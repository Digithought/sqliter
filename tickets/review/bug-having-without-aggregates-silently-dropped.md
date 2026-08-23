---
description: A query filtering with `having` but doing no counting or grouping used to have its filter ignored entirely — every row came back. It now behaves the way other databases do, and a new test suite checks that each part of a `select` statement actually affects the answer.
repro: verified
difficulty: medium
files:
  - packages/quereus/src/planner/building/select-aggregates.ts   # the fix, in buildAggregatePhase
  - packages/quereus/test/logic/25.2-having-edge-cases.sqllogic  # +97 lines of behaviour cases
  - packages/quereus/test/clause-canary.spec.ts                  # NEW — per-clause "clause must change the answer" guard
  - docs/sql-select.md                                           # §3.3 bullet, §3.4 new paragraph
  - docs/runtime.md                                              # aggregate-boundary-check wording
---

# `having` with no aggregate and no `group by` — implemented, tested, documented

## What was wrong

`select a from wg having a = 'x'` returned **every** row of `wg`. So did
`having 1 = 0`. No error, no warning — the clause never reached the plan.

`buildAggregatePhase` computed a `shouldPushHavingBelowAggregate` flag and then
returned before anything could read it: the flag's condition was the early return's
condition plus `stmt.having`, so the branch it guarded was unreachable. Since
`select-aggregates.ts` is the only builder that reads `stmt.having`, nothing else
picked the clause up.

## What it does now

A `having` makes the query an aggregate query on its own — one implicit group over
all input rows, as SQLite and PostgreSQL define it. The query returns at most one
row, and every clause above the aggregation is subject to the existing coverage
rule (the implicit group carries no base-table columns at all).

**This is a behaviour change, not only a bug fix.** `select a from wg having
a = 'x'` is now an *error* rather than two rows. That is deliberate and was settled
in the fix ticket: Quereus does not import SQLite's permissive bare-column rule
(already recorded above `validateAggregateProjections` and in the
`assertGroupedPlanCoverage` NOTE in `select.ts`), so it rejects, as PostgreSQL does,
and as it already rejected `select count(*) from wg having a = 'x'`.

## The change

Three edits in `buildAggregatePhase`, exactly as the fix ticket specified:

- `shouldPushHavingBelowAggregate` + the early return replaced by
  `const isAggregateQuery = hasAggregates || hasGroupBy || Boolean(stmt.having)`.
- The unreachable pre-aggregate-filter branch deleted.
- `if (stmt.having && !shouldPushHavingBelowAggregate)` simplified to `if (stmt.having)`.
- `preAggregateSort` drops its `hasAggregates` term (see *Tripwire* below for why,
  and for what it costs).

Net: **-28 / +39 lines**, most of it comment. Nothing else changed — the machinery
this relies on (`emitStreamAggregate`'s zero-grouping-key path, `buildHavingFilter`'s
own coverage check, `assertGroupedPlanCoverage`, the unconditional
`groupedCoverageContext`) already existed. `FilterNode` and `buildExpression` imports
are still live (`buildHavingFilter` uses both), so the import block is untouched.

## Validation — what was actually run

| Command | Result |
| --- | --- |
| `yarn build` | clean |
| `yarn test` (full workspace, all packages) | **0 failing.** `@quereus/quereus` 10203 passing / 25 pending (baseline before this ticket was 10194; +9 = the new canary suite). Every other package unchanged. |
| `yarn lint` (full workspace) | clean |
| `yarn workspace @quereus/quereus run lint` (eslint + `tsc -p tsconfig.test.json`) | clean |

## Behaviour to check by hand

Fixture: `create table wg (a text, b text primary key);
insert into wg values ('x','1'),('y','2'),('x','3');` plus an empty table.

Rejected (each from one of the two existing coverage checks — `buildHavingFilter`'s
for a bare column in `having`, `assertGroupedPlanCoverage`'s for one in the select
list):

```
select a from wg having a = 'x';   -- HAVING references non-grouped column 'a'; …
select * from wg having a = 'x';   -- same, for 'a'
select a from wg having 1 = 0;     -- Column 'a' must appear in the GROUP BY clause or be used in an aggregate function
```

Accepted, one implicit group:

```
select 1 as one from wg   having 1 = 1;                          → [{"one":1}]
select 1 as one from wg   having 1 = 0;                          → []
select 1 as one from empt having 1 = 1;                          → [{"one":1}]   -- empty table still yields the group
select 1 as one from wg   having (select count(*) from wg) > 2;  → [{"one":1}]
select 1 as one from wg   having (select count(*) from wg) > 5;  → []
select 1 as one from wg   having 1 = 1 limit 1;                  → [{"one":1}]
select distinct 1 as one from wg having 1 = 1;                   → [{"one":1}]
select 1 as one from wg   having 1 = 1 order by a;               → [{"one":1}]
create view v1 as select 1 as one from wg having 1 = 1; select * from v1;  → [{"one":1}]
```

Unchanged (regression guards):

```
select count(*) as c from wg having count(*) > 5;                → []
select count(*) as c from wg having count(*) > 1;                → [{"c":3}]
select a, count(*) as c from wg group by a having a = 'x';       → [{"a":"x","c":2}]
select count(*) as c from wg where a = 'x' having count(*) > 1;  → [{"c":2}]
select w.b from wg w where exists (select 1 from wg t having w.a = 'x') order by w.b;  → [{"b":"1"},{"b":"3"}]
```

Every one of these was run against the patched build and matched. All are now
pinned in `25.2-having-edge-cases.sqllogic` (97 new lines, appended as a new
section; nothing above it changed).

That last case is the one worth re-reading: a `having` inside a subquery may name an
**enclosing** query's column, exactly as `where` may, and the coverage check must
still tell that from an ungrouped local column when no aggregate is present.

## The class guard — `test/clause-canary.spec.ts` (new, 9 tests)

The class here is not "wrong predicate", it is **a clause the parser accepted that
never reached the plan and said nothing about it**. `order by <ordinal> collate
<name>` silently not sorting
(`tickets/backlog/bug-order-by-ordinal-with-collate-ignored`) is a second, independent
instance already on the board.

So: for each clause, a query whose answer must differ from the same query with the
clause removed. Covers `where`, `group by`, `having` (grouped **and** the
no-aggregate-no-group-by shape), `order by`, `limit`, `offset`, `distinct`, plus one
error-canary (a clause whose only observable effect is a rejection — if it were
dropped, nothing would be raised).

**It was verified to bite.** With `Boolean(stmt.having)` removed from
`isAggregateQuery` — which reproduces the exact pre-fix behaviour, since the
pre-aggregate-filter branch was unreachable anyway — the run was **7 passing,
2 failing**, and the two failures were precisely the two having-only canaries. Every
other canary stayed green, so they are not accidentally coupled to this fix. The
term was then restored and the full suite re-run.

The file's header comment states what the suite is *not*: it checks that a clause is
implemented **at all**, not that it is implemented **correctly**. Per-clause
correctness stays in the behaviour suites.

## Docs

- `docs/sql-select.md` §3.3 — the implicit-group bullet now reads "with aggregates
  **or a `having`**, and no `group by`".
- `docs/sql-select.md` §3.4 — new paragraph: a `having` is not a second `where`;
  what is rejected, what is accepted, the empty-table case, and the pointer to why
  Quereus does not follow SQLite here.
- `docs/runtime.md` — the boundary-check bullet now says "aggregate query" includes
  one whose only trigger is a `having`.

## Tripwire recorded (not a ticket)

`preAggregateSort` dropping its `hasAggregates` term means the having-only shape
takes the pre-aggregate sort path. For that shape the aggregate list is empty, so
nothing observes input order and the sort **cannot** change the single output row —
it is a no-op. Confirmed by dumping the emitted program: `select 1 from hn having
1 = 1 order by val` carries one `sort(1 keys)` instruction, the same shape the
already-documented `select group_concat(grp) from hn order by val` produces (where
the order genuinely does matter).

Keeping it is the right call — the alternative pushes the sort above the aggregation,
where the coverage check rejects it, making `order by` mean different things for two
queries that differ only in whether an aggregate is named. Parked as a `NOTE:` at the
`preAggregateSort` computation in `select-aggregates.ts`, with the revisit condition
and the one-line elision to apply if it ever matters.

## Known gaps and limitations — where to point a reviewer

**One real limitation, confirmed pre-existing (not a regression).**
`select 1 from t having 1 = 1 order by count(*)` raises *"Aggregate function count
not allowed in this context"*. PostgreSQL accepts it — the query **is** an aggregate
query, so an aggregate in its `order by` should be legal. The cause is that
`orderByNeedsPostAggregateSort`' aggregate-collection branch is gated on
`(hasAggregates || hasGroupBy)`, which the having-only shape does not satisfy.
Verified by re-running the same query with `Boolean(stmt.having)` removed from
`isAggregateQuery`: **identical error message, before and after**. So this patch
neither introduces nor worsens it — it is a corner the new shape now reaches. Not
filed: it resolves at the same site as this ticket's own fix and a reviewer may
prefer to fold it in rather than carry a separate ticket. Left as an explicit call
for review.

Same story for `select 1 from t having count(*) > 1` → *"Cannot mix aggregate and
non-aggregate columns in SELECT list without GROUP BY"*. Also byte-identical before
and after, and already filed as
`tickets/backlog/bug-ungrouped-aggregate-rejects-constant-select-item`.

**Gaps that were probed and closed rather than handed off.** Three shapes I had
listed as untested were run and then pinned in the sqllogic file:
`count(*) over () … having 1 = 1` → `[{"c":1}]` (the window runs over the single
aggregated row, not the three input rows — it returned `3` three times before the
fix), and `order by 1` / `order by <alias>` on the having-only shape → one row each.
`row_number() over () … having 1 = 1` raises *"Window function row_number requires
ORDER BY clause"* — the pre-existing rule for that function, unrelated to `having`,
so nothing to pin.

**Genuinely still open:**

- **Only the memory vtab was exercised.** `yarn test:store` (LevelDB path) was not
  run — this is a planner-shape change with no storage surface, so it should be
  inert there, but that is reasoning, not evidence.
- **The canary suite is a floor, not a ceiling.** Eight clauses plus one error
  canary; a `select` has more (`from`-clause modifiers, `with`, set operations,
  `window` definitions). Adding rows is cheap and the harness is already there.
- **The bite test disabled the fix minimally** rather than restoring the original
  source text. That is equivalent — the deleted branch was unreachable — but a
  reviewer wanting certainty can revert the whole hunk and re-run.

## Deliberately not in scope

`select 'total' as label, count(*) from t` is still rejected by
`validateAggregateProjections`' blanket throw — a separate, already-filed finding
(`tickets/backlog/bug-ungrouped-aggregate-rejects-constant-select-item`) at the same
file but a different site. This patch neither fixes nor worsens it: the having-only
shape leaves `hasAggregates` false and so never reaches that throw. It does produce
a visible asymmetry worth knowing about — `select 1 from wg having 1 = 1` works,
`select 1, count(*) from wg` does not. `hasAggregates` was deliberately **not** set
to `true` for the having-only shape, precisely so the new shape does not hit that
throw.

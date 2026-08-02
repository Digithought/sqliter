---
description: Fixed queries that join a sub-select against a table returning wrong answers or crashing, because the planner was matching columns by their position in the sub-select's result instead of their position in the underlying table.
files:
  - packages/quereus/src/planner/rules/join/rule-join-elimination.ts
  - packages/quereus/src/planner/rules/join/rule-fanout-lookup-join.ts
  - packages/quereus/src/planner/rules/join/rule-join-key-inference.ts
  - packages/quereus/src/planner/rules/subquery/rule-semi-join-fk-trivial.ts
  - packages/quereus/src/planner/rules/subquery/rule-anti-join-fk-empty.ts
  - packages/quereus/src/planner/util/key-utils.ts
  - packages/quereus/src/planner/util/ind-utils.ts
  - packages/quereus/test/optimizer/rule-join-elimination.spec.ts
  - packages/quereus/test/optimizer/parallel-fanout.spec.ts
  - docs/optimizer-joins.md
  - docs/optimizer-rule-families.md
difficulty: medium
---

# Review: foreign-key alignment now compares base-table column positions

## What the bug was

A foreign key is declared in the **base table's own column order** (`p.id` is
column 0). A join condition is expressed in each join input's **output column
order**, and a sub-select in the FROM list renames, reorders, and drops columns
freely. Two optimizer rules compared the two numbering schemes without
translating, so an output position could collide with an unrelated table column
and the wrong column was accepted as the foreign-key (or primary-key) column.

## What changed

**Both rules now translate before comparing.** `resolveTableColumnMapping` +
`mapColumnsToTable` (`planner/util/ind-utils.ts`) resolve a subtree to its single
base table plus an output-column → table-column map built by attribute identity.
This is the same pattern the semi/anti-join folds already used.

- `rule-join-elimination.ts` — `tryEliminate` resolves a mapping per side and
  translates both equi-column lists. Untranslatable (computed) join column →
  decline the rewrite.
- `rule-fanout-lookup-join.ts` — `recognizeBranch` takes a `TableColumnMapping`
  instead of a `TableSchema` and translates both sides. **Deliberate asymmetry:**
  when translation fails the branch falls through to the `cross` path rather than
  returning null. A `cross` / `cross-left` branch is always sound (data-driven
  1:n, gated by the existing row/product guards), so failing to *prove*
  at-most-one costs the proof, not the whole cluster.
- `rule-join-key-inference.ts` — the third caller, diagnostic-only (it only
  `log(...)`s and always returns null). Translated the same way so the log line
  stops naming joins that are not in fact foreign-key joins.
- `checkFkPkAlignment` (`key-utils.ts`) — doc comment now states the base-table
  index contract; parameters renamed `fkEquiIndices`/`pkEquiIndices` →
  `fkTableCols`/`pkTableCols`. `lookupCoveringFK` got the same contract note.
- `isRowPreservingPathToTable` (`ind-utils.ts`) — **the `throughProject` option
  is gone**; a `ProjectNode` is now always peeled. Rationale: the predicate
  answers *rows only*, and `ProjectNode.estimatedRows` returns its source's count
  verbatim (DISTINCT is a separate `DistinctNode`), so a projection can never
  drop a row. The option only ever existed to stop callers pairing raw output
  positions against a table schema; no such caller remains. This is what unlocks
  the INNER sub-select rewrite (case 4 below).
- `extractTableSchema` (`key-utils.ts`) is untouched and still used elsewhere; it
  simply has no FK-alignment callers left.

## Use cases to exercise

All four were re-verified by temporarily reverting the translation in each rule
and watching the new tests go red, then restoring it.

### 1. Outer join must not lose a row

```sql
create table p (id integer primary key, other integer) using memory;
create table c (id integer primary key, p_id integer not null references p(id)) using memory;
insert into p values (7, 7), (2, 7);
insert into c values (10, 7);

select c.id from c left join (select other from p) q on c.p_id = q.other;
-- expected: two rows, both id = 10; the join must survive in the plan
```

`q.other` is output position 0 of the sub-select but column 1 of `p`; position 0
of `p` is `id`, the column the foreign key references.

### 2. Inner join must not invent a row (the *preserved* side was also untranslated)

```sql
create table p (id integer primary key) using memory;
create table c3 (id integer primary key, x integer, p_id integer not null references p(id), y integer) using memory;
insert into p values (1), (2);
insert into c3 values (10, 0, 1, 99);   -- y = 99 has NO parent row

select q.id from (select id, x, y from c3) q join p on q.y = p.id;
-- expected: zero rows; the join must survive in the plan
```

`q.y` is output position 2, colliding with `c3.p_id` (table column 2), the real
foreign-key column.

### 3. Fan-out lookup join must not claim at-most-one

Three sub-select lookup branches over `HighLatencyMemoryModule` with
`tuning.parallel.concurrency = 2`, joining on a non-key `other` column. Before
the fix each branch was classified `atMostOne-left` and execution threw
`QuereusError: FanOutLookupJoin: branch 0 produced more than one row for outer
row (got 2)`.

### 4. A genuinely-covered sub-select must still be optimized

```sql
select c.id from c left join (select other, id from p) q on c.p_id = q.id;   -- join eliminated
select c.id from c join      (select other, id from p) q on c.p_id = q.id;   -- join eliminated (needs the Project peel)
```

Plus the fan-out equivalent (`(select other, id, label from cust) c on
o.customer_id = c.id`), which must still classify `atMostOne-left`. These are the
cases that distinguish "translates" from "merely refuses sub-selects".

### 5. Computed join column declines

```sql
select c.id from c left join (select id + 0 as k from p) q on c.p_id = q.k;
-- join must survive: q.k has no base-table origin
```

## Tests added

`test/optimizer/rule-join-elimination.spec.ts` — new `describe('derived-table
column indices')` with 5 cases (1, 2, 4-LEFT, 4-INNER, 5). All 5 fail when the
translation in `tryEliminate` is reverted.

`test/optimizer/parallel-fanout.spec.ts` — new `describe('derived-table lookup
branches')` with 4 cases: branch-mode assertion for the non-FK sub-select,
execution equivalence against the rule-disabled baseline, branch-mode assertion
for the FK-covered reordering sub-select, and its execution equivalence. Three of
the four fail when the translation in `recognizeBranch` is reverted (one with the
exact `assertAtMostOne` runtime error above). Also hoisted the existing
`fanOutBranchModes` helper from the subquery `describe` to module scope so the
new block can reuse it — no behavior change to existing tests.

## Where I differed from the ticket, and known gaps

**The ticket's stated expectation for case 3 is wrong, and my test asserts
something different.** It said the three sub-select branches "must not form a
fan-out". They *do* still form one — as three `cross-left` branches, which is
sound and is exactly the documented degradation path the fix intends. Whether a
fan-out forms at all depends on the cross-branch memory guards
(`maxCrossBranchRows` / `maxCrossProduct`) and therefore on row estimates, which
makes it a fragile thing to assert. I assert instead that (a) no branch is ever
classified `atMostOne-*`, and (b) the executed row multiset equals the
nested-loop baseline. **Reviewer: confirm that is the right contract to pin.**

**Removing `throughProject` widens what two rules accept.** `rule-join-elimination`
and `rule-fanout-lookup-join` previously refused any `Project` on the eliminable
/ lookup side; they now peel it. That is intentional (it is what makes case 4's
INNER variant work) and is safe only because the column-index confusion is now
handled by translation. It is the single highest-leverage thing to re-check — a
soundness argument, not a test-coverage one.

**Not covered by tests:** composite foreign keys through a reordering sub-select.
The existing composite-FK misalignment test uses bare tables. A composite FK
whose columns a sub-select permutes should still be rejected by
`lookupCoveringFK`'s positional pairing after translation, but nothing pins it.

**Not covered by tests:** `rule-join-key-inference`'s translated path. It is
log-only and returns null unconditionally, so there is no observable behavior to
assert without capturing log output. Verified by reading only.

**Aggregate entrypoint shares `tryEliminate`** and so is fixed by the same
change, but the new tests only drive the Project entrypoint. The existing
`aggregate-anchored elimination` block still passes; no sub-select variant was
added there.

## Validation run

- `yarn workspace @quereus/quereus run test` — **8333 passing, 13 pending, 0
  failing**. (The ticket quoted 8056 as the baseline; the tree has gained tests
  since it was written.) No golden-plan churn.
- `yarn lint` — clean.
- `yarn typecheck` — clean.

## Docs updated

- `docs/optimizer-joins.md` § "Fan-out lookup join (FK→PK + 1:n cross)" — added
  the base-table-translation bullet and the cross-degradation rule; updated the
  outer-subtree bullet from `extractTableSchema` to `resolveTableColumnMapping`.
- `docs/optimizer-rule-families.md` § "Output indices are not table column
  indices" — this paragraph previously documented the bug as current behavior and
  pointed at this ticket by slug. Rewritten: every alignment caller now
  translates, the contract lives on the helpers' parameters, and the two rules'
  differing failure modes are spelled out. Also fixed the two downstream
  sentences that described `throughProject` and the Project-rejection.
- `docs/optimizer.md` needed no change (its only mention is a one-line rule-family
  table row). It was **not** modified in the working tree at the start of this
  run, contrary to the implement ticket's note.

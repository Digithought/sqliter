---
description: The planner now answers "what is the largest (or smallest) value in this indexed column" by reading the one row at the end of the index instead of scanning the whole table. Implemented, reviewed, and shipped with one wrong-answer defect found and fixed during review.
files:
  - packages/quereus/src/planner/rules/aggregate/rule-minmax-index-boundary.ts   # the rule
  - packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts            # trySortAbsorbViaIndexOrdering exported; LimitOffset-arm comment corrected
  - packages/quereus/src/planner/optimizer.ts                                    # RULE_MANIFEST entry
  - packages/quereus/src/core/database.ts                                        # `_isBuiltinFunction` — new built-in-identity seam
  - packages/quereus/test/optimizer/minmax-index-boundary.spec.ts                # 18 plan-shape / work-counter tests
  - packages/quereus/test/logic/10.5.6-minmax-index-boundary.sqllogic            # answer-level tests, both backends
  - packages/quereus-store/test/isolated-store.spec.ts                           # boundary read under the isolation overlay
  - docs/optimizer-rules.md, docs/optimizer-streaming.md, docs/optimizer-retrieve.md
---

# Completed: ungrouped MIN / MAX answered from the index boundary

## What shipped

A Structural-pass optimizer rule, `minmax-index-boundary`, rewrites an ungrouped
`min(c)` / `max(c)` over an indexed column into the shape the planner already knows how to
answer from an index, keeping the aggregate itself unchanged on top:

```
Aggregate [max(c)]                     <- unchanged
  └─ LimitOffset(limit=1)              <- new
       └─ Filter(c is not null)        <- new, only when c is nullable
            └─ Retrieve(t)             <- equipped with an ordering access plan
```

`min(c)` over any relation `S` equals `min(c)` over `(S where c is not null order by c asc
limit 1)`, so this is a plan-shape change only. Keeping the aggregate makes the empty
relation free (an ungrouped aggregate over zero rows still emits one NULL row) and keeps
the rule out of the comparator business — it delegates the ordering question to the same
access-plan claim plain `ORDER BY` consumes. The rule probes first
(`trySortAbsorbViaIndexOrdering`, now exported from grow-retrieve) and commits nothing when
the probe returns null, so a plan that cannot serve the ordering is left byte-identical.

**Coverage caveat, unchanged from the implement handoff and worth repeating:** neither
shipped backend walks an index backwards, so `min(c)` needs an ascending index (the primary
key counts) and `max(c)` needs a descending one. `max(c)` with only an ascending index is
still a full scan; the fix for that user today is `create index … on t(c desc)`. Backwards
index walks are `backlog/feat-reverse-index-walk-for-desc-ordering`; grouped MIN/MAX is
`backlog/feat-grouped-minmax-index-boundary`.

## Review findings

Read the implement diff (commit `1c7454ff9`, all nine changed files) before the handoff
summary, then re-derived the gates from the surrounding code rather than from the ticket's
description of them.

### Major — one wrong-answer defect, fixed in this pass

**The "user-registered shadow declines" gate did not decline anything.** The rule gated on
`call.functionSchema === context.db._findFunction('min'|'max', 1)`. Both sides resolve
through the same `schemaManager.findFunction`, so the comparison only ever proved that a
lookup agrees with itself — it was a tautology, and the code comment, the RULE_MANIFEST
note, and `docs/optimizer-rules.md` all claimed the opposite.

Verified, not inferred. With a user aggregate registered as `min/1` that counts rows
instead of taking an extremum, over a 12-row table:

| | plan | answer |
| --- | --- | --- |
| before | carries the `LIMITOFFSET` — rewrite fired | `1` (wrong) |
| after | no `LIMITOFFSET` — rule declines | `12` (correct) |

Fixed at the level that retires the question rather than at the instance. `Schema.addFunction`
overwrites by `name/numArgs`, so *name resolution structurally cannot* tell a built-in from a
shadow; the database's built-in registration is the one seam that knows. Added
`Database._isBuiltinFunction(schema)` — an identity check against the schemas registered from
`BUILTIN_FUNCTIONS` (stamped in the same loop that already stamps `replicable`, which its own
comment calls "the single seam that *knows* a schema is a builtin"). Identity-based, so a user
schema cannot declare its way in. The rule now gates on that plus the schema's own name.
Regression test added to the decline block.

Fixed inline rather than filed because it is a defect in the diff under review and the fix is
contained (three files, ~20 lines including the doc comment).

**The same mistake exists one site over**, in `rule-groupby-fd-simplification`, which
synthesizes `min(<col>)` "pick any group representative" aggregates through the same name
lookup. Also verified: with the shadow registered, `select id, v from pk group by id, v`
returns `v=1` instead of `v=100`. Outside this diff and it changes a different rule's plans, so
filed as `backlog/bug-shadowed-builtin-aggregate-in-groupby-simplification`, pointing at the
helper this ticket added. Those two were the only two `_findFunction` call sites in the tree;
the materialized-view rewrite does the right thing already (it keys off a capability the
function schema declares, not off its name).

### Major — filed, not fixed

**`LIMIT n` consumes row `n+1` before stopping** (`runtime/emit/limit-offset.ts`). The
handoff flagged this as pre-existing and asked whether it deserved a ticket. It does, and
it is worse than the "one wasted read" the handoff described: it also drives one extra row
of *side effects*. Verified — `select * from (insert into t select k, k*10 from src
returning k) limit 1` leaves **two** rows in `t`. Neither reading of that query produces
two (either the LIMIT stops the insert at one row, or the insert completes and the LIMIT
trims output to one of four); two is purely the lookahead pull. Filed as
`backlog/bug-limit-reads-one-row-too-many`, with the general shape ("anything that stops
early should not consume past what it emits" — the ordinal-slice operator, `exists`/`IN`
subqueries) named as the class to cover with one test rather than three point fixes. Not
fixed here: it changes row counts across the suite, well outside this ticket's blast radius.
The `BOUNDARY_ROWS = 2` constant in the new spec now cites the ticket.

### Minor — fixed in this pass

- **Stale comment turned into a trap.** `rule-grow-retrieve.ts`'s LimitOffset arm said its
  non-numeric-OFFSET refusal was "inert today: this arm is unreached anyway (no shape puts
  a LimitOffset directly above a Retrieve)" and invited a future reader to "read a
  null/absent OFFSET as 0 rather than refusing". This change makes that arm reachable —
  confirmed by running the spec with the grow-retrieve logger on and watching `Testing
  index-style fallback for LimitOffset` → `No usable constant LIMIT` fire — and accepting
  the invitation would let the grow swallow the rewrite's `LimitOffset` into
  `Retrieve.source`, where the index-style branch never executes it, silently restoring a
  full scan. Comment corrected to state that it is reached, what depends on it, and which
  test catches a regression.
- **Two missing test cases added.** A shadowed built-in `min` must decline (the regression
  for the defect above), and `select max(c) from t where k > 1` must decline cleanly with
  the plan byte-identical — the handoff called that case out in prose but pinned nothing.
  Two matching answer-level cases added to the `.sqllogic` so both backends check the
  answers regardless of which access path each one costs cheaper.

### Tripwires — recorded in code, not filed

- `rule-minmax-index-boundary.ts`, at the `IS NOT NULL` decision: **two different sources
  of truth decide whether a NULL can reach the column.** The rule reads the column
  reference's own type; `nullSafeOrderingPrefixLength` reads `tableSchema.columns[i].notNull`.
  They agree today, and the DESC direction fails safe if they ever stop agreeing (a missing
  filter makes the ordering claim be refused, so the rule declines). The ASC direction does
  **not** fail safe — an ordering claim over a nullable ascending column is granted
  unconditionally, so a type that under-reported nullability would skip the filter and
  `min(c)` would return NULL. `NOTE:` at the site with the revisit condition.
- The two tripwires the implementer recorded (the load-bearing `Literal(null)` OFFSET, and
  the NULL-run walk when the module does not consume `IS NOT NULL` as a seek bound) were
  re-read and are accurate as written. Left in place.

### Examined and deliberately left alone

- **The unreachable `call.filter` / `call.orderBy` gates.** The parser rejects both today,
  so they cannot be exercised end-to-end. Two lines, and they become live the moment the
  parser grows either feature. Agree with the implementer's call.
- **Redundant `IS NOT NULL` evaluation** (the `FilterNode` above the equipped Retrieve plus
  a possible residual stamp). Idempotent, and identical to what a hand-written `where d is
  not null order by d desc limit 1` already does — a pre-existing grow-retrieve property,
  not something this rule introduced.
- **The `monotonic-limit-pushdown` → `OrdinalSliceNode` interaction** is documented but not
  exercised, because no shipped module advertises `supportsOrdinalSeek`. The tests assert
  row counts rather than operator names, so they already tolerate either. Nothing to test
  until a module advertises it.
- **`.sqllogic` numbered `10.5.6`, not `10.5.5`.** `10.5.5` was taken. Non-issue.
- **No benchmark run.** The rewrite's effect is pinned by work counters (2 rows against a
  full scan of 12) rather than wall clock, and no wall-clock magnitude is claimed anywhere
  in the code, the docs, or this ticket. A number would need a bench run; nothing depends
  on having one.

### Categories with nothing to report

- **Resource cleanup:** nothing to report. The rule allocates only plan nodes, which are
  garbage like any other discarded probe; it opens no cursors, holds no handles, and the
  early stop closes the source iterator through the existing `for await` break path.
- **Type safety:** nothing to report. No `any`, no assertion that widens a type unsoundly;
  the one cast (`absorbed as RelationalPlanNode`) is guarded by the probe having returned a
  rebuilt relational chain.
- **File size / decomposition:** nothing to report. The rule is 204 lines, of which about
  half is the header explaining why the rewrite is sound; the executable part is one entry
  point plus five single-purpose helpers, each named for what it decides.
- **Error handling:** nothing to report *as a defect*. The probe calls a third-party
  module's `getBestAccessPlan` and does not guard it, so a module that throws there would
  now break `select min(c) from t` — but `ruleGrowRetrieve` calls it unguarded on many more
  shapes already, so a local try/catch here would buy inconsistency rather than robustness.
  If that ever needs guarding it needs guarding at the shared call site.

### Documentation

Read every file the change touched and swept for files it should have touched.
`docs/optimizer-rules.md` (rule catalogue), `docs/optimizer-retrieve.md` (the exported
probe's side-effect-free contract) and `docs/optimizer-streaming.md` (composition with
`monotonic-limit-pushdown`) were updated by the implementer and are accurate — except the
gate list in `optimizer-rules.md`, which repeated the false shadow claim and has been
rewritten to describe the identity check. `docs/optimizer-rule-families.md` and
`docs/optimizer.md` describe families and passes this rule does not change; no user-facing
doc claims anything about MIN/MAX performance that is now stale.

## Validation

Run after the review's changes, from the repo root:

- `yarn lint` — clean (eslint plus the `tsconfig.test.json` type pass over spec files).
- `yarn typecheck` — clean across all workspaces.
- `yarn test` — 10082 passing, 25 pending, **0 failing** in `@quereus/quereus`; every other
  workspace green (`@quereus/store` 1910 passing, sync 736, the rest as before). Two more
  passing than the implement handoff's 10080: the two optimizer tests added above.
- `yarn test:store` — 10074 passing, 33 pending, **0 failing** (the new `.sqllogic` file,
  including its two added cases, runs on the LevelDB-backed store path too).

No pre-existing failures were encountered, so `tickets/.pre-existing-error.md` was not
written. No golden plan snapshot changed.

## Follow-ups filed

- `backlog/bug-shadowed-builtin-aggregate-in-groupby-simplification` — the second instance
  of the built-in-shadow mistake, verified, with the helper to fix it already in place.
- `backlog/bug-limit-reads-one-row-too-many` — `LIMIT` over-consuming by one row, including
  the extra-write case, with the early-stop class named.

Pre-existing and unchanged: `backlog/feat-reverse-index-walk-for-desc-ordering` (what would
make `max(c)` fast off an ascending index) and `backlog/feat-grouped-minmax-index-boundary`.

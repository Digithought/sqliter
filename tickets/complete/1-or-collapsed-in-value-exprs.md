description: |
  A query written as "this column equals a written-out value OR equals a placeholder" used to
  crash with an internal error. The planner now records the right thing for the written-out
  branches, and a plan-time check makes the same class of mistake fail loudly with a clear
  message instead of surfacing as a confusing runtime error.
files:
  - packages/quereus/src/planner/analysis/constraint-extractor.ts        # collapseBranchesToIn, valueSideOf
  - packages/quereus/src/planner/util/column-refs.ts                     # new: collectColumnRefAttributeIds (cycle-free home)
  - packages/quereus/src/planner/nodes/table-access-nodes.ts             # assertSeekKeysRowIndependent, called from IndexSeekNode's constructor
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts # makeIndexSeek factory (9 call sites)
  - packages/quereus/test/plan/or-collapsed-in-value-exprs.spec.ts       # regression spec (15 tests)
  - docs/invariants.md                                                   # OPT-061
  - docs/optimizer-rule-families.md                                      # § Predicate Analysis and Pushdown
----

# Complete: OR-collapsed IN records value expressions, plus a seek-key invariant guard

## What shipped

**The defect.** `where col = 10 or col = :p` is collapsed by the planner into a single
`col in (10, :p)` constraint carrying a parallel array of *value* expressions, one per list
member. `collapseBranchesToIn` filled the literal branches' slots with the branch's **whole
comparison** (`col = 10`) instead of the value (`10`). Any module claiming the collapsed `IN`
as an index multi-seek then got `col = 10` as a lookup key; lookup keys are evaluated before
any row is read, so it died with `No row context found for column i`.

Both bad sites now record the value: the literal equality branch via a new `valueSideOf`
helper (mirror of `columnSideOf`), and the all-literal `IN` branch via the `InNode`'s own
value expressions.

**The invariant.** A seek key for table T may reference columns of *other* relations (an
ordinary correlated / index-nested-loop seek) but never a column of T itself.
`assertSeekKeysRowIndependent` enforces this and raises `StatusCode.INTERNAL` naming the
table, index, column, attribute id, and the offending key.

## Review findings

Full adversarial pass over the implement diff (`git show b8a57bfad`), read before the
handoff summary. Lint, docs check, and four test suites run — all green.

### Major — fixed in this pass (architecture, not a ticket)

**The invariant was enforced at one producer, not at the seam.** The implement stage put the
check in a `makeIndexSeek` factory local to `rule-select-access-path`, and flagged the
alternative as a judgment call it left open. `docs/invariants.md` OPT-061 stated the rule as
a global invariant while three other construction sites — `table-access-nodes.ts`'s
`withProvenance` and `withChildren`, and `rule-monotonic-range-access.ts`'s two clone helpers
— bypassed it. (The handoff described the monotonic rule as "builds bounds from monotonic
expressions"; reading it shows all four are pure clones that re-pass existing keys. The one
that can introduce *new* keys is `withChildren`, which a later rewrite pass drives.)

Climbing to the boundary-invariant rung: the check now lives in **`IndexSeekNode`'s
constructor**, so every producer is covered by construction. This required first moving
`collectColumnRefAttributeIds` out of `constraint-extractor.ts` — that module has an explicit
in-file warning that the runtime cycle `constraint-extractor → nodes/reference → …` is real
and must never become a value import. It now lives in a new leaf module,
`planner/util/column-refs.ts`, which depends on nothing but the node-type enum. The walk is
identical; `constraint-extractor` imports it, and the `export` the implement stage added to
it is gone.

Two of the handoff's own flagged gaps are retired by this move rather than deferred:

- *Seek-kind label drift* — the nine hand-written `'multiSeek'` / `'eqSeek'` / … strings
  duplicating `planKind` are deleted. The constructor names `this.indexName` instead, which
  is real state and cannot drift.
- *`makeIndexSeek` hides `IndexSeekNode`'s trailing optional parameters* — no longer a
  hazard. A future arm that reaches for `new IndexSeekNode` to pass `rangeBoundedOn` or
  `pushedConstraints` no longer skips the check. `makeIndexSeek` survives only as the
  `tableRef.scope`-deduplicating shorthand it also was.

Verified by reintroducing the original defect in a scratch edit: the guard fires at plan
time on 8 of the spec's shapes with the named error (`Internal planner error: seek key on p
via index "p_i" references that table's own column "i" (attribute 52) … Offending key:
i = 10`), instead of the old runtime `No row context found`. Edit reverted.

### Minor — fixed in this pass

- **Every row assertion in the spec passed even when the collapse silently declined.** The
  two new `null` returns in `collapseBranchesToIn` fall back to a scan + residual filter,
  which returns the *same rows*. So a regression that disabled the fixed path entirely would
  not have failed a single test. The spec's `col()` helper now asserts the plan reaches an
  `IndexSeek` before running the query — the rows prove correctness, the seek proves the path
  under test is the one exercised.
- **`valueSideOf`'s second arm was untested.** Added `10 = i or i = :p` (literal on the left,
  the `src.left` return) and `cast(i as integer) = 10 or i = :p` (the `unwrapCast` path).
  Both reach an `IndexSeek` and return the right rows.
- **The two `null` returns declined silently**, unlike every other decline in that function,
  which logs. Both now log a reason. Also folded the equality arm's two guard clauses into one
  expression — the `instanceof BinaryOpNode` check had no distinct outcome from the
  `valueSideOf` miss.
- Spec had two copies of the plan-walk helper; hoisted to one.

### Checked and found correct — no action

- **`change-scope.ts:614` under the new contract.** Read it: the loop takes `c.value[i]`
  whenever it is not `undefined` and only reads `valueExpr[i]` for dynamic slots, so it never
  looked at a literal position's entry. The literal `NULL` case (`value[i]` is `null`, not
  `undefined`) also stays on the `c.value` path. The handoff's claim holds.
- **The two `null` returns really are unreachable.** Confirmed independently: `op: '='`
  constraints are minted only by `extractBinaryConstraint`, which always leaves a
  `BinaryOpNode` with an identifiable column side, and `extractInConstraint` always sets
  `sourceExpression` to the `InNode` with `values.length === value.length`. `IS NULL` carries
  op `IS NULL` and never reaches this branch. They are defence, and now logged defence.
- **`valueSideOf` uses the same `unwrapCast` as `isColumnReference`/`getColumnReference`**, so
  it cannot disagree with the extractor about which side is the column. A converting cast is
  stripped by neither, and such a shape is declined upstream anyway.
- **No false positives from moving the check into the constructor.** This was the real risk of
  the change — a legitimate plan whose seek key carries the sought table's own attribute id
  would now throw. Three suites over the whole repo say no.

### Tripwires — recorded at the site, not filed

- The constructor walks every seek key on every construction, clones included. Keys are
  almost always single literal nodes, and the uncapped composite cross-product arm of
  `rule-select-access-path` costs far more to *build* its keys than to walk them. `NOTE:` at
  `table-access-nodes.ts`'s `assertSeekKeysRowIndependent`, with the remedy if seek
  construction ever profiles hot (cache on the key node — never skip the check).

### Filed elsewhere

None. One existing ticket updated as evidence rather than duplicated:
`tickets/backlog/debt-oversized-source-files.md` already lists `constraint-extractor.ts`;
its measurement was stale (1,647 lines, 2026-08-11) and is now 1,695 (`wc -l`, 2026-09-01).
Refreshed in place. `rule-select-access-path.ts` shrank from 1,689 to 1,643 and is not on
that list.

### Not checked

Nothing material. `yarn test:full` is `test` plus `test:store`, both of which ran, so
coverage is complete for this change.

## Validation

- `yarn workspace @quereus/quereus run lint` (eslint + `tsc -p tsconfig.test.json --noEmit`):
  exit 0.
- `node test-runner.mjs --no-bail` in `packages/quereus`: **10263 passing, 25 pending**
  (10259 before, +4 new spec cases).
- `yarn test` from repo root: green across all workspaces, `Done in 6m 55s`.
- `yarn test:store` (LevelDB-backed re-run of the quereus logic tests — the handoff's largest
  flagged gap, since the store module also claims multi-seeks): **10255 passing**, exit 0. The
  new constructor guard produces no false positive on the store path either.
- `node scripts/check-docs.mjs`: `Docs OK`. OPT-061 was 4 words over the 120-word invariant
  cap after the rewrite and was trimmed — the OR-collapse narrative now lives only in the
  rule-families doc it links to.

## Spec coverage

`packages/quereus/test/plan/or-collapsed-in-value-exprs.spec.ts`, 15 tests. Fixtures are
plain `using memory` tables. The originating report claimed the memory module was unaffected;
that is wrong — it is unaffected only when the column has no index.

Shapes: primary key, indexed integer, indexed text, three-way OR, `IN`-branch arm, reversed
operand order, no-op cast on the column side, composite key with the leading column pinned,
a parameter matching nothing, and a NULL-bound parameter. Controls: all-literal OR,
all-parameter OR, directly written `in (10, :p)`. Every one asserts both the returned rows
and that the plan reached an `IndexSeek`.

Invariant tests drive `assertSeekKeysRowIndependent` from a hand-built violation — a real
plan is walked for its `IndexSeek` and for a `ColumnReference` carrying one of the sought
table's own attribute ids — since the guard has no SQL-level trigger left once the collapse
is fixed.

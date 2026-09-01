description: |
  A query written as "this column equals a written-out value OR equals a placeholder" used to
  crash with an internal error. The planner now records the right thing for the written-out
  branches, and a new plan-time check makes the same class of mistake fail loudly with a clear
  message instead of surfacing as a confusing runtime error.
files:
  - packages/quereus/src/planner/analysis/constraint-extractor.ts        # collapseBranchesToIn, new valueSideOf, exported collectColumnRefAttributeIds
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts # assertSeekKeysRowIndependent + makeIndexSeek factory (9 call sites rerouted)
  - packages/quereus/test/plan/or-collapsed-in-value-exprs.spec.ts       # new regression spec (13 tests)
  - docs/invariants.md                                                   # new OPT-061
  - docs/optimizer-rule-families.md                                      # § Predicate Analysis and Pushdown bullet
----

# Review: OR-collapsed IN records value expressions, plus a seek-key invariant guard

## What landed

**Arm 1 — the defect.** `where col = 10 or col = :p` is collapsed by the planner into a single
`col in (10, :p)` constraint that carries a parallel array of *value* expressions, one per list
member. `collapseBranchesToIn` (`constraint-extractor.ts`) filled the literal branches' slots
with the branch's **whole comparison** (`col = 10`) instead of the value (`10`). A module that
claims the collapsed `IN` as an index multi-seek then received `col = 10` as a lookup key;
lookup keys are evaluated before any row is read, so it died with:

```
No row context found for column i. The column reference must be evaluated within
the context of its source relation.
```

Both bad `valueExprs.push(c.sourceExpression)` sites are fixed:

- Literal equality branch → the comparison's non-column operand, via a new `valueSideOf`
  helper (mirror of the existing `columnSideOf`, placed after it). The cast unwrap identifies
  the *column* side only; the returned value side is the **raw** operand, matching
  `extractBinaryConstraint`, which keeps a converting cast in `valueExpr` on purpose.
- All-literal `IN` branch → the `InNode`'s own value expressions, positionally aligned with
  `c.value`.

`collapseBranchesToIn` now returns `null` when a branch's source shape yields no value
expression, and the caller (`tryExtractOrBranches`) falls through to `tryCollapseToOrRange` and
then to "leave the OR residual" — a completeness loss only, never a wrong answer.

**Arm 2 — the guard.** New invariant at the seam, so this class fails at plan time with a named
error rather than deep in expression evaluation:

> A seek key handed to `IndexSeekNode` for table T may reference columns of *other* relations
> (an ordinary correlated / index-nested-loop seek) but never a column of **T itself**.

`assertSeekKeysRowIndependent` (exported for testing) walks each key with
`collectColumnRefAttributeIds` — now exported from `constraint-extractor.ts` — and raises
`StatusCode.INTERNAL` naming the table, column, attribute id, and the offending key. Rather
than sprinkling the call, all nine `new IndexSeekNode(...)` sites in the rule were rerouted
through one local `makeIndexSeek(...)` factory that checks first, so no arm can skip it. The
factory drops the redundant `tableRef.scope` argument; every site passed the same shape.

Docs: `docs/invariants.md` gains **OPT-061**; `docs/optimizer-rule-families.md` §
*Predicate Analysis and Pushdown* gains the `valueExpr` contract bullet it links to.
`node scripts/check-docs.mjs` passes.

## How to exercise it

`packages/quereus/test/plan/or-collapsed-in-value-exprs.spec.ts` (13 tests). Run:

```
node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js \
  "packages/quereus/test/plan/or-collapsed-in-value-exprs.spec.ts"
```

Fixtures are plain `using memory` tables — no external module needed. The originating report
claimed the memory module was unaffected; that is wrong, it is unaffected only when the column
has no index. Add an index (or use the primary key) and the memory module claims the collapsed
`IN` as a multi-seek.

Shapes covered (all threw before the fix, 8 of 13 failing on the unfixed tree):

- primary key: `select i from p where id = 1 or id = :p`
- indexed integer: `select id from p where i = 10 or i = :p`
- indexed text: `select id from p where t = 'aa' or t = :p`
- three-way OR: `... where i = 10 or i = 20 or i = :p`
- IN-branch arm: `... where i in (10, 20) or i = :p`
- composite key: `select v from c where a = 1 and (b = 1 or b = :p)`
- parameter matching nothing, and a NULL-bound parameter (both must return only the literal
  branch's rows — these guard the runtime NULL-skip / no-match paths, not just "doesn't throw")

Controls that already passed and still do: all-literal OR, all-parameter OR, directly written
`in (10, :p)`.

Every assertion checks the **returned rows**, not merely the absence of a throw.

Invariant tests: the guard has no SQL-level trigger left once the collapse is fixed, so it is
driven from a hand-built violation — a real plan is walked for its `IndexSeek` and for a
`ColumnReference` carrying one of the sought table's own attribute ids, and the two are fed to
`assertSeekKeysRowIndependent` directly (expects a throw); the seek's genuine keys are fed to
the same function (expects no throw).

## Validation run

- `node test-runner.mjs --no-bail` from `packages/quereus`: **10259 passing, 25 pending** (was
  10248 before this ticket's 11 SQL-level tests; the 2 invariant tests were added after this
  run and are covered by the root run below).
- `yarn test` from repo root: green, `Done in 7m 5s`.
- `yarn lint` in `packages/quereus` (eslint + `tsc -p tsconfig.test.json --noEmit`): exit 0.
  Root `yarn lint` fan-out: exit 0.
- `node scripts/check-docs.mjs`: `Docs OK`.

## Known gaps — please poke at these

- **`yarn test:store` was not run.** Nothing here is store-specific (the change is planner-side
  and the fixtures are memory tables), but the store module also claims multi-seeks, so a
  reviewer wanting belt-and-braces should run it.
- **The two `null` returns in `collapseBranchesToIn` are untested.** They are unreachable in
  practice: the collation pre-gate in `tryExtractOrBranches` already requires every branch's
  `sourceExpression` to be a recognised `BinaryOpNode` with an identifiable column side, or an
  `InNode`. They are defence, not live paths. If a reviewer can construct a shape that reaches
  them, that is a genuine finding.
- **The guard covers only `rule-select-access-path`.** Two other producers construct
  `IndexSeekNode` and are *not* checked: `table-access-nodes.ts` (`withChildren` clone paths —
  same keys re-wrapped, no new risk) and `rules/access/rule-monotonic-range-access.ts` (builds
  bounds from monotonic expressions). `rules/join/index-nested-loop.ts` **is** covered, because
  it delegates to this rule's exported `selectPhysicalNode`. Whether the check belongs in the
  `IndexSeekNode` constructor instead — covering every producer at once — is a judgment call I
  left alone rather than widening scope; the ticket asked for the rule.
- **`change-scope.ts` (~line 614) was deliberately left untouched**, per the ticket: it reads
  `c.value[i]` first and only falls back to the expression when the value is `undefined`, so it
  never touched a literal position's entry. Worth a second pair of eyes that the new contract
  does not change what it sees.
- **Seek-kind labels in the error message** (`'multiSeek'`, `'composite multiSeek'`,
  `'eqSeek'`, …) are hand-written strings duplicating the `planKind` already passed to
  `makeIndexFilterInfo` at each site. They can drift. Deliberate: threading the typed
  `IndexPlanKind` through would not cover the two legacy PK arms, which pass no plan kind.
- **`makeIndexSeek` does not expose `IndexSeekNode`'s trailing optional constructor
  parameters** (`rangeBoundedOn`, `suppressMonotonic`, `orderingLoadBearing`,
  `pushedConstraints`). No call site in this rule passed them, so behaviour is unchanged — but
  a future arm needing one has to widen the factory rather than reaching for `new` and skipping
  the check. A reviewer may prefer a rest-args passthrough.

---
description: When a query combines two SELECTs with UNION, the engine used to assume both halves produce the same kind of value as the first half, corrupting or rejecting rows from the second half. Set operations now merge the two halves' types symmetrically and convert a half when needed. Implemented and reviewed.
files:
  - packages/quereus/src/planner/analysis/set-op-type-merge.ts          # merge rules 1–5 + advertised-type collapse
  - packages/quereus/src/planner/nodes/set-operation-node.ts            # resolvedDataType; create/alignSetOpOperands factory; withChildren routing
  - packages/quereus/src/planner/building/select-compound.ts            # routes through factory; DIFF aligns once before expansion
  - packages/quereus/src/planner/nodes/async-gather-node.ts             # unionAll getType/buildAttributes fold the same merge
  - packages/quereus/test/planner/set-op-type-merge.spec.ts             # unit spec
  - packages/quereus/test/logic/06.9.1-json-coerce-once.sqllogic        # JSON union cases
  - packages/quereus/test/logic/28.2-set-op-branch-types.sqllogic       # DATE/ANY, numeric promotion, NULL branch, DIFF, ORDER BY/view/nested
  - docs/types.md                                                       # § Where coercion happens
  - docs/runtime.md                                                     # § AsyncGatherNode — unionAll type merge
---

# Complete: set operations report a type they actually produce

## What shipped

`SetOperationNode` used to advertise the LEFT operand's logical type for every
output column, so a `union` whose branches carried different types mis-described
one branch's rows — storing raw text in a DATE column, throwing bogus conversion
errors on JSON, and failing to dedup equal values across branches.

**Symmetric merge** (`planner/analysis/set-op-type-merge.ts`).
`mergeSetOpColumnType(left, right)` is order-independent:

1. identical types → that type;
2. either side NULL → the other side;
3. both builtin numerics → promotion (any NUMERIC → NUMERIC; else INTEGER/REAL
   pair → REAL); a non-builtin numeric pair falls to ANY;
4. exactly one side object-physical (JSON) → the object side, with a `convert`
   marker naming the branch that must be cast;
5. otherwise → ANY (claims nothing; every consumer converts).

`mergeSetOpAdvertisedType` collapses an *unconverted* rule-4 pair to ANY, so the
node never advertises a type that depends on a conversion it did not perform.
`SetOperationNode.resolveDataColumns` derives per-data-column
`{logicalType, nullable (ORed), collation}` from both operands; flag columns are
untouched.

**Branch alignment** (`SetOperationNode.create` / `alignSetOpOperands`). The
factory wraps a rule-4 `convert` branch in a `ProjectNode` whose marked columns
pass through a lenient `CastNode` (`castFallback` semantics — `'not json'` stays
a string scalar, reads stay total). Pass-through columns keep their attribute
ids; cast columns mint fresh ids. After alignment both branches report the merged
type, so the node lands on rule 1 and every consumer — `buildRowCoercion`'s skip
rule, the dedup comparator, predicate coercion — reads an honest type.
`withChildren` routes through `create`; `select-compound.ts` uses the factory
everywhere and aligns ONCE before the DIFF `(A except B) union (B except A)`
expansion. Flag-surfacing branches are never wrapped (a `ProjectNode` would
flatten surfaced flag columns into the data arity), so such a pair stays
unconverted and honestly advertises ANY.

**`AsyncGatherNode`** (`unionAll`): `getType()` folds the same merge left-deep
across children and the non-preserved `buildAttributes` path rebases attribute
types onto it.

## Review findings

Reviewed the implement diff (`7592870e`) against the source, then probed the
built engine directly with ~30 SQL cases beyond the shipped suites.

### Major — ticketed

- **Rule-3 numeric promotion advertises REAL but converts neither branch.** The
  implementer recorded this as a conditional tripwire ("would choke if one ever
  reaches it"). It is reachable from plain SQL today, so it is a defect, not a
  tripwire. Confirmed against the built engine:
  `insert into t(v real) select 9007199254740993 union all select 2.5` stores the
  whole-number internal form unconverted (a direct single-row insert of the same
  literal converts correctly), and with the column declared `real primary key`
  the statement throws `Cannot convert a BigInt value to a number`. Both arm
  orders fail; this diff regressed the whole-number-on-the-left order, which
  worked before it. Filed `tickets/fix/set-op-numeric-promotion-skips-conversion.md`
  with the repro and the two candidate routes (convert the branch, as rule 4
  does — or advertise NUMERIC, which leaves read-side output alone). Rewrote the
  in-code comment from a tripwire to a KNOWN DEFECT pointing at the ticket, and
  added the same caveat to `docs/types.md` rule 3.

### Minor — fixed in this pass

- **`docs/runtime.md` § AsyncGatherNode was stale.** The `unionAll` bullet still
  said only per-column nullability is OR-merged across children; the diff also
  made it merge logical types and rebase `children[0]`'s attribute types onto the
  result. Documented both.

### Tripwires — recorded, not ticketed

- **`withChildren` re-mint.** Routing the rebuild through the aligning factory
  means that *if* an optimizer rule ever returns a child whose column types
  changed, re-alignment mints fresh cast-column attribute ids mid-optimization
  and stale references above would fail to resolve. Every rule is type-preserving
  today (verified — no rule rewrites a child's column types), so it is inert.
  Parked as a `NOTE:` at the `withChildren` rebuild site.

### Checked, nothing found

- **Order independence.** Every JSON/DATE/NULL/numeric case exercised in both arm
  orders against the running engine; results identical, as the shipped suites
  claim.
- **Attribute-id stability under alignment.** The concern was that wrapping the
  LEFT branch changes the set operation's output ids, breaking an outer ORDER BY
  or an enclosing view. It does not: `createSetOperationScope` is built from the
  *final* set-op node, after alignment, so outer references bind to the fresh
  ids. Verified with ORDER BY, positional ORDER BY, a view, and a nested set op
  over an aligned branch.
- **DML branch wrapping.** A compound's right operand may be an
  `insert … returning`; that branch now gets wrapped in the cast projection when
  it is the text side. Verified the insert still lands and the rows still flow.
- **Nullability widening.** `nullable` is now the OR of both branches, and a
  `CastNode` reports nullable even from a NOT NULL operand. Verified this does
  not newly reject inserts into `not null` targets in either shape.
- **Collation.** The declared-collation rank conflict still errors for a genuine
  TEXT/TEXT pair (`NOCASE` vs `BINARY` → `ambiguous collation for comparison`).
  A branch cast to JSON drops its text collation, which is inconsequential —
  JSON compares structurally and the JSON side never carried one.
- **Predicate pushdown below the conversion.** Cast columns mint fresh attribute
  ids specifically to block this; verified a predicate over an aligned union
  matches both branches' rows rather than being pushed under the cast.
- **`buildRowCoercion` under ANY.** Read the skip rule: it is an identity compare
  against the declared column type, and ANY is never identical to one, so every
  cell converts — the rule-5 claim holds.
- **`AsyncGatherNode` recursion / drift.** `buildAttributes` → `getType()` reads
  only children, so no cycle. The reference-compare rebase can allocate one
  redundant attribute array, but `attributesCache` makes it once. No defect.
- **Construction paths.** `select-compound.ts` is the only builder of
  `SetOperationNode` outside tests, and it routes through the factory everywhere
  (recursive CTEs do not use this node). No unaligned production path.
- **Docs sweep.** Read every `docs/` file mentioning set operations. The
  attribute-model statements in `invariants.md` and `optimizer.md` ("set
  operations mirror the left child's IDs") remain accurate at the node level.
  `optimizer-fd.md`'s key/FD table is untouched by this diff. Only `runtime.md`
  was stale (fixed above); `types.md` was correctly updated by the implementer.
- **Lint and tests.** `yarn lint` (eslint + test-file `tsc`) clean; full
  `yarn test` green across all workspaces (7416 quereus tests, 0 failing);
  set-op / compound / JSON suites re-run green after the review edits.

### Coverage gaps examined — no ticket warranted

- **Flag-surfacing branch in a rule-4 pair** (the implementer's flagged gap). I
  tried to reach it from SQL and could not: the parenthesized-compound form
  flattens into a projection and hits the arity check, and chained compounds nest
  right-deep so the flagged node never lands as the *converting* operand. The
  carve-out is defensive; the ANY collapse it relies on is directly unit-covered
  in `set-op-type-merge.spec.ts`. A contrived test here would pin the mock, not
  the behavior.
- **`AsyncGather` with mismatched child types end-to-end.** The recognition rule
  is latency-gated and inert on memory-backed plans, and it always passes
  `preserveAttributeIds`, so the merged-fold path is pure drift-proofing between
  `getType()` and `getAttributes()`. Construction-level coverage is proportionate.
- **Cast targets resolving by registry name.** Conditional on a future plugin
  object-physical type whose name does not round-trip; JSON does today. The
  constraint is already documented at the `castColumns` call site.

Related, same root shape, separate ticket: `failed-cast-stores-unconverted-value`.

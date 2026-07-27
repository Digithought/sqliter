description: When a query combines two SELECTs with UNION, the engine used to assume both halves produce the same kind of value as the first half, corrupting or rejecting rows from the second half. Set operations now advertise a symmetric cross-branch type merge and convert branches where needed; this is the review pass over that implementation.
files:
  - packages/quereus/src/planner/analysis/set-op-type-merge.ts          # NEW — merge rules 1–5 + advertised-type collapse
  - packages/quereus/src/planner/nodes/set-operation-node.ts            # resolvedDataType rewrite; create/alignSetOpOperands factory; withChildren routing
  - packages/quereus/src/planner/building/select-compound.ts            # routes through factory; DIFF aligns once before expansion
  - packages/quereus/src/planner/nodes/async-gather-node.ts             # unionAll getType/buildAttributes fold the same merge
  - packages/quereus/test/planner/set-op-type-merge.spec.ts             # NEW — unit spec (merge rules, node output type, factory alignment)
  - packages/quereus/test/logic/06.9.1-json-coerce-once.sqllogic        # JSON union cases (both orders, CTE, read dedup, predicate, intersect/except)
  - packages/quereus/test/logic/28.2-set-op-branch-types.sqllogic       # NEW — DATE/ANY cases, numeric promotion, NULL branch, DIFF, ORDER BY/view/nested
  - docs/types.md                                                       # § Where coercion happens — merge rule documented
difficulty: hard
---

# Review: set operations now report a type they actually produce

## What was built

`SetOperationNode` used to advertise the LEFT operand's logical type for every
output column, so a `union` whose branches carried different types mis-described
one branch's rows — silently storing raw text in a DATE column, throwing bogus
conversion errors on JSON, and failing to dedup equal values across branches
(full defect catalog in `tickets/complete` history / the original ticket). Two
halves, landed together:

**Half A — symmetric merge** (`planner/analysis/set-op-type-merge.ts`).
`mergeSetOpColumnType(left, right)`, order-independent:

1. identical types → that type;
2. either side NULL → the other side;
3. both builtin numerics → promotion (any NUMERIC → NUMERIC; else INTEGER/REAL
   pair → REAL); a non-builtin numeric pair falls to ANY;
4. exactly one side object-physical (JSON) → the object side, with a `convert`
   marker naming the branch that must be cast;
5. otherwise → ANY (claims nothing; every consumer converts).

`mergeSetOpAdvertisedType` collapses an *unconverted* rule-4 pair to ANY — the
node itself performs no conversion, so it never advertises a type requiring one.
`SetOperationNode.resolveDataColumns` now derives per-data-column
`{logicalType, nullable (ORed), collation (unchanged lattice)}` from both
operands; flag columns untouched.

**Half B — branch alignment** (`SetOperationNode.create` /
`alignSetOpOperands`). The factory wraps a rule-4 `convert` branch in a
`ProjectNode` whose marked columns pass through a lenient `CastNode`
(`castFallback` semantics — `'not json'` stays a string scalar, reads stay
total). Pass-through columns keep their attribute ids; cast columns mint fresh
ids (the value changes). After alignment both branches report the merged type,
so the node lands on rule 1 and every consumer — `buildRowCoercion`'s skip rule,
the dedup comparator, predicate coercion — reads an honest type.
`withChildren` routes through `create` (idempotent re-align);
`select-compound.ts` uses the factory everywhere and aligns ONCE before the
DIFF `(A except B) union (B except A)` expansion.

**Flag-surfacing branches are never wrapped** (a `ProjectNode` would flatten
surfaced membership-flag columns into the recursive data arity). Such a rule-4
pair stays unconverted and the node honestly advertises ANY via the collapse.

**`AsyncGatherNode`** (`unionAll`): `getType()` folds the same merge left-deep
across children (matching the set-op chain the gather replaced) and the
non-preserved `buildAttributes` path rebases attr types onto it. The rewrite
rule always passes `preserveAttributeIds = setOp.getAttributes()`, so this is
mostly drift-proofing between `getType()` and `getAttributes()`.

## Verified behavior (all in automated tests, memory + store backends)

- DATE ∪ TEXT insert: raw `'2024-01-02T00:00:00Z'` normalizes to `'2024-01-02'`
  in BOTH arm orders; stored dates survive re-conversion (`28.2`).
- JSON ∪ TEXT insert: `'"9"'` converts to the JSON string 9, stored JSON never
  re-parsed, both orders + CTE form; previously one order corrupted silently and
  the other threw (`06.9.1`).
- Read side: `union` dedup collapses the native and literal `"abc"` to one row
  (both orders); a predicate over the union matches both branches' rows;
  `intersect`/`except` now match across branches; `'not json'` stays total.
- Must-keep: `1 union all 'a'` unchanged; `1 union all 2.5` stays numeric (NOT
  TEXT); INTEGER-column inserts with a text numeral in either arm; JSON|JSON
  untouched.
- NULL branch does not poison the other side's type (both orders).
- DIFF over mixed JSON/TEXT (both orders); ORDER BY over a set op, a view over
  one, nested set ops, positional ORDER BY — all resolve post-alignment.
- Nullability ORs across branches; unaligned direct construction advertises ANY
  (unit spec `test/planner/set-op-type-merge.spec.ts`).

Validation run: root `yarn build`, root `yarn test` (all workspaces, 7416
quereus + others, 0 failing), `yarn test:store` (7410 passing), quereus
`yarn lint` (eslint + test-file tsc). Ticket-named suites (28-set-ops,
28.1-compound, 09.1-cross-collation, 93.6-flagless-write, 13.3-cte,
10.6-distinct, 20-empty-single-row, planner validation.spec) all pass.

## Deviations from the ticket spec (deliberate — review these first)

- **Rule 3 refinement**: ticket said "REAL if either is REAL, else INTEGER".
  Implemented NUMERIC-aware promotion instead (INTEGER ∪ NUMERIC → NUMERIC, not
  INTEGER — NUMERIC's value space contains reals, so INTEGER would under-claim),
  and a non-builtin numeric pair → ANY rather than a guessed promotion. The
  ticket's pinned INT∪REAL→REAL case is preserved.
- **ANY ∪ JSON → JSON** (rule 4 fires; ANY is not object-physical). Follows the
  ticket letter. Consequence: `(TEXT ∪ DATE) ∪ JSON` casts the mixed ANY stream
  leniently to JSON — total, never errors, but a reviewer may want to weigh
  ANY-absorbs as an alternative (which would instead re-introduce strict
  re-conversion errors at a JSON DML — worse, we judged).

## Known gaps / reviewer attention

- **No logic test for a flag-surfacing branch in a rule-4 pair** (flagged set-op
  operand whose data column is JSON on one side, TEXT on the other → ANY
  downgrade). The path is unit-covered only indirectly (the advertised-type
  collapse). `93.6-set-op-flagless-write` and the membership suites pass, but a
  targeted case would pin the downgrade.
- **AsyncGather with genuinely mismatched child types is untested end-to-end**:
  the rewrite rule is latency-gated and never fires on memory-backed plans, so
  the merged-fold `getType()` is exercised only by construction-level suites.
- **`withChildren` re-mint**: if an optimizer rule ever hands back a child whose
  column *types* changed, re-alignment wraps it and mints fresh cast-column
  attribute ids mid-optimization. No rule does this today (rules are
  type-preserving); flagging because the factory routing makes it possible.
- **Cast targets resolve by registry name** (`CastNode` → `typeRegistry.inferType`).
  A future plugin object-physical type registered under a name the registry
  can't round-trip would mis-cast; JSON round-trips fine today.

## Tripwires (recorded, not tickets)

- `set-op-type-merge.ts` rule 3 NOTE: promotion converts neither branch; a
  bigint INTEGER cell riding an advertised REAL into a REAL-declared column
  skips DML conversion and stores as bigint — `REAL_TYPE.compare` (declared-key
  BTrees) would choke if one ever reaches it. If that surfaces, extend branch
  alignment to numeric pairs.

Related, same root shape, separate ticket: `failed-cast-stores-unconverted-value`.

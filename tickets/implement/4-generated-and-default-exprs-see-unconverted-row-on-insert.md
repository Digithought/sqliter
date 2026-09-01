description: On INSERT, a computed column (GENERATED ALWAYS AS) and a DEFAULT expression are handed the values exactly as the caller typed them, while every other write path hands them the values after conversion to the column's declared type. Fix INSERT to match — evaluate those expressions against the converted row.
files:
  - packages/quereus/src/planner/nodes/plan-node-type.ts          # WriteCoercion enum entry ALREADY ADDED (only landed change so far)
  - packages/quereus/src/planner/nodes/scalar.ts                  # add WriteCoercionNode here, after CastNode (~line 811)
  - packages/quereus/src/runtime/emit/write-coercion.ts           # new emitter (mirror runtime/emit/cast.ts)
  - packages/quereus/src/runtime/register.ts                      # register the emitter
  - packages/quereus/src/runtime/scalar-fusion.ts                 # add WriteCoercion case (fuseSpec; converter closures are synchronous)
  - packages/quereus/src/planner/building/insert.ts               # restructure createRowExpansionProjection + createGeneratedColumnProjection
  - packages/quereus/src/planner/building/default-scope.ts        # buildRowDefaultScope — reused unchanged, new attrs passed in
  - packages/quereus/src/runtime/emit/update.ts                   # phase 2: per-cell coercion inside the loop (replaces coerceGenerated)
  - packages/quereus/src/runtime/emit/dml-executor.ts             # lines ~777-782: NOTE about emitUpdate divergence — resolve it
  - packages/quereus/src/types/validation.ts                      # buildCellCoercion — used as-is, plus plan-time skip probe
difficulty: hard
----

# Make INSERT's DEFAULT/GENERATED evaluation see the converted row (Arm A of the original ticket)

Continuation of the original ticket of this slug after a budget stop. **Investigation is
complete and the design is decided** — this ticket is the implementation. Arm B (contract
tests) and Arm C (docs/release note) moved to `4.5-write-form-contract-tests-and-docs`.

## Verified baseline (reproduced at HEAD before any change)

Scratch spec (now deleted) confirmed all four reproductions from the original ticket:

- `create table G (Id text primary key, V json, Note text null, L integer generated always as (length(V)))`
  — note **columns are NOT NULL by default in this engine**, `null` must be explicit in repro tables.
- INSERT `('a','"Bob"','n1')` → `L=5` (written form — WRONG); `update G set Note='n2'` → `L=3` (declared form).
- Backfill vs INSERT: `alter table V add column L integer generated always as (length(j))` backfills 3, later INSERT of same value stores 5.
- `add column k text default (new.j)`: backfill `Bob`, later INSERT `"Bob"`.
- datetime: generated `s text generated always as (ts)` keeps `.000Z` on INSERT, loses it on any UPDATE.
- **UPSERT `on conflict … do update` recompute ALREADY AGREES with UPDATE** (verified:
  `do update set V = '"Bob"'` gives `L=3`). See `runtime/emit/dml-executor.ts`
  `executeUpsertUpdate` (~lines 740-794): user assignments are converted per-cell via
  `assignmentCoercions` as they are applied, then generated columns are recomputed against
  the composed converted row, each converted before the next reads it. **No change needed
  there except the NOTE below.** Record this in the review handoff.

## Decided design — planner interleave via a scalar coercion node

Rejected alternatives (do not relitigate):
- *Emitter two-phase mirroring emitUpdate*: would move DEFAULT/GENERATED expressions out of
  the projection chain onto InsertNode — large restructure of InsertNode child exposure
  (see `test/optimizer/dml-child-exposure.spec.ts` for how seriously that contract is taken),
  new row-descriptor plumbing, plan-golden churn for no extra correctness.
- *Wrapping column REFERENCES in coercion inside default/generated scopes*: broken —
  `buildGeneratedColumnExpr` deliberately announces the column's DECLARED type on its refs
  (for collation), so an identity-matched coercion would guard-only and skip conversion of a
  conforming written-form value (datetime string with `Z` conforms to TEXT physical class →
  never converted → bug survives).
- *Reusing CastNode*: CAST is lenient (`lenientCast`, failure→NULL); write path must throw
  MISMATCH via `validateAndParse` and must identity-guard (JSON re-parse hazard). Wrong node.

### 1. `WriteCoercionNode` (new scalar plan node)

`PlanNodeType.WriteCoercion` **already added** to `plan-node-type.ts` (after `Cast`). Add the
class in `planner/nodes/scalar.ts` after `CastNode` (~line 811), modeled on it:

- Fields: `scope`, `operand: ScalarPlanNode`, `targetType: ScalarType` (declared column type
  from `columnSchemaToScalarType(column)` — carries declared collation), `columnName: string`.
- `expression` getter returns `this.operand.expression` (the node adds no syntax; the
  `'expression' in node` checks elsewhere still pass via prototype getter).
- `getType()`: `{ ...targetType, nullable: operand.getType().nullable }` — conversion maps
  NULL→NULL and throws rather than yielding NULL, so nullability follows the operand;
  NOT NULL stays enforced by the constraint check, not asserted here. Cache via `Cached`.
- `getChildren`/`withChildren`/`getRelations`/`toString`/`getLogicalAttributes`: mirror
  CastNode. Cost `0.02`. `isInjectiveIn`: leave the conservative PlanNode default.
- Doc comment must say: planner-inserted only (INSERT row expansion is the sole construction
  site); semantics are the write path's (`buildCellCoercion` — throws MISMATCH, identity-guards),
  NOT CAST's.
- Fingerprint (`expression-fingerprint.ts`) falls to `_UK:` unique — acceptable, no change
  needed. Fusion: add a `WriteCoercion` case in `runtime/scalar-fusion.ts` calling a
  `buildWriteCoercionSpec` (closures are synchronous).

### 2. Emitter `runtime/emit/write-coercion.ts`

Mirror `emit/cast.ts`: `buildWriteCoercionSpec(plan)` computes once
`const coerce = buildCellCoercion(plan.operand.getType().logicalType, plan.targetType.logicalType, plan.columnName)`
and `run` applies it (pass-through when `undefined`). Register in `runtime/register.ts` next
to `PlanNodeType.Cast`.

### 3. Planner helper in `building/insert.ts`

```ts
function coerceToDeclared(ctx: PlanningContext, node: ScalarPlanNode, column: ColumnSchema): ScalarPlanNode
```
Skip the wrap when provably inert, to avoid plan noise/golden churn on untyped columns:
- if `!column.logicalType.parse && !column.logicalType.validate` → return node (converter
  could never change a value; covers ANY);
- if `buildCellCoercion(node.getType().logicalType, column.logicalType, column.name) === undefined`
  → return node (identity + no conformance guard);
- else wrap in `new WriteCoercionNode(ctx.scope, node, columnSchemaToScalarType(column), column.name)`.

### 4. Restructure `createRowExpansionProjection`

Current: ONE projection evaluates supplied refs + ALL defaults, then the generated chain,
and conversion happens only later in `emitInsert`. New shape:

- **Projection A** (expansion): supplied column → `coerceToDeclared(ctx, columnRef, tableColumn)`;
  omitted with *literal* default → `coerceToDeclared(ctx, literalNode, tableColumn)`;
  omitted with *expression* default → plain NULL literal placeholder, record its table column
  index; generated → NULL literal (unchanged); no default → NULL literal (no wrap).
- **Projection B** (only when ≥1 expression default — preserves the current lazy/hot-path
  property): pass-through refs for every column except the expression-default ones, which get
  their default built against a `buildRowDefaultScope` whose attribute array is **projection
  A's output attributes at the supplied columns' table positions** (parallel to
  `targetColumns`; map via `tableSchema.columnIndexMap.get(tc.name.toLowerCase())`), parented
  on `contextScope ?? defaultRowContextScope ?? ctx.scope` with the same
  `mutationContextVarNames` shadowing set as today. Keep `validateDeterministicDefault`
  (gated on `nondeterministic_schema`) with the build. Wrap each default in
  `coerceToDeclared`. Omitted columns stay unregistered in the scope (defaults still cannot
  read other defaults — same rule as today).
- **Generated chain** (`createGeneratedColumnProjection`): unchanged except each computed
  `genNode` is wrapped in `coerceToDeclared(ctx, genNode, genColumn)` — a generated column
  reading another generated column then sees the converted value, matching the upsert arm's
  per-cell order (the one `dml-executor.ts`'s NOTE calls "the correct one").
- The all-columns-supplied/no-generated fast path (`return sourceNode`) stays: nothing reads
  the row before `emitInsert` converts it.
- `emitInsert` stays as-is: with every produced cell announcing its declared type, its
  `buildRowCoercion` degrades to conformance guards (identity skip) — the "convert exactly
  once" discipline. Cells from the fast path still convert there.

Multi-source note for the handoff: envelope-only sibling columns reached through
`defaultRowContextScope` still resolve to raw envelope attributes (written form) — unchanged,
pre-existing, out of scope; say so in the review ticket.

### 5. `emitUpdate` phase 2 — per-cell coercion

Replace the single `coerceGenerated = buildRowCoercion(...)` applied after the loop with a
per-generated-cell `buildCellCoercion(plan.assignments[i].value.getType().logicalType,
column.logicalType, column.name)` map applied **inside** the loop, immediately after each
evaluator and before the next generated column reads `updatedRow`. This is exactly what the
upsert arm already does. Then rewrite the NOTE at `runtime/emit/dml-executor.ts:777-782`
("if such a divergence is ever observed, make emitUpdate convert per-column too") — the
divergence is now resolved; the two sites agree.

## TODO

- Implement steps 1–5 above (enum entry already landed).
- Re-verify the five baseline behaviors flip to declared-form on INSERT (the values in
  "Verified baseline" above are the before; after the fix INSERT must agree with UPDATE:
  `L=3`, backfill==INSERT, `k='Bob'` both rows, datetime `s` without `.000Z`).
- Expect plan-golden churn in `test/plan/` (new WriteCoercion nodes inside INSERT
  projections) — regenerate/adjust deliberately, confirming the shape is the designed one.
- Watch `test/logic/15.1.1-json-check-coercion.sqllogic`, `06.9.1-json-coerce-once.sqllogic`,
  `41*.sqllogic`, `03.4-defaults.sqllogic`, `test/dml-write-representation.spec.ts` — they
  pin neighboring behavior; the OR REPLACE NOT NULL DEFAULT substitution
  (`buildNotNullDefaults`) is deliberately NOT changed.
- `yarn build`, `yarn workspace @quereus/quereus test`, `yarn lint`.
- Hand off to review with: upsert-arm-already-correct finding, the envelope-sibling
  written-form note, and honest listing of any golden regenerations.

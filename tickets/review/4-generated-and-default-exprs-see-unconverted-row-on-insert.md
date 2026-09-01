description: On INSERT, computed (GENERATED ALWAYS AS) and DEFAULT expressions used to see values as the caller typed them instead of converted to the column's declared type; INSERT now converts inside the row-expansion projection so those expressions read the same values every other write path hands them. Review the implementation.
files:
  - packages/quereus/src/planner/nodes/scalar.ts                  # WriteCoercionNode (after CastNode)
  - packages/quereus/src/planner/nodes/plan-node-type.ts          # WriteCoercion enum entry (landed in prior run)
  - packages/quereus/src/runtime/emit/write-coercion.ts           # new emitter (mirrors emit/cast.ts)
  - packages/quereus/src/runtime/register.ts                      # emitter registration
  - packages/quereus/src/runtime/scalar-fusion.ts                 # WriteCoercion fusion case
  - packages/quereus/src/planner/building/insert.ts               # coerceToDeclared + two-projection restructure
  - packages/quereus/src/runtime/emit/update.ts                   # phase 2: per-cell coercion inside the loop
  - packages/quereus/src/runtime/emit/dml-executor.ts             # divergence NOTE resolved (~line 777)
  - docs/types.md                                                 # "Concretely:" bullets updated
difficulty: medium
----

# Review: INSERT DEFAULT/GENERATED expressions now see the converted row

Implementation of the decided design from the implement-stage ticket (same slug).
Build green, full `@quereus/quereus` suite green (10281 passing, 0 failing,
25 pending), `yarn workspace @quereus/quereus lint` clean (eslint + test tsc).

## What was built

- **`WriteCoercionNode`** (`planner/nodes/scalar.ts`, `PlanNodeType.WriteCoercion`):
  unary scalar node, planner-inserted only. `expression` getter forwards the
  operand's expression (adds no syntax). `getType()` = target declared type with
  the operand's nullability. Write-path semantics — `buildCellCoercion`
  (throws MISMATCH via `validateAndParse`, identity-guards against JSON
  re-parse) — deliberately NOT CAST's lenient failure→NULL. Not injective
  (conservative default). Cost 0.02.
- **Emitter** `runtime/emit/write-coercion.ts`: `buildWriteCoercionSpec` computes
  the converter once at emit time; pass-through when `buildCellCoercion` returns
  undefined. Registered beside Cast; fused in `scalar-fusion.ts` (converters are
  synchronous).
- **`building/insert.ts`** restructured `createRowExpansionProjection` into:
  - *Projection A*: supplied columns and literal defaults wrapped in
    `coerceToDeclared` (skips wrap when the column type has no parse/validate,
    or `buildCellCoercion` is provably inert); NULL placeholders for expression
    defaults (positions recorded), generated columns, defaultless omissions.
  - *Projection B* (built only when ≥1 expression default — hot-path lazy
    property preserved): computes expression defaults against projection A's
    CONVERTED row. `buildRowDefaultScope` reused unchanged, handed projection
    A's output attributes at the supplied columns' table positions (parallel to
    `targetColumns`). Same parent-scope chain (`contextScope ??
    defaultRowContextScope ?? ctx.scope`), same mutation-context shadowing, same
    `validateDeterministicDefault` gate. Omitted columns still unregistered
    (defaults cannot read other defaults — unchanged rule).
  - *Generated chain*: each computed node wrapped in `coerceToDeclared`, so a
    generated column reading another generated column sees the converted value.
  - Fast path (all columns supplied, no generated) still returns `sourceNode`
    bare; `emitInsert` unchanged — its `buildRowCoercion` degrades to
    conformance guards for cells announcing declared types.
- **`runtime/emit/update.ts`**: phase-2 whole-row `coerceGenerated` replaced with
  per-cell `buildCellCoercion` applied inside the loop, before the next
  generated column reads `updatedRow` — the order `executeUpsertUpdate` already
  used. The `dml-executor.ts` NOTE describing the divergence is rewritten: the
  three sites (INSERT chain, UPDATE phase 2, upsert recompute) now agree.
- `buildNotNullDefaults` / OR REPLACE substitution deliberately NOT changed.

## Validation performed (floor, not finish line)

Scratch script against the built package verified every baseline from the
implement ticket flips to declared form:

- `create table G (Id text primary key, V json, Note text null, L integer generated always as (length(V)))`;
  `insert … ('a','"Bob"','n1')` → `L=3` (was 5); after `update G set Note='n2'` → still 3.
- ALTER backfill vs later INSERT of the same JSON value: both store `L=3`.
- `add column k text default (new.j)`: backfill and later INSERT both store `k='Bob'` (INSERT stored `'"Bob"'` before).
- datetime generated TEXT copy: INSERT now canonicalizes identically to UPDATE (`2024-01-02T03:04:05`, no `.000Z`).
- Literal JSON default + generated-from-generated chain: `j='xy'`, `L=2`, `L2=3`.
- Upsert `do update set V = excluded.V` recompute: `L=5` for `"Alice"` — still correct.

Suite watchlist from the implement ticket (`15.1.1-json-check-coercion`,
`06.9.1-json-coerce-once`, `41*`, `03.4-defaults` sqllogic files,
`test/dml-write-representation.spec.ts`, `test/optimizer/dml-child-exposure.spec.ts`)
all pass inside the full run.

## Findings to carry into review

- **Upsert arm was already correct before this change** (verified at HEAD):
  `executeUpsertUpdate` converts user assignments per-cell and recomputes
  generated columns against the composed converted row. Only its NOTE changed.
- **No plan-golden churn materialized.** The implement ticket predicted
  regeneration in `test/plan/`, but those specs assert shape programmatically
  and none pins the INSERT expansion projection at WriteCoercion granularity —
  the whole suite passed with zero test-file edits. Reviewer: confirm no
  snapshot-style golden exists elsewhere that should now pin the new shape.
- **Multi-source envelope siblings unchanged (pre-existing, out of scope):**
  a sibling logical column reached only through `defaultRowContextScope` (the
  multi-source view-insert envelope) still resolves to raw envelope attributes,
  i.e. written form. Only columns of the member's own table get the converted
  read.
- **No new tests were added in this ticket** — Arm B (contract tests pinning
  which value form each write shape sees) and Arm C (docs/release note) live in
  `4.5-write-form-contract-tests-and-docs`. The scratch verification above is
  not committed; the permanent pin is that ticket's job.

## Known gaps / accepted costs for reviewer judgment

- Identity-matched constrained columns get a guard-only WriteCoercion wrap in
  the projection AND emitInsert's identity guard — a double conformance check
  per such cell on non-fast-path inserts. Cheap (one typeof-class probe each),
  and the fast path is unaffected; flagging rather than optimizing.
- `expression-fingerprint.ts` has no WriteCoercion case, so it falls to the
  unique `_UK:` fingerprint — no CSE across identical coercions. Accepted in
  the design; confirm that is still fine.
- A coerced supplied column is a computed projection, so `ProjectNode` marks it
  `generated: true` in the output RelationType and source keys/FDs do not
  project through it (WriteCoercion is not injective). Nothing downstream of the
  INSERT expansion consumed those keys in the suite; reviewer may want to
  confirm no optimizer rule reads the expanded source's key set.

description: INSERT now converts each value to its column's declared type before computed and DEFAULT expressions read it, so those expressions see the same value that gets stored — matching what UPDATE and the other write paths already did.
files:
  - packages/quereus/src/planner/building/insert.ts               # coerceToDeclared + the decomposed three-stage expansion chain
  - packages/quereus/src/planner/building/default-scope.ts        # buildRowDefaultScope — optional columnIndexes
  - packages/quereus/src/planner/nodes/scalar.ts                  # WriteCoercionNode
  - packages/quereus/src/runtime/emit/write-coercion.ts           # emitter
  - packages/quereus/src/runtime/emit/update.ts                   # phase-2 per-cell coercion
  - packages/quereus/src/runtime/emit/insert.ts                   # emitInsert's row coercion (now a conformance guard for coerced cells)
  - packages/quereus/src/planner/nodes/project-node.ts            # attribute `generated` flag / key projection
  - docs/sql-ddl.md                                               # DEFAULT and GENERATED sections
----

# Complete: INSERT DEFAULT/GENERATED expressions see the converted row

Implemented in commits `af80df49a` + `3499dccd5`; reviewed across two runs (the second a
budget-stop continuation of the first).

## What landed

An INSERT's row-expansion projection converts every produced cell to its column's declared
type *in place*, so anything evaluated later in the chain — an expression DEFAULT reading a
supplied sibling via `new.<col>`, a generated column, a generated column reading another
generated column — sees the value in the form that will be stored. This matches what the
UPDATE, upsert DO UPDATE, and `ALTER TABLE ... ADD COLUMN` backfill paths already handed the
same expressions. `emitInsert`'s row conversion degrades to a conformance guard for cells the
projection already converted, preserving convert-exactly-once.

The chain, each stage present only when needed: base expansion (supplied and literal-default
cells converted, NULL placeholders elsewhere) → expression-DEFAULT projection over the
converted row → the generated-column chain.

## Review findings

### Checked

Read the implement diff first, then ran ad-hoc INSERT/UPDATE/ALTER scenarios against the
engine through `node --import ./packages/quereus/register.mjs` (scratch script deleted;
nothing committed from it). Confirmed by running:

- Expression DEFAULT reading a supplied sibling (`k text default (new.j)` over a `json`
  column) stores the converted value, and agrees with the `ALTER TABLE ... ADD COLUMN`
  backfill for the same value.
- Generated columns, including generated-reading-generated, see converted inputs.
- Target columns listed out of table order (`insert into t (b, a) ...`) — exercises the new
  remapping of supplied attributes into the expanded row.
- `insert into ... select ...`, multi-row `VALUES`, `RETURNING`, `on conflict ... do update`
  with `excluded.<col>`, and the `insert or replace` NOT NULL DEFAULT substitution all
  produce the converted form.
- Mutation-context (`with context`) shadowing still holds: a bare name in a DEFAULT resolves
  to the context variable, `new.<col>` to the column.
- No double-conversion hazard: `columnSchemaToScalarType` reuses the column's own
  `logicalType` object, so `buildCellCoercion`'s identity test matches and `emitInsert`
  degrades to a storage-class probe rather than re-parsing already-parsed JSON. Checked JSON,
  `date`, `integer`, and the idempotence-sensitive literal defaults (`json default '"5"'`);
  the DEFAULT path and the explicitly-supplied path agree row for row.
- Literal DEFAULT values that cannot convert are still rejected at `CREATE TABLE`, with the
  original message — plan-time folding of the conversion does not degrade it.
- Constant folding, key/functional-dependency projection, and the plan-node physical-property
  fold all treat the new node conservatively and safely.

**No defect was found in the change's behaviour.** The findings below are hygiene, metadata
accuracy, and documentation.

### Minor — fixed in this pass

- **`createRowExpansionProjection` was ~170 lines covering three sequential stages.**
  Decomposed into `buildBaseExpansion`, `buildExpressionDefaultProjection`, and the existing
  `createGeneratedColumnProjection`, leaving the top-level function as the chain it describes.
  Extracted `sourceMatchesTableShape` and the `isExpressionDefault` type predicate.
- **Repeated cell constructions.** The pass-through `ColumnReferenceNode` was written out
  identically in two stages and the NULL placeholder three times; both are now one helper
  each (`passThroughCell`, `nullPlaceholder`).
- **`buildRowDefaultScope` recorded a stale column position for the INSERT caller.** It built
  each `new.<col>` reference with the column's position in the *target column list*, which
  stopped being where the column sits once the INSERT caller began passing attributes from
  the expanded row (table positions). Runtime was unaffected — value lookup goes through the
  attribute id — but planner analyses do read the field. Fixed by an optional `columnIndexes`
  parallel array; it defaults to the old behaviour, so the view-mutation and ALTER callers,
  which were already correct, are untouched.
- **Documentation gap in `docs/sql-ddl.md`.** The DEFAULT and generated-column sections said
  how an expression may spell a sibling but never what form the value is in. One sentence
  added to each, cross-referencing `docs/types.md`. The fuller contract write-up belongs to
  `4.5-write-form-contract-tests-and-docs` and was deliberately not duplicated here.

### Tripwires — recorded at the code site, no tickets filed

- **Keys and functional dependencies no longer project through a converted cell** — a wrapped
  supplied column is a computed projection, so `ProjectNode` does not carry the source's
  unique keys through it. Conservative and correct (a conversion collapses spellings), whole
  suite passes. `NOTE:` parked at the wrap site in `buildBaseExpansion`
  (`packages/quereus/src/planner/building/insert.ts`): the fix, if an optimizer rule ever
  needs the expanded source's key set, is an injectivity claim on the coercion node, not
  dropping the wrap.
- **Two conformance probes per constrained supplied cell** on non-fast-path inserts — one in
  the projection, one in `emitInsert`. Deliberate: a source's announced type is an inference,
  not a guarantee, so `emitInsert`'s pass cannot be skipped. `NOTE:` parked at `emitInsert`'s
  coercion (`packages/quereus/src/runtime/emit/insert.ts`) naming the provenance-flag fix if
  it ever shows up in a profile.

### Considered and closed — no action, with reasons

- **No common-subexpression sharing across conversions** (the new node has no fingerprint
  case). Harmless: every conversion wraps a different cell of the same row, so there is no
  pair to share, and a unique fingerprint can only miss a merge, never make a wrong one.
- **A sibling column of another table reached through the multi-source view-insert envelope
  still resolves to the written form.** Pre-existing, outside this change's scope, already
  recorded in the implement handoff.
- **No plan-golden test churn.** The plan tests assert shape programmatically; none pins the
  INSERT expansion at this granularity.

### Major findings

None. Nothing rose to a new `fix/`, `plan/`, or `backlog/` ticket — the correctness pass
found no defect, and the four items above were all small enough to resolve inline.

### Appended to an existing ticket

`packages/quereus/src/planner/building/insert.ts` measures 1,146 lines (`wc -l`, 2026-09-01),
up from ~1,050 before this change; the decomposition above traded a long function for named
helpers and their doc comments, so the file total did not come back under the seam. Appended
as an arm to `backlog/debt-oversized-source-files` with the measurement, rather than filed
fresh.

### Validation

- `yarn workspace @quereus/quereus lint` — clean (eslint + the test-file `tsc` pass).
- `yarn test` — all workspaces green; `@quereus/quereus` reports **10,281 passing, 0 failing,
  25 pending**, matching the implement-stage baseline exactly.
- No pre-existing failures surfaced, so `tickets/.pre-existing-error.md` was not written.

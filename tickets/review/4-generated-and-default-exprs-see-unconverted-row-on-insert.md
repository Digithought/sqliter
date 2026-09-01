description: Continue the code-review pass of the change that makes INSERT convert values to each column's declared type before computed and DEFAULT expressions read them. Correctness was already checked by hand and holds; what remains is three small tidy-up edits, a documentation line, and the lint and test run.
files:
  - packages/quereus/src/planner/building/insert.ts               # coerceToDeclared + the three-stage expansion chain (lines ~46-255)
  - packages/quereus/src/planner/building/default-scope.ts        # buildRowDefaultScope — columnIndex now stale for the insert caller
  - packages/quereus/src/planner/nodes/scalar.ts                  # WriteCoercionNode
  - packages/quereus/src/runtime/emit/write-coercion.ts           # emitter
  - packages/quereus/src/runtime/emit/update.ts                   # phase-2 per-cell coercion
  - packages/quereus/src/runtime/emit/insert.ts                   # emitInsert's row coercion (now a guard for coerced cells)
  - packages/quereus/src/planner/nodes/project-node.ts            # attribute `generated` flag / key projection
  - docs/sql-ddl.md                                               # DEFAULT (~line 402) and GENERATED (~line 360-372) sections
difficulty: medium
----

# Review (continuation): INSERT DEFAULT/GENERATED expressions see the converted row

Continuation of the same-slug review ticket after a budget stop. **The adversarial
correctness pass is done and is recorded below — do not redo it.** What is left is a
short list of tidy-up edits, one documentation line, and the mandatory validation run.

The implement-stage diff is commit `3499dccd5` (code) plus `af80df49a` (the
`PlanNodeType.WriteCoercion` enum entry and the ticket split).

## Findings already established (verified this run)

Verified by reading the diff and by running ad-hoc INSERT/UPDATE/ALTER scenarios against
the engine through `node --import ./packages/quereus/register.mjs`. Scratch script was
deleted; nothing was committed from it.

**Correct, confirmed by running it:**

- Expression DEFAULT reading a supplied sibling (`k text default (new.j)` over a `json`
  column) now stores the converted value, and matches what the `ALTER TABLE ... ADD COLUMN`
  backfill produces for the same value.
- Generated columns, including generated-reading-generated, see converted inputs.
- Target columns listed out of table order (`insert into t (b, a) ...`) resolve correctly —
  this exercises the new remapping of supplied attributes into the expanded row.
- `insert into ... select ...` (relational source), multi-row `VALUES`, `RETURNING`,
  `on conflict ... do update` with `excluded.<col>`, and the `insert or replace` NOT NULL
  DEFAULT substitution all produce the converted form.
- Mutation-context (`with context`) shadowing still holds: a bare name in a DEFAULT
  resolves to the context variable, `new.<col>` to the column.
- No double-conversion hazard. `columnSchemaToScalarType` reuses the column's own
  `logicalType` object, so the identity test inside `buildCellCoercion` matches and
  `emitInsert` degrades to a conformance guard rather than re-parsing an already-parsed
  JSON value. Checked JSON, `date`, `integer`, and literal DEFAULT values, including the
  idempotence-sensitive ones (`json default '"5"'`); the DEFAULT path and the
  explicitly-supplied path agree row for row.
- Literal DEFAULT values that cannot convert are still rejected at `CREATE TABLE`, with
  the original message — the new plan-time folding of the conversion does not degrade it.
- Constant folding, key/functional-dependency projection, and the plan-node physical
  property fold all treat the new node conservatively and safely (see the two accepted
  costs below).

**No new defect was found in the change's behaviour.** The remaining items are hygiene,
metadata accuracy, and documentation.

### Minor — fix in this pass

- **`createRowExpansionProjection` is now ~170 lines covering three sequential stages**
  (`packages/quereus/src/planner/building/insert.ts`, lines ~62-255). Repo convention is
  small single-purpose functions and decomposed sub-functions over grouped sections.
  Extract the base expansion and the expression-DEFAULT stage into named helpers,
  leaving the top-level function as the three-line chain it describes.
- **Repeated cell constructions.** The "pass through the child's cell at this position"
  projection (a `ColumnReferenceNode` built from an input attribute) is written out
  identically in the expression-DEFAULT stage and in the generated-column chain; the NULL
  placeholder expression is written out three times. Both want one small shared helper.
- **`buildRowDefaultScope` now records a stale column position for the INSERT caller.**
  `packages/quereus/src/planner/building/default-scope.ts` builds each `new.<col>`
  reference with `columnIndex = <position within the target column list>`. That was right
  when the caller passed the source relation's own attributes; the INSERT caller now
  passes attributes taken from the expanded row, where the column sits at its *table*
  position instead. Runtime is unaffected — value lookup goes through the attribute id and
  the producing relation's row descriptor, never this field — but the field is planner
  metadata other analyses do read (materialized-view matching, for one), so it should not
  be left wrong. Smallest correct fix: let the caller supply the positions (an optional
  parallel array, defaulting to the current behaviour so the view-mutation caller, which is
  still correct, is untouched).
- **Documentation gap in `docs/sql-ddl.md`.** The DEFAULT section (~line 402) and the
  generated-column section (~lines 360-372) describe exactly *how* an expression may spell
  a sibling column, but never say *what form the value is in* when it reads one — which is
  precisely what this change settled. Add one sentence to each saying the sibling is read
  already converted to its declared type, cross-referencing `docs/types.md`. Keep it to
  that: the fuller write-up of the contract, `docs/types.md` itself, `docs/invariants.md`,
  and the release note all belong to `4.5-write-form-contract-tests-and-docs` — do not
  duplicate them here.

### Tripwires — record at the code site, do not file tickets

- **Keys and functional dependencies no longer project through a converted cell.** A
  supplied column wrapped for conversion is a computed projection, so `ProjectNode` marks
  it generated and does not carry the source's unique keys through it. This is the
  conservative and correct answer (a conversion collapses spellings, so distinctness is not
  preserved), and the whole suite passes, but it means a non-fast-path
  `insert into t (cols) select ...` presents a keyless source to everything downstream.
  Park a `NOTE:` at the wrap site in `insert.ts`: if an optimizer rule ever needs the
  expanded source's key set, the fix is to teach the node an injectivity claim for the
  cases where conversion provably preserves distinctness, not to drop the wrap.
- **Two conformance probes per constrained supplied cell** on non-fast-path inserts — once
  in the projection, once in `emitInsert`. Deliberate: `emitInsert`'s pass exists because a
  source's announced type is an inference, not a guarantee, so it cannot be skipped on the
  strength of the projection's announcement. Cheap (one storage-class probe each) and the
  fast path is untouched. Park a `NOTE:` at `emitInsert`'s coercion.

### Considered and closed — no action

- **No common-subexpression sharing across conversions** (the new node has no
  fingerprint case, so each gets a unique one). Confirmed harmless: every conversion wraps
  a different cell of the same row, so there is no pair to share, and a unique fingerprint
  can only miss a merge, never make a wrong one. Say so in the findings; add no code.
- **A sibling column of another table reached through the multi-source view-insert
  envelope still resolves to the written form.** Pre-existing, out of this change's scope,
  and already recorded in the implement handoff.
- **No plan-golden test churn.** Confirmed: the plan tests assert shape programmatically
  and none pins the INSERT expansion at this granularity.

### Possible arm for an existing ticket

`packages/quereus/src/planner/building/insert.ts` measured 1,120 lines
(`wc -l`, 2026-09-01), up from roughly 1,050 before this change. The backlog ticket
`debt-oversized-source-files` collects files past that seam and does not list this one.
Append it there as an arm with the measured count if the decomposition above does not
bring it back under — do not file a new ticket.

## TODO

- Apply the four minor fixes above (decompose, DRY the repeated cells, correct the
  recorded column position, the two `docs/sql-ddl.md` sentences).
- Add the two tripwire `NOTE:` comments.
- Append the `insert.ts` line count as an arm to `debt-oversized-source-files` if it is
  still over after the decomposition.
- Run `yarn workspace @quereus/quereus lint` and `yarn test` in the foreground, streaming
  (no redirection), and confirm both are clean. Baseline from the implement stage: 10,281
  passing, 0 failing, 25 pending; lint clean.
- Write the `complete/` ticket with a `## Review findings` section built from the sections
  above — what was checked, what was found, what was done, and the empty categories with
  their reasons.

---
description: A write's values are now converted to their declared column types once, at the top of the DML pipeline, so updating one column no longer silently rewrites or errors on a JSON column the statement never touched.
files:
  - packages/quereus/src/types/validation.ts                 # new buildRowCoercion helper (the static-type mask)
  - packages/quereus/src/runtime/emit/insert.ts              # converts the NEW section by source-attribute types
  - packages/quereus/src/runtime/emit/update.ts              # converts assigned cells by assignment type, unassigned by source type
  - packages/quereus/src/runtime/emit/constraint-check.ts    # coerceNewSection deleted; OR REPLACE default substitution converts its one cell
  - packages/quereus/src/runtime/emit/dml-executor.ts        # preCoerced on all 4 vtab.update sites; DO UPDATE assignment conversion; conflict-target match simplified
  - packages/quereus/src/runtime/foreign-key-actions.ts      # anyReferencedColumnChanged is now plain identity
  - packages/quereus/src/planner/nodes/dml-executor-node.ts  # conflictTargetTypes plan field removed
  - packages/quereus/src/planner/building/insert.ts          # ...and no longer populated
  - packages/quereus/src/vtab/table.ts                       # UpdateArgs.preCoerced contract rewritten
  - packages/quereus/src/vtab/memory/layer/manager.ts        # comment updated (behavior was the prereq's)
  - packages/quereus-isolation/src/isolated-table.ts         # honors preCoerced, forwards it to overlay writes
  - packages/quereus/test/logic/06.9.1-json-coerce-once.sqllogic   # new memory+store coverage
  - packages/quereus-store/test/json-semantic-key-order.spec.ts    # new UPDATE section; six-kinds test adjusted (see behavior change)
  - docs/types.md                                            # § "Where coercion happens" rewritten
  - docs/runtime.md                                          # deferred-constraint row description updated
---

# Review: convert a write's values once, where their type is known

## What was built

The rule from the implement ticket, applied end to end: a DML write's cells are
converted to the declared column logical types **once, in the DML emitters**,
and a cell converts **iff the producing expression's static `LogicalType` is
not — by object identity — the column's type**. The type registry hands out one
shared instance per type, so identity comparison is sound; the singletons make
"reference to a same-typed column" (an unassigned UPDATE column, `insert into b
select j from a`) an exact match that skips conversion, which is the fix: JSON
conversion is not repeatable (stored text `9` re-parses to the number 9; `abc`
throws).

- `buildRowCoercion` (types/validation.ts) precomputes the per-statement mask
  and returns `undefined` when nothing converts — zero per-row cost then.
- `emitInsert` masks by the source relation's attribute types (source is
  projected into table-column order by the builder).
- `emitUpdate` masks assigned columns by their assignment expression's type and
  unassigned columns by the source attribute's type at that index (so a
  non-scan source converts by the same rule, never by an "unassigned ⇒
  converted" assumption).
- Two late-injection paths convert their single cell by the same rule: the
  `OR REPLACE` NOT NULL DEFAULT substitution (constraint-check.ts) and
  `ON CONFLICT … DO UPDATE` assignments (dml-executor.ts,
  `assignmentCoercions`).
- The executor passes `preCoerced: true` on all four `vtab.update` sites
  (upsert-update, insert, update, delete). Memory manager (prereq) and
  StoreTable already honored it; `IsolatedTable` now honors it and forwards it
  on every overlay data write (including `writeRelocatedRow` and the
  tombstone-revive update).
- Downstream re-conversions deleted: `coerceNewSection` (constraint check now
  reads the row directly), the per-row affinity coercion in
  `conflictTargetValuesMatch` (collation compare remains), and the coerce-and-
  recompare fallback in `anyReferencedColumnChanged` (now plain
  `sqlValueIdentical` over both stored-form rows). The now-unused
  `conflictTargetTypes` plan plumbing was removed.

Direct `vtab.update` API callers, external-change apply, and MV maintenance
writes leave `preCoerced` unset — the storage layer still converts raw values
for them; the public vtab contract is unchanged (doc on `UpdateArgs.preCoerced`).

## Validation run

`yarn build`, `yarn lint`, `yarn typecheck`, `yarn test` (all workspaces:
quereus 7189, store 1017+, isolation, sync — all green), `yarn test:store`
(7183 green). New coverage:

- `test/logic/06.9.1-json-coerce-once.sqllogic` (runs on memory AND store
  backends): all four repros from the fix ticket — UPDATE of an unmentioned
  column (`'"9"'` stays the JSON text 9; `'"abc"'` no longer errors),
  `insert into b select j from a`, `update c set j = j`,
  `update d set j = '"abc"'` still converts, `'[2]'` still inserts a list, a
  conversion error still names the column, a CHECK (`j <> 9`) sees the stored
  JSON string scalar on an UPDATE that never mentions j, and ON CONFLICT DO
  UPDATE with both `excluded.j` (pass-through) and a TEXT literal (converts).
- `quereus-store/test/json-semantic-key-order.spec.ts`: new "UPDATE of a
  non-key column" section (number-spelled string key stays byte-identical;
  invalid-JSON-source key doesn't throw; self-assignment no-op; assigned
  literal still converts) — store backend with the memory table as oracle —
  plus an in-transaction overlay UPDATE case.

## Behavior changes a reviewer should weigh

1. **NOT NULL now sees the converted value.** JSON text `'null'` converts to
   SQL NULL, so inserting it into a NOT NULL (or PK) JSON column now fails NOT
   NULL. At HEAD the check inspected the raw text, passed, and the storage
   layer silently stored a NULL key in a NOT NULL PK column. I judged the new
   behavior correct and pinned it (sqllogic + store spec); the store spec's
   "six JSON kinds" scan test was reworked because its `'null'` PK row is now
   rejected — the null *rank* is pinned via ORDER BY on a nullable column
   instead. This is a deliberate change to previously-pinned behavior.
2. **Identity-matched cells skip validation, not just parsing.** The skip rule
   trusts declared static types. Builtins declaring a JSON return type were
   audited (`json()`, `json_group_array`, `json_group_object` — all return
   native values; `json_extract` and friends declare no return type). A
   third-party function that declares a return logical type but returns
   non-declared-form values now stores them unconverted and unvalidated,
   where before the storage layer would convert/reject. Documented in
   docs/types.md; flagged here rather than guarded in code.
3. **Conversion errors surface earlier** (emitter instead of storage layer),
   before constraint checking. Message text unchanged (`validateAndParse`
   produces it); all existing error-asserting sqllogic expectations pass.
4. **`anyReferencedColumnChanged` is identity-only.** Safe-direction analysis:
   executor paths now hand it converted rows; external-change apply runs with
   FK RESTRICT suppressed; MV-apply rows derive from stored rows. A future
   caller handing a raw NEW row would get a spurious "changed" — which costs a
   redundant probe on the cascade path but could raise a spurious RESTRICT
   error on the assert path. Worth a reviewer pass over
   `assertTransitiveRestrictsForParentMutation` callers.

## Known gaps / notes for the reviewer

- The "too many values" width guard inside `coerceRowToSchema` no longer runs
  for engine writes (preCoerced skips the whole helper). Width is structural on
  those paths (builders project the source into table shape); the existing
  NOTE in `manager.ts` says to hoist the guard if that ever changes.
- `preCoerced` is set on DELETE too — it only vouches for `oldKeyValues`
  (scanned, already stored-form); neither backend converts delete keys today.
- Generated-column UPDATE expressions still evaluate against the pre-conversion
  values of sibling regular assignments (unchanged from HEAD; conversion runs
  after both assignment phases).
- While writing tests I found a pre-existing comparison quirk (`json_quote(j) =
  '"9"'` is false even when json_quote returns exactly that text) — filed as
  `backlog/bug-json-typed-comparison-reparses-text-literal`, not touched here.
- `backlog/bug-json-text-scalar-reparsed-on-write` describes the exact defect
  this ticket fixed (a JSON text value spelled like a number does not survive a
  write). It looks superseded now — left in place for the human to retire.

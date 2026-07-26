---
description: Changing any column of a row whose JSON column holds a plain piece of text silently rewrites that text as a number, or fails with a conversion error naming a column the statement never touched; copying such rows between tables fails the same way.
prereq: json-tombstone-recoerces-stored-key
files:
  - packages/quereus/src/runtime/emit/insert.ts              # emitInsert — builds the flat OLD/NEW row for INSERT
  - packages/quereus/src/runtime/emit/update.ts              # emitUpdate — merges assignments over the scanned row
  - packages/quereus/src/runtime/emit/dml-executor.ts        # the 4 vtab.update call sites (~525, ~844, ~1094, ~1260); conflictTargetValuesMatch (~80)
  - packages/quereus/src/runtime/emit/constraint-check.ts    # coerceNewSection (~457) and its phase-order comment (~242)
  - packages/quereus/src/runtime/foreign-key-actions.ts      # anyReferencedColumnChanged (~100)
  - packages/quereus/src/types/validation.ts                 # coerceRowToSchema / validateAndParse
  - packages/quereus/src/vtab/memory/layer/manager.ts        # performInsert / performUpdate — honor preCoerced (from the prereq)
  - packages/quereus-store/src/common/store-table.ts         # already honors preCoerced (~1797, ~1924)
  - packages/quereus-isolation/src/isolated-table.ts         # coerceRow (~1090) and the comment at ~1119
  - docs/types.md                                            # § "Where coercion happens (and why exactly once)"
  - packages/quereus-store/test/json-semantic-key-order.spec.ts
difficulty: hard
---

# Convert a write's values once, where their type is known

## The rule that is broken

`docs/types.md` § "Where coercion happens (and why exactly once)" states the
current architecture: a row travelling through an INSERT/UPDATE plan carries
**raw** values (the literal text the statement supplied), and the storage layer
converts every cell to the declared column type exactly once, on its own.

That premise is false for two common shapes:

- **UPDATE**: the row handed to the storage layer is the *scanned* row with the
  assigned columns overwritten. Every column the statement did not assign is a
  value that came **out of** storage, already converted.
- **INSERT … SELECT**: every value came out of storage, already converted.

So those cells get converted a second time. For most types conversion is
repeatable and nothing shows. For JSON it is not: a JSON value that is a plain
piece of text is held as a JavaScript string, indistinguishable from unparsed JSON
source, so converting it again either changes it (the text `9` becomes the number
9) or throws (`abc` is not valid JSON source).

## Reproductions (all observed at HEAD)

```sql
create table m (j json primary key, v text);
insert into m values ('"9"', 'a'), ('"9.0"', 'b');
update m set v = 'X' where v = 'a';
-- the touched row's key silently changed from the text "9" to the number 9
```

```sql
create table m2 (j json primary key, v text);
insert into m2 values ('"abc"', 'a');
update m2 set v = 'X';
-- QuereusError: Type conversion failed for column 'j':
--   Cannot convert 'abc' to JSON: invalid JSON syntax     ← 'j' was never assigned
```

```sql
insert into b select j from a;   -- same conversion error
update c set j = j;              -- same conversion error
```

Both the memory backend and the store backend are affected (they share
`coerceRowToSchema`).

## The fix: convert where the value's type is known

Conversion cannot be made repeatable — for the JavaScript string `9`, "already
converted" and "unparsed JSON source" are both plausible readings and they
disagree. But the planner already knows which it is: the *static type* of the
expression that produced the cell.

Rule: **convert cell `i` if and only if the producing expression's logical type is
not already the target column's logical type.**

- a SQL literal `'"abc"'` is TEXT → into a JSON column, convert;
- a reference to a JSON column is JSON → into a JSON column, already in declared
  form, leave alone;
- an unassigned column in an UPDATE takes the source relation's attribute type,
  which for the ordinary "scan the target table" source is the declared column
  type → leave alone.

Compare the `LogicalType` objects by identity, not by name. Everything that is not
an exact type match keeps converting exactly as it does today, so no non-JSON
behaviour changes in practice (`INTEGER` ← `INTEGER` was already a no-op, while
`INTEGER` ← `REAL`, which is what a bare integer literal produces, still converts).

The static types were instrumented during the fix stage and are exactly as needed:

| statement | observed target ← source |
|---|---|
| `insert into a values ('"9"')` | `j:JSON ← TEXT` (convert) |
| `insert into b select j from a` | `j:JSON ← JSON` (skip) |
| `update c set j = j` | `j(JSON) ← JSON` (skip) |
| `update d set j = '"abc"'` | `j(JSON) ← TEXT` (convert) |
| `update e set v = 'X'` | only `v(TEXT) ← TEXT`; `j` not assigned at all |
| `insert into f values (1, …)` | `i:INTEGER ← REAL` (convert — affinity still applies) |

## Where to apply it

Do the conversion at the **top of the DML pipeline**, so a single converted row
flows through constraint checking and into the storage layer:

- `emitInsert` — the mask comes from `plan.source.getAttributes()[i].type.logicalType`
  against `plan.table.tableSchema.columns[i].logicalType`. The source is already
  projected into full table-column order, so the two align positionally.
- `emitUpdate` — for an assigned column, the mask comes from
  `assignment.value.getType().logicalType` (this covers generated-column
  assignments too); for an unassigned column, from the source relation's attribute
  type at that index. Do not assume "unassigned ⇒ already converted" — read the
  source attribute type, so a non-scan source (view decomposition, member insert)
  is handled by the same rule.

Precompute the mask at emit time and build one closure per statement; skip the
per-row work entirely when nothing needs converting.

Once the NEW section is converted up front:

- `dml-executor.ts` passes `preCoerced: true` on its `vtab.update` calls (four
  sites: ~525, ~844, ~1094, ~1260). The prereq ticket made the memory backend
  honor it; `StoreTable` already does.
- `IsolatedTable.coerceRow` must be skipped when the caller says `preCoerced`, and
  the flag forwarded to the overlay writes. The comment at `isolated-table.ts`
  ~line 1119 documents today's workaround (deliberately writing the *un*converted
  row to the overlay) and needs rewriting, not preserving.
- `constraint-check.ts`'s `coerceNewSection` becomes redundant — the row it is
  handed is already converted. Deleting it also fixes a smaller latent bug: today
  that snapshot re-converts carried-over JSON, so a CHECK constraint on a table
  being UPDATEd sees a damaged value.
- `conflictTargetValuesMatch` (`dml-executor.ts` ~line 80) re-converts the proposed
  value per conflicting row; the proposed value is now already converted.
- `anyReferencedColumnChanged` (`foreign-key-actions.ts` ~line 100) re-converts the
  new value to compare it against the stored old value; both are now converted, so
  the comparison is a plain identity check. Its doc comment cites this ticket.

Two paths still need their own single-cell conversion, because they inject a value
*after* the mask has been applied:

- NOT NULL `OR REPLACE` default substitution
  (`checkNotNullConstraints`, `constraint-check.ts` ~line 317) writes a DEFAULT
  expression's raw result into the NEW section. Convert that one cell there, using
  the same rule against the default expression's type.
- `ON CONFLICT … DO UPDATE` assignments, evaluated in the executor from the
  `RuntimeUpsertClause`, need the same per-assignment mask as `emitUpdate`.

Leave `preCoerced` **unset** on write paths that do not go through the DML
executor (external-change apply, materialized-view maintenance writes, direct
`vtab.update` API use). Those keep handing raw values to the storage layer, which
keeps converting them — the public contract is unchanged.

## Constraints on the solution

- The SQL literal `'"abc"'` must still insert the JSON text value `abc`, and
  `'[2]'` must still insert a list.
- Do not regress `bug-store-isolation-upsert-affinity-coerced-pk`: a TEXT `'1'`
  proposed against an INTEGER key holding `1` must still be converted before the
  isolation layer probes for an existing row. Under the new scheme that conversion
  happens earlier (in the emitter), so the probe still sees a converted key — but
  verify it, the store/isolation upsert tests are the guard.
- Audit scalar functions that declare a JSON return type: the skip rule trusts the
  declaration, so any function declaring JSON while returning *serialized* text
  would now store the text unconverted. `json()`, `json_extract`, `json_insert`
  and friends live in `packages/quereus/src/func/builtins/`.
- `coerceNewSection` currently swallows conversion failures and lets the storage
  layer report them. After the move, the conversion error surfaces from the
  emitter instead. The message is produced by the same `validateAndParse`, so the
  text is unchanged, but the site moves — check `test/logic/*.sqllogic` expectations
  that assert on conversion errors.

## TODO

**Phase 1 — convert at the emitter**

- Add a shared helper (near `coerceRowToSchema` in `types/validation.ts`) that,
  given per-cell source logical types and the target columns, returns either
  `undefined` (nothing to convert) or a row-conversion closure.
- Use it in `emitInsert` when filling the NEW section of the flat row.
- Use it in `emitUpdate` for both the regular and the generated assignment passes.
- Convert the substituted DEFAULT value in `checkNotNullConstraints`.
- Apply the same mask to `ON CONFLICT … DO UPDATE` assignments in the executor.

**Phase 2 — stop converting downstream**

- Pass `preCoerced: true` from the four `vtab.update` call sites in
  `dml-executor.ts`.
- Skip `IsolatedTable.coerceRow` when `preCoerced`, forward the flag to the
  overlay writes, and rewrite the ~line 1119 comment.
- Delete `coerceNewSection` and simplify `checkConstraints`' phase-order comment
  (`constraint-check.ts` ~line 242) — the reason it existed is gone.
- Drop the re-conversion in `conflictTargetValuesMatch` and in
  `anyReferencedColumnChanged`, updating both doc comments (the latter names this
  ticket explicitly).

**Phase 3 — tests and docs**

- `packages/quereus-store/test/json-semantic-key-order.spec.ts`: add the UPDATE
  cases the file currently avoids — updating a non-key column of a row keyed by a
  JSON string scalar leaves the key byte-identical, on the store backend and
  against the memory table as oracle; and the same for a key whose text is not
  valid JSON source.
- Add memory-backend coverage in `packages/quereus/test/logic/` for: UPDATE of an
  unmentioned column, `insert into b select j from a`, `update c set j = j`, and
  `update d set j = '"abc"'` (which must still convert).
- Add a case where a table with a CHECK constraint is UPDATEd without mentioning
  its JSON column — the CHECK must see the stored JSON value, not a re-converted
  one.
- Rewrite `docs/types.md` § "Where coercion happens (and why exactly once)": the
  conversion point moves from the storage layer to the DML emitters, driven by
  static types; the storage layer still converts for direct API callers and honors
  `preCoerced`. Remove the now-stale note that a coerced row must never reach the
  storage layer.
- `yarn build` before running `packages/quereus-store` tests (its mocha runner
  resolves `@quereus/quereus` from `dist/`). Then `yarn test`, `yarn lint`, and
  `yarn test:store` — this touches the store write path.

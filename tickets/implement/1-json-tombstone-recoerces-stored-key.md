---
description: Deleting a row whose JSON column holds a plain piece of text does nothing, or fails with a confusing conversion error, when the change happens inside a transaction on the persistent store.
prereq:
files:
  - packages/quereus/src/vtab/table.ts                       # UpdateArgs.preCoerced — the flag already exists
  - packages/quereus/src/vtab/memory/table.ts                # MemoryTable.update → performMutation (~line 287) — drops preCoerced
  - packages/quereus/src/vtab/memory/layer/manager.ts        # performMutation / performInsert (~829) / performUpdate (~875)
  - packages/quereus-isolation/src/isolated-table.ts         # delete branch (~1303-1355), insertTombstoneForPK (~1532)
  - packages/quereus-isolation/src/isolation-module.ts       # overlay rebuild insert (~941) — already passes preCoerced, silently ignored
  - packages/quereus-store/test/json-semantic-key-order.spec.ts  # regression home
difficulty: easy
---

# The delete marker copies a stored key and gets it re-converted

## Background: what "re-conversion" breaks

A JSON value can be a list, an object, or a plain scalar — including a plain piece
of text. Quereus keeps a JSON value in memory as the corresponding JavaScript
value, so the JSON text value `abc` is held as the JavaScript string `abc`, which
looks exactly like *unparsed JSON source* would. Converting a value "to JSON" is
therefore **not** repeatable: converting the already-converted `abc` a second time
either throws (`abc` is not valid JSON source) or silently changes it (`9` becomes
the number 9). `docs/types.md` § "Where coercion happens (and why exactly once)"
already states this rule — every value must be converted exactly once.

`UpdateArgs.preCoerced` (`packages/quereus/src/vtab/table.ts:35`) is the existing
opt-out: "these values are already in declared form, skip your conversion pass".

## What is wrong

Two independent gaps let a stored value be converted twice:

1. **The memory backend ignores `preCoerced`.** `MemoryTable.update` does not
   forward `args.preCoerced` to `MemoryTableManager.performMutation`, and
   `performInsert` / `performUpdate` run `coerceRowToSchema` over every cell
   unconditionally. `quereus-store`'s `StoreTable` *does* honor the flag
   (`store-table.ts:1797`, `:1924`), so today the flag works on one backend and is
   silently dropped on the other.

2. **The isolation layer's delete marker carries stored values.** Deleting a row
   inside a transaction does not remove anything immediately — it writes a
   "tombstone" row into the per-connection overlay, a memory table, to hide the
   committed row. That tombstone copies the deleted row's **primary key**, which
   came out of storage already converted. The overlay's memory table converts it
   again, so a JSON key holding the text `9` lands as the number 9: the tombstone
   sits at a key that hides nothing and the row stays visible. When the text is not
   valid JSON source (`abc`), the second conversion throws instead and the whole
   DELETE fails.

Reproduction (both observed at HEAD, `createIsolatedStoreModule`):

```sql
create table d (j json primary key, v text) using store;
insert into d values ('"9"', 'a'), ('"9.0"', 'b');
delete from d where v = 'a';
-- both rows still there, no error
```

```sql
create table d2 (j json primary key, v text) using store;
insert into d2 values ('"abc"', 'a');
delete from d2 where v = 'a';
-- QuereusError: Type conversion failed for column 'j':
--   Cannot convert 'abc' to JSON: invalid JSON syntax
```

Structured JSON (`'[2]'`, `'{"a":1}'`) converts to itself, which is why the
existing suite is green.

## The fix

Make the memory backend honor `preCoerced`, and set it on the overlay writes whose
row is built out of stored (already-converted) values.

Three overlay writes qualify, all in `isolated-table.ts`:

- the delete branch's "convert existing overlay row to a tombstone" update
  (~line 1322) — its row is sliced from a row the overlay itself wrote, so it is
  already converted;
- the delete branch's "insert a fresh tombstone" (~line 1343) — its key cells come
  from `oldKeyValues`, read from the source scan;
- `insertTombstoneForPK` (~line 1532), the same construction used by the
  primary-key-change path.

Everything else in `IsolatedTable.update` keeps passing **un**converted values to
the overlay and must be left alone — that is deliberate (see the comment at
~line 1119) and stays correct until `json-coerce-once-at-dml-source` lands.

This was verified end-to-end during the fix stage: with exactly these changes both
reproductions above behave correctly (row deleted, no error). The four remaining
UPDATE-side symptoms in the parent ticket are **not** addressed here — they are
`json-coerce-once-at-dml-source`.

## Side effect worth knowing

`isolation-module.ts:941` (overlay rebuild after a schema change) already passes
`preCoerced: true` to an overlay memory table and is silently ignored today, so
that path also converts twice. It starts working as intended with this change.

Audit the other existing `preCoerced: true` callers to confirm their rows really
are already converted before the flag starts biting on memory tables:
`quereus-isolation/src/flush.ts:77` and `:85` (overlay → underlying flush) — both
carry rows the overlay wrote, so both are fine.

## TODO

- Thread `args.preCoerced` from `MemoryTable.update` into
  `MemoryTableManager.performMutation`, and from there into `performInsert` /
  `performUpdate`; skip `coerceRowToSchema` when set. Document on the parameter
  why (values already in declared form; JSON conversion is not repeatable).
- Set `preCoerced: true` on the three isolation-layer tombstone writes listed
  above. Do **not** set it on any other overlay write in that file.
- Update the `preCoerced` doc comment in `packages/quereus/src/vtab/table.ts` — it
  currently says "used by the isolation layer's overlay→underlying flush"; the
  tombstone path is a second user.
- Add regression cases to
  `packages/quereus-store/test/json-semantic-key-order.spec.ts`, isolated-store
  section: an in-transaction DELETE of a row keyed by a JSON string scalar
  (`'"9"'` with a `'"9.0"'` sibling still present) removes exactly that row; the
  same with a key whose text is not valid JSON source (`'"abc"'`) does not throw.
  Cover both auto-commit and inside an explicit `begin`/`commit`.
- Run `yarn build` before the store tests — `packages/quereus-store`'s mocha
  runner resolves `@quereus/quereus` from `dist/`, not `src/`, so source edits
  are invisible until a build.
- `yarn test` and `yarn lint` green.

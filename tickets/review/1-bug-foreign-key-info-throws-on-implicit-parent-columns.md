description: Asking the database to describe a table's foreign keys crashed when one of those keys was written without naming the parent columns — a perfectly legal way to declare it. Fixed.
files:
  - packages/quereus/src/func/builtins/schema.ts        # foreign_key_info() fix, ~lines 335-378
  - packages/quereus/src/schema/table.ts                # resolveReferencedColumns (line 1016) — reused, unchanged
  - docs/functions.md                                   # foreign_key_info column table, "to" row now TEXT?
  - packages/quereus/test/logic/06.3.2-schema-foreign-keys.sqllogic       # 3 new cases (Tests 9-11)
  - packages/quereus/test/logic/41.5-cross-schema-foreign-keys.sqllogic   # 1 new case (implicit cross-schema)
  - packages/quereus/test/logic/41.10.3-alter-drop-column-referencing-fk.sqllogic  # introspection assertion added to §7
difficulty: easy
---

# `foreign_key_info()` mishandles a foreign key declared with no parent column list

## What was wrong

Original ticket (`tickets/implement/1-bug-foreign-key-info-throws-on-implicit-parent-columns.md`,
now deleted — see `git log` for full text) found `foreign_key_info()` had a second, divergent
copy of the parent-column resolution rule that `resolveReferencedColumns()`
(`schema/table.ts:1016`) already implements correctly for enforcement. The divergent copy:

- **Threw** for any implicit FK (no declared parent columns) whose parent lived in the
  default schema — `fk.referencedColumns` is always `[]` at the point `foreign_key_info`
  reads it (parent columns resolve lazily), so `columns[undefined].name` raised.
- **Silently returned the string `"undefined"`** as the `to` value when the parent lived
  in another schema (`db._findTable` was called without the schema arg) or didn't exist.

## Fix

Rewrote the resolution in `foreign_key_info()` (`func/builtins/schema.ts`) to resolve the
parent's column names **once per FK, before the per-`seq` loop**, reusing
`resolveReferencedColumns` from `schema/table.ts` instead of re-implementing it:

- Declared names (`fk.referencedColumnNames.length > 0`) are still reported verbatim —
  no parent lookup, so a dangling declared name stays printable instead of raising.
- Otherwise, parent is looked up with **both** `fk.referencedTable` and
  `fk.referencedSchema` (previously only the table name — this was the cross-schema bug).
  If found, `resolveReferencedColumns(fk, parentTable)` runs — with no declared names this
  always takes the primary-key branch, which cannot throw — and indices are mapped to
  `parentTable.columns[i]?.name`.
- If the parent can't be resolved, or the resolved index list comes back shorter than
  `fk.columns` (arity mismatch — the same case enforcement skips in
  `foreign-key-builder.ts:235`), the row's `to` is `null` rather than raising or printing
  the literal string `"undefined"`.

`to` in the TVF's return-type schema is now `nullable: true` (was `false`); docs updated
to match (`TEXT?`).

## Test coverage added

- `06.3.2-schema-foreign-keys.sqllogic` Tests 9–11: implicit single-column FK resolves to
  the parent's PK; implicit composite FK yields one row per PK column in PK order; FK
  whose parent table doesn't exist reports `to` as `NULL` (not a throw, not `"undefined"`).
- `41.5-cross-schema-foreign-keys.sqllogic`: new `mchild2` case — implicit (no column
  list) FK across schemas resolves `to` against the s2 parent's PK.
- `41.10.3-alter-drop-column-referencing-fk.sqllogic` §7 (`PkC references PkP`, no column
  list): added a direct `foreign_key_info` assertion (`to`:`"pid"`) alongside the existing
  enforcement-only check, since the enforcement check was originally standing in for
  introspection coverage that used to throw.

## Validation run

- `yarn workspace @quereus/quereus run test` — 9205 passing, 0 failing (full suite, all
  three touched `.sqllogic` files included).
- `yarn workspace @quereus/quereus run lint` — clean (eslint + test-file `tsc --noEmit`).
- Did **not** run `yarn test:store` (LevelDB store leg) — none of the touched files carry
  a `-- requires-capability:` directive and the change is purely read-path (a TVF), so the
  store leg should be unaffected, but it wasn't explicitly re-run this pass.

## Known gaps / things the reviewer should look at

- No new test for the "resolved list shorter than `fk.columns`" arity-mismatch branch
  specifically (parent exists, has a PK, but the PK has fewer columns than the FK
  declares) — the ticket's spec calls this out as a case that should yield `null`, and the
  code path handles it (`toColNames[seq] ?? null` where `seq` exceeds the mapped array),
  but it isn't exercised by a dedicated `.sqllogic` case. Enforcement already skips this
  case entirely (`foreign-key-builder.ts:235`), so it's a rare/malformed-schema corner.
- Did not add a case for a parent with **no primary key at all** (implicit FK +
  PK-less parent) — `resolveReferencedColumns` returns `[]` in that case and every row's
  `to` becomes `null`. Same reasoning as above: plausible edge case, not separately tested.
- `docs/functions.md` only got the one-line type/semantics update to the `to` row per the
  ticket's TODO; didn't audit the rest of that doc section for other drift.

description: Asking the database to describe a table's foreign keys crashed when one of those keys was written without naming the parent columns — a perfectly legal way to declare it. Fixed, reviewed, and covered by tests.
files:
  - packages/quereus/src/func/builtins/schema.ts        # foreign_key_info() fix + resolveForeignKeyParentColumnNames helper
  - packages/quereus/src/schema/table.ts                # resolveReferencedColumns (line ~1016) — reused, unchanged
  - docs/functions.md                                   # foreign_key_info column table: "to" and "referenced_schema" rows
  - packages/quereus/test/logic/06.3.2-schema-foreign-keys.sqllogic       # Tests 9-13
  - packages/quereus/test/logic/41.5-cross-schema-foreign-keys.sqllogic   # implicit cross-schema case
  - packages/quereus/test/logic/41.10.3-alter-drop-column-referencing-fk.sqllogic  # introspection assertion in §7
---

# `foreign_key_info()` mishandled a foreign key declared with no parent column list

## What was wrong

`foreign_key_info()` carried a second, divergent copy of the parent-column resolution rule
that `resolveReferencedColumns()` (`schema/table.ts`) already implements for enforcement.
That copy **threw** for any implicit foreign key (no declared parent columns) whose parent
lived in the default schema, and **printed the literal string `"undefined"`** when the
parent lived in another schema or didn't exist.

## Fix

Parent column names now resolve once per foreign key, before the per-`seq` loop, by
reusing `resolveReferencedColumns`:

- Declared names are reported verbatim — no parent lookup, so a dangling declared name
  stays printable instead of raising.
- Otherwise the parent is looked up with both table and schema, and the resolved indices
  map to the parent's column names.
- Unresolvable positions (unknown parent, or parent key narrower than the child column
  list) yield `null`. The `to` column is now `nullable: true`.

## Review findings

**Checked:** the implement diff read cold before the handoff summary; `_findTable` /
`resolveReferencedColumns` / `referencedSchema` semantics across the codebase; every
construction site of `ForeignKeyConstraintSchema`; the three touched `.sqllogic` files and
the two touched doc rows; whether any other doc or ticket claims the same site (none did);
lint and the full `@quereus/quereus` suite.

**Fixed in this pass (minor):**

- *Wrong default schema for the parent lookup.* The new code passed
  `fk.referencedSchema` straight through, so an absent value fell back to the
  **connection's current default schema**. Every other site in the codebase reads it as
  `fk.referencedSchema ?? childTable.schemaName` — the child's own schema. Latent today
  (both builders always populate the field) but wrong by convention and one deserialized
  schema away from real. Now `?? childTable.schemaName`.
- *Single-purpose function extraction.* The resolution block lived inline in the
  generator. Pulled out as `resolveForeignKeyParentColumnNames(db, childTable, fk)` with a
  doc comment stating the null contract; the generator body is back to yielding rows.
- *Two of the three gaps the implementer flagged, now tested.* Test 12: implicit foreign
  key wider than the parent's primary key — unmatched positions report `NULL`. Test 13:
  parent that declares no primary key. The handoff predicted `NULL` for Test 13; the
  actual behavior is that Quereus synthesizes a key for such a table, so `to` resolves to
  that column. The test pins the real behavior.
- *Doc drift found while verifying.* `docs/functions.md` said `referenced_schema` is
  "null if same schema". It isn't — both builders resolve it at CREATE TABLE time, so a
  same-schema foreign key reports its own schema name (a `41.5` test already asserted
  this). Row corrected, and the `to` row now also mentions the narrow-parent-key case.

**Filed as a ticket (major, architecture-first):**
`tickets/backlog/debt-fk-schema-carries-always-empty-referenced-columns.md`.
`ForeignKeyConstraintSchema.referencedColumns` is write-only dead state — both builders
set it to a frozen empty array and, after this fix, no production code reads it. That
field *is* the trap this bug fell into: the old code indexed `fk.referencedColumns[seq]`
because the name promised data. Filed at the representation rung (remove the field /
expose only the resolver) rather than as another point fix, citing this bug as evidence.

**Tripwires:** none. Nothing here is conditional-on-future-growth; the remaining
observations were either fixed inline or are the ticket above.

**Considered, not filed:** parent column name casing differs between the two paths —
declared names echo the declaration's casing (`references p(PID)` → `"PID"`), implicit
ones report the parent's stored casing. This matches SQLite's `pragma foreign_key_list`
and the verbatim behavior is deliberate (it keeps a dangling declared name printable), so
it is documented at the call site, not a defect.

## Validation

- `yarn workspace @quereus/quereus run lint` — exit 0 (eslint + test-file `tsc --noEmit`).
- `yarn workspace @quereus/quereus run test` — 9205 passing, 25 pending, 0 failing.
- `yarn test:store` (LevelDB leg) was not run, same as at implement time: none of the
  touched `.sqllogic` files carry a `-- requires-capability:` directive and the change is
  a read-only table-valued function, so the store leg exercises identical code.

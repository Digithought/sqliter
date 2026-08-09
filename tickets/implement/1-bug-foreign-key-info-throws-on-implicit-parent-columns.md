---
description: Asking the database to describe a table's foreign keys crashes when one of those keys was written without naming the parent columns — a perfectly legal way to declare it.
files:
  - packages/quereus/src/func/builtins/schema.ts        # foreign_key_info(), parent-column fallback at lines 341-352 — the one fix site
  - packages/quereus/src/schema/table.ts                # resolveReferencedColumns (line 1016) — the correct rule to reuse
  - docs/functions.md                                   # foreign_key_info column table, line ~546
  - packages/quereus/test/logic/06.3.2-schema-foreign-keys.sqllogic       # main introspection test
  - packages/quereus/test/logic/41.5-cross-schema-foreign-keys.sqllogic   # cross-schema introspection test
  - packages/quereus/test/logic/41.10.3-alter-drop-column-referencing-fk.sqllogic  # section that had to work around this
repro: verified
difficulty: easy
---

# `foreign_key_info()` mishandles a foreign key declared with no parent column list

## Reproduced at HEAD (`61c4317f`)

Ran in-process (Mocha + `Database` from `src/index.js`), all four cases:

| declaration | today |
|---|---|
| `x integer references p` (parent in same schema) | **throws** `Cannot read properties of undefined (reading 'name')` |
| `foreign key (x, y) references p4` (composite, implicit) | **throws**, same message |
| `p_id integer references s2.par` (implicit, parent in another schema) | returns `"to": "undefined"` — the literal 5-letter string |
| `x integer references nope` (parent table absent) | returns `"to": "undefined"` — same string |
| `x integer references p(pid)` (explicit list) | correct |

So a legal declaration is either uninspectable or silently wrong, depending only on
whether the parent happens to live in the default schema.

## Root cause — one site, three arms

A foreign key's parent columns resolve late (the parent may not exist when the child is
created), so the schema entry always stores `referencedColumns: []` and carries the
declared names in `referencedColumnNames`. Every enforcement path resolves through
`resolveReferencedColumns` (`schema/table.ts:1016`), which prefers the stored names and
falls back to the parent's `primaryKeyDefinition` when there are none.

`foreign_key_info` keeps a second, divergent copy of that rule
(`func/builtins/schema.ts:341-352`):

```ts
if (fk.referencedColumnNames && fk.referencedColumnNames[seq]) {
    toColName = fk.referencedColumnNames[seq];
} else {
    const parentTable = db._findTable(fk.referencedTable);          // arm 2: no schema arg
    if (parentTable) {
        toColName = parentTable.columns[fk.referencedColumns[seq]].name;  // arm 1: always undefined
    } else {
        toColName = String(fk.referencedColumns[seq]);              // arm 3: "undefined"
    }
}
```

- **Arm 1 — the throw.** `fk.referencedColumns` is empty for *every* key, so
  `columns[undefined]` is `undefined` and `.name` raises. This branch can only ever have
  worked against a schema shape the engine no longer produces. It must consult the
  parent's primary key, i.e. `resolveReferencedColumns`.
- **Arm 2 — the wrong schema.** `_findTable(name)` drops `fk.referencedSchema`, so a
  cross-schema parent is never found and control falls to arm 3. Enforcement gets this
  right (`planner/building/foreign-key-builder.ts:216` passes both). Note the two arms
  interact: fixing arm 2 alone would turn the cross-schema case from a wrong string into
  a throw, so both land together.
- **Arm 3 — the placeholder.** When the parent genuinely cannot be resolved there is no
  name to report, and `String(undefined)` prints `"undefined"` as if it were a column.

## Expected

`foreign_key_info('c')` returns one row per referenced column with `to` naming the
parent's primary key column(s) — matching what enforcement actually checks against:

```sql
create table p (pid integer primary key, other integer);
create table c (id integer primary key, x integer references p);
select "from", "to" from foreign_key_info('c');
-- [{"from":"x","to":"pid"}]
```

Composite implicit keys report one row per parent primary-key column, in primary-key
order. Cross-schema implicit keys resolve against `referenced_schema`. When the parent
is genuinely unresolvable, `to` is **NULL** rather than raising or printing a fake name —
which makes the `to` column nullable, a small contract change to carry through the
declared return type and the docs.

## Shape of the fix

Resolve once per foreign key, before the per-column loop, delegating to the shared rule:

- Look the parent up with **both** arguments: `db._findTable(fk.referencedTable, fk.referencedSchema)`.
- If the key declares names (`referencedColumnNames.length > 0`), keep reporting those
  names verbatim — no parent lookup needed, and a dangling declared name stays printable
  instead of raising the way `resolveReferencedColumns` would.
- Otherwise, when the parent resolved, call `resolveReferencedColumns(fk, parentTable)`
  and map the indices to `parentTable.columns[i]?.name`. With no declared names this
  call takes the primary-key path and cannot throw.
- Anything left over — parent missing, or the resolved list shorter than `fk.columns`
  (an arity-mismatched key, which enforcement skips at
  `foreign-key-builder.ts:235`) — yields `null` for that row's `to`.

Do not add a third copy of the resolution rule. If a small helper is warranted, put it
next to `resolveReferencedColumns` in `schema/table.ts` so the names-for-display variant
and the indices-for-enforcement variant sit together. (Note `schema/lens-fk-discovery.ts:50`
already has a lens-aware names variant, `resolveLogicalReferencedColumns` — do **not**
reuse it here: it resolves through lens slots and returns logical column names, which is
the wrong surface for catalog introspection.)

## Test coverage

- `06.3.2-schema-foreign-keys.sqllogic` — add: single-column implicit key resolves to the
  parent's primary-key column; composite implicit key yields one row per primary-key
  column with the right `seq` order; a key whose parent table does not exist reports
  `to` as NULL instead of raising.
- `41.5-cross-schema-foreign-keys.sqllogic` — add an implicit `references s2.par` (no
  column list) alongside the existing explicit cross-schema assertions at lines 201-238,
  and assert `to` resolves to the s2 parent's primary key.
- `41.10.3-alter-drop-column-referencing-fk.sqllogic` — its no-column-list section
  asserts enforcement (an orphan INSERT is rejected) purely because introspection threw.
  Switch it to assert `foreign_key_info` like the rest of the file.

## TODO

- Rewrite the parent-column fallback in `func/builtins/schema.ts` per *Shape of the fix*;
  resolve the parent once per FK, outside the `seq` loop.
- Mark the `to` column `nullable: true` in the `foreign_key_info` return type
  (`func/builtins/schema.ts:306`).
- Update the `to` row of the `foreign_key_info` column table in `docs/functions.md`
  (~line 556): type `TEXT?`, and say it is the parent's primary-key column when the
  declaration named no parent columns, NULL when the parent cannot be resolved.
- Add the three `06.3.2` cases, the `41.5` implicit cross-schema case, and convert the
  `41.10.3` section to introspection.
- `yarn test` from repo root; `yarn workspace @quereus/quereus run lint`.

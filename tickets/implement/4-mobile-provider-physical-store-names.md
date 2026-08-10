---
description: Two of the mobile storage plugins make up their own names for the files/tables they store data in, and one of them throws away punctuation while doing it — so two differently-named tables can end up sharing one pile of storage and mixing their rows together. Fix both to use the shared naming helper, and add one shared test that every storage plugin runs so this cannot come back.
files:
  - packages/quereus-plugin-nativescript-sqlite/src/provider.ts        # getTableName (line 57) — the lossy sanitizer; getStoreKey (65); getIndexStore (74)
  - packages/quereus-plugin-nativescript-sqlite/src/store.ts           # SQLiteStore interpolates the table name into SQL unquoted (lines 80-104) — constrains the escaping
  - packages/quereus-plugin-nativescript-sqlite/README.md              # "Each store gets its own table: quereus_main_users" (line 137), sample DDL (line 174)
  - packages/quereus-plugin-react-native-leveldb/src/provider.ts       # getDatabaseName (74), getStoreKey (81), getIndexStore (90)
  - packages/quereus-plugin-react-native-leveldb/README.md             # naming convention block
  - packages/quereus-store/src/common/key-builder.ts                   # buildDataStoreName / buildIndexStoreName — the canonical helpers; the docstring at line 61 names this defect
  - packages/quereus-store/src/common/kv-store.ts                      # KVStoreProvider — where the "derive names from the helpers" rule belongs
  - packages/quereus-store/src/testing/kv-provider-conformance.ts      # sibling shared battery; the model for the new one
  - packages/quereus-store/src/testing/index.ts                        # test-support barrel — export the new battery here
  - packages/quereus-plugin-leveldb/src/provider.ts                    # the provider that does it correctly (encodeSublevelName, line 57)
  - packages/quereus-plugin-indexeddb/src/provider.ts                  # likewise (uses the helpers verbatim)
  - packages/quereus-plugin-*/test/conformance.spec.ts                 # four spec files that will register the new battery
difficulty: medium
repro: verified
---

## What is wrong

Every table in a store-backed database keeps its rows in its own **physical store** — a
LevelDB sublevel, an IndexedDB object store, a SQLite table, an on-device LevelDB file,
depending on the storage plugin in use. The name of that store is supposed to come from one
place: `buildDataStoreName` / `buildIndexStoreName` in
`packages/quereus-store/src/common/key-builder.ts`, which produce `{schema}.{table}` and
`{schema}.{table}_idx_{index}`, lowercased.

Before creating a table or index, `StoreModule.assertStoreNameFree` checks that name is not
already taken. It compares plain strings, so it only guarantees "these two tables will not
share storage" when the plugin's translation from that name to its own native name is
**injective** — two different names can never come out the same. The LevelDB plugin is
injective (percent-escapes the bytes); IndexedDB is (uses the name verbatim). The two mobile
plugins never call the helpers at all and build their own names, and neither result is safe.

### Arm 1 — NativeScript SQLite silently merges tables

`getTableName` folds every character outside `[a-zA-Z0-9_]` to `_`. Many-to-one, so distinct
tables land on one SQLite table. **Reproduced** (a temporary spec driving the provider over
`better-sqlite3`, since removed — recreate it as the permanent test below):

```
create table "a-b" …   →  quereus_main_a_b
create table "a b" …   →  quereus_main_a_b   ← same table, rows interleave
index "x" on "t"       →  quereus_main_t_idx_x
create table "t_idx_x" →  quereus_main_t_idx_x  ← index and a sibling table's data merge
create table "café"    →  quereus_main_caf_
```

Observed directly: a value written through the `"a-b"` store was readable through the
`"a b"` store, and an index entry was readable through the sibling table's data store.
Nothing rejects the second `create` — `assertStoreNameFree` sees the *logical* names
`main.a-b` and `main.a b`, which differ, and passes. Depending on the two tables' column
sets this surfaces as corrupted-looking rows, spurious primary-key conflicts, or rows
appearing in a table they were never inserted into.

This is unrelated to the earlier unpaired-surrogate guard, which rejects a narrow class of
malformed name; this folds perfectly ordinary ones.

### Arm 2 — React Native LevelDB diverges from the canonical name

`getDatabaseName` lowercases `{prefix}.{schema}.{table}`, but `getIndexStore` appends
`_idx_{indexName}` **without** lowercasing the index name, and the in-memory cache key has
the same flaw. **Reproduced** at the provider API: `getIndexStore('main','T','IdxName')`
opens `quereus.main.t_idx_IdxName` where every other plugin would use
`main.t_idx_idxname`; and asking for the same index spelled `IDX` and `idx` opens **two**
separate on-device databases. SQL identifiers are case-insensitive, so one logical index can
map to two physical databases here.

Two further hazards at the same site, both **static** (not reproduced — `rn-leveldb` is a
native module and is not installed in this repo):

- The name reaches `new LevelDB(name, …)`, which resolves it as a path under the app's
  documents directory. A quoted table name containing `/` or `..` therefore reaches a
  filesystem path unescaped. Confirm by reading `rn-leveldb`'s native constructor before
  relying on the current behavior either way; escaping the name (below) closes it
  regardless.
- Because the name is unescaped, characters that are illegal or awkward in a filename on
  either platform (`:`, `\`, NUL, trailing space) pass straight through.

## Expected behavior

- Two tables (or indexes) the engine considers distinct must never share one physical store,
  under any storage plugin. A plugin whose native namespace genuinely cannot represent a name
  must **reject** it, never fold it onto another one.
- Every plugin derives its physical name from `buildDataStoreName` / `buildIndexStoreName`, so
  the naming rules (lowercasing, the `_idx_` separator, the identifier guards) live in one
  place. A plugin may prefix or escape that name; it must not re-derive it.
- Any escaping a plugin adds to reach a legal native name must be injective — decodable in
  principle, like the LevelDB plugin's percent-escaping — never lossy.
- The plugin's in-memory store cache is keyed by the same canonical name, so two spellings of
  one logical store cannot produce two cached handles.

## The escaping to use for NativeScript SQLite

`SQLiteStore` interpolates the table name straight into SQL **unquoted**
(`select value from ${this.tableName} where key = ?`). Percent-escaping, as the LevelDB
plugin does, would produce `%` — illegal in a bare SQLite identifier — and would force
quoting the identifier everywhere, which also opens a quoting/injection surface that does not
exist today. Instead use `_` as the escape introducer so the output stays inside
`[a-z0-9_]`, which is a legal bare identifier and carries no injection surface:

```ts
/**
 * Escape a logical store name into a legal bare SQLite identifier.
 * Bytes 0-9 and a-z pass through; every other byte becomes `_XX` (uppercase hex).
 * `_` is therefore always an escape introducer, never a literal — which is what makes
 * the mapping injective, including under SQLite's ASCII-case-insensitive identifier
 * comparison (we only ever emit uppercase hex, and a literal can never produce `_` + hex).
 */
function encodeSqliteName(name: string): string {
	let out = '';
	for (const byte of textEncoder.encode(name)) {
		const isDigit = byte >= 0x30 && byte <= 0x39;
		const isLower = byte >= 0x61 && byte <= 0x7a;
		out += (isDigit || isLower) ? String.fromCharCode(byte)
			: '_' + byte.toString(16).toUpperCase().padStart(2, '0');
	}
	return out;
}
```

**Validated** against real SQLite (better-sqlite3) over the corpus below: every name is a
legal bare identifier, distinct, distinct under ASCII case folding, and each store kept only
its own rows.

| logical name | SQLite table |
| --- | --- |
| `main.t` | `quereus_main_2Et` |
| `main.a-b` | `quereus_main_2Ea_2Db` |
| `main.a b` | `quereus_main_2Ea_20b` |
| `main.a.b` | `quereus_main_2Ea_2Eb` |
| `main.t_idx_x` | `quereus_main_2Et_5Fidx_5Fx` |
| `main.café` | `quereus_main_2Ecaf_C3_A9` |
| `main.o'brien` | `quereus_main_2Eo_27brien` |

Two consequences worth keeping in the code comments:

- The input is already lowercased by `buildDataStoreName`, so no ASCII uppercase survives to
  be escaped, and the escape hex is the only uppercase in the output.
- The reserved stores (`{prefix}__stats__`, `{prefix}__catalog__`) stay **unescaped**, and
  that is what keeps them in a disjoint namespace: an escaped name can never contain a bare
  `_` followed by a non-hex character, so no table name can spoof `__stats__`. Do not run the
  reserved names through the encoder.

For React Native LevelDB, apply the same shape: `{databaseName}.{escaped canonical name}`,
with a single unescaped `.` separating the prefix. Escaping there can be the LevelDB plugin's
percent-encoding (no SQL is involved), but must additionally exclude the path-hostile bytes
(`/`, `\`, `:`, NUL, `%` as introducer) so the name is filename-safe on both platforms; the
same disjointness argument then covers `{databaseName}.__stats__`.

## The class-level fix: a shared naming battery

The specific defect is a symptom of a class — a provider deriving its own physical names
instead of the shared ones — and a fifth plugin can reintroduce it tomorrow. There is already
a home and a precedent for catching that class: `@quereus/store/testing` exports
`runKVStoreConformance` (the store contract) and `runKVProviderConformance` (the provider's
atomic-batch contract), each supplied a small per-backend lifecycle adapter, with all the
assertions living in one file so backends cannot quietly drift.

Add a third sibling in the same style — `runStoreNameDistinctness` in a new
`packages/quereus-store/src/testing/kv-naming-conformance.ts`, exported from
`src/testing/index.ts`. It asserts the property **behaviorally**, so it needs nothing from
the provider beyond the public interface and works for every backend:

- Open one provider over a fresh empty keyspace.
- For each entry in a corpus of adversarial `(schema, table)` and `(schema, table, index)`
  triples, obtain its store and write a marker value unique to that entry under one shared
  key.
- Read the key back from every store and assert each still sees its own marker. Two entries
  sharing a physical store show up as one marker overwriting another.
- A provider is allowed to **reject** a name it cannot represent: a throw from `getStore` /
  `getIndexStore` passes that entry (record it, so the corpus does not silently shrink to
  nothing); silently sharing never passes.

Corpus (must contain only names the shared builders accept — no unpaired surrogates):
`t`, `t2`, `a-b`, `a b`, `a.b`, `a_b`, `café`, `o'brien`, `weißbier`, `T` vs `t` (must be the
*same* store — identifiers are case-insensitive), plus the index/table overlap pair
(index `x` on `t` vs. table `t_idx_x`) that `assertStoreNameFree` already guards logically.

Register it from all four plugin `test/conformance.spec.ts` files, next to the existing
`runKVStoreConformance` call, reusing each file's existing backend adapter.

## Assumption: no on-disk migration

Changing either plugin's naming renames the stores of any database those plugins already
wrote. Treat that as acceptable and do a hard cutover, on this basis: `AGENTS.md` states
"Backwards compat: don't worry yet", and the LevelDB plugin already took exactly this route
for its own layout change — `packages/quereus-plugin-leveldb/README.md` line 36 reads "Hard
cutover (no on-disk migration) … pre-1.0 dev data is expected to be thrown away; there is no
migration importer." Neither mobile plugin has a consumer in this repo. Add the equivalent
note to both mobile READMEs rather than writing a migration. If a maintainer says these
plugins do have shipped users, the fallback is to read the old name when the new one is
absent — but do not build that speculatively.

## Not in scope

- `deleteTableStores` on these same two plugins closes handles without erasing anything —
  a separate root cause at a separate site, already filed as
  `bug-mobile-providers-delete-table-stores-only-closes` in `backlog/`. It interacts with
  this work only in that renaming the stores leaves the old ones behind, which was already
  true. Do not fix it here.
- Changing `KVStoreProvider` so its methods take an already-built store name instead of
  `(schemaName, tableName)` would make the whole defect class unrepresentable rather than
  merely tested for. Deliberately not done: it touches five packages and every call site in
  `StoreModule`, and the shared battery covers the same class at a fraction of the cost.
  Leave a `NOTE:` tripwire on the `KVStoreProvider` interface in
  `packages/quereus-store/src/common/kv-store.ts` recording that the interface hands
  providers the raw identifiers and trusts them to call the shared builders, and that if a
  provider is ever again found re-deriving names — or a sixth provider lands — the interface
  should hand over the built name instead.

## TODO

Phase 1 — shared battery first, so both fixes are validated against it

- Write `packages/quereus-store/src/testing/kv-naming-conformance.ts` exporting
  `runStoreNameDistinctness(name, makeBackend)`, modelled on `kv-provider-conformance.ts`
  (module-local Mocha globals, per-test backend lifecycle, all assertions in this file).
- Export it from `packages/quereus-store/src/testing/index.ts` and mention it in that file's
  header list alongside the two existing batteries.
- Register it in `packages/quereus-plugin-leveldb/test/conformance.spec.ts` and
  `packages/quereus-plugin-indexeddb/test/conformance.spec.ts` and confirm both pass
  unchanged — they are the reference implementations, so a failure there means the battery
  is wrong, not the plugin.

Phase 2 — NativeScript SQLite

- Replace `getTableName` with `${tablePrefix}${encodeSqliteName(buildDataStoreName(...))}`,
  and give `getIndexStore` the same treatment over `buildIndexStoreName` — delete the
  second `replace(/[^a-zA-Z0-9_]/g, '_')` on line 76 entirely.
- Key the `stores` map by the canonical store name (as `LevelDBProvider` does), not by the
  separate half-lowercased `getStoreKey`; update `closeStore` / `closeIndexStore` /
  `deleteIndexStore` / `deleteTableStores` to match.
- Leave `{prefix}__stats__` / `{prefix}__catalog__` unescaped; comment why that is what keeps
  them un-spoofable.
- Update the storage-naming block in the file header and the two README sites that show
  `quereus_main_users`.
- Register `runStoreNameDistinctness` in this package's `test/conformance.spec.ts`.

Phase 3 — React Native LevelDB

- Derive both names from `buildDataStoreName` / `buildIndexStoreName`, escape the result to a
  filename-safe injective form, and prefix with `{databaseName}.`.
- Key the `stores` map by the canonical name, same as phase 2.
- Update the file-header naming block and the README.
- Register `runStoreNameDistinctness` in this package's `test/conformance.spec.ts`.

Phase 4 — tighten the shared docs and verify

- Update the `buildDataStoreName` docstring in `key-builder.ts` (lines 61-68): it currently
  documents the NativeScript SQLite folding as a live exception to the
  `assertStoreNameFree` guarantee and points at the backlog slug. Once fixed, state that
  every shipped provider's encoding is injective and name the battery that keeps it so.
- Add the `NOTE:` tripwire on `KVStoreProvider` described under *Not in scope*.
- Run `yarn build`, then the four plugin test suites, then `yarn test` and `yarn lint`.

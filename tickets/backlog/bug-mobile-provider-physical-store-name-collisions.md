---
description: Two of the mobile storage plugins invent their own physical storage names instead of using the shared naming helper, and one of them deletes punctuation from the name — so two differently-named tables can silently end up sharing one physical store and mixing their rows.
files:
  - packages/quereus-plugin-nativescript-sqlite/src/provider.ts        # getTableName (~line 57) — the lossy sanitizer
  - packages/quereus-plugin-react-native-leveldb/src/provider.ts       # getDatabaseName / getIndexStore (~lines 74-94)
  - packages/quereus-store/src/common/key-builder.ts                   # buildDataStoreName / buildIndexStoreName — the canonical helpers
  - packages/quereus-store/src/common/store-module.ts                  # assertStoreNameFree / collectOccupiedStoreNames (~lines 524-580)
  - packages/quereus-plugin-leveldb/src/provider.ts                    # the provider that does it correctly, for reference
difficulty: medium
---

## Background

Every table in a store-backed database is kept in its own **physical store** — a LevelDB
sublevel, an IndexedDB object store, a SQLite table, depending on which storage plugin is in
use. The logical name of that store is built in one place, `buildDataStoreName` /
`buildIndexStoreName` in `packages/quereus-store/src/common/key-builder.ts`, which produce
`{schema}.{table}` and `{schema}.{table}_idx_{index}`.

Before creating a table or index, `StoreModule.assertStoreNameFree` checks that the name it
is about to use is not already taken. That check compares the names as plain strings. It is
therefore only a real guarantee of "these two tables will not share storage" when the
storage plugin's own translation from that name to its native name is **injective** — that
is, when two different names can never come out the same.

The LevelDB plugin satisfies that: it percent-escapes the name's bytes, so distinct names
stay distinct. The IndexedDB plugin satisfies it: it uses the name verbatim. Two mobile
plugins do not go through the shared helpers at all, and build their own names instead.

## Problem 1 — NativeScript SQLite silently merges tables (the serious one)

`packages/quereus-plugin-nativescript-sqlite/src/provider.ts`:

```ts
private getTableName(schemaName: string, tableName: string): string {
    const sanitized = `${schemaName}_${tableName}`.replace(/[^a-zA-Z0-9_]/g, '_');
    return `${this.tablePrefix}${sanitized}`;
}
```

Every character that is not a letter, digit, or underscore becomes `_`. That is a
many-to-one mapping, so distinct tables collapse onto one SQLite table:

| SQL | native SQLite table |
| --- | --- |
| `create table "a-b" (...) using store` | `quereus_main_a_b` |
| `create table "a b" (...) using store` | `quereus_main_a_b` |
| `create table "a.b" (...) using store` | `quereus_main_a_b` |
| `create table "café" (...) using store` | `quereus_main_caf_` |

All of these are legal quoted identifiers in Quereus. Nothing rejects the second `create`:
`assertStoreNameFree` sees the *logical* names `main.a-b` and `main.a b`, which are
different, and passes. The two tables then read and write the same rows. Depending on their
column sets this shows up as corrupted-looking data, spurious primary-key conflicts, or rows
appearing in a table they were never inserted into.

The `_idx_` separator makes it worse in the same way the shared builders already document:
because `_` is also what punctuation folds *to*, an index and a sibling table can land on
the same native name from more directions than they can under LevelDB.

Note this has nothing to do with the earlier unpaired-surrogate work — that guard rejects a
narrow class of malformed name, whereas this folds perfectly ordinary names. It was noticed
while reviewing `bug-store-physical-store-name-lone-surrogate-collision`.

## Problem 2 — React Native LevelDB is inconsistent about index-name case

`packages/quereus-plugin-react-native-leveldb/src/provider.ts` builds
`{prefix}.{schema}.{table}` lowercased for a data store, but for an index store it appends
`_idx_{indexName}` **without** lowercasing the index name:

```ts
const dbName = `${this.getDatabaseName(schemaName, tableName)}${STORE_SUFFIX.INDEX}${indexName}`;
```

The shared builder lowercases the whole thing. SQL identifiers are case-insensitive, so an
index the engine considers to be one object can map to two different on-device databases
here depending on how its name was spelled, and the mapping disagrees with every other
plugin. No known reproduction — this package has no test harness — but it is a divergence
from the canonical naming that will not stay harmless.

## Expected behavior

- Two tables (or indexes) that the engine considers distinct must never share one physical
  store, under any storage plugin. If a plugin's native namespace genuinely cannot represent
  a name, it must **reject** the name rather than fold it onto another one.
- All plugins should derive their physical name from the shared `buildDataStoreName` /
  `buildIndexStoreName` helpers, so the naming rules (lowercasing, the `_idx_` separator, the
  identifier guards) live in one place and every plugin inherits them. A plugin may prefix or
  escape that name; it should not re-derive it.
- Whatever escaping NativeScript SQLite adopts to reach a legal SQLite identifier must be
  reversible-in-principle (e.g. percent-encoding, as the LevelDB plugin does) rather than
  lossy.

## Decision needed before implementing

Changing either plugin's naming **renames existing on-device stores**, so any database
already written by these plugins becomes unreadable unless a migration is provided. Someone
needs to decide whether these plugins have shipped users:

- If not: change the naming outright, no migration.
- If so: either add a one-time rename migration, or keep the current name as a fallback that
  is read when the new name is absent.

## Suggested coverage

Both defects are reachable purely at the name-construction level, so they can be unit-tested
without a device or emulator — construct the provider with a stub database/open function and
assert that two distinct logical names never produce the same native name. Neither package
has a test directory today; adding one for the naming logic alone is cheap.

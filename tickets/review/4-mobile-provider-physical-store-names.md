---
description: The two mobile storage plugins used to invent their own names for the files/tables they keep data in, and one of them threw away punctuation while doing it, so two differently-named tables could quietly share one pile of storage. Both now derive names from the shared helper and escape them reversibly, and a new shared test makes every storage plugin prove it.
files:
  - packages/quereus-store/src/testing/kv-naming-conformance.ts     # NEW — the shared battery + its standalone core assertion
  - packages/quereus-store/src/testing/index.ts                     # exports runStoreNameDistinctness / assertStoreNamesDistinct
  - packages/quereus-store/test/store-name-distinctness.spec.ts     # NEW — negative control: the battery driven against broken doubles
  - packages/quereus-store/src/common/key-builder.ts                # buildDataStoreName docstring rewritten; new NOTE on buildIndexStoreName
  - packages/quereus-store/src/common/kv-store.ts                   # KVStoreProvider contract + the deferred-redesign NOTE
  - packages/quereus-plugin-nativescript-sqlite/src/provider.ts     # encodeSqliteName; names from the shared builders; cache re-keyed
  - packages/quereus-plugin-nativescript-sqlite/README.md           # new "Table naming" section + hard-cutover note
  - packages/quereus-plugin-react-native-leveldb/src/provider.ts    # encodeDatabaseName; names from the shared builders; cache re-keyed
  - packages/quereus-plugin-react-native-leveldb/README.md          # new "Database naming" section + hard-cutover note
  - packages/quereus-plugin-leveldb/test/conformance.spec.ts        # registers the battery (reference impl)
  - packages/quereus-plugin-indexeddb/test/conformance.spec.ts      # registers the battery (reference impl)
  - packages/quereus-plugin-nativescript-sqlite/test/conformance.spec.ts   # registers the battery
  - packages/quereus-plugin-react-native-leveldb/test/conformance.spec.ts  # registers the battery
difficulty: medium
---

## What shipped

Every table in a store-backed database keeps its rows in its own **physical store** — a
LevelDB sublevel, an IndexedDB object store, a SQLite table, an on-device LevelDB file,
depending on the storage plugin. The name of that store must come from one place:
`buildDataStoreName` / `buildIndexStoreName` in `packages/quereus-store/src/common/key-builder.ts`.
The two mobile plugins were not calling them and were composing their own names instead;
both now do, and each escapes the result into its own native namespace with a mapping that
is reversible in principle (so two different names can never come out the same).

**NativeScript SQLite.** `getTableName` folded every character outside `[a-zA-Z0-9_]` to
`_`, which is many-to-one — tables `a-b` and `a b` both landed on `quereus_main_a_b` and
interleaved their rows. Replaced with `encodeSqliteName`: digits and `a`-`z` pass through,
every other UTF-8 byte becomes `_XX` (uppercase hex), so `_` is always an escape introducer
and never a literal. Output stays inside `[a-z0-9_]` — a legal bare SQLite identifier,
which matters because `SQLiteStore` interpolates the table name into its SQL unquoted, so
percent-escaping (what the LevelDB plugin uses) was not an option.

**React Native LevelDB.** `getIndexStore` appended `_idx_{indexName}` without lowercasing,
so one logical index could occupy two on-device databases depending on how the SQL spelled
it; the name also reached rn-leveldb's path resolution unescaped. Both names now come from
the builders and go through `encodeDatabaseName` — percent-escaping restricted to a
filename-safe set (excludes `/ \ : * ? " < > |`, `%`, and every control/space/non-ASCII
byte), so the whole name is always a single path component.

Both providers now key their in-memory store cache by the **canonical** store name, so two
spellings of one logical store cannot produce two cached handles.

**The class-level fix.** `@quereus/store/testing` gained a third battery,
`runStoreNameDistinctness`, alongside `runKVStoreConformance` and
`runKVProviderConformance`. All four plugin `test/conformance.spec.ts` files register it.
It asserts behaviorally, through the public `KVStoreProvider` surface only: open a corpus of
adversarial `(schema, table)` and `(schema, table, index)` stores, write a distinct marker
into each under one shared key, and check each still reads back its own. A provider may
*reject* a name it cannot represent (recorded and logged, never silent); folding two names
onto one store never passes.

## Hard cutover — no on-disk migration

Both plugins' physical names changed, so any database either plugin already wrote is
unreadable by this version. Taken deliberately, on the basis stated in the plan ticket:
`AGENTS.md` says backwards compatibility is not a concern yet, the LevelDB plugin already
took the same route for its own layout change, and neither mobile plugin has a consumer in
this repo. Both READMEs now carry the equivalent note.

## Where this deviated from the plan ticket

**The plan's corpus contained a pair no provider can satisfy.** It asked the battery to
assert that a table literally named `t_idx_x` and index `x` on table `t` land on different
physical stores. They do not — and cannot: `buildDataStoreName('main','t_idx_x')` and
`buildIndexStoreName('main','t','x')` both return the string `main.t_idx_x`, so the two are
already one logical name before any provider sees them. This surfaced as a **failing run of
the new battery against LevelDB**, which is exactly what registering it against the
reference implementations first was for.

`StoreModuleBase.assertStoreNameFree` is what actually handles this pair: it rejects
whichever of the two is created second. So the pair is guarded above the provider, in the
same bucket as the already-documented dotted-name pair (schema `x` + table `y.z` vs schema
`x.y` + table `z`). Both are now excluded from the corpus with the reason written down, and
`buildIndexStoreName` gained a `NOTE:` recording that its `_idx_` join is not boundary-safe
and that `assertStoreNameFree` is the guard. Two index entries (`x` on `t`, `x` on `t2`)
replaced the dropped pair, so index naming is still exercised.

**Added beyond the plan:** a negative control,
`packages/quereus-store/test/store-name-distinctness.spec.ts`. The battery's core assertion
is exported standalone as `assertStoreNamesDistinct` (mirroring `assertBoundedIterate`, and
for the same stated reason — a guard nobody has watched fail is not a guard), and the spec
drives it against provider doubles: verbatim naming and injective escaping must pass;
punctuation-folding, truncation, and refusing a `[a-z0-9_.]` name must fail; refusing a
non-ASCII name must pass *and* report what it refused.

## Use cases for testing and validation

Run these first — all four register the new battery:

```
yarn workspace @quereus/plugin-leveldb run test              # 76 passing
yarn workspace @quereus/plugin-indexeddb run test            # 140 passing
yarn workspace @quereus/plugin-nativescript-sqlite run test  #  66 passing
yarn workspace @quereus/plugin-react-native-leveldb run test #  77 passing
yarn workspace @quereus/store run test                       # 1593 passing (incl. the negative control)
```

Then `yarn build`, `yarn typecheck`, `yarn test`, `yarn lint` — all four were run green at
handoff (full `yarn test`: 13 suites, no failures).

Things worth exercising by hand or by reading:

- **The escape tables in both READMEs are checkable.** The NativeScript one was verified
  against real SQLite (better-sqlite3) by creating every store and reading `sqlite_master`:
  the produced names are `quereus_main_2Et`, `quereus_main_2Ea_2Db`, `quereus_main_2Ea_20b`,
  `quereus_main_2Ea_2Eb`, `quereus_main_2Ecaf_C3_A9`, `quereus_main_2Eo_27brien`,
  `quereus_main_2Et_5Fidx_5Fx`, plus the unescaped `quereus___stats__` /
  `quereus___catalog__` — all distinct, and still distinct after ASCII case folding (which
  is how SQLite compares identifiers). The React Native table was derived, not run against
  the real native module.
- **Reserved-store disjointness** is asserted by the battery's third test: a user table
  named `__stats__` or `__catalog__` must not land on the reserved store of that name.
- **The disjointness *arguments* deserve a read**, since they are what the reserved-store
  test would not catch if the escape changed. NativeScript: an escaped name can never
  contain a bare `_` followed by a non-hex character, so no table name can produce
  `__stats__`. React Native: every canonical store name contains a `.` (it is built as
  `{schema}.{table}`) and neither reserved name does.

## Known gaps — please treat as the starting point

- **React Native LevelDB is not tested against the real native module.** `rn-leveldb` cannot
  load under Node and is not installed here, so everything runs against `MockLevelDB`. Two
  consequences: the path-traversal hazard the plan flagged is closed by *construction* (the
  escape removes `/` and `\`, so the name is always one path component) but was never
  observed on device; and the claim that the escaped names are legal on-device database
  names is reasoning, not measurement. The plan ticket suggested reading rn-leveldb's native
  constructor to confirm the old behavior — that was not done, and the fix does not depend
  on the answer.
- **The battery's corpus is a judgement call, not a proof.** It breaks the specific foldings
  that seemed plausible (punctuation, case, non-ASCII, quote characters). An encoding that
  is lossy in some way none of those probe would still pass. The negative control covers two
  distinct failure shapes (folding and truncation) partly to keep the battery from being
  tuned to one.
- **The battery does not assert anything about a provider's cache.** Re-keying both mobile
  caches to the canonical name is covered only indirectly: the case-insensitivity test would
  catch a cache that produced two handles for one logical store, but nothing pins the cache
  behavior of `closeStore` / `deleteIndexStore` / `deleteTableStores` on either mobile
  plugin. Those methods were mechanically updated to the new keying and are exercised by no
  test in either package.
- **The IndexedDB registration opens ~12 object stores per test**, each via a version
  upgrade under `fake-indexeddb`. It passes and is not visibly slow, but it is the heaviest
  thing in that spec file.
- **`deleteTableStores` on both mobile plugins still closes handles without erasing
  anything.** Untouched here by design — separate root cause, already filed as
  `bug-mobile-providers-delete-table-stores-only-closes` in `backlog/`. Renaming the stores
  leaves the old ones behind, which was already true of that defect.

## Deliberately not done

Changing `KVStoreProvider` so its methods take an already-built store name instead of
`(schemaName, tableName)` would make this defect class unrepresentable rather than merely
tested for. It touches five packages and every `StoreModule` call site, so the shared
battery was judged the better trade. A `NOTE:` on the interface in
`packages/quereus-store/src/common/kv-store.ts` records the decision and its revisit
condition (a provider found re-deriving names again, or a sixth provider landing).

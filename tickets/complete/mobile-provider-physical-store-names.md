description: The two mobile storage plugins used to invent their own names for the files/tables they keep data in, and one of them threw away punctuation while doing it, so two differently-named tables could quietly share one pile of storage. Both now derive names from the shared helper and escape them reversibly, and a new shared test makes every storage plugin prove it.
files:
  - packages/quereus-store/src/testing/kv-naming-conformance.ts     # the shared battery + its standalone core assertion
  - packages/quereus-store/src/testing/index.ts                     # exports runStoreNameDistinctness / assertStoreNamesDistinct
  - packages/quereus-store/test/store-name-distinctness.spec.ts     # negative control: the battery driven against broken doubles
  - packages/quereus-store/src/common/key-builder.ts                # buildDataStoreName docstring; NOTE on buildIndexStoreName
  - packages/quereus-store/src/common/kv-store.ts                   # KVStoreProvider contract + the deferred-redesign NOTE
  - packages/quereus-store/README.md                                # documents all three shared batteries
  - packages/quereus-plugin-nativescript-sqlite/src/provider.ts     # encodeSqliteName; names from the shared builders; cache re-keyed
  - packages/quereus-plugin-nativescript-sqlite/README.md           # "Table naming" section + hard-cutover note
  - packages/quereus-plugin-react-native-leveldb/src/provider.ts    # encodeDatabaseName; names from the shared builders; cache re-keyed
  - packages/quereus-plugin-react-native-leveldb/README.md          # "Database naming" section + hard-cutover note
  - packages/quereus-plugin-leveldb/test/conformance.spec.ts        # registers the battery (reference impl)
  - packages/quereus-plugin-indexeddb/test/conformance.spec.ts      # registers the battery (reference impl)
  - packages/quereus-plugin-nativescript-sqlite/test/conformance.spec.ts   # registers the battery
  - packages/quereus-plugin-react-native-leveldb/test/conformance.spec.ts  # registers the battery
  - docs/store.md                                                   # provider-encoding contract in § Store Naming Convention
---

## What shipped

Every table in a store-backed database keeps its rows in its own **physical store** — a
LevelDB sublevel, an IndexedDB object store, a SQLite table, an on-device LevelDB file,
depending on the storage plugin. The name of that store now comes from one place for every
provider: `buildDataStoreName` / `buildIndexStoreName` in
`packages/quereus-store/src/common/key-builder.ts`. The two mobile plugins were composing
their own names instead; both now call the builders and escape the result into their own
native namespace with a mapping that is reversible in principle, so two different logical
names can never come out the same.

**NativeScript SQLite.** `getTableName` folded every character outside `[a-zA-Z0-9_]` to
`_`, which is many-to-one — tables `a-b` and `a b` both landed on `quereus_main_a_b` and
interleaved their rows. Replaced with `encodeSqliteName`: digits and `a`-`z` pass through,
every other UTF-8 byte becomes `_XX` (uppercase hex), so `_` is always an escape introducer
and never a literal. Output stays inside `[a-z0-9_]` — a legal bare SQLite identifier, which
matters because `SQLiteStore` interpolates the table name into its SQL unquoted.

**React Native LevelDB.** `getIndexStore` appended `_idx_{indexName}` without lowercasing, so
one logical index could occupy two on-device databases depending on how the SQL spelled it;
the name also reached rn-leveldb's path resolution unescaped. Both names now come from the
builders and go through `encodeDatabaseName` — percent-escaping restricted to a
filename-safe set — so the whole name is always a single path component.

Both providers key their in-memory store cache by the **canonical** store name.

**The class-level fix.** `@quereus/store/testing` gained a third battery,
`runStoreNameDistinctness`, alongside `runKVStoreConformance` and
`runKVProviderConformance`; all four plugin `test/conformance.spec.ts` files register it. It
asserts behaviorally, through the public `KVStoreProvider` surface only: open a corpus of
adversarial `(schema, table)` and `(schema, table, index)` stores, write a distinct marker
into each under one shared key, and check each still reads back its own. A provider may
*reject* a name it cannot represent (recorded and logged, never silent); folding two names
onto one store never passes. `assertStoreNamesDistinct` is exported standalone and
`packages/quereus-store/test/store-name-distinctness.spec.ts` drives it against provider
doubles that fold, truncate, and over-reject, so the guard has been watched failing.

**Hard cutover.** Both plugins' physical names changed, so any database either plugin already
wrote is unreadable by this version. Deliberate: `AGENTS.md` says backwards compatibility is
not a concern yet, the LevelDB plugin already took the same route for its own layout change,
and neither mobile plugin has a consumer in this repo. Both READMEs carry the note.

## Review findings

### Verified

- **The injectivity claims hold.** Re-derived `encodeSqliteName`'s case-insensitive
  injectivity by hand (`_` is never a literal, so the output parses left-to-right
  unambiguously; literals are digits and `a`-`z`, escape hex is the only uppercase, and
  lowercasing the hex still decodes to the same byte). Both READMEs' escape tables were
  reproduced from a standalone script and match exactly, including the React Native one the
  handoff flagged as derived rather than run.
- **Both reserved-store disjointness arguments hold.** NativeScript: an encoded name can never
  contain a bare `_` followed by a non-hex character, so no table can produce `__stats__` or
  `__catalog__`. React Native: every canonical store name contains a `.` and neither reserved
  name does — and that survives any `databaseName` prefix the caller chooses.
- **The excluded corpus pair really is guarded above the provider.**
  `packages/quereus-store/test/store-name-collision.spec.ts` covers exactly the case the
  battery drops (a table named `t_idx_x` versus index `x` on table `t`), rejecting whichever
  is created second. The exclusion and the new `buildIndexStoreName` NOTE are accurate.
- **Coverage is complete.** Four `KVStoreProvider` implementations exist in the repo and all
  four register the battery; there is no shipped in-memory provider left uncovered. The
  battery and the negative control were confirmed executing (not silently skipped) by running
  them under `--grep`.
- **The new `KVStoreProvider` doc contract does not contradict the existing providers.**
  LevelDB and IndexedDB already build names with the shared builders and cache by the
  canonical name.
- **Both original defects would be caught.** The old NativeScript folding collapses the
  corpus's `a-b` / `a b` pair; the old React Native index-case bug fails the
  case-insensitivity test.
- **Gates:** `yarn build`, `yarn typecheck`, `yarn test` (13 suites, no failures),
  `yarn lint`, and each of the five affected packages individually — all green before and
  after the changes below.

### Fixed in this pass (minor)

- `docs/store.md` still stated that the NativeScript SQLite provider's `getTableName` folds
  every character outside `[a-zA-Z0-9_]`, and pointed readers at the backlog ticket this work
  resolved. Rewritten to point at the naming section instead.
- `docs/store.md` § Store Naming Convention documented only the *logical* names and had
  nothing about what a provider must do with them. Added the injective-encoding contract and
  a pointer to the battery that enforces it — the change should have landed here.
- `packages/quereus-store/README.md` documents the shared conformance batteries for a new
  backend author and listed only two of the three. Added `runStoreNameDistinctness` with its
  adapter shape and a pointer to the negative control.
- The battery's reserved-store test wrote a marker into a user table named `__catalog__` and
  one named `__stats__` but never read either back — it only checked the two *reserved*
  markers survived. A provider that folded those two user tables onto each other would have
  passed. Added the read-back.

### Parked as tripwires, not tickets

- **The battery reads markers back through the same handles it wrote through.** A provider
  that caches one read-your-own-writes handle per logical name *and* folds two names onto one
  physical store *below* that cache would serve each marker from its own cache and pass. No
  shipped provider does both — the only caching provider (IndexedDB, via `CachedKVStore`)
  names its object stores verbatim, so any folding would happen at the cache key and be
  caught. `NOTE:` in the header of `kv-naming-conformance.ts`, with the fix to apply if that
  ever changes (re-read through handles reopened after `closeStore`).
- **The React Native escape narrows the maximum usable table name on device.** Percent-escaping
  is a 3x expansion per unsafe byte and the result is a single path component, which most
  filesystems cap at 255 bytes. Measured: a 90-character Cyrillic table name is 193 bytes as
  the raw UTF-8 name the old code handed to rn-leveldb, but 553 bytes escaped — so names of
  roughly 80+ non-ASCII characters that used to open will now fail on device. Not reproducible
  off-device. `NOTE:` at `encodeDatabaseName`, including the fix that keeps the escape
  injective (hash the tail rather than widen the safe set).

### Filed

- `debt-store-docs-indexeddb-section-stale` (backlog) — `docs/store.md`'s "IndexedDB Backend"
  and "IndexedDB Architecture Gap" sections still describe the pre-consolidation
  database-per-table design as current and propose the single-database consolidation as future
  work, though it shipped along with `beginAtomicBatch`. Pre-existing rot, found while
  verifying this change's doc surface, unrelated to naming.
- `debt-store-and-module-authoring-docs-at-word-cap` (backlog) — `yarn docs:check` is red at
  `main`: `docs/module-authoring.md` is 12001 words against a hard 12000-word cap with no
  grace band. `docs/store.md` was 11897 words before this pass and is 11985 after, so it now
  fails on the next paragraph anyone adds. The paragraph added above had to be rewritten three
  times to fit.

### Considered and not filed

- **Mobile cache re-keying is exercised by no test** (the handoff flagged this). Not filed:
  the risk it describes has been retired structurally rather than left untested.
  `closeStore` / `closeIndexStore` / `deleteIndexStore` / `deleteTableStores` now call the
  *same* builder expression as `getStore` / `getIndexStore`, so a key mismatch is
  unrepresentable. The original bug existed precisely because there were two independent
  derivations of the name.
- **`deleteTableStores` on both mobile plugins closes handles without erasing anything** —
  already `bug-mobile-providers-delete-table-stores-only-closes` in backlog; renaming the
  stores does not change it.
- **`tablePrefix: ''` plus a schema whose name starts with a digit** produces an illegal bare
  SQLite identifier. Not a regression (the previous scheme had the same shape), and reachable
  only by deliberately clearing a prefix that exists to prevent collisions.
- **React Native LevelDB is still untested against the real native module** — `rn-leveldb`
  cannot load under Node, so everything runs against `MockLevelDB`. Genuine and unresolvable
  in this environment; the path-traversal hazard is closed by construction (the escape removes
  `/` and `\`) but has not been observed on device.
- **The battery's corpus is a judgement call, not a proof.** It breaks the foldings that seemed
  plausible (punctuation, case, non-ASCII, quote characters); an encoding lossy in some other
  way would still pass. Accepted — the negative control covers two distinct failure shapes
  partly to keep the battery from being tuned to one.

### Deliberately not done (carried from the implementation)

Changing `KVStoreProvider` so its methods take an already-built store name instead of
`(schemaName, tableName)` would make this defect class unrepresentable rather than merely
tested for. It touches five packages and every `StoreModule` call site, so the shared battery
was judged the better trade. The `NOTE:` on the interface in
`packages/quereus-store/src/common/kv-store.ts` records the decision and its revisit condition
(a provider found re-deriving names again, or a sixth provider landing). Reviewed and left
standing.

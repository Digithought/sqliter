----
description: Two tables whose names differ only by a broken half-character (a lone surrogate) can still end up sharing the same on-disk storage location on a real storage backend such as LevelDB, because the physical store-name builder was not hardened the way the catalog keys just were — so one table's data could silently overwrite the other's.
files:
  - packages/quereus-store/src/common/key-builder.ts     # buildDataStoreName / buildIndexStoreName (unguarded) vs buildCatalogKey (now guarded)
  - packages/quereus-store/src/common/store-module.ts     # create() → assertStoreNameFree + provider.getStore (eager physical-store open at CREATE TABLE)
  - packages/quereus-plugin-leveldb/src/provider.ts       # turns the store-name string into sublevel/key bytes (the suspected folding point)
  - packages/quereus-plugin-indexeddb/src/provider.ts     # uses the store name as an IndexedDB object-store name (likely surrogate-preserving; verify)
difficulty: medium
----

## What's wrong

A recent fix (`bug-store-catalog-key-lone-surrogate-identifier-collision`) hardened the **catalog
keys** — `buildCatalogKey` / `buildViewCatalogKey` / `buildMaterializedViewCatalogKey` /
`buildStatsKey` now reject an identifier carrying a lone (unpaired) surrogate rather than folding it
to the Unicode replacement character and colliding.

But the **physical store-name** builders — `buildDataStoreName` (`{schema}.{table}`) and
`buildIndexStoreName` (`{schema}.{table}_idx_{index}`) — were deliberately left out of that fix's
scope and remain unguarded. These strings become the actual on-disk / in-backend storage location:
a LevelDB sublevel name, an IndexedDB object-store name, etc.

The builders return a plain JavaScript string with the lone surrogate intact (they only interpolate
and lowercase — no byte encoding). Two tables named, say, `"\uD800"` and `"\uD801"` therefore produce
two *distinct* JS strings, and `assertStoreNameFree` (which compares JS strings) sees no conflict and
lets both `CREATE TABLE`s through. But when a **real** provider encodes that string to bytes for a
directory / key prefix, every lone surrogate folds to the same replacement bytes — so both tables can
land on **one** physical store. The second table's data then intermixes with or overwrites the
first's, even though their *catalog* keys are now safely distinct.

The collision point is at `CREATE TABLE` time, not lazily: `StoreModule.create()` eagerly calls
`provider.getStore(...)` (which uses `buildDataStoreName`) to open/create the backing store *before*
any catalog write, so the physical store is created under the folded name before the catalog-key
guard ever runs.

## Why it matters / what's uncertain

The in-memory and test providers key stores by JS `Map` string equality, which distinguishes lone
surrogates fine — so this is invisible in the default test suite. The risk is specific to **real**
providers, and whether it actually manifests depends on each provider's own name encoding:

- **LevelDB** — store names likely become byte-encoded sublevel prefixes → folding is **plausible**;
  this is the primary suspect.
- **IndexedDB** — object-store names are DOMStrings compared by code unit, which per spec should
  preserve lone surrogates → probably **safe**, but confirm.

This was **not verified against a live LevelDB/IndexedDB** during the parent ticket's review — hence a
bug ticket rather than a confirmed defect. First step is to reproduce: create two tables differing
only by a lone surrogate against the LevelDB plugin and check whether they share a physical store.

## What good looks like

If reproduced: guard `buildDataStoreName` / `buildIndexStoreName` the same way the catalog keys are
guarded (reject an unfaithful identifier), **or** choose a boundary-safe physical-name encoding that
keeps lone-surrogate-differing names distinct at the storage layer. Either way `assertStoreNameFree`
should not be relied on to catch this, since it compares pre-encoding JS strings.

If *not* reproduced (all real providers preserve lone surrogates): downgrade to a `NOTE:` tripwire at
the `buildDataStoreName` site recording that physical-name faithfulness rides on the provider's
encoding, and close.

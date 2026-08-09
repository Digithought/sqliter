description: Asking a storage backend "how many records are in this range?" can give different answers depending on which backend you ask, because they disagree about whether a "give me at most N" hint should cap the count. No caller uses that hint today, so nothing is broken yet.
files:
  - packages/quereus-store/src/common/kv-store.ts               # approximateCount + IterateOptions declarations
  - packages/quereus-store/src/common/memory-store.ts           # counts by iterating — caps at limit
  - packages/quereus-plugin-leveldb/src/store.ts                # counts by iterating — caps at limit
  - packages/quereus-plugin-react-native-leveldb/src/store.ts   # counts by iterating — caps at limit
  - packages/quereus-plugin-indexeddb/src/store.ts              # IDBObjectStore.count(range) — ignores limit
  - packages/quereus-plugin-nativescript-sqlite/src/store.ts    # count(*) — ignores limit; carries a NOTE at the site
  - packages/quereus-store/src/testing/kv-conformance.ts        # battery never passes limit to approximateCount
difficulty: easy
tradeoffs: Nothing in the engine passes the limit hint to a count today, so this is interface hygiene rather than a live bug — a maintainer could reasonably leave it until someone actually needs the combination.
----

# `approximateCount` accepts an option it cannot honor consistently

## What the interface says

`KVStore.approximateCount(options?: IterateOptions)` returns "approximate number of keys
in a range", used for query planning cost estimation. It takes the *same* options object
as `iterate`, and that object carries a `limit` field — "return at most this many
entries". Counting a range and reading a range are different questions, so what `limit`
should mean here was never decided.

## The divergence

Five backends implement the interface and they split two ways:

| backend | how it counts | effect of `limit` |
|---|---|---|
| in-memory, LevelDB, React Native LevelDB | drives its own `iterate` and counts what comes back | count is capped at `limit` |
| IndexedDB, NativeScript SQLite | one native count over the range | `limit` ignored |

So `approximateCount({ gte: k, limit: 10 })` over a 1000-key range returns `10` on three
backends and `1000` on two. The backends are meant to be interchangeable.

The NativeScript SQLite site carries a `NOTE:` recording this and deferring it; the
conformance battery never passes `limit` to `approximateCount`, so nothing catches it.
No production caller passes it either — the divergence is dormant, but it is definitely
wrong the moment one does.

## What "done" looks like

Prefer making the bad state unrepresentable over documenting it: `approximateCount`
should take only the range bounds (and, if a backend needs it, direction), not the full
`IterateOptions` — a caller then cannot pass `limit` at all, and the question of what it
would mean disappears. Extracting the bound fields into their own type that
`IterateOptions` extends would let both signatures stay honest.

If instead the decision is to keep one options type, then the contract must say which
reading wins, every backend must implement that reading, and the shared conformance
battery must have a case that fails a backend which does not — a documented rule with no
test behind it is how the current split survived.

Either way the accepted-tradeoff `NOTE:` in the NativeScript SQLite store should be
retired or rewritten to point at the settled answer.

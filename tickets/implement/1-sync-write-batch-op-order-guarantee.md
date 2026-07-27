----
description: The storage layer never says what happens when one write batch touches the same key twice, so code that wants to write a value and then remove it in a single atomic write has no guarantee it will behave the same on every storage backend. Pin the rule down and test it.
files:
  - packages/quereus-store/src/common/kv-store.ts
  - packages/quereus-store/src/testing/kv-conformance.ts
  - packages/quereus-store/src/common/memory-store.ts
  - packages/quereus-plugin-leveldb/src/store.ts
  - packages/quereus-plugin-indexeddb/src/store.ts
  - packages/quereus-plugin-nativescript-sqlite/src/store.ts
  - packages/quereus-plugin-react-native-leveldb/src/store.ts
  - docs/store.md
difficulty: easy
----

## Why

`WriteBatch` (`packages/quereus-store/src/common/kv-store.ts`) documents `write()`
as "Execute all queued operations atomically" and says nothing about what happens
when two queued operations target the **same key**. The conformance suite
(`kv-conformance.ts` tier 4) covers put-only, put+delete on *different* keys,
reuse, `clear()`, and empty — never same-key.

Every implementation today in fact applies its queued operations in order, so the
last operation on a key wins:

| implementation | file | mechanism |
| --- | --- | --- |
| in-memory | `quereus-store/src/common/memory-store.ts:123` | `for (const op of ops)` over an append-ordered array |
| LevelDB | `quereus-plugin-leveldb/src/store.ts:137` | `abstract-level` batch (ordered) |
| React Native LevelDB | `quereus-plugin-react-native-leveldb/src/store.ts:286` | native LevelDB `WriteBatch` (ordered) |
| IndexedDB | `quereus-plugin-indexeddb/src/store.ts:318` | append-ordered `ops` array replayed in one IDB transaction |
| NativeScript SQLite | `quereus-plugin-nativescript-sqlite/src/store.ts:190` | `for (const op of ops)` inside one SQL transaction |
| cached wrapper | `quereus-store/src/common/cached-kv-store.ts:240` | delegates to the wrapped batch |

That behaviour is currently accidental. `sync-local-capture-read-your-own-writes`
wants to *depend* on it — it needs to stage a column-version record and, later in
the same transaction, stage the removal of that same record, all inside one atomic
batch. Depending on an untested accident across five backends is not acceptable, so
promote it to a stated contract with a conformance test behind it.

## The contract to state

> Queued operations apply in the order they were queued. When two operations target
> the same key, the later one wins: `put(k, a); delete(k)` leaves `k` absent, and
> `delete(k); put(k, a)` leaves `k` set to `a`. Ordering is only defined *within* one
> batch; `write()` remains all-or-nothing.

## TODO

- Extend the `WriteBatch` interface doc comment in
  `packages/quereus-store/src/common/kv-store.ts` with the ordering guarantee above
  (on the interface, and a one-liner on `put`/`delete`).
- Add tier-4 conformance cases in
  `packages/quereus-store/src/testing/kv-conformance.ts`:
  - `put` then `delete` on the same key in one batch leaves the key absent (both
    when the key did and did not pre-exist).
  - `delete` then `put` on the same key in one batch leaves the put's value.
  - three ops on one key (`put a`, `put b`, `delete`, then `put c`) leave `c`.
- Run the conformance suite for every backend it is already wired into and confirm
  each passes unchanged. Backends whose suite does not run in this repo's default
  test job (React Native LevelDB, NativeScript SQLite, IndexedDB) — read the code and
  state in the review handoff which ones were verified by execution and which by
  inspection. Do **not** relax the assertion to accommodate a backend; if one genuinely
  cannot honour the ordering, stop and file that as its own ticket, because
  `sync-local-capture-read-your-own-writes` would then need a different design.
- Add the guarantee to `docs/store.md` next to the existing `WriteBatch` / atomicity
  discussion (around the "Shared WriteBatch" and transaction-model sections).

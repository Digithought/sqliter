description: The storage layer now explicitly guarantees that if you queue two writes to the same key in one atomic batch, the later one wins on every supported storage backend — pin this down with docs and tests, ready for review.
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

## What changed

`WriteBatch` (`packages/quereus-store/src/common/kv-store.ts`) now states the
same-key ordering contract on the interface doc comment, plus a one-liner each
on `put`/`delete`:

> Queued operations apply in the order they were queued. When two operations
> target the same key, the later one wins: `put(k, a); delete(k)` leaves `k`
> absent, and `delete(k); put(k, a)` leaves `k` set to `a`. Ordering is only
> defined *within* one batch; `write()` remains all-or-nothing.

`docs/store.md` gets a matching paragraph right after the transaction-coordinator
"How It Works" steps (near the "Shared WriteBatch" diagram), naming all five
backends as compliant.

Four new tier-4 conformance cases in
`packages/quereus-store/src/testing/kv-conformance.ts` (shared battery, runs
once per backend via `runKVStoreConformance`):
- `put` then `delete` on the same key, pre-existing key → absent.
- `put` then `delete` on the same key, key not previously present → absent.
- `delete` then `put` on the same key → put's value wins.
- four ops on one key in sequence (`put a`, `put b`, `delete`, `put c`) → `c`
  survives (exercises more than a simple two-op flip).

No runtime code changed — every backend already applied batch ops in queue
order by construction (append-ordered array replayed with a `for` loop, or a
native/`abstract-level` batch structure that is itself queue-ordered). This
ticket promotes that pre-existing behavior to a stated, tested contract; it
does not alter it.

## Verified by execution (all green, no regressions)

- `yarn workspace @quereus/store run test` — 1081 passing (in-memory backend
  conformance + everything else in that package).
- `packages/quereus-plugin-leveldb` `yarn test` — 56 passing (LevelDB backend
  conformance, via `abstract-level`'s array-form `batch()`).
- `packages/quereus-plugin-indexeddb` `yarn test` — 104 passing (IndexedDB
  backend conformance, via `fake-indexeddb`).
- `yarn workspace @quereus/store run typecheck` — clean.
- Full repo `yarn test` from root — all workspaces green (quereus, quereus-store,
  quereus-isolation, quereus-sync, quereus-sync-client, sync-coordinator,
  quoomb-cli, quoomb-web, plugin-loader, plugin-leveldb, plugin-indexeddb — no
  failures, no new console errors beyond each suite's existing intentional
  error-path logging).

## Verified by inspection only (no test harness in this repo)

`packages/quereus-plugin-nativescript-sqlite` and
`packages/quereus-plugin-react-native-leveldb` have **no** `*.spec.ts` files at
all (confirmed via glob) — both wrap native modules (NativeScript's SQLite
binding, react-native-leveldb's native LevelDB binding) that can't load under
plain Node/Mocha, so there is no conformance run to point at for either:

- **NativeScript SQLite** (`store.ts:190`, `executeBatch`): queued ops are
  replayed with a plain `for` loop inside one `db.transaction(...)` call, in
  array order — same-key ordering follows directly from JS array iteration
  order, no special-casing needed.
- **React Native LevelDB** (`store.ts:319`, `ReactNativeLevelDBWriteBatch`):
  `put`/`delete` calls are forwarded directly to a native LevelDB `WriteBatch`
  object (`nativeBatch.put`/`.delete`), committed via `db.write(nativeBatch)`.
  Native LevelDB's `WriteBatch` is documented to apply operations in the order
  they were added to the batch (standard LevelDB semantics, same as the Node
  `classic-level`/`abstract-level` batch the LevelDB backend uses) — last
  writer for a given key wins.

Neither backend needed a code change to honor the contract; both already did,
by construction. Per the ticket's instruction, if either had turned out unable
to honor the ordering, that would have needed its own ticket (and would have
blocked `sync-local-capture-read-your-own-writes`'s design) — that did not
happen here.

## What the reviewer should look at

- The four new conformance cases are the load-bearing part of this ticket —
  worth double-checking they'd actually fail if a backend broke ordering (e.g.
  temporarily flip a `for` loop to iterate in reverse locally and confirm the
  new assertions catch it, if you want an extra confidence pass — not done as
  part of this ticket, left for review to decide whether it's worth the churn).
- `AtomicBatch` (the cross-store atomic batch interface, same file,
  `kv-store.ts:85`) has the identical queue-then-commit shape and presumably
  the same same-key semantics wherever it's implemented, but the ticket scoped
  doc/test work to `WriteBatch` only — `AtomicBatch`'s doc comment was left
  untouched. Flagging in case the reviewer wants that documented too, but
  treating it as out of scope here rather than silently expanding the ticket.
- `sync-local-capture-read-your-own-writes` (tickets/implement, prereq on this
  ticket + `sync-inbound-batch-delete-blocks-same-batch-writes`) is the ticket
  that actually depends on this guarantee — worth confirming its design still
  matches what got documented here.

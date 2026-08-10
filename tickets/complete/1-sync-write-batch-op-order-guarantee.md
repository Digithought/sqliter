----
description: The storage layer now promises that when one atomic write batch touches the same key twice, the later operation wins — on every supported storage backend — and that promise is written down and covered by tests.
files:
  - packages/quereus-store/src/common/kv-store.ts
  - packages/quereus-store/src/common/cached-kv-store.ts
  - packages/quereus-store/src/testing/kv-conformance.ts
  - packages/quereus-plugin-leveldb/test/atomic-batch.spec.ts
  - packages/quereus-plugin-indexeddb/test/atomic-batch.spec.ts
  - docs/store.md
difficulty: easy
----

## Outcome

The same-key ordering rule — "queued operations apply in queue order; for one key
the later operation wins" — is now stated on the `WriteBatch` interface, stated on
the `AtomicBatch` interface, documented in `docs/store.md`, and enforced by tests
on every backend that has a test harness in this repo.

No runtime behavior changed. Every backend already applied batch operations in
queue order (append-ordered array replayed with a `for` loop, or a native /
`abstract-level` batch that is itself queue-ordered); this work turned that
accident into a contract.

### From the implement stage

- `WriteBatch` doc comment + one-liners on `put`/`delete`
  (`packages/quereus-store/src/common/kv-store.ts`).
- Paragraph in `docs/store.md` after the transaction-coordinator "How It Works"
  steps.
- Four tier-4 cases in the shared conformance suite
  (`packages/quereus-store/src/testing/kv-conformance.ts`): put→delete on a
  pre-existing key, put→delete on a new key, delete→put, and a four-operation run
  (`put a`, `put b`, `delete`, `put c` → `c`). Runs once per backend via
  `runKVStoreConformance` (in-memory, LevelDB, IndexedDB).

### Added during review

- **`AtomicBatch` same-key ordering, documented and tested.** The implement stage
  flagged `AtomicBatch` as "presumably the same semantics, out of scope". It is not
  merely cosmetic: `TransactionCoordinator.commit`
  (`packages/quereus-store/src/common/transaction.ts:231`) buckets its pending
  operations per store and replays them **without collapsing duplicates**, into an
  `AtomicBatch` whenever the provider exposes `beginAtomicBatch` (LevelDB and
  IndexedDB in production). So an ordinary SQL transaction that writes then deletes
  the same row — the exact case `sync-local-capture-read-your-own-writes` depends
  on — commits through `AtomicBatch`, not through the `WriteBatch` path the
  implement stage documented. Fixed in this pass: ordering note on the `AtomicBatch`
  interface doc comment, a matching clause in `docs/store.md`, and a
  `same-key ops in one batch resolve to the last one queued` case in both
  `packages/quereus-plugin-leveldb/test/atomic-batch.spec.ts` and
  `packages/quereus-plugin-indexeddb/test/atomic-batch.spec.ts` (put→delete and
  delete→put against one store handle).

## Review findings

**Do the new conformance tests actually bite? — verified, yes.** The implement
handoff left this as an optional confidence pass; it was run. Temporarily reversing
the in-memory backend's batch replay loop
(`packages/quereus-store/src/common/memory-store.ts:135`) made exactly the four new
cases fail (plus 10 pre-existing tests elsewhere that also depend on batch order),
confirming the assertions are load-bearing and not vacuously true. The mutation was
reverted; the working tree was verified clean afterward.

**Backend coverage of the contract — audited, one real gap (fixed above).** Every
`WriteBatch` and `AtomicBatch` implementation in the repo was read for a per-key
coalescing structure (a `Map` keyed by key would silently break the "later wins"
rule for a delete→put pair). None coalesces — all queue into an append-ordered array
or a native ordered batch:
`memory-store.ts:123`, `cached-kv-store.ts:240` (delegates),
`plugin-leveldb/src/store.ts:191`, `plugin-indexeddb/src/store.ts:318` and `:368`,
`plugin-react-native-leveldb/src/store.ts:319`,
`plugin-nativescript-sqlite/src/store.ts:208`,
`plugin-leveldb/src/provider.ts:410` (`ChainedBatch`),
`plugin-indexeddb/src/provider.ts:355` (wraps `MultiStoreWriteBatch`). The only gap
was documentation/test coverage of the `AtomicBatch` path, addressed above.

**IndexedDB request ordering — checked.** `IndexedDBWriteBatch.write` issues each
operation as a separate request inside one `readwrite` transaction; the IndexedDB
specification executes requests in the order they were placed against a transaction,
so same-key ordering holds. The `fake-indexeddb`-backed conformance run confirms it
empirically.

**Backends verified by inspection only — unchanged and accurate.**
`quereus-plugin-nativescript-sqlite` and `quereus-plugin-react-native-leveldb` have
no runnable conformance harness (both wrap native modules). The implement stage's
reasoning was re-checked at the cited lines and holds: the NativeScript backend
replays a plain array with a `for` loop inside one SQL transaction; the React Native
backend forwards to a native LevelDB `WriteBatch`, which is order-preserving. Note
the RN package does have a `test/store.spec.ts` with a mock native batch — the
handoff's "no `*.spec.ts` files at all" claim is wrong for that package, though its
conclusion (no conformance run available) is right.

**Docs — read the touched files and the ones that should have been touched.**
`docs/store.md` is the only document that describes `WriteBatch`/batch atomicity;
its new paragraph is accurate and now also covers `AtomicBatch`. `docs/sync.md` and
`packages/quereus-store/README.md` were checked and describe no batch semantics that
this contract contradicts.

**Downstream ticket — still consistent.**
`tickets/implement/3-sync-local-capture-read-your-own-writes.md` relies on staging a
cell record and its removal into one batch within one transaction. That is exactly
what is now guaranteed, on both the `WriteBatch` and (after this pass) the
`AtomicBatch` commit path.

**Tripwire parked (not a ticket).** `CachedWriteBatch.write`
(`packages/quereus-store/src/common/cached-kv-store.ts:262`) never clears its `ops`
array. Harmless today — the inner batch clears its own queue, so reusing a handle
only re-invalidates already-invalid cache keys, and the coordinator makes a fresh
batch per commit. Recorded as a `NOTE:` comment at the site: if a caller ever reuses
one batch handle across many commits, the array grows unbounded.

**Noted, no action.** `MultiStoreWriteBatch`
(`packages/quereus-plugin-indexeddb/src/store.ts:368`) declares
`implements WriteBatch` but throws from `put`/`delete`, directing callers to
`putToStore`/`deleteFromStore`. Pre-existing, outside this diff, and it fails loudly
rather than silently — flagged for awareness only, no ticket filed.

**No major findings; no new tickets filed.** Nothing found warranted a `fix/` or
`backlog/` ticket: the one substantive gap (`AtomicBatch`) was small enough to close
in this pass, and everything else was either already correct or a tripwire.

## Validation

- `yarn workspace @quereus/store run test` — 1081 passing.
- `packages/quereus-plugin-leveldb` `yarn test` — 57 passing (was 56; +1 new atomic
  batch case).
- `packages/quereus-plugin-indexeddb` `yarn test` — 105 passing (was 104; +1).
- Root `yarn test` — all workspaces green, no failures.
- Root `yarn lint` — clean.
- Root `yarn typecheck` — clean.

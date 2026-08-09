description: The two mobile storage backends used to load an entire table into memory whenever a query scanned it; they now read in small chunks, and both are wired into the shared storage test suite they previously skipped entirely.
files:
  - packages/quereus-plugin-react-native-leveldb/src/store.ts                   # iterate + walkEntries (was collectEntries)
  - packages/quereus-plugin-react-native-leveldb/test/mock-leveldb.ts           # NEW — extracted + hardened mock
  - packages/quereus-plugin-react-native-leveldb/test/store.spec.ts             # mock removed; iterator-release test added
  - packages/quereus-plugin-react-native-leveldb/test/conformance.spec.ts       # NEW
  - packages/quereus-plugin-nativescript-sqlite/src/store.ts                    # iterate over pagedIterate; own count query; ITERATE_BATCH_SIZE
  - packages/quereus-plugin-nativescript-sqlite/test/better-sqlite3-adapter.ts  # createTestDatabase(path)
  - packages/quereus-plugin-nativescript-sqlite/test/conformance.spec.ts        # NEW
  - packages/quereus-store/src/testing/kv-conformance.ts                        # header: backend list was stale
  - packages/quereus-store/README.md                                            # worked-adapter pointers
  - docs/store.md                                                               # per-backend stream-vs-page facts
difficulty: medium
----

# What landed

Both mobile backends now satisfy `KVStore.iterate`'s bounded-peak / linear-total / release-on-abandon
contract, and both run the shared `runKVStoreConformance` battery.

**React Native LevelDB** — `collectEntries` ran the whole walk into a `KVEntry[]` and the
generator yielded from that array. It is now `walkEntries`, a generator that yields inside the
same walk loop; positioning, bound checks and the limit counter are unchanged. No paging is
involved — rn-leveldb hands back a real streaming cursor. One ordering tweak: the bound check
now happens before `valueBuf()`, so the entry past the far edge ends the walk without its value
being fetched. The pre-existing `finally { iterator.close() }` covers early termination unchanged.

**NativeScript SQLite** — `iterate` is now `yield* pagedIterate(options, fetchBatch, ITERATE_BATCH_SIZE)`
with `ITERATE_BATCH_SIZE = 128` (exported). `fetchBatch` runs one bounded `select` per batch.
Query building split: `buildRangeFilter` (bounds → `where` + params) is shared by
`buildIterateQuery(options, limit)` — where `limit` is the per-batch `want`, not the caller's
`IterateOptions.limit` — and by `approximateCount`, which now builds its own `count(*)` instead of
regex-stripping clauses off the iterate query. Key-resume, not `limit`/`offset`: `pagedIterate`
hands back the resume edge as `gt`/`lt`, which `buildRangeFilter` already understood.

# Measured

Read meters wired into both conformance adapters; numbers taken by temporarily setting
`maxReadAhead: 0` and reading the assertion message (the technique is recorded in a comment at
each adapter's `maxReadAhead`).

| case | React Native LevelDB | NativeScript SQLite |
|---|---|---|
| consume 1 entry of a 512-entry range | 1 read | 128 reads (exactly one batch) |
| same, reverse | 1 | 128 |
| `limit: 5`, consume 5 | 5 | 5 (limit pushed into the batch) |
| drain all 512 | 512 | 512 (linear — no prefix re-scan) |

Before this change both read 1000 of 1000 seeded entries to serve one.

# Validate

```
npx tsc -b tsconfig.build.json          # both specs import @quereus/store/testing from dist
yarn workspace @quereus/plugin-react-native-leveldb run test      # 72 passing
yarn workspace @quereus/plugin-nativescript-sqlite run test       # 61 passing
yarn test                                # whole workspace — green, 5m20s
```

Both plugins' `typecheck` (which includes `tsc -p tsconfig.test.json --noEmit`) pass, and
`--listFiles` confirms each new spec is in the compiled set — the zero-file-config trap the
ticket warned about is not in play.

Conformance coverage: React Native LevelDB registers 43 cases (no `reopen` — the mock is not
persistent, so tier 5 is skipped, same as the in-memory backend); NativeScript SQLite registers 44
including tier 5, driven by a per-test temp **file** database whose `reopen` closes every handle
and re-opens the same path.

Worth exercising by hand if you want independent confidence:
- delete the `finally { iterator.close() }` in the RN store → `should close the native iterator on
  exhaustion, break, and a consumer throw` in `store.spec.ts` must fail (conformance tier 7 will
  NOT catch it: a leaked *mock* iterator wedges nothing, which is exactly why that test exists);
- put back `collectEntries`-style buffering in either store → tier 7's metered cases must fail;
- change `pagedIterate`'s resume edge to `limit`/`offset` → the `draining the whole range` case
  must fail while the prefix cases still pass.

# Honest gaps

- **Neither backend is tested against its real native module.** rn-leveldb and
  @nativescript-community/sqlite cannot load under Node, so the subjects are `MockLevelDB` and
  better-sqlite3 behind the same interfaces. Mock fidelity is the whole trust anchor for the RN
  side; `test/mock-leveldb.ts`'s header states exactly which LevelDB behaviors it claims to
  reproduce. Nothing here proves on-device behavior.
- **`ITERATE_BATCH_SIZE = 128` is a judgement call, not a measurement** — no device profiling
  exists. Recorded as a `NOTE:` at the constant with both revisit directions.
- **`approximateCount` + `limit` diverges across backends** and this ticket did not resolve it:
  IndexedDB and NativeScript SQLite ignore `limit` (a range's count does not depend on how much
  of it you would read); LevelDB and in-memory count by iterating, so they cap at `limit`. The
  contract says nothing and the battery never passes `limit` there. Previously SQLite got its
  behavior by accident (a regex that swallowed the `limit` clause along with `order by`); it is now
  explicit, with a `NOTE:` saying to settle it in the contract rather than in one backend.
- **A `close()` while a SQLite scan is suspended does not stop its remaining batches** —
  `checkOpen` runs once, as it did when one `select` read everything. Harmless because
  `SQLiteStore.close()` deliberately leaves the shared database open. `NOTE:` at the site.
- The RN store's `iterate` still reads key and value as separate cursor calls per entry; the read
  meter counts a position once however many buffers are read there, so a future change that reads
  a third buffer per entry would not move the number.

# Divergences the battery surfaced

Both were **mock** defects, not store defects, found while extracting `MockLevelDB` out of
`store.spec.ts` — the store's behavior was correct in both cases and was not changed:

- **Empty key was corrupted.** The mock keyed its `Map` by `bytes.join(',')`; decoding `''` gave
  `[0]`, so the empty key round-tripped as `x'00'` (tier 1 `an empty key is a valid key`). Keys are
  now a latin1 string — losslessly invertible for every byte value including empty, and its natural
  string order already matches `compareBytes`, which is what the ticket asked to verify for the high
  bytes `0x80`–`0xff`. Tiers 2 and 6 (which seed `0x80`, `0xff` and the encoded golden vector) pass.
- **`valueBuf()` handed out the mock's internal buffer**, so a consumer scribbling on a yielded
  entry corrupted stored data (tier 2 `yields COPIES`). The real binding returns a fresh buffer per
  call; the mock now does too.

The mock also gained `openIteratorCount()` and the `onEntryRead` metering hook. Everything else in
it — positioning, `seek`/`seekLast`/`prev` semantics, snapshot-at-`newIterator` — is the original
behavior, re-expressed.

No pre-existing failures were encountered; `tickets/.pre-existing-error.md` was not written.

# Review notes

- The two `NOTE:` tripwires above (`ITERATE_BATCH_SIZE` sizing, `close()`-mid-scan) are parked at
  their code sites, not filed as tickets.
- `docs/store.md` gained one sentence naming which backend streams and which pages, and
  `kv-conformance.ts`'s header + `quereus-store/README.md` no longer claim only three backends run
  the battery.
- `yarn build` proper (which `clean`s and also bundles shared-ui / vscode / quoomb-web) was not run;
  `tsc -b tsconfig.build.json` — the same library graph, incremental — was, and the bundled apps
  are untouched by this diff.

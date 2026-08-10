description: The two mobile storage backends used to load an entire table into memory whenever a query scanned it; they now read in small chunks, and both are wired into the shared storage test suite they previously skipped entirely.
files:
  - packages/quereus-plugin-react-native-leveldb/src/store.ts                   # iterate + walkEntries (was collectEntries); shared compareBytes
  - packages/quereus-plugin-react-native-leveldb/test/mock-leveldb.ts           # extracted + hardened mock; shared compareBytes
  - packages/quereus-plugin-react-native-leveldb/test/store.spec.ts             # mock removed; iterator-release test added
  - packages/quereus-plugin-react-native-leveldb/test/conformance.spec.ts       # NEW; read meter
  - packages/quereus-plugin-nativescript-sqlite/src/store.ts                    # iterate over pagedIterate; own count query; ITERATE_BATCH_SIZE
  - packages/quereus-plugin-nativescript-sqlite/test/better-sqlite3-adapter.ts  # createTestDatabase(path)
  - packages/quereus-plugin-nativescript-sqlite/test/conformance.spec.ts        # NEW
  - packages/quereus-store/src/testing/kv-conformance.ts                        # header: backend list was stale
  - packages/quereus-store/README.md                                            # worked-adapter pointers
  - docs/store.md                                                               # per-backend stream-vs-page facts
----

# What landed

Both mobile backends satisfy `KVStore.iterate`'s bounded-peak / linear-total /
release-on-abandon contract, and both run the shared `runKVStoreConformance` battery.

**React Native LevelDB** — `collectEntries` ran the whole walk into a `KVEntry[]` and the
generator yielded from that array. It is now `walkEntries`, a generator that yields inside the
same walk loop; positioning, bound checks and the limit counter are unchanged. No paging is
involved — rn-leveldb hands back a real streaming cursor. One ordering tweak: the bound check
now happens before `valueBuf()`, so the entry past the far edge ends the walk without its value
being fetched. The pre-existing `finally { iterator.close() }` covers early termination.

**NativeScript SQLite** — `iterate` is `yield* pagedIterate(options, fetchBatch, ITERATE_BATCH_SIZE)`
with `ITERATE_BATCH_SIZE = 128` (exported for the test's read meter; not re-exported from the
package index, so it is not public API). `fetchBatch` runs one bounded `select` per batch.
Query building split: `buildRangeFilter` (bounds → `where` + params) is shared by
`buildIterateQuery(options, limit)` — where `limit` is the per-batch `want`, not the caller's
`IterateOptions.limit` — and by `approximateCount`, which builds its own `count(*)` instead of
regex-stripping clauses off the iterate query. Key-resume, not `limit`/`offset`: `pagedIterate`
hands back the resume edge as `gt`/`lt`, which `buildRangeFilter` already understood.

Conformance coverage: React Native LevelDB registers 43 cases (no `reopen` — the mock is not
persistent, so tier 5 is skipped, same as the in-memory backend); NativeScript SQLite registers
44 including tier 5, driven by a per-test temp **file** database whose `reopen` closes every
handle and re-opens the same path.

Two mock defects (not store defects) surfaced while extracting `MockLevelDB` out of
`store.spec.ts`: the empty key was corrupted by a `bytes.join(',')` map key (now a losslessly
invertible latin1 string), and `valueBuf()` handed out the mock's internal buffer so a consumer
scribbling on a yielded entry corrupted stored data (now a fresh buffer per call, as the real
binding does). The store's behavior was correct in both cases and was not changed.

# Review findings

## Checked

Read the implement diff before the handoff summary, then every touched file plus the files it
should have touched: `paged-iterate.ts` and its property spec, `kv-store.ts`'s `iterate`
contract, all seven conformance tiers, both plugins' `package.json` test globs, both plugin
READMEs, `docs/store.md`, `packages/quereus-store/README.md`.

Reproduced the handoff's measured read counts independently rather than trusting the table —
temporarily set `maxReadAhead: 0` on both adapters and read the assertion messages:

| case | React Native LevelDB | NativeScript SQLite |
|---|---|---|
| consume 1 of a 512-entry range | 1 | 128 (exactly one batch) |
| same, reverse | 1 | 128 |
| `limit: 5`, consume 5 | 5 | 5 (limit pushed into the batch) |
| drain all 512 | 512 | 512 (linear, no prefix re-scan) |

Exactly as claimed. Also hand-checked the tier-7 allowance arithmetic against
`ITERATE_BATCH_SIZE = 128` (consume-1 reads 128 against an allowance of exactly 128 — the case
passes at its boundary, which is correct but leaves no margin if the batch size is ever raised
without re-running the tier), and confirmed tier 3's 306-entry fixture crosses two 128-row
seams so the resume edge is genuinely exercised on this backend.

Validation, all from a clean `tsc -b tsconfig.build.json`:

```
yarn workspace @quereus/plugin-react-native-leveldb run test    # 72 passing
yarn workspace @quereus/plugin-nativescript-sqlite run test     # 61 passing
yarn workspace @quereus/plugin-{react-native-leveldb,nativescript-sqlite} run typecheck   # clean
yarn lint        # clean (only quereus has a real lint; the rest are the intentional no-ops)
yarn typecheck   # clean
yarn test        # whole workspace, exit 0, zero failing, 10m43s
```

The `Error:`/`failed` strings in the full-test log are expected error-path logging from
negative tests (sync socket-write, batch-write and iterate failure cases), not failures.

## Fixed in this pass (minor)

- **`maxReadAhead: 1` was understated for the React Native adapter** — the field's own contract
  says to count "any extra probe read the implementation takes". An exclusive `gt` whose key
  exists costs two reads for the first yield: the store reads that key, sees it equals `gt`,
  steps past it, and reads the next. Measured with a throwaway spec: `{ gt: <present key> }`
  stopped after one entry reads 2. Nothing failed today because no metered case passes bounds,
  but a bounded metered case added to the shared battery later would fail a *correct*
  implementation. Now `2`, with the measurement recorded in the comment. This loosens the
  allowance by one entry; a backend that buffers a 512-entry range still fails by 511.
- **Three copies of `compareBytes`** — the RN store's own copy (pre-existing) and a new one in
  `mock-leveldb.ts`, alongside the canonical `@quereus/store` export. `compareBytes` *is* the
  iteration contract's ordering oracle and the thing the battery asserts against, so a store
  doing its bound checks with a private re-derivation is exactly the drift the shared battery
  cannot see. Both now import the canonical one. Safe for a React Native bundle: `plugin.ts`
  and `provider.ts` already value-import `@quereus/store`, so this adds no new runtime edge.
- **NativeScript SQLite row casts claimed `ArrayBuffer`** while better-sqlite3 — the driver the
  tests actually run — returns `Buffer`. `toUint8Array` already accepted both, so the cast
  contradicted the helper it fed. Introduced `type BlobColumn = ArrayBuffer | Uint8Array` and
  used it in `get` and `fetchBatch`.

## Filed (major)

- `backlog/debt-approximate-count-limit-divergence` — `approximateCount(options)` takes the full
  `IterateOptions`, including `limit`, and the five backends split on what that means:
  in-memory / LevelDB / RN LevelDB count by iterating so they cap at `limit`; IndexedDB and
  NativeScript SQLite issue a native count and ignore it. Same range, different answer, on
  stores that are meant to be interchangeable. The implementer left a `NOTE:` at the SQLite site
  deferring it, which is the right call for that site but leaves the interface unsettled. This
  is a dormant path (no caller passes `limit` to a count) but it is definitely wrong the moment
  one does, so it is a ticket, not a tripwire. Filed at the top rung of the architecture ladder:
  the preferred fix is narrowing `approximateCount`'s parameter so `limit` cannot be passed at
  all, with "document the rule and add a battery case" as the fallback. Checked the board first
  — nothing open claims `kv-store.ts`/`approximateCount`; `debt-conformance-harness-coverage-gaps`
  is about the vtab committed-read harness, a different file and a different guarantee.

## Tripwires

Nothing new parked. The implementer's two `NOTE:`s are correctly placed and left alone:
`ITERATE_BATCH_SIZE = 128` being a judgement call with no device profile behind it, and
`checkOpen` running once per scan so a `close()` mid-scan does not stop remaining batches
(harmless while `SQLiteStore.close()` leaves the shared database open). Neither revisit
condition has tripped.

## Checked and found nothing — with reasons

- **Resource cleanup.** No leak. The RN `finally` is verified on all three exits (exhaustion,
  `break`, consumer throw) by the mock's live-iterator count, which is the only thing that can
  see it — tier 7 cannot, since a leaked *mock* iterator wedges nothing. The SQLite path holds
  no handle between batches: `SQLiteDatabase.select` returns a realized array, so there is
  genuinely nothing to release, and the code says so at the site.
- **Correctness of the paging seam.** Nothing found. `pagedIterate` already carries a
  property test pinning it byte-identical to a single-shot iterate across five batch sizes and
  22 bound/limit/direction scenarios, and the SQLite store only supplies bounds to it — it does
  not re-derive the resume edge, which is where this class of bug lives.
- **Docs.** No staleness left. `docs/store.md`, `kv-conformance.ts`'s header and
  `quereus-store/README.md` were all updated and now match reality. Both plugin READMEs were
  re-read in full: neither makes any claim about iteration buffering or memory behavior that
  this change invalidates, so no edit was warranted — an absence, not an oversight.
- **Source hygiene.** Sizes measured with `wc -l`: NativeScript store 316 lines, RN store 391,
  mock 264 — none near a split. Functions are short and named (`walkEntries`, `fetchBatch`,
  `buildRangeFilter`, `buildIterateQuery`). The comment-to-code ratio in `SQLiteStore.iterate`
  is high (two lines of code under fourteen of comment), but each paragraph records a distinct
  decision a reader would otherwise have to re-derive, so it was left as written.
- **SQL construction.** No injection surface. `limit ${limit}` interpolates a number, but that
  number is now always `Math.min(batchSize, remaining)` or the validated `ITERATE_BATCH_SIZE`,
  so a non-numeric value degrades to `NaN` and a syntax error rather than reaching the parser
  as text. This is strictly tighter than the previous code, which interpolated the caller's
  `options.limit` directly.
- **Pre-existing failures.** None encountered; `tickets/.pre-existing-error.md` was not written.

# Honest gaps that remain

- **Neither backend is tested against its real native module.** rn-leveldb and
  @nativescript-community/sqlite cannot load under Node, so the subjects are `MockLevelDB` and
  better-sqlite3 behind the same interfaces. Mock fidelity is the whole trust anchor for the RN
  side; `test/mock-leveldb.ts`'s header states which LevelDB behaviors it claims to reproduce.
  Nothing here proves on-device behavior.
- **`ITERATE_BATCH_SIZE = 128` is unmeasured** — no device profiling exists. Parked as a `NOTE:`.
- **`approximateCount` + `limit` still diverges across backends** — now filed, see above.
- The RN store reads key and value as separate cursor calls per entry; the meter counts a
  position once however many buffers are read there, so a future change that reads a third
  buffer per entry would not move the number.
- `yarn build` proper (which `clean`s and also bundles shared-ui / vscode / quoomb-web) was not
  run; `tsc -b tsconfig.build.json` — the same library graph, incremental — was, and the bundled
  apps are untouched by this diff.

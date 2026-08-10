---
description: A table or index whose name contains a broken half-character is now rejected up front, instead of being accepted and then silently emptying the table when it was renamed.
files:
  - packages/quereus-store/src/common/key-builder.ts                        # the fix — guard on both physical store-name builders
  - packages/quereus-store/src/common/store-module.ts                       # NOTE tripwires at renameTable's relocation and at collectOccupiedStoreNames
  - packages/quereus-plugin-leveldb/src/provider.ts                          # corrected injectivity docstring
  - packages/quereus-plugin-indexeddb/src/provider.ts                        # NOTE about untested IndexedDB behavior
  - docs/store.md                                                            # doc paragraph on the physical-name guard
  - packages/quereus-store/test/key-builder.spec.ts                          # 12 unit tests
  - packages/quereus-store/test/lone-surrogate-keys.spec.ts                   # 3 tests retimed to reject at CREATE
  - packages/quereus-plugin-leveldb/test/lone-surrogate-store-name.spec.ts    # 5 real-LevelDB regression tests
---

## What a "lone surrogate" is

A JavaScript string is a list of 16-bit units. Characters above U+FFFF are stored as a
*pair* of units. A string may also hold one half of such a pair with no partner — a **lone
(unpaired) surrogate**. It is a legal JS string and a legal Quereus `text` value, but it is
not valid Unicode and **no UTF-8 byte sequence encodes it**: `TextEncoder` replaces all 2048
of them with the same replacement character U+FFFD. So any code that turns a name into UTF-8
bytes maps every lone surrogate onto one identical byte string.

## What was wrong

Physical storage names (`{schema}.{table}`, `{schema}.{table}_idx_{index}`) were built with
no check. `LevelDBProvider` percent-escapes the name's UTF-8 bytes to form a sublevel name,
so `main.\uD800` and `main.\uD801` both became the sublevel `main.%EF%BF%BD` — two distinct
tables, one physical store.

The sharp end was **silent data loss on RENAME**. `StoreModule.renameTable` relocates
physical storage *first* and rewrites the catalog *after*; only the catalog write carried the
identifier guard added by the earlier ticket
`bug-store-catalog-key-lone-surrogate-identifier-collision`. So
`alter table p rename to "<lone surrogate>"` raised an error — after LevelDB had already
moved p's rows into an orphan sublevel and emptied `main.p`. The statement errored and the
table came back permanently empty, with the catalog still naming `p`.

## What was changed

`buildDataStoreName` and `buildIndexStoreName` (`key-builder.ts`) call
`assertKeyableIdentifiers` on every identifier they compose from — the same helper the
catalog-key builders already used, moved above them in the file so it is declared before
first use.

This is the right layer because every call site computes the physical name **before** its
first side effect: `create()` before `provider.getStore` (`store-module.ts:616`),
`createIndex()` before `provider.getIndexStore` (`:922`), `renameTable()` before the
coordinator flush and `provider.renameTableStores` (`:2534`/`:2542`). The throw always lands
on a clean no-op — which is what kills the data-loss path. It also sits above every provider,
so LevelDB, IndexedDB, React Native LevelDB and the in-memory provider behave identically.

Non-functional companions: `LevelDBProvider.encodeSublevelName`'s docstring no longer claims
injectivity over arbitrary JS strings; `NOTE:` tripwires sit at `renameTable`'s relocation
call and at `collectOccupiedStoreNames`; `IndexedDBProvider.getStore` records that its
object-store names are code-unit-compared `DOMString`s per spec but that this was not
verified against a real browser; `docs/store.md` gained a paragraph.

`buildStatsStoreName` was deliberately left unguarded: it is deprecated and has no callers
outside the barrel re-export in `common/index.ts`.

## User-visible behavior change

`create table "<lone surrogate>" using store` and `create index "<lone surrogate>" on t (v)`
now fail **at the DDL statement**, with a message naming the unpaired surrogate, instead of
succeeding and then failing on the first INSERT/SELECT. Such a table could never persist its
schema anyway, so the change is strictly earlier, not stricter.

A lone surrogate that appears only in the persisted **DDL text** (a quoted column name, a
`default` string literal) while the table's own name is clean still surfaces lazily on first
data access, because the store-name guard never sees it.

Well-formed astral characters (a proper surrogate *pair*, e.g. `'\u{10000}'`) keep working.

## Tests

- `packages/quereus-store/test/key-builder.spec.ts` — 12 unit tests: each builder rejects a
  lone high surrogate, a lone low surrogate, and one embedded mid-identifier, in the schema /
  table / index position; each still accepts a well-formed astral character.
- `packages/quereus-store/test/lone-surrogate-keys.spec.ts` — the three tests that pinned the
  old late-failure timing for a bad *table* name now assert rejection at `CREATE` and that
  `loadAllDDL()` stays empty. The index test puts the lone surrogate in the *index* name and
  checks the table's rows survive. The two DDL-text tests are untouched.
- `packages/quereus-plugin-leveldb/test/lone-surrogate-store-name.spec.ts` — 5 tests over a
  real `LevelDBProvider` + `Database` + `StoreModule` on a temp dir, including a raw
  `ClassicLevel` reopen asserting no `%EF%BF%BD` sublevel exists on disk, plus the
  astral end-to-end test added during review (see findings).

The implementer verified the regression tests actually catch the bug: with the two
`assertKeyableIdentifiers` calls temporarily removed and the workspace rebuilt, the LevelDB
tests fail, the rename test with exactly the reported symptom
(`expected [] to deeply equal [ { v: 111 }, { v: 222 } ]`).

## Review findings

### What was checked

Read the implement diff (`78bc19f6`) before the handoff summary. Traced every `src/` caller
of `buildDataStoreName` / `buildIndexStoreName` (34 sites across four providers and
`store-module.ts`) and confirmed none is on a per-row or per-query path — all are DDL,
store-open, or store-close paths, so the added O(name length) scan costs nothing measurable.
Confirmed the guard precedes the first side effect at all three `StoreModule` call sites
(`create` :616 before `getStore` :627; `createIndex` :922; `renameTable` :2534/:2542 before
the coordinator flush :2551 and the relocation :2610). Audited the rest of `key-builder.ts`
for sibling builders that key on an identifier and found `buildCatalogKey`,
`buildViewCatalogKey`, `buildMaterializedViewCatalogKey` and `buildStatsKey` all already
guarded — no gap. Verified `.toLowerCase()` runs after the guard and cannot split a
well-formed surrogate pair. Re-read `docs/store.md`, both touched provider docstrings, and
the two `NOTE:` blocks against the code they describe.

### Fixed in this pass (minor)

- **Over-claimed injectivity in the new docs.** `buildDataStoreName`'s docstring and the new
  `docs/store.md` paragraph both stated flatly that the guard makes
  `StoreModule.assertStoreNameFree` "sound" because the remaining name space "encodes
  injectively". That holds for LevelDB and IndexedDB but is false for
  `@quereus/plugin-nativescript-sqlite`, whose `getTableName` folds every character outside
  `[a-zA-Z0-9_]` to `_`. Both passages now scope the claim to the providers it holds for and
  name the one it does not, pointing at the new backlog ticket. `buildIndexStoreName`'s
  cross-reference was reworded to match.
- **No end-to-end test that a well-formed astral name works through a real provider** — the
  handoff listed this as a known gap. Astral acceptance was covered only at the builder unit
  level, so an over-rejection (or a mangling) that only manifests deeper in a provider would
  not have been caught. Added
  `accepts well-formed astral characters end to end, on distinct sublevels` to
  `lone-surrogate-store-name.spec.ts`: creates a table and an index named with U+10000,
  inserts and index-seeks, creates a sibling named with U+10001 and shows the two do not
  share rows, then renames onto another astral name and re-reads. Passes (LevelDB suite
  55 → 56).

### Filed as a new ticket (major)

- `tickets/backlog/bug-mobile-provider-physical-store-name-collisions.md` — the handoff
  flagged NativeScript SQLite's `getTableName` sanitizer as "outside this ticket, but the
  same class of defect"; it is worse than a lookalike. `create table "a-b"` and
  `create table "a b"` both map to the SQLite table `quereus_main_a_b`, so two ordinary,
  legally-named tables silently share storage and mix rows — reachable today, invisible to
  `assertStoreNameFree` (which compares the still-distinct logical names), and unrelated to
  surrogates. Folded into the same ticket: React Native LevelDB appends `_idx_{indexName}`
  without lowercasing the index name, so a case-insensitive SQL identifier can map to two
  on-device databases there and disagrees with every other provider. Both stem from the same
  root cause the handoff identified — these two plugins compose physical names by hand
  instead of calling the shared builders. Backlogged rather than queued for fix because
  changing either plugin's naming renames existing on-device stores; the ticket states that
  compatibility decision explicitly.

### Recorded as tripwires, not tickets

- **`collectOccupiedStoreNames` can now throw while enumerating *existing* schema objects**,
  not only the incoming one, because it calls the newly-guarded builders over every
  store-backed table in the schema. An unrelated `CREATE`/`RENAME` would then fail with a
  confusing "cannot store the identifier …" error. Unreachable today (a throwing `create`
  never registers the table, and a pre-guard catalog entry was folded to a real U+FFFD
  character, which passes) — but the handoff correctly noted this was reasoning, not a test.
  Parked as a `NOTE:` at `store-module.ts:524`, including what to do if it ever trips (skip
  the object; it occupies no store) rather than letting the enumeration throw.
- The `renameTable` relocation-before-catalog-rewrite tripwire the implementer added at
  `store-module.ts:~2600` was checked against the code and is accurate; left as written.

### Checked and found clean — no action

- **`buildStatsStoreName` left unguarded.** Confirmed deprecated with no callers outside the
  `common/index.ts` re-export. Correct to leave alone; guarding it would imply it is live.
- **Duplicated test fixture.** `lone-surrogate-store-name.spec.ts` repeats ~40 lines of
  harness (temp dir, `Database`, `rows`, `attempt`) from `sibling-collision.spec.ts`.
  Deliberately not extracted: the new file's fixture additionally tracks a `closed` flag so
  its raw-`ClassicLevel` reopen can release the single-writer lock, so a shared helper would
  need parameterizing for one caller. Revisit if a third LevelDB integration spec appears.
- **Error-message content.** `assertKeyableIdentifiers` interpolates the offending identifier
  raw, so the message itself carries the lone surrogate. Pre-existing behavior of the shared
  helper (not introduced here), and harmless — `assertNoUnpairedSurrogate` also reports the
  code point and offset in ASCII, which is the actionable part.
- **IndexedDB unverified.** Needs a browser; correctness no longer depends on it since the
  guard sits above the provider. The code comment is the right home for it.
- **No `blocked/` items.** Nothing in this ticket needed a human decision or an out-of-repo
  dependency.

## Validation

| Command | Result |
| --- | --- |
| `yarn build` | clean |
| `yarn lint` (fan-out, incl. `tsc -p tsconfig.test.json`) | clean, 1m16s |
| `yarn typecheck` (fan-out) | clean |
| `npx tsc -p packages/quereus-store/tsconfig.test.json --noEmit` | clean |
| `npx tsc -p packages/quereus-plugin-leveldb/tsconfig.test.json --noEmit` | clean |
| `yarn test` (full workspace, after review edits) | **0 failing** — quereus 7267 passing / 13 pending, store 1037, leveldb 56, sync 481, others green |
| `yarn test:store` (quereus logic tests vs the LevelDB store module) | **0 failing** — 7260 passing / 20 pending, 4m |

`yarn test:store` was the one item the implementer deferred and explicitly flagged for
review, on the grounds that this ticket touches the store path. It was run here and is green;
it completes in ~4 minutes, well inside the runner's idle timeout, so future store-path
tickets can run it directly.

No pre-existing failures surfaced; `tickets/.pre-existing-error.md` was not written.

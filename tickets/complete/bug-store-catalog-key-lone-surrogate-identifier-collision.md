----
description: Table, view, and column names containing a broken half-character (a lone surrogate) used to get silently mixed up together when a persistent database saved them, so creating two differently-named tables could lose one and saved definitions could come back changed. The store now refuses such names with a clear error.
files:
  - packages/quereus-store/src/common/encoding.ts
  - packages/quereus-store/src/common/index.ts
  - packages/quereus-store/src/common/key-builder.ts
  - packages/quereus-store/src/common/store-module.ts
  - packages/quereus-store/test/lone-surrogate-keys.spec.ts
  - packages/quereus-store/test/encoding.spec.ts
  - packages/quereus-store/test/key-builder.spec.ts
  - packages/quereus-sync/src/metadata/keys.ts
  - packages/quereus-sync/test/metadata/keys.spec.ts
  - docs/store.md
----

# Complete: catalog keys and DDL text now refuse identifiers with an unpaired surrogate

## What shipped

The value-side guard from `bug-store-lone-surrogate-key-collision` was generalized into one shared,
exported primitive and wired into every identifier/DDL-text write site:

- `findUnpairedSurrogate` exported; `assertEncodableText` renamed to
  `assertNoUnpairedSurrogate(value, describe)` with a caller-supplied describe phrase. TEXT-value
  behavior unchanged.
- `key-builder.ts`: `buildCatalogKey` / `buildViewCatalogKey` / `buildMaterializedViewCatalogKey` /
  `buildStatsKey` guard their identifiers via a private `assertKeyableIdentifiers(...names)`. Stale
  `NOTE:` pointing at this ticket removed.
- `store-module.ts`: new private `encodeCatalogDDL(ddl)` guards the FULL persisted DDL text (catches
  a lone surrogate in a quoted column name or a `default '…'` / `check` string literal even when the
  table name is clean); now the sole DDL→bytes path for `saveTableDDL`,
  `persistObjectCatalogEntryIfChanged`, `persistCatalogIfChanged`.
- `quereus-sync/metadata/keys.ts`: all six identifier-keyed builders guard their schema/table/column
  args via a local `assertKeyableIdentifiers`, importing `assertNoUnpairedSurrogate` from
  `@quereus/store`. `pk`/`hlc`/`entryType`/`siteId`/`transactionId` exempt (JSON-escaped, base64, or
  non-user text).

Design: unconditional refuse, not after-the-fact collision detection — mirrors the value-side ticket.

## Review findings

Reviewed the full implement diff (`d5f99955`) with fresh eyes against SPP, DRY, modularity,
scalability, maintainability, performance, resource cleanup, error handling, and type safety, then
re-ran every test and typecheck. The implementer's handoff was honest and its two flagged gaps both
held up under scrutiny.

**Checked and clean:**
- **Completeness of the guard's reach.** Confirmed `encodeCatalogDDL` is the sole DDL→bytes path for
  all three catalog-DDL write sites; the remaining raw-`TextEncoder` `put`s in `store-module.ts`
  (stale-MV set, clean-shutdown marker) carry only `JSON.stringify` output, which escapes lone
  surrogates to ASCII — correctly exempt. In `quereus-sync/keys.ts`, verified all six write-side
  identifier builders are guarded and that `buildTransactionKey` / `buildPeerStateKey` /
  `buildPeerSentStateKey` legitimately need no guard (internal id / base64 siteId — no user text).
- **Read-side scan-bounds builders left unguarded** (`buildChangeLogScanBoundsAfter`,
  `buildQuarantineScanBounds`) — correct: an unfaithful identifier can never have been *written*
  (write side rejects), so scanning for one is harmless.
- **Performance.** The per-identifier regex `HAS_SURROGATE.test` early-returns on the common
  (no-surrogate) case; negligible even on the hot sync-write builders. No action.
- **Type safety / error shape.** `QuereusError` reused, message names code unit + offset +
  caller phrase. Test-file typechecks (`tsc -p tsconfig.test.json --noEmit`) pass in both packages,
  catching spec call-site drift.

**Tests (all green this pass):**
- `@quereus/store` — 938 passing.
- `@quereus/sync` — 477 passing.
- `tsc -p tsconfig.test.json --noEmit` in both packages — clean.
- No pre-existing failures encountered; nothing skipped, loosened, or disabled.

**Major (filed as new tickets):**
1. **Views/MVs: the guard fires but the error is swallowed** →
   `backlog/bug-store-view-lone-surrogate-name-silently-dropped`. `view_added` /
   `materialized_view_added` persists route through `enqueuePersist`, whose `.catch(console.warn)`
   (by design, so a listener can't abort the SQL statement) eats the guard's throw — so
   `CREATE VIEW "<lone-surrogate>"` succeeds, is queryable in-session, and is silently lost on
   reopen. Confirmed by a throwaway (uncommitted) check. Real, currently reachable; fix needs
   synchronous pre-validation ahead of the fire-and-forget path (touches event-dispatch
   architecture — out of this ticket's one-line-guard scope).
2. **Physical store names unguarded** →
   `backlog/bug-store-physical-store-name-lone-surrogate-collision`. `buildDataStoreName` /
   `buildIndexStoreName` were out of this ticket's explicit scope and still fold on real providers:
   two tables differing only by a lone surrogate produce distinct JS strings (so `assertStoreNameFree`
   passes) but can encode to one physical store on LevelDB, colliding at the storage layer at
   `CREATE TABLE` time (`create()` opens the store eagerly, before the catalog guard runs).
   Unverified against a live provider — ticket leads with "reproduce against LevelDB first."

**Reviewed and accepted as-is (no ticket, no change):**
- **Table rejection is lazy, not at `CREATE TABLE`.** `saveTableDDL` runs on first store access
  (`StoreTable.initializeStore`), so `create table "<lone-surrogate>" … using store` succeeds and the
  first `INSERT`/`SELECT` is what raises. This is documented, tested, and consistent with how
  `CREATE INDEX`/`ALTER` persist — an accurate description of behavior, not a defect. (The views gap
  above is the genuinely broken variant of the same lazy/advisory-persist theme.)

**Minor (noted, not worth a change):**
- **`assertKeyableIdentifiers` is duplicated** — one copy in `key-builder.ts`, one in
  `quereus-sync/keys.ts`, both a 3-line loop over `assertNoUnpairedSurrogate`. Left as-is: sharing a
  trivial variadic wrapper across a package boundary would add coupling for no real DRY payoff, and
  the underlying primitive (`assertNoUnpairedSurrogate`) *is* already shared. Recorded here so a
  future reader knows it was a deliberate call, not an oversight.

**Empty categories:** No pre-existing test failures. No tests skipped, loosened, or disabled. No
docs left stale — `docs/store.md`'s identifier paragraph now describes the shipped guard.

---
description: Some errors from tables using the transaction-isolation layer named an internal bookkeeping table instead of the table the user actually wrote — fixed at both places it could happen, with tests and a documented rule.
files:
  - packages/quereus-isolation/src/isolation-module.ts       # renameOverlayInError() helper; wired into the PK re-key pre-flight and the in-place overlay-adopt catch
  - packages/quereus-isolation/test/isolation-layer.spec.ts  # regression coverage for both sites
  - docs/design-isolation-layer.md                           # states the "no user-facing error names an overlay staging table" rule
---

# Complete — overlay staging-table name no longer leaks into user-facing errors

## Background

A table declared `using isolated` is backed by a shared underlying table plus one private
per-connection **overlay** — a scratch `MemoryTable` named `_overlay_<table>_<id>` that holds the
connection's uncommitted rows. That name is an internal detail; a user who wrote
`alter table ecp_own …` should never see it.

The overlay's module raises errors of its own, and those errors name the table they were raised
against — the overlay. Wherever such an error reaches the user unedited, the internal name leaks.

## What shipped

`IsolationModule.renameOverlayInError(e, overlaySchema, tableName)` (isolation-module.ts, ~line
968): if `e` is a `QuereusError` whose message contains the overlay's internal name, it rewrites
the message **in place** to name the real table, and returns `e`.

Two call sites — both places an overlay-raised message can reach a user:

- The PRIMARY-KEY re-key pre-flight in `alterTable` (~line 1543), whose refusal is thrown
  verbatim. *(Fixed in the implement stage.)*
- `applyInPlaceOverlayChange` (~line 1351), which quotes the text into a foreign overlay's
  poison message and into `issuerOverlayDriftError`. *(Found and fixed in this review.)*

`docs/design-isolation-layer.md` § *SET COLLATE on a primary key* now states the rule — no
user-facing error may name an overlay staging table — and names both sites, so a future third
site has somewhere to be checked against.

## Review findings

Read the implement-stage diff first (the code actually landed in the `ticket(fix)` commit
`80cdfbdb`; `ticket(implement)` `c97bc166` moved the ticket only), then the surrounding module,
the memory module's error sites, and the design doc.

**Major — fixed in this pass (same root site family, so no new ticket):**

- **A second leak site, missed by the handoff.** The handoff asserted the pre-flight was the only
  unguarded spot. It is not: `applyInPlaceOverlayChange` embeds the overlay's own `e.message`
  into the poison message a foreign connection later sees (`buildInPlaceAdoptPoisonMessage`), and
  the memory module's CONSTRAINT/BUSY messages all interpolate their own table name
  (`manager.ts:1756, 3665`, etc.). Reachable in normal use — one connection stages rows, another
  issues DDL those rows violate. Demonstrated by adding the assertion to the existing test
  `poisons a foreign overlay whose staged rows violate a newly created UNIQUE index` and watching
  it fail (message: `Another connection's create index … (UNIQUE constraint failed: _overlay_t_… PK)`),
  then fixed by renaming at the catch entry, which covers the poison message, the issuer BUSY
  rethrow, and the drift error at once. Test now also pins the positive form (`main.t`).

**Minor — fixed in this pass:**

- **The helper reconstructed the error instead of editing it**, which (a) flattened any
  `QuereusError` subclass — `ConstraintError`, `RepresentationError` — to the base class, (b)
  discarded the original stack, and (c) would duplicate the `(at line …, column …)` suffix,
  because the constructor appends it to a message that already carries it. Dormant today (the
  memory module's re-key errors set neither `line` nor `column` and are base-class), but wrong
  the moment an error carrying either passes through. Now rewrites `e.message` in place, which
  is safe: the error is raised by the call the catch wraps and referenced nowhere else.
- **The no-leak assertion was per-test.** Moved into the block's shared `expectAlterError`
  helper, so all five refusal tests in *SET COLLATE on a PRIMARY KEY column judges the
  transaction's effective rows* enforce the invariant, not just the new one. The positive
  assertion (`table ecp_own:`) stays in the specific test.
- **Docs were silent on the rule.** Added, as above.

**Checked, nothing to fix:**

- Every other overlay call site. `createOverlayIndex` / `dropOverlayIndex` route through
  `applyIndexChangeToOverlays` → `applyInPlaceOverlayChange` (now covered); the
  `alter-migration.ts` `alterSchema` forwards are all reached through the same wrapper;
  `buildDropPoisonMessage` and `buildAlterPoisonMessage` compose their text from
  `schemaName`/`tableName` and never quote an overlay error. No third leak site.
- The regression test is load-bearing: temporarily reverting the pre-flight call to `throw e`
  produced exactly one failure (the new test), and restoring it returned 387 passing.
- Marker reinsertion on the refusal path, and the `validateOnly` contract NOTE at the pre-flight
  — both already carry accepted-tradeoff/tripwire `NOTE:` comments at the site; untouched.

**Tripwires recorded:** none. Nothing found here was of the "fine now, only matters if X grows"
shape — both findings were defects reachable as written.

**New tickets filed:** none. Both findings resolved at one code site (`renameOverlayInError` and
its call sites), which is the same site the ticket already owned — filing would have split one
fix across two tickets.

## Verification

- `yarn workspace @quereus/isolation run typecheck` — clean.
- `yarn workspace @quereus/isolation run test` — 387 passing, 0 failing.
- `yarn lint` (all workspaces) — clean.
- `yarn test` (all workspaces) — 9396 + 387 + 147 + 80 + 69 + 80 + 1710 + 725 + 85 + 31 + 34 +
  134 + 22 passing, 25 pending, **0 failing**.

## Known gap

`yarn test:store` (the `packages/quereus` logic suite re-run against the LevelDB store module)
was not run at any stage — it takes several minutes and has no per-file filter. Both fixes are
store-agnostic by construction: the overlay wrapped by `IsolationModule` is always an in-memory
`MemoryTableModule` regardless of what `underlying` points at, and both leaks originate in that
overlay's own error text before the underlying is consulted. A human or CI can confirm
end-to-end out-of-band.

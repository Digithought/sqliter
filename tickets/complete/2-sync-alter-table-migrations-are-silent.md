---
description: Altering a table on one device still never reaches other synced devices, but both the altering device and any receiving device now log a warning about it instead of staying silent.
prereq:
files:
  - packages/quereus-sync/src/sync/sync-manager-impl.ts (recordSchemaMigration, ~line 873 — origin-side warning)
  - packages/quereus-sync/src/sync/store-adapter.ts (applySchemaChange, ~line 543 — receiver-side warning)
  - packages/quereus-sync/test/sync/schema-alter-table-warnings.spec.ts (4 tests)
  - docs/sync.md (§ Schema Synchronization → "What replicates", ~line 1614)
  - tickets/backlog/feat-sync-replicate-alter-table.md (the real fix this defers to)
  - tickets/backlog/debt-sync-test-files-never-typechecked.md (filed by this review)
---

# Complete: ALTER TABLE sync gap is now audible, not silent

Logging only — no wire format or replication behavior changed. Built on
`sync-replicate-drop-and-index-ddl`, which made `alter_column` the only migration
type that can still carry a blank DDL from a current-build peer.

## What shipped

- **Origin** (`recordSchemaMigration`): recording an `alter_column` migration
  with no DDL warns, naming schema + table and stating the alteration will not
  reach other devices. Scoped to `alter_column` deliberately — a generic
  blank-DDL check fires spuriously on `transaction-commit.spec.ts` fixtures whose
  synthetic drop events never set `ddl`.
- **Receiver** (`applySchemaChange`): the pre-existing blank-DDL early return now
  warns first, for **any** migration type — so a blank drop/index migration from
  a peer on an older build is reported too. The origin/receiver asymmetry is
  intentional and now stated at both call sites and in the docs.
- `docs/sync.md` § "What replicates" documents both warnings, the asymmetry, and
  why the underlying gap is design work (`feat-sync-replicate-alter-table`).
- 4 tests in `schema-alter-table-warnings.spec.ts` over real two-peer engines.

## Review findings

Reviewed the implement diff (`5173e334`) cold, then the handoff. Checked:
correctness of the reachability claim behind the `alter_column` scoping, warning
text accuracy, doc accuracy against source, test strength (assertion specificity,
mutation-resistance, coverage of ALTER forms beyond ADD COLUMN), file hygiene,
and cross-package fallout.

**Fixed in this pass (minor):**

- *Comment contradicted itself.* The new receiver comment said "Only
  `alter_column` reaches here with no DDL today", directly contradicting the
  block comment six lines above it (and the handoff's own stated intent) that a
  peer on an older build still sends blank drop/index migrations. Rewritten to
  state the deliberate non-scoping and why.
- *Receiver warning text was wrong for non-alter types.* "the receiving table's
  schema is unchanged" reads false for a blank `drop_table` (nothing was
  dropped). Now "this peer's schema is unchanged". Only source + stale `dist/`
  referenced the old wording.
- *Origin and receiver disagreed on what "no DDL" means.* Origin tested `!ddl`,
  receiver tests `ddl.trim() === ''`, so a whitespace-only DDL would be skipped
  by the receiver while the origin stayed silent. Origin now uses `!ddl?.trim()`.
- *Test 2 could not distinguish the two warnings.* It asserted only that some
  warning contained `main.orders` and `alter_column` — true of the **origin**
  message as well, so the test would still pass if the receiver warning were
  deleted and any origin warning leaked into the capture window. Now keys on the
  receive-side wording and asserts exactly one such line. Test 1 likewise now
  asserts exactly one origin warning rather than "at least one".
- *Coverage stopped at ADD COLUMN.* The ticket's own description names renames
  and constraint changes, and all six store-module alter paths emit the same bare
  `alter`/`table` event — but only `add column` was exercised. Added a test over
  `rename column`, `add constraint` and `drop column`, asserting one warning each.
- *Stray NUL byte in `store-adapter.ts`.* Pre-existing (line 314, a literal NUL
  written inside a comment's backticks rather than the text `\0`), not from this
  diff — but it made `grep`/`ripgrep` classify the whole file as binary and
  report "Binary file matches" instead of line hits, which degraded searching
  during this very review. Replaced with the words "a NUL byte".
- *Docs claim was inaccurate.* `docs/sync.md` said "one `ALTER TABLE` statement
  can decompose into several module-level events". `AlterTableStmt` carries a
  single `action`, so one statement emits one event; the multi-event case is a
  declarative `apply schema`, whose differ emits several separate alterations in
  one transaction. Corrected, and the docs now also record that each altering
  event warns individually.

**Filed as a new ticket (major):**

- `backlog/debt-sync-test-files-never-typechecked.md` — `packages/quereus-sync`
  ships a `tsconfig.test.json` that no script runs, so no gate ever type-checks a
  sync spec (mocha's loader strips types without checking them). Surfaced when an
  editor flagged an implicit `any` in the new spec that every green command had
  missed. Running the config by hand is clean today, so wiring it is a green
  change; eight other packages have the identical gap, hence a ticket rather than
  a drive-by edit to a package.json this ticket had no business touching.

**Recorded as tripwires, not tickets:**

- Blank-DDL migrations return *before* the "already applied" convergence check,
  so a peer re-bootstrapping from zero re-warns for every blank migration it
  replays. Harmless while alterations are rare. `NOTE:` at the early return in
  `store-adapter.ts`.
- One warning per altering event means a multi-alteration `apply schema` emits
  several lines for the same table, unlike `logSkippedTables` in the same file,
  which collapses to one line per table. Left as-is on purpose — each event is a
  genuinely distinct lost alteration, so per-event is the informative shape.
  Stated in `docs/sync.md`.

**Checked and found clean (no action):**

- *Reachability of the origin scoping.* All six `alter` emit sites in
  `packages/quereus-store/src/common/store-module.ts` omit `ddl`, and the
  store module's event type is `'table' | 'index'` only — it never emits the
  `objectType: 'column'` events that `mapSchemaMigrationType` ignores. So every
  store-backed ALTER form does reach the warning; none slips through untracked.
- *Memory-module tables* emit `objectType: 'column'` for alters and so record no
  migration and no warning — but there is no end-to-end sync path for
  memory-backed tables, which `docs/sync.md` already states. Not a defect.
- *No retry amplification.* `handleTransactionCommit` has no retry loop, so a
  warning cannot double from a replayed commit.
- *Cleanup / error handling.* The warnings are pure side effects on paths that
  already existed; the new spec restores `console.warn` in a `finally` and closes
  its peers in a `finally`. No resource or exception-safety gap.

**Known, deliberately not addressed:**

- The console-capture helper is now duplicated across three sync specs
  (`schema-alter-table-warnings`, `transaction-commit`, `sync-manager`). Not
  hoisted: the natural home, `_peer-harness.ts`, drags `Database`/`StoreModule`
  imports into `transaction-commit.spec.ts`, which deliberately uses a fake
  transaction source and no engine.
- Warning wording is still asserted loosely (substring checks, not exact
  strings). Intentional — minor rewording should not require a test edit.

## Validation

- `yarn workspace @quereus/sync run test` — 583 passing, 0 failing (582 before,
  +1 from the new ALTER-forms test).
- `yarn build`, `yarn typecheck`, `yarn lint` from the repo root — all clean.
- `yarn test` from the repo root — all workspaces passing (7390 + 1081 + 583 +
  312 + 134 + 109 + 61 + 52 + 34 + 31 + 28 + 22 + 17), 0 failing.
- `npx tsc -p tsconfig.test.json --noEmit` in `packages/quereus-sync` — clean
  (run by hand; see the debt ticket above for why nothing runs it in CI).

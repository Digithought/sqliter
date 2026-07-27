---
description: Altering a table on one device — adding a column, renaming it, changing a constraint — still never reaches other synced devices, but now both the altering device and any receiving device log a warning about it instead of staying silent.
prereq:
files:
  - packages/quereus-sync/src/sync/sync-manager-impl.ts (recordSchemaMigration, ~line 855 — origin-side warning)
  - packages/quereus-sync/src/sync/store-adapter.ts (applySchemaChange, ~line 528 — receiver-side warning)
  - packages/quereus-sync/test/sync/schema-alter-table-warnings.spec.ts (new — end-to-end coverage)
  - packages/quereus-sync/test/sync/transaction-commit.spec.ts (pre-existing; see gap below)
  - docs/sync.md (§ Schema Synchronization → "What replicates", ~line 1614)
  - tickets/backlog/feat-sync-replicate-alter-table.md (the real fix this still defers to)
---

# Review: ALTER TABLE sync gap is now audible, not silent

Implemented from `implement/sync-alter-table-migrations-are-silent`. No wire format or
replication behavior changed — this is logging only, on top of
`sync-replicate-drop-and-index-ddl` (already landed), which made `alter_column` the
only migration type that can still carry a blank DDL.

## What changed

- **Origin** (`recordSchemaMigration`): when the mapped migration type is
  `alter_column` AND its event carries no `ddl`, warns naming the schema and table
  and stating plainly the alteration will not reach other devices. The migration is
  still recorded (unconditionally) and the schema version still advances — no
  behavioral change, logging only.
- **Receiver** (`applySchemaChange`): the existing blank-DDL early return is
  unchanged in behavior; a `console.warn` was added immediately before it, naming
  the migration `type`, `schema` and `table`. This one is **not** scoped to
  `alter_column` — it fires for ANY blank-DDL migration, which also covers an
  older peer that still sends blank drop/index migrations (a pre-existing,
  already-tested branch). That's deliberate: an operator watching a receiver
  should hear about a schema change that arrived and did nothing, regardless of
  which migration type produced it.
- `docs/sync.md` § "What replicates" (the section that already documented the gap
  from the prerequisite ticket) now also documents both warnings and why the gap
  itself is real design work, not a quick fix — pointing at
  `feat-sync-replicate-alter-table`.

## A scoping decision worth a reviewer's eye

The ticket described the origin-side warning generically ("when a schema-change
event maps to a tracked migration but carries no DDL, warn"). The first pass did
exactly that — `if (!ddl)` regardless of migration type — and it broke an
existing unit test: `transaction-commit.spec.ts` ("a table dropped by the same
transaction skips informationally, not as a warning", line ~280) drives
`recordSchemaMigration` through a `FakeTransactionSource` with a synthetic
`{ type: 'drop', objectType: 'table', ... }` schema event that has no `ddl` field
set at all — it's testing opSeq/HLC bookkeeping, not DDL, so the fixture never
bothered to set one. A generic blank-DDL check fired a spurious warning there.

Fixed by scoping the origin-side check to `migrationType === 'alter_column'`
specifically — which is exactly what the ticket itself says is the only type that
can legitimately reach here post-prerequisite. This is narrower than the ticket's
literal wording but matches its stated reasoning; flagging in case the reviewer
reads it differently. The receiver-side warning was **not** narrowed the same
way (see above) — that asymmetry between origin and receiver is intentional, not
an oversight.

## How to validate

- `packages/quereus-sync/test/sync/schema-alter-table-warnings.spec.ts` (new, 3
  tests, real two-peer engines via the existing `_peer-harness.ts`):
  - origin warns on `alter table orders add column qty integer` and the local
    schema version advances by exactly 1;
  - relaying that migration to a peer warns there too, produces no error, still
    advances the receiver's schema version by 1, and the receiver's `orders`
    table genuinely does NOT gain the `qty` column (the blank-DDL migration ran
    nothing);
  - a full `create_table` → `add_index` → `drop_index` → `drop_table` round trip
    between two peers (all real DDL) produces **zero** warnings on either end —
    this is what keeps the new warning from decaying into background noise as
    other migration types evolve.
- `yarn workspace @quereus/sync run test` — 582 passing, 0 failing (was 581
  passing / 1 failing before the scoping fix above).
- Full `yarn build`, `yarn typecheck`, `yarn lint`, `yarn test` from the repo root
  — all clean (build: all packages + 3 bundled apps; typecheck: clean; lint: no
  errors across every workspace; test: 1081 + 582 + 52 + 31 + 10 + 68 + 34 + 134 +
  22 passing across the fanned-out workspaces, 0 failing).

## Known gaps

- No adapter-level (synthetic `SchemaChangeToApply`) test was added in
  `schema-replication-idempotency.spec.ts` specifically asserting the receiver
  warning's text — coverage is end-to-end only, via real peers. The ticket's own
  TODO asked for the real-peer flow, so this was treated as sufficient, but a
  synthetic unit test would pin the receiver-side message more cheaply than the
  full two-peer round trip does.
- Warning message wording is not tested for exact string match anywhere except a
  couple of `includes()` checks (table/schema name, "alter_column", "not reach
  other synced devices") — intentionally loose so minor wording edits don't need
  a test update, but it also means the wording itself got no independent review.
- `console.warn` is used per repo convention (`@quereus/sync` has no logger
  abstraction); if that ever changes, both new call sites need to move together.

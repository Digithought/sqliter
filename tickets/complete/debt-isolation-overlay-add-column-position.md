---
description: Added tests proving that "add a column at a chosen position" already behaves correctly when it goes through the transaction-isolation layer, so a future edit cannot quietly break it.
files:
  - packages/quereus-isolation/test/isolation-layer.spec.ts   # describe block "ADD COLUMN at a caller-chosen position (isolation layer)", ~2959-3260
  - packages/quereus-isolation/src/alter-migration.ts         # buildOverlayAddColumnChange (~708) — behavior under test; untouched
  - packages/quereus-isolation/README.md                      # one bullet in the ALTER section (~145)
difficulty: easy
---

# Pin the caller-chosen ADD COLUMN position through the isolation layer — complete

## What shipped

Test-only, as scoped. No product code changed anywhere: the implement diff and this review pass
together touch exactly `packages/quereus-isolation/test/isolation-layer.spec.ts` and one README
bullet. `packages/quereus-isolation/src/` is byte-identical to before the ticket.

There is no SQL syntax for choosing an ADD COLUMN position — only an in-process module wrapper can
set `SchemaChangeInfo.insertAtIndex`. So the tests stand up a `PositionedIsolationModule` (subclass of
`IsolationModule` overriding `alterTable` to inject the index), mirroring `PositionedMemoryModule` in
`packages/quereus/test/alter-column-open-transaction-layer.spec.ts`.

12 tests total in the new block (9 from implement, 3 added in review), covering:

- position 0 with a committed and a staged row, read in-transaction and post-commit
- writes (UPDATE / INSERT / DELETE) issued after the reshape, targeting the new column by name
- a staged DELETE surviving a positioned ALTER
- a multi-column primary key and a secondary index both renumbered by an insert ahead of them
- `insertAt` equal to the base's own column count (indistinguishable from a plain append)
- no position supplied → still appends (proves the harness can't mask the default arm)
- out-of-range position (99) rejected with `Cannot add column 'w' at position 99: expected an integer
  in [0, 2]`, catalog and rows untouched, transaction still commits afterward
- a positioned ALTER surviving `rollback to savepoint`
- a cross-connection foreign overlay (one live staged row, one deletion marker) migrated at the named
  slot rather than poisoned
- **(review)** an expression `DEFAULT (new.v * 2)` at position 0 — the evaluator arm, where
  `computeAddColumnValue` strips the tombstone flag off an *old-layout* row while `insertAtIndex`
  describes the *new* layout
- **(review)** a `NOT NULL` expression default at position 0 with a staged deletion marker present —
  the marker must still short-circuit to NULL rather than be evaluated or rejected
- **(review)** three successive ALTERs in one transaction (position 0, then 2, then none) — the
  overlay's tombstone slot is re-derived per ALTER, so the second and third see the *reshaped*
  overlay, not the connect-time schema snapshot

Every assertion reads back by column name, never by row index — a value landing under the wrong
column name is the failure mode being pinned.

## Review findings

**Read first:** the implement diff (`git show f2dbdfed`) before the handoff summary, then
`buildOverlayAddColumnChange` and its call path in `src/alter-migration.ts`,
`MemoryTable.alterSchema` / `MemoryTableManager.addColumn` (where the position is applied and the
range is validated), the store's `insertAtIndex` refusal, and the sibling engine-level positioned
block in `packages/quereus/test/alter-column-open-transaction-layer.spec.ts`.

**Coverage gaps — found 3, all fixed inline (minor).** The implement block covered only the folded
*literal* default arm, only one ALTER per transaction, and never combined a position with a staged
deletion marker under a NOT NULL column. Those are exactly the three places where the two indices in
play (`insertAtIndex`, describing the new layout, and the tombstone index, describing the old one)
could plausibly be confused for each other. All three new tests passed on first run — the code is
correct; the tests now say so. Isolation suite 364 → 367.

**Correctness — nothing found.** `insertAtIndex: change.insertAtIndex ?? tombstoneIdx` is sound
because the overlay's data columns mirror the base's one-for-one below the flag, so a base index in
`[0, n]` is the same index in the overlay, and `n` coincides with the tombstone index. The
out-of-range refusal comes from the underlying (`MemoryTableManager`), which runs before any overlay
is reshaped, so a bad position leaves the transaction intact — the implement test pins that, and the
commit-after-refusal assertion is the part that would catch a half-migrated overlay.

**Handoff accuracy — two miscounts, corrected here.** The implement handoff claimed 11 new tests and
"364 passing, up from 353". The diff adds 9 `it`s (`git show f2dbdfed | grep -c '^+\t\tit('`), and the
package went 355 → 364. No effect on the code; noted so the numbers above are trustworthy.

**Docs — checked, accurate.** The one new README bullet matches `buildOverlayAddColumnChange`'s actual
behavior (caller-named position honored for the issuer's overlay and every migrated foreign one;
default appends ahead of the deletion-marker column). `node scripts/check-docs.mjs` is clean. No other
doc in the repo describes overlay ADD COLUMN positioning, so nothing else was stale.

**Deliberately not re-litigated.** The implement stage skipped an in-package stub module for "the
underlying refuses a non-append position" — the plan ticket said to, and
`packages/quereus-store/test/alter-table.spec.ts:105` already pins that refusal against the real store
module. Agreed; not worth a second fake module here.

**Major findings — one filed.** `tickets/backlog/debt-split-isolation-layer-spec.md`:
`isolation-layer.spec.ts` is 6860 lines (`wc -l`) under a single `describe`, roughly ten times every
sibling spec in the folder; near-duplicate local test modules already exist in it because authors
didn't find the earlier one. Pure test-file hygiene, no defect, so backlog rather than fix.

**Tripwires — none.** Nothing in this diff is "fine now, breaks if X later": the tests carry no
conditional assumption about scale or future features, and the one standing performance caveat in
this area (`validateOverlayMigration` full-scans staged rows) is already a `NOTE:` at its own site
from earlier work, not something this ticket introduced.

## Validation

- `yarn workspace @quereus/isolation test` — 367 passing.
- `yarn workspace @quereus/isolation run typecheck` — clean.
- `yarn test` (full workspace) — green: `@quereus/quereus` 8277, `@quereus/isolation` 367, all other
  packages passing, 0 failures.
- `yarn lint` — clean (only `packages/quereus` has a real lint; every other package is the intentional
  no-op, per AGENTS.md).
- `node scripts/check-docs.mjs` — "Docs OK".

---
description: A sync batch that both renamed a table and carried rows for it could jam a device into an endless retry, or bring back a row the device had deleted. Both are fixed, with regression tests, and the review found and fixed a third shape the fix had broken.
files:
  - packages/quereus-sync/src/sync/change-applicator.ts               # computeBatchTableFates + its three read sites
  - packages/quereus-sync/src/sync/store-adapter.ts                   # decideRenameTable — the catalog verdict the simulation mirrors; UNCHANGED
  - packages/quereus-sync/test/sync/drop-recreate-batch.spec.ts       # 3 cases added across fix/implement/review
  - packages/quereus-sync/test/sync/schema-alter-replication.spec.ts  # `rename to, carrying rows for the new name` describe (3 cases)
  - docs/sync-schema.md                                               # `RENAME TO` section
  - docs/migration.md                                                 # unknown-table disposition + revival/drain bullets
difficulty: medium
---

# What shipped

`computeBatchTableFates` in `change-applicator.ts` decides, before any of a batch's DDL
runs, what each table name the batch mentions will look like afterwards. Three sites read
that verdict: whether an incoming row's table is known (or takes the unknown-table
disposition), whether its rows may resolve **read-free** (skipping local cell versions and
tombstones), and whether the post-commit held-change drain should fire for a name.

The verdict used to be derived structurally, from the batch's schema steps in isolation:
each `create_table` / `drop_table` / `rename_table` contributed an existence step at its own
timestamp and the last one won. That disagreed with `decideRenameTable`, which decides the
same rename against the receiver's actual catalog. Two user-visible failures followed, both
verified before the fix and both now covered:

- **Endless retry.** A rename the receiver DECLINES (it dropped the old table locally, or
  the migration omits the old name) leaves the new name non-existent, but the structural
  verdict routed the batch's rows there anyway. The store adapter threw `Table not found for
  external write`, the batch aborted with its watermark unadvanced, and the identical batch
  re-threw on every later sync — every subsequent change from that peer stuck behind it.
- **Resurrected row.** A name renamed away and back in one batch was judged a brand-new
  empty table, so its rows resolved read-free past the receiver's own tombstone and a
  deleted row came back under the default `allowResurrection: false`.

The fix replaced the structural derivation with a **simulation**: seed each mentioned name
with whether the receiver has it right now, then replay only the migrations Phase 1a kept,
in HLC order, applying the same decision each kind's `decideSchemaChange` arm will reach
against the catalog. Seeding is what makes the two verdicts agree; replaying only the kept
migrations is what keeps a re-delivered (HLC-dominated) migration from resurrecting a state
the receiver has already moved past.

The review pass then found the fix had over-narrowed the read-free rule (see below) and
replaced its `recreated` boolean with table-identity tracking: each fate records
`historyName`, the name the surviving table's sync bookkeeping (`cv:`/`tb:`/`cl:`) is filed
under. The bookkeeping is name-keyed and nothing re-files it on a rename, so a name whose
`historyName` is not its own key holds records describing a table that is no longer there —
exactly the read-free condition. That distinguishes the two ways a name is vacated and
refilled: a `drop_table` destroys its occupant (whatever arrives next is a stranger to the
records left behind), while a rename AWAY and then BACK returns the very table they
describe.

Docs: `docs/sync-schema.md` § `RENAME TO` and `docs/migration.md` (the unknown-table
disposition bullet and the revival/drain bullet) all describe the simulation and the
identity rule.

# Review findings

## Checked

- Read the fix-stage (`230687ac`) and implement-stage (`53ba9a57`) diffs before the
  handoffs, then re-derived `computeBatchTableFates` against `decideSchemaChange` /
  `decideRenameTable` case by case: `create_table` (present ⇒ already-applied; absent ⇒
  execute), `drop_table`, and all five `rename_table` rows including the both-present
  collision that throws and aborts the batch. Every arm agrees with the catalog decision.
- Traced the three read sites, the relay-only (no basis oracle) configuration, chained
  renames, rename-then-drop, drop-then-create, and re-delivered batches.
- `yarn workspace @quereus/sync run typecheck` — clean. `yarn lint` — clean (only
  `packages/quereus` has a real lint; the rest are the intentional no-ops).
- `yarn workspace @quereus/sync run test` — **725 passing, 0 failing**.
- `yarn test` (whole workspace) — all green, no failures.
- `yarn docs:check` — `docs/schema.md` and `docs/sync.md` are over their word ratchets.
  Pre-existing and untouched by this ticket; already tracked as the
  `debt-docs-size-ratchet-red-again` ticket, which a human has since promoted to `plan/`.

## Found and fixed in this pass

- **Major, fixed: the fix stage broke the table-swap shape.** Narrowing the read-free
  verdict to "an applied `create_table` made this name go absent → present" excluded the
  case where a name is vacated by a `drop_table` and refilled by renaming a DIFFERENT table
  into it — the ordinary swap migration (build the replacement under a scratch name, drop
  the old table, rename the replacement into place). The batch's rows for that name then
  resolved against the dropped table's stranded tombstones and were silently discarded.
  Reproduced first (`a table swapped INTO a vacated name is fresh: the vacated name's
  tombstone does not block it` in `drop-recreate-batch.spec.ts` — it failed on the
  as-shipped code with the row missing), then fixed by the `historyName` identity tracking
  described above. The deliberate contrast case, `a name renamed AWAY and BACK in one batch
  is not fresh`, still passes: identity distinguishes the two, a presence boolean cannot.
  Note the pre-fix code happened to get the swap right for the wrong reason, so this was a
  regression the fix stage introduced, not a pre-existing gap.
- **Minor, fixed: one handoff gap closed.** The implement stage listed "a declined
  rename's rows under the OLD name are not exercised — believed uninteresting, unverified".
  It is not uninteresting: an undecidable rename (no old name) records NO fate entry at all,
  so the row-admission gate falls back to the basis read — a path with no data-row coverage.
  Added `an undecidable rename still admits the same batch's rows for the OLD name`
  (`schema-alter-replication.spec.ts`): rows for the surviving old name land while only the
  rows for the name the rename failed to create are diverted.
- **Minor, fixed: stale docs the earlier stages missed.** `docs/migration.md` still
  described the removed max-HLC existence-step algorithm in two bullets and pointed readers
  at the (now closed) fix ticket for a defect that no longer exists. Rewritten to the
  simulation + identity rule. `docs/sync-schema.md`'s "Renamed-in tables keep their history"
  bullet asserted the over-narrow rule and was rewritten with it. Three comments in
  `drop-recreate-batch.spec.ts` carried the same stale claims; corrected.

## Recorded as tripwires, not tickets

- The simulation seeds from the `getTableSchema` basis oracle while Phase 2 decides the DDL
  against `db.schemaManager` directly. The shipped wiring makes those the same answer; a
  host that deliberately narrows its oracle would make them diverge (rows held instead of
  applied, recovered by the next drain sweep). Parked as a `NOTE:` at the seed site in
  `computeBatchTableFates`.

## Carried forward from earlier stages, still accurate

- The `NOTE:` at the `freshLocalTable` site records the one imperfection this work leaves:
  a table arriving under a name the receiver does not currently hold still resolves
  read-free, because an out-of-basis name has no schema and so no resolvable primary-key
  keying. Tracked as `bug-sync-recreated-table-inherits-dropped-table-metadata`.
- Renaming a table stranding its per-row history at the old name is unchanged and out of
  scope — `bug-sync-rename-and-pk-change-strand-crdt-metadata`, which already carries the
  arm about pre-rename rows being diverted to quarantine.

## Deliberately not covered, with reasons

- **Non-default unknown-table dispositions.** All wedge cases run under `quarantine`;
  nothing pins `ignore` or `store-and-forward` for a declined rename's rows. The disposition
  branch is shared with the drop/re-create cases, which do cover `ignore`, so the marginal
  value is low — the fate verdict, not the disposition, is what this ticket changed.
- **`allowResurrection: true`.** The `true` branch of `isDeletedAndBlocking` compares HLCs,
  and the harness enforces no ordering between the origin's update and the receiver's
  delete, so the case would be timing-dependent. Left out rather than written flaky.
- **A rename collision carrying rows.** Both names present locally still throws and retries
  forever — deliberately, as a divergence alarm — and the DDL-only case already covers it.
  Adding rows asserts nothing new about the fate verdict.
- **No performance measurement.** The simulation replays the kept migrations once per apply
  where the old code made one pass over all of them; the difference was not measured and no
  claim is made about it.

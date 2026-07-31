description: A device that drops a table and immediately creates a new one with the same name now sends that pair of steps to other devices without the new table's rows going missing — previously the rows were filed away as "belonging to a table I don't have" and showed up late, or never.
files:
  - packages/quereus-sync/src/sync/change-applicator.ts               # computeBatchTableFates (~81-144) + the three read sites (~264, ~289, ~409)
  - packages/quereus-sync/test/sync/drop-recreate-batch.spec.ts       # new spec, 6 cases
  - packages/quereus-sync/test/sync/schema-ddl-replication.spec.ts    # ~112 — comment renamed to the new function
  - docs/migration.md                                                 # § 4, the unknown-table bullet + the reactive-drain parenthetical
  - tickets/backlog/bug-sync-recreated-table-inherits-dropped-table-metadata.md  # appended arm (see Known gaps)
repro: verified
----

## What changed

`applyChanges` used to reduce a batch's schema migrations to two order-blind sets —
`created` and `dropped` — and call a table absent when it appeared in both:

```ts
const known = (inBasis || batchCreated.has(key)) && !batchDropped.has(key);
```

A `create → drop → create` batch put the table in both sets, so every row for it was
diverted as unknown-table, even though the same batch's schema steps replayed in
timestamp order leave the table present and empty. Under the default
`unknownTableDisposition: 'quarantine'` those rows were held and only surfaced on the
next periodic maintenance sweep (a convergence delay); under `'ignore'` they were
dropped permanently.

The two sets are replaced by one per-table verdict derived from the schema steps' HLCs:

```ts
interface BatchTableFate {
	present: boolean;    // the table's LAST create/drop step (by HLC) is a create_table
	recreated: boolean;  // present, AND some drop_table has a strictly lower HLC
}
function computeBatchTableFates(changes: ChangeSet[]): Map<string, BatchTableFate>;
```

Only `create_table` / `drop_table` participate (there is no rename in
`SchemaMigrationType`); tables the batch's DDL never touches are absent from the map and
fall back to the basis read. Three sites read it:

| site | before | after |
| --- | --- | --- |
| row-admission gate (~264) | `(inBasis \|\| created) && !dropped` | `fate ? fate.present : inBasis` |
| `freshLocalTable` (~289) | `!inBasis` | `!inBasis \|\| (fate?.recreated ?? false)` |
| reactive drain skip (~409) | `if (batchDropped.has(key)) continue` | `if (fate && !fate.present) continue` |

The `freshLocalTable` arm is load-bearing, not scope creep: dropping a table does **not**
purge its sync metadata, so without it the re-created table's rows resolve against the
dropped incarnation's cell versions and deletion markers, and a stale marker silently
discards them under the default `allowResurrection: false`. Marking the table fresh makes
those rows resolve read-free, exactly as rows for a table this batch creates already do.

Tie-breaking: `keepLatestStep` keeps the **later-arriving** migration when two HLCs
compare equal, matching `orderMigrationsByHLC`'s stable sort (so the verdict agrees with
what the DDL replay actually does). That differs from the neighbouring `keepMaxHLC`,
which keeps the first of a tie because it collapses repeats of one fact — the divergence
is called out in the JSDoc so a future reader doesn't "unify" them.

## How to exercise it

`packages/quereus-sync/test/sync/drop-recreate-batch.spec.ts` — 6 cases on real
`Database` peers via `_peer-harness.ts`, so each asserts what `select` returns rather
than what the metadata believes:

- **quarantine default** — origin does `create widgets` → `drop` → `create` → `insert
  pk 2`; the receiver's single `applyChanges` reports no `unknownTable` and
  `select id, w from widgets` returns the row with no drain. A follow-up
  `drainHeldChanges` returns 0, proving nothing was held.
- **`disposition: 'ignore'`** — the same batch; the row still lands. This is the case
  that used to lose data permanently.
- **reversed batch** — same batch handed to `applyChanges` in reverse, guarded by an
  `expectNotHLCOrdered` premise check; commits the same state as the in-order receiver.
- **trailing `drop_table`** — `create` → `insert` → `drop` in one batch still hides the
  table: rows diverted, `unknownTable > 0`, table absent, held count matches.
- **reactive drain** — receiver quarantines a row for `widgets` from an earlier batch,
  then a later batch that drops + re-creates `widgets` drains it with no explicit
  `drainHeldChanges` call (`drainOnReappear` defaults true).
- **stale deletion marker** — receiver already HAS the table and holds its own local
  tombstone for pk 1; a drop + re-create batch's `insert pk 1` still lands under the
  default `allowResurrection: false`. This is the only case that covers the
  `freshLocalTable` arm.

**Non-vacuity checked by hand:** reverting `freshLocalTable` to `!inBasis` and re-running
makes the stale-deletion-marker case fail (`expected [] to deeply equal [{ id: 1, w:
'reborn' }]`). The other five fail on the `known` gate pre-fix by construction. I did
**not** re-run each of the five against a reverted gate individually — a reviewer wanting
that assurance should stash the gate change and run the file.

Sibling coverage that already pinned the old behaviour and still passes:
`unknown-table-disposition.spec.ts` § "detection edges" (in-batch create, in-batch drop)
and § "reactive drain" ("create + drop of the same table in one batch is a no-op drain"),
plus `schema-ddl-replication.spec.ts`'s dropped-table divert case.

## Validation run

- `yarn workspace @quereus/sync run test` — **607 passing, 0 failing** (was 606 before;
  +6 new, and the count reconciles because the pre-existing suite is unchanged).
- `yarn build` — exit 0.
- `yarn workspace @quereus/sync run typecheck` — exit 0.
- `yarn test` (whole workspace) — exit 0.

No pre-existing failures encountered, so no `.pre-existing-error.md` was written.

## Known gaps — please poke at these

**1. A second blocker survives, and I did not fix it.** Writing the stale-deletion-marker
case surfaced a *different* path to the same user-visible symptom, which the fix in this
ticket does not address: when the OLD incarnation's delete and the NEW incarnation's write
arrive in the **same** batch, `reconcileInBatchDeletes` blocks the write under the default
`allowResurrection: false`, because that rule has no notion of which incarnation a fact
belongs to. Verified:

```
migrations: create_table@…641, drop_table@…835, create_table@…876
changes:    delete:[1]@…729, column:[1]@…908, column:[1]@…908
result:     { applied: 3, skipped: 3 }   ← both post-re-create columns skipped
```

This is reachable on a first (from-zero) delta sync, not just in a contrived test. I did
not fix it here because it needs a policy decision that is already filed and explicitly
deferred to a human: **which incarnation does a pre-drop fact belong to.** I appended it as
a second arm (with the repro above) to
`tickets/backlog/bug-sync-recreated-table-inherits-dropped-table-metadata`, which owns
exactly that question — its "Questions to settle" third bullet is the same rule applied
to stored markers. Two sites, one decision, so one ticket.

Consequence for this ticket's spec: the stale-deletion-marker case has to seed the marker
via a **local** delete on the receiver, so the drop/re-create batch carries no delete of
its own. That is a real scenario, but it is a narrower one than "origin deleted the row
before dropping the table" — which is the shape a reviewer would reach for first, and
which still fails. The spec says so in a comment; check that the comment is honest enough.

**2. Tie-breaking is unreachable today, so it is untested.** `keepLatestStep`'s `>= 0`
only matters if a `create_table` and a `drop_table` for one table carry byte-identical
HLCs. An HLC is unique per fact (wallTime, counter, siteId, opSeq), so I could not
construct that on real peers and wrote no spec for it. The reasoning is in the JSDoc. If
you think it warrants a synthetic-changeset spec, `unknown-table-disposition.spec.ts`'s
`createTable` / `dropTable` builders take an explicit wall time and `opSeq` and could
forge one.

**3. The verdict is computed over migrations Phase 1a later skips.** A `create_table` the
receiver already has is HLC-dominated and never applied, but it still counts toward
`present` / `recreated`. That matches the previous behaviour (the sets were built the same
way) and is argued correct in the JSDoc — a skipped migration means the receiver already
reached that state. The consequence worth a second opinion: a batch carrying a
**redundant** drop + create for a table the receiver already re-created will set
`recreated`, so that batch's rows resolve read-free (no stored-metadata reads) even though
the local table is not actually fresh. That direction is safe for the tombstone problem
but means a genuine LWW comparison is skipped for those rows — worth deciding whether it
should be.

**4. Store data survives a `drop table`.** Noticed while writing the specs, not caused by
this change and not filed: on a real peer, `drop table widgets` followed by
`create table widgets` leaves the previous rows in the store, so re-inserting a pk that
existed before the drop raises `UNIQUE constraint failed: widgets PK`. That is why the
stale-deletion-marker spec uses pk 2 for the pre-drop row and pk 1 for the post-re-create
one. It may be intended (storage reclaim is an explicit `reclaimDetachedTable` call, per
`docs/migration.md` § 4), or it may be its own bug — I did not chase it and it is outside
this ticket's diff.

## Docs

`docs/migration.md` § 4, two edits — the unknown-table detection bullet now states the
timestamp-ordered rule (last create/drop step decides; drop-then-create leaves the table
known and its rows resolve read-free) instead of "a `drop_table` makes a present table
unknown", and the reactive-drain parenthetical no longer says "a create+drop in one batch
leaves the table absent" flatly. Worth checking both read correctly for someone who has
not seen this diff.

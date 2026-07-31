description: When one device drops a table and then creates a new table with the same name, another device receiving both those steps together also receives the new table's rows — but files them away as "belonging to a table I don't have" instead of inserting them, so the rows show up late or, on one setting, never.
files:
  - packages/quereus-sync/src/sync/change-applicator.ts               # computeBatchTableDelta (~88), the `known` gate + freshLocalTable (~237-255), the reactive-drain skip (~357-363)
  - packages/quereus-sync/test/sync/apply-order-independence.spec.ts  # sibling specs; the `reversed schema migrations` case is the nearest shape
  - packages/quereus-sync/test/sync/unknown-table-disposition.spec.ts # where quarantine/ignore/unknownTable assertions live today
  - packages/quereus-sync/test/sync/_peer-harness.ts                  # makePeer / localWrite / collect — the repro below uses these verbatim
  - docs/migration.md                                                 # § 4 line 110: "a create+drop in one batch leaves the table absent, so the drain is a no-op"
difficulty: medium
repro: verified
----

## What is wrong

Before applying an incoming batch, `applyChanges` works out which tables that batch
creates and which it drops, so it can tell a row for a table the receiver genuinely
does not have (set it aside) from a row for a table the same batch is about to create
(apply it).

`computeBatchTableDelta` does that with two plain sets — every `create_table` goes in
`created`, every `drop_table` in `dropped` — and the gate reads

```ts
const known = (inBasis || batchCreated.has(key)) && !batchDropped.has(key);
```

The sets throw away *when* each step happened. A batch carrying `create widgets` →
`drop widgets` → `create widgets` puts `widgets` in both sets, so every row for
`widgets` is treated as belonging to an absent table — even though the same batch's
schema steps, replayed in timestamp order (`orderMigrationsByHLC`, already correct),
leave `widgets` present and empty, ready for exactly those rows.

The same set is read a second time at the reactive post-apply drain (~line 361):
`if (batchDropped.has(key)) continue;` skips replaying anything previously held for a
table this batch created, on the same "the batch left it absent" reasoning.

With the default `unknownTableDisposition: 'quarantine'` the rows are held and picked
up by the next periodic maintenance sweep — a convergence *delay*. With `'ignore'`
nothing is held and the rows are lost permanently.

## Verified reproduction

Ran on real peers via `_peer-harness.ts` (scratch spec, since deleted):

```ts
const origin = await makePeer('origin');
const receiver = await makePeer('receiver', { disposition: 'quarantine' });

await localWrite(origin, 'create table widgets (id integer primary key, w text) using store');
await localWrite(origin, 'drop table widgets');
await localWrite(origin, 'create table widgets (id integer primary key, w text) using store');
await localWrite(origin, "insert into widgets (id, w) values (2, 'new')");

const sets = await origin.manager.getChangesSince(receiver.manager.getSiteId());
await receiver.manager.applyChanges(sets);
```

Observed: `{ applied: 3, skipped: 0, conflicts: 0, transactions: 4, unknownTable: 2 }`;
`widgets` **exists** on the receiver (the three schema steps replayed correctly) but is
**empty**. A following `drainHeldChanges()` returns 2 and the row appears — confirming
both halves: the row-admission gate diverted the rows, and the reactive drain skipped
the table.

Expected: the row lands inside that same `applyChanges`, and `unknownTable` is absent.

## The fix

Replace the two order-blind sets with one per-table verdict derived from the schema
steps' timestamps, and read it at both sites. Only `create_table` and `drop_table`
change whether a table exists (`SchemaMigrationType` in `protocol.ts` has no rename),
so only those two participate; the other kinds keep being ignored here.

```ts
interface BatchTableFate {
	/** Table exists after this batch's schema steps replay in timestamp order. */
	present: boolean;
	/** A drop_table precedes the trailing create_table — the post-batch table is a NEW, empty incarnation. */
	recreated: boolean;
}

/** Per-table fate keyed by `schema.table`; tables with no create/drop step in the batch are absent from the map. */
function computeBatchTableFates(changes: ChangeSet[]): Map<string, BatchTableFate>;
```

Per table: take the max-HLC step among its `create_table` / `drop_table` migrations
(`compareHLC`, same total order the DDL replay uses). `present` = that step is a
`create_table`. `recreated` = `present` AND some `drop_table` for the table has a
strictly lower HLC.

Compute it over the WHOLE batch, exactly where `computeBatchTableDelta` is called today
(before Phase 1a) — including migrations Phase 1a later skips as HLC-dominated, which is
also current behaviour: a skipped migration means the receiver already reached that
state, so the verdict is unchanged.

**Site 1 — the row-admission gate (~239):**

```ts
const fate = batchFates.get(key);
const known = fate ? fate.present : inBasis;
```

**Site 2 — `freshLocalTable` (~255).** Today `freshLocalTable = !inBasis`. A batch that
re-creates a table the receiver *already has* would otherwise resolve the new
incarnation's rows against the dropped incarnation's cell versions and tombstones
(dropping a table does not purge its sync metadata — verified: after a `drop_table` and
a same-name re-create, `columnVersions.getRowVersions` still returns the old
incarnation's cells). Post-batch that table is a new, empty incarnation, so:

```ts
const freshLocalTable = !inBasis || (fate?.recreated ?? false);
```

This arm is *why the fix is safe*, not scope creep: without it, admitting these rows
routes them through a stale tombstone that can silently discard them under the default
`allowResurrection: false`. The broader "a re-created table inherits the dropped table's
bookkeeping" question — purge policy, relays, retention horizon — is already filed as
`bug-sync-recreated-table-inherits-dropped-table-metadata` (backlog) and stays there;
this ticket only stops the *in-batch* recreate from consulting that stale metadata.

**Site 3 — the reactive drain skip (~361):** skip a table only when the batch leaves it
absent — `if (fate && !fate.present) continue;`.

Note `applyChanges` uses `batchDropped` nowhere else, and `orderMigrationsByHLC` /
`orderDataChangesByHLC` are already correct — nothing else in the file changes.

## Context

Same class as `bug-sync-apply-order-splits-data-from-metadata` (complete), which made
the schema-step list itself replay in timestamp order. That fixed *how the steps are
replayed*; this fixes *what the receiver concludes from them*. Same file, separate code
sites.

## TODO

- [ ] Replace `computeBatchTableDelta` with `computeBatchTableFates` in
      `packages/quereus-sync/src/sync/change-applicator.ts`, per the shape above; update
      its JSDoc (it currently states the set semantics as the rule) and the
      `applyChanges` header comment where it describes unknown-table detection.
- [ ] Read the fate map at all three sites: the `known` gate, `freshLocalTable`, and the
      reactive-drain skip.
- [ ] New spec `packages/quereus-sync/test/sync/drop-recreate-batch.spec.ts` on real
      peers (`_peer-harness.ts`), covering:
  - [ ] the verified repro above — `unknownTable` absent, row visible from
        `select ... from widgets` immediately after `applyChanges`, no drain needed;
  - [ ] the same batch with `disposition: 'ignore'` — the row still lands (this is the
        permanent-loss case);
  - [ ] the same batch handed to `applyChanges` **reversed** — same committed state
        (order independence, matching the sibling spec's `expectNotHLCOrdered` guard);
  - [ ] trailing `drop_table` still hides the table — `create` → `insert` → `drop` in one
        batch diverts the rows and counts `unknownTable`, table absent afterwards;
  - [ ] reactive drain fires — receiver quarantines rows for `widgets` from an earlier
        batch, then a later batch that drops+re-creates `widgets` drains them without an
        explicit `drainHeldChanges` call (`drainOnReappear` defaults true);
  - [ ] receiver already HAS the table and holds an old-incarnation tombstone for the
        same pk — the re-created table's row still lands (the `freshLocalTable` arm),
        under the default `allowResurrection: false`.
- [ ] Update `docs/migration.md` § 4 line 110: "a create+drop in one batch leaves the
      table absent, so the drain is a no-op" — restate as the timestamp-ordered rule
      (the *last* create/drop step decides; a drop-then-create batch drains).
- [ ] Validate: `yarn workspace @quereus/sync run test 2>&1 | tee /tmp/sync-test.log`,
      then `yarn build` and `yarn workspace @quereus/sync run typecheck`.

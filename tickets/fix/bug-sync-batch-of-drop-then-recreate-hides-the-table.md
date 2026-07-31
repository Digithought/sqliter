description: When one device drops a table and then creates a new table with the same name, another device receiving both those steps together also receives the new table's rows — but files them away as "belonging to a table I don't have" instead of inserting them, so the rows show up late or, on one setting, never.
files:
  - packages/quereus-sync/src/sync/change-applicator.ts   # computeBatchTableDelta (~88); the `known` gate (~235); the reactive-drain skip (~357)
  - packages/quereus-sync/test/sync/apply-order-independence.spec.ts  # nearest existing specs (reversed create_table + drop_table)
  - packages/quereus-sync/test/sync/_peer-harness.ts      # makePeer / localWrite used by the repro below
difficulty: medium
repro: verified
----

## What happens

Before applying an incoming batch, the receiver works out which tables that batch
creates and which it drops, so it can tell a row for a table it genuinely does not
have (which must be set aside) from a row for a table the same batch is about to
create (which must be applied).

It does that with two plain sets: every `create_table` in the batch goes in one set,
every `drop_table` in the other. A table's rows are applied only if the table is
already present **or** in the created set, **and** not in the dropped set.

Those sets throw away *when* each step happened. A batch that carries
`create widgets` → `drop widgets` → `create widgets` puts `widgets` in both sets, so
every row for `widgets` is treated as belonging to a table the receiver does not
have — even though the same batch's schema steps, replayed in timestamp order, leave
`widgets` present and empty, ready for exactly those rows.

The same assumption appears a second time a few lines further down: after applying
the batch, the receiver immediately replays anything it had previously set aside for
each table the batch just created — but it skips any table that also appears in the
dropped set, on the same "the batch left it absent" reasoning.

## Why it matters

With the default setting the rows are held in quarantine and picked up by the next
periodic maintenance sweep, so this is a convergence *delay*, not loss. With
`unknownTableDisposition: 'ignore'` nothing is held, so the rows are dropped
permanently — the receiving device is silently missing rows the sender has.

Drop-and-recreate of a table under the same name is ordinary schema maintenance
(rebuilding a table is the classic case), and a batch spanning all three steps is
what a receiver that has been offline for a while gets on its next sync.

## Reproduction (observed)

Ran against real peers with `packages/quereus-sync/test/sync/_peer-harness.ts`:

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

Observed: `ApplyResult` is `{ applied: 3, skipped: 0, conflicts: 0, transactions: 4,
unknownTable: 2 }`. The receiver's `widgets` table **exists** (the three schema steps
replayed correctly, in timestamp order) but is **empty**; the row's two cell changes
went to quarantine. A subsequent `drainHeldChanges()` returns 2 and the row appears —
confirming the rows are recoverable under the default setting, and that the reactive
post-apply drain skipped this table.

Expected: the row lands during the same `applyChanges`, and `unknownTable` is absent.

## Expected behavior

Whether a batch leaves a table present must follow the same rule as every other
"which write survives" question in sync — the facts' timestamps, not set membership.
The last schema step for that table in timestamp order decides: a trailing
`create_table` means present, a trailing `drop_table` means absent. Both the
row-admission gate and the post-apply replay of previously set-aside rows must read
that same answer.

## Context

This is the same class of defect as `bug-sync-apply-order-splits-data-from-metadata`
(now complete), which made the schema-step list itself replay in timestamp order.
That fix corrected *how the steps are replayed*; this one is about *what the receiver
concludes from them*, which is still computed order-blind. The two live in the same
file but are separate code sites.

Scope note: `create_table` and `drop_table` are the only schema-step kinds that change
whether a table exists (`SchemaMigrationType` in `protocol.ts` has no rename), so only
those two need ordering — the other kinds can keep being ignored by this computation.

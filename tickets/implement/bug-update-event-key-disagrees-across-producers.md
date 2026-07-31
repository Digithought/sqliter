---
description: When an update changes a row's primary key, the three storage backends each report the change differently, so an app listening for changes cannot tell which row was affected. Pick one rule, write it down, and make every backend follow it.
prereq:
files:
  - packages/quereus/src/runtime/emit/dml-executor.ts           # ~1062 event key taken from OLD row; ~1169-1180 update auto-event
  - packages/quereus-store/src/common/store-table.ts            # ~488-616 update arm; ~601-614 the event
  - packages/quereus/src/vtab/memory/layer/manager.ts           # ~705-735 commit-time emit; ~1113-1129 non-relocating update arm
  - packages/quereus/src/vtab/memory/layer/transaction.ts       # ~905-922 recordUpsert writes pendingChanges.pk
  - packages/quereus-sync/src/sync/store-adapter.ts             # ~682-700 emitEffectiveChanges — already follows the rule; reference impl
  - packages/quereus-sync/src/sync/sync-manager-impl.ts         # recordDataEvent — consumer; verify, do not change
  - docs/usage.md                                               # ~314-382 § Subscribing to Data Changes
  - docs/module-events.md                                       # ~76-89 event shape
  - docs/module-authoring.md                                    # module obligations table (~553, ~894)
  - packages/quereus/test/alter-table-events.spec.ts            # ~442-468 test that must be re-pinned
  - packages/quereus-store/test/alter-events.spec.ts            # ~212-240 test that must be re-pinned
difficulty: medium
repro: verified
---

# Reproduced

`update t set a = 2 where a = 1`, table keyed by `a`, holding `(1, 'x')`. Observed by
subscribing before the update and printing every delivered event:

| producer | events delivered |
|---|---|
| engine auto-event path (plain `new Database()`) | one `update`, `key: [1]`, `oldRow: [1,'x']`, `newRow: [2,'x']`, `changedColumns: ['a']` |
| memory module with its own emitter (`new MemoryTableModule(emitter)`) | `delete` `key: [1]` `oldRow: [1,'x']`, then `insert` `key: [2]` `newRow: [2,'x']` |
| store-backed (`using store`) | one `update`, `key: [2]`, `oldRow: [1,'x']`, `newRow: [2,'x']` |

The memory module's pair is delivered identically whether observed through its own emitter or
through `db.onDataChange`.

**A second disagreement, not in the original report.** Under a `NOCASE` primary key a
case-only rewrite (`'apple'` → `'APPLE'`) does *not* move the row — every backend agrees it
is an in-place update and delivers a single `update` event. They still disagree on `key`:

| producer | `key` | stored row after |
|---|---|---|
| engine auto-event path | `['apple']` | `APPLE` |
| memory native | `['apple']` | `APPLE` |
| store-backed | `['APPLE']` | `APPLE` |

So two producers hand back key bytes the table no longer holds even when nothing relocated.
Any rule this ticket adopts has to settle this case too, not only the relocating one.

# The rule to adopt

Two coherent options were on the table (post-image key, or split the event). **Adopt the
split**, stated as two clauses that together cover every case:

> **1. `key` is the primary key projected out of the event's own row image** — from `newRow`
> for `insert` and `update`, from `oldRow` for `delete`.
>
> **2. An `update` never moves a row.** If a statement changes a row's primary key such that
> the row *relocates* — its key values differ under the primary key's own comparator, which is
> per-column collation- and type-aware, not byte identity — the producer delivers a `delete`
> at the old key followed by an `insert` at the new key, in that order, instead of one
> `update`. A rewrite that leaves the row in place (the `NOCASE` case-only case above) stays a
> single `update`, whose `key` clause 1 then fixes to the post-image bytes.

## Why the split rather than a post-image key

Post-image key alone leaves the old identity un-retired. The sync engine's `recordDataEvent`
(`packages/quereus-sync/src/sync/sync-manager-impl.ts`) writes a tombstone **only** for
`type === 'delete'`; for an insert/update it writes column versions filed under `event.key`.
So a post-image-keyed update records row `(2,'x')` under identity `2` and never tombstones
identity `1` — a synced peer ends up holding *both* rows. A cache keyed by `key` has the same
problem. Recovering the old identity from `oldRow` requires knowing which columns form the
primary key, which the event does not carry; sync can look it up, a plain listener cannot.

The split needs no consumer to know the schema, and it is already the behavior of two of the
four producers in-tree: the memory module's native path, and
`emitEffectiveChanges` in `packages/quereus-sync/src/sync/store-adapter.ts`, which already
computes exactly clause 1 (`const row = change.newRow ?? change.oldRow;` then projects it
through `primaryKeyDefinition`). Treat that function as the reference implementation.

Cost, to be stated in the docs rather than engineered around: a relocating update loses
`changedColumns` and loses the "these two events are the same row" relationship. Ordering
(delete before insert) is contract; **adjacency is not** — do not promise consumers the two
events arrive with nothing between them.

# Producer-by-producer

**Engine auto-event path** — already satisfies clause 1 everywhere except one site. The INSERT
arm projects from `storedRow` (~919, ~934), and the update arm's eviction event projects from
`result.replacedRow` (~1134). Only `processUpdateRow`'s `keyValues` (~1062) projects from
`oldRow`. That variable is *also* the `oldKeyValues` handed to `vtab.update` and to
`buildUpdateStatement`, and must keep pointing at the old row there — introduce a separate
event key rather than repointing it. For the relocation test, the file already imports
`uniqueEnforcementComparators` from `../../schema/unique-enforcement.js`; build per-PK-column
comparators from `tableSchema.primaryKeyDefinition[i].collation` the same way.

**Store** — `store-table.ts`'s update arm already computes the relocation predicate as
`pkChanged = !bytesEqual(oldKey, newKey)` (~512), which is precisely clause 2's "relocates"
(encoded keys honor per-column PK collation). Split the single event at ~601-614 on that flag.
The non-relocating branch already keys by `newPk` and is correct as-is. Keep the existing
`replacedAtNewPk` eviction delete (`deleteRowAt`, ~576) emitting *first*, so the order is
evict-delete, move-delete, move-insert — which is what the memory module already journals.

**Memory native** — the relocating case is already correct
(`performUpdateWithPrimaryKeyChange` records delete-then-upsert). The non-relocating arm
(~1127) calls `recordUpsert(targetPrimaryKey, …)` with the *pre-image* key, which is what
surfaces as `pendingChanges.pk` and then as the event key — this is the `NOCASE` bug above.
Prefer fixing it at the commit-time emit site (`manager.ts` ~705-735) by projecting
`change.newRow ?? change.oldRow` through the schema's `primaryKeyDefinition`, rather than
changing what `recordUpsert` stores: that argument also drives secondary-index bookkeeping,
and repointing it is a wider blast radius. Projecting at emit time also subsumes the
`keyParts(change.pk, eventKeyIsTuple)` shape juggling and the `NOTE:` there about handing
listeners the stored key array. Confirm the ALTER PRIMARY KEY re-key specs still pass either
way — projecting at emit time uses the schema current at delivery, which is what those specs
already require.

**Sync** — consumer only. It should need no change: it will now see `delete` + `insert` and
write a tombstone for the old pk plus column versions for the new one. Verify, don't assume.

# Tests that must be re-pinned

Two existing specs deliberately assert the *neutral* behavior and cite this ticket by slug in
their comments. Both currently learn the producer's key choice from a baseline run and require
the ALTER-crossing run to match it. Under the new rule each becomes two events, and the
assertion gets stronger rather than weaker — `delete` re-keyed to `[1, 9]`, `insert` re-keyed
to `[2, 9]`:

- `packages/quereus/test/alter-table-events.spec.ts` ~442-468
- `packages/quereus-store/test/alter-events.spec.ts` ~212-240

Rewrite the comments too; they describe a disagreement that will no longer exist.

# TODO

## Phase 1 — contract

- Write the two-clause rule into `docs/usage.md` § Subscribing to Data Changes, alongside the
  existing as-of-delivery paragraphs for `tableName` / `key` / row shape. State the `NOCASE`
  in-place case explicitly, and state that ordering is guaranteed but adjacency is not.
- Update the `key` row of the field table in `docs/usage.md` and the `key` comment in
  `docs/module-events.md` — both currently say only "Primary key values (if available)".
- Add the producer obligation to `docs/module-authoring.md` where the other as-of-delivery
  guarantees are spelled out: a module with its own emitter owes clause 1 and clause 2.

## Phase 2 — producers

- Engine auto path: add a relocation check in `processUpdateRow` and emit `delete` + `insert`
  when it fires; otherwise emit one `update` keyed from `storedRow`. Leave `keyValues` alone
  as the vtab's `oldKeyValues`.
- Store: split the update-arm event on the existing `pkChanged`; keep eviction-delete first.
- Memory native: project the event key from the row image at the commit-time emit site.
- Confirm the relocation predicate agrees across all three (PK comparator / encoded key, never
  raw value equality) — the `NOCASE` case is the test that catches a wrong choice here.

## Phase 3 — tests

- New spec pinning both clauses across all three producers: relocating update splits with the
  right keys and order; `NOCASE` case-only rewrite stays one `update` keyed by the post-image;
  ordinary non-PK update unchanged.
- Cover the PK-change-under-REPLACE-onto-an-occupied-key ordering (evict-delete, move-delete,
  move-insert). Note: `update or replace t set …` does not parse in this dialect — reach the
  REPLACE path via a per-constraint `on conflict replace` declaration instead.
- Re-pin the two ALTER specs listed above.
- Add a sync regression: a PK-changing update on a synced table must tombstone the old pk and
  land the new row under the new pk, with no phantom left at the old identity.
- Run `yarn test` and `yarn test:store` (the store leg is where the store producer's split is
  actually exercised), plus `yarn lint`.

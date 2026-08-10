---
description: Renaming one table used to briefly leave other tables' saved definitions on disk pointing at a name that no longer existed; a crash in that gap could permanently break writes to them. Fixed by deleting the renamed table's old catalog entry only after the dependents are safely re-saved, and reviewed.
prereq:
files:
  - packages/quereus/src/vtab/module.ts                          # optional finalizeRename hook on VirtualTableModule
  - packages/quereus/src/runtime/emit/alter-table.ts             # runRenameTable calls module.finalizeRename after propagateTableRename
  - packages/quereus-store/src/common/store-module.ts            # renameTable no longer deletes old entry; finalizeRename does, after draining dependents
  - packages/quereus-isolation/src/isolation-module.ts           # forwards finalizeRename to the underlying module
  - packages/quereus-store/test/rename-catalog-durability.spec.ts # multi-table ordering tests (FK + view dependents) + traceCatalogOps helper
  - docs/schema.md                                               # durability guarantee + best-effort residue documented
  - docs/module-authoring.md                                     # finalizeRename added to hook-surface reference
difficulty: medium
---

# Complete: two-phase `RENAME TABLE` — defer old-entry delete until dependents persist

## What the bug was

Every store-backed table's schema is saved on disk in a catalog. Renaming `parent`
to `parent2` requires every *other* object that names `parent` (a child table's foreign
key, a cross-schema FK, a `CHECK` expression, a view/materialized-view body) to have its
saved definition rewritten to say `parent2`. Before the fix, the store deleted `parent`'s
catalog entry **synchronously** inside its rename hook, but the dependents' corrective
rewrites landed a moment later on a deferred queue. In that gap the durable catalog said
"child → parent" with no `parent` on disk. A crash there stranded that state: on reopen the
child parsed fine but every write that checked its FK failed against the vanished `parent` —
a healthy-looking database whose child table silently could not be written to.

## The fix (as implemented)

Rename is now **two-phase** at the module boundary:

1. `StoreModule.renameTable` writes the new entry + moves physical stores but **no longer
   deletes** the old catalog entry.
2. New optional engine hook `VirtualTableModule.finalizeRename(db, schema, oldName, newName)`.
   The engine (`runRenameTable`) calls it at the **end** of ALTER … RENAME TO, *after*
   `propagateTableRename` rewrote every dependent and (synchronously, via the store's
   schema-change listener) enqueued their corrective catalog writes onto `persistQueue`.
3. `StoreModule.finalizeRename` enqueues the old-entry delete **behind** those writes on the
   same FIFO `persistQueue`, then drains the whole chain (`whenCatalogPersisted`) before
   returning — so the delete lands strictly after every dependent is durable.

During the window both `parent` and `parent2` entries coexist on disk, so every intermediate
catalog set rehydrates into a working database. `IsolationModule` forwards the hook; the
memory module keeps no persistent catalog and omits it (engine no-op fallback).

Guarantee delivered (docs/schema.md): **no durable catalog set ever names a vanished table.**
Deliberately narrower than full cross-table atomicity — see residue in that doc.

## Review findings

Read the implement diff fresh before the handoff. Verified the core invariant from the code,
not the summary: `propagateTableRename` fires `notifyChange` **synchronously**, the store's
`onEngineSchemaChange`/`dispatchSchemaChange` listener calls `enqueuePersist` **synchronously**
for every dependent kind, and `finalizeRename` enqueues the delete afterward — so the FIFO
ordering holds. The mechanism is identical for tables (`persistCatalogIfChanged`), plain views
(`saveViewDDL`), and MVs (`saveMaterializedViewDDL`): all ride the one `persistQueue`, all
enqueued during the awaited propagation. Confirmed `runRenameTable` is the **only** engine
caller of `module.renameTable`, and it now always follows with `finalizeRename` — there is no
path that renames without finalizing (no old-entry orphan leak).

**Checked — correctness / ordering:** sound. Dependent writes provably precede the old-entry
delete for all dependent kinds. No defect.

**Checked — resource cleanup / leaks:** sound. The delete rides the existing queue; connection
eviction in `renameTable` is unchanged. No new leak.

**Checked — error handling:** the old-entry delete is best-effort (`enqueuePersist`
swallows+logs); a failed delete leaves a droppable orphan, not a stranded dependent. Confirmed
this is the intended, safer failure mode. If `propagateTableRename` throws, `finalizeRename`
is skipped and both entries coexist (safe residue). No change.

**Fixed inline — test coverage (minor):** the implementer's test covered only a foreign-key
dependent. Added `RENAME TABLE re-persists a dependent VIEW body before deleting the renamed
table` to `rename-catalog-durability.spec.ts`. A view body persists through a *different*
enqueued function (`saveViewDDL`, reserved `\x00view\x00` key prefix) than a table
(`persistCatalogIfChanged`), so this exercises the ordering invariant across a second dependent
kind. The ordering assertion (`viewPut < parentDelete`) is discriminating: the old synchronous
delete would sequence `main.parent`'s delete first and fail it. Store suite now **918 passing**
(was 917).

**Fixed inline — docs (minor):** `docs/module-authoring.md` (the module-hook reference) listed
`renameTable` but not the new hook. Added `finalizeRename` to the method-presence table, the
surface-inventory table (with per-module behavior), and the isolation-forwarding paragraph.
`docs/schema.md` was already updated by the implementer and is accurate. `docs/store.md`
describes only the provider `renameTableStores` interface — no stale content, no change.

**Empty — new tickets filed:** none. No major defect surfaced.

**Tripwire (carried, not re-filed): atomic-provider hardening.** Full cross-table atomicity
(bundling the old-entry delete + every dependent rewrite into one `provider.beginAtomicBatch`
commit) would remove even the transient two-entry window and the physical-move orphan, but only
on atomic providers and with a larger engine↔module change. Already parked as a `NOTE:` in the
`StoreModule.finalizeRename` docblock and in docs/schema.md's best-effort section. Left as-is.

**Tripwire (noted): cross-*database* FK ordering.** The FIFO guarantee is per-`StoreModule`
instance. One module serves all schemas of a single `Database` (main/temp/attached-schema),
so a same-database cross-schema FK dependent rides the same `persistQueue` and is covered. A
dependent living in a *separate attached Database* backed by a *different* module instance would
persist on that module's own queue, outside this `finalizeRename`'s drain — but cross-database
FKs are speculative (not a currently-reachable path). Recorded here only; not a ticket.

**Accepted residues (documented, untested):** physical-move orphan (`renameTableStores` moves
data into the new name while the old entry still exists → crash reopens old name as an empty,
droppable table) and old-entry-delete failure — both strictly safer than the write-stranding
bug they replace, both written up in docs/schema.md. No crash-injection test exists; the new
tests prove *ordering* (trace) + *clean reopen*, not a real mid-window process kill.

## Validation

All green:
- `yarn workspace @quereus/store test` → **918 passing** (adds the view-dependent case)
- `yarn workspace @quereus/quereus test` → **6921 passing**, 13 pending
- `yarn workspace @quereus/isolation test` → **240 passing**
- `yarn workspace @quereus/quereus run lint` → clean (eslint + tsc test typecheck)

LevelDB ALTER path (`yarn test:store`) was **not** run in this pass — the ordering lives in the
provider-agnostic store module, exercised by the in-memory persistent provider. A release-grade
pass may want the LevelDB path too.

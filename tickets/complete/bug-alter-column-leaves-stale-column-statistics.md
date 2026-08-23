----
description: Renaming or dropping a column and then adding a new column that reused the freed name gave the new, empty column the old column's saved measurements, and that survived closing and reopening the database; the measurements now follow a rename, vanish with a drop, and a reused name inherits nothing.
files:
  - packages/quereus/src/schema/table.ts                              # pruneStaleColumnStatistics — the invariant helper
  - packages/quereus/src/schema/schema.ts                             # Schema.addTable — prunes, and now RETURNS what it registered
  - packages/quereus/src/runtime/emit/alter-table.ts                  # carryStatisticsAcrossColumnRename; runDropColumn announces the registered schema
  - packages/quereus/src/vtab/memory/module.ts                        # NOTE: memory backend drops statistics on a column-level ALTER
  - packages/quereus-store/src/common/store-table-base.ts             # remapPersistedColumnStatistics + columnStatisticsRemap
  - packages/quereus-store/src/common/store-module-alter.ts           # alterTable dispatch seam — calls the remap
  - packages/quereus-store/src/common/serialization.ts                # TableStats.columnStats doc
  - packages/quereus/test/schema-column-statistics-prune.spec.ts      # helper + addTable seam + memory-backed RENAME carry
  - packages/quereus-store/test/alter-column-statistics-prune.spec.ts # store-backed property + three end-to-end reopen scenarios
  - packages/quereus-store/test/stats-persistence.spec.ts             # rewritten rename test
  - packages/quereus-store/test/column-statistics-plan.spec.ts        # two tests re-based off a device that no longer works
  - docs/optimizer-costing.md                                         # "Statistics across DDL"
  - docs/store.md                                                     # "Column statistics across a column-level ALTER"
  - docs/module-authoring.md                                          # corrected stale rename guidance; new re-key obligation for persisting modules
repro: verified
----

# Column statistics no longer outlive the columns they describe

## The bug

`ANALYZE` records per-column measurements (distinct count, NULL count, min, max, sometimes
a histogram) on `TableSchema.statistics.columnStats`, keyed by lowercase column name. Every
`ALTER TABLE` arm in a virtual-table module builds the post-ALTER schema itself and the
engine installs that return value verbatim. The store module builds its result from the
pre-ALTER schema and copies across every field it does not override — so the measurement
map rode along still keyed by the pre-ALTER column names.

Verified end to end, store-backed: `analyze` → `rename column k to k2` → `add column k`
left the brand-new, entirely-NULL `k` credited with the old `k`'s 7 distinct values, 0
NULLs and range 0–6, so `where k = 3` was estimated at ~7 rows against a true 0. The
mis-attribution was written to disk and re-stamped onto a fresh schema on reopen.

## What shipped

**One invariant at the catalog seam.** `pruneStaleColumnStatistics` (`schema/table.ts`)
returns a schema whose `statistics.columnStats` names only columns that schema actually
has; `Schema.addTable` applies it before the map write. That seam is the single place every
registration passes through — `CREATE TABLE`, each module's ALTER return value, `ANALYZE`'s
own write, the store's reopen-time stamp — so no module has to get this right individually.
It returns the input object itself whenever nothing is stale, so ordinary registration stays
a map write.

**A rename keeps its measurements.** `carryStatisticsAcrossColumnRename`
(`runtime/emit/alter-table.ts`) moves the renamed column's entry onto its new key, reading
the pre-ALTER *catalog* schema rather than the module's return value — which is what makes
one implementation repair both backends at once. `ALTER COLUMN … SET DATA TYPE` deliberately
does not get this.

**The store re-keys its persisted snapshot.** `StoreModuleAlter.alterTable` calls
`StoreTableBase.remapPersistedColumnStatistics(change)` after the arm's work; it moves a
renamed column's entry onto its new name, removes a dropped column's outright, and flushes
immediately. Needed because once a freed name is reused the catalog-side prune cannot see
the problem: the stale key names a column that genuinely exists.

**Registration is no longer silently lossy.** `Schema.addTable` now returns the schema it
registered, and a caller that goes on to announce or persist must pass that value on — see
the review finding below, which is what forced this.

## Review findings

### Checked

Read the implement diff first, without the handoff summary. Then: the three layers against
each other; every `SchemaChangeInfo` arm against `columnStatisticsRemap`; `addTable`'s 40
call sites for the announce-your-input pattern; the store's `primeStats` / `flushStats` /
`publishPersistedStatistics` / `saveStatistics` chain for ordering and mutation hazards;
`buildColumnIndexMap` keying against `columnStats` keying; every doc file the change touched
and the ones it should have (`docs/module-authoring.md` was the miss); the five scenarios
the handoff listed under "what to exercise"; source sizes of the four touched files.

### Major — one real bug, found and fixed here

**`drop column k` then `add column k` still inherited the dropped column's measurements**,
in memory, before any reopen. The handoff listed this scenario under "what to exercise" and
no test covered it; the property test only asserted the invariant *after* the drop, not
after the reuse. Writing the missing test failed immediately.

Root cause is one site, and it is not in the drop arm: `Schema.addTable` pruned silently and
stored a *different* object, while `runDropColumn` then announced `table_modified` carrying
its own unpruned copy. The store module caches the announced schema as its working copy, and
its ALTER arms build their result by spreading it — so the dropped column's entry was
rebuilt into the next `ADD COLUMN`'s return value, by which time the name was live again and
the prune had no objection. The rename path was accidentally immune: it pre-cleans its schema
before `addTable`, so prune is a no-op there and the two objects agree.

Fixed at the seam rather than in the arm: `addTable` returns the registered schema and
documents that a caller which announces or persists must use that value; `runDropColumn`
announces it. Regression test added (store-backed, through a close and reopen).

The class behind it — ~15 register-then-announce sites and nothing checking they agree — is
filed as `debt-schema-change-notice-must-carry-registered-schema`, which asks for a boundary
check rather than a sweep.

### Major — filed, not fixed

**`alter column … set data type` keeps the column's old value range**, store-backed. The
handoff flagged this as needing a judgement call from review. Confirmed by running it:
after casting 20 integer values to text, min/max still read 0 and 19 *as integers*. The
column keeps its name, so neither guard applies by construction. Filed as
`backlog/bug-column-type-change-keeps-old-value-range` (`repro: verified`) rather than fixed
inline — which type changes invalidate a range (a collation change does; a widening numeric
change is arguable), and whether the distinct/NULL counts should survive, are real decisions
that want their own tests, and the implement ticket scoped the arm out deliberately.

### Minor — fixed in this pass

- **A `NOTE:` that contradicted its own commit.** `carryStatisticsAcrossColumnRename`
  carried a long note explaining that the store's persisted record is *deliberately not*
  re-keyed and that a renamed column plans blind after a reopen — which the same commit's
  `remapPersistedColumnStatistics` had made false. Rewritten to state the real division of
  labour, and to say what a *future* persisting module must do.
- **`columnStatisticsRemap` did not do what its own comment claimed.** The doc said a new
  ALTER form "has to be considered there rather than skipping this silently"; the `default:`
  arm skipped it silently. Every variant is now listed with a `never` exhaustiveness check,
  so a new form fails to compile until someone answers the question.
- **A comment block glued onto its neighbour.** The remap call and its explanation were
  inserted at the tail of the pre-existing `reconcileImplicitUniqueIndexStores` note, so
  that note read as if it described the remap. Separated, and the remap kept ahead of the
  reconcile with the reason stated (the reconcile's failure window would otherwise leave a
  freed name in the record after an IO error the arm itself survived).
- **`docs/module-authoring.md` was never updated** and contradicted the change in three
  places: "a column added or renamed … simply has no entry" and "a renamed column then
  misses cleanly" are both wrong now. Corrected, and a fourth rule added to *Persisting
  statistics across a reopen* telling a module author to re-key their own record when an
  ALTER frees a name — the obligation this ticket discovered and only the store currently
  meets. `docs/optimizer-costing.md` gained the announce-the-registered-schema rule.

### Minor — test gaps filled

The handoff was honest about these; all are now covered rather than noted.

- Drop-then-reuse across a reopen (store-backed) — this is what caught the major bug.
- Case-only rename (`k` → `K`), store-backed across a reopen and memory-backed.
- The engine's rename carry on the **memory** backend, which had no test at all: the store
  spec exercises one half of `carryStatisticsAcrossColumnRename`'s claim and the memory
  backend the other (before the fix, a rename lost the measurements entirely there). Three
  tests added to the engine spec.

Not added, deliberately: a test that `alterPrimaryKey` / the three constraint forms are
no-ops for the remap. The exhaustiveness check above makes that a compile-time property,
which is stronger than a test asserting nothing happened.

### Tripwires

None new. The two the implementer parked were re-read: the memory-module `NOTE:` is accurate
as written; the `alter-table.ts` one was the stale note fixed above. One accepted-tradeoff
`NOTE:` added at the remap's flush — it does not ride the transaction coordinator, matching
the documented decision on the neighbouring `saveStatistics`, and the two now have to move
together if statistics ever gain a non-advisory consumer.

### Considered and not filed

- **Duplicated `createInMemoryProvider` in the new store spec** — already claimed by
  `backlog/debt-store-test-shared-inmemory-provider`, which counts twenty-odd copies. Evidence,
  not a new ticket.
- **Source size.** `alter-table.ts` 2,650 lines (was 2,419 when `debt-oversized-source-files`
  was filed) and `store-table-base.ts` 1,327 (was 1,120 at its last measurement, 1,033 when
  filed) — both measured with `wc -l`. Both are already listed in that ticket with dated
  counts, and the growth in `store-table-base.ts` is entirely in the statistics block that
  ticket already names as its seam. Updated the counts in place; no new ticket.
- **The remap not riding the transaction coordinator** — the site it mirrors carries an
  accepted-tradeoff decision with an explicit revisit condition that has not tripped.
  Recorded at the new site instead of re-filing.

## Validation

- `yarn build` — clean.
- `yarn test` (whole workspace) — 10171 + 1916 + others passing, no failures.
- `yarn test:store` (engine logic tests re-run against the LevelDB store module) — 10163
  passing.
- `yarn workspace @quereus/quereus run lint` — clean (eslint + `tsc -p tsconfig.test.json`).
- `yarn workspace @quereus/store run typecheck` — clean.

Note for anyone re-running the store specs by hand: `packages/quereus-store` resolves
`@quereus/quereus` through its built `dist`, so an engine-side edit needs
`yarn workspace @quereus/quereus run build` before the store tests see it.

## Known remaining gaps

- `alter column … set data type` keeps a stale value range, store-backed — filed as
  `backlog/bug-column-type-change-keeps-old-value-range`.
- Register-then-announce divergence is fixed at the one site where it currently bites; the
  general guard is `backlog/debt-schema-change-notice-must-carry-registered-schema`.
- A histogram does not survive persistence for columns the store cannot seek on
  (`toPersistedColumnStats` drops it, by size arithmetic that predates this work), so a
  renamed column keeps its scalar measurements across a reopen but can lose its histogram.
  Pre-existing; the guard specs compare the four scalar fields and say why.
- The memory backend still discards a table's statistics on `add column`, `drop column` and
  `alter column`. Fail-safe rather than wrong; recorded as a `NOTE:` at
  `packages/quereus/src/vtab/memory/module.ts`. The two backends need a re-`ANALYZE` at
  different times.
- `fix/bug-drop-table-leaves-stale-stats-entry` is the same family at a different site (the
  store's `tearDownTableStorage` never deletes the whole-table `__stats__` entry) and was
  left alone here.

description: Nine source and test files across the repo have grown well past the size at which this project has previously split a file, and nothing stops the next one from growing the same way; add an automated size limit and work through the backlog of files already over it.
files:
  - packages/quereus/src/schema/manager.ts                   # 3,633 lines (`wc -l`, 2026-08-10)
  - packages/quereus/src/vtab/memory/layer/manager.ts        # 3,589 lines
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts   # 3,107 lines
  - packages/quereus/src/schema/schema-differ.ts             # 3,013 lines (`wc -l`, 2026-08-07; 2,725 when this ticket was filed) (spec: 1,186)
  - packages/quereus/src/runtime/emit/alter-table.ts         # 2,419 lines
  - packages/quereus-isolation/src/isolated-table.ts         # 2,077 lines
  - packages/quereus-isolation/src/isolation-module.ts       # 1,825 lines
  - scripts/check-docs.mjs                                   # 1,325 lines
  - packages/quoomb-cli/src/commands/dot-commands.ts         # 1,189 lines
  - packages/quereus-store/src/common/store-table-base.ts    # 1,120 lines (`wc -l`, 2026-08-11; 1,033 when this ticket was filed)
  - packages/quereus-store/src/common/store-table-scan.ts    # 1,401 lines (`wc -l`, 2026-08-11; 1,023 when this ticket was filed) — prefix-range seek window builders added ~230, batched row resolution another ~150
  - packages/quereus/src/planner/analysis/constraint-extractor.ts   # 1,647 lines (`wc -l`, 2026-08-11) — noticed during the relation-key review; predicate normalization, covered-key derivation, `analyzeRowSpecific`, and `TableInfo` construction are four separable concerns in one file
  - packages/quereus/src/planner/building/select-aggregates.ts # 1,630 lines (`wc -l`, 2026-08-12, after the post-aggregate redirect choke point + finished-plan boundary check; 1,486 earlier the same day after the select-list group-key redirect; 1,451 on 2026-08-11, 1,400 before the ungrouped-aggregate ORDER BY alias change, 1,296 before the grouping-key-alias change) — noticed during the window/group-key-alias review; GROUP BY key indexing and redirection, the aggregate output scope, HAVING construction, and the final grouped projection are four separable concerns in one file, and the redirect half now has five callers routed through one entry point (select list, window phase, ORDER BY, HAVING, pre-window sort) plus a plan-walking coverage checker
  - packages/quereus/src/schema/table.ts                     # 1,751 lines (`wc -l`, 2026-08-16) — noticed during the PK-conflict DDL review; the `TableSchema`/`ColumnSchema` type surface, the AST→schema builders (`columnDefToSchema` and friends), the key resolvers (`findPKDefinition`, `resolvePkDefaultConflict`, `isSynthesizedAllColumnsKey`), and the structural mutators (`rekeySchemaPrimaryKey`, `shiftSchemaIndicesForDrop`) are four separable concerns in one file
  - packages/quereus/src/planner/mutation/multi-source.ts    # 3,541 lines (`wc -l`, 2026-08-17) — second-largest non-test source file in the repo and never listed here
  - packages/quereus/src/planner/mutation/decomposition.ts   # 2,262 lines (`wc -l`, 2026-08-17) — the sibling half of the same folder
  - packages/quereus/src/planner/mutation/set-op.ts          # 2,058 lines (`wc -l`, 2026-08-17)
  - packages/quereus/src/schema/rename/table-rename.ts       # 1,063 lines (`wc -l`, 2026-08-07) — the other half of the same split; crossed 1,000 when the qualifier-collision predicate landed
  - packages/quereus/src/schema/rename/column-rename.ts      # 1,370 lines (`wc -l`, 2026-08-06; 1,057 when this ticket was filed) — residue of the 1,759-line rename-rewriter.ts split (table/column/strip); the column walk alone is still over, and still growing
  - packages/quereus-store/src/common/store-table.ts         # update() alone is ~315 lines (~252-565)
  - packages/quereus-isolation/test/isolation-layer.spec.ts  # 6,860 lines
  - packages/quereus-isolation/src/alter-migration.ts        # 1,078 lines — a prior split of this kind, for reference
  - docs/store.md                                            # the NOTE that already sets a ~1,000-line threshold for the StoreTable chain
  - docs/doc-conventions.md                                  # where a source-size rule would be written down
difficulty: medium
tradeoffs: Every one of these files works and none of the splits fixes a defect, so the whole theme is pure churn against a moving target — a maintainer may reasonably decline the ratchet (it will block unrelated PRs) and split individual files only when a ticket has to touch them anyway.
----

# Nine oversized files, and nothing that stops a tenth

This ticket absorbs nine separately-filed size tickets. They were filed one at a time,
each measured by hand, each arguing the same point — which is itself the evidence that
a **guard** is the deliverable and the splits are the backlog it drains.

The project already applies exactly this pattern to documentation: `scripts/check-docs.mjs`
enforces a per-doc word-count ratchet (a doc may shrink but not grow). There is no
equivalent for source.

## The invariant that retires the class

A source-size ratchet in the same shape as the docs one: a recorded per-file line count
that may shrink but not grow, with a hard ceiling for new files. A file over the ceiling
is recorded at its current size, so the gate goes green immediately and every subsequent
edit either holds or reduces the number. That converts "someone should split this" from a
ticket into a build failure at the moment the file grows.

Open question for whoever picks this up: whether the ceiling is one number repo-wide or
per-package, and whether test files get a higher one (the largest offender here is a spec).

## The backlog it drains

Measurements below are as recorded on each absorbed ticket; re-measure before splitting.

### `packages/quereus/src/schema/manager.ts` — 3,633 lines

Measured with `wc -l` on 2026-08-10 while reviewing the generated-column determinism gate;
currently the largest non-test source file in the repo, and not previously listed here.
`SchemaManager`, one class, covering: schema registry and name resolution (main / temp /
attached, canonicalization); the `CREATE TABLE` build-and-register pipeline
(`buildTableSchemaFromAST` plus roughly a dozen declaration-time guards stacked in
`createTable`); the DEFAULT / CHECK / GENERATED declaration validators; index, view and
materialized-view registration; constraint and tag mutation; and the catalog
import/rehydrate path (`importCatalog` / `importDDL` / `importTable`). The
build-vs-register split is already load-bearing in the comments — several guards carry a
note explaining that they sit in `createTable` rather than in the shared builder precisely
so catalog reload does not run them — which reads as the natural seam.

### `packages/quereus/src/vtab/memory/layer/manager.ts` — 3,589 lines

`MemoryTableManager`, one class: committed data, the stack of per-transaction layers,
every secondary index, and every `ALTER TABLE` arm that reshapes any of the above. Named
seams, already barely interacting: transaction/savepoint layer lifecycle (open, collapse,
commit, rollback); primary and secondary index structures and re-keying them; the
`ALTER TABLE` arms (add/drop/rename column, alter column, primary key, add/drop/rename
constraint — each a schema rewrite plus a row migration); constraint enforcement over
existing rows (UNIQUE / CHECK); connection registry bookkeeping.
Measured 2026-08 with `(Get-Content … | Measure-Object -Line).Lines`.
Reference: `packages/quereus/src/vtab/memory/module.ts` (988 lines) drives it.

### `packages/quereus/src/runtime/emit/materialized-view-helpers.ts` — 3,107 lines

The larger of the two emitter offenders. Its internal seams need a look before proposing
a split. (Re-measured 2026-08-03 with `wc -l`; grown since first filing at 3,093.)

### `packages/quereus/src/schema/schema-differ.ts` — 3,013 lines (unit spec 1,186)

Re-measured with `wc -l` on 2026-08-07 (2,725 at first filing); the rename-artifact-tolerant
compare (`absorbRenameArtifacts` and its three per-sink wrappers) is a natural extraction seam
that arrived after the split description below was written. One entry point (`computeSchemaDiff`) plus the DDL
renderer (`generateMigrationDDL`) over several separable responsibilities: rename
resolution (tables, views, indexes, columns, named constraints); per-object-kind diffing
(tables & columns, named constraints, indexes, views & materialized views, assertions);
the logical/lens diff variant; tag-drift detection; migration-DDL emission and its
statement ordering. Each kind's loop follows the same shape (name-match → body compare →
drop+recreate on drift), so the split is mechanical: one module per object kind, a thin
sequencing `computeSchemaDiff`, and the ordering-sensitive `generateMigrationDDL` kept
whole in its own file. The spec splits the same way.

### `packages/quereus/src/runtime/emit/alter-table.ts` — 2,419 lines

Holds the dispatcher for every `ALTER TABLE` verb, the per-verb runners (add/drop/rename
column, alter column, primary key, constraints, tags, the maintained-view lifecycle
verbs), **and** three independent table-rebuild strategies (in-place memory rebuild,
shadow-table rebuild via generated SQL, native-module path). The rebuild strategies are
self-contained and read as their own concern. (Re-measured 2026-08-03; was 2,155.)

### `packages/quereus-isolation/src/isolated-table.ts` — 2,077 lines

Now the largest file in the isolation package and it has had **no** split at all. The
per-connection table handle: merged reads, write routing into the overlay, cross-layer
PK/UNIQUE conflict detection, key ordering and collation resolution, savepoint
bookkeeping.

### `packages/quereus-isolation/src/isolation-module.ts` — 1,825 lines

Down from ~2,845: the `ALTER TABLE` overlay-migration machinery already moved out into
`alter-migration.ts` (1,078 lines) under `debt-isolation-module-alter-migration-extract`.
**Do not redo that work.** What remains mixes module lifecycle and bookkeeping
(create/connect/destroy, the per-connection overlay registry, commit and rollback,
savepoint tracking, renames) with secondary-index DDL forwarding. This is a *separate*
split from `isolated-table.ts` — do not bundle them.

### `scripts/check-docs.mjs` — 1,325 lines

The documentation gate, the first and cheapest step of `yarn check`. Started as a link
checker and accreted a check per ticket: **A** link integrity, **B** invariant format,
**C** doc size ratchet, **D** stability tiers for docs, **E** stability tiers for
packages. Each check is well factored internally (short named functions, per-check
self-tests); the problem is only that all five share one file with a handful of genuinely
common helpers (CRLF/BOM-safe reader, fence stripper, GitHub heading slugifier, package
directory walker). Wanted shape: a `scripts/check-docs/` directory with a thin entry
point, one module per check, plus a shared helpers module.
Blocks: `debt-stability-table-machine-readable` names this split as its prereq, and
`debt-check-docs-validate-section-markers` would add a sixth check to the same file.

### `packages/quoomb-cli/src/commands/dot-commands.ts` — 1,189 lines

Measured with `wc -l` on 2026-08-03. Four unrelated responsibilities behind one
`handleDotCommand` / `DotCommands` pair: CSV import/export (papaparse, file I/O);
result-table rendering and output-mode switches; schema introspection commands
(`.tables`, `.schema`, …); and the entire plugin manager — the `~/.quoomb/plugins.json`
record store (`loadPlugins`/`savePlugins`), install/remove/enable/disable/reload/config,
and the hash-pinning commands (`pin`, `unpin`, `trust`).

The plugin half alone is roughly half the file and is where all recent work has landed:
`feat-plugin-loader-hash-pinning`, `feat-cli-plugin-pinning` and
`feat-config-declared-plugin-hashes` each edited it and each had to read past the CSV and
formatting code. `bug-cli-corrupt-plugins-file-silently-wipes-plugins` (still open)
targets the record store inside the same file. Its plugin-side suite,
`packages/quoomb-cli/test/plugin-commands.spec.ts`, splits the same way.

### `packages/quereus/src/planner/mutation/` — three files over, 7,861 lines together

Measured with `wc -l` on 2026-08-17 while reviewing the join-view NULL-key write fix:
3,541 `multi-source.ts`, 2,262 `decomposition.ts`, 2,058 `set-op.ts`. `multi-source.ts` is
the second-largest non-test source file in the repo behind `schema/manager.ts` and had
never been listed in this theme. It grew ~190 lines in that one ticket alone.

Named seams inside `multi-source.ts`, already barely interacting: the **join-body analysis**
(`analyzeJoinView`, side classification, key/EC discovery); the **identity capture substrate**
(`buildMultiSourceKeyCapture`, `rebuildJoinWithMatchFlags`, `withKeyCapture`,
`capturedValueSubquery`, `buildCapturedKeyPredicate` — the `__vmupd_keys` machinery, which
now also owns the match-marker join rebuild); the **UPDATE/DELETE decomposition**
(`decomposeUpdate`, `decomposeDelete`, the outer-join matched/materialize branches); the
**RETURNING re-query builders**; and the **multi-source INSERT** analysis. The capture
substrate is the natural first extraction — it is the piece `decomposition.ts` and
`set-op.ts` both import, and `capture-correlation.ts` (added by that same ticket) is already
the start of that module.

### `packages/quereus-store/src/common/store-table-base.ts` (1,120) and `store-table-scan.ts` (1,401)

These two have a **documented** threshold, not an invented one. `docs/store.md` records:

> NOTE: the two largest `StoreTable` layers have both passed the ~1,000-line seam …
> Scan-layer seams — the multi-seek group (`decodeMultiSeekTuples` / `orderTupleValues` /
> `scanMultiSeek` / `scanMultiSeekPrimary`) and the row-resolution group
> (`produceIndexEntries` / `resolveIndexEntries` / `resolveRowBatch`); the base's is the
> statistics block. Until it lands, put new scan-side logic in a collaborator … rather
> than growing these two.

Both have passed it. Full chain measured with `wc -l` from `packages/quereus-store`
(2026-08-11): 1,401 `store-table-scan.ts`, 1,120 `store-table-base.ts`,
711 `store-table-constraints.ts`, 722 `store-table.ts`. The doc already names the seam for
each file, so this is mechanical.

The scan layer is the one still moving, and it is now the largest file in the package —
it has taken two features since this ticket was filed (the prefix-range seek window
builders, then the batched row-resolution producer/consumer of
`store-index-seek-batched-scan`), each landing in the file rather than in a collaborator,
against the "prefer a collaborator" guidance the same NOTE gives. Both features are
cohesive with the scan arms they serve, so neither is a wrong placement — the point is
that nothing stops the pattern, which is exactly what the ratchet above is for. Its seams
are now two, not one: the multi-seek group, and the row-resolution group
(`produceIndexEntries` / `resolveIndexEntries` / `resolveRowBatch` — these need only
`iterateEffective`, `readEffectiveRowsByKeys` and `matchesFilters`, so a collaborator
taking a narrow interface would lift out cleanly).

### `packages/quereus-store/src/common/store-table.ts` — `update()` is ~315 lines

Not a whole-file split: one method. `update()` is the single entry point the engine calls
for every row write against a store-backed table — one `switch (operation)` with three
arms written inline (`insert` ~125 lines, `update` ~130, `delete` ~45, lines ~252-565),
roughly half of the 645-line file and the largest method in the package. `AGENTS.md` asks
for small single-purpose methods and decomposed sub-functions in preference to long blocks
separated by comments. Pre-existing debt: the file was recently reduced from ~3,400 lines
to 645 by the four-file `StoreTable` chain split, which was a pure move.

### `packages/quereus-isolation/test/isolation-layer.spec.ts` — 6,860 lines

The largest file in the theme, and a test. An order of magnitude larger than every sibling
in the folder (`alter-table-conformance.spec.ts`, `merge-iterator.spec.ts`,
`key-set-seek-merge.spec.ts`, `flush-probe-ordering.spec.ts`, … all a few hundred lines).
Everything under one `describe('IsolationModule')` with dozens of nested blocks: table
creation, reads/writes, savepoints, commit/rollback, every ALTER arm, cross-connection
overlay behavior, poisoning, concurrency modes.

Nothing is broken; the cost is navigational, and it is already compounding — several
near-duplicate local test modules (subclasses of `IsolationModule`, fake
`VirtualTableModule`s) exist in the file because their authors did not find the earlier
one. Split by behavior under test, keeping shared helpers in one importable place rather
than copied per file.

## Notes for whoever picks this up

- The ratchet and the splits are separable, and the ratchet is the part worth promoting
  first: without it this ticket regrows.
- The splits are not one unit of work. Each is independently promotable and several are
  purely mechanical; `store-table-scan.ts` / `store-table-base.ts` have their seams named
  in `docs/store.md` and `schema-differ.ts` has a stated per-object-kind cut.
- `scripts/check-docs.mjs` has a downstream dependent (`debt-stability-table-machine-readable`),
  so promote that one ahead of the rest if the theme is split.

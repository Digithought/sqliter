----
description: Let each storage backend tell the query planner how expensive its basic operations really are — sequential read versus random point read — instead of one hard-coded guess that fits some backends and badly misprices others.
prereq: idb-native-index-bench
files:
  - packages/quereus-store/src/common/kv-store.ts (KVStore interface — where the declaration lives)
  - packages/quereus-store/src/common/store-module-access-plan.ts (ROW_RESOLUTION_COST, INDEX_SEEK_COST, the seek-vs-scan comparison — the consumer)
  - packages/quereus-plugin-indexeddb/src/store.ts (declares the expensive-point-read profile)
  - packages/quereus-plugin-leveldb/ (declares a near-parity profile)
  - packages/quereus/src/planner/rules/access/rule-key-set-seek.ts (engine consumer that probes module costs and assumes linearity)
----

# Problem

`store-module-access-plan.ts` prices resolving one secondary-index entry to its row with a
single constant, `ROW_RESOLUTION_COST = 1.0` — "a resolved row costs about what a sequentially
scanned row costs". That is roughly true for LevelDB (block cache) and false by roughly an
order of magnitude for IndexedDB, where a measured ~20k-row workload showed ~0.017 ms per
sequentially scanned row vs ~0.14–0.18 ms per index-resolved row. Result: the planner picks
index seeks that lose to a full scan, and downstream users hand-roll full-scan-and-filter
workarounds that beat the "optimized" plan (measured: 981 ms naive vs 337 ms workaround on one
join-shaped query; 425 vs 289 on a filtered read).

One constant cannot serve both backends. The store framework already has the right idiom for
per-backend variation: declared capabilities (`readCommittedSnapshot`, `concurrencyMode`,
`supportsBatchedRead`). Cost belongs on that list.

# Spec (for the plan pass to settle into implement tickets)

- An optional cost-profile declaration on `KVStore` (or the provider — decide which surface;
  profiles are per-backend, not per-table): relative units with sequential-row-read ≡ 1, e.g.
  `{ pointRead, seekPositioning }`, possibly `entryRead` if index-entry pages price differently
  from data pages. Absent declaration = today's constants exactly (parity default; memory-backed
  and third-party stores unchanged).
- `computeBestAccessPlan` derives `ROW_RESOLUTION_COST` / `INDEX_SEEK_COST` from the profile
  instead of module-wide constants.
- IndexedDB's declared numbers come from the `idb-native-index-bench` results (that prereq's
  arms A/B/C measure exactly this ratio); LevelDB's from a quick equivalent measurement or a
  documented parity default.

# Landmines the design must respect (all documented in comments at the named sites)

- **Raising resolution cost is currently arm-disabling, not arm-tuning.** `ARM_SELECTIVITY` is
  a fixed fraction of table size, so every arm's cost and the scan's are both linear in table
  rows — the comment at `ROW_RESOLUTION_COST` derives that a value past ~2.8 turns range arms
  off for every query, past ~6.2 prefix-range, past ~9.7 equality. An IndexedDB profile near 8
  would do exactly that wholesale. That may even be *correct* for IndexedDB today (scan genuinely
  wins at 10%-of-table selectivity there), but the plan pass must decide this deliberately:
  either accept whole-arm disablement until per-column statistics land
  (`store-column-statistics`, sequenced immediately after and deliberately so), or gate how much
  of the profile applies while selectivity is still a fixed guess.
- **`rule-key-set-seek` probes costs at 2 and 1000 keys and interpolates a straight line**; a
  probe answer that stops naming an index is read as "module declined" and kills the rewrite.
  The multi-seek arm's exemptions from both the per-row charge and the seek-vs-scan comparison
  exist to keep those probes sane (regression fingerprint: 16 tests in
  `key-set-seek-store.spec.ts`). The profile must flow into multi-seek pricing without breaking
  the linearity or the index-naming those probes rely on.
- **`bug-store-pk-range-preempts-cheaper-index` (backlog)** — the PK-range arm returns before
  secondary arms compete at all. Not absorbed here, but the profile surface should not bake in
  the assumption that arms never compete across the PK/secondary boundary; that ticket wants to
  make them compete on cost later.

# Key tests to expect in later phases

- Same schema + query planned against a parity profile picks the seek; against an
  IndexedDB-like profile picks the scan (assert on `explains` / chosen index, and on identical
  row sets both ways).
- Undeclared profile ⇒ byte-identical plan choices to today across the existing pushdown suite.
- `key-set-seek-store.spec.ts` green under both profiles.

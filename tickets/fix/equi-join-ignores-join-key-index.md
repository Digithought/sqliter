description: On the persistent store, joining two tables on an indexed foreign key gets slower faster than the data grows — a two-table join that takes tens of milliseconds at a few hundred rows takes seconds at a few thousand and does not finish at ten thousand, even though the same lookup done directly through the index is flat-fast. The join planner is not using the index on the join column.
files:
  - packages/quereus/src/planner/rules/join/rule-join-physical-selection.ts   # hash/merge/NL cost pick + equi-pair gate
  - packages/quereus/src/planner/rules/join/equi-pair-extractor.ts             # collation/semantic-ordering equi-pair demotion
  - packages/quereus/src/planner/rules/join/rule-fanout-lookup-join.ts         # only correlated-inner-seek path; inert for local vtabs
  - packages/quereus/src/planner/rules/predicate/rule-predicate-pushdown.ts    # pushes Filter into Retrieve; does NOT cross a Join
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts       # constraints → IndexSeekNode (seek keys can be dynamic bindings)
  - packages/quereus/src/planner/nodes/retrieve-node.ts                        # bindings surface (correlated/param seek keys)
  - packages/quereus/src/runtime/emit/join.ts                                  # nested-loop drivers re-scan inner per outer row, no correlation pushed
  - packages/quereus-plugin-indexeddb/                                         # store vtab the report was measured against
difficulty: hard
----

# Equi-join does not use the secondary index on the join key

External user report (measured on `@quereus/quereus` **4.4.1** + `@quereus/plugin-indexeddb`
4.4.1, browser). Full report: `.tmp/quereus-join-perf.md`. The repo is at 4.4.1, so the
measurements are against current code, not a stale version.

## Symptom

A two-table equi-join on an indexed FK grows **super-linearly** on the store backend:

| query | ~200 rows | ~2000 rows | growth for 10× data |
|---|---|---|---|
| `entry ⋈ txn ⋈ account ⋈ account_group` (4-way, filter + GROUP BY) | 87 ms | 1924 ms | ~22× |
| `entry ⋈ txn` (2-way, filter + ORDER BY) | 36 ms | 1679 ms | ~47× |
| control: `select … from entry where txn_id = ?` (the join predicate as a direct seek) | 1.30 ms | 1.20 ms | **flat — O(1) seek** |

At ~10 000 rows the 4-way join **did not complete within an 8-minute cap**; the same report
computed with single-table indexed reads joined in JS returns in ~1 s (~20× faster, linear).
Every single-table read (seek / range / full scan) is flat or linear — the store itself is
fine. The cost is entirely the join strategy.

The smoking gun: `idx_entry_txn` answers `where txn_id = ?` in flat ~1.2 ms regardless of
table size, i.e. it gives an O(1) seek on exactly the column the join needs (`t.id =
e.txn_id`) — yet the join does not use it to satisfy the join.

## What the code confirms (research done at triage)

Two distinct facts, both real:

1. **No index-nested-loop join (INLJ) exists.** No rule pushes an outer row's join key into
   the inner (right) side as a per-outer-row index seek. `rule-predicate-pushdown` pushes a
   `Filter` into a `Retrieve` and `rule-select-access-path` can turn those constraints into an
   `IndexSeekNode` whose seek keys are dynamic bindings — but pushdown explicitly does **not**
   cross a `Join`, and a join's equi-condition lives on the `JoinNode.condition` child, never
   as a `Filter` on the inner subtree. So the seek-by-bound-key machinery exists but is never
   wired to an ordinary join inner. The one correlated-inner-seek node,
   `FanOutLookupJoinNode`, is gated on `expectedLatencyMs > 0` (0 for all in-process vtabs → inert
   for local; unclear whether the indexeddb plugin advertises latency) plus an FK→PK-alignment
   shape under a `ProjectNode` — it does not cover a general `t.id = e.txn_id` join.
   Consequence: the inner side is **always fully consumed** — a hash build reads every inner
   row, a plain nested loop re-scans (or caches-then-replays) every inner row. Even the
   best-case hash join scans the whole indexed inner instead of doing a few cheap seeks.

2. **A clean equi-join normally escapes O(n·m) via a hash/Bloom join** — `rule-join-physical-selection`
   defaults unknown cardinality to 100, and `hash(100,100)=120` beats `NL(100,100)=1100`, so
   hash is picked. That makes the *measured super-linearity itself* the anomaly to reproduce:
   if hash join were firing, the join would be ~linear, not 22–47× per decade. So on the store
   path the join is likely **falling back to nested-loop**. The most probable causes to
   confirm first:
   - **Equi-pair extraction demotes the key to a residual.** `equi-pair-extractor.ts` accepts
     `ColumnRef = ColumnRef` only when both sides share collation *and* agree on semantic
     ordering; a mismatch demotes the pair to residual, and with no surviving equi-pair
     `rule-join-physical-selection` never fires → nested loop. The store keys are `text` PK vs
     `text` FK; a store-side collation/key-encoding difference could trip this. (Many completed
     store-collation tickets touched this area — verify current state.)
   - **Bad 4-way join ordering on zero/unknown cardinality.** With every base cardinality
     unknown, join-order enumeration and the NL/hash cost comparison run on flat guesses; a
     wrong order can blow up the intermediate. See related tickets below.
   - **Nested-loop cache abandonment.** `rule-nested-loop-right-cache` caches a pure inner once,
     but abandons past ~1000 rows (`bug-cache-threshold-abandon-cliff`) → flips O(K)→O(N×K). The
     ~200→~2000-row explosion in the table above lands right at that boundary.

## Expected behavior

A two-table equi-join on an indexed join key should be at worst **linear-ish** in the data,
matching the direct `where join_key = ?` seek that already exists. Concretely one of:

- an **index-nested-loop join** — outer drives, inner is an index seek keyed on the outer join
  value (`idx_entry_txn`) — the O(n log m) shape the report asks for and the only one that uses
  the inner index; **or**
- a reliably-selected **hash join** on the store path (build the smaller side once), which is
  linear even though it does not use the inner index.

Driving the join from either side, or as a 3-/4-way, must not reintroduce the super-linear
shape.

## Scope / relationship to existing tickets

This ticket owns the **join** case, which nothing currently does. Do not duplicate:

- `plan/feat-uncorrelated-in-semijoin` — cites this same report but only fixes the **IN-subquery
  / DML analogue** (key-set pushdown to storage); it explicitly calls the join case "the
  reported join-key-not-pushed gap" and leaves it here.
- `backlog/bug-cache-threshold-abandon-cliff` — the O(K)→O(N×K) cliff that may be one contributor.
- `backlog/debt-access-node-catalog-cardinality` + `plan/feat-conjunction-and-join-selectivity`
  — zero/coarse cardinality feeding the cost model that picks the join strategy.
- `backlog/known/2-adaptive-query-optimization` — the grand vision; INLJ-on-equality is squarely
  its "Tier 0: index seek on equality match / hash join over nested loop" floor.

## Reproduce first

- Build the two-table shape (`txn(id text pk)`, `entry(id text pk, txn_id text)` +
  `create index idx_entry_txn on entry(txn_id)`) on **both** `default_vtab_module='memory'`
  and the **store** module. Seed one entity, N and 10N rows.
- Capture `query_plan('select … from entry e join txn t on t.id = e.txn_id where …')` on each
  backend and diff the chosen join strategy (hash vs nested loop) and whether any inner access
  is a seek. (Report claimed "no EXPLAIN" — `query_plan()` / `explain()` exist in
  `func/builtins/explain.ts`; that discoverability gap is a separate, minor docs note, not part
  of this fix.)
- Time the join vs the `where txn_id = ?` control at both sizes and confirm the growth curve.
- Determine which of the three causes above is actually firing on the store path before
  choosing between "make hash reliably fire" and "add INLJ" (they are not mutually exclusive —
  INLJ is the strictly better answer for a small outer vs large indexed inner).

## Out of scope

- Per-row store read/write overhead (~0.03–0.1 ms/row read, ~2 ms/row write on IndexedDB) — a
  store-plugin bulk-cursor concern, noted in the report as "likely not an optimizer bug".
- `col in (list)` index pushdown on the store — already `plan/feat-store-in-list-index-pushdown`.

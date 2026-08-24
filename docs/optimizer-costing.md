# Optimizer Cost and Statistics

> **Stability: Internal** — see [Stability Tiers](stability.md#tiers).

How a plan node's cost is computed, and how row counts and selectivities are estimated —
the two things every cost-based rule stands on. The cost half covers the self-cost-only
convention and the conjunct cost tiers; the statistics half covers the `StatsProvider`
abstraction, filter and base-table row estimates, boolean decomposition, and the
multi-relation attribution walk.
A satellite of [Quereus Query Optimizer](optimizer.md).

## Cost Model Integration
Cost estimation is centralized in `src/planner/cost/index.ts`:
- Consistent formulas across optimization rules
- Tunable parameters via `OptimizerTuning`
- Clear units (rows, cost units, bytes)

### Conjunct cost tiers

`cost/conjunct-cost.ts` ranks WHERE/HAVING conjuncts for
`rule-filter-conjunct-ordering` on a three-part key
(`compareConjunctRank`): a coarse `ConjunctCostTier`
(`Pure` < `Volatile` < `Subquery`) first; within a tier, estimated filtering
bought per unit work — `(1 - selectivity) / max(subtreeCost, 1e-9)`,
descending — with plain `getTotalCost()` breaking ratio ties. Raw subtree cost
alone misorders across tiers: node-count-derived cost
does not model "opens a whole sub-program per row", so a tableless scalar
subquery (`(select f())`, ≈0.051) costs *less* than a three-term arithmetic
expression (≈0.053) and barely more than a modulo — pure cost would run the
subquery before the arithmetic. The tier is the structural signal instead: any
relational descendant ⇒ `Subquery`, else any non-deterministic node ⇒
`Volatile`, else `Pure`.

**Why the tier stays the primary key.** The textbook rank is
`(fraction rejected) / (cost to run)` applied globally, but that needs a cost
denominator comparable across every conjunct — which is exactly what the tier
exists to say quereus does *not* have. Promoting a `Subquery`-tier conjunct
ahead of a `Pure` one because statistics say it rejects 95% would bet a
*measured* selectivity against an *unmeasured* per-row sub-program cost. Within
a tier the conjuncts are the same structural class, so cost is comparable there
and the ratio is meaningful.

Per-conjunct selectivities come from the shared estimator in
`planner/stats/conjunct-selectivity.ts`, gated on `statsOnlySelectivity` — real
statistics only. When **no** conjunct in a filter gets a real estimate the rule
sorts with the cost-only `compareConjunctCost` verbatim (an explicit branch,
not a limit argument), so a query with no `ANALYZE`d statistics orders
bit-identically to the pre-selectivity rule. In the mixed case an unknown
conjunct is assigned `UNKNOWN_CONJUNCT_SELECTIVITY` — which *is*
`DEFAULT_FILTER_SELECTIVITY` (0.5), the engine's one "nobody knows" fraction —
so "no information" is the neutral position: a measured-stronger conjunct
(s < 0.5) sorts ahead of unknowns, a measured-weaker one behind, and unknowns
keep their cost order among themselves (constant benefit ⇒ descending
benefit/cost degenerates to ascending cost). Selectivities are clamped to
[0, 1] before the benefit is computed, and the 1e-9 cost floor is a
divide-by-zero guard only — no real conjunct has zero subtree cost.

The module is deliberately **not** re-exported from
`cost/index.ts` — `nodes/filter.ts` imports `cost/index.ts`, and conjunct-cost
imports plan-node + characteristics (and now `DEFAULT_FILTER_SELECTIVITY` from
`nodes/filter.ts` itself), so a re-export would create an import cycle.

Reordering preserves the row set (AND commutes under three-valued logic, and a
Filter rejects `false` and `NULL` alike) but it does **not** preserve which
conjuncts get evaluated, so a guard idiom (`v <> 0 and 10 / v > 1`) is only
safe while no scalar expression raises. Every arithmetic edge quereus defines
returns NULL rather than throwing, so this is inert today; note that
selectivity adds a second route past a guard — a statistics-strong conjunct
can sort ahead of a cheaper same-tier guard even where cost alone would have
kept the guard first. If a scalar function
that throws on bad input ever ships, gate the reorder on a per-function
"may raise" trait, or require CASE for guarding as PostgreSQL does.

### First-row latency in cost comparisons

`PhysicalProperties.expectedLatencyMs` is a subtree's **first-row** latency in milliseconds — how long an iterator opened over it takes to hand back its first row. A `VirtualTableModule` declares it (`TableReferenceNode.computePhysical` reads the module's hint) and it propagates upward as `max(children)`. Every in-tree module declares 0, so every formula below reduces to its latency-free form on local plans; a genuinely network-backed module — one whose reads cross an HTTP or WebSocket boundary — would declare a real number. `StoreModule` takes its value from `KVStoreProvider.expectedLatencyMs`, so a third-party key-value backend has a path to declare one; no in-tree provider does, and the IndexedDB provider deliberately declines despite being measurable (its round trips are sub-millisecond, far below the 25 ms gates, and the one shared formula that reads the field charges the seek plan rather than the scan — the reasons are recorded at that provider's `costProfile` site).

Beware the unit when reading a small declared value: the `tuning.parallel.*ThresholdMs` gates read the field as literal wall-clock milliseconds, while the cost formula below reads it as engine cost units where 1.0 is one scanned row. Those agree only where a scanned row costs about 1 ms — fine for the network case this exists for, wrong by orders of magnitude for a sub-millisecond backend. The same caveat is recorded at `indexNestedLoopJoinCost`.

It is **not** part of any shared formula in `cost/index.ts` except `indexNestedLoopJoinCost`'s explicit `perSeekLatencyMs` parameter — the other callers of these formulas cost latency-free subtrees, and folding a latency term into `seqScanCost` and friends would double-charge wherever a rule adds its own. Instead each rule that compares alternatives adds the latency its own candidates pay, in the same "ms-equivalent cost unit" convention `tuning.parallel.branchSetupCost` uses: one unit of `expectedLatencyMs` is one engine cost unit.

The discipline that keeps such a comparison sound is that **every** candidate must be charged the opens it actually performs — charging one candidate and exempting another biases the comparison by the exempted amount, and the bias is invisible until a module reports a non-zero latency. `rule-join-physical-selection` is the worked example: see [Optimizer Joins § Physical Join Algorithm Selection](optimizer-joins.md#physical-join-algorithm-selection) for its per-candidate charge table, including the case where a later rule (`rule-nested-loop-right-cache`) changes how many opens a candidate performs, so the charge has to ask that rule how many opens are left. Ask it for the **open count**, not for whether its own rewrite still applies — those answers diverge once the rewrite has landed and the rule reports "nothing left to do".

### Self-cost-only convention

> **Invariant:** [OPT-016](invariants.md#opt-016--estimatedcost-is-self-cost-only), [OPT-018](invariants.md#opt-018--the-total-cost-memo-is-invalidated-on-mutation)

`PlanNode.estimatedCost` stores **only the node's own incremental (self) cost**,
excluding its children. The whole-subtree cost is `PlanNode.getTotalCost()`, which
is the **sole** place child costs are summed — it walks `getChildren()` and adds
each child's total to this node's self-cost.

A node constructor must never fold `child.getTotalCost()` (or a child's
`estimatedCost`) into its own `estimatedCost`. Doing so double-counts the child once
`getTotalCost()` sums the children again, which compounds with nesting depth and
inflates deeply nested plans exponentially — skewing which plan the optimizer picks.
The only genuine leaf self-cost that reads an `estimatedCost` is the vtab access
node's own `xBestIndex` IndexInfo cost (`table-access-nodes.ts`).

`getTotalCost()` is memoized per instance. This is sound because PlanNodes are
immutable (`withChildren` mints a fresh instance with a fresh, empty cache) and no
constructor calls `getTotalCost()`, so the first call always happens after the tree
is fully built. The one in-place mutator — `RecursiveCTENode.setRecursiveCaseQuery()`
— clears the memo via `invalidateTotalCostCache()`.

Two guards keep the two conventions from silently re-mixing (see
`test/planner/cost-additivity.spec.ts`):
- `validateCostAdditivity(plan)` (`planner/validation/plan-validator.ts`) asserts, per
  node, `getTotalCost() === estimatedCost + Σ child.getTotalCost()` and that
  `estimatedCost` is finite and `>= 0`.
- A static source-scan test fails if any node constructor reintroduces
  `getTotalCost(`/child `.estimatedCost` in its self-cost.

## Statistics Abstraction
The `StatsProvider` interface allows pluggable statistics sources:
```typescript
// Attribute id → the base-table column whose statistics describe it; undefined for an
// attribute minted above the base table. A caller holding a plan tree MUST pass one.
type ColumnStatsResolver = (attributeId: number) => string | undefined;

interface StatsProvider {
  tableRows(table: TableSchema): number | undefined;
  selectivity(table: TableSchema, pred: ScalarPlanNode, resolve?: ColumnStatsResolver): number | undefined;
  // Real statistics only — undefined instead of a heuristic guess.
  statsOnlySelectivity?(table: TableSchema, pred: ScalarPlanNode, resolve?: ColumnStatsResolver): number | undefined;
  joinSelectivity?(left: TableSchema, right: TableSchema, cond: ScalarPlanNode, resolve?: ColumnStatsResolver): number | undefined;
  distinctValues?(table: TableSchema, columnName: string): number | undefined;
  indexSelectivity?(table: TableSchema, indexName: string, pred: ScalarPlanNode): number | undefined;
}
```

The default provider is `CatalogStatsProvider`, which reads real statistics from `TableSchema.statistics` (populated by `ANALYZE` or `VirtualTable.getStatistics()`) and falls back to `NaiveStatsProvider` heuristics when unavailable. When catalog statistics include equi-height histograms, range and equality selectivity estimates use histogram interpolation rather than uniform assumptions.

`selectivity` always answers, substituting a fabricated per-nodeType guess when nothing real is available. `statsOnlySelectivity` is the same estimate *without* that fallback: it returns `undefined` when the table has no statistics, and also when the predicate's shape puts it out of reach of the statistics that do exist (`lower(cat) = 'x'` — the leaf estimator reads the column off a direct child of the comparison and finds none), when the compared column was minted *above* the base table (the resolver below reports it as having no origin), or when they answered only part of it (a partly-known `OR`, below). Callers that must not act on a fabricated number use it in place of `selectivity`.

**Column identity, not column name.** Each selectivity method takes an optional `ColumnStatsResolver` that maps a `ColumnReferenceNode`'s attribute id to the base-table column whose statistics describe it. `rule-filter-selectivity` builds one from `collectColumnOrigins` and passes it on every call. Without it a provider falls back to the name in the reference's AST, and `select id * 7 as qty from o` — a computed column that happens to be aliased to a real column's name — silently borrows `o.qty`'s distinct count, making the estimate depend on the alias spelling. `ProjectNode` forwards the source attribute id for a bare column-reference projection and mints a fresh one for a computed expression, which is exactly the distinction wanted: `select cat as qty` still reads `o.cat`'s statistics, `select id * 7 as qty` reads none. The parameter stays optional only for callers with no plan tree in hand (the direct-provider unit tests, which build mock nodes with no meaningful attribute ids); every production caller passes one.

Identity resolution is only as complete as `collectColumnOrigins`, which reaches through a `with` clause as well as through an inline subquery: `CTEReferenceNode` mints fresh attribute ids for every column it republishes, so the walk maps the body's origins positionally onto those fresh ids rather than descending past the reference. See "A CTE reference publishes its own relation instances" below for why the remap alone is not enough.

**Filter row estimates.** `FilterNode.estimatedRows` derives from `context.stats.selectivity(table, predicate)`, stamped onto the node by `rule-filter-selectivity` (node accessors carry no `OptContext`, so the estimate is computed by a context-holding rule and cached on an optional `FilterNode.selectivity` field). The flat `DEFAULT_FILTER_SELECTIVITY` (0.5) is only a last-resort default — used before that rule runs (e.g. Structural-pass cost comparisons), when neither the single-table nor the multi-relation path below produces a number, or when the provider declines. A provably ≤1-row filter (equality conjuncts covering a unique key) still forces `estimatedRows = 1` in `computePhysical`, overriding any stats fraction.

The rule is registered in **three** passes, all bottom-up. Only the first derives an estimate the plan did not have; the other two recover one that a later pass dropped, because `FilterNode.withChildren` carries the stamp forward only when the predicate child is the same object and several passes rewrite inside a predicate.

- `filter-selectivity` (Physical) is the primary stamp — the one the physical and PostOptimization cost readers consult.
- `filter-selectivity-restamp` (PostOptimization, registered first in that pass) recovers the estimate for a Filter whose predicate PostOptimization itself rewrote: `scalar-subquery-cache` wraps an uncorrelated scalar subquery's inner in a `CacheNode`, which (bottom-up) re-mints every scalar ancestor up to the Filter's predicate. It has to run *inside* that pass rather than merely after it, because the cost readers later in the pass (`join-physical-selection`, `key-set-seek`, the materialization advisory) read the stamp.
- `filter-selectivity-final` (Final Estimates, order 37 — see [Optimizer § Pass 3.7: Final Estimates](optimizer.md#pass-37-final-estimates-bottom-up-order-37)) is the backstop behind every plan-mutating pass. It recovers the estimate for a Filter re-minted by the **Materialization** advisory (order 35), which rebuilds every path on which it marks a `with` clause for shared materialization or injects a `CacheNode`: without it, `with c as materialized (select cat, qty from o) select * from o where o.qty = (select max(qty) from c) and o.cat = 'a'` reached emission on the flat 0.5 while the same query without the hint stamped `1/ndv(o.qty)` — two spellings of one query disagreeing. A `CacheNode` newly sitting under the Filter does not block the re-derivation: both `extractRowSourceTableSchema` and `collectColumnOrigins` descend generic single-relation wrappers, so the recovered number is the one the Physical pass produced.

The rule declines immediately on an already-stamped Filter, so the second and third registrations only ever fill in a dropped estimate — re-deriving it against the *new* predicate rather than carrying the stale one forward — and cost one declined call per surviving Filter. A Filter that is permanently unstampable (computed projection, set-operation output, un-analyzed table) cannot short-circuit on a stamp that will never exist and pays the origin walk once per registration.

**Base-table row estimates.** `TableReferenceNode.estimatedRows` — the number every full-relation access node (`SeqScanNode`, `IndexScanNode`, `RetrieveNode`) inherits as its scan cardinality, and the number `rule-select-access-path` passes down as `BestAccessPlanRequest.estimatedRows` for the module to price against — is statistics-first: `table.statistics?.rowCount ?? table.estimatedRows`, i.e. the count `ANALYZE` last collected, falling back to the static schema estimate (0 unless a vtab module supplies one) only when the table has never been analyzed. The logic lives in one place, `catalogRowCount` (`planner/stats/table-cardinality.ts`), which both the node getter and `CatalogStatsProvider.tableRows` call, so the base-cardinality number used for scan costing and the number used for selectivity's denominator cannot disagree. A table that was never `ANALYZE`d is unaffected — no statistics means no plan change.

**Statistics across DDL.** Column statistics only ever describe columns the table currently has. `Schema.addTable` enforces that on every registration (`pruneStaleColumnStatistics` in `schema/table.ts`): an entry whose key names no column of the schema being registered is dropped before the catalog write. This is the one seam every registration passes through — `CREATE TABLE`, each vtab module's `alterTable` return value, `ANALYZE`'s own write, and the store's reopen-time stamp — and it has to be enforced there rather than per-module, because each module's ALTER arms build their result schema independently and the engine installs it verbatim. `rowCount` is untouched: no column-level ALTER changes it.

Because the prune means registration is not always the identity, `addTable` returns what it actually registered, and a DDL arm that goes on to *announce* the schema must announce that return value. `runDropColumn` is where this bites: the drop frees a column name, so the prune fires, and a `table_modified` listener handed the unpruned copy caches it — the store module does exactly that — from which the next `ADD COLUMN` reusing the freed name rebuilt the dropped column's measurements into its own result.

`RENAME COLUMN` is the one form that *keeps* its measurements: `runRenameColumn` re-keys the renamed column's entry from the old name to the new one, reading the pre-ALTER catalog schema rather than the module's return value (`carryStatisticsAcrossColumnRename` in `runtime/emit/alter-table.ts`), so the same code repairs the store backend (which copies statistics across, stranded under the old key) and the memory backend (which returns a schema carrying none). `ALTER COLUMN … SET DATA TYPE` deliberately does not carry them: a type change rewrites values, so the old min/max and histogram would describe values the column no longer holds.

The store persists its `ANALYZE` snapshot keyed by column name, and a name freed by a rename or a drop can be taken again by a later `ADD COLUMN` — at which point the catalog-side prune cannot help, because the stale key names a column that genuinely exists. `StoreModuleAlter.alterTable` therefore has the store move or remove the persisted entry at the moment the name is freed (`StoreTableBase.remapPersistedColumnStatistics`), so the correction survives a close and reopen.

**Detecting that statistics have gone stale.** The catalog number above is a snapshot from the last `ANALYZE`; nothing in the plan pipeline notices when the table has since drifted away from it. `AutoAnalyzeManager` (`core/database-auto-analyze.ts`) supplies that missing signal. It counts, per base table, the distinct rows committed transactions have changed since statistics were last collected, and calls the statistics stale once that count reaches `max(auto_analyze_min_mutations, auto_analyze_ratio × knownRowCount)` — the SQL Server / PostgreSQL autoanalyze shape, defaulting to 500 + 20%.

The counts are free: `TransactionManager` already maintains a per-transaction change log (base table → primary key → captured row) on every write path, so the count for a table is the `size` of its inner map summed over the base layer and each live savepoint layer, read post-commit while that log is still alive. Nothing is added to the write path. Three properties follow from the source rather than from any code here — a rolled-back savepoint's layer is popped before the reading, ten updates of one row coalesce to one changed row, and an insert-then-delete of the same key nets to nothing — and one deliberate approximation: a key changed in two live savepoint layers counts twice, because deduplicating would cost a scan and this is a heuristic, not an invariant. Counters are per-process and not persisted, so drift that happened while the process was down is invisible until the table drifts again.

A crossing arms a short debounce timer, and the timer runs `analyze <schema>.<table>` through `Database.exec` — the ordinary statement path, so there is one implementation of statistics collection and the refresh queues on the same execution mutex every statement uses instead of racing it. Crossings that arrive while a refresh is armed or running are absorbed into it, so a bulk load costs O(1) refreshes rather than one per commit, and a per-table cooldown proportional to the last refresh's duration caps a table's automatic `ANALYZE` at a fixed fraction of wall-clock time. A refresh is skipped for a table above `auto_analyze_row_limit`, and deferred while a transaction is open — an explicit `BEGIN` and equally the implicit transaction any writing statement runs inside — because collecting inside one would fold uncommitted rows into the statistics. A deferred refresh reschedules itself on a geometric backoff, a bounded number of times, so a wakeup that merely landed mid-statement is postponed rather than lost; once that budget is spent the crossing is dropped and the next commit that touches the table re-arms. The counter is left alone in all of these cases, so the staleness stays visible. The refresh cannot trigger itself — `ANALYZE` performs no DML and publishes through the catalog notifier, so its own commit advances no counter. `auto_analyze` gates the whole mechanism and defaults on; see `docs/sql-txn.md` §9.5 for the user-facing description.

**Where a module's own size fits.** `catalogRowCount` reads the catalog only; nothing calls `VirtualTable.getStatistics()` during planning, so a module's live size never reaches the engine-side cost model between `ANALYZE`s. What a module *can* do is answer for its own access path: `rule-select-access-path` passes the catalog number down as `BestAccessPlanRequest.estimatedRows` (`|| undefined`, so a never-analyzed table's 0 arrives as "unknown"), and a module that knows its size may substitute it there — `StoreModule` does, from the row count its write paths maintain. That closes the access-path half only; join ordering, cache thresholds and sort costs still read the catalog and still need an `ANALYZE`. Note the asymmetry a module must respect in the other direction: `BestAccessPlanResult.rows === 0` on a plan that claims at least one filter handled is a *claim* that the plan's predicate is unsatisfiable — `selectPhysicalNode` replaces the access with an empty relation on it — not a report that the table is currently empty. The claimed-filter requirement is what keeps the fold off a plain full scan, whose `handledFilters` list is empty and whose `every(...)` is therefore vacuously true.

**Where a module's own SELECTIVITY fits.** The row count is only half of what a module needs to price its own access path; the other half is what fraction of it a predicate keeps. `getBestAccessPlan` is handed the `TableSchema`, so `tableInfo.statistics` — the same `TableStatistics` `CatalogStatsProvider` reads — is already in scope, and a module may consume it directly. The rule a module must follow if it does: **its `rows` for a predicate has to be the number this provider would produce for the same predicate**, because the seek's advertised `rows` and the estimate a residual `Filter` above it carries describe the same row set. Two different numbers have the optimizer comparing two different worlds. `selectivityFromHistogram` and `combineConjunctive` are exported from the package root for exactly that reason — a module restating either formula is how the two estimates drift apart.

`StoreModule` is the worked example (`packages/quereus-store/src/common/store-module-access-plan.ts`). Each index arm resolves its own estimate: `1 / max(distinctCount, 1)` per equality column, the histogram's verdict per range bound (two bounds on one column combining as `max(0, low + high - 1)`, the same BETWEEN arithmetic `estimateLeaf` uses), folded together with `combineConjunctive`. When the numbers are not there — no `ANALYZE`, a column added since the last one, or a snapshot taken while the table was still empty (`rowCount` 0 describes nothing, and this provider short-circuits it too) — the arm falls back **wholesale** to the shape constant it used before (equality 10% of the table, prefix-equality-plus-bound 15%, leading-column range 30%), never mixing a measured factor with a guess. Three of the module's cost decisions key off which of the two produced the estimate:

- a multi-seek charges its per-resolved-row cost only when the estimate is real, because the fallback's `min(N, K × 0.1N)` union saturates at ten seek keys and is a clamp rather than an estimate past that;
- the module's own seek-versus-scan comparison judges a real estimate at the backend's declared cost profile and a shape constant at the parity profile — a fixed fraction of the table makes that comparison arm-*disabling* rather than arm-tuning, since the arm's cost is then linear in the table size for every query;
- and the comparison is skipped entirely for a request carrying `runtimeSet`, whichever arm serves it (see [Module Authoring § Runtime-valued `IN` sets](module-authoring.md#2-index-based-access-standard)).

The practical consequence for a user: `ANALYZE` can now change which index a store-backed query uses, and can make a key-set semi join stop rewriting where the seek keys approach the table's own row count. It never changes the rows returned — every arm the comparison drops leaves its filters unclaimed, so the residual `Filter` survives.

The memory module follows the same rule for its **equality** arm (`estimateEqualityRows` in `vtab/memory/module.ts`): a unique index — or the `_primary_` pseudo-index, which carries no `unique` flag and is recognised by name — matches at most one row per seek key; otherwise `1 / max(distinctCount, 1)` per equality column through `combineConjunctive`, falling back wholesale to the same 10%-of-table shape constant, and clamped so a seek never advertises more rows than the table holds. Its other arms (leading-column range, prefix-range, OR-range) are still shape constants of the table size. Note what the equality arm is estimating: `AccessPlanBuilder.eqMatch(n)` derives both cost and rows from one argument, but the two answer different questions — cost scales with the number of seek KEYS, rows with the number of rows MATCHED — so the module passes the key count to `eqMatch` and overrides `rows` separately. On a non-unique index the two differ by the number of rows sharing each key.

One shape the memory module does not have, and the store does: a **seek-versus-scan comparison**. An equality seek matching a large fraction of a memory table still prices below a full scan (`0.5 + rows × 0.3` against `rows × 1.0`). Harmless while the estimate is the shape constant, and the advertised row count is honest either way; if a fat seek over an `ANALYZE`d memory table ever shows up as a slow plan, the comparison is the fix.

**What a physical seek node reports.** `IndexSeekNode.computePhysical` relays the module's `rows` for the plan it chose (reaching it as `filterInfo.indexInfoOutput.estimatedRows`) rather than deriving a number of its own — that estimate is the input to join-algorithm selection, cache admission, sort costing and aggregate cardinality above the seek. `rule-select-access-path` builds the field as `accessPlan.rows || 1000`, so "the module supplied no estimate" has already collapsed to 1000 before the node sees it; that `|| 1000` is the sole no-answer fallback, and both shipped modules always set `rows`. The node adds exactly one claim of its own: a seek whose keys pin every primary-key column **once** returns at most one row, encoded as the singleton functional dependency `∅ → all columns`. A multi-key seek (`where id in (1, 2, 3)`) is not that seek and gets neither the forced count nor the dependency.

**Which source qualifies for the single-table path.** The rule picks it via `extractRowSourceTableSchema` (`planner/util/key-utils.ts`), the *strict* sibling of `extractTableSchema`. Both walk single-relation wrappers down to a base table, but the strict one declines at any operator whose output rows are not its source's rows — a set operation, a recursive CTE, or an aggregate (`changesRowPopulation` in `planner/util/row-population.ts`, shared with `collectColumnOrigins` so the two cannot drift). This matters because such an operator's output rows are a *different population* from its source's, so no fraction of the base table describes them at all: over `select cat, count(*) as ct from o group by cat having ct > 2` the permissive walk reaches `o` through the aggregate, but `o`'s row count and column distributions say nothing about how many GROUPS survive `ct > 2`. Declining hands control to the multi-relation path, which finds no base-table origin for an aggregate output and leaves the Filter on the 0.5 default. A `having` on a *group key* is unaffected: `rule-aggregate-predicate-pushdown` moves it below the aggregate first, where it genuinely sits over the base table's rows. `Distinct`, `LimitOffset`, `OrdinalSlice` and the physical access nodes are *not* in `changesRowPopulation` — their output is a subset of the base table's rows, so the base-table fraction stays a defensible approximation. The permissive `extractTableSchema` is unchanged, and answers the different question "which table does this subtree read". It has no production caller of its own today: FK/key analysis needs the output-column → table-column map as well as the schema, and so goes through `resolveTableColumnMapping` (`planner/util/ind-utils.ts`) instead — see "Output indices are not table column indices" in `optimizer-rule-families.md`.

**Boolean decomposition.** `CatalogStatsProvider` estimates recursively over the predicate's boolean structure (`planner/stats/catalog-stats.ts`), so `a = 1 and b = 2` combines two per-column estimates instead of collapsing to one flat guess:

- **`AND`** — flatten with `splitConjuncts`, estimate each, combine the ones that produced a number. A conjunct the provider cannot estimate counts as selectivity `1.0` (no reduction claimed) rather than as the naive `0.1`: the naive number is fabricated, and multiplying it in biases the estimate downward, whereas over-estimating surviving rows is the safer error direction for plan choice. A conjunct that produced only a *lower bound* (a partly-known `OR`, below) counts as unknown for the same reason — folding a floor into the product would drag the result down. If *every* conjunct is unestimable the provider returns `undefined` and the whole-predicate naive fallback runs as before.
- **`OR`** — flatten with `splitDisjuncts` and combine with independence, `1 - Π(1 - sᵢ)`, when every disjunct is estimable. When at least one disjunct is unestimable but at least one is not, the walk reports a **lower bound** instead of an estimate: `a or b` keeps at least as many rows as `a`, so the most permissive readable branch floors the whole disjunction. `selectivity` then returns `max(naive guess, floor)` — keeping the naive number's caution (an unread branch may match far more rows than the read one) while never contradicting statistics already in hand. The floor is `max(sᵢ)` over the readable branches, *not* their disjunctive combination: `1 - Π(1 - sᵢ)` assumes the branches do not overlap, which is an estimate rather than a proof. The floor is exact only when the branch it came from is: a readable branch that is itself an `AND` with a dropped conjunct reports an upper bound of its own value, so the floor can sit above the truth — the same over-estimate direction `AND` already takes deliberately. A partly-known `OR` still reads as `undefined` to `statsOnlySelectivity` — a floor is not an answer, and that method is the multi-relation path's statistics gate.
- **`NOT`** — `1 - inner`; `undefined` propagates, and so does a lower bound, since negating one yields an *upper* bound that nothing downstream models.
- Recursion is capped at `MAX_BOOLEAN_DEPTH` (16); anything else is a leaf and goes through the existing per-node column-statistics switch.

Conjuncts are combined by **exponential backoff** rather than the textbook independence product (`planner/stats/selectivity-combine.ts`). Selectivities sort ascending, the four most selective participate, and each subsequent factor is damped by a further square root:

```
s₁ · s₂^(1/2) · s₃^(1/4) · s₄^(1/8)
```

Plain independence collapses too fast for real workloads (five conditions at 0.1 each give 1e-5) because predicates are correlated far more often than not; backoff needs no correlation statistics and reduces to plain independence for a single conjunct. Once two or more selectivities are actually combined the result floors at `1 / rowCount` — never fewer than one surviving row. Conjuncts on the *same* column (`a > 1 and a < 10`) are still not paired into a single range, so that case remains over-selective, just less so.

**Filters over a join.** `rule-filter-selectivity` has a second path for a Filter whose source spans several base tables. `rule-join-predicate-pushdown` moves every conjunct that lands entirely on one never-null-extended side down onto that branch, where the *single-table* path estimates it better, so `... o join r on … where o.status = 'shipped' and r.name = 'EU'` no longer reaches this path at all — each side gets its own Filter. What stays above, and needs this path: a cross-side conjunct (`o.qty > r.qty`), a conjunct carrying a subquery, a conjunct over an outer join's null-extended side, and everything over a `full` join. That path splits the predicate with `splitConjuncts`, attributes each conjunct to the relation(s) its columns come from, estimates each independently, and folds the results with the same exponential backoff.

The per-conjunct estimation machinery lives in `planner/stats/conjunct-selectivity.ts` (`estimateConjunctSelectivity` / `makeColumnStatsResolver`), shared with `rule-filter-conjunct-ordering` so the two cannot drift. The estimator works off `collectColumnOrigins`, which populates for a one-table source exactly as for a join, so the ordering rule calls it regardless of how many tables sit under the Filter and gates on `statsOnlySelectivity` on **both** single-table and multi-relation sources. The single-table *stamping* path here deliberately still does not — it hands the whole predicate to `selectivity` (naive fallback allowed), as it always has, because its output feeds `estimatedRows` and every physical cost reader.

Attribution uses `collectColumnOrigins` (`planner/util/column-origins.ts`), which maps each attribute id reachable under the Filter's source back to the base-table column that minted it. Origins are keyed on a **relation instance** (`ColumnOrigin.relation`, an opaque token compared by reference and never dereferenced), not on the `TableSchema`: a self-join produces two relation instances sharing one schema object, and collapsing them would mis-read `a.age > b.age` as a single-table predicate. A `TableReferenceNode` is its own instance. Attributes minted *above* a base table — computed projections, aggregate outputs, `values` rows, join existence flags — are deliberately absent from the map, so a conjunct over one of them is skipped rather than mis-attributed by column name.

The same map backs the `ColumnStatsResolver` handed to the provider, on **both** paths — so the map is now built once per Filter regardless of which path runs. Each call site narrows it to the origins that call is entitled to: the single-table path accepts origins of the one table the strict walk found; a single-relation conjunct accepts only origins of the one relation instance it touches (instance identity, so the two sides of a self-join — or of a CTE self-join — stay separate); a cross-relation conjunct accepts any, both of its origins having already been resolved and stats-checked by identity.

The walk also stops at a **row-merging operator** — a set operation, a recursive CTE, or an `AsyncGatherNode` whose combinator is `unionAll` (`isRowMerging` in `planner/util/row-population.ts`). All three *forward* their left / base-case / first-branch attribute ids (see `analysis/attribute-provenance.ts`) while the rows behind those ids come from every branch, so one branch's column statistics do not describe the merged relation. Descending would attribute `union all` output to the left branch alone; instead nothing under such a node is recorded, and a conjunct over it reads as unknown. The gather case matters because `rule-async-gather-union-all` (PostOptimization) *replaces* the `SetOperation` node outright on high-latency plans, leaving nothing else to recognise — and `filter-selectivity-restamp` runs in that same pass. The gather's other combinators are not row-merging: `crossProduct` concatenates every branch's own ids and `zipByKey` mints fresh ids for the merged key columns. A join whose *other* side is a plain table is unaffected — that side's conjuncts still estimate normally.

**A CTE reference publishes its own relation instances.** The walk does not descend through a `CTEReferenceNode` either, but for the opposite reason: the node republishes its body's columns under *fresh* attribute ids, so descending would record ids nothing above the reference uses. It instead maps the body's origins positionally onto the reference's own ids — `CTEReferenceNode` builds its attribute list one-for-one from `CTENode`'s, and `CTENode` forwards its source's ids verbatim, so index *i* names the same column on both sides. Crucially the republished origins get a relation instance minted **per reference**, one per underlying relation, because two references to one `with` clause share a single body subtree: pairing them with the body's own instances would make both arms of `with c as (select * from o) select … from c a join c b …` the same relation, and `a.qty > b.qty` would read as a single-relation predicate comparing a column to a constant. A column the body *computed* simply has no origin, exactly as for the equivalent inline subquery, so the estimate does not depend on the alias spelling. A body whose own rows are merged or regrouped stays opaque through the reference: a recursive CTE is rejected by `isRowMerging` at the reference itself, and a `union all` or `group by` inside a non-recursive body contributes no origins for the remap to find.

Per conjunct:

- **one origin relation** — `context.stats.statsOnlySelectivity(table, conjunct)`, the same estimate a single-table filter gets but without the naive fallback (see the gate below).
- **two origin relations**, a plain binary comparison with a bare column reference on each side — `=` uses `joinSelectivity(left, right, conjunct)` (the table owning the conjunct's *left* child is passed first, since `extractEquiJoinColumns` and the FK→PK check read left/right positionally); `!=` uses `1 - joinSelectivity(…)`; `<` `<=` `>` `>=` use `CROSS_RELATION_INEQUALITY_SELECTIVITY` (1/3, the uniform-distribution estimate — there is no cross-table histogram to do better with).
- **anything else** — three or more relations, no column references at all, a reference to a non-base attribute — skipped. If no conjunct produces a number the Filter is left unstamped.

**Statistics gate (multi-relation path only).** `context.stats.selectivity` always returns a number for a stats-less table, because `CatalogStatsProvider` falls through to `NaiveStatsProvider`. Stamping that would replace 0.5 with 0.1 on essentially every filter-over-join, including in the many tests that never run `ANALYZE`, churning plan shapes with no information behind the change. So the multi-relation path counts a conjunct as known only when real statistics answer it: a single-relation conjunct goes through `statsOnlySelectivity`, and a cross-relation conjunct requires `columnStats` for *both* compared columns before `joinSelectivity` is consulted (table-level `statistics` alone is not enough — `joinSelectivity` has its own naive fallback for a missing distinct count). The one deliberate exception is a cross-relation `!=` / `<>`: the catalog models only `=`, so the complement rides on the naive join estimate, which is capped at 0.5 — bounding the result to `[0.5, 1]`, where it can only relax the estimate, never claim an unsupported reduction. The single-table path is deliberately *not* gated — it keeps its existing behaviour of stamping a naive number when that is all there is.

**The number the selectivity multiplies.** A selectivity is only useful if the cardinality underneath it is a real number. Every relational node carries two row counts — the **logical** `estimatedRows` getter (available before optimization, derived from the *logical* children) and the **physical** `physical.estimatedRows` (folded bottom-up during the Physical pass). They diverge the moment a `Retrieve` subtree becomes a physical access node: `SeqScanNode` / `IndexScanNode` / `IndexSeekNode` declare no `estimatedRows` getter, so any logical read through one yields `undefined` while its physical property holds the catalog-derived count. A `computePhysical` that estimates from `this.source.estimatedRows` therefore drops the count for the whole plan above it. `physicalSourceRows` (`planner/util/row-estimates.ts`) is the one-line reader every `computePhysical` uses instead: physical count first, logical getter as fallback. Nodes whose estimate is a *formula* over the source count (aggregate, distinct, limit, ordinal slice) keep that formula in a single private `rowsFrom(sourceRows)` shared by the getter and `computePhysical`, so the logical and physical readings cannot drift apart. The three aggregate flavours (`AggregateNode`, `HashAggregateNode`, `StreamAggregateNode`) delegate that formula to the shared `aggregateRowsFrom(sourceRows, grouped, groupDivisor)` in the same file, so their only intended difference is the rows-per-group each assumes (2 for the logical node, 10 for the physical pair).

For a join the same rule applies to both sides, and there is a second gap to fill: `analyzeJoinKeyCoverage` only returns a number when it can *prove* a cap (an equi-predicate covering a unique key bounds the output at the other side's row count). Everywhere else — no key coverage, full outer, semi/anti — `joinPhysicalRows` (`planner/nodes/join-utils.ts`) falls back to the `estimateJoinRows` heuristic over the same physical inputs, floored to whole rows. A proven cap of `0` is kept as an answer, not treated as unknown. All three join shapes (the logical `JoinNode` that also serves as the nested-loop physical join, `BloomJoinNode` = hash join, `MergeJoinNode`) go through it.

Two things a *consumer* of these numbers has to know. **Not every node relays.** The single-source operators and the join family do; a set operation (`union`/`union all`/…), an `AsyncGatherNode`, a CTE reference and the data-modifying nodes stamp nothing, so the count still dies above them (backlog `debt-row-estimates-die-at-set-operations`). Read a missing estimate as *unknown* and fall back, rather than treating the subtree as small. **A 0 is also unknown, not empty.** `SchemaManager` hardcodes `TableSchema.estimatedRows` to 0 at CREATE TABLE, so a never-`ANALYZE`d table reports 0 rows — and that 0 now travels the length of the plan instead of dying at the first operator. Threshold consumers that floor (the cache threshold's min of 1000) or use a `>` test are unaffected; a consumer that reads the number as a magnitude must spell 0 as unknown, as `vtab/memory/module.ts` does with `request.estimatedRows || 1000`. `rule-cte-optimization` does not, which is its own bug (backlog `bug-cte-cache-gate-reads-unknown-as-empty`). The corollary binds *relaying* nodes just as hard: a formula that floors must not floor a 0 up, or it launders unknown into a confident magnitude and every `|| default` guard above it stops firing. `aggregateRowsFrom` returns 0 for a grouped aggregate over 0 source rows for exactly this reason (0 rows in also genuinely means 0 groups out) — before it did, `rule-join-physical-selection` costed a 1x1 join and kept the nested loop wherever both sides were grouped aggregates over never-`ANALYZE`d tables.

**Simplifications.** Join type is ignored: a `left`/`right`/`full` join emits NULL-extended rows, which makes a predicate on the non-preserved side more selective than the base-table fraction suggests and one on the preserved side less so, but the base fraction is applied either way. An `aggregate` between the Filter and the join forwards group-key attribute ids unchanged, so a predicate on a group key is attributed to its base table and its base-table fraction is applied to post-aggregate cardinality — imprecise, not unsound. Multi-column correlation within one table remains out of scope (backlog `feat-multi-column-correlation-stats`).

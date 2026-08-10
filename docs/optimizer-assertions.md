# Optimizer Assertion Analysis

> **Stability: Internal** — see [Stability Tiers](stability.md#tiers).

The analysis half of delta-driven features: deciding, for one table reference inside a
plan, whether a change to that table can be re-checked by binding a key (cheap) or
only by re-running the whole query (expensive). The runtime half — change capture,
the savepoint-layered log, and the `DeltaExecutor` kernel that runs the residuals —
is [Incremental Maintenance](incremental-maintenance.md).

## Row‑specific vs Global Classification for Assertions

### Problem Statement

Global transaction‑deferred integrity assertions are expressed as violation queries that return rows when a constraint is broken. To avoid full re‑evaluation on every COMMIT, we must:
- Classify each table reference instance in an assertion plan as row‑specific (≤1 row per changed key) or global (potentially many rows)
- Track per‑transaction changes keyed by table instance
- Execute efficient delta checks: full scan only when necessary; otherwise run parameterized checks per changed key

### Core Definitions

- relationKey: Unique identifier for a table reference instance within a plan. Format: `schema.table#<nodeId>` or `schema.table@alias#<nodeId>`.
- unique key: A set of column indices on a node's output that uniquely identifies each row. Encoded as the FD `key → (all_cols \ key)` in `PhysicalProperties.fds`. The empty set (`∅ → all_cols`) is the singleton/"at-most-one-row" form.
- coveredKey: A unique key that is fully constrained by equality predicates at a node boundary, **or whose columns lie in the FD-closure of the equality-covered column set**. Presence of a covered key implies `estimatedRows ≤ 1`. Closure expansion uses the table reference's physical FDs/ECs — so equality on a UNIQUE column closes to the PK via the table's `unique → other-columns` FD, and equality on column `a` plus an EC `{a, b}` closes to include `b`.
- Row‑specific: A table reference instance classified as producing at most one row for any given unique key binding at COMMIT time (covered-key holds and no identity-breaking node above demotes it).
- Group-specific: A table reference instance beneath an aggregate whose `GROUP BY` columns (under FD closure at the aggregate's source) cover a unique key of the reference. The aggregate output is row-unique per group key, so the runtime can parameterize on changed group keys.
- Global: Any instance not provably row- or group-specific.

### Logical Analysis Pipeline

1) Optimizer pre‑physical analysis
- Use an analysis entrypoint that runs constant folding and structural rewrites, stops before physical selection.
- This stabilizes logical shape and enables reliable key propagation without physical access assumptions.

2) Unique key propagation rules
- Filter: If predicate covers a full unique key on the source, emit the singleton FD `∅ → all_cols` and cap `estimatedRows = 1`; otherwise propagate source FDs (which carry the source's key encodings) unchanged.
- Project/Returning: Project source logical keys (`RelationType.keys`) through the column mapping; for each surviving key emit the FD `key → all_other_out_cols`. Source FDs project through the same column map (FDs that lose a determinant column are dropped; surviving dependents stay).
- Join (INNER/CROSS): Preserve side keys when equi‑join predicates cover the other side's key; emit each preserved key as a `key → all_other_join_cols` FD. For OUTER joins, only preserve non‑null‑safe keys on the preserved side.
- Aggregate: `GROUP BY` columns are a unique key on the output; emit `{0..groupCount-1} → all_other_out_cols`. Global aggregates without grouping emit the singleton `∅ → all_out_cols`.
- Distinct: Set semantics is encoded via `RelationType.isSet = true` (the all-columns "key" has no non-trivial FD encoding). Source FDs pass through unchanged.
- Set operations/window functions: Conservatively drop key-encoding FDs unless proven otherwise.

3) Covered key detection
- Constraint extractor emits `coveredKeysByTable: Map<relationKey, number[][]>` by matching normalized equality predicates to the table's logical `RelationType.keys`. Closure expansion uses the table reference's physical FDs/ECs.
- A table reference instance is row‑specific at a node if any covered key is present or the FD set carries the singleton `∅ → all_cols`.

### Classification API

```ts
// Pre‑physical plan only
type RowClassification = 'row' | 'group' | 'global';

interface RowSpecificResult {
  classifications: Map<string /* relationKey */, RowClassification>;
  /** For 'group'-classified relations, the minimal group-key columns expressed as
   *  output column indices on the underlying table reference. */
  groupKeys: Map<string /* relationKey */, number[]>;
}

function analyzeRowSpecific(plan: RelationalPlanNode | PlanNode): RowSpecificResult;
```

Algorithm (concise):
1. **Initial pass.** Traverse plan; collect `TableInfo` for each table reference instance, including its `uniqueKeys`, physical `fds`, and `equivClasses`.
2. **Covered-key under FD closure.** Walk predicates along the path to each instance and gather equality-covered columns `E`. Compute `closure(E)` under the table reference's local FDs + EC-derived FDs. A unique key is covered if every column lies in the closure. Classify as `'row'` if any key is covered, else `'global'`.
3. **Identity-breaking adjustment pass.** Walk the tree top-down:
   - **Aggregate** (`AggregateNode`, `StreamAggregateNode`, `HashAggregateNode`): for each table reference beneath, compute `closure(group-by-bare-cols)` at the aggregate's source physical context (FDs + ECs). If the closure covers a unique key (mapped through the source-to-table column correspondence), classify the reference as `'group'` and store the minimal subset of GROUP BY columns whose closure still covers a key (greedy minimization). If the reference already holds `'row'` (equality cover at a Filter beneath the aggregate), keep `'row'` — it is strictly stronger than `'group'`. Otherwise demote to `'global'`. Aggregate without GROUP BY is single-group: existing classifications survive.
   - **SetOperation**: conservatively demote all references beneath to `'global'`.
   - **Window**: pass-through. Windowing preserves input row count, so the classification at the Filter level survives upward.

Notes:
- Multi‑reference handling: Classify per‑instance via `relationKey`. The same base table may have both row‑specific and global instances in one assertion.
- Joins with equality on a unique key reduce the joined side to row‑specific; push this information upward to avoid false global classifications.
- All three modes (`'row'`, `'group'`, `'global'`) are now driven by the reusable `DeltaExecutor` kernel; `'group'` classifications parameterize per changed group-key tuple. See [`docs/incremental-maintenance.md`](incremental-maintenance.md) for the kernel surface.

### Transaction Change Tracking

Goal: Build a per‑transaction delta of changed rows, keyed by table instance.

Data structures:
- `transactionLog: Map<relationKey | baseTableName, Set<KeyTuple>>`
  - Initially use base table name; after analysis, map to instance `relationKey`s for assertions. For MVP, base table scope is sufficient and simpler.
- `KeyTuple` supports composite keys via ordered arrays of values.

Events captured:
- INSERT: add NEW primary key
- UPDATE: add OLD and NEW primary keys (if key changes)
- DELETE: add OLD primary key

Savepoints:
- Maintain a stack of change sets; on SAVEPOINT push a new layer; on ROLLBACK TO SAVEPOINT discard the top layer; on RELEASE merge.

### Commit‑time Evaluation Engine

High‑level algorithm:
1) Collect assertions impacted by the transaction: `dependentTables ∩ changedTables ≠ ∅` (dependent tables discovered during assertion preparation by examining the violation plan).
2) For each impacted assertion:
   a) Build/obtain pre‑physical plan via analysis entrypoint; run `analyzeRowSpecific(plan)`.
   b) If any dependent reference is classified 'global' AND that base table changed: execute the original violation SQL once. If any row returns → fail.
   c) Otherwise, for each row‑specific dependent table with changes: execute a parameterized variant once per changed key. If any run returns rows → fail early.
3) On first failure: throw `QuereusError(StatusCode.CONSTRAINT)`; the COMMIT path rolls back all connections.

### Prepared, Parameterized Assertion Variants

For each assertion and each row‑specific dependent table reference instance:
- Parameterization: Bind the full unique key (declared PK or any covered unique key) as parameters at the earliest reference to that instance.
- Injection point: Add a Filter on the table’s own attributes with `= ?` parameters; do not restructure joins (no equality‑join injection), allowing the optimizer to infer `IndexSeek` or equivalent logically.
- Metadata: For composite keys, maintain stable parameter order matching the declared key column order.
- Multiple instances: Prepare one variant per row‑specific instance (`relationKey`) to avoid parameter collision across multiple references to the same base table.

Execution strategy:
- For N changed keys of table T, execute the prepared variant N times (MVP). A future enhancement will batch keys via `IN`/`VALUES`.

### Dependency Discovery & Invalidation

During assertion creation/update:
- Parse and normalize the violation expression into a SELECT form `SELECT 1 WHERE NOT (<check>)` if provided as CHECK.
- Plan using analysis entrypoint and extract base tables with `relationKey`s at earliest references; store as `dependentTables` with preliminary classification (updated at COMMIT time to reflect current statistics/rewrites).
- On schema change (table/column/index/constraint) touching any dependent object: mark assertion stale; re‑prepare on next COMMIT or on `VALIDATE ASSERTION`.

### Diagnostics & Tooling

- `explain_assertion(name)` TVF: returns normalized SQL plus concise logical plan (pre‑physical) and the classification map `{ relationKey → 'row' | 'group' | 'global' }`. The `prepared_pk_params` column lists the parameter names a parameterized variant would bind: for `'row'`, PK column names (`pk0`, `pk1`, ...); for `'group'`, the minimal group-key column names from `RowSpecificResult.groupKeys`. Both modes are now executed by the `DeltaExecutor` kernel at COMMIT time.
- Error formatting on violation: include assertion name and up to N sample violating key tuples when available from parameterized runs.

### Guarantees and Safety

- Classification is conservative: when uncertain, classify as 'global' to preserve correctness.
- Parameterized execution binds only table‑local attributes; no cross‑relation value injection is required for correctness.
- Transactional semantics: Assertions run atomically before commit; failures rollback all connections.

## Binding-aware Delta Planning (Reusable)

The same analysis used for assertions generalizes to reactive watches, the lens layer, and other delta-driven features. `analyzeRowSpecific` returns a `RowSpecificResult { classifications, groupKeys }`; `extractBindings` packages that into a `PlanBindings { perRelation, relationToBase }` map of `BindingMode` per `TableReferenceNode` instance. The full runtime surface is documented in [`docs/incremental-maintenance.md`](incremental-maintenance.md).

The **public** projection of this analysis is the `ChangeScope` data contract — a JSON-serializable description of "what state does this prepared statement depend on?". `Statement.getChangeScope()` returns one for any prepared statement; see [`docs/change-scope.md`](change-scope.md). One refinement lives at this boundary: a read of a materialized view resolves to a reference on its (never-user-written) backing table, so the analyzer projects it onto the MV's source tables — `getChangeScope()` reports (and `Database.watch` fires on) *source* mutations rather than the backing table. See [`docs/change-scope.md` § Materialized-view reference projection](change-scope.md#materialized-view-reference-projection).

### Modes of Specificity
- Row-specific (`'row'`): unique key fully covered (under FD closure including FK→PK and EC-derived FDs); bind PK/unique key columns.
- Group-specific (`'group'`): aggregate `GROUP BY` columns (under FD closure at the aggregate's source) cover a unique key of the underlying table reference; bind the minimal group-key column subset (`groupKeys[relKey]`). Group-membership transitions (when an UPDATE changes a captured column) drive OLD/NEW projection emission so both old and new group keys are re-evaluated.
- Global (`'global'`): no safe binding → evaluate full query once.

### Binding Extraction
`extractBindings(plan)` (see `src/planner/analysis/binding-extractor.ts`) walks the plan once, runs `analyzeRowSpecific`, and emits one `BindingMode` per `TableReferenceNode`:
- From predicates: equality that covers a declared/inferred unique key.
- From aggregations: grouping keys whose closure covers a unique key.
- From joins: propagate bindings through equi-joins; when `T.k = U.k` and `k` is a binding key on `T`, it binds `U` as well.

For `'row'` bindings, the chosen key prefers the table's primary key when it's among the covered keys; otherwise it picks the lex-min covered key for determinism.

### Residual Construction
- Do not rewrite joins structurally; inject a Filter on the bound relation’s own attributes with `= ?` parameters (`injectKeyFilter` in `database-assertions.ts`).
- Preserve attribute IDs; parameter order follows key column order. `'row'` parameters use the prefix `pk0..pkN-1`; `'group'` parameters use `gk0..gkN-1`.
- Each consumer owns its residual cache, keyed by `(relationKey, BindingMode.kind, columnsJoined)`.

### Runtime execution

The runtime side — how a `DeltaSubscription` is registered, how capture demand and
the savepoint-layered change log work, the cost-fallback-to-global rule, and the
plug-in pattern for new consumers — is documented in
[Incremental Maintenance](incremental-maintenance.md). This section is only the
*analysis* half: classifying references and choosing binding keys. The live
consumers are assertions and `Database.watch`; the [lens layer](lens.md) consumes
the kernel for set-level constraint maintenance/enforcement where no covering
structure answers it; triggers/signals are future consumers. Materialized views are
maintained synchronously at the DML write boundary, **not** through this kernel (see
[Materialized Views](materialized-views.md)).

This places “what to bind” in the optimizer and “when/how to execute residuals” in the runtime, enabling reuse across features.

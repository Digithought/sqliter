## Project TODO List & Future Work

This list reflects the current and upcoming work for Quereus. Completed items and status fluff have been removed to keep this focused on actionable tasks.

## 🏗️ Titan Optimizer Implementation Progress

### In Progress
- 🔄 **Phase 1.5 - Access Path Selection**: Seek/range scan infrastructure and optimization rules

### Upcoming Optimizer Work
- 📋 **Subquery Optimization**: Transform the *remaining* correlated subquery shapes to joins. Already shipped: correlated `EXISTS`/`IN` → semi/anti join (`subquery-decorrelation`) and correlated scalar-*aggregate* subqueries → grouped LEFT join, in the SELECT list (`scalar-agg-decorrelation`), inside an enclosing aggregate's arguments (`-aggregate`), and in WHERE/HAVING filter predicates (`-filter`). Still uncovered: correlated *non-aggregate* scalar subqueries (e.g. `... ORDER BY ... LIMIT 1`), and non-equi correlations (`c.pid < p.id`).
- 📋 **Advanced Statistics**: VTab-supplied or ANALYZE-based statistics
- ✅ **Join Algorithms**: Bloom joins and merge joins
- 📋 **Aggregate Pushdown**: Push aggregations below joins when semantically valid
- 📋 **Key-driven row-count reduction**: With better key inference, cardinality can be better estimated and efficiencies gained
  - 📋 FK→PK join inference: derive keys when ON aligns a PK with an inferred unique set on the other side (e.g., via DISTINCT/GROUP BY)
  - 📋 Optimizer exploitation: prefer join strategies and pruning using `[[]]` and preserved keys

## Stand-alone isolation layer optimizations

See `docs/design-isolation-layer.md`

## 🔄 Current Development Focus

- [ ] Need to update the BNF in sql.md

### Language roadmap (relocated from the SQL reference §11.4)

Quereus is actively developed with plans to add:
- Advanced window function features (navigation functions, window frames)
- Enhanced recursive CTE capabilities
- More query planning enhancements

- [ ] Our constraint system can't enforce a certain class of constraints that require access to the before AND after state of the transaction (e.g. a certain row must have been removed).  Design a system to enable this.  Perhaps we have a new class of constrains that runs a query *before* the transaction changes anything, then makes that result set available to the constraint logic running *after*.

### UPSERT Implementation (ON CONFLICT DO UPDATE/DO NOTHING)

Full UPSERT support with column-level updates and result-based constraint signaling.

**Phase 1: UpdateResult Type & VTab API Refactor** ✅
- [x] Define `UpdateResult` type to replace exception-based constraint signaling
- [x] Update `VirtualTable.update()` signature: `Promise<UpdateResult>` instead of `Promise<Row | undefined>`
- [x] Update MemoryTable to return `UpdateResult` with `existingRow` on unique constraint conflicts
- [x] Update `dml-executor.ts` to handle `UpdateResult` (converts constraint violations to exceptions for now)
- [x] Keep `ConstraintError` for truly unexpected constraint failures

**Phase 2: AST & Parser** ✅
- [x] Add `UpsertClause` AST node with `conflictTarget`, `action`, `assignments`, `where`
- [x] Extend `InsertStmt` with `upsertClauses?: UpsertClause[]` (supports multiple)
- [x] Parse `ON CONFLICT ... DO NOTHING` and `ON CONFLICT ... DO UPDATE SET ...`
- [x] Parse optional `WHERE` clause in `DO UPDATE`
- [x] Validate mutual exclusivity: error if both `OR <conflict>` and `ON CONFLICT` present
- [x] `NEW` qualifier already supported via existing column reference parsing
- [x] Add UPSERT clause to `ast-stringify.ts` for round-trip support

**Phase 3: Planner** ✅
- [x] Plan UPSERT as conditional: attempt insert, on unique conflict execute update
- [x] Resolve `NEW.*` references to the proposed insert values
- [x] Resolve unqualified column references in DO UPDATE to existing row values
- [x] Plan the WHERE condition for conditional updates
- [x] Handle multiple ON CONFLICT clauses (match in order)
- [x] Added `excluded.*` alias for PostgreSQL compatibility

**Phase 4: Runtime/Emitter** ✅
- [x] Modify `dml-executor.ts` to handle `UpdateResult` for UPSERT
- [x] On `{ status: 'constraint', constraint: 'unique' }`:
  - If UPSERT with matching conflict target: execute the DO UPDATE path
  - If `DO NOTHING`: skip row, continue
  - If no UPSERT clause: propagate as error (convert to exception for user)
- [x] Evaluate DO UPDATE SET expressions with access to:
  - `NEW.*` bindings (proposed insert values)
  - Existing row values (from `existingRow` in UpdateResult)
- [x] Evaluate WHERE condition; skip update if false
- [x] Issue UPDATE operation to vtab for rows that pass WHERE

**Phase 5: Testing** ✅
- [x] Basic DO NOTHING (equivalent to INSERT OR IGNORE)
- [x] Basic DO UPDATE SET with NEW references
- [x] DO UPDATE with WHERE condition
- [x] Increment pattern: `SET count = count + 1`
- [x] Multiple ON CONFLICT clauses
- [x] UPSERT with RETURNING clause
- [x] Error on mixing OR REPLACE with ON CONFLICT
- [x] Verify unspecified columns preserved (vs OR REPLACE which loses them)
- [x] excluded.* alias for NEW.* (PostgreSQL compatibility)

**Module Updates Required** (after core UPSERT changes): ✅
- [x] `quereus-store`: Update `update()` to return `UpdateResult` instead of throwing `ConstraintError`
- [x] `quereus-isolation`: Update `update()` to return `UpdateResult`
- [ ] `plugin-leveldb`: Update `update()` to return `UpdateResult` (external repository)
- [ ] `plugin-indexeddb`: Update `update()` to return `UpdateResult` (external repository)
- [ ] `plugin-react-native-leveldb`: Update `update()` to return `UpdateResult` (external repository)
- [ ] `plugin-nativescript-sqlite`: Update `update()` to return `UpdateResult` (external repository)

**Query Optimization (Current Priority)**
- [ ] **Phase 3 - Advanced Push-down**: Complex optimization with full cost model
  - [ ] Advanced predicate push-down with sophisticated cost decisions (LIKE prefix, complex OR factoring)
  - [ ] Dynamic constraints: plan-time shape, runtime evaluation of binding expressions
  - [ ] Range seeks: pass dynamic lower/upper bounds and extend Memory module scan plan to use them
  - [ ] IN lists: choose between seek-union or residual handling based on index support and list size
  - [ ] Projection and aggregation push-down optimization
  - [ ] Projection Push-down: Eliminate unnecessary column retrieval (leverage stable attribute IDs and key propagation)

**Design Philosophy: Characteristic-Based Rules**
- Rules target logical node characteristics rather than hard-coded node types
- RetrieveNode is the principled exception (represents unique module boundary concept)
- Phase sequencing ensures each optimization stage has proper cost information
- Structural phases (grow-retrieve) precede cost-dependent phases (complex push-down)

**Core SQL Features (Lower Priority)**
- [ ] **DELETE T FROM ...**: Allow specification of target alias for DML ops
- [ ] **Orthogonal relational expressions**: allow any expression that results in a relational expression in a relational expressive context 
- [ ] Values in "select" locations (e.g. views)
- [ ] Expression-based functions
- [ ] Make choice of scheduler run method determined at constructor time, not in run

**Window Functions (Remaining)**
- [ ] **LAG/LEAD**: Offset functions
- [ ] **FIRST_VALUE/LAST_VALUE**: Navigation functions
- [ ] **RANGE BETWEEN**: Range-based window frames
- [ ] **PERCENT_RANK/CUME_DIST**: Statistical ranking functions

## 🔐 Global Transaction‑Deferred Assertions

Database‑wide integrity assertions deferrable at COMMIT (auto-detected), with efficient row‑level delta checks where provably row‑specific.

- [ ] SQL surface & schema objects
  - [ ] Add `IntegrityConstraint` schema object: name, text/AST/plan of violation query, `dependentTables`, classification per table (row‑specific/global), deferrability, initial mode

- [ ] Dependency discovery & invalidation
  - [ ] During assertion build, resolve base tables referenced by the violation query and store as `dependentTables`. Note that a given table may be referenced multiply by a query; each reference should be regarded independently
  - [ ] Hook into schema change events to invalidate/recompile affected assertions

- [ ] Optimizer analysis: row‑specific vs global (logical, pre‑physical)
  - [ ] Treat `GROUP BY` exactly on a unique key as row‑specific for that table; any aggregation without such grouping is global
  - [ ] Classify presence of windows/set ops (UNION/INTERSECT/EXCEPT/DIFF) as global unless both sides are independently row‑specific

- [ ] Prepared assertion plans (parameterized)
  - [ ] For each assertion and each row‑specific dependent table, compile a parameterized variant of the violation query that binds the table's full unique key at the earliest reference
  - [ ] Maintain binding metadata: table → parameter positions (support composite keys)
  - [ ] For assertions touching multiple tables, prepare one parameterized variant per row‑specific table

- [ ] Commit‑time evaluation engine
  - [ ] Abort commit on first non‑empty result; include constraint name and sample violating keys in error

- [ ] Diagnostics & tooling
  - [ ] `explain_assertion(name)` shows normalized violation query and concise plan (pre‑physical and physical views)
  - [ ] Error formatting: include assertion name and up to N violating key tuples

- [ ] Tests
  - [ ] Parser/DDL round‑trip for assertions
  - [ ] Dependency tracking and invalidation on table/column changes
  - [ ] Row‑specific classification correctness across filters, projections, joins, aggregates, set ops
  - [ ] Commit‑time enforcement for: single‑table FK‑like, multi‑table co‑existence (DIFF), and aggregate‑based global assertions
  - [ ] Savepoint interaction (rollback removes violations)

- [ ] Future enhancements (post‑MVP)
  - [ ] Batched execution: support IN‑list/VALUES parameterization to amortize per‑key runs when many keys change
  - [ ] Optional early (statement‑end) prechecks for single‑table row‑specific assertions to surface errors sooner, still enforcing at COMMIT
  - [ ] Statistics‑aware threshold to choose between per‑key runs vs full scan
  - [ ] Auto‑classify deferrability so users don't need `SET CONSTRAINTS`

## ♻️ Reusable Incremental Delta Runtime (Assertions, Views)

- [ ] Runtime: Delta pipeline kernel
  - [ ] ParameterizedPlanCache keyed by (registrant, relationKey, key-shape)
  - [ ] DeltaExecutor orchestrating global vs per-binding runs with early-exit hook
  - [ ] Savepoint-aware ChangeCapture reuse for COMMIT-time execution
- [ ] Optimizer: Binding-aware analysis
  - [ ] Extend classification with group-specific (GROUP BY / PARTITION BY) keys
  - [ ] Binding propagation across equi-joins to related tables
  - [ ] Residual construction helper to inject `= ?` filters on bound relation
- [ ] Reactive signals / triggers (future kernel consumers)
  - [ ] Register a reactive plan and act on per-binding deltas at COMMIT

> Note: materialized views are **not** a kernel consumer — they are maintained
> synchronously at the DML write boundary (row-time), off this post-commit kernel.
> See [Materialized Views](materialized-views.md).

### Milestones (Implementation Outline)

1) Change tracking: per‑transaction log keyed by base table, integrate with savepoints.
2) Prepared variants: compile and cache per‑assertion, per‑relationKey parameterized plans with binding metadata.
3) Commit engine: orchestrate global vs per‑key execution; early‑fail on first violation.
4) Diagnostics: `explain_assertion()` and enhanced error messages.


## Declarative Schema - Remaining Work (Future Enhancements)

**Planned:**
- [x] Rename detection with `old name` hints and stable `id` matching (tables, columns, named constraints; views/indexes drop+recreate when hinted — see `docs/sql.md` §"Rename detection")
- [ ] Destructive change gating with `allow_destructive` option
- [ ] `validate_only` and `dry_run` modes for safety
- [ ] Import support: `import schema <alias> from '<url>' cache '<key>' version '<semver>'`
- [ ] Local cache registry for offline imports
- [ ] Idempotent seeds with PK/UNIQUE upsert logic
- [ ] Domain and collation declarations
- [ ] Helper TVFs: `schema_diff()`, `schema_objects()`, `schema_hash()`
- [ ] CLI integration in quoomb
- [ ] View and index DDL generation in diff engine
- [x] Advanced rename policies (`rename_policy = 'allow' | 'require-hint' | 'deny'`)
- [ ] Engine-level RENAME primitives for views, indexes, and named constraints (today: drop+recreate)

### Architecture Notes

- **DDL remains primary**: Declarative schema is optional and generates canonical DDL
- **Module-agnostic**: Works with any VTab module, uses standard catalog introspection
- **Safe by default**: Non-destructive operations only (drops require future `allow_destructive` flag)
- **Order-independent**: Forward references allowed within declaration blocks
- **Deterministic**: Schema hash computed from canonical DDL representation
- **Contextual keywords**: `schema`, `version`, `seed` are contextual to avoid breaking `schema()` function or column names

## 🚀 Type System Performance Optimizations

The logical type system enables significant runtime performance improvements by eliminating type detection and enabling type-specific optimizations.

**Comparison System Optimization (High Priority)**
- [ ] **Pre-resolved Comparators**: Eliminate runtime type detection in hot paths
  - [ ] **Memory VTable Primary Keys** (`src/vtab/memory/utils/primary-key.ts`)
    - Replace `compareSqlValuesFast()` with pre-resolved comparator from `pkColumn.logicalType.compare`
    - Store comparator at BTree creation time, not per-comparison
  - [ ] **Memory VTable Secondary Indexes** (`src/vtab/memory/index.ts`)
    - Pre-create array of comparators (one per index column) at index creation
    - Replace `compareSqlValues()` loop with direct comparator array invocation
  - [ ] **Sort Node** (`src/runtime/emit/sort.ts`)
    - Pre-resolve comparators for all sort keys at Sort node creation
    - Store comparators in Sort node metadata
  - [ ] **Join Node** (`src/runtime/emit/join.ts`)
    - Pre-resolve comparators for join keys
    - Use type-specific equality checks instead of generic comparison
  - [ ] **Distinct/Group By** (`src/runtime/emit/distinct.ts`, `src/runtime/emit/aggregate.ts`)
    - Pre-resolve comparators for grouping keys
    - Use type-specific hash functions where applicable
  - **Target**: 2-3x speedup for index operations, joins, and sorts
  - **Files to modify**: `src/vtab/memory/utils/primary-key.ts`, `src/vtab/memory/index.ts`, `src/runtime/emit/sort.ts`, `src/runtime/emit/join.ts`

**Function/Operator Runtime Optimization (High Priority)**
- [ ] **Type-Specialized Implementations**: Use type information to skip runtime checks
  - [ ] **Arithmetic Operators** (`src/runtime/emit/binary.ts`)
    - Use operand types from plan to select specialized numeric operations
    - INTEGER + INTEGER: Direct integer addition without type checks
    - REAL operations: Direct floating-point operations
    - Eliminate `coerceForComparison()` calls (types guaranteed by planner)
  - [ ] **Comparison Operators** (`src/runtime/emit/binary.ts`)
    - Use type-specific comparison from `logicalType.compare`
    - Pre-resolve comparator at node creation time
    - Eliminate runtime type detection in `compareSqlValues()`
  - [ ] **String Functions** (`src/func/builtins/string.ts`)
    - Skip type validation when input types are known at planning time
    - Use type information to optimize string operations
  - [ ] **Aggregate Functions** (`src/runtime/emit/aggregate.ts`)
    - Pre-resolve accumulator types based on input types
    - Use type-specific accumulation logic (e.g., INTEGER SUM vs REAL SUM)
  - **Target**: 1.5-2x speedup for expression evaluation
  - **Files to modify**: `src/runtime/emit/binary.ts`, `src/runtime/emit/aggregate.ts`

**Validation data Boundary Optimization (Medium Priority)**
- [ ] **Entrance-Point Validation**: Validate data only at system boundaries
  - [ ] **Parameters**
  - [ ] **Optionally from modules**

**Type System Enhancements (Medium Priority)**
- [ ] **JSON Type**: Native JSON type with object storage
  - [ ] Define JSON_TYPE with PhysicalType.OBJECT
  - [ ] Implement validation, parsing, and serialization
  - [ ] JSON path queries (`json_extract()`, `json_set()`, etc.)
  - [ ] Indexing JSON properties
  - [ ] Schema validation (optional)

## 📋 Future Development Areas

**Optimizer Enhancements (Near-term)**
- [ ] **Advanced Statistics**: Move beyond naive heuristics to VTab-supplied or ANALYZE-based stats
- [ ] **Sophisticated Cost Models**: Better formulas for complex operations and join algorithms
- [ ] **Plan Validation**: Runtime tree validation to catch optimizer bugs early
- [ ] **Execution Metrics**: Row-level telemetry for verifying cardinality estimates

**Schema & DDL Enhancements**
- [ ] **Foreign Key Constraints**: REFERENCES constraints with cascading actions
- [ ] **Computed Columns**: Columns with derived values
- [ ] **ALTER TABLE**: More comprehensive ALTER TABLE operations
- [ ] **Materialized Views**: Views with cached results
- [ ] **Atomic store catalog rename**: fold the old-entry delete and every dependent
  rewrite into one `provider.beginAtomicBatch` commit, removing the crash residues
  documented in [`store.md` § Catalog persistence](store.md#catalog-persistence-bundled-index-ddl).
  Needs an atomic provider and a larger engine↔module change.

**Runtime — parallel and validation follow-ups**
- [ ] **Per-branch equi-pair surface on `FanOutBranchSpec`**: would let
  `FanOutLookupJoinNode.computePhysical` tighten its ordering/FD derivation without
  changing the emitter (see [`runtime.md`](runtime.md#fanoutlookupjoinnode-per-row-fan-out-lookup-join)).
- [ ] **Relax the connection lock for fully-reentrant modules**: once a module advertises
  `'fully-reentrant'`, the optimizer predicate and the lock policy can refine in tandem
  for that module (see [`runtime.md`](runtime.md#connection-lock-contract-under-impure-subtrees)).

**Performance & Scalability (Medium-term)**
- [ ] **Memory Pooling**: Reduce allocation overhead in hot paths
- [ ] **Query Caching**: Result caching and invalidation strategies
- [ ] **Streaming Execution**: Better streaming support for large result sets
- [ ] **Parallel Execution**: Multi-threaded query execution for CPU-bound operations

**Developer Experience & Tooling**
- [ ] **Enhanced EXPLAIN**: More detailed query plan analysis capabilities
- [ ] **Performance Profiling**: Detailed execution timing and resource usage
- [ ] **Virtual Table Development Guide**: Best practices for creating custom vtab modules

**Testing & Quality (Ongoing)**
- [ ] **Stress Testing**: Large dataset and concurrent operation testing
- [ ] **Fuzzing**: Automated testing with random SQL generation
- [ ] **Performance Benchmarks**: Regression testing for performance
- [ ] **Cross-platform Testing**: Browser, Node.js, React Native environments

**Advanced Features (Long-term Vision)**
- [ ] **Real-time Queries**: Streaming query execution over live data
- [ ] **Graph Queries**: Graph traversal and pattern matching capabilities
- [ ] **Machine Learning Integration**: Built-in ML functions and operators

**Ecosystem Integration**
- [ ] **Database Connectors**: Interfaces to PostgreSQL, MySQL, SQLite, etc.
- [ ] **ORM Adapters**: Integration with TypeScript/JavaScript ORMs
- [ ] **Cloud Platform**: Cloud-native deployment and scaling options
- [ ] **Data Pipeline Integration**: Standard connectors for ETL workflows

---

## 🔁 Push-down & Federation Roadmap (Active Items)

**Phase 2 – Optimization Pipeline Sequencing**
- [ ] **Join Enumeration Integration**: Ensure join rewriting uses realistic cardinality estimates
  - [ ] Verify join cost model accounts for pushed-down predicates
  - [ ] Test that join enumeration benefits from phase 1-2 optimizations

**Phase 3 – Advanced Push-down Optimization**
- [ ] **Advanced Predicate Push-down** (cost-precise phase): Complex predicate optimization
  - [ ] OR-predicate factorisation and split across children
  - [ ] `IN (…)`, `BETWEEN`, NULL test optimizations
  - [ ] Subquery predicate push-down with correlation analysis
- [ ] **Projection Push-down**: Eliminate unnecessary column retrieval
  - [ ] Project only required attributes through module boundary
  - [ ] Coordinate with SELECT list requirements and JOIN dependencies
- [ ] **Aggregation Push-down**: Push GROUP BY and aggregate functions
  - [ ] Simple aggregates (COUNT, SUM, MIN, MAX) for supported modules
  - [ ] Complex aggregation split strategies
- [ ] **Range Seeks**: Pass dynamic lower/upper bounds and extend Memory module scan/seek plan to use them
- [ ] **IN-list strategy**: Choose between seek-union vs residual based on index coverage and list size

**Phase 4 – Correlated push-down (`ApplyNode` proposal)**

Correlated and lateral joins plan as `JoinNode` today; the nested-loop emitter re-executes
the right subtree per outer row and a right-side `RetrieveNode` is re-assessed each time.
(One shape is no longer among these: a correlated scalar-*aggregate* subquery is now
decorrelated into a grouped LEFT join by `scalar-agg-decorrelation`, so it never reaches the
per-row emitter — this proposal is scoped to the still-correlated shapes.)
The proposal replaces that with an explicit `Apply(left, right, predicate, outer)` node —
"execute `right` once per row of `left`, with correlation context threaded through" —
mapping `CROSS`/`INNER`/`LEFT JOIN` onto the same shape and eliminating the per-join-type
special cases. Its value is push-down, not execution: with the correlated operation named,
the optimizer can hand the left row's correlation values to `module.supports()` as extra
constraints, letting a module turn a correlated subquery into one index seek — or ship the
whole correlated pipeline to a remote system. Non-correlated `Apply`s remain free to
become bloom or merge joins in the Physical pass.

- [ ] Introduce `ApplyNode` and build correlated / lateral joins onto it
- [ ] Extend `supports()` with a correlation-constraint channel
- [ ] Teach the memory module to answer a correlated seek through it
- [ ] Retire the `JoinNode` special-casing for lateral once the above lands


## Materialized views

Everything below is unimplemented. The one-line pointers under
[`materialized-views.md` § Current limitations](materialized-views.md#current-limitations)
name each item; the design detail lives here.

**Bounded-delta arms for floor-covered shapes.** A fanning (non-1:1) keyed join, an outer 1:1
join, and a scalar (no-`GROUP BY`) aggregate are maintained correctly by the
[full-rebuild floor](mv-maintenance.md#full-rebuild-floor) but have no *bounded-delta* arm.
These are pure performance refinements — they shrink the rebuild fallback without changing
coverage:

- [ ] Delta-arithmetic aggregate arm (`sum` / `count`), with a rescan-on-retraction fallback for `min` / `max`
- [ ] Null-extending reverse residual, giving outer 1:1 joins a bounded-delta arm
- [ ] By-prefix fanning-join arm — the natural next consumer of the `'prefix-delete'` machinery
- [ ] A possible **unified maintenance substrate** folding the row-time arms and the post-commit `DeltaExecutor` binding kernel under one abstraction; the arms above would retarget onto it if it lands

**Statement-level op-coalescing for the incremental arms — LANDED** (the
`mv-maintenance-statement-batching` ticket). The three residual arms now accumulate their
affected binding keys per statement and recompute once per distinct key at the
end-of-statement flush, with the per-statement `shouldDegradeToRebuild` demotion wired
(see [`mv-maintenance.md` § Synchronous, transactional, per-statement](mv-maintenance.md#synchronous-transactional-per-statement)).
The once-feared `lookupCoveringConflicts` buffer-unioning turned out never to be needed:
`'inverse-projection'` — the only arm enforcement ever reads — stays per-row-immediate, so
the deferral cut avoids the hazard entirely. No coalescing remains open for
`'inverse-projection'` itself (its per-row delta is a cheap pure projection, and its
per-row visibility is load-bearing for enforcement).

**Bag (multiplicity-keyed) materialization.** A body with no provable unique key — and no
[coarsened lineage key](materialized-views.md#coarsened-backing-keys) — is rejected at create
today, because there is no row identity to materialize on. A Z-set-style backing (distinct
rows plus a multiplicity count, expanded on read) would lift the restriction, at the cost of
a hidden count column and a read-time expansion.

- [ ] Z-set backing with a hidden multiplicity column
- [ ] Read-time expansion, and its interaction with the covering-structure prover

**Concurrent refresh.** Overlapping refreshes, and refresh-while-read beyond the current
atomic base-layer swap.

**MV-over-MV write-through.** DML against a materialized view whose body's source is itself a
materialized view is rejected today; its rewrite would target the inner view's read-only
maintained table. Routing one level down to the inner view's own write-through would lift it.

**Non-binary covering-MV prefix scan.**

- [ ] Thread per-column collation into `ScanPlan.equalityPrefix` matching (`plan-filter.ts` / `scan-layer.ts`) so a non-binary covering materialized view uses the prefix scan instead of the full-scan fallback

**Precise change-scope projection.** `Database.watch` on a materialized view currently
projects to a `full` watch per source. A per-source row/group scope, mirroring the maintenance
projection the manager already derives, would narrow it.

**Coarsened-key advisory surface.** `TableDerivation.coarsenedKey` is stamped at create but is
programmatic-only — no SQL or introspection-TVF surface exposes it. If the lens deploy-report
pipeline grows an advisory surface, the coarsened-key fact is a natural candidate to carry
there. It must read the live record rather than persist; the stamp stays non-serialized. See
[`materialized-views.md` § Coarsened backing keys](materialized-views.md#coarsened-backing-keys).

**Backing-host stale-set portability.** The durable stale-MV set's soundness currently rests
on write-ahead-log ordering: the source DDL is queued before the `sync: true` stale-set write
on the same queue. Folding the two into one atomic `batch()` would remove the WAL-ordering
dependency and make the adopt fast path portable to any backend. It requires reworking
`alterTable`'s eager source-DDL persist across every alter kind. See
[`mv-backing-host.md` § Cross-module atomicity](mv-backing-host.md#cross-module-atomicity).

- [ ] Fold the stale-set write into the source DDL's atomic batch

## Sync Engine Remaining Work

Core sync is complete (see [`sync.md`](sync.md)); these are refinements and coverage gaps.

**Transactional integrity**
- [ ] Use `WriteBatch` for per-table atomicity when applying remote changes
- [ ] Consider `TransactionCoordinator` in the store adapter for batched writes
- [ ] Update the sync store adapter to use `UnifiedIndexedDBModule` for atomic sync writes
- [ ] Leverage Store-level isolation (memory vtab's `TransactionLayer` pattern) for true ACID sync semantics

**Storage cost**
- [ ] Config flag to opt out of the tombstone row before-image (`priorRow`), whose cost is
  bounded but non-trivial for wide rows (see [`sync-protocol.md`](sync-protocol.md#data-structures))

**Testing**
- [ ] Tombstone TTL expiration and fallback to snapshot
- [ ] Large-dataset streaming-snapshot tests
- [ ] Network interruption / resume tests
- [ ] IndexedDB integration tests (browser environment)
- [ ] Crash-recovery tests (idempotent re-apply after partial sync)

**Transports & examples**
- [ ] Example transports: WebSocket, HTTP polling, `applyToStore` callback
- [ ] Performance benchmarks
- [ ] HTTP-polling fallback for environments without WebSocket
- [ ] Connection-quality metrics (latency, reconnect count)

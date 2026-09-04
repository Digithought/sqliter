# Optimizer Retrieve Push-down

> **Stability: Internal** — see [Stability Tiers](stability.md#tiers).

How operations slide across the virtual-table boundary: the `RetrieveNode`
abstraction, the module capability API, access-path selection, and the correlated
(lateral) access model. Table-valued functions advertise the same physical properties
a virtual table does, so their declaration surface lives here too.

## Retrieve-based Push-down Architecture

### Overview

The Quereus optimizer features a comprehensive push-down infrastructure built around the `RetrieveNode` abstraction. This system enables virtual table modules to execute arbitrary query pipelines within their own execution context, providing a clean boundary between Quereus execution and module-specific optimization.

### RetrieveNode Infrastructure

**Core Concept**: Every `TableReferenceNode` is wrapped in a `RetrieveNode` at build time, marking the exact boundary where data transitions from virtual table module execution to Quereus execution.

```typescript
// Builder automatically wraps table references
export function buildTableReference(fromClause: AST.FromClause, context: PlanningContext): RetrieveNode {
  const tableRef = new TableReferenceNode(/* ... */);
  return new RetrieveNode(context.scope, tableRef, tableRef); // pipeline starts as just the table
}
```

**Structure**:
```
RetrieveNode
  └─ pipeline: RelationalPlanNode  (operations handled by the module)
      └─ TableReferenceNode        (leaf table reference)
  [bindings: ScalarPlanNode[]]     (captured params/correlated expressions)
```

### Supported-only placement policy

> **Invariant:** [OPT-022](invariants.md#opt-022--a-retrieve-pipeline-holds-only-supported-operations)
> **Invariant:** [OPT-023](invariants.md#opt-023--nothing-is-pushed-into-a-retrieve-whose-access-path-is-committed)

- **Pushdown rule**: When sliding a `Filter` down into a `Retrieve`, the optimizer:
  - Normalizes the predicate, extracts constraints for the `Retrieve` table, and constructs a supported-only predicate fragment.
  - Inserts only that fragment as a `Filter` inside the `Retrieve` pipeline.
  - Leaves any residual (unsupported) predicate above the `Retrieve` boundary.
  - Merges newly referenced bindings (parameters/correlations) into `Retrieve.bindings`.
  - **Declines outright once the access path is committed**: if the target `Retrieve` already carries an index-style `moduleCtx`, no predicate is pushed into it at all. From that point `rule-select-access-path` builds the physical leaf from `accessPlan` + `moduleCtx.residualPredicate` and never reads `Retrieve.source`, so a fragment placed there would execute nowhere and the query would return unfiltered rows. The `Filter` stays above the boundary instead, where grow-retrieve re-probes `getBestAccessPlan()` with the constraint on the next fixed-point iteration and residualizes whatever the module declines — so nothing is lost by declining. `Retrieve.source` remains populated for the readers that still walk it (binding collection, and the constraint sweep in `trySortAbsorbViaIndexOrdering`); it is dead only as an *execution* channel.

- **Grow-retrieve rule**: When sliding `Retrieve` upward over a `Filter` (index-style fallback):
  - The rule mirrors the pushdown behavior: only supported fragments of the enveloped node are placed beneath `Retrieve` as a new `Filter`. The residual remains above.
  - Bindings are collected from the added fragment and merged into `Retrieve.bindings`.
  - **Subquery-bearing residual carve-out**: the index-style residual is normally stashed on `moduleCtx.residualPredicate` and rebuilt into a `Filter` by `rule-select-access-path`. But a residual that contains ANY subquery (`IN (SELECT …)`, `NOT IN (SELECT …)`, `EXISTS`, a scalar subquery, or any future subquery form) is instead kept above the grown `Retrieve` as a real `FilterNode` at grow time. A stashed subquery would carry its own inner `Retrieve` outside the plan tree the bottom-up physical pass walks, leaving it unphysicalized (it surfaces as the missing-emitter error in the physicalization invariant below). Detection is structural — the residual is kept above iff any node in it is relational (a subquery is the only way a `RelationalPlanNode` hangs beneath a scalar predicate), so new subquery node types are covered automatically. Correlation is irrelevant — a self-contained subquery buries an inner `Retrieve` just the same as a correlated one.

This policy ensures the `Retrieve` pipeline is always a precise description of what the module/index can handle; unsupported parts never enter the boundary.

### Re-probing a committed access path

> **Invariant:** [OPT-026](invariants.md#opt-026--a-committed-access-path-context-is-replaced-only-by-a-superset)

`moduleCtx` and `Retrieve.source` are two channels, and only one of them executes. Once an
index-style `moduleCtx` exists it is the **sole authority** for what the table access
enforces; `source` is walked only for binding collection and the
`trySortAbsorbViaIndexOrdering` constraint sweep. The policy above is the first
consequence: do not write into `source`. This section is the second, in the opposite
direction: do not **replace** `moduleCtx` with less than it held.

`ruleGrowRetrieve` can fire more than once on the same `Retrieve` — a later rule drops a
fresh `Filter` (or `Sort`, or `LimitOffset`) on top of one that is already equipped — and
`fallbackIndexSupports` returns a brand-new context that replaces the committed one
wholesale. So the re-probe seeds its `BestAccessPlanRequest` with the union of the
committed context's `originalConstraints` and whatever it extracts from the incoming node,
and folds the committed `residualPredicate` into the new residual conjunct-by-conjunct,
skipping whatever the constraint union already covers (otherwise a carried predicate is
evaluated twice per row). Anything the module declines on the second probe is residualized,
so correctness does not depend on it answering the same way twice.

Three details are load-bearing:

- **De-duplication is keyed on `(sourceExpression, columnIndex, op)`, not on the expression
  alone.** A `BETWEEN` decomposes into a lower and an upper bound sharing one source node;
  collapsing them drops half the range. Leaving genuine duplicates in is not harmless
  either — the module claims the first copy, `reattachUnconsumedConstraints` re-applies the
  second as a redundant residual, and the cost shift can flip a join strategy.
- **The ordering channel has the same rule.** An equipped `providesOrdering` is
  re-requested and a plan that does not provide it is declined, so a re-probe cannot
  clobber a plan whose emission order a dropped `Sort` now depends on.
- **Growing a `Sort` or a `LimitOffset` swallows it** — the node lands in `source`, which
  never executes — so those arms are accepted only when the plan provides the requested
  ordering. A handled filter is not a licence to drop an `ORDER BY`.

Two bugs have been filed against these two directions of the same seam
(`bug-filter-conjunct-lost-under-index-order` for `source`,
`bug-primary-key-conjunct-lost-with-correlated-subquery` for replacement); both presented
identically, as a silently dropped `WHERE` conjunct returning every row. The general
property behind them is that **adding a conjunct must never widen the result set**, pinned
in `test/logic/07.7.9-conjunct-monotonicity.sqllogic`.

### Constraint sweep scope

> **Invariant:** [OPT-025](invariants.md#opt-025--a-predicate-constrains-only-tables-in-its-own-relational-input)

`extractConstraintsForTable(plan, key)` answers "which predicates in this subtree constrain
table instance `key`?". Both callers that place work on an access path use it:
`rule-select-access-path` sweeps `Retrieve.source`, and `trySortAbsorbViaIndexOrdering`
(grow-retrieve) sweeps the whole subtree beneath an absorbed `Sort` — the only caller that
looks past a single `Filter`'s own predicate, which is why a bug here needs an `ORDER BY` the
table's own key walk satisfies.

`trySortAbsorbViaIndexOrdering` is **exported** and has two callers. `ruleGrowRetrieve`
itself calls it for a `Sort` the user wrote (or an earlier rule left). `rule-minmax-index-boundary`
(Structural, Aggregate) calls it as a *probe*: it synthesizes a throwaway `SortNode` purely
to ask whether the access path can serve that ordering, and commits nothing when the answer
is null. That second caller is why the helper must stay side-effect-free — it probes
`getBestAccessPlan` and either returns a new tree or null, never mutating its input and never
recording anything on the `OptContext`. A caller that gets null must be able to discard its
probe input and leave the plan byte-identical.

The subtree is not the same thing as the scope. A subquery body is a `RelationalPlanNode`
hanging beneath a *scalar* expression, so `where exists (select 1 from t where t.s = a.i)`
puts the inner `t.s = a.i` inside the outer `Filter`'s subtree. The sweep (`walkPredicatesConstraining`)
therefore descends into everything but only *visits* a predicate when the target table
reference is reachable through relational-child links from the predicate's own node — i.e.
when the table is genuinely in that predicate's input. An inner scan of the same table still
collects its own predicates, because the recursion still enters subquery bodies; what it finds
there simply cannot mark an enclosing node's input.

Note the distinction from correlation. A constraint whose **value** side references an outer
attribute (`PredicateConstraint.correlated`) is a supported feature — it is how a correlated
seek is pushed into an inner scan. What is never legal is attributing an inner scope's
predicate to an **outer** table: the unhandled-constraint path turns it into
`moduleCtx.residualPredicate`, and `rule-select-access-path` then materializes a `Filter`
reading a column the outer relation does not have (runtime "No row context found for column
…"), or — under `NOT EXISTS`, where the hoisted conjunct happens to be satisfiable — silently
drops rows.

The gate is also the only protection against one shape the `correlated` flag cannot see: an
**outer** column compared to a **constant** inside the subquery body
(`where not exists (select 1 from t where a.i = 2)`). Its value side is a literal, so
`computeCoveredKeysForConstraints` would treat it as an ordinary covering equality on `a` —
letting `extractCoveredKeysForTable` claim ≤1 row for a relation with many, and letting
`rule-select-access-path` seek on it, which drops every row under `NOT EXISTS`. A subquery
over the same *table* is not this shape: the inner scan is a distinct
`TableReferenceNode` with its own attribute ids, so `exists (select 1 from a a2 where
a2.id = 2)` never matched the outer instance's attributes in the first place.

### Set operations and growth boundaries

- `SetOperation` (`UNION`, `INTERSECT`, `EXCEPT`, `DIFF`) is excluded from the grow-retrieve structural pass. Sliding a `Retrieve` boundary across set operations can cause structural oscillation and provides little benefit to index-style modules. Predicate push-down into the branches remains supported via the supported-only policy.

### Physicalization invariant

> **Invariant:** [OPT-020](invariants.md#opt-020--no-logical-only-node-reaches-emission)

- During the physical selection pass, all `Retrieve` nodes must be rewritten to concrete access nodes (`SeqScan`, `IndexScan`, or `IndexSeek`) or `RemoteQuery`. `validatePhysicalNodeType` asserts this, but it runs only under `tuning.debug.validatePlan`, which is off by default — so in a release build a surviving `Retrieve` surfaces as a missing-emitter error rather than as that assertion.

### Robust primary-key equality seeks

- For index-style modules, full primary-key equality (including parameterized values) will select `IndexSeek` even if the provider’s `handledFilters` ordering differs from planner constraint extraction. The optimizer aligns constraints by column index and constructs dynamic seek keys from parameters/correlated expressions.

### Diagnostics and verification

- `query_plan(sql)` exposes `RETRIEVE` rows with logical properties including `bindingsCount` and `bindingsNodeTypes`, which reveal whether parameters and/or correlated column references have been captured by the pipeline.
- For test assertions, prefer checking for the presence of `ParameterReference` nodes in the plan (logical indicator of binding presence) rather than relying on `RETRIEVE` presence post-physical selection, since physical rules may replace `Retrieve` with concrete access operators.

### Module Capability API

**VirtualTableModule Interface**:
```typescript
interface VirtualTableModule {
  // Query-based push-down
  supports?(node: PlanNode): SupportAssessment | undefined;
  
  // Index-based access
  getBestAccessPlan?(req: BestAccessPlanRequest): BestAccessPlanResult;
}

interface SupportAssessment {
  cost: number;    // Module's cost estimate for executing this pipeline
  ctx?: unknown;   // Opaque context data cached for runtime execution
}
```

**VirtualTable Interface**:
```typescript
interface VirtualTable {
  // Runtime execution of pushed-down pipelines
  executePlan?(db: Database, plan: PlanNode, ctx?: unknown): AsyncIterable<Row>;

  // Standard index-based query execution
  query?(filterInfo: FilterInfo): AsyncIterable<Row>;
}
```

### Architecture Modes

**1. Query-based Push-down** (implements `supports()` + `executePlan()`)
- Module analyzes entire query pipelines
- Returns cost assessment for execution within module
- Examples: SQL federation modules, document databases, remote APIs

**2. Index-based Access** (implements `getBestAccessPlan()` + `query()`)
- Module exposes index capabilities
- Quereus pushes individual predicates via BestAccessPlan API
- Examples: MemoryTable, SQLite vtabs, file-based storage

**3. Hybrid Modules** (can implement both, but they're mutually exclusive per query)
- Modules can provide both interfaces
- Optimizer chooses based on cost assessment

### Access Path Selection

The `ruleSelectAccessPath` optimizer rule handles the routing decision:

```typescript
export function ruleSelectAccessPath(node: PlanNode, context: OptContext): PlanNode | null {
  if (!(node instanceof RetrieveNode)) return null;
  
  const vtabModule = node.vtabModule;
  
  // Query-based push-down takes priority
  if (vtabModule.supports) {
    const assessment = vtabModule.supports(node.source);
    if (assessment) {
      return new RemoteQueryNode(node.scope, node.source, node.tableRef, assessment.ctx);
    }
    // Module declined - fall back to sequential scan
    return createSeqScan(node.tableRef);
  }
  
  // Index-based access
  if (vtabModule.getBestAccessPlan) {
    return createIndexBasedAccess(node, context);
  }
  
  // Default sequential scan
  return createSeqScan(node.tableRef);
}
```

### Physical Execution Nodes

**RemoteQueryNode**:
- Represents execution of a pipeline within a virtual table module
- Calls `VirtualTable.xExecutePlan()` at runtime
- Passes the original plan pipeline and cached context

**Traditional Access Nodes**:
- `SeqScanNode`: Full table scan
- `IndexScanNode`: Index-based scan with filters
- `IndexSeekNode`: Index-based point/range lookups
- `EmptyResultNode`: Zero-row short-circuit at the access boundary (e.g., `IS NULL` on NOT NULL column). Sibling node `EmptyRelationNode` (`planner/nodes/empty-relation-node.ts`) covers the schema-polymorphic empty case for general fold rules — `EmptyResultNode` stays bound to a `TableReferenceNode` (for EXPLAIN), while `EmptyRelationNode` is detached from any specific source. See [Rule Families § Empty-relation folding](optimizer-rule-families.md#empty-relation-folding).

### Parameterization hand-off

- Modules that implement `getBestAccessPlan` can return `indexName` and `seekColumnIndexes` to identify the chosen index and its key columns. When present, `selectPhysicalNodeFromPlan` builds seek keys from the correct constraint columns — not hardcoded to PK.
- When these fields are absent, the legacy PK-based heuristic path (`selectPhysicalNodeLegacy`) is used for backward compatibility.
- Equality constraints that fully cover a primary or secondary index prefix are translated into `IndexSeekNode` with dynamic seek keys:
  - Seek keys are stored as scalar expressions (parameters or correlated refs), evaluated at runtime by the emitter and passed to the module via the existing `FilterInfo.args` mechanism.
  - Range bounds (>=/<=) similarly pass dynamic lower/upper expressions.

This establishes a clean “call-like” boundary: `Retrieve.bindings` declares required inputs; physical access nodes evaluate those inputs and deliver them to the module.

### Seek provenance

A seek's `FilterInfo` is the only place a claimed predicate is enforced: once `handledFilters[i] === true`, `rule-select-access-path` folds filter `i` into seek keys and it exists as a `Filter` nowhere in the tree. `FilterInfo.constraints` records only the encoded form (column index, operator, argv slot) — not enough to rebuild the predicate, because a comparison's effective collation is resolved from the *original expression's* operand types (`analysis/comparison-collation.ts`), not from the column alone.

So `IndexSeekNode` also carries `pushedConstraints`: the exact `PredicateConstraint` objects the rule consumed, each with its `sourceExpression`. A later rule that wants to replace the seek's access method can therefore re-apply them (AND them with the exported `combineResidualExpressions`) or re-offer them to `getBestAccessPlan`, instead of having to decline because it cannot tell what predicate it would be dropping. `rule-key-set-seek` is the first consumer: it admits a seek as the key-set semi join's target and re-applies the combined predicate as a `Filter` directly above the new node (see `optimizer-rules.md`).

- **Stamped at one site.** `selectPhysicalNode` stamps between the index-aware/legacy dispatch and `reattachUnconsumedConstraints`, descending through the collation-residual `Filter` a seek arm may wrap the leaf in — not at the individual `new IndexSeekNode(...)` calls.
- **Contents.** Exactly the constraints this seek turned into keys or bounds, in `constraints` order. Deliberately *not* every claimed filter: a claimed-but-unconsumed reclaimable constraint is already re-applied above the leaf by `reattachUnconsumedConstraints`, and a claimed constraint outside `RECLAIMABLE_OPS` is enforced nowhere today (see that constant's note), so including either would misdescribe the field.
- **Not always re-appliable in an arbitrary position.** `rules/join/index-nested-loop.ts` builds seeks from synthesized correlated equalities whose `sourceExpression` references an outer-side attribute. Recorded faithfully, but a consumer must gate on where it intends to re-apply.
- **`orderingLoadBearing`** rides alongside on both `IndexScanNode` and `IndexSeekNode`: true when `rule-grow-retrieve` dropped a `Sort` because this access plan advertised the matching ordering, so a rewrite that changes the leaf's emission order must decline.
- Neither field appears in `getLogicalAttributes` — they are provenance for rules, not EXPLAIN output.

### Runtime Execution

**Query-based Execution**:
```typescript
// emitRemoteQuery.ts
export function emitRemoteQuery(plan: RemoteQueryNode, ctx: EmissionContext): Instruction {
  async function* run(rctx: RuntimeContext): AsyncIterable<Row> {
    const table = plan.vtabModule.connect(/* ... */);
    yield* table.executePlan!(rctx.db, plan.source, plan.moduleCtx);
  }
  return { params: [], run, note: `remoteQuery(${plan.tableRef.tableSchema.name})` };
}
```

**Index-based Execution**:
- Uses existing `query()` with `FilterInfo` parameter
- Leverages `BestAccessPlan` API for predicate push-down

### Integration Points

**Builder Integration**:
- All table references automatically wrapped in `RetrieveNode`
- DML operations (INSERT/UPDATE/DELETE) extract `tableRef` from `RetrieveNode`
- Maintains backward compatibility with existing code

**Optimizer Integration**:
- `ruleSelectAccessPath` registered for `PlanNodeType.Retrieve`
- Physical properties correctly propagated through `RemoteQueryNode`
- Cost estimation integrated with existing cost model

**Runtime Integration**:
- `RemoteQueryNode` emitter registered in runtime system
- Error handling for modules without `xExecutePlan()` implementation
- Seamless execution alongside traditional access methods

### Dynamic support growth with ruleGrowRetrieve

`ruleGrowRetrieve` is a **structural, capability-bounded** sliding rule. It maximizes the
query segment each virtual table module executes for itself, without consulting cost.

**Algorithm** — registered on every relational node type in the Structural pass, which
runs top-down so a parent is visited before the `RetrieveNode` child it may slide into:
1. Graft the parent operation onto the child `RetrieveNode`'s current pipeline, forming a
   candidate pipeline
2. Assess it with `module.supports(candidatePipeline)`, or the index-style fallback
   (`getBestAccessPlan`)
3. On support, replace the parent with a new `RetrieveNode` carrying the expanded pipeline
4. On decline, stop — the `RetrieveNode` has reached its maximum extent

```typescript
// Example: Filter above table reference
Filter(condition) 
  └── RetrieveNode(source: TableRef)

// After ruleGrowRetrieve (assuming module supports filtering):
RetrieveNode(source: Filter(condition, TableRef))
```

**Key properties**:
- Structural for a module with `supports()` — that module either commits to the expanded
  pipeline or does not, and no cost enters the decision, so the segment boundary is
  deterministic and reproducible
- Cost-aware for the index-style fallback — `fallbackIndexSupports` (used for a module that
  only implements `getBestAccessPlan`) declines a plan whose seek costs no less than a plain
  whole-table read. Note that declining does **not** currently produce that whole-table read:
  with no index-style context committed, `rule-predicate-pushdown` absorbs the predicate into
  `Retrieve.source` and access-path selection rebuilds the same seek with the absorbed Filter
  re-stacked above it, so a decline costs strictly more than the push-down it refused — see
  `bug-declined-push-down-is-rebuilt-as-seek-plus-duplicate-filter`. Both numbers in that
  comparison are quoted by the same module: the baseline is a second,
  filter-free/ordering-free/limit-free probe of `getBestAccessPlan`, not the engine's own
  `seqScanCost` over the catalog's row count. Pricing the two sides against
  different table sizes is what made a self-sizing backend's honest seek lose to a fabricated
  scan — see [Costing § Where a module's own size fits](optimizer-costing.md). The probe is
  paid only on the branch that reads it; when the plan supplies the ordering that was
  requested, that ordering is the benefit and no baseline is fetched
- Module-bounded — a module evaluates exactly the operations it commits to handle
- Runs before physical selection, so access-path choice sees the final segment
- Establishes the "query segment" baseline every later push-down rule builds on

**Modules can accept arbitrary nodes**: `supports()` may accept complex subtrees, including joins across multiple tables that reside in the same module. When a module declares support for such a subtree, `ruleGrowRetrieve` will slide those operations into the `RetrieveNode` boundary, enabling efficient intra-module execution.

## Correlated and lateral access

A correlated or lateral join is planned as an ordinary `JoinNode` and executed by the
nested-loop emitter: the right subtree is re-executed once per left row, with the
correlated values visible through the runtime context. When the right side reduces to a
seek on an indexed column, the
[fan-out lookup join](optimizer-joins.md#fan-out-lookup-join-fkpk--1n-cross) clusters those
per-row lookups into one concurrently-driven node.

There is no separate `ApplyNode` abstraction. Pushing correlation values into a module as
*declared constraints* — so the module, rather than the runtime, drives the seek — is
future work; see
[`docs/todo.md` § Push-down & Federation Roadmap](todo.md#-push-down--federation-roadmap-active-items).

## TVF Property Declarations

Table-valued functions can advertise relational and physical characteristics through an optional `relationalAdvertisement` field on `TableValuedFunctionSchema`. Without it, a TVF's logical `returnType.keys` / `returnType.isSet` are exposed but `physical` defaults are conservative (no key FDs, no `ordering`, no `monotonicOn`, default `estimatedRows`). With an advertisement, `TableFunctionCallNode.computePhysical` consumes it on the standard physical-property path so downstream rules (FD propagation, DISTINCT elimination, sort/monotonic-window rules, cardinality estimation) see the same information they get from a real vtab.

**Advertisement surface** — each field is either a static value or a `TVFAdvertiseFn<T>` that receives the call's operands and the schema and may return `undefined` to decline:

| Field | Type | Notes |
|---|---|---|
| `isSet` | `boolean` | Overrides `returnType.isSet` when present. |
| `keys` | `ReadonlyArray<ReadonlyArray<ColRef>>` | Output-column unique keys; lifted into `physical.fds` as `key → other-cols` FDs and into `getType().keys`. |
| `fds` | `ReadonlyArray<FunctionalDependency>` | Additional (non-key) FDs over output columns. |
| `equivClasses` | `ReadonlyArray<ReadonlyArray<number>>` | Equivalence classes; each class must have ≥ 2 members. |
| `ordering` | `ReadonlyArray<{column, desc}>` | Output ordering. |
| `monotonicOnColumns` | `ReadonlyArray<{column, direction, strict?}>` | Column-keyed monotonicity; preferred over `monotonicOn` because the node mints attribute IDs per call — the node translates `column → attrId` when assembling physical props. |
| `monotonicOn` | `ReadonlyArray<MonotonicOnInfo>` | Direct form for advanced uses where the author already has the attrId. |
| `constantBindings` | `ReadonlyArray<ConstantBinding>` | Columns pinned to a single value over the call. |
| `estimatedRows` | `number` | Row-count estimate; the `TableFunctionCallNode.estimatedRows` getter consults this before falling back to the default. |
| `accessCapabilities` | `PhysicalProperties['accessCapabilities']` | `ordinalSeek` / `asofRight`. |
| `deterministic`, `readonly`, `idempotent` | `boolean` | Overrides the FunctionFlags-derived defaults. |

**Literal operand inspection** — `evaluateLiteralOperand(operand)` (from `schema/function.js`) returns `operand.expression.value` when the operand is a literal and `undefined` otherwise. Use it in a `TVFAdvertiseFn` closure to declare parameter-dependent values:

```typescript
estimatedRows: (operands) => {
  const start = evaluateLiteralOperand(operands[0]);
  const end = evaluateLiteralOperand(operands[1]);
  if (typeof start === 'number' && typeof end === 'number' && end >= start) {
    return end - start + 1;
  }
  return undefined;  // Decline when bounds are non-literal.
},
```

**Validation** — every advertised field is shape-checked against the call's column count and attribute set before it lands in `physical`. Bad advertisements (out-of-range column indices, empty FD dependents, equivalence classes of size < 1, duplicate ordering columns, etc.) are dropped silently with a single warning on the `planner:tvf` log channel — they never break planning. A `TVFAdvertiseFn` closure that throws is treated the same way. This guarantees a buggy third-party advertisement degrades to "no advertisement" instead of poisoning the optimizer.

**Built-in annotations** — the following TVFs ship with relational advertisements:

| TVF | Advertisement |
|---|---|
| `generate_series(start, end)` | `isSet`, `keys=[[value]]`, `ordering=[{value, asc}]`, `monotonicOnColumns=[{value, asc, strict}]`, `estimatedRows` (when bounds are literal). |
| `json_each(json[, path])` | `isSet`, `keys=[[id]]`. |
| `json_tree(json[, path])` | `isSet`, `keys=[[id]]`. |
| `query_plan(sql)` | `isSet`, `keys=[[id]]`. |
| `table_info(table)` | `isSet`, `keys=[[cid]]`. |
| `index_info(table)` | `isSet`, `keys=[[index_name, seq]]`. |
| `foreign_key_info(table)` | `isSet`, `keys=[[id, seq]]`. |
| `unique_constraint_info(table)` | `isSet`, `keys=[[id, seq]]`. |
| `check_constraint_info(table)` | `isSet`, `keys=[[id]]`. |
| `assertion_info()` | `isSet`, `keys=[[schema_name, name]]`. |
| `function_info()` | `isSet`, `keys=[[name, num_args]]`. |

Non-deterministic or trace-only TVFs (`execution_trace`, `row_trace`, `stack_trace`, `scheduler_program`, `schema_size`, `explain_assertion`, `schema`) skip advertisement.

**Relevant to materialized-view maintenance (deferred shape).** The TVF `relationalAdvertisement` (`keys` / `isSet`) is the surface a lateral-TVF row-time materialized-view body would consume to bound a fan-out (`base t cross join lateral json_each(t.arr) je`): a base-row change maps to many backing rows that a prefix-delete + recomputed-fan-out maintenance would need to prove set on the backing PK. This shape is **not** in the current row-time eligibility gate — it is deferred to `materialized-view-rowtime-general-bodies`. `combineJoinKeys` (`planner/util/key-utils.ts`) now forms the **product key** `(leftKey ∪ shiftedRightKey)` for a keyed cross/lateral join (when both sides are keyed and neither is equi-covered), so `keysOf` surfaces the keyed cross-product key — see [Joins § Keyed cross/inner (and lateral) product keys](optimizer-joins.md#keyed-crossinner-and-lateral-product-keys). The remaining lateral-TVF consumption work (proving a recomputed fan-out set on the backing PK) is tracked by `materialized-view-rowtime-general-bodies`. See [Materialized Views](materialized-views.md).

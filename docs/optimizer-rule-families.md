# Optimizer Rule Families

> **Stability: Internal** — see [Stability Tiers](stability.md#tiers).

Deep-dives on the rule families that need more than a catalog line: the materialized-view
read-side rewrite, constant folding, the predicate family (sargable rewrites, pushdown,
contradiction detection, empty-relation folding), and the cardinality / key family
(key-driven row-count reduction, DISTINCT elimination, key inference). The
one-line entry for each rule, grouped by the `src/planner/rules/` subdirectory it lives in,
is in [the rule catalog](optimizer-rules.md); the pass framework these rules register into,
and the audit discipline every rule declares, live in [the optimizer hub](optimizer.md).

> **NOTE:** the families here are grouped only by "needs more than a catalog line", not by
> subject. Unratcheted, so the 12,000-word cap governs and this doc sits at roughly half of
> it. If it approaches the cap again, split along family lines — MV rewrite, predicate,
> cardinality/key — rather than at an arbitrary point.

## Materialized-view query rewrite (read side)

`ruleMaterializedViewRewrite` (`rules/cache/rule-materialized-view-rewrite.ts`) is the read-side dual of the [coverage prover](mv-constraints.md#explicit-covering-structures-the-coverage-prover): it recognizes when an *arbitrary* scan-projection-filter query — one that **never names** a materialized view — is *answered from* a covering MV, and rewrites it to scan the MV's backing table (`_mv_<name>`) with a residual projection/filter instead of recomputing the body against the base tables. Because the replacement is an ordinary `TableReference`, `query_plan()` shows the backing scan for free.

**Matcher** (`planner/analysis/query-rewrite-matcher.ts`, sibling to `coverage-prover.ts`). The question is **output-relation subsumption**: do the MV's stored rows contain a superset (re-coverable via a bounded residual) of the rows the fragment produces, keyed so the residual recovers exactly the fragment's output? It shares the coverage prover's entailment vocabulary (`recognizeConjunctiveClauses` / `guardClausesEntail`), so NULL semantics are identical. Soundness mirrors the prover exactly — **a false NotMatch only forgoes a speedup; a false Match returns wrong rows** — so every check forgoes the rewrite on doubt, and the rule only ever replaces the correct recompute-over-base plan with a provably row-equivalent backing scan (non-regressing).

- **Shape.** The fragment must be a single-source `Project(Filter?(scan(TableReference)))` over base `T`; the MV body (read from `mv.selectAst`) the same projection-and-filter over the same `T`. DISTINCT / set-op / LIMIT on either side ⇒ NotMatch (`shape`). An **aggregate** fragment and a **1:1-join** fragment are each handled by a separate arm (both below).
- **Predicate entailment (containment).** The fragment's row set must be a subset of the MV's: the MV's WHERE `P_mv` must be entailed by the fragment's WHERE `P_q`. The residual is the conjunction of `P_q` conjuncts not already entailed by `P_mv`, applied as a `Filter` on the backing scan (`predicate-not-entailed` otherwise). An MV with no WHERE subsumes any fragment WHERE (residual = full `P_q`); a fragment with no WHERE requires `P_mv` empty too.
- **Projection coverage.** Every fragment output column (a bare passthrough of a `T` column) must be a column the MV projects; the residual's columns likewise (`missing-column` otherwise). A computed fragment output is not re-derived in v1.
- **Gates.** A **stale** MV (its backing is an unmaintained snapshot), a **non-deterministic body** (reuses the function-registry determinism metadata — a registered MV is already deterministic by construction), or a **source-schema mismatch** are all rejected before shape matching.

**Aggregate-rollup arm** (`analyzeAggregateFragment` / `matchAggregateFragmentToMv`). Fires when the fragment root is a logical `Aggregate(Filter?(scan(T)))` and the MV body is a grouped aggregate over the same `T`. Query and MV GROUP BY are mapped to bare source-column sets (computed group key ⇒ `aggregate-shape`); query key ⊆ MV key required (⊄ ⇒ `group-key-mismatch`). Two sub-cases: **exact-key** (query key == MV key) scans the backing directly — each output is a passthrough of a stored group column or an *exactly* matching stored aggregate, with an optional residual `Filter`/`Project` and **no re-aggregation**; **rollup** (query key ⊊ MV key, incl. the empty global key) re-aggregates the backing partials down to the query key via the decomposable-aggregate allowlist (`sum`→`sum`, `count`→`coalesce(sum,0)`, `min`/`max`→`min`/`max`, `avg`→`sum(sum)/sum(count)`; `count(distinct)` / `group_concat` / any `distinct` ⇒ `aggregate-not-decomposable`). A comparison-sensitive re-aggregation (`min`/`max`) is bound to the stored partials' comparison context before its `merge`/`decode` are pulled: the backing attribute supplies the logical type, while the collation comes from `MergeReagg.argCollation` — the *argument* column's declared collation, which an aggregate's result type does not carry — so the fold ranks partials the way the same query would without the view. The one-row-per-group witness is `backingPkIsGroupKey` (the backing PK equals the MV group key — the schema-level `proveEffectiveKeyUnique`). A residual may reference only MV group-key columns (`missing-column` otherwise) — these partition whole MV groups, so the residual `Filter` on the backing scan commutes with the rollup re-aggregate (a rollup needing a residual is therefore sound, and the rule builds that `Filter` before the re-aggregate). One forgo guard remains: `group-key-pinned` (a multi-key query pinning/equating a group column would diverge from the base's `rule-groupby-fd-simplification` column reorder). See [docs/materialized-views.md § Aggregate rollup](materialized-views.md#aggregate-rollup-indexed-view-matching) for the recombine table and the avg-NULL/count-zero semantics.

**Join-subsumption arm** (`analyzeJoinQueryFragment` / `matchJoinFragmentToMv`). Fires when the fragment root is `Project(Filter?(Join(T, P)))` and a 1:1 inner/cross-join MV body materializes the same join — answering it from the backing and **eliminating the join at read time**. The soundness pivot reuses the coverage prover's shared `proveOneToOneJoin` (no-row-loss descent + `proveJoinNoFanout`): a 1:1 join's output is in bijection with the driving table `T`'s governed rows, so two 1:1 joins over the *same tables, equi-pairs, and type* produce the same relation. The matcher runs `proveOneToOneJoin` on **both** the fragment join and the MV body join (the rule plans the MV body once, suppressed, and caches its optimized root in a `WeakMap`), then requires the **same driving `T`, same lookup `P`, an inner/cross top join on each side** (outer is deferred — its null-extended rows differ from an inner-join query), and **equi-pair equivalence** in `(driving-col, lookup-col)` terms (a different FK to the same lookup ⇒ `shape`, the load-bearing guard). Projection coverage maps every fragment output (including lookup-side columns) to a stored backing column through stable attribute ids (`missing-column` otherwise). The stored-column map keys each backing column by the MV body's output **position**, so the arm first verifies the backing columns still correspond positionally (count + name) to the body output — the invariant established when the backing is built from the body. `refresh` keeps that invariant intact even across a schema-shifting source `alter`: it [re-derives the backing shape and rebuilds the backing table](materialized-views.md#refresh-materialized-view) when a re-planned `select *` body interleaves a new source column, so the rebuilt backing re-aligns with the body and the rewrite **re-enables** (no matcher change needed). `backingAlignsWithBody` is retained as **defense-in-depth** — it now passes in the happy path but still forgoes the rewrite (`no-candidate`, leaving the correct base recompute) should any future path ever leave the backing desynchronized from the body, so the matcher never trusts position blindly. A join MV body carries **no WHERE** (the row-time `'join-residual'` create gate rejects a partial join body), so predicate entailment is trivial — the whole post-join WHERE is the residual `Filter`, re-bound onto the backing by **source attribute id** (a base-column index is ambiguous across a join). **Read-side relaxation:** a WHERE term on a *lookup-side* column is allowed here (the row-time arm forbids it), since the rewrite only *reads* the already-materialized join; a residual on a non-stored column ⇒ `missing-column`, a subquery conjunct ⇒ `predicate-not-entailed` (preserving the no-subquery invariant behind `sideEffectMode: 'safe'`). The replacement is the foundation's emission unchanged (backing scan → residual `Filter` → residual `Project`). See [docs/materialized-views.md § Join subsumption](materialized-views.md#join-subsumption).

**Pass placement.** Registered FIRST in the Structural `rewrite` pass (pass rules fire in *registration* order), so it sees the pristine `Project(Filter?(Retrieve(TableReference)))` and reads the fragment's WHERE off the live plan — *before* `grow-retrieve` / `predicate-pushdown` reposition the Filter and before the Physical pass absorbs a predicate into a range scan (where the matcher could no longer see it and would falsely treat the fragment as unfiltered). The **join arm shares the `Project` registration**: the same firing point means the fragment's join is still the pristine **logical** `JoinNode` with its `ON` condition intact (physical join selection runs in a later pass), and the fragment WHERE is still an explicit `Filter` above the join. The aggregate arm is a **second registration** of the same rule function on the `Aggregate` node type (pass rules fire only on their `nodeType` and are deduped by id, so the two arms need separate handles); it carries a distinct id (`materialized-view-rewrite-aggregate`) but honors the canonical `materialized-view-rewrite` disable switch internally, so one `disabledRules` entry turns off both arms. The aggregate fragment is the **logical** `Aggregate` at this point — physical Stream/Hash selection (`aggregate-physical`) and `groupby-fd-simplification` run in later passes. Logical→logical, so the substituted backing `TableReference` (exact-key) or re-aggregate node (rollup) flows through the normal Physical-pass access-path and aggregate-strategy selection. `sideEffectMode: 'safe'`: the matcher admits only a read-only fragment (recognized predicates, no subqueries), so the dropped base-scan subtree is pure, and the replacement re-emits the fragment's identical output attribute ids so the parent splice stays valid.

**Cost gate.** The projection-filter arm compares the recompute-over-base cost (`seqScanCost(baseRows) + filter + project`) to the MV-backed cost (`seqScanCost(backingRows) + residual + project`); the aggregate arm compares recompute-over-base (`seqScanCost(baseRows) + filter + aggregateCost(baseRows, queryGroups)`) to the MV path — exact-key `seqScanCost(mvGroups) + residual + project` (skips the aggregation) or rollup `… + aggregateCost(mvGroups, queryGroups) + project`. The join arm's recompute estimate additionally pays **both base scans plus the join** (`seqScanCost(tRows) + seqScanCost(pRows) + hashJoinCost(…) + filter + project`, using the cheaper physical equi-join so the gate stays conservative), versus the MV-backed `seqScanCost(backingRows) + residual + project` — so the backing scan (one row per driving row) wins decisively. All arms choose the MV only when strictly cheaper, picking the cheapest match with a stable lowercased-name tiebreak. Backing cardinality prefers a real stat and otherwise applies a discount — a WHERE-selectivity discount (projection-filter) or a GROUP-BY grouping-factor discount (aggregate, `mvGroups ≪ baseRows`) — so a covering MV wins even when the stats provider reports no row counts (memory tables). A no-win case (e.g. an MV with no WHERE answering a no-WHERE query) is equal-cost and declines.

**Self-maintenance suppression.** The rule is disabled (`SchemaManager.withSuppressedMaterializedViewRewrite`) while planning an MV's own body to (re)compute or maintain its backing (create / refresh / row-time-maintenance compile), so a body matching a registered MV is never re-pointed at the backing it is populating.

The soundness backstop is the equivalence property harness (`test/query-rewrite-equivalence.spec.ts`): over random base data it asserts `rewritten(query) == unrewritten(query)` row-for-row (including NULLs and empty results) for a corpus of covering and near-miss queries, run with the rule enabled vs disabled. A second block extends it with the aggregate shapes — exact-key, rollup-to-coarser-key (including rollup with a residual on a dropped MV group key, which filters whole backing groups before the re-aggregate), and global-scalar over a grouped MV — over a nullable aggregated column and a row count starting at zero, so every run exercises the load-bearing `sum`-over-zero-rows ⇒ NULL, `count`-over-zero-rows ⇒ 0, and `avg` recombine NULL/division semantics. A third block extends it with the join shapes — driving-side and lookup-side residual WHEREs over a 1:1 FK→PK join MV — across the FK→PK boundary (the generator only emits child rows for existing parents), NULL lookup columns, and the empty-lookup case. Matcher per-reason outcomes and golden plans (a 1:1-join query → backing scan with **no join in the plan**; a fanning near-miss → base recompute) live in `test/query-rewrite-join.spec.ts`.

## Constant Folding Subsystem

Constant folding is an elaborate optimization that evaluates constant expressions at plan time rather than runtime. The system uses a three-phase algorithm with sophisticated dependency tracking.

See [Constant Folding System](optimizer-const.md) for details.

**Core Concepts**

The `constant` physical property has strict requirements:
- A node is `constant: true` **only if** it implements the `ConstantNode` interface with `getValue()`
- This means the node can statically provide its value at plan time
- Examples: `LiteralNode`, materialized relation nodes

```typescript
interface ConstantNode extends PlanNode {
  getValue(): OutputValue;  // Must return the constant value
}
```

**Three-Phase Algorithm**

Rather than stopping propagation when a column reference is found, the optimizer notes the reference and continues to see if the expressions remains otherwise constant at the point where said column is resolved.  This allows even complex queries to be fully folded, if they truly are constant.

1. **Bottom-up Classification**: Assigns `ConstInfo` to every node
   - `const`: Nodes with `physical.constant === true` that implement `getValue()`
   - `dep`: Nodes depending on specific attribute IDs (e.g., column references)
   - `non-const`: Non-functional nodes or those with non-const children

2. **Top-down Border Detection**: Identifies foldable nodes
   - Const nodes are always border nodes
   - Dep nodes become border nodes when their dependencies are resolved
   - Tracks which attributes are known constants in each scope

3. **Replacement Phase**: Replaces border nodes with literals
   - Scalar expressions → `LiteralNode`
   - Relational expressions → Materialized relation nodes (future)

**Dependency Resolution**

The system tracks constant attribute propagation through the plan:
```typescript
// ProjectNode produces constant attribute 42 if its expression is const
if (exprInfo?.kind === 'const') {
  updatedKnownAttrs.add(42);  // Attribute 42 is now a known constant
}

// Later, ColumnReference to attribute 42 can be folded
if (nodeInfo?.kind === 'dep' && isSubsetOf(nodeInfo.deps, knownConstAttrs)) {
  // This dep node can be folded because its dependencies are resolved
}
```

**Important Constraints**

- **Never set `constant: true` without implementing `getValue()`** - This will cause runtime errors
- **Constant folding respects functional properties** - Only nodes with `deterministic && readonly` are considered
- **The optimizer uses runtime evaluation** - Complex expressions are evaluated using the actual runtime, ensuring correctness

**Example: Constant Propagation**
```sql
-- Original query
SELECT x + 1 AS y FROM t WHERE y > 5;

-- After constant folding with known x = 10
SELECT 11 AS y FROM t WHERE 11 > 5;  -- Expression folded
SELECT 11 AS y FROM t WHERE true;    -- Predicate folded
```

## Sargable range rewrites

Rule `rule-sargable-range-rewrite` (Structural pass — runs before `aggregate-predicate-pushdown` / `predicate-pushdown`) turns predicates of the form `f(col) = c` into the equivalent half-open range on `col`:

```
f(col) = c    →    col >= lower(c)  AND  col < upper(c)
```

This converts a function-of-column equality (which the constraint extractor cannot push down) into a bare `col op literal` shape that `rule-predicate-pushdown` carries through the Retrieve pipeline and `rule-select-access-path` can convert to an `IndexSeek` or range scan.

**Wiring.** The rule consults the per-function trait `FunctionSchema.rangeRewriteOnArg` (see [Optimizer § Scalar Expression Properties](optimizer.md#scalar-expression-properties-per-attribute)) which names a bucketing **kind**; the actual boundary computation lives on the column's `LogicalType.bucketBounds(kind, value)`. Bounds are wrapped in `LiteralNode`s typed with the column's logical type, so the result rides the same coercion-free path the constraint extractor already knows.

**Initial coverage.** Only `=` is rewritten; `<`/`<=`/`>`/`>=` require direction analysis on `monotonicityIn` and are deferred. Built-in trait wiring covers the unary `date(x)` form (`func/builtins/conversion.ts`) and `DATE_TYPE` / `DATETIME_TYPE` `bucketBounds`. The variadic `dateFunc` (`func/builtins/datetime.ts`, `numArgs: -1`) is intentionally **not** annotated — its trailing modifiers can shift or re-bucket the result. Build-time dispatch picks the unary `numArgs: 1` form when an SQL `date(col)` call has exactly one argument.

**Identity / null constraints.** The rule never rewrites `f(g(col)) = c` — `bucketBounds` answers in `col`'s value space, not `g(col)`'s, so only a bare column reference is safe. A `null` constant is left alone (`f(col) = null` is already null-rejecting). A null column row continues to be rejected because `col >= L` and `col < U` both evaluate to null.

**Parameter-bound RHS** (`where date(ts) = :p`) is out of scope here — the rule needs a literal RHS at plan time. A follow-up will introduce scalar bound functions (`bucket_lower(:p)` / `bucket_upper(:p)`) backed by the same `bucketBounds`.

## Predicate Analysis and Pushdown

The optimizer includes sophisticated predicate analysis for pushdown optimization:

```typescript
import { extractConstraints, createTableInfoFromNode } from '../analysis/constraint-extractor.js';

// Extract constraints from filter predicates for pushdown
const tableInfo = createTableInfoFromNode(tableNode, 'main.users');
const result = extractConstraints(filterPredicate, [tableInfo]);

// Use constraints for virtual table pushdown
const tableConstraints = result.constraintsByTable.get('main.users');
if (tableConstraints) {
  // Push constraints to virtual table via BestAccessPlan API
  const pushedTable = new TableReferenceWithConstraintsNode(
    scope, tableSchema, vtabModule, tableConstraints
  );
}
```

**Predicate Pushdown Implementation:**
- **Normalization**: Pushes NOT, flattens AND/OR (no CNF/DNF), inverts comparisons; collapses small OR-of-equalities to `IN` (only when every disjunct's effective collation matches — see the OR-collapse gates under [Functional Dependencies § Collation gate on equality facts](optimizer-fd.md#collation-gate-on-equality-facts)); preserves BETWEEN (NOT BETWEEN remains residual).
- **Constraint Extraction**: Analyzes equality/range (`=`, `>`, `>=`, `<`, `<=`), `IS NULL`/`IS NOT NULL`, `BETWEEN` (as `>=`/`<=`), and `IN` value lists. Supports dynamic bindings: parameters and correlated references are captured alongside literal values.
  - **Wrapper rule** (ticket `bug-cast-stripped-from-seek-constraints`): shape matching sees through a `CAST` only when it is a no-op (target logical type == the operand's, per `isNoOpCast`), and never through a `COLLATE`. A converting cast on either compared operand changes the value the seek key would carry — `cast(x as integer) = 1` over a `text` key would seek the integer `1` against stored text — so the conjunct stays residual. The planner reaches this shape without any written `cast(...)`: `insertCrossTypeCoercion` wraps the textual operand of `where x = 1`. The one exception is the *value* side's `bindingKind` classification, which looks through any cast because the emitted constraint retains the whole `CastNode` in `valueExpr` and evaluates it at runtime — that keeps `x = cast(:p as integer)` seekable. "Target logical type" is what `inferType` resolves the written name to, on both the planner and the emitter side, so an affinity-only alias of the operand's type (`cast(x as nvarchar)` over a `text` key) is a no-op and still seeks. Pinned by `test/logic/05.2-cast-seek-correctness.sqllogic` (rows) and `test/plan/cast-seek-blocking.spec.ts` (plan shape).
- **Supported-only placement**: Only the portion of a predicate that is known to be supported by the target module/index is pushed into the `Retrieve` pipeline. Any residual (unsupported) part remains above the `Retrieve`. This guarantees the `Retrieve` pipeline exclusively contains supported operations.
- **Module Validation via supports()**: For query-based modules, a predicate (or entire filter node) is only pushed below the `RetrieveNode` when `supports()` accepts the resulting pipeline. Acceptance typically implies significantly lower cost and should be preferred over mere proximity to the data source.
- **Index-style Fallback**: When a module does not implement `supports()`, push-down uses `getBestAccessPlan()` for constraints translation; benefits may come from filter handling, ordering, and limit pushdown.
- **Committed access paths are off limits** (ticket `bug-filter-conjunct-lost-under-index-order`): a predicate is never pushed into a `Retrieve` whose `moduleCtx` already holds an index-style context. Once `ruleGrowRetrieve` sets that context, `ruleSelectAccessPath` builds the physical leaf from `accessPlan` + `residualPredicate` alone and never reads `Retrieve.source` — anything pushed in there is silently discarded, and the query returns unfiltered rows. Declining costs nothing: the Filter stays above the `Retrieve`, where `ruleGrowRetrieve` re-probes `getBestAccessPlan()` with the constraint and residualizes whatever the module declines. Pinned by `test/logic/07.7.5-filter-lost-under-index-order.sqllogic` (rows) and `test/filter-lost-under-index-order.spec.ts` (plan shape).
- **Filter Elimination**: Removes Filter nodes when all predicates are successfully handled by the module/index.
- **Multi-table Support**: Modules may accept complex subtrees (including joins) in a single `supports()` call when multiple relations belong to the same module.

## Key-driven row-count reduction

> **Invariant:** [OPT-040](invariants.md#opt-040--a-fanning-join-downgrades-the-non-preserved-side), [OPT-042](invariants.md#opt-042--an-outer-join-drops-the-null-padded-sides-facts), [OPT-056](invariants.md#opt-056--an-inclusion-dependency-is-dropped-when-unsure)

* If a predicate contains **equality** on all columns of a unique key the result cardinality ≤ 1.
* See [Functional Dependency Tracking](optimizer-fd.md); a unique key is encoded as the FD `key → all_other_cols`, and the broader `fds`/`equivClasses` fields capture additional non-key dependencies.

**Shared join key-coverage analysis** (`analyzeJoinKeyCoverage` in `key-utils.ts`):
- Extracts equi-join column index pairs from join conditions
- Checks coverage via the unified `isUnique(eqIndices, side)` surface — kind-aware, with empty-key (≤1-row) recognition: a ≤1-row side has `[]` in `keysOf`, and `[] ⊆ anything`, so it is reported covered regardless of equi-pairs. (Builds a `KeyRel` per side over `getType()` + `physical`; when the side's logical type is unavailable it falls back to declared-logical-keys-coverage OR `isUniqueDeterminant(eqSet, fds, colCount, /* isSet */ false)` — conservative, since coverage alone must never mint a preserved key: `withKeyFds` turns preserved keys into `'unique'` FDs downstream.)
- Preserved keys are sourced from `keysOf(side)` (declared + FD-derived + empty key), so FD-only keys flow through (the prior logical-keys-only completeness gap is closed). When **both** sides are ≤1-row (`isAtMostOneRow(side)`), the empty key `[]` is pushed for inner / cross / left / right (not full outer), which `propagateJoinFds` materializes as the singleton `∅ → all_cols` FD
- INNER / CROSS: when side B's key is covered, preserves side A's unique keys (both directions can apply) — `propagateJoinFds` materializes each preserved key as a `key → all_other_join_cols` FD (`kind: 'unique'`) on the join output — and caps `estimatedRows` at side A's row count. **Fanning-side FDs are downgraded, not dropped:** when a side is *not* preserved (no preserved key lies entirely within its columns) the join fans it out, so `propagateJoinFds` downgrades that side's FDs — guarded ones included — `'unique'` → `'determination'` (`downgradeUniqueFds`). The value claims survive for closure consumers (ORDER BY pruning, GROUP BY simplification), and the kind-aware readers never read them as keys. The genuinely-surviving keys (e.g. the composite product key of a bare cross join) are added via the preserved-key list
- LEFT outer: when the **right** side's key is covered, preserves the **left** side's unique keys and caps `estimatedRows` at left's row count. The right-side keys are NOT propagated — unmatched left rows produce NULL-padded right columns, breaking right uniqueness. If the right key is not covered the left side fans out, so no keys propagate and `propagateJoinFds` downgrades the left side's FDs to `'determination'` (mirroring INNER/CROSS)
- RIGHT outer: symmetric to LEFT
- FULL outer: no keys propagate (both sides can be NULL-padded)
- SEMI / ANTI: left's keys pass through unchanged (left-only output, no null-padding)
- Used by all three join node types: `JoinNode`, `BloomJoinNode`, `MergeJoinNode`

**FK→PK inference** (`rule-join-key-inference.ts` + `CatalogStatsProvider`):
- When equi-join pairs align with a foreign key→primary key relationship, the PK side's key is guaranteed covered (each FK row matches ≤1 PK row)
- `CatalogStatsProvider.joinSelectivity()` uses FK→PK detection to produce tighter selectivity (`1/ndv_pk`) instead of the general `1/max(ndv_left, ndv_right)`
- FK constraints stored in `TableSchema.foreignKeys`, extracted from AST during CREATE TABLE
- Unique constraints stored in `TableSchema.uniqueConstraints`, surfaced as additional `RelationType.keys` (only when **all constrained columns are NOT NULL** and the constraint is **not partial** — partial UNIQUE constraints, i.e. those carrying a `predicate` from `CREATE UNIQUE INDEX ... WHERE ...`, only guarantee uniqueness within their scope and would derive an unsound `K → all-other-cols` FD over the whole table; see `relationTypeFromTableSchema` in `src/planner/type-utils.ts`). Partial UCs are instead routed through `partial-unique-extraction.ts` to emit *guarded* FDs that Filter activation discharges when a surrounding predicate entails the partial WHERE — see [Functional Dependencies § Guarded (conditional) FDs](optimizer-fd.md#guarded-conditional-fds).

**Inclusion-dependency reasoning** (`util/ind-utils.ts` + `rule-anti-join-fk-empty.ts` + `rule-semi-join-fk-trivial.ts` + `rule-join-elimination.ts`):

Foreign keys are inclusion dependencies — `child.fk ⊆ parent.pk` — and three optimizer rules exploit them to remove parent-side access entirely. All three run in the Structural pass, after `rule-subquery-decorrelation` has materialized `EXISTS / NOT EXISTS / IN` as semi/anti joins — and after `semijoin-existence-recovery` has recovered a semi/anti join from a probe-only outer-join `exists … as` flag (`where flag` / `where not flag`), which the folders treat identically (a covering-FK semi recovered from `where flag` folds to L just as a decorrelated `EXISTS` semi does). The shared util `lookupCoveringFK` walks `TableSchema.foreignKeys`, matches the equi-pairs against the FK's declared *positional* pairing (`fk.columns[i] → referencedColumns[i]` — a permuted equi-pair set on a composite FK such as `(fa = b AND fb = a)` against `FOREIGN KEY (fa, fb) REFERENCES p(a, b)` is **not** covered and the rule abstains), and reports the matched FK plus whether any child column is nullable; `isRowPreservingPathToTable` guards against parent-side filters/limits/distincts that would invalidate the IND under filtering.

**Output indices are not table column indices.** `lookupCoveringFK` speaks *base-table* column indices, while the equi-pairs a rule extracts index each side's *output* attributes. A projection between the join and the table renames, reorders, or drops columns, so the two coincide only by luck — and a coincidence is a wrong fold, not a missed one (`emp.dept_id IN (select dname from dept)` compares against dept's column 1 but reads output column 0, the very index the FK references). `resolveTableColumnMapping` resolves a subtree to its single base table plus the `output column → table column` map, built by attribute identity: a `TableReferenceNode` mints one attribute per table column in order, every pass-through wrapper republishes that id, and anything computed carries a fresh id and therefore maps to nothing. `mapColumnsToTable` translates a rule's equi columns through it and declines when any column has no base-table origin. The two semi/anti folders below translate **both** sides this way; `rule-join-elimination` and `rule-fanout-lookup-join` instead pass raw output indices to `checkFkPkAlignment` and rely on `isRowPreservingPathToTable` rejecting projections (see the `bug-fk-alignment-derived-table-indices` ticket for the outer-join hole that leaves).

- **`rule-anti-join-fk-empty`**: `AntiJoin(L, R, p)` where `p` is AND-of-column-equalities, the equi-pairs cover a non-null FK on L referencing R's PK, and R is a row-preserving path to its base table → rewrite to `EmptyRelationNode` carrying L's attribute IDs and `RelationType`. Correct because the IND guarantees every (non-null) L row has a matching parent in R, so the anti-join is empty.
- **`rule-semi-join-fk-trivial`**: `SemiJoin(L, R, p)` with the same preconditions → rewrite to `L` (every L row matches) if every FK column is NOT NULL, otherwise to `Filter(L, fk_col IS NOT NULL AND …)` (rows with NULL in any FK column never match the equi-condition). Both folders pass `throughProject` to `isRowPreservingPathToTable`, because `rule-subquery-decorrelation`'s uncorrelated-`IN` arm uses the subquery tree verbatim as R — so R is a `Project` over the parent table, which drops no rows and whose column renaming the mapping above already accounts for.
- **`rule-join-elimination` (Aggregate entrypoint)**: `Aggregate(group, aggs, source = chain → Join(L, R))` where the FK-covered `left`/`right`/`inner` join's non-preserved side is referenced by neither the group keys nor any aggregate expression → drop the join, keep the wrapper chain. For `inner` this needs a non-null FK and a row-preserving R (`|L ⋈ R| == |L|` only when no NULL-FK row is silently dropped); for `left`/`right` it needs **neither** — `L LEFT JOIN R` preserves every L row (matched → 1, unmatched → 1 null-padded) and FK→PK alignment caps matches at ≤1, so `|L LEFT JOIN R| == |L|` *unconditionally*. Covers `count(*) from child left join parent on …`. A `hasExistenceColumns` guard abstains when a live `exists … as` flag is present (its attr id is invisible to the demand scan); the sibling `join-existence-pruning-aggregate` strips undemanded flags first, so the two cascade. The `right` arm is the mirror of `left` (FK on the *preserved* right side); since RIGHT-JOIN execution is unimplemented (`emit/join.ts` throws `RIGHT JOIN is not supported yet`), eliminating an FK-covered RIGHT join is what lets a `count(*)` over it return a result at all rather than throw.

The federated-vtab payoff: each fold removes a remote round-trip to the parent table. Rules abstain conservatively when: the FK is undeclared, equi-pairs don't cover all FK columns, the parent side has a row-reducing wrapper (Filter, LimitOffset, Distinct, non-trivial Retrieve pipeline — plus Project for the join-elimination entrypoints, which pass raw output indices; the two semi/anti folders translate and so peel it), an equi column has no base-table origin (a computed projection), or — for the anti-join and inner-join cases — any FK column is nullable.

The anti-join-to-empty rewrite emits `EmptyRelationNode` carrying L's attribute IDs and `RelationType`. Downstream the const-fold pass (`rule-empty-relation-folding`, Structural) cascades that emptiness up through immediate Filter / Project / Sort / LimitOffset / Distinct / inner-or-cross-or-semi-anti joins; see "Empty-relation folding" below.

> **IND promotion note.** INDs are now *also* a first-class propagated dependency-family
> member of `PhysicalProperties` (`inds`) — seeded from declared FKs at the table
> reference and propagated through joins/projections; see § [Inclusion Dependency
> Tracking](optimizer-fd.md#inclusion-dependency-tracking). That propagated set is a **parallel
> derivation surface**, not a migration: the three rules above still consume the FK
> *declaration* directly via the on-demand `util/ind-utils.ts` helpers (they need the
> nullability split and positional composite pairing a coarse `child ⊆ parent` fact does
> not carry). The **only** consumer of `inds` is the coverage prover, which reads the
> FK-seeded `kind:'table'` INDs; the lens
> existence-anchor injection (`lens-multi-source-ind-injection`) is the first
> `kind:'relation'` producer. For a primary-storage advertisement's **synthesized
> decomposition body**, the lens compiler (`computeExistenceAnchorInds` in
> `schema/lens-compiler.ts`) mints one IND per **mandatory**, non-anchor, non-EAV
> member asserting `anchor.key ⊆ member.key` — `cols` = the **anchor's** shared-key
> indices, `target = { kind:'relation', relationId: <member>, targetCols: <member's
> shared-key indices> }`, `nullRejecting:false` (total existence). The direction is
> load-bearing: `compileDecompositionBody` roots the left-deep join at the anchor and
> inner-joins each mandatory member, so the no-row-loss obligation is "no anchor row is
> dropped", which the consumer discharges from an IND **on the anchor**
> (`anchor.key ⊆ member.key`). `presence:'mandatory'` ("every logical row has it")
> guarantees exactly that totality; the converse (`member ⊆ anchor`) is intentionally
> **not** asserted because no stated property guarantees member→anchor referential
> integrity — emitting it would over-claim (an orphan mandatory-member row is filtered
> by the inner join, leaving the converse false). Optional members (outer-joined), EAV
> pivots (never inner-joined), and the empty-key singleton inject nothing — any would
> over-claim. Injection is gated to the synthesized-decomposition body: a full
> hand-authored override / single-source default body carries no advertised
> `anchor ⋈ member` join, so it injects nothing. The surrogate join carries no declared
> SQL FK, so `seedTableForeignKeyInds` is blind to it; the fact is recorded on
> `LensSlot.injectedInds` and read by the lens prover off the slot, **not** seeded at
> the member scan (the body is planned before the slot is committed, so a scan-time seed
> would never reach the prover). The trade-off: the relation-IND is visible only to the
> prover (its sole intended consumer), not the general optimizer.

## Empty-relation folding

`EmptyRelationNode` (`planner/nodes/empty-relation-node.ts`) is a schema-polymorphic zero-row relation. Its constructor takes the exact `Attribute[]` and `RelationType` that the surrounding node would have produced, so attribute IDs above the fold site remain stable. It is distinct from `EmptyResultNode` (a `TableAccessNode` tied to a `TableReferenceNode` — the table-access-bound empty result for impossible predicates inferred during access-path planning); `EmptyRelationNode` is unmoored from any specific source.

`rule-empty-relation-folding.ts` runs in the Structural pass — after the IND rules — and rewrites the following shapes (`E = EmptyRelationNode`):

| Host shape                                  | Rewrite                                                          | Note |
|---------------------------------------------|------------------------------------------------------------------|------|
| `Filter(x, lit-false / null / 0)`           | `EmptyRelationNode(x.getAttributes(), x.getType())`              | WHERE-clause truthiness — `false`, `NULL`, `0`, `0n` all reject. |
| `Filter(E, _)`                              | `E` (schema unchanged)                                            | Pass-through. |
| `Project(E, projections)`                   | `EmptyRelationNode(project.getAttributes(), project.getType())`  | Lifts Project's own attribute IDs. |
| `Sort(E, _)`, `LimitOffset(E, _)`, `Distinct(E)` | `E`                                                              | Schema unchanged. |
| `Join(E, R, inner \| cross \| semi)` or `Join(L, E, inner \| cross \| semi)` | `EmptyRelationNode(join.getAttributes(), join.getType())`     | |
| `Join(E, R, left)` or `Join(L, E, right)`   | `EmptyRelationNode(join.getAttributes(), join.getType())`        | Empty driving side. |
| `Join(E, _, anti)`                          | `EmptyRelationNode(join.getAttributes(), join.getType())`        | Anti drives from left only. |
| `Join(E, E, full)` (both empty)             | `EmptyRelationNode(join.getAttributes(), join.getType())`        | A single empty side under FULL still null-pads — don't fold. |

The fold rule's `isEmpty` helper looks through `AliasNode` wrappers (FROM-clause subquery aliases produce these). This is sound for the fold itself because the host node (Join, Filter, Project, …) supplies its own attribute IDs when constructing the new `EmptyRelationNode`; the Alias's rename is discarded along with the Alias.

Cascade limits: the Structural pass traverses top-down, so a parent's rules fire BEFORE its children are visited. When an inner Filter folds to `EmptyRelation` mid-traversal, the residual operators above it (Sort, LimitOffset, Project, Join, …) have already been rule-visited and won't re-fire automatically. The runtime is unaffected — `EmptyRelation` yields no rows, so output is correct — but the plan may still show residual operators above the `EmptyRelation`. The IND rules and the fold rules co-located in the Structural pass mean that whenever the IND rule rewrites an anti-join to `EmptyRelation` *within the same node visit*, the JoinFoldEmpty rule can still fire via the per-node fixed-point loop in `applyPassRules`.

## Predicate contradiction detection

`rule-filter-contradiction.ts` (Structural pass) recognizes when a Filter's predicate, conjoined with the source's `domainConstraints` and literal `constantBindings`, is provably unsatisfiable, and emits `EmptyRelationNode` carrying the Filter's own attribute IDs / RelationType. The const-fold cascade above (Project / Sort / LimitOffset / Distinct / inner-or-cross-or-semi Join) then collapses the surrounding subtree.

The reasoning is implemented by `planner/analysis/sat-checker.ts` — a single-pass per-column accumulator over the conjuncts. Scope is intentionally narrow:

- **In-scope** (can prove `unsat`):
  - Single-column comparisons against literals: `= / == / != / <> / < / <= / > / >=`.
  - Single-column positive `BETWEEN literal AND literal`.
  - Single-column `IN (lit, lit, ...)` and intersection across multiple IN-lists; the empty form `x IN ()` is recognized as trivially `unsat`.
  - Range intersection across multiple bounds, with inclusive/exclusive arithmetic.
  - Domain-vs-predicate intersection (CHECK-derived `range` and `enum`).
  - Literal `ConstantBinding` from the source (treated as a degenerate point range plus singleton enum).
- **Out of scope** (clauses set a per-column `sawUnknown` flag; never produces a false `unsat`):
  - `OR` / `CASE` branch analysis — would require case-decomposition.
  - Cross-column arithmetic (`a + b > 10`), function calls, `LIKE` patterns, `IS NULL` / `IS NOT NULL`, `NOT (...)`, parameter bindings (the runtime value isn't known at plan time).
  - A value-changing `CAST`, or any `COLLATE` wrapper, on a compared operand. Only a no-op cast (target logical type == the operand's) is unwrapped: erasing `cast(x as integer)` would read `x = '1' and cast(x as integer) = 1` as a cross-storage-class contradiction, and erasing `collate` would compare `x collate nocase = 'a' and x collate nocase = 'A'` under `x`'s own (BINARY) collation. Both predicates are satisfiable; both would fold to empty. (`analysis/constraint-extractor.ts`'s `unwrapCast` and `analysis/coarsened-key.ts` apply the same no-op-cast-only rule; for seek witnesses, erasing a converting cast pushes a seek key that is not the stored column value — `cast(x as integer) = 1` over a `text` primary key seeks the integer `1` and matches nothing, with the conjunct consumed so no residual `FILTER` remains. The planner synthesizes exactly that cast for a bare `where x = 1` on a `text` column via `insertCrossTypeCoercion`, so no explicit `cast(...)` is needed to reach the shape.)
  - Outer-join `on`-clause contradiction (null padding survives; deferred).
  - Inner-join `on`-clause contradiction — covered by the filter rule whenever `predicate-pushdown` has lowered the predicate onto a Filter, which is the canonical shape. The standalone `on`-clause variant is a tracked follow-up.

The `sawUnknown` flag is **per column**, not global: a LIKE pattern on `b` does not block proving an interval-range contradiction on `a`.

**Collation.** Literal comparisons use the compared column's declared collation, resolved through the owning `Database` (`db.getCollationResolver()`), so `x = 'a' and x = 'A'` is `unsat` on a BINARY column and satisfiable on a `NOCASE` one — including a `NOCASE` the embedder redefined via `db.registerCollation`. Every mentioned column's collation is resolved **once**, before the conjunct loop. If a name cannot be resolved — no resolver was supplied, or the name is not registered (column DDL does not yet validate collation names on non-TEXT types) — the entire check returns `unknown` and the Filter stands. Assuming BINARY there would let a satisfiable predicate be proved `unsat`, silently dropping rows. The same resolver reaches the set-operation write path's per-leg oracle (`planner/mutation/set-op.ts`), where a false `unsat` would skip a leg the incoming row belongs in.

Prereqs in the propagation chain (already landed):
- `optimizer-check-derived-fds-and-domains` — populates `PhysicalProperties.domainConstraints` from declared CHECK.
- `optimizer-empty-relation-node` — supplies the schema-polymorphic empty target so the rewrite preserves attribute IDs.

**Worked example**:

```sql
CREATE TABLE t (id INTEGER PRIMARY KEY, qty INTEGER, CHECK (qty >= 0));

-- Source advertises domainConstraints = [{ kind: 'range', column: 1, min: 0, minInclusive: true }].
-- WHERE qty < 0 contributes the conjunct `qty < 0` → upper bound 0 exclusive on column 1.
-- Intersection: min=0 (inclusive) ∧ max=0 (exclusive) → empty range → 'unsat'.
SELECT * FROM t WHERE qty < 0;
-- → EmptyRelationNode (the SeqScan and downstream Filter are eliminated by the fold cascade).
```

## DISTINCT elimination

`rule-distinct-elimination.ts`:

- When a `DistinctNode`'s source already has a key (`keysOf(source).length > 0` — declared `RelationType.keys`, a kind-aware FD-derived key, the ≤1-row empty key, or the `isSet` all-columns key), the DISTINCT is redundant and removed
- Registered in the structural pass (after key inference, before predicate pushdown)

## Key inference after projections / joins

* `projectKeys(keys, columnMapping)` pushes keys through `ProjectNode` / `ReturningNode`.
* `combineJoinKeys(leftKeys, rightKeys, joinType, leftColumnCount, equiPairs?)` combines logical `RelationType.keys` across joins:
  * **INNER / CROSS**: coverage-gated, mirroring `analyzeJoinKeyCoverage` — left's keys survive only when `equiPairs` cover a right-side key (each left row matches ≤ 1 right row), and right's keys (shifted) survive only when `equiPairs` cover a left-side key. A key=key join covers both. When neither side is covered but **both** sides are keyed (a bare cross join, or an inner join whose predicate touches no key), the result is keyed by the **composite product key** `(leftKey ∪ rightKey-shifted)` — see [Joins § Keyed cross/inner (and lateral) product keys](optimizer-joins.md#keyed-crossinner-and-lateral-product-keys). One lex-min product key is emitted (blow-up containment); full-row set-ness is additionally carried by `isSet`. An unconditional union of both sides' individual keys would over-claim: `ta CROSS JOIN tb` repeats `ta`'s PK once per `tb` row, so `ta`'s PK alone is not a key of the product — only the *pair* is.
  * **LEFT**: when `equiPairs` cover any right-side key, left's keys survive (each left row matches ≤ 1 right row); otherwise empty. Right's keys never survive (NULL-padded right columns break uniqueness).
  * **RIGHT**: symmetric — when `equiPairs` cover any left-side key, right's keys (shifted) survive.
  * **FULL**: empty (both sides can be NULL-padded).
  * **SEMI / ANTI**: left's keys pass through unchanged.
  * **Empty-key (≤1-row) coverage**: a length-0 entry in either side's `keys` (e.g. TableDee, or a logically-≤1-row source) is unconditional coverage — `joinPairsCoverKey` treats `[]` as covering regardless of `equiPairs` (a ≤1-row side caps the partner at one match), so LEFT/RIGHT/inner/cross no longer early-return `[]` on an empty `equiPairs` when the opposite side is ≤1-row. When **both** sides carry the empty key, the inner/cross/left/right result advertises the empty key (deduped). Full outer stays empty.
  * If `equiPairs` is omitted, LEFT/RIGHT preserve keys only via an empty-key (≤1-row) opposite side; otherwise they return empty.
  * Equi-pair coverage at the logical-type layer mirrors the physical-side check in `analyzeJoinKeyCoverage`: callers (`JoinNode.getType`, `BloomJoinNode.getType`, `MergeJoinNode.getType`) extract column-index pairs from their condition/`equiPairs` field and pass them through.

* **Logical-vs-physical layering** (why `combineJoinKeys` has no FD-superkey branch): the two layers stay distinct and consistent. `combineJoinKeys` (logical → `getType().keys`) recognizes only the **logical** empty key (a length-0 `RelationType.keys` entry); it has no FD access by design — `getType()` is the logical type and must not read physical properties. The FD-aware coverage (empty key from `∅ → all` FDs, FD-derived keys) lives in the **physical** path (`analyzeJoinKeyCoverage` → `propagateJoinFds`), where FDs exist, via a single `isUnique` call. Downstream consumers read uniqueness through `keysOf` / `isUnique`, which consult **both** `getType().keys` and `physical.fds` — so a join whose ≤1-row-ness is only FD-provable still surfaces the empty key through the physical FD branch. `getType().keys` carrying only logical-derived keys is therefore correct and sufficient.

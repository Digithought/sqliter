/**
 * Materialized-view maintenance — plan-tree analysis helpers.
 *
 * The stateless utilities the maintenance plan builders lean on: recursive plan-tree
 * walks (find/count node types, collect table refs + attribute provenance), the
 * collation/determinism/replicability gates, the create-time rejection diagnostics, and
 * the single-source scalar-expression evaluator. Split out of
 * `database-materialized-views.ts` so the manager class and its plan builders read on
 * their own; every function here is a pure move (no `MaterializedViewManager` state).
 */

import { QuereusError } from '../common/errors.js';
import { StatusCode, type SqlValue, type Row } from '../common/types.js';
import { BlockNode } from '../planner/nodes/block.js';
import { PlanNode, type ScalarPlanNode, type RowDescriptor, type RelationalPlanNode, isRelationalNode, isScalarNode } from '../planner/nodes/plan-node.js';
import { ColumnReferenceNode, TableReferenceNode } from '../planner/nodes/reference.js';
import { FilterNode } from '../planner/nodes/filter.js';
import { AggregateNode } from '../planner/nodes/aggregate-node.js';
import { TableFunctionCallNode } from '../planner/nodes/table-function-call.js';
import { PlanNodeType } from '../planner/nodes/plan-node-type.js';
import { checkDeterministic } from '../planner/validation/determinism-validator.js';
import { emitPlanNode } from '../runtime/emitters.js';
import { EmissionContext } from '../runtime/emission-context.js';
import { Scheduler } from '../runtime/scheduler.js';
import { RowContextMap } from '../runtime/context-helpers.js';
import type { RuntimeContext } from '../runtime/types.js';
import { normalizeCollationName } from '../util/comparison.js';
import type { MaintainedTableSchema } from '../schema/derivation.js';
import type { FunctionSchema } from '../schema/function.js';
import { uniqueEnforcementCollations } from '../schema/unique-enforcement.js';
import type { Database } from './database.js';
import type { MaintenancePlan } from './database-materialized-views-plans.js';

/** True for the default (binary) collation: an absent name or a case-insensitive
 *  `BINARY`. Non-binary collations gate off the prefix-scan fast path (see
 *  {@link MaterializedViewManager.tryBuildCoveringPrefix}). */
export function isBinaryCollation(collation: string | undefined): boolean {
	return collation === undefined || collation.toUpperCase() === 'BINARY';
}

/** Canonical upper-case collation name (absent ⇒ `BINARY`). Used to compare a backing-PK
 *  column's collation against its source PK column's at plan-build (see
 *  {@link MaterializedViewManager.buildLateralTvfPrefixDeletePlan}). */
export function normalizeCollation(collation: string | undefined): string {
	return (collation ?? 'BINARY').toUpperCase();
}

export function mvKey(schemaName: string, name: string): string {
	return `${schemaName}.${name}`.toLowerCase();
}

/** Every source base (lowercased `schema.table`) a plan must be indexed under in
 *  `rowTimeBySource`. Single-source arms read one base; the 1:1-join arm also reads
 *  the lookup base, so a write to `P` fires maintenance too; the full-rebuild floor reads
 *  every source its body touches (set-op legs, all join sources). */
export function planSourceBases(plan: MaintenancePlan): string[] {
	if (plan.kind === 'full-rebuild') {
		return plan.sourceBases;
	}
	if (plan.kind === 'join-residual' && plan.lookupBase !== plan.sourceBase) {
		return [plan.sourceBase, plan.lookupBase];
	}
	return [plan.sourceBase];
}

/** Walk the whole plan; return the string form of the first non-deterministic scalar
 *  expression (a `random()`/`now()`/volatile UDF, anywhere in the body), or `undefined`
 *  when the body is fully deterministic. The full-rebuild floor's whole-body determinism
 *  gate uses this — a non-deterministic body can never be kept equal to its plain view.
 *  `physical.deterministic` is computed lazily and propagates from leaves, so checking each
 *  scalar node is sound on either the pre-physical or optimized plan. */
export function findNonDeterministic(node: PlanNode): string | undefined {
	if (isScalarNode(node)) {
		const det = checkDeterministic(node as ScalarPlanNode);
		if (!det.valid) return det.expression ?? node.toString();
	}
	for (const child of node.getChildren()) {
		const found = findNonDeterministic(child as unknown as PlanNode);
		if (found) return found;
	}
	return undefined;
}

/** Walk the whole plan; return the NAME of the first function whose schema is not declared
 *  REPLICABLE (bit-identical across peers/platforms/app-versions — built-ins auto-qualify),
 *  or `undefined` when every function in the body qualifies. Mirrors {@link findNonDeterministic}'s
 *  `getChildren()` recursion so nested calls (a UDF inside a builtin inside a UDF) and the
 *  WHERE / GROUP BY / aggregate-arg / TVF-arg positions are all reached. The structural
 *  `'functionSchema' in node` test covers all four function-bearing node kinds uniformly —
 *  scalar (`function.ts`), aggregate (`aggregate-function.ts`), TVF call
 *  (`table-function-call.ts`), and TVF reference (`reference.ts`) — without per-type imports.
 *  Window functions live in a separate builtin-only registry with no UDF registration path and
 *  carry no scalar/aggregate/TVF `functionSchema` on these nodes, so they are inherently
 *  replicable and are never flagged. Consumed only when the backing host declares
 *  `requiresReplicableDerivations` (see {@link MaterializedViewManager.buildMaintenancePlan}). */
export function findNonReplicableFunction(node: PlanNode): string | undefined {
	if ('functionSchema' in node) {
		const schema = (node as unknown as { functionSchema: FunctionSchema }).functionSchema;
		if (schema.replicable !== true) return schema.name;
	}
	for (const child of node.getChildren()) {
		const found = findNonReplicableFunction(child as unknown as PlanNode);
		if (found) return found;
	}
	return undefined;
}

/** The built-in collation names. These are pure JS string operations (`<`/`>`,
 *  locale-independent `toLowerCase()`, ASCII-space trim), so they are bit-identical
 *  across peers' JS engines and auto-qualify as REPLICABLE — exactly parallel to why
 *  built-in functions do. A custom collation must opt in with `replicable: true` at
 *  registration. Short-circuiting on name (regardless of `collationSource`) keeps the
 *  walk free of rank reasoning: a `default` BINARY and an `explicit` NOCASE both pass;
 *  only a custom name is ever subjected to `_isCollationReplicable`. */
const BUILTIN_COLLATION_NAMES: ReadonlySet<string> = new Set(['BINARY', 'NOCASE', 'RTRIM']);

/** True when `collation` is a non-builtin name the database does not assert REPLICABLE.
 *  `undefined`/builtin/replicable ⇒ not offending. */
function collationIsOffending(collation: string | undefined, db: Database): boolean {
	if (collation === undefined) return false;
	const norm = normalizeCollationName(collation);
	if (BUILTIN_COLLATION_NAMES.has(norm)) return false;
	return !db._isCollationReplicable(norm);
}

/**
 * The collation analogue of {@link findNonReplicableFunction}: return the NAME of the
 * first collation that governs derived bytes and is neither built-in nor declared
 * REPLICABLE, or `undefined` when every collation qualifies. Two sources, soundness-first
 * (any non-builtin non-replicable collation anywhere rejects — see the soundness note in
 * `replicable-collation-class`):
 *
 *  1. **Body scalars** — every fold/order/key site (explicit `COLLATE`, a declared/default
 *     column collation, a comparison's effective collation, ORDER BY / GROUP BY / DISTINCT
 *     keys) resolves through some scalar node whose `getType().collationName` carries the
 *     name. One `getChildren()` walk reading that field uniformly reaches them all, including
 *     nested COLLATE, subquery/CTE/set-op legs, and MV-over-MV bodies (whose source columns
 *     carry the producing backing's published collation).
 *  2. **Backing key** — a custom collation can govern the backing key MERGE without appearing
 *     on any body scalar type (a maintained table declared with an explicit
 *     `UNIQUE (… COLLATE custom)` or PK collation the SELECT body never names). The body walk
 *     alone would miss it, so the maintained table's own PK column collations + declared
 *     secondary UNIQUE per-column enforcement collations (resolving an index-derived override
 *     via {@link uniqueEnforcementCollations}) are checked directly — the robust closure.
 *
 * Consumed only when the backing host declares `requiresReplicableDerivations`.
 */
export function findNonReplicableCollation(node: PlanNode, mv: MaintainedTableSchema, db: Database): string | undefined {
	const bodyOffender = findNonReplicableBodyCollation(node, db);
	if (bodyOffender !== undefined) return bodyOffender;
	return findNonReplicableKeyCollation(mv, db);
}

/** Source 1: walk the plan; first scalar node whose resolved `collationName` is a
 *  non-builtin non-replicable collation. Mirrors {@link findNonReplicableFunction}'s
 *  recursion so every body position is reached. */
function findNonReplicableBodyCollation(node: PlanNode, db: Database): string | undefined {
	if (isScalarNode(node)) {
		const collation = (node as ScalarPlanNode).getType().collationName;
		if (collationIsOffending(collation, db)) return normalizeCollationName(collation!);
	}
	for (const child of node.getChildren()) {
		const found = findNonReplicableBodyCollation(child as unknown as PlanNode, db);
		if (found !== undefined) return found;
	}
	return undefined;
}

/** Source 2: the maintained table's backing-key collations — PK column collations and
 *  declared secondary UNIQUE per-column enforcement collations. First non-builtin
 *  non-replicable name returns. */
function findNonReplicableKeyCollation(mv: MaintainedTableSchema, db: Database): string | undefined {
	for (const pk of mv.primaryKeyDefinition) {
		if (collationIsOffending(pk.collation, db)) return normalizeCollationName(pk.collation!);
	}
	for (const uc of mv.uniqueConstraints ?? []) {
		for (const collation of uniqueEnforcementCollations(mv, uc)) {
			if (collationIsOffending(collation, db)) return normalizeCollationName(collation!);
		}
	}
	return undefined;
}

/** Canonical, order-stable, bigint-safe string for a key tuple — used to dedup the
 *  distinct affected backing keys of a single change in the residual-recompute arm. */
export function canonKeyValues(values: readonly SqlValue[]): string {
	return JSON.stringify(values, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v));
}

/** Aggregate node types (logical + physical) — the analyzed plan may carry any. */
const AGGREGATE_NODE_TYPES = new Set<PlanNodeType>([
	PlanNodeType.Aggregate,
	PlanNodeType.StreamAggregate,
	PlanNodeType.HashAggregate,
]);

/** Structural view of an aggregate node shared by the logical/physical variants. */
export interface AggregateLike {
	readonly groupBy: readonly ScalarPlanNode[];
	readonly aggregates: readonly { readonly expression: ScalarPlanNode }[];
}

/** Find the first aggregate node anywhere in the plan. */
export function findAggregate(node: PlanNode): AggregateLike | undefined {
	if (AGGREGATE_NODE_TYPES.has(node.nodeType)) return node as unknown as AggregateLike;
	for (const child of node.getChildren()) {
		const found = findAggregate(child as unknown as PlanNode);
		if (found) return found;
	}
	return undefined;
}

/**
 * Join-bearing PlanNodeTypes (logical + physical). `optimizeForAnalysis` stops
 * before physical join selection, so the analyzed plan carries the logical
 * {@link PlanNodeType.Join}; the physical variants are included so the
 * eligibility gate stays correct if analysis ever surfaces them.
 */
const JOIN_NODE_TYPES = new Set<PlanNodeType>([
	PlanNodeType.Join,
	PlanNodeType.NestedLoopJoin,
	PlanNodeType.HashJoin,
	PlanNodeType.MergeJoin,
	PlanNodeType.KeySetSemiJoin,
	PlanNodeType.FanOutLookupJoin,
	PlanNodeType.AsofScan,
]);

/** True if any node in the plan has the given type (recursive `getChildren` walk). */
export function containsNodeType(node: PlanNode, type: PlanNodeType): boolean {
	if (node.nodeType === type) return true;
	for (const child of node.getChildren()) {
		if (containsNodeType(child as unknown as PlanNode, type)) return true;
	}
	return false;
}

/** True if the plan carries any join node (logical or physical). Used by the
 *  row-time gate, which is single-source — any join is ineligible. */
export function containsAnyJoin(node: PlanNode): boolean {
	for (const t of JOIN_NODE_TYPES) {
		if (containsNodeType(node, t)) return true;
	}
	return false;
}

/** Count nodes of the given type (recursive `getChildren` walk). Used by the
 *  lateral-TVF gate to reject nested/multiple TVFs. */
export function countNodeType(node: PlanNode, type: PlanNodeType): number {
	let n = node.nodeType === type ? 1 : 0;
	for (const child of node.getChildren()) n += countNodeType(child as unknown as PlanNode, type);
	return n;
}

/** Count join nodes (logical + physical) in the plan — used to reject a chained
 *  lateral join (the admitted lateral-TVF shape carries exactly one). */
export function countJoins(node: PlanNode): number {
	let n = 0;
	for (const t of JOIN_NODE_TYPES) n += countNodeType(node, t);
	return n;
}

/** Find the first {@link TableFunctionCallNode} anywhere in the plan, or `undefined`. */
export function findTableFunctionCall(node: PlanNode): TableFunctionCallNode | undefined {
	if (node instanceof TableFunctionCallNode) return node;
	for (const child of node.getChildren()) {
		const found = findTableFunctionCall(child as unknown as PlanNode);
		if (found) return found;
	}
	return undefined;
}

/** Collect `relationKey → TableReferenceNode` over a plan. */
export function collectTableRefs(node: PlanNode, out = new Map<string, TableReferenceNode>()): Map<string, TableReferenceNode> {
	if (node instanceof TableReferenceNode) {
		const base = `${node.tableSchema.schemaName}.${node.tableSchema.name}`.toLowerCase();
		out.set(`${base}#${node.id ?? 'unknown'}`, node);
	}
	for (const child of node.getChildren()) collectTableRefs(child as unknown as PlanNode, out);
	return out;
}

/** Minimal duck-type for nodes (aggregates) that expose attribute provenance. */
interface HasProducingExprs { getProducingExprs(): Map<number, ScalarPlanNode>; }

/**
 * Merge attribute provenance (output attr id → producing scalar expr) from every
 * node that exposes it. Physical aggregates expose `getProducingExprs()`; the
 * logical {@link AggregateNode} present in the pre-physical analyzed plan does
 * not, so its group-by → output-attr mapping is reconstructed directly here.
 */
export function collectProducingExprs(node: PlanNode, out = new Map<number, ScalarPlanNode>()): Map<number, ScalarPlanNode> {
	const fn = (node as Partial<HasProducingExprs>).getProducingExprs;
	if (typeof fn === 'function') {
		for (const [attrId, expr] of fn.call(node)) {
			if (!out.has(attrId)) out.set(attrId, expr);
		}
	} else if (node instanceof AggregateNode) {
		const attrs = node.getAttributes();
		node.groupBy.forEach((expr, i) => {
			const attr = attrs[i];
			if (attr && !out.has(attr.id)) out.set(attr.id, expr);
		});
		node.aggregates.forEach((agg, i) => {
			const attr = attrs[node.groupBy.length + i];
			if (attr && !out.has(attr.id)) out.set(attr.id, agg.expression);
		});
	}
	for (const child of node.getChildren()) collectProducingExprs(child as unknown as PlanNode, out);
	return out;
}

/**
 * Transitive provenance: chase an output-attr → producing `ColumnReference` chain (a
 * Project-over-Aggregate or a passthrough-through-Join adds a hop the single-hop
 * {@link resolveSourceCol} cannot follow) until landing on a base-source column, or
 * `undefined` (e.g. a TVF-output column with no base-source identity). Shared by the
 * aggregate-residual and lateral-TVF arms.
 */
export function resolveTransitiveSourceCol(
	attrId: number,
	sourceAttrToCol: Map<number, number>,
	producingByAttrId: Map<number, ScalarPlanNode>,
): number | undefined {
	const seen = new Set<number>();
	let cur: number | undefined = attrId;
	while (cur !== undefined && !seen.has(cur)) {
		seen.add(cur);
		const direct = sourceAttrToCol.get(cur);
		if (direct !== undefined) return direct;
		const expr = producingByAttrId.get(cur);
		if (expr instanceof ColumnReferenceNode) { cur = expr.attributeId; continue; }
		return undefined;
	}
	return undefined;
}

/**
 * True iff the analyzed join body's WHERE references the lookup table `P` (or any base other
 * than the driving `T`) — the classification the join-residual arm uses to decide whether the
 * lookup side must be delete-capable (see {@link MaterializedViewManager.buildJoinResidualPlan}).
 * The body WHERE — possibly split by predicate-pushdown — surfaces as one or more
 * {@link FilterNode}s above/around the join; the join's own `ON` condition lives inside the
 * JoinNode (not a Filter) and so is excluded. Each column a filter predicate references is
 * resolved against `T`'s attribute→source-column map (transitively); a reference that does NOT
 * resolve to a `T` column is a `P` (the arm requires exactly two base refs, `T` and `P`) — or
 * otherwise non-`T` — reference. Conservative by construction: an unresolved reference counts as
 * lookup-referencing, so the cheaper `T`-only upsert-only path is taken only when **every**
 * filter column provably belongs to `T`.
 */
export function bodyWhereReferencesLookup(
	analyzed: BlockNode,
	tAttrToCol: Map<number, number>,
	producingByAttrId: Map<number, ScalarPlanNode>,
): boolean {
	const filterAttrs = new Set<number>();
	collectFilterPredicateAttrs(analyzed as unknown as PlanNode, filterAttrs);
	for (const attrId of filterAttrs) {
		if (resolveTransitiveSourceCol(attrId, tAttrToCol, producingByAttrId) === undefined) return true;
	}
	return false;
}

/** Collect every attribute id referenced by a ColumnReferenceNode inside any {@link FilterNode}
 *  predicate in the plan (the body WHERE; the join `ON` condition is not a Filter). */
function collectFilterPredicateAttrs(node: PlanNode, out: Set<number>): void {
	if (node instanceof FilterNode) collectColumnRefAttrs(node.predicate as unknown as PlanNode, out);
	for (const child of node.getChildren()) collectFilterPredicateAttrs(child as unknown as PlanNode, out);
}

/** Collect every {@link ColumnReferenceNode} attribute id in a scalar subtree. */
function collectColumnRefAttrs(node: PlanNode, out: Set<number>): void {
	if (node instanceof ColumnReferenceNode) out.add(node.attributeId);
	for (const child of node.getChildren()) collectColumnRefAttrs(child as unknown as PlanNode, out);
}

/**
 * True iff any {@link FilterNode} predicate in the body (the body WHERE) is non-deterministic.
 * The join-residual arm embeds the body WHERE in every residual (forward, in-scope reverse, and
 * — when delete-capable — membership), so a volatile predicate (`random()`/`now()`/a volatile
 * UDF) would make them irreproducible and diverge from the plain view. The arm therefore declines
 * such a body (returns `null` → the full-rebuild floor, which applies the **pragma-gated**
 * whole-body determinism reject — rejected without `pragma nondeterministic_schema`, accepted as a
 * wholesale rebuild with it), preserving the pre-WHERE-widening behavior rather than building an
 * unsound bounded-delta residual.
 */
export function bodyWhereIsNonDeterministic(analyzed: BlockNode): boolean {
	const visit = (node: PlanNode): boolean => {
		if (node instanceof FilterNode && !checkDeterministic(node.predicate).valid) return true;
		for (const child of node.getChildren()) {
			if (visit(child as unknown as PlanNode)) return true;
		}
		return false;
	};
	return visit(analyzed as unknown as PlanNode);
}

/** Read the output attributes of a block's final relational statement. */
export function relationalAttributes(block: BlockNode): ReturnType<TableReferenceNode['getAttributes']> | undefined {
	const children = block.getChildren();
	for (let i = children.length - 1; i >= 0; i--) {
		const child = children[i] as unknown as { getAttributes?: () => ReturnType<TableReferenceNode['getAttributes']> };
		if (typeof child.getAttributes === 'function') return child.getAttributes();
	}
	return undefined;
}

/** The root relational node of a block's final relational statement — the node whose
 *  attributes {@link relationalAttributes} reads — or `undefined`. Feeds the shared
 *  coverage-prover join predicates ({@link proveOneToOneJoin}) for the join-residual arm. */
export function rootRelationalNode(block: BlockNode): RelationalPlanNode | undefined {
	const children = block.getChildren();
	for (let i = children.length - 1; i >= 0; i--) {
		const child = children[i] as unknown as PlanNode;
		if (isRelationalNode(child)) return child as unknown as RelationalPlanNode;
	}
	return undefined;
}

/**
 * The diagnostic for a create-time **hard** reject — one of the four non-shape rejections
 * the cost-gated-with-floor model keeps (non-determinism, bag/no-key, no relational output,
 * size). Names the MV and steers to a plain `view` (live re-evaluation) or
 * `create table ... as <body>` (a one-off snapshot) — never a refresh policy, never an
 * internal implementation detail. Used by the arm builders (for their arm-specific
 * determinism diagnostic) and by {@link MaterializedViewManager.buildFullRebuildPlan}.
 */
export function cannotMaterialize(mvName: string, detail: string): QuereusError {
	return new QuereusError(
		`materialized view '${mvName}' cannot be materialized: ${detail}. For this body, use a `
			+ `plain 'create view' (live re-evaluation) or 'create table ... as <body>' (a one-off snapshot)`,
		StatusCode.UNSUPPORTED,
	);
}

/**
 * The diagnostic for the create-time **replicable-determinism** reject — distinct from
 * {@link cannotMaterialize} because the fix here is not "use a plain view": the body is
 * fine, it just calls a function the backing host requires be REPLICABLE. So this names the
 * function and steers to declaring it `replicable: true` at registration (built-ins qualify
 * automatically). Fires only when the resolved backing host declares
 * `requiresReplicableDerivations`. `StatusCode.UNSUPPORTED`.
 */
export function nonReplicableDerivationError(mvName: string, fnName: string): QuereusError {
	return new QuereusError(
		`materialized view '${mvName}' cannot be materialized on this backing host: it calls non-replicable `
			+ `function '${fnName}'. This host requires every function in the body to be bit-identical across `
			+ `peers/platforms; declare the function \`replicable: true\` at registration (built-in functions `
			+ `qualify automatically)`,
		StatusCode.UNSUPPORTED,
	);
}

/**
 * The diagnostic for the create-time **replicable-collation** reject — the collation
 * analogue of {@link nonReplicableDerivationError}. The body is fine; it just folds or
 * orders (comparison / ORDER BY / GROUP BY / DISTINCT / backing key) under a collation the
 * backing host requires be bit-identical across peers — so this does NOT steer to a plain
 * view. It names the collation and steers to declaring it `replicable: true` at registration
 * (built-in collations qualify automatically). Fires only when the resolved backing host
 * declares `requiresReplicableDerivations`. `StatusCode.UNSUPPORTED`.
 */
export function nonReplicableCollationDerivationError(mvName: string, collationName: string): QuereusError {
	return new QuereusError(
		`materialized view '${mvName}' cannot be materialized on this backing host: it folds or orders under `
			+ `non-replicable collation '${collationName}'. This host requires every collation in the body to be `
			+ `bit-identical across peers/platforms; declare the collation \`replicable: true\` at registration `
			+ `(built-in collations qualify automatically)`,
		StatusCode.UNSUPPORTED,
	);
}

/**
 * True iff a computed projection expression can be evaluated as a pure function of the
 * changed source row — i.e. it contains no subquery / relational subtree (cross-row) and
 * every column reference resolves to a source column (no correlated / outer reference).
 * This is the "shape" gate distinct from the determinism gate (a determinism failure is
 * caught earlier by `checkDeterministic`); a `false` here is a `null` fall-through to the
 * full-rebuild floor, not a hard reject.
 */
export function isSingleRowEvaluable(expr: ScalarPlanNode, sourceDescriptor: RowDescriptor): boolean {
	const visit = (node: PlanNode): boolean => {
		if (node !== expr && isRelationalNode(node)) return false; // a subquery / relational subtree
		if (node instanceof ColumnReferenceNode && sourceDescriptor[node.attributeId] === undefined) {
			return false; // references a value outside the source row
		}
		for (const child of node.getChildren()) {
			if (!visit(child as unknown as PlanNode)) return false;
		}
		return true;
	};
	return visit(expr);
}

/**
 * Compile a deterministic scalar plan node into a per-source-row evaluator by reusing
 * the runtime: emit the node once, then run it against a row context that maps each
 * source attribute id to its column index in the changed row. Reusing the runtime
 * (rather than a hand-rolled scalar interpreter) guarantees a computed backing value is
 * byte-for-byte what `select <body>` would produce — the materialized-view ≡ view
 * contract. The gated forms (deterministic scalars over a single row, no subqueries —
 * see {@link assertSingleRowEvaluable}) resolve synchronously; a Promise result would
 * signal an unsupported async form and is surfaced loudly rather than silently awaited.
 */
export function compileSourceRowEvaluator(
	db: Database,
	expr: ScalarPlanNode,
	sourceDescriptor: RowDescriptor,
): (row: Row) => SqlValue {
	const instruction = emitPlanNode(expr, new EmissionContext(db));
	const scheduler = new Scheduler(instruction);
	const context = new RowContextMap();
	let currentRow: Row = [];
	// Installed once; the getter reads the closed-over `currentRow`, refreshed per call.
	context.set(sourceDescriptor, () => currentRow);
	const rctx: RuntimeContext = {
		db,
		stmt: undefined,
		params: {},
		context,
		tableContexts: new Map(),
		enableMetrics: false,
	};
	return (row: Row): SqlValue => {
		currentRow = row;
		const result = scheduler.run(rctx);
		if (result instanceof Promise) {
			throw new QuereusError(
				'a row-time projection expression evaluated asynchronously (unexpected for a gated single-row scalar)',
				StatusCode.INTERNAL,
			);
		}
		return result as SqlValue;
	};
}

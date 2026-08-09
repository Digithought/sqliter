/**
 * Public change-scope data contract and analyzer.
 *
 * `ChangeScope` is the external, serializable projection of the internal
 * `BindingMode` shape from `binding-extractor.ts`. It tells a caller what
 * base-table state a prepared `Statement` may read from, with as much
 * narrowing as the optimizer can prove statically (binding keys, group
 * keys, parameter placeholders).
 *
 * The data contract is plain JSON (after sorted-array normalization of the
 * `columns` set), so callers can serialize a scope, ship it over a wire,
 * and deserialize it on the other side.
 *
 * Companion watcher (`Database.watch`) ships separately and consumes the
 * same shape.
 */
import type { SqlValue, SqlParameters } from '../../common/types.js';
import type { CollationSource, ScalarType } from '../../common/datatype.js';
import { isRelationalNode } from '../nodes/plan-node.js';
import type { PlanNode, RelationalPlanNode, ScalarPlanNode } from '../nodes/plan-node.js';
import { TableReferenceNode, ColumnReferenceNode, ParameterReferenceNode } from '../nodes/reference.js';
import { ScalarFunctionCallNode } from '../nodes/function.js';
import { SequenceNode } from '../nodes/sequence-node.js';
import { PlanNodeType } from '../nodes/plan-node-type.js';
import { FunctionFlags } from '../../common/constants.js';
import { extractBindings, type BindingMode } from './binding-extractor.js';
import { extractConstraintsForTable } from './constraint-extractor.js';
import { compareSqlValues } from '../../util/comparison.js';
import { getTypeOrDefault } from '../../types/registry.js';

/** Qualified base-table name, lowercased. */
export interface QualifiedName {
	readonly schema: string;
	readonly table: string;
}

/** A non-deterministic input that means "watching state alone won't tell you when the result changes." */
export type NonDetSource =
	| { readonly kind: 'time' }
	| { readonly kind: 'random' }
	| { readonly kind: 'volatileUdf'; readonly name: string }
	| { readonly kind: 'parameter'; readonly index: number | string };

/** A bound or unbound value pinning a key column. */
export type ScopeValue =
	| SqlValue
	| ParamScopeValue;

/**
 * Portable, clone- and JSON-safe description of a parameter's declared scalar
 * type. Carries the logical type's *name* (resolvable against the global type
 * registry) plus the metadata flags that callers typically need at the
 * boundary. The full {@link ScalarType} can be reconstructed with
 * {@link scalarTypeFromPortable}.
 */
export interface PortableScalarType {
	readonly typeName: string;
	readonly nullable: boolean;
	readonly collationName?: string;
	/** Provenance of `collationName` — see {@link ScalarType.collationSource}. */
	readonly collationSource?: CollationSource;
	readonly isReadOnly?: boolean;
}

/** An unbound parameter placeholder inside a `ScopeValue` tuple. */
export interface ParamScopeValue {
	readonly kind: 'param';
	readonly index: number | string;
	readonly type: PortableScalarType;
}

function isParamScopeValue(v: ScopeValue): v is ParamScopeValue {
	return v !== null
		&& typeof v === 'object'
		&& !(v instanceof Uint8Array)
		&& !Array.isArray(v)
		&& 'kind' in v
		&& (v as { kind?: unknown }).kind === 'param'
		&& 'index' in v
		&& 'type' in v;
}

function portableFromScalarType(t: ScalarType): PortableScalarType {
	const result: PortableScalarType = {
		typeName: t.logicalType.name,
		nullable: t.nullable,
		...(t.collationName !== undefined ? { collationName: t.collationName } : {}),
		...(t.collationSource !== undefined ? { collationSource: t.collationSource } : {}),
		...(t.isReadOnly !== undefined ? { isReadOnly: t.isReadOnly } : {}),
	};
	return result;
}

/**
 * Reconstruct a full {@link ScalarType} from a {@link PortableScalarType} by
 * resolving the logical type through the global type registry. Useful for
 * callers that received a deserialized {@link ChangeScope} and need to feed
 * the parameter type into other planner APIs.
 */
export function scalarTypeFromPortable(p: PortableScalarType): ScalarType {
	const logical = getTypeOrDefault(p.typeName);
	return {
		typeClass: 'scalar',
		logicalType: logical,
		nullable: p.nullable,
		...(p.collationName !== undefined ? { collationName: p.collationName } : {}),
		...(p.collationSource !== undefined ? { collationSource: p.collationSource } : {}),
		...(p.isReadOnly !== undefined ? { isReadOnly: p.isReadOnly } : {}),
	};
}

/** How the scope narrows reads on a single base table. */
export type WatchScope =
	| { readonly kind: 'full' }
	| { readonly kind: 'rows'; readonly key: readonly string[]; readonly values: ReadonlyArray<ReadonlyArray<ScopeValue>> }
	| { readonly kind: 'groups'; readonly groupBy: readonly string[] }
	| { readonly kind: 'rowsByGroup'; readonly groupBy: readonly string[]; readonly values: ReadonlyArray<ReadonlyArray<ScopeValue>> };

/** A watch on one base table referenced by the plan. */
export interface TableWatch {
	readonly table: QualifiedName;
	/**
	 * Columns of the table actually read by the plan. `'all'` covers both
	 * count-style plans that read nothing column-specific AND whole-row reads
	 * (`select *`) that forward the table's entire attribute set to the output —
	 * in either case the watch maps downstream to a row-level dep rather than a
	 * cell dep on an enumerated column subset.
	 */
	readonly columns: ReadonlySet<string> | 'all';
	readonly scope: WatchScope;
}

/** Top-level result: per-table watches plus non-deterministic inputs. */
export interface ChangeScope {
	readonly watches: ReadonlyArray<TableWatch>;
	readonly nonDeterministicSources: ReadonlyArray<NonDetSource>;
	readonly unboundParameters: ReadonlyArray<number | string>;
}

/* --- Watcher types (consumed by Database.watch) -------------------------- */

/**
 * Handle returned by `Database.watch(scope, handler)`. Calling
 * `unsubscribe()` stops further firings and releases any capture-spec
 * demand the subscription registered. Idempotent.
 */
export interface Subscription {
	readonly id: string;
	unsubscribe(): void;
}

/**
 * Per-watch hit produced for a single fired `WatchEvent`.
 *
 * - For a `rows` / `rowsByGroup` watch, `hits` lists the bound tuples
 *   from the watch's `values` that intersected the changes in this txn.
 * - For a `groups` watch, `hits` lists the distinct group-key tuples
 *   touched in this txn.
 * - For a `full` watch, `hits` is always empty (the watch describes the
 *   whole table — there is no narrower set of keys to report).
 */
export interface MatchedWatch {
	readonly watch: TableWatch;
	readonly hits: ReadonlyArray<ReadonlyArray<SqlValue>>;
}

/**
 * Event delivered to a `WatchHandler` after a transaction commits.
 *
 * `matched` contains one entry per `TableWatch` in the subscription's
 * scope that actually saw a change in this transaction; watches that
 * weren't touched are omitted. The handler is not invoked at all when
 * `matched` would be empty.
 */
export interface WatchEvent {
	readonly matched: ReadonlyArray<MatchedWatch>;
	readonly txnId: string;
}

/**
 * Handler signature for `Database.watch`. May be sync or async. A
 * Promise return is awaited before the watcher proceeds to the next
 * subscription; rejections are logged and swallowed (watcher errors
 * do not roll back the commit — assertions own that contract).
 */
export type WatchHandler = (event: WatchEvent) => void | Promise<void>;

/* --- Constants ----------------------------------------------------------- */

const KNOWN_TIME_FUNCS = new Set([
	'now', 'current_timestamp', 'current_time', 'current_date',
	'date', 'time', 'datetime', 'julianday',
	'epoch_s', 'epoch_ms', 'epoch_s_frac',
	'strftime',
]);
const KNOWN_RANDOM_FUNCS = new Set(['random', 'randomblob']);

const DML_NODE_TYPES = new Set<PlanNodeType>([
	PlanNodeType.Update,
	PlanNodeType.Insert,
	PlanNodeType.Delete,
	PlanNodeType.UpdateExecutor,
]);

/* --- Analyzer ------------------------------------------------------------ */

/**
 * Resolves a table reference's qualified name to the source-union `ChangeScope`
 * that should replace its watch. The sole use is projecting a materialized
 * view's backing-table reference onto the sources whose mutations actually drive
 * its maintenance, widening a watch on the view to a watch on its sources.
 * Returns `undefined` for anything that is not an MV backing table (ordinary
 * tables).
 *
 * This projection is **conservative, not load-bearing**: a maintained table now
 * appears in the transaction change log in its own right, because row-time
 * maintenance records each realized backing delta there
 * (`MaterializedViewManager.recordMaintenanceChanges`). A direct watch on the
 * backing would therefore fire. The projection is kept because it also widens
 * the watch's *granularity* to the sources — removing it would change which
 * writes a watcher observes, which is a separate decision.
 */
export type MaterializedViewSourceResolver = (table: QualifiedName) => ChangeScope | undefined;

/**
 * Walk a (post-analysis) plan and produce its `ChangeScope`. If `params`
 * is supplied, parameter placeholders are substituted in-place and the
 * corresponding indices are dropped from `unboundParameters`. If
 * `resolveMaterializedViewSource` is supplied, an incremental-MV backing-table
 * reference is projected onto its cached source-union scope (see
 * {@link MaterializedViewSourceResolver}).
 */
export function analyzeChangeScope(
	plan: PlanNode,
	options?: {
		params?: SqlParameters | SqlValue[];
		resolveMaterializedViewSource?: MaterializedViewSourceResolver;
	},
): ChangeScope {
	const dmlWithoutReturning = isDmlWithoutReturning(plan);
	const { perRelation } = extractBindings(plan as RelationalPlanNode);

	const tableRefs = collectTableRefs(plan);

	const columnsByRelKey = collectColumnReads(plan, tableRefs);
	const nonDetSources: NonDetSource[] = [];
	const unboundParams = new Set<number | string>();
	collectNonDeterminism(plan, nonDetSources, unboundParams, perRelation);

	const watches: TableWatch[] = [];
	// Source-union scopes for any incremental-MV backing references encountered;
	// folded into the result below so they union/dedup against direct reads of
	// the same source table.
	const mvSourceScopes: ChangeScope[] = [];
	if (!dmlWithoutReturning) {
		for (const ref of tableRefs) {
			const relKey = relKeyFor(ref);
			const mode = perRelation.get(relKey);
			if (!mode) continue;

			const schemaName = ref.tableSchema.schemaName.toLowerCase();
			const tableName = ref.tableSchema.name.toLowerCase();
			const table: QualifiedName = { schema: schemaName, table: tableName };

			// An MV's backing table is row-time maintained from its sources. Replace the
			// backing-table watch with the MV's source-union scope so a watcher fires on
			// a SOURCE mutation. Widening, not a prerequisite: maintenance records its
			// realized backing deltas into the change log, so a direct backing watch
			// would fire too (see MaterializedViewSourceResolver).
			const mvScope = options?.resolveMaterializedViewSource?.(table);
			if (mvScope) {
				mvSourceScopes.push(mvScope);
				continue;
			}

			const colIndices = columnsByRelKey.get(relKey);
			const columns: ReadonlySet<string> | 'all' = buildColumnSet(ref, colIndices);
			const scope = buildScopeForMode(plan as RelationalPlanNode, ref, relKey, mode, unboundParams);
			watches.push({ table, columns, scope });
		}
	}

	let scope: ChangeScope = {
		watches: normalizeWatches(watches),
		nonDeterministicSources: normalizeNonDet(nonDetSources),
		unboundParameters: sortedDedupParamIndices(unboundParams),
	};

	for (const mvScope of mvSourceScopes) {
		scope = unionScopes(scope, mvScope);
	}

	if (options?.params !== undefined) {
		scope = bindParameters(scope, options.params);
	}

	return scope;
}

/**
 * Detects an UPDATE/INSERT/DELETE plan with no RETURNING clause: such a plan
 * doesn't surface table state to the caller, so watches are empty (but
 * parameters in the WHERE/SET clauses still count toward unboundParameters).
 */
function isDmlWithoutReturning(plan: PlanNode): boolean {
	// A Sequence node prepends side-effect statements (sunk unreferenced
	// data-modifying CTEs) ahead of the actual statement. Classify by the MAIN
	// child only: the effects' RETURNING clauses are internal to the sunk CTE
	// bodies, not the statement's own RETURNING, and the effects give the node
	// 2+ children so the single-child descent below would stop short.
	if (plan instanceof SequenceNode) {
		return isDmlWithoutReturning(plan.main);
	}

	function hasReturning(node: PlanNode): boolean {
		if (node.nodeType === PlanNodeType.Returning) return true;
		for (const c of node.getChildren()) {
			if (hasReturning(c as unknown as PlanNode)) return true;
		}
		return false;
	}

	function isDmlRoot(node: PlanNode): boolean {
		if (DML_NODE_TYPES.has(node.nodeType)) return true;
		if (node.nodeType === PlanNodeType.Block) {
			// A Block wraps one or more statements; check the last statement.
			const stmts = (node as unknown as { statements: PlanNode[] }).statements;
			if (stmts && stmts.length > 0) {
				return isDmlRoot(stmts[stmts.length - 1]);
			}
		}
		// Some DML may be wrapped by sinks/constraint-check nodes; recurse into
		// a single relational child to find the inner DML.
		const children = node.getChildren();
		if (children.length === 1) return isDmlRoot(children[0] as unknown as PlanNode);
		return false;
	}

	if (!isDmlRoot(plan)) return false;
	return !hasReturning(plan);
}

/* --- Plan walking helpers ------------------------------------------------ */

function relKeyFor(ref: TableReferenceNode): string {
	const base = `${ref.tableSchema.schemaName}.${ref.tableSchema.name}`.toLowerCase();
	return `${base}#${ref.id ?? 'unknown'}`;
}

function collectTableRefs(plan: PlanNode): TableReferenceNode[] {
	const out: TableReferenceNode[] = [];
	const seen = new Set<TableReferenceNode>();
	const visited = new Set<PlanNode>();
	function walk(node: PlanNode): void {
		if (visited.has(node)) return;
		visited.add(node);
		if (node instanceof TableReferenceNode) {
			if (!seen.has(node)) {
				seen.add(node);
				out.push(node);
			}
		}
		for (const c of node.getChildren()) walk(c as unknown as PlanNode);
		// DML write targets (Insert/Update/Delete `.table`) sit OUTSIDE
		// `getChildren()` — they're surfaced via `getRelations()`. Walk those
		// too so a FROM-position DML's write target is captured in the outer
		// statement's ChangeScope. See `docs/change-scope.md` § DML write-target
		// propagation.
		for (const r of node.getRelations()) walk(r as unknown as PlanNode);
	}
	walk(plan);
	return out;
}

/**
 * Walk the plan and, for each TableReference, collect the set of output
 * column indices that any scalar expression in the plan reads. The value is
 * either the explicit set of read column indices, or the `'all'` sentinel when
 * the plan serves the table's whole row to its output (a `select *` /
 * non-enumerable star — see below).
 */
function collectColumnReads(plan: PlanNode, tableRefs: readonly TableReferenceNode[]): Map<string, Set<number> | 'all'> {
	const result = new Map<string, Set<number> | 'all'>();
	const attrToRelKeyAndIdx = new Map<number, { relKey: string; colIdx: number }>();
	const refByRelKey = new Map<string, TableReferenceNode>();
	for (const ref of tableRefs) {
		const relKey = relKeyFor(ref);
		refByRelKey.set(relKey, ref);
		const attrs = ref.getAttributes();
		attrs.forEach((a, i) => attrToRelKeyAndIdx.set(a.id, { relKey, colIdx: i }));
	}

	function visit(node: PlanNode): void {
		if (node instanceof ColumnReferenceNode) {
			const info = attrToRelKeyAndIdx.get(node.attributeId);
			if (info) {
				const cur = result.get(info.relKey);
				// A relKey already pinned to 'all' (whole-row read) stays 'all';
				// individual column reads can't narrow it.
				if (cur !== 'all') {
					const s = cur ?? new Set<number>();
					s.add(info.colIdx);
					result.set(info.relKey, s);
				}
			}
		}
		for (const c of node.getChildren()) visit(c as unknown as PlanNode);
	}
	visit(plan);

	// `select *` (and any unresolved/whole-row star projection) is elided by the
	// planner to a passthrough that forwards the base table's OWN attribute ids
	// straight to the plan output, with no intervening ColumnReferenceNode — so
	// the scan above never records those columns and the watch would under-report
	// its read set (typically to just the WHERE-predicate column). When an output
	// relation forwards a table reference's ENTIRE attribute set, the whole row is
	// served to the caller: pin that table to 'all' so it maps downstream to a
	// row-level dep, not a cell dep on the predicate column. Under-counting here
	// is unsound for a host that emits precise pk+column change events (it would
	// miss changes to every non-predicate column); over-counting only costs an
	// extra wakeup. See `docs/change-scope.md` and the binding DepSpec contract.
	const outputAttrIds = new Set<number>();
	for (const rel of collectOutputRelations(plan)) {
		for (const attr of rel.getAttributes()) outputAttrIds.add(attr.id);
	}
	for (const [relKey, ref] of refByRelKey) {
		const attrs = ref.getAttributes();
		if (attrs.length > 0 && attrs.every(a => outputAttrIds.has(a.id))) {
			result.set(relKey, 'all');
		}
	}

	return result;
}

/**
 * The top-level output relation(s) of a plan — the relations whose attribute
 * lists are the query's result row(s). A `BlockNode` is not itself relational;
 * its result statements are surfaced via `getRelations()`. A bare relational
 * plan is its own output. Only the TOP relations are returned (not their
 * relational descendants) so a forwarded base-table attribute id distinguishes
 * "served to the caller" (whole-row `select *`) from "consumed internally".
 */
function collectOutputRelations(plan: PlanNode): readonly RelationalPlanNode[] {
	if (isRelationalNode(plan)) return [plan];
	return plan.getRelations();
}

/**
 * Walk every scalar expression in the plan and collect non-deterministic
 * sources (volatile functions, parameters used outside a row-binding equality).
 */
function collectNonDeterminism(
	plan: PlanNode,
	out: NonDetSource[],
	unboundParams: Set<number | string>,
	perRelation: ReadonlyMap<string, BindingMode>,
): void {
	// Track parameters that *are* used as the value side of a row-binding
	// equality predicate. These are already represented as ScopeValue.param
	// placeholders inside the watch and don't need to also be flagged as
	// nondeterministic sources (though they remain in unboundParameters).
	const rowBindingParams = collectRowBindingParams(plan, perRelation);

	function visit(node: PlanNode): void {
		if (node instanceof ScalarFunctionCallNode) {
			const isDet = (node.functionSchema.flags & FunctionFlags.DETERMINISTIC) !== 0;
			if (!isDet) {
				const name = node.functionSchema.name.toLowerCase();
				if (KNOWN_TIME_FUNCS.has(name)) {
					out.push({ kind: 'time' });
				} else if (KNOWN_RANDOM_FUNCS.has(name)) {
					out.push({ kind: 'random' });
				} else {
					out.push({ kind: 'volatileUdf', name });
				}
			}
		}
		if (node instanceof ParameterReferenceNode) {
			const id = node.nameOrIndex;
			unboundParams.add(id);
			if (!rowBindingParams.has(id)) {
				out.push({ kind: 'parameter', index: id });
			}
		}
		for (const c of node.getChildren()) visit(c as unknown as PlanNode);
	}
	visit(plan);
}

/** Collect every parameter id used as the value side of a row/group binding equality. */
function collectRowBindingParams(
	plan: PlanNode,
	perRelation: ReadonlyMap<string, BindingMode>,
): Set<number | string> {
	const result = new Set<number | string>();
	for (const [relKey, mode] of perRelation) {
		if (mode.kind === 'global') continue;
		const constraints = extractConstraintsForTable(plan as RelationalPlanNode, relKey);
		const keyCols = mode.kind === 'row' ? mode.keyColumns : mode.groupColumns;
		for (const colIdx of keyCols) {
			const match = constraints.find(c => c.columnIndex === colIdx && (c.op === '=' || c.op === 'IN'));
			if (!match) continue;
			const ve = match.valueExpr;
			if (!ve) continue;
			const exprs: ScalarPlanNode[] = Array.isArray(ve) ? ve : [ve];
			for (const e of exprs) {
				const id = extractParamId(e);
				if (id !== undefined) result.add(id);
			}
		}
	}
	return result;
}

function extractParamId(expr: ScalarPlanNode): number | string | undefined {
	// Unwrap a cast inserted by the planner for cross-category coercion.
	const inner = expr.nodeType === PlanNodeType.Cast
		? (expr as unknown as { operand: ScalarPlanNode }).operand
		: expr;
	if (inner instanceof ParameterReferenceNode) {
		return inner.nameOrIndex;
	}
	return undefined;
}

/* --- Scope building ------------------------------------------------------ */

function buildColumnSet(ref: TableReferenceNode, indices: Set<number> | 'all' | undefined): ReadonlySet<string> | 'all' {
	if (indices === 'all') return 'all';
	if (indices === undefined || indices.size === 0) return 'all';
	const attrs = ref.getAttributes();
	const names = new Set<string>();
	for (const idx of indices) {
		const attr = attrs[idx];
		if (attr) names.add(attr.name.toLowerCase());
	}
	return names;
}

function buildScopeForMode(
	plan: RelationalPlanNode,
	ref: TableReferenceNode,
	relKey: string,
	mode: BindingMode,
	unboundParams: Set<number | string>,
): WatchScope {
	const attrs = ref.getAttributes();
	const colName = (i: number) => attrs[i]?.name.toLowerCase() ?? `_col${i}`;

	if (mode.kind === 'global') {
		return { kind: 'full' };
	}
	if (mode.kind === 'row') {
		// Empty key columns ⇒ the reference is provably ≤1-row (keysOf yielded
		// the empty key). There are no key columns to pin a per-row watch on, so
		// the whole (single-row) table is in scope. 'full' is the sound
		// projection — equivalent for a ≤1-row table.
		if (mode.keyColumns.length === 0) {
			return { kind: 'full' };
		}
		const keyNames = mode.keyColumns.map(colName);
		const values = extractRowKeyValues(plan, relKey, mode.keyColumns, unboundParams);
		// If the binding-extractor classified this as 'row' but we couldn't
		// decode literal/parameter values for every key column (e.g. equality
		// against a complex expression like `pk = a + b`), an empty `values`
		// array would mean "watch zero rows" — strictly less than what the
		// query reads. Fall back to `full` to stay sound.
		if (values.length === 0) return { kind: 'full' };
		return { kind: 'rows', key: keyNames, values };
	}
	// mode.kind === 'group'
	const groupNames = mode.groupColumns.map(colName);
	const values = extractRowKeyValues(plan, relKey, mode.groupColumns, unboundParams);
	if (values.length > 0) {
		return { kind: 'rowsByGroup', groupBy: groupNames, values };
	}
	return { kind: 'groups', groupBy: groupNames };
}

/**
 * For each key column, pick the equality constraint and translate the
 * RHS into a `ScopeValue` (literal or `param` placeholder). Returns one
 * tuple per row-binding values combination present in the constraints.
 */
function extractRowKeyValues(
	plan: RelationalPlanNode,
	relKey: string,
	keyColumns: readonly number[],
	unboundParams: Set<number | string>,
): ReadonlyArray<ReadonlyArray<ScopeValue>> {
	const constraints = extractConstraintsForTable(plan, relKey);

	// For each key column, gather candidate value expressions.
	const perColValues: ScopeValue[][] = [];
	for (const colIdx of keyColumns) {
		const matches = constraints.filter(c => c.columnIndex === colIdx && (c.op === '=' || c.op === 'IN'));
		if (matches.length === 0) return [];
		const colValues = new Set<string>();
		const ordered: ScopeValue[] = [];
		const push = (v: ScopeValue): void => {
			const key = stringifyScopeValue(v);
			if (!colValues.has(key)) {
				colValues.add(key);
				ordered.push(v);
			}
		};
		for (const c of matches) {
			if (c.op === 'IN' && Array.isArray(c.value)) {
				const inExprs = Array.isArray(c.valueExpr) ? (c.valueExpr as ScalarPlanNode[]) : undefined;
				for (let i = 0; i < (c.value as SqlValue[]).length; i++) {
					const v = (c.value as SqlValue[])[i];
					const exprAt = inExprs?.[i];
					if (v !== undefined) {
						push(v);
					} else if (exprAt) {
						const sv = scopeValueFromExpr(exprAt, unboundParams);
						if (sv === undefined) return [];
						push(sv);
					} else {
						return [];
					}
				}
			} else if (c.op === '=') {
				if (c.bindingKind === 'literal' || c.value !== undefined && !c.valueExpr) {
					push(c.value as SqlValue);
				} else if (c.valueExpr && !Array.isArray(c.valueExpr)) {
					const sv = scopeValueFromExpr(c.valueExpr, unboundParams);
					if (sv === undefined) return [];
					push(sv);
				} else if (c.value !== undefined) {
					push(c.value as SqlValue);
				} else {
					return [];
				}
			}
		}
		perColValues.push(ordered);
	}

	// Take the cartesian product but only for single-column keys we keep
	// independent rows; for multi-column keys without a matching tuple
	// extraction the conservative thing is to produce the cross product.
	const tuples = cartesianProduct(perColValues);
	return sortAndDedupTuples(tuples);
}

function scopeValueFromExpr(expr: ScalarPlanNode, unboundParams: Set<number | string>): ScopeValue | undefined {
	const inner = expr.nodeType === PlanNodeType.Cast
		? (expr as unknown as { operand: ScalarPlanNode }).operand
		: expr;
	if (inner instanceof ParameterReferenceNode) {
		unboundParams.add(inner.nameOrIndex);
		return { kind: 'param', index: inner.nameOrIndex, type: portableFromScalarType(inner.targetType) };
	}
	if (inner.nodeType === PlanNodeType.Literal) {
		const lit = inner as unknown as { expression: { value: SqlValue } };
		const v = lit.expression?.value;
		if (v === undefined) return undefined;
		return v;
	}
	return undefined;
}

function cartesianProduct(input: readonly (readonly ScopeValue[])[]): ScopeValue[][] {
	if (input.length === 0) return [];
	if (input.some(arr => arr.length === 0)) return [];
	const result: ScopeValue[][] = [[]];
	for (const arr of input) {
		const next: ScopeValue[][] = [];
		for (const prefix of result) {
			for (const v of arr) {
				next.push([...prefix, v]);
			}
		}
		result.length = 0;
		result.push(...next);
	}
	return result;
}

/* --- Normalization, sorting, dedup --------------------------------------- */

function normalizeWatches(watches: TableWatch[]): TableWatch[] {
	return [...watches].sort(compareWatches);
}

function compareWatches(a: TableWatch, b: TableWatch): number {
	const sc = a.table.schema.localeCompare(b.table.schema);
	if (sc !== 0) return sc;
	const tc = a.table.table.localeCompare(b.table.table);
	if (tc !== 0) return tc;
	const ak = a.scope.kind;
	const bk = b.scope.kind;
	if (ak !== bk) return ak.localeCompare(bk);
	return scopeKeySerialization(a.scope).localeCompare(scopeKeySerialization(b.scope));
}

function scopeKeySerialization(scope: WatchScope): string {
	if (scope.kind === 'full') return 'full';
	if (scope.kind === 'groups') return `groups:${scope.groupBy.join(',')}`;
	if (scope.kind === 'rows') return `rows:${scope.key.join(',')}:${tuplesKey(scope.values)}`;
	return `rowsByGroup:${scope.groupBy.join(',')}:${tuplesKey(scope.values)}`;
}

function tuplesKey(values: ReadonlyArray<ReadonlyArray<ScopeValue>>): string {
	return values.map(t => t.map(stringifyScopeValue).join('|')).join(';');
}

function stringifyScopeValue(v: ScopeValue): string {
	if (isParamScopeValue(v)) {
		return `@${v.index}`;
	}
	if (v === null) return 'null';
	if (typeof v === 'bigint') return `b:${v.toString()}`;
	if (typeof v === 'number') return `n:${v}`;
	if (typeof v === 'string') return `s:${v}`;
	if (typeof v === 'boolean') return `B:${v}`;
	if (v instanceof Uint8Array) return `x:${Array.from(v).map(b => b.toString(16).padStart(2, '0')).join('')}`;
	return `j:${JSON.stringify(v)}`;
}

function sortAndDedupTuples(tuples: ScopeValue[][]): ScopeValue[][] {
	const seen = new Map<string, ScopeValue[]>();
	for (const t of tuples) {
		const k = t.map(stringifyScopeValue).join('|');
		if (!seen.has(k)) seen.set(k, t);
	}
	return [...seen.values()].sort(compareTuples);
}

function compareTuples(a: readonly ScopeValue[], b: readonly ScopeValue[]): number {
	const len = Math.min(a.length, b.length);
	for (let i = 0; i < len; i++) {
		const ca = compareScopeValues(a[i], b[i]);
		if (ca !== 0) return ca;
	}
	return a.length - b.length;
}

function compareScopeValues(a: ScopeValue, b: ScopeValue): number {
	const aIsParam = isParamScopeValue(a);
	const bIsParam = isParamScopeValue(b);
	if (aIsParam && bIsParam) {
		return String(a.index).localeCompare(String(b.index));
	}
	if (aIsParam) return 1;
	if (bIsParam) return -1;
	return compareSqlValues(a as SqlValue, b as SqlValue);
}

function normalizeNonDet(sources: NonDetSource[]): NonDetSource[] {
	const seen = new Map<string, NonDetSource>();
	for (const s of sources) {
		const k = nonDetKey(s);
		if (!seen.has(k)) seen.set(k, s);
	}
	return [...seen.values()].sort((a, b) => nonDetKey(a).localeCompare(nonDetKey(b)));
}

function nonDetKey(s: NonDetSource): string {
	switch (s.kind) {
		case 'time': { return 't'; }
		case 'random': { return 'r'; }
		case 'volatileUdf': { return `u:${s.name}`; }
		case 'parameter': { return `p:${s.index}`; }
	}
}

function sortedDedupParamIndices(set: Set<number | string>): ReadonlyArray<number | string> {
	const arr = [...set];
	arr.sort((a, b) => {
		const aIsNum = typeof a === 'number';
		const bIsNum = typeof b === 'number';
		if (aIsNum && bIsNum) return (a as number) - (b as number);
		if (aIsNum) return -1;
		if (bIsNum) return 1;
		return (a as string).localeCompare(b as string);
	});
	return arr;
}

/* --- Composition helpers ------------------------------------------------- */

/**
 * Build the conservative source-union `ChangeScope` for a materialized view:
 * one `{kind:'full'}` watch (columns `'all'`) per source table. This is the
 * scope a materialized view reference projects to, so a watcher fires on any
 * source mutation. A precise per-source row scope — mirroring the row-time
 * maintenance the `MaterializedViewManager` already derives — is a future
 * refinement.
 *
 * @param sourceTables Qualified lowercased `schema.table` names, as recorded on
 *   `TableDerivation.sourceTables`.
 */
export function buildSourceUnionScope(sourceTables: ReadonlyArray<string>): ChangeScope {
	const watches: TableWatch[] = [];
	for (const qualified of sourceTables) {
		const dot = qualified.indexOf('.');
		const schema = dot >= 0 ? qualified.slice(0, dot) : 'main';
		const table = dot >= 0 ? qualified.slice(dot + 1) : qualified;
		watches.push({ table: { schema, table }, columns: 'all', scope: { kind: 'full' } });
	}
	return {
		watches: normalizeWatches(watches),
		nonDeterministicSources: [],
		unboundParameters: [],
	};
}

export function unionScopes(a: ChangeScope, b: ChangeScope): ChangeScope {
	const byTable = new Map<string, TableWatch>();
	for (const w of a.watches) byTable.set(tableKey(w.table), w);
	for (const w of b.watches) {
		const k = tableKey(w.table);
		const prev = byTable.get(k);
		byTable.set(k, prev ? unionWatch(prev, w) : w);
	}
	return {
		watches: normalizeWatches([...byTable.values()]),
		nonDeterministicSources: normalizeNonDet([...a.nonDeterministicSources, ...b.nonDeterministicSources]),
		unboundParameters: sortedDedupParamIndices(new Set([...a.unboundParameters, ...b.unboundParameters])),
	};
}

export function intersectScopes(a: ChangeScope, b: ChangeScope): ChangeScope {
	const byTableA = new Map<string, TableWatch>();
	for (const w of a.watches) byTableA.set(tableKey(w.table), w);
	const out: TableWatch[] = [];
	for (const w of b.watches) {
		const k = tableKey(w.table);
		const other = byTableA.get(k);
		if (!other) continue;
		const merged = intersectWatch(other, w);
		if (merged) out.push(merged);
	}
	// Intersection of non-determinism is the set-intersection.
	const bNonDet = new Set(b.nonDeterministicSources.map(nonDetKey));
	const sharedNonDet = a.nonDeterministicSources.filter(s => bNonDet.has(nonDetKey(s)));
	// Intersection of unbound parameters is the set-intersection.
	const aParams = new Set(a.unboundParameters);
	const sharedParams = new Set<number | string>();
	for (const p of b.unboundParameters) if (aParams.has(p)) sharedParams.add(p);
	return {
		watches: normalizeWatches(out),
		nonDeterministicSources: normalizeNonDet(sharedNonDet),
		unboundParameters: sortedDedupParamIndices(sharedParams),
	};
}

function tableKey(t: QualifiedName): string {
	return `${t.schema}.${t.table}`;
}

function unionWatch(a: TableWatch, b: TableWatch): TableWatch {
	const columns = unionColumns(a.columns, b.columns);
	const scope = unionWatchScope(a.scope, b.scope);
	return { table: a.table, columns, scope };
}

function unionColumns(a: ReadonlySet<string> | 'all', b: ReadonlySet<string> | 'all'): ReadonlySet<string> | 'all' {
	if (a === 'all' || b === 'all') return 'all';
	const out = new Set<string>(a);
	for (const c of b) out.add(c);
	return out;
}

function unionWatchScope(a: WatchScope, b: WatchScope): WatchScope {
	if (a.kind === 'full' || b.kind === 'full') return { kind: 'full' };

	if (a.kind === 'groups' && b.kind === 'groups') {
		const aSet = new Set(a.groupBy);
		const bSet = new Set(b.groupBy);
		const aSubsetB = [...aSet].every(c => bSet.has(c));
		const bSubsetA = [...bSet].every(c => aSet.has(c));
		if (aSubsetB) return { kind: 'groups', groupBy: a.groupBy };
		if (bSubsetA) return { kind: 'groups', groupBy: b.groupBy };
		return { kind: 'full' };
	}

	if (a.kind === 'rows' && b.kind === 'rows') {
		if (sameKey(a.key, b.key)) {
			return { kind: 'rows', key: a.key, values: mergeValues(a.values, b.values) };
		}
		return { kind: 'full' };
	}

	if (a.kind === 'rowsByGroup' && b.kind === 'rowsByGroup') {
		if (sameKey(a.groupBy, b.groupBy)) {
			return { kind: 'rowsByGroup', groupBy: a.groupBy, values: mergeValues(a.values, b.values) };
		}
		return { kind: 'full' };
	}

	// Mixed shapes (rows vs groups, etc.) cannot be unioned narrowly.
	return { kind: 'full' };
}

function intersectWatch(a: TableWatch, b: TableWatch): TableWatch | null {
	const columns = intersectColumns(a.columns, b.columns);
	const scope = intersectWatchScope(a.scope, b.scope);
	if (!scope) return null;
	return { table: a.table, columns, scope };
}

function intersectColumns(a: ReadonlySet<string> | 'all', b: ReadonlySet<string> | 'all'): ReadonlySet<string> | 'all' {
	if (a === 'all') return b;
	if (b === 'all') return a;
	const out = new Set<string>();
	for (const c of a) if (b.has(c)) out.add(c);
	return out;
}

function intersectWatchScope(a: WatchScope, b: WatchScope): WatchScope | null {
	if (a.kind === 'full') return b;
	if (b.kind === 'full') return a;

	if (a.kind === 'groups' && b.kind === 'groups') {
		const aSet = new Set(a.groupBy);
		const bSet = new Set(b.groupBy);
		const aSubsetB = [...aSet].every(c => bSet.has(c));
		const bSubsetA = [...bSet].every(c => aSet.has(c));
		// Intersect picks the *finer* (longer) groupBy that is a superset of the other.
		if (aSubsetB) return { kind: 'groups', groupBy: b.groupBy };
		if (bSubsetA) return { kind: 'groups', groupBy: a.groupBy };
		return null;
	}

	if (a.kind === 'rows' && b.kind === 'rows') {
		if (!sameKey(a.key, b.key)) return null;
		const merged = intersectValues(a.values, b.values);
		if (merged.length === 0) return null;
		return { kind: 'rows', key: a.key, values: merged };
	}
	if (a.kind === 'rowsByGroup' && b.kind === 'rowsByGroup') {
		if (!sameKey(a.groupBy, b.groupBy)) return null;
		const merged = intersectValues(a.values, b.values);
		if (merged.length === 0) return null;
		return { kind: 'rowsByGroup', groupBy: a.groupBy, values: merged };
	}

	return null;
}

function sameKey(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

function mergeValues(
	a: ReadonlyArray<ReadonlyArray<ScopeValue>>,
	b: ReadonlyArray<ReadonlyArray<ScopeValue>>,
): ReadonlyArray<ReadonlyArray<ScopeValue>> {
	const seen = new Map<string, ReadonlyArray<ScopeValue>>();
	for (const t of a) {
		const k = t.map(stringifyScopeValue).join('|');
		seen.set(k, t);
	}
	for (const t of b) {
		const k = t.map(stringifyScopeValue).join('|');
		if (!seen.has(k)) seen.set(k, t);
	}
	return [...seen.values()].sort(compareTuples);
}

function intersectValues(
	a: ReadonlyArray<ReadonlyArray<ScopeValue>>,
	b: ReadonlyArray<ReadonlyArray<ScopeValue>>,
): ReadonlyArray<ReadonlyArray<ScopeValue>> {
	const bKeys = new Set(b.map(t => t.map(stringifyScopeValue).join('|')));
	return a.filter(t => bKeys.has(t.map(stringifyScopeValue).join('|')));
}

/* --- Parameter binding --------------------------------------------------- */

export function bindParameters(scope: ChangeScope, params: SqlParameters | SqlValue[]): ChangeScope {
	const lookup = (id: number | string): SqlValue | undefined => {
		if (Array.isArray(params)) {
			if (typeof id !== 'number') return undefined;
			const v = params[id - 1];
			return v;
		}
		if (typeof id === 'number') {
			return (params as Record<string, SqlValue>)[id];
		}
		const key = id.startsWith(':') || id.startsWith('@') || id.startsWith('$')
			? id.substring(1)
			: id;
		const obj = params as Record<string, SqlValue>;
		if (key in obj) return obj[key];
		if (id in obj) return obj[id];
		return undefined;
	};

	const substituteValue = (v: ScopeValue): ScopeValue => {
		if (isParamScopeValue(v)) {
			const bound = lookup(v.index);
			if (bound !== undefined) return bound;
		}
		return v;
	};

	const substituteTuples = (tuples: ReadonlyArray<ReadonlyArray<ScopeValue>>): ReadonlyArray<ReadonlyArray<ScopeValue>> => {
		const out = tuples.map(t => t.map(substituteValue));
		return sortAndDedupTuples(out);
	};

	const newWatches: TableWatch[] = scope.watches.map(w => {
		let newScope: WatchScope = w.scope;
		if (w.scope.kind === 'rows') {
			newScope = { kind: 'rows', key: w.scope.key, values: substituteTuples(w.scope.values) };
		} else if (w.scope.kind === 'rowsByGroup') {
			newScope = { kind: 'rowsByGroup', groupBy: w.scope.groupBy, values: substituteTuples(w.scope.values) };
		}
		return { table: w.table, columns: w.columns, scope: newScope };
	});

	const remainingUnbound = new Set<number | string>();
	for (const id of scope.unboundParameters) {
		if (lookup(id) === undefined) remainingUnbound.add(id);
	}

	const remainingNonDet = scope.nonDeterministicSources.filter(s => {
		if (s.kind === 'parameter') return lookup(s.index) === undefined;
		return true;
	});

	return {
		watches: normalizeWatches(newWatches),
		nonDeterministicSources: normalizeNonDet(remainingNonDet),
		unboundParameters: sortedDedupParamIndices(remainingUnbound),
	};
}

/* --- Predicates ---------------------------------------------------------- */

export function isEmpty(scope: ChangeScope): boolean {
	return scope.watches.length === 0
		&& scope.nonDeterministicSources.length === 0
		&& scope.unboundParameters.length === 0;
}

export function describesEverything(scope: ChangeScope): boolean {
	if (scope.watches.length === 0) return false;
	return scope.watches.every(w => w.scope.kind === 'full' && w.columns === 'all');
}

/* --- Serialization ------------------------------------------------------- */

type SerializedWatchScope =
	| { kind: 'full' }
	| { kind: 'rows'; key: string[]; values: SerializedScopeValue[][] }
	| { kind: 'groups'; groupBy: string[] }
	| { kind: 'rowsByGroup'; groupBy: string[]; values: SerializedScopeValue[][] };

type SerializedScopeValue =
	| { v: SqlValue }
	| { p: number | string; t: PortableScalarType };

interface SerializedTableWatch {
	table: QualifiedName;
	columns: string[] | 'all';
	scope: SerializedWatchScope;
}

export interface SerializedChangeScope {
	watches: SerializedTableWatch[];
	nonDeterministicSources: NonDetSource[];
	unboundParameters: ReadonlyArray<number | string>;
}

export function serializeChangeScope(scope: ChangeScope): SerializedChangeScope {
	return {
		watches: scope.watches.map(w => ({
			table: { schema: w.table.schema, table: w.table.table },
			columns: w.columns === 'all' ? 'all' : [...w.columns].sort(),
			scope: serializeScope(w.scope),
		})),
		nonDeterministicSources: [...scope.nonDeterministicSources],
		unboundParameters: [...scope.unboundParameters],
	};
}

function serializeScope(scope: WatchScope): SerializedWatchScope {
	if (scope.kind === 'full') return { kind: 'full' };
	if (scope.kind === 'groups') return { kind: 'groups', groupBy: [...scope.groupBy] };
	if (scope.kind === 'rows') {
		return {
			kind: 'rows',
			key: [...scope.key],
			values: scope.values.map(t => t.map(serializeScopeValue)),
		};
	}
	return {
		kind: 'rowsByGroup',
		groupBy: [...scope.groupBy],
		values: scope.values.map(t => t.map(serializeScopeValue)),
	};
}

function serializeScopeValue(v: ScopeValue): SerializedScopeValue {
	if (isParamScopeValue(v)) {
		return { p: v.index, t: { ...v.type } };
	}
	return { v: v as SqlValue };
}

export function deserializeChangeScope(obj: SerializedChangeScope): ChangeScope {
	return {
		watches: obj.watches.map(w => ({
			table: { schema: w.table.schema, table: w.table.table },
			columns: w.columns === 'all' ? 'all' : new Set<string>(w.columns),
			scope: deserializeScope(w.scope),
		})),
		nonDeterministicSources: [...obj.nonDeterministicSources],
		unboundParameters: [...obj.unboundParameters],
	};
}

function deserializeScope(scope: SerializedWatchScope): WatchScope {
	if (scope.kind === 'full') return { kind: 'full' };
	if (scope.kind === 'groups') return { kind: 'groups', groupBy: [...scope.groupBy] };
	if (scope.kind === 'rows') {
		return {
			kind: 'rows',
			key: [...scope.key],
			values: scope.values.map(t => t.map(deserializeScopeValue)),
		};
	}
	return {
		kind: 'rowsByGroup',
		groupBy: [...scope.groupBy],
		values: scope.values.map(t => t.map(deserializeScopeValue)),
	};
}

function deserializeScopeValue(v: SerializedScopeValue): ScopeValue {
	if ('p' in v) return { kind: 'param', index: v.p, type: { ...v.t } };
	return v.v;
}


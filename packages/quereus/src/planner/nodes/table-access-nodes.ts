/**
 * Physical table access nodes for seek and range scan operations
 * These replace logical TableReferenceNode during optimization
 */

import { PlanNodeType } from './plan-node-type.js';
import { PlanNode, type UnaryRelationalNode, type PhysicalProperties, type Attribute, type MonotonicOnInfo } from './plan-node.js';
import { TableReferenceNode } from './reference.js';
import type { RelationType } from '../../common/datatype.js';
import type { Scope } from '../scopes/scope.js';
import { Cached } from '../../util/cached.js';
import type { FilterInfo } from '../../vtab/filter-info.js';
import type { ScalarPlanNode } from './plan-node.js';
import type { TableAccessCapable } from '../framework/characteristics.js';
import { addSingletonFd } from '../util/fd-utils.js';
import { collectColumnRefAttributeIds } from '../util/column-refs.js';
import { quereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import { accessPathPlan } from '../../vtab/index-descriptor.js';
// Type-only: the runtime cycle `constraint-extractor → nodes/reference → …` is real,
// so this must never become a value import.
import type { PredicateConstraint } from '../analysis/constraint-extractor.js';

/**
 * Advertisement lifted from a `BestAccessPlanResult` onto a physical leaf node:
 * the monotonicOn property keyed by table-relative column index (translated to
 * attrId at lift time), plus access-path capability flags.
 */
export interface AccessPathAdvertisement {
	/** Monotonic ordering provided by the underlying storage. */
	monotonicOn?: { columnIndex: number; direction: 'asc' | 'desc'; strict: boolean };
	/** Whether the path supports O(log N) seek to the kth monotonic row. */
	supportsOrdinalSeek?: boolean;
	/** Whether the path can serve as the right side of a streaming asof join. */
	supportsAsofRight?: boolean;
}

/**
 * Lift an `AccessPathAdvertisement` onto `PhysicalProperties` overrides.
 * Translates `monotonicOn.columnIndex` to an attrId via the table reference's
 * attributes and emits a single-element `monotonicOn` array on the result.
 */
function liftAdvertisement(
	source: TableReferenceNode,
	advertisement: AccessPathAdvertisement | undefined,
): { monotonicOn?: readonly MonotonicOnInfo[]; accessCapabilities?: PhysicalProperties['accessCapabilities'] } {
	if (!advertisement) return {};
	const out: { monotonicOn?: readonly MonotonicOnInfo[]; accessCapabilities?: PhysicalProperties['accessCapabilities'] } = {};
	if (advertisement.monotonicOn) {
		const attrs = source.getAttributes();
		const colIdx = advertisement.monotonicOn.columnIndex;
		if (colIdx >= 0 && colIdx < attrs.length) {
			out.monotonicOn = [{
				attrId: attrs[colIdx].id,
				direction: advertisement.monotonicOn.direction,
				strict: advertisement.monotonicOn.strict,
			}];
		}
	}
	if (advertisement.supportsOrdinalSeek || advertisement.supportsAsofRight) {
		const caps: { ordinalSeek?: boolean; asofRight?: boolean } = {};
		if (advertisement.supportsOrdinalSeek) caps.ordinalSeek = true;
		if (advertisement.supportsAsofRight) caps.asofRight = true;
		out.accessCapabilities = caps;
	}
	return out;
}

/**
 * Base class for physical table access operations
 * Provides common functionality for sequential scan, index scan, and index seek
 */
export abstract class TableAccessNode extends PlanNode implements UnaryRelationalNode, TableAccessCapable {
	// Brand inherited by SeqScanNode / IndexScanNode / IndexSeekNode / EmptyResultNode.
	readonly isTableAccessCapable = true as const;
	private attributesCache: Cached<Attribute[]>;
	private outputType: Cached<RelationType>;

	constructor(
		scope: Scope,
		public readonly source: TableReferenceNode,
		public readonly filterInfo: FilterInfo,
		estimatedCostOverride?: number
	) {
		super(scope, estimatedCostOverride ?? filterInfo.indexInfoOutput.estimatedCost);

		this.attributesCache = new Cached(() => this.source.getAttributes());
		this.outputType = new Cached(() => this.source.getType());
	}

	getAttributes(): Attribute[] {
		return this.attributesCache.value;
	}

	getType(): RelationType {
		return this.outputType.value;
	}

	getChildren(): readonly PlanNode[] {
		return [this.source];
	}

	getRelations(): readonly [TableReferenceNode] {
		return [this.source];
	}

	// TableAccessCapable interface implementation
	get tableSchema() {
		return this.source.tableSchema;
	}

	abstract getAccessMethod(): 'sequential' | 'index-scan' | 'index-seek' | 'virtual';

	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		if (newChildren.length !== 1) {
			throw new Error(`${this.nodeType} expects 1 child, got ${newChildren.length}`);
		}

		const [newSource] = newChildren;

		// Type check - Physical access nodes specifically need a TableReferenceNode
		if (!(newSource instanceof TableReferenceNode)) {
			throw new Error(`${this.nodeType}: child must be a TableReferenceNode`);
		}

		// Return same instance if nothing changed
		if (newSource === this.source) {
			return this;
		}

		// Subclasses must override this with their specific constructor
		throw new Error(`${this.nodeType} must override withChildren method`);
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			table: this.source.tableSchema.name,
			schema: this.source.tableSchema.schemaName,
			accessMethod: this.getAccessMethod(),
			filterInfo: {
				usableIndex: this.filterInfo.indexInfoOutput.idxStr,
				matchedClauses: this.filterInfo.indexInfoOutput.aConstraintUsage?.length || 0,
				estimatedCost: this.filterInfo.indexInfoOutput.estimatedCost,
				estimatedRows: this.filterInfo.indexInfoOutput.estimatedRows
			}
		};
	}
}

/**
 * Sequential scan - reads entire table without using indexes
 * Used when no suitable index exists or for small tables
 */
export class SeqScanNode extends TableAccessNode {
	override readonly nodeType = PlanNodeType.SeqScan;

	constructor(
		scope: Scope,
		source: TableReferenceNode,
		filterInfo: FilterInfo,
		estimatedCostOverride?: number,
		public readonly rangeBoundedOn?: PhysicalProperties['rangeBoundedOn'],
		/** When true, suppress the lifted `monotonicOn` advertisement (defensive escalation). */
		public readonly suppressMonotonic: boolean = false,
	) {
		super(scope, source, filterInfo, estimatedCostOverride);
	}

	getAccessMethod(): 'sequential' {
		return 'sequential';
	}

	computePhysical(childrenPhysical: PhysicalProperties[]): Partial<PhysicalProperties> {
		const sourcePhysical = childrenPhysical[0];
		// Keys come through from the TableReferenceNode as FDs (`{key} → other-cols`).
		const out: Partial<PhysicalProperties> = {
			estimatedRows: this.source.estimatedRows,
			// Sequential scans don't provide any specific ordering
			ordering: undefined,
			fds: sourcePhysical?.fds,
			equivClasses: sourcePhysical?.equivClasses,
			constantBindings: sourcePhysical?.constantBindings,
			domainConstraints: sourcePhysical?.domainConstraints,
			// A full scan preserves the table reference's seeded INDs. (Even a
			// row-reducing seek would preserve a per-row inclusion claim — the
			// subset of surviving rows still satisfies it — so this is safe across
			// every access node here.)
			inds: sourcePhysical?.inds,
			// Backward update-lineage passes through the module-boundary access node
			// unchanged (columns and attribute ids are identical to the table
			// reference) — without this the seeded lineage would be lost the moment
			// the optimizer wraps the table in an access node.
			updateLineage: sourcePhysical?.updateLineage,
			attributeDefaults: sourcePhysical?.attributeDefaults,
		};
		if (this.rangeBoundedOn) out.rangeBoundedOn = this.rangeBoundedOn;
		return out;
	}

	override toString(): string {
		return `SEQ SCAN ${this.source.tableSchema.name}`;
	}

	override withChildren(newChildren: readonly PlanNode[]): PlanNode {
		if (newChildren.length !== 1) {
			throw new Error(`SeqScanNode expects 1 child, got ${newChildren.length}`);
		}

		const [newSource] = newChildren;

		// Type check - Physical access nodes specifically need a TableReferenceNode
		if (!(newSource instanceof TableReferenceNode)) {
			throw new Error('SeqScanNode: child must be a TableReferenceNode');
		}

		// Return same instance if nothing changed
		if (newSource === this.source) {
			return this;
		}

		// Create new instance
		return new SeqScanNode(
			this.scope,
			newSource,
			this.filterInfo,
			undefined,
			this.rangeBoundedOn,
			this.suppressMonotonic,
		);
	}
}

/**
 * Index scan - uses an index to read table data in order
 * Provides ordering and can handle range queries efficiently
 */
export class IndexScanNode extends TableAccessNode {
	override readonly nodeType = PlanNodeType.IndexScan;

	constructor(
		scope: Scope,
		source: TableReferenceNode,
		filterInfo: FilterInfo,
		public readonly indexName: string,
		public readonly providesOrdering?: { column: number; desc: boolean }[],
		estimatedCostOverride?: number,
		public readonly advertisement?: AccessPathAdvertisement,
		public readonly rangeBoundedOn?: PhysicalProperties['rangeBoundedOn'],
		/** When true, suppress the lifted `monotonicOn` advertisement (defensive escalation). */
		public readonly suppressMonotonic: boolean = false,
		/**
		 * True when a SortNode was dropped on the strength of this scan's
		 * `providesOrdering` (sort absorption in `rule-grow-retrieve`): the
		 * scan's emission order is the only thing producing the requested
		 * ORDER BY. Rewrites that change this leaf's emission order
		 * (`rule-key-set-seek`) must decline. False for a vacuously-advertised
		 * ordering nothing consumed.
		 */
		public readonly orderingLoadBearing: boolean = false,
	) {
		super(scope, source, filterInfo, estimatedCostOverride);
	}

	getAccessMethod(): 'index-scan' {
		return 'index-scan';
	}

	computePhysical(childrenPhysical: PhysicalProperties[]): Partial<PhysicalProperties> {
		const sourcePhysical = childrenPhysical[0];
		const lifted = liftAdvertisement(this.source, this.advertisement);
		if (this.suppressMonotonic) {
			delete lifted.monotonicOn;
			// Capabilities below all imply monotonicOn — drop them too.
			delete lifted.accessCapabilities;
		}
		const out: Partial<PhysicalProperties> = {
			estimatedRows: this.source.estimatedRows,
			// Index scans can provide ordering
			ordering: this.providesOrdering,
			fds: sourcePhysical?.fds,
			equivClasses: sourcePhysical?.equivClasses,
			constantBindings: sourcePhysical?.constantBindings,
			domainConstraints: sourcePhysical?.domainConstraints,
			// INDs survive the scan (a per-row inclusion claim holds on any subset).
			inds: sourcePhysical?.inds,
			// Pass the backward update-lineage through the access boundary unchanged.
			updateLineage: sourcePhysical?.updateLineage,
			attributeDefaults: sourcePhysical?.attributeDefaults,
			...lifted,
		};
		if (this.rangeBoundedOn) out.rangeBoundedOn = this.rangeBoundedOn;
		return out;
	}

	override toString(): string {
		const orderDesc = this.providesOrdering
			? ` ORDER BY ${this.providesOrdering.map(o => `${o.column}${o.desc ? ' DESC' : ''}`).join(', ')}`
			: '';
		return `INDEX SCAN ${this.source.tableSchema.name} USING ${this.indexName}${orderDesc}`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			...super.getLogicalAttributes(),
			indexName: this.indexName,
			providesOrdering: this.providesOrdering
		};
	}

	override withChildren(newChildren: readonly PlanNode[]): PlanNode {
		if (newChildren.length !== 1) {
			throw new Error(`IndexScanNode expects 1 child, got ${newChildren.length}`);
		}

		const [newSource] = newChildren;

		// Type check - Physical access nodes specifically need a TableReferenceNode
		if (!(newSource instanceof TableReferenceNode)) {
			throw new Error('IndexScanNode: child must be a TableReferenceNode');
		}

		// Return same instance if nothing changed
		if (newSource === this.source) {
			return this;
		}

		// Create new instance
		return new IndexScanNode(
			this.scope,
			newSource,
			this.filterInfo,
			this.indexName,
			this.providesOrdering,
			undefined,
			this.advertisement,
			this.rangeBoundedOn,
			this.suppressMonotonic,
			this.orderingLoadBearing,
		);
	}
}

/**
 * Empty result - produces zero rows (e.g., IS NULL on NOT NULL column)
 * Used when the optimizer detects an impossible predicate at planning time
 */
export class EmptyResultNode extends TableAccessNode {
	override readonly nodeType = PlanNodeType.EmptyResult;

	getAccessMethod(): 'sequential' {
		return 'sequential';
	}

	computePhysical(): Partial<PhysicalProperties> {
		return {
			estimatedRows: 0,
			ordering: undefined
		};
	}

	override toString(): string {
		return `EMPTY RESULT ${this.source.tableSchema.name}`;
	}

	override withChildren(newChildren: readonly PlanNode[]): PlanNode {
		if (newChildren.length !== 1) {
			throw new Error(`EmptyResultNode expects 1 child, got ${newChildren.length}`);
		}
		const [newSource] = newChildren;
		if (!(newSource instanceof TableReferenceNode)) {
			throw new Error('EmptyResultNode: child must be a TableReferenceNode');
		}
		if (newSource === this.source) return this;
		return new EmptyResultNode(this.scope, newSource, this.filterInfo);
	}
}

/**
 * Seek-key row-context invariant (OPT-061).
 *
 * A seek key for table T is evaluated *before* any row of T is read. It may
 * reference columns of *other* relations — that is an ordinary correlated /
 * index-nested-loop seek — but never a column of T itself. When one does, the
 * failure surfaces far from its cause, as "No row context found for column …"
 * from inside expression evaluation.
 *
 * Enforced in {@link IndexSeekNode}'s constructor rather than at any one
 * producer, so every path that mints or re-keys a seek — the access-path rule,
 * the monotonic-range clone, `withChildren` key substitution by a later rewrite
 * — is covered by construction.
 *
 * NOTE: this walks every seek key on every construction, clones included. Seek
 * keys are almost always single literal nodes, and the uncapped composite
 * cross-product arm of `rule-select-access-path` already costs far more to
 * *build* its keys than to walk them. If a plan ever shows seek construction
 * itself as hot, cache the result on the key node rather than skipping the check.
 */
export function assertSeekKeysRowIndependent(
	source: TableReferenceNode,
	seekKeys: readonly ScalarPlanNode[],
	indexName: string,
): void {
	const ownAttributes = new Map(source.getAttributes().map(a => [a.id, a.name]));
	for (const key of seekKeys) {
		for (const attrId of collectColumnRefAttributeIds(key)) {
			const name = ownAttributes.get(attrId);
			if (name !== undefined) {
				quereusError(
					`Internal planner error: seek key on ${source.tableSchema.name} via index "${indexName}" references that ` +
					`table's own column "${name}" (attribute ${attrId}). Seek keys are evaluated before any row of the table ` +
					`is read, so a key may reference other relations but never the table being sought. ` +
					`Offending key: ${key.toString()}`,
					StatusCode.INTERNAL,
				);
			}
		}
	}
}

/**
 * Index seek - point lookup or tight range using an index
 * Very efficient for equality constraints and small ranges
 */
export class IndexSeekNode extends TableAccessNode {
	override readonly nodeType = PlanNodeType.IndexSeek;

	constructor(
		scope: Scope,
		source: TableReferenceNode,
		filterInfo: FilterInfo,
		public readonly indexName: string,
		public readonly seekKeys: ScalarPlanNode[],
		public readonly isRange: boolean = false,
		public readonly providesOrdering?: { column: number; desc: boolean }[],
		estimatedCostOverride?: number,
		public readonly advertisement?: AccessPathAdvertisement,
		public readonly rangeBoundedOn?: PhysicalProperties['rangeBoundedOn'],
		/** When true, suppress the lifted `monotonicOn` advertisement (defensive escalation). */
		public readonly suppressMonotonic: boolean = false,
		/**
		 * True when a SortNode was dropped on the strength of this seek's
		 * `providesOrdering` (sort absorption in `rule-grow-retrieve`): the seek's
		 * emission order is the only thing producing the requested ORDER BY.
		 * Rewrites that change this leaf's emission order must decline. False for a
		 * vacuously-advertised ordering nothing consumed.
		 */
		public readonly orderingLoadBearing: boolean = false,
		/**
		 * The planner-level constraints this seek's keys were built from — the exact
		 * `PredicateConstraint` objects `rule-select-access-path` consumed, each carrying
		 * its original `sourceExpression` (and therefore its effective comparison
		 * collation, which `filterInfo.constraints` cannot express).
		 *
		 * This node's `FilterInfo` is the ONLY place these predicates are enforced: they
		 * were dropped from the tree on the module's promise (`handledFilters`). A rewrite
		 * that replaces this node's `FilterInfo` must re-apply them (as a `Filter`) or
		 * re-offer them to the module; a rewrite that cannot must decline.
		 *
		 * Caveats for a consumer that re-applies them:
		 * - Under a `COARSER_SAFE` collation cover the seek is already wrapped in a
		 *   residual `Filter` carrying the same predicate, so re-applying yields a
		 *   doubly-applied predicate — correct, but one extra evaluation.
		 * - `rules/join/index-nested-loop.ts` builds seeks from *synthesized* correlated
		 *   equalities (`innerCol = outerCol`) whose `sourceExpression` references an
		 *   attribute from the OUTER side of the join. Those are recorded faithfully, but
		 *   they are not re-appliable in an arbitrary position — a consumer must gate on
		 *   the position it intends to re-apply at.
		 *
		 * Undefined ⇒ this node was built by a path that did not thread the consumed set
		 * (never true for `selectPhysicalNode`'s output). An empty array is impossible: a
		 * seek exists only because at least one constraint was consumed.
		 *
		 * NOTE: deliberately NOT exposed via `getChildren` (OPT-009). No emitter reads these
		 * expressions — `runtime/emit/scan.ts` emits `seekKeys` only — so they are inert and
		 * merely hold pre-rewrite subtrees after a seek rebuild. The consumers above re-apply
		 * them into fresh rule output the pass then descends into. Expose them if an emitter
		 * ever reads them.
		 */
		public readonly pushedConstraints?: readonly PredicateConstraint[],
	) {
		super(scope, source, filterInfo, estimatedCostOverride);
		assertSeekKeysRowIndependent(source, seekKeys, indexName);
	}

	getAccessMethod(): 'index-seek' {
		return 'index-seek';
	}

	/**
	 * Clone recording what this seek's `FilterInfo` is enforcing (see
	 * {@link pushedConstraints}) and whether its emission order is load-bearing.
	 * Exists so the single stamping site in `rule-select-access-path` need not
	 * re-list every constructor argument.
	 */
	withProvenance(
		pushedConstraints: readonly PredicateConstraint[],
		orderingLoadBearing: boolean,
	): IndexSeekNode {
		return new IndexSeekNode(
			this.scope,
			this.source,
			this.filterInfo,
			this.indexName,
			this.seekKeys,
			this.isRange,
			this.providesOrdering,
			// No cost override: the base falls back to `filterInfo.indexInfoOutput.
			// estimatedCost`, which is the very `accessPlan.cost` every seek arm passes
			// as its override — so the clone re-derives the same self-cost. Same
			// reasoning as `withChildren` below.
			undefined,
			this.advertisement,
			this.rangeBoundedOn,
			this.suppressMonotonic,
			orderingLoadBearing,
			pushedConstraints,
		);
	}

	computePhysical(childrenPhysical: PhysicalProperties[]): Partial<PhysicalProperties> {
		const sourcePhysical = childrenPhysical[0];
		const lifted = liftAdvertisement(this.source, this.advertisement);
		if (this.suppressMonotonic) {
			delete lifted.monotonicOn;
			// Capabilities below all imply monotonicOn — drop them too.
			delete lifted.accessCapabilities;
		}
		const base = {
			ordering: this.providesOrdering,
			// The module's own row estimate for the access plan it chose, threaded here
			// by `rule-select-access-path.selectPhysicalNode`. It is the only number that
			// tracks what this particular seek matches; the constant that used to sit
			// here made every non-PK seek advertise the same cardinality whatever it
			// returned, and every cost decision above the seek reads this.
			//
			// NOTE: "the module supplied no estimate" is not distinguishable at this
			// point, by design. The rule builds this field as `accessPlan.rows || 1000`,
			// so a missing — or zero — `rows` has already collapsed to 1000 before the
			// node sees it. That `|| 1000` IS the no-answer fallback. Both shipped
			// modules always set `rows`, so only a third-party module can reach it.
			// Spelling "unknown" apart from "zero" is owned by backlog
			// `bug-row-estimate-conflates-unknown-and-zero`; do not invent a second
			// convention here.
			estimatedRows: Number(this.filterInfo.indexInfoOutput.estimatedRows),
			fds: sourcePhysical?.fds,
			equivClasses: sourcePhysical?.equivClasses,
			constantBindings: sourcePhysical?.constantBindings,
			domainConstraints: sourcePhysical?.domainConstraints,
			// A row-reducing seek still preserves the per-row inclusion claim.
			inds: sourcePhysical?.inds,
			// Pass the backward update-lineage through the access boundary unchanged.
			updateLineage: sourcePhysical?.updateLineage,
			attributeDefaults: sourcePhysical?.attributeDefaults,
			...lifted,
		} as Partial<PhysicalProperties>;
		if (this.rangeBoundedOn) base.rangeBoundedOn = this.rangeBoundedOn;
		if (!this.isRange && this.indexName === 'primary') {
			const pk = this.source.tableSchema.primaryKeyDefinition ?? [];
			// The singleton claim needs the seek keys to pin every primary-key column
			// exactly ONCE. A multi-seek (`where id in (1, 2, 3)`) supplies one tuple per
			// IN member — three seek keys against a one-column key — so a `>=` test passed
			// for it and the node both reported one row and stamped `∅ → all columns`,
			// which asserts the relation holds at most one row. Nothing leans on that FD
			// today, but its consumers (uniqueness proofs, DISTINCT elision, sort elision)
			// are exactly the rewrites that would silently drop rows if one ever did.
			//
			// A composite-key multi-seek that happens to reduce to a single tuple is
			// declined here too (its `plan` is still `multiSeek`); that costs an
			// optimization in a rare shape rather than risking a false claim.
			// `estimatedRows` needs no override either way — the module's own estimate,
			// read above, already says 1 for a whole-PK point seek and 3 for the IN.
			const isMultiSeek = accessPathPlan(this.filterInfo.accessPath) === 'multiSeek';
			if (pk.length > 0 && this.seekKeys.length === pk.length && !isMultiSeek) {
				// Full PK equality seek — at most one row. Encode via the singleton
				// FD `∅ → all_cols`.
				const colCount = this.source.getType().columns.length;
				const fds = addSingletonFd(base.fds ?? [], colCount);
				return { ...base, estimatedRows: 1, fds } as Partial<PhysicalProperties>;
			}
		}
		return base;
	}

	override toString(): string {
		const seekDesc = this.isRange ? 'RANGE' : 'SEEK';
		const orderDesc = this.providesOrdering
			? ` ORDER BY ${this.providesOrdering.map(o => `${o.column}${o.desc ? ' DESC' : ''}`).join(', ')}`
			: '';
		return `INDEX ${seekDesc} ${this.source.tableSchema.name} USING ${this.indexName}${orderDesc}`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			...super.getLogicalAttributes(),
			indexName: this.indexName,
			seekKeys: this.seekKeys.map(key => key.toString()),
			isRange: this.isRange,
			providesOrdering: this.providesOrdering
		};
	}

	getSeekKeys(): readonly ScalarPlanNode[] {
		return this.seekKeys;
	}

	override getChildren(): readonly PlanNode[] {
		return [this.source, ...this.seekKeys];
	}

	override withChildren(newChildren: readonly PlanNode[]): PlanNode {
		const expectedLength = 1 + this.seekKeys.length;
		if (newChildren.length !== expectedLength) {
			throw new Error(`IndexSeekNode expects ${expectedLength} children, got ${newChildren.length}`);
		}

		const [newSource, ...newSeekKeys] = newChildren;

		// Type check - Physical access nodes specifically need a TableReferenceNode
		if (!(newSource instanceof TableReferenceNode)) {
			throw new Error('IndexSeekNode: first child must be a TableReferenceNode');
		}

		// Type check seek keys
		for (const seekKey of newSeekKeys) {
			if (!('expression' in seekKey)) {
				throw new Error('IndexSeekNode: seek keys must be ScalarPlanNodes');
			}
		}

		// Check if anything changed
		const sourceChanged = newSource !== this.source;
		const seekKeysChanged = newSeekKeys.some((key, i) => key !== this.seekKeys[i]);

		if (!sourceChanged && !seekKeysChanged) {
			return this;
		}

		// Create new instance
		return new IndexSeekNode(
			this.scope,
			newSource,
			this.filterInfo,
			this.indexName,
			newSeekKeys as ScalarPlanNode[],
			this.isRange,
			this.providesOrdering,
			undefined,
			this.advertisement,
			this.rangeBoundedOn,
			this.suppressMonotonic,
			// Both must survive a rebuild: a lost `orderingLoadBearing` silently
			// re-enables an emission-order rewrite that should decline, and lost
			// `pushedConstraints` makes the seek look like it enforces nothing.
			this.orderingLoadBearing,
			this.pushedConstraints,
		);
	}
}

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
	) {
		super(scope, source, filterInfo, estimatedCostOverride);
	}

	getAccessMethod(): 'index-seek' {
		return 'index-seek';
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
			estimatedRows: Math.min(this.source.estimatedRows || 1000, 100),
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
			if (pk.length > 0 && this.seekKeys.length >= pk.length) {
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
		);
	}
}

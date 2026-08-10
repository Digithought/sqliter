import { ZeroAryRelationalBase, type Attribute, type TableDescriptor, type PhysicalProperties } from './plan-node.js';
import type { RelationType } from '../../common/datatype.js';
import { PlanNodeType } from './plan-node-type.js';
import type { Scope } from '../scopes/scope.js';
import { Cached } from '../../util/cached.js';

/**
 * Leaf relational node that scans the **shared-surrogate mutation envelope** —
 * the per-row augmented source a multi-source view INSERT decomposition
 * materializes once (the supplied view columns + the minted shared key) and
 * exposes to every sibling base insert.
 *
 * The materialized rows live in `rctx.tableContexts` keyed by {@link descriptor},
 * which the `ViewMutation` emitter populates *before* it runs the base ops (the
 * same working-table-in-context pattern recursive CTEs use). Because every base
 * op of one view insert shares the same `rctx`, they all read the SAME envelope
 * rows: the shared surrogate is generated exactly once per produced logical row
 * and threaded identically across the fan-out, so the branches cannot diverge
 * (docs/vu-mutation-context.md § Mutation Context).
 *
 * It is a leaf — its rows come from the context, not a child subtree — so
 * `withChildren` (inherited) returns `this`, preserving the {@link descriptor}
 * identity through optimization.
 */
export class EnvelopeScanNode extends ZeroAryRelationalBase {
	override readonly nodeType = PlanNodeType.EnvelopeScan;

	private attributesCache: Cached<Attribute[]>;

	constructor(
		scope: Scope,
		/** Identity shared with the owning `ViewMutationNode.envelope.descriptor`. */
		public readonly descriptor: TableDescriptor,
		/** Output attributes — positional with the materialized envelope rows. */
		public readonly attributes: Attribute[],
		public readonly relationType: RelationType,
	) {
		super(scope, 0.01); // Cheap: reads already-materialized rows from context.
		this.attributesCache = new Cached(() => this.attributes.map(attr => ({
			id: attr.id,
			name: attr.name,
			type: attr.type,
			sourceRelation: `envelope:${this.id}`,
		})));
	}

	getAttributes(): readonly Attribute[] {
		return this.attributesCache.value;
	}

	getType(): RelationType {
		return this.relationType;
	}

	computePhysical(): Partial<PhysicalProperties> {
		// The envelope is materialized once before fan-out; scanning it is a
		// read-only pass-through with no determinism guarantees of its own.
		return { estimatedRows: undefined };
	}

	override toString(): string {
		return `ENVELOPE SCAN (${this.attributes.length} col${this.attributes.length === 1 ? '' : 's'})`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return { columns: this.attributes.length };
	}
}

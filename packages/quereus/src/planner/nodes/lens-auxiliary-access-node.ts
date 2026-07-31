import { PlanNode, type RelationalPlanNode, type UnaryRelationalNode, type Attribute, type PhysicalProperties } from './plan-node.js';
import type { RelationType, ScalarType } from '../../common/datatype.js';
import { PlanNodeType } from './plan-node-type.js';
import type { Scope } from '../scopes/scope.js';
import type { AccessForm, MappingAdvertisement } from '../../vtab/mapping-advertisement.js';
import { physicalSourceRows } from '../util/row-estimates.js';

/**
 * One side of the logical-PK join-back (D4): the marker source's output
 * attribute paired with the auxiliary scan's aligned key attribute. The
 * `columnIndex` is the position of the attribute in its own relation's output
 * (for building a {@link ColumnReferenceNode}); `type` is its scalar type.
 */
export interface AuxJoinPair {
	/** Marker-source (logical view body) PK attribute. */
	readonly logicalPk: { readonly attrId: number; readonly columnIndex: number; readonly type: ScalarType };
	/** Auxiliary-scan key attribute aligned positionally to {@link logicalPk}. */
	readonly auxKey: { readonly attrId: number; readonly columnIndex: number; readonly type: ScalarType };
}

/**
 * An advertised access column the auxiliary serves: its logical column name, the
 * marker-source (logical) output attribute the predicate references, and the
 * auxiliary-scan attribute the predicate is rewritten to point at (D3 — the
 * auxiliary's own backing basis column, so the auxiliary's module sees the
 * predicate over its own column).
 */
export interface AuxAccessColumn {
	readonly logicalColumn: string;
	readonly logicalAttrId: number;
	readonly auxRef: { readonly attrId: number; readonly columnIndex: number; readonly type: ScalarType };
}

/**
 * A single routable auxiliary-access structure, fully resolved at build time
 * (where the {@link PlanningContext} is in hand) so the rewrite rule has every
 * attribute id / column index it needs without re-resolving the catalog.
 */
export interface RoutableAuxiliary {
	readonly advertisement: MappingAdvertisement;
	/**
	 * A scan over the auxiliary's single backing member relation (a
	 * `RetrieveNode` from `buildTableReference`, with its own fresh attribute
	 * ids). The rewrite rule pushes the column-rewritten predicate onto this
	 * scan and semi-joins it back to the logical body on the logical key.
	 */
	readonly auxScan: RelationalPlanNode;
	/** Logical-PK ↔ auxiliary-key join pairs, in logical-PK order (D4). */
	readonly joinPairs: readonly AuxJoinPair[];
	/** Every advertised access column locatable on both the logical body and the auxiliary scan. */
	readonly accessColumns: readonly AuxAccessColumn[];
	/** The advertised served entries (columns + forms) — the form-matcher's input. */
	readonly served: readonly { readonly columns: readonly string[]; readonly forms: readonly AccessForm[] }[];
}

/**
 * A unary pass-through marker wired around an inlined **lens** view body that
 * carries the table's routable auxiliary-access advertisements (nd-tree spatial,
 * vector knn, full-text, …) to the read-path-selection optimizer rule
 * (`rule-lens-auxiliary-access`). See `docs/lens.md` § "The module mapping
 * advertisement" and the design ticket `lens-access-shape-path-selection`.
 *
 * Modeled exactly on {@link AssertedKeysNode}: column shape and attribute IDs are
 * the source's (pass-through `getType` / `getAttributes`), `computePhysical`
 * passes every child physical property through unchanged, and the emitter
 * (`runtime/emit/lens-auxiliary-access.ts`) emits the source directly — so when
 * no predicate routes (the degrade case, D5) the node vanishes at runtime with
 * zero cost, exactly like `emitAlias` / `emitAssertedKeys`.
 *
 * The build site (`planner/building/lens-auxiliary-access.ts`, called from
 * `planner/building/select.ts`) only inlines the node when ≥1 auxiliary is
 * routable; the optimizer rule consumes it (replacing it with an auxiliary-seek
 * ⋈ logical-key semi-join) when the outer query's `WHERE` matches an advertised
 * form, and otherwise leaves it as a transparent pass-through.
 */
export class LensAuxiliaryAccessNode extends PlanNode implements UnaryRelationalNode {
	override readonly nodeType = PlanNodeType.LensAuxiliaryAccess;

	constructor(
		scope: Scope,
		public readonly source: RelationalPlanNode,
		/** The routable auxiliaries, resolved at build time. Non-empty by construction. */
		public readonly routables: readonly RoutableAuxiliary[],
	) {
		// Self-cost only: pure pass-through marker, the source flows in via
		// getChildren(). Using source.estimatedCost here would double-count the
		// source's self-cost.
		super(scope, 0.01);
	}

	getType(): RelationType {
		return this.source.getType();
	}

	getAttributes(): readonly Attribute[] {
		return this.source.getAttributes();
	}

	getChildren(): readonly [RelationalPlanNode] {
		return [this.source];
	}

	getRelations(): readonly [RelationalPlanNode] {
		return [this.source];
	}

	get estimatedRows(): number | undefined {
		return this.source.estimatedRows;
	}

	computePhysical(childrenPhysical: PhysicalProperties[]): Partial<PhysicalProperties> {
		const src = childrenPhysical[0];
		if (!src) return {};

		// Pure pass-through of every physical property (attribute IDs preserved),
		// exactly like AssertedKeysNode / AliasNode — the marker carries no rows.
		return {
			estimatedRows: physicalSourceRows(src, this.source),
			ordering: src.ordering,
			monotonicOn: src.monotonicOn,
			fds: src.fds,
			equivClasses: src.equivClasses,
			constantBindings: src.constantBindings,
			domainConstraints: src.domainConstraints,
			inds: src.inds,
			updateLineage: src.updateLineage,
			attributeDefaults: src.attributeDefaults,
		};
	}

	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		if (newChildren.length !== 1) {
			throw new Error(`LensAuxiliaryAccessNode expects 1 child, got ${newChildren.length}`);
		}

		const [newSource] = newChildren;
		if (newSource === this.source) {
			return this;
		}

		return new LensAuxiliaryAccessNode(
			this.scope,
			newSource as RelationalPlanNode,
			this.routables,
		);
	}

	override toString(): string {
		return `LENS AUX ACCESS (${this.routables.length})`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			auxiliaries: this.routables.map(r => ({
				id: r.advertisement.id,
				forms: [...new Set(r.served.flatMap(s => s.forms))],
				accessColumns: r.accessColumns.map(c => c.logicalColumn),
			})),
		};
	}
}

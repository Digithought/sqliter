import { isRelationalNode, PlanNode } from './plan-node.js';
import type { RelationalPlanNode, Attribute, BinaryRelationalNode, ScalarPlanNode, DomainConstraint } from './plan-node.js';
import type { RelationType } from '../../common/datatype.js';
import type { PhysicalProperties } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';
import type { Scope } from '../scopes/scope.js';
import { Cached } from '../../util/cached.js';
import { StatusCode } from '../../common/types.js';
import { quereusError } from '../../common/errors.js';
import type { JoinCapable, PredicateSourceCapable } from '../framework/characteristics.js';
import { normalizePredicate } from '../analysis/predicate-normalizer.js';
import { combineJoinKeys, analyzeJoinKeyCoverage } from '../util/key-utils.js';
import { BinaryOpNode } from './scalar.js';
import { ColumnReferenceNode } from './reference.js';
import { buildJoinAttributes, buildJoinRelationType, estimateJoinRows, joinPhysicalRows, propagateJoinMonotonicOn, propagateJoinFds, propagateJoinInds } from './join-utils.js';
import { physicalSourceRows } from '../util/row-estimates.js';
import { isValueDiscriminatingEquality } from '../analysis/comparison-collation.js';
import { deriveJoinUpdateLineage, type JoinExistenceSite } from '../analysis/update-lineage.js';
import { semanticOrderingsAgree } from '../../util/comparison.js';

export type JoinType = 'inner' | 'left' | 'right' | 'full' | 'cross' | 'semi' | 'anti';

/**
 * One `exists [<side>] as <name>` existence match-flag column the JoinNode
 * appends after both sides. The `attrId` is minted once at build time (so it is
 * stable across `withChildren` rebuilds, like the per-side attribute ids the
 * join preserves); `side` is the resolved non-preserved side whose match the
 * flag reifies.
 */
export interface ExistenceColumnSpec {
	readonly attrId: number;
	readonly name: string;
	readonly side: 'left' | 'right';
}

/**
 * Extract equi-join column index pairs from a join condition (AND-of-equalities).
 * Returns pairs of {left, right} column indices.
 *
 * An equi-pair is a VALUE-level pairing fact — its consumers (join key
 * coverage, FD/EC propagation, FK-alignment rules, join elimination, the
 * coverage prover) all assume matched rows are value-equal on the pair, so a
 * pair is only recognized when the comparison is value-discriminating
 * (`isValueDiscriminatingEquality`): for textual columns, every collation
 * either side contributes must be BINARY. A NOCASE comparison over a
 * BINARY-keyed column matches several distinct key values, so a pair minted
 * from it would falsely claim key coverage / preserved keys (ticket
 * `collation-blind-equality-fact-extraction`). Declared-non-BINARY equi-joins
 * therefore contribute NO pairs (a sound under-claim: keys combine as a cross
 * product, eliminations don't fire). Physical join algorithm selection is
 * unaffected — it uses its own extractor (`rules/join/equi-pair-extractor.ts`)
 * and resolves collations at emit time.
 *
 * The gate also requires the two sides to agree on semantic ordering
 * (`semanticOrderingsAgree`): a pair whose sides disagree (`timespan_col = text_col`)
 * matches rows that are NOT value-equal ('PT1H' against 'PT60M'), so no pair is minted
 * for it, mirroring the physical extractor (`rules/join/equi-pair-extractor.ts`).
 *
 * Operands must be **bare** `ColumnReferenceNode`s: a `COLLATE`-wrapped side
 * (`l.x = r.b collate nocase`) is structurally rejected. That exclusion is
 * load-bearing — do not "improve" this with a collate-unwrapping step without
 * re-deriving the gate above against the wrapper's collation.
 */
export function extractEquiPairsFromCondition(
	condition: ScalarPlanNode | undefined,
	leftAttrs: readonly Attribute[],
	rightAttrs: readonly Attribute[],
): Array<{ left: number; right: number }> {
	const pairs: Array<{ left: number; right: number }> = [];
	const cond = condition ? normalizePredicate(condition) : undefined;
	if (!cond) return pairs;

	const leftIdToIndex = new Map<number, number>();
	leftAttrs.forEach((a, i) => leftIdToIndex.set(a.id, i));
	const rightIdToIndex = new Map<number, number>();
	rightAttrs.forEach((a, i) => rightIdToIndex.set(a.id, i));

	const stack: ScalarPlanNode[] = [cond];
	while (stack.length) {
		const n = stack.pop()!;
		if (n instanceof BinaryOpNode) {
			const op = n.expression.operator;
			if (op === 'AND') {
				stack.push(n.left, n.right);
				continue;
			}
			if (op === '=') {
				if (n.left instanceof ColumnReferenceNode && n.right instanceof ColumnReferenceNode
					&& isValueDiscriminatingEquality(n.left, n.right)
					&& semanticOrderingsAgree(n.left.getType().logicalType, n.right.getType().logicalType)) {
					let lIdx = leftIdToIndex.get(n.left.attributeId);
					let rIdx = rightIdToIndex.get(n.right.attributeId);
					if (lIdx !== undefined && rIdx !== undefined) {
						pairs.push({ left: lIdx, right: rIdx });
					} else {
						lIdx = leftIdToIndex.get(n.right.attributeId);
						rIdx = rightIdToIndex.get(n.left.attributeId);
						if (lIdx !== undefined && rIdx !== undefined) {
							pairs.push({ left: lIdx, right: rIdx });
						}
					}
				}
			}
		}
	}
	return pairs;
}

/**
 * Represents a logical JOIN operation between two relations.
 * This is a logical node that will be converted to physical join algorithms during optimization.
 */
export class JoinNode extends PlanNode implements BinaryRelationalNode, JoinCapable, PredicateSourceCapable {
	readonly nodeType = PlanNodeType.Join;
	readonly isJoinCapable = true as const;
	readonly isPredicateSourceCapable = true as const;
	private attributesCache: Cached<Attribute[]>;

	constructor(
		scope: Scope,
		public readonly left: RelationalPlanNode,
		public readonly right: RelationalPlanNode,
		public readonly joinType: JoinType,
		public readonly condition?: ScalarPlanNode,
		/**
		 * The column names a `using (…)` join was written with. **Presentational
		 * only — `condition` is authoritative.** `buildUsingCondition`
		 * (planner/building/select.ts) desugars USING into the equivalent
		 * `l.c = r.c and …` and stores it in `condition`, so every consumer
		 * (physical selection, equi-pair extraction, the nested-loop emitter)
		 * reads the condition and none re-derives the comparison from these names.
		 * They survive so EXPLAIN can print how the join was actually written.
		 */
		public readonly usingColumns?: readonly string[],
		public readonly existence?: readonly ExistenceColumnSpec[],
	) {
		// Self-cost only: the children (left, right, condition) flow in via
		// getTotalCost(); self is the nested-loop join cost heuristic.
		const leftRows = left.estimatedRows ?? 100;
		const rightRows = right.estimatedRows ?? 100;
		const joinCost = leftRows * rightRows;
		super(scope, joinCost);

		this.attributesCache = new Cached(() => this.buildAttributes());
	}

	computePhysical(childrenPhysical: PhysicalProperties[]): Partial<PhysicalProperties> {
		const leftPhys = childrenPhysical[0];
		const rightPhys = childrenPhysical[1];
		const leftType = this.left.getType();
		const rightType = this.right.getType();
		const leftAttrs = this.left.getAttributes();
		const rightAttrs = this.right.getAttributes();

		// Extract equi-join index pairs from condition
		const pairs = extractEquiPairsFromCondition(
			this.condition, leftAttrs, rightAttrs
		);

		// PHYSICAL child cardinalities, not the logical getters: by the time this
		// runs both sides are usually physical access nodes (or wrappers over them),
		// which declare no `estimatedRows` getter — see `physicalSourceRows`.
		const leftRows = physicalSourceRows(leftPhys, this.left);
		const rightRows = physicalSourceRows(rightPhys, this.right);

		const result = analyzeJoinKeyCoverage(
			this.joinType, leftPhys, rightPhys, leftType, rightType,
			pairs, leftRows, rightRows,
			leftType.columns.length,
		);

		// Map column-index equi-pairs to attribute-id pairs for monotonicOn propagation.
		const attrIdPairs = pairs.map(p => ({
			leftAttrId: leftAttrs[p.left]?.id,
			rightAttrId: rightAttrs[p.right]?.id,
		})).filter(p => p.leftAttrId !== undefined && p.rightAttrId !== undefined) as
			Array<{ leftAttrId: number; rightAttrId: number }>;

		const totalCols = this.getAttributes().length;
		const fdResult = propagateJoinFds(
			this.joinType, leftPhys, rightPhys, pairs,
			leftType.columns.length, totalCols, result.preservedKeys,
		);

		// Backward update-lineage: compose per-source lineage along the join FDs
		// the forward pass computed (output attribute ids are preserved per side,
		// so the maps merge directly). Outer joins wrap the non-preserved side's
		// sites `null-extended` under the join predicate — annotation only; write
		// materialization is a later phase. Each existence flag registers an
		// `existence` site (read-only here) under the same join predicate.
		const { updateLineage, attributeDefaults } = deriveJoinUpdateLineage(
			this.joinType,
			leftPhys?.updateLineage, rightPhys?.updateLineage,
			leftPhys?.attributeDefaults, rightPhys?.attributeDefaults,
			this.condition?.expression,
			this.existenceSites(),
		);

		return {
			estimatedRows: joinPhysicalRows(this.joinType, result.estimatedRows, leftRows, rightRows),
			monotonicOn: propagateJoinMonotonicOn(this.joinType, leftPhys, rightPhys, attrIdPairs),
			// `fdResult.fds` already covers `key → flag` for each preserved key: the
			// forward walk's `withKeyFds` builds `key → all_other_cols` over the FULL
			// output column count (which includes the appended flags), so a flag is a
			// dependent of every preserved key and never a determinant — Invariant 1.
			fds: fdResult.fds,
			equivClasses: fdResult.equivClasses,
			constantBindings: fdResult.constantBindings,
			// Each flag carries a `{true,false}` enum domain (the clean-boolean point).
			domainConstraints: this.withFlagDomains(fdResult.domainConstraints),
			inds: propagateJoinInds(this.joinType, leftPhys, rightPhys, leftType.columns.length),
			updateLineage,
			attributeDefaults,
		};
	}

	/** Output column index of the i-th existence flag (appended after both sides). */
	private flagColumnIndex(i: number): number {
		return this.left.getType().columns.length + this.right.getType().columns.length + i;
	}

	/** Existence sites for the backward lineage walk (empty when no flags). */
	private existenceSites(): ReadonlyArray<JoinExistenceSite> | undefined {
		if (!this.existence || this.existence.length === 0) return undefined;
		return this.existence.map(spec => ({
			attrId: spec.attrId,
			side: spec.side,
			componentTable: Number(spec.side === 'left' ? this.left.id : this.right.id),
		}));
	}

	/** Append a `{true,false}` enum domain constraint per existence flag. */
	private withFlagDomains(
		domains: ReadonlyArray<DomainConstraint> | undefined,
	): ReadonlyArray<DomainConstraint> | undefined {
		if (!this.existence || this.existence.length === 0) return domains;
		const out = [...(domains ?? [])];
		this.existence.forEach((_spec, i) => {
			out.push({ kind: 'enum', column: this.flagColumnIndex(i), values: [true, false] });
		});
		return out;
	}

	/** True when this join exposes one or more `exists … as` match flags. */
	get hasExistenceColumns(): boolean {
		return !!this.existence && this.existence.length > 0;
	}

	private buildAttributes(): Attribute[] {
		return buildJoinAttributes(this.left.getAttributes(), this.right.getAttributes(), this.joinType, undefined, this.existence);
	}

	getAttributes(): Attribute[] {
		return this.attributesCache.value;
	}

	getType(): RelationType {
		const leftType = this.left.getType();
		const rightType = this.right.getType();
		// Equi-pairs are needed for LEFT/RIGHT outer key propagation (preserved-side
		// keys only survive when the other side's key is covered by the pairs).
		const pairs = extractEquiPairsFromCondition(
			this.condition, this.left.getAttributes(), this.right.getAttributes(),
		);
		const keys = combineJoinKeys(leftType.keys, rightType.keys, this.joinType, leftType.columns.length, pairs);
		return buildJoinRelationType(leftType, rightType, this.joinType, keys, this.existence);
	}

	getChildren(): readonly PlanNode[] {
		return this.condition ? [this.left, this.right, this.condition] : [this.left, this.right];
	}

	getRelations(): readonly [RelationalPlanNode, RelationalPlanNode] {
		return [this.left, this.right];
	}

	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		const expectedLength = this.condition ? 3 : 2;
		if (newChildren.length !== expectedLength) {
			quereusError(`JoinNode expects ${expectedLength} children, got ${newChildren.length}`, StatusCode.INTERNAL);
		}

		const [newLeft, newRight, newCondition] = newChildren;

		// Type check
		if (!isRelationalNode(newLeft)) {
			quereusError('JoinNode: first child must be a RelationalPlanNode', StatusCode.INTERNAL);
		}
		if (!isRelationalNode(newRight)) {
			quereusError('JoinNode: second child must be a RelationalPlanNode', StatusCode.INTERNAL);
		}
		if (newCondition && !('expression' in newCondition)) {
			quereusError('JoinNode: third child must be a ScalarPlanNode', StatusCode.INTERNAL);
		}

		// Check if anything changed
		const leftChanged = newLeft !== this.left;
		const rightChanged = newRight !== this.right;
		const conditionChanged = newCondition !== this.condition;

		if (!leftChanged && !rightChanged && !conditionChanged) {
			return this;
		}

		// Create new instance - JoinNode creates new attributes by combining left and
		// right. The existence specs carry pre-minted stable attribute ids, so they
		// are threaded verbatim (the appended flag columns survive the rebuild).
		// `usingColumns` is dropped when the condition is rewritten: it only labels the
		// predicate the desugar produced, so keeping it over a different condition would
		// make `toString` print `USING(...)` for a predicate that is no longer that.
		return new JoinNode(
			this.scope,
			newLeft as RelationalPlanNode,
			newRight as RelationalPlanNode,
			this.joinType,
			newCondition as ScalarPlanNode | undefined,
			conditionChanged ? undefined : this.usingColumns,
			this.existence,
		);
	}

	get estimatedRows(): number | undefined {
		return estimateJoinRows(this.left.estimatedRows, this.right.estimatedRows, this.joinType);
	}

	override toString(): string {
		const joinTypeDisplay = this.joinType.toUpperCase();
		// USING first: a USING join always carries a desugared condition too (see the
		// `usingColumns` field), and the USING spelling is the faithful one for EXPLAIN.
		if (this.usingColumns) {
			return `${joinTypeDisplay} JOIN USING(${this.usingColumns.join(', ')})`;
		} else if (this.condition) {
			return `${joinTypeDisplay} JOIN ON condition`;
		} else {
			return `${joinTypeDisplay} JOIN`;
		}
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			joinType: this.joinType,
			hasCondition: !!this.condition,
			usingColumns: this.usingColumns,
			existence: this.existence?.map(e => `exists ${e.side} as ${e.name}`),
			leftRows: this.left.estimatedRows,
			rightRows: this.right.estimatedRows
		};
	}

	public getJoinType(): JoinType {
		return this.joinType;
	}

	public getJoinCondition(): ScalarPlanNode | undefined {
		return this.condition;
	}

	public getLeftSource(): RelationalPlanNode {
		return this.left;
	}

	public getRightSource(): RelationalPlanNode {
		return this.right;
	}

	public getUsingColumns(): readonly string[] | undefined {
		return this.usingColumns;
	}

	// PredicateSourceCapable: Expose ON condition (if present) as a predicate source
	getPredicates(): readonly ScalarPlanNode[] {
		return this.condition ? [normalizePredicate(this.condition)] : [];
	}
}

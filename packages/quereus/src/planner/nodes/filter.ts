import { PlanNodeType } from './plan-node-type.js';
import { PlanNode, type RelationalPlanNode, type ScalarPlanNode, type UnaryRelationalNode, type Attribute, isRelationalNode, isScalarNode, type PhysicalProperties, type FunctionalDependency, type ConstantBinding } from './plan-node.js';
import type { RelationType } from '../../common/datatype.js';
import type { Scope } from '../scopes/scope.js';
import { formatExpression } from '../../util/plan-formatter.js';
import { quereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import type { PredicateCapable, PredicateSourceCapable } from '../framework/characteristics.js';
import { createTableInfoFromNode, extractConstraints } from '../analysis/constraint-extractor.js';
import { normalizePredicate } from '../analysis/predicate-normalizer.js';
import { addFd, addSingletonFd, closeConstantBindingsOverEcs, extractEqualityFds, mergeConstantBindings, mergeEquivClasses, predicateImpliesGuard, stripGuard } from '../util/fd-utils.js';
import { deriveFilterAttributeDefaults } from '../analysis/update-lineage.js';
import { filterCost } from '../cost/index.js';

/**
 * Last-resort selectivity used by {@link FilterNode.estimatedRows} when no
 * stats-derived estimate has been stamped (see `rule-filter-selectivity`).
 */
export const DEFAULT_FILTER_SELECTIVITY = 0.5;

/**
 * Represents a filter operation (WHERE clause).
 * It takes an input relation and a predicate expression,
 * and outputs rows for which the predicate is true.
 */
export class FilterNode extends PlanNode implements UnaryRelationalNode, PredicateCapable, PredicateSourceCapable {
	override readonly nodeType = PlanNodeType.Filter;
	readonly isPredicateCapable = true as const;
	readonly isPredicateSourceCapable = true as const;

	constructor(
		scope: Scope,
		public readonly source: RelationalPlanNode,
		public readonly predicate: ScalarPlanNode,
		estimatedCostOverride?: number,
		// Stats-derived selectivity in [0,1], stamped by `rule-filter-selectivity`
		// during the Physical pass. Undefined until that rule runs (or when the
		// source table can't be identified / the provider declines) — see
		// `estimatedRows`, which falls back to DEFAULT_FILTER_SELECTIVITY.
		public readonly selectivity?: number,
	) {
		// Self-cost only: both children — source AND predicate (getChildren() is
		// [source, predicate]) — flow in via getTotalCost(). Self is the per-row
		// predicate-evaluation overhead; the predicate's own subtree cost is added
		// once as a child, so it must NOT be folded here.
		// NOTE: under self-cost-only the predicate's subtree cost is added once, not
		// multiplied by row count (the pre-fix formula did rows * predicate.getTotalCost()).
		// So an expensive predicate over a large input is now under-weighted; if predicate
		// complexity ever needs to drive plan choice, fold a per-row predicate factor into
		// filterCost() rather than re-summing the child here.
		super(scope, estimatedCostOverride ?? filterCost(source.estimatedRows ?? 1));
	}

	getType(): RelationType {
		// Filter preserves the type of the source relation
		return this.source.getType();
	}

	getAttributes(): readonly Attribute[] {
		// Filter preserves the same attributes as its source
		return this.source.getAttributes();
	}

	getChildren(): readonly [RelationalPlanNode, ScalarPlanNode] {
		return [this.source, this.predicate];
	}

	getRelations(): readonly [RelationalPlanNode] {
		return [this.source];
	}

	get estimatedRows(): number | undefined {
		// Selectivity is stamped by `rule-filter-selectivity` (Physical pass), which
		// consults the stats provider (histogram / 1-over-ndv / null-fraction, with a
		// NaiveStatsProvider per-nodeType fallback).
		// NOTE: DEFAULT_FILTER_SELECTIVITY (0.5) is the LAST-RESORT default, used only
		// before that rule runs (e.g. Structural-pass cost comparisons) or when the
		// source table can't be identified / the provider declines — it is NOT the
		// real heuristic path, which lives in the stats provider.
		const sourceRows = this.source.estimatedRows;
		if (sourceRows === undefined) return undefined;
		const sel = this.selectivity ?? DEFAULT_FILTER_SELECTIVITY;
		// selectivity 0 (provider says nothing matches) floors to 1, matching the
		// empty-source path's min-1 convention — never negative / NaN.
		return sourceRows > 0 ? Math.max(1, Math.floor(sourceRows * sel)) : 0;
	}

	computePhysical(childrenPhysical: PhysicalProperties[]): Partial<PhysicalProperties> {
		const sourcePhysical = childrenPhysical[0];
		const srcRows = sourcePhysical?.estimatedRows;
		const est = this.estimatedRows;
		// Apply the stamped selectivity to the PHYSICAL source cardinality. The
		// logical `estimatedRows` getter multiplies `this.source.estimatedRows`, but a
		// physical access-node source (IndexScan/IndexSeek) exposes no logical row
		// count, so the getter yields undefined and the selectivity stamped by
		// `rule-filter-selectivity` would be lost after the Retrieve→access-node
		// conversion. computePhysical holds the real physical source cardinality, so
		// apply selectivity here when stamped (matching the getter's min-1 / 0-empty
		// floor); fall back to the logical estimate (min against source) when unstamped.
		let rows: number | undefined;
		if (typeof srcRows === 'number' && this.selectivity !== undefined) {
			rows = srcRows > 0 ? Math.max(1, Math.floor(srcRows * this.selectivity)) : 0;
		} else if (typeof srcRows === 'number' && typeof est === 'number') {
			rows = Math.min(srcRows, est);
		} else {
			rows = srcRows ?? est;
		}

		const sourceAttrs = this.source.getAttributes();
		const attrIdToIndex = this.source.getAttributeIndex();
		const { fds: predFds, equivPairs, constantBindings: predBindings } = extractEqualityFds(this.predicate, attrIdToIndex);

		// Merge ECs and bindings up front so guard activation can consult the
		// post-predicate view of equivalence classes and constant bindings.
		let equivClasses = sourcePhysical?.equivClasses ?? [];
		if (equivPairs.length > 0) {
			equivClasses = mergeEquivClasses(equivClasses, equivPairs.map(p => [p[0], p[1]]));
		}
		const mergedBindings = mergeConstantBindings(sourcePhysical?.constantBindings ?? [], predBindings);
		let constantBindings = closeConstantBindingsOverEcs(mergedBindings, equivClasses);

		// Activate any guarded FDs on the source whose guard is entailed by the
		// predicate (combined with the merged ECs/bindings). Activation replaces
		// the guarded FD with its unconditional twin so downstream operators see
		// it as an ordinary FD.
		const isColumnNonNullable = (col: number): boolean => {
			const attr = sourceAttrs[col];
			return attr ? attr.type.nullable === false : false;
		};
		const isColumnNumeric = (col: number): boolean => {
			const attr = sourceAttrs[col];
			return attr?.type.logicalType?.isNumeric === true;
		};
		// The column's declared collation — what guard scopes are evaluated under
		// at index-maintenance time (table-ref attrs carry the schema collation;
		// projections pass types through unchanged).
		const declaredCollationOf = (col: number): string =>
			sourceAttrs[col]?.type.collationName ?? 'BINARY';
		const activation = activateGuardedFds(
			sourcePhysical?.fds ?? [],
			this.predicate,
			equivClasses,
			constantBindings,
			attrIdToIndex,
			isColumnNonNullable,
			isColumnNumeric,
			declaredCollationOf,
		);
		let fds: ReadonlyArray<FunctionalDependency> = activation.fds;
		// A value-equality body activated by the guard contributes its equality as an EC
		// unconditionally (sound regardless of key-ness, and not read by `keysOf`),
		// mirroring the table-reference gate. Re-close bindings over the enlarged EC set.
		if (activation.activatedEquivPairs.length > 0) {
			equivClasses = mergeEquivClasses(equivClasses, activation.activatedEquivPairs);
			constantBindings = closeConstantBindingsOverEcs(constantBindings, equivClasses);
		}

		// Predicate-derived FDs fold unconditionally. They are all
		// `kind: 'determination'` (`extractEqualityFds`: constant pins `∅ → col`
		// and `col1 = col2` mirrors), and the kind-aware readers
		// (`isUniqueDeterminant`) never read a determination as a uniqueness
		// claim — the endpoint gate that used to live here is subsumed (ticket
		// fd-determination-reader-side-rule, replacing the
		// fd-derived-key-bag-overclaim producer gate).
		for (const fd of predFds) {
			fds = addFd(fds, fd);
		}

		// Attempt logical covered-key detection: if equality conjuncts cover a
		// unique key on the source table, the Filter emits at-most-one row. Encode
		// that as the singleton FD `∅ → all_cols`.
		// NOTE: this re-runs on every re-mint even when `this.predicate` is the
		// same object (the common `withChildren` source-only-remint case). A
		// predicate-keyed cache was considered (ticket 3-planner-plan-time-mechanical)
		// but `tableInfo.relationKey` embeds the source's per-instance node id, so it
		// never agrees across two distinct source instances — and the covered-key
		// result also depends on `tableInfo.fds`/`equivClasses`, which are
		// physical-strategy-dependent and not cheaply hashable, so a signature broad
		// enough to be sound would need to fingerprint those too. If this shows up
		// hot in profiling, revisit with a cache keyed on `this.predicate` (WeakMap)
		// plus a signature over `tableInfo.uniqueKeys`/`fds`/`equivClasses`.
		const tableInfo = createTableInfoFromNode(this.source);
		if (tableInfo.uniqueKeys && tableInfo.uniqueKeys.length > 0) {
			const result = extractConstraints(this.predicate, [tableInfo]);
			const covered = result.coveredKeysByTable?.get(tableInfo.relationKey) || [];
			if (covered.length > 0) {
				fds = addSingletonFd(fds, sourceAttrs.length);
				rows = 1;
			}
		}

		return {
			estimatedRows: rows,
			ordering: sourcePhysical?.ordering,
			// Filter preserves monotonicOn — a predicate doesn't reorder rows.
			monotonicOn: sourcePhysical?.monotonicOn,
			fds: fds.length > 0 ? fds : undefined,
			equivClasses: equivClasses.length > 0 ? equivClasses : undefined,
			constantBindings: constantBindings.length > 0 ? constantBindings : undefined,
			// Domains pass through unchanged. Intersecting with the filter predicate
			// is deferred to the predicate-contradiction-detection ticket.
			domainConstraints: sourcePhysical?.domainConstraints,
			// Row removal preserves a per-row inclusion claim, so INDs pass through.
			inds: sourcePhysical?.inds,
			// Backward update-lineage: filter preserves columns, so `updateLineage`
			// passes through; insert defaults gain a `constant-fd` entry for every
			// column the forward pass pinned constant (read off `constantBindings`,
			// NOT a re-scan of the predicate AST).
			updateLineage: sourcePhysical?.updateLineage,
			attributeDefaults: deriveFilterAttributeDefaults(
				sourcePhysical?.attributeDefaults,
				sourceAttrs,
				constantBindings,
			),
		};
	}

	override toString(): string {
		return `WHERE ${formatExpression(this.predicate)}`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			predicate: formatExpression(this.predicate)
		};
	}

	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		if (newChildren.length !== 2) {
			quereusError(`FilterNode expects 2 children, got ${newChildren.length}`, StatusCode.INTERNAL);
		}

		const [newSource, newPredicate] = newChildren;

		// Type check
		if (!isRelationalNode(newSource)) {
			quereusError('FilterNode: first child must be a RelationalPlanNode', StatusCode.INTERNAL);
		}
		if (!isScalarNode(newPredicate)) {
			quereusError('FilterNode: second child must be a ScalarPlanNode', StatusCode.INTERNAL);
		}

		// Return same instance if nothing changed (this fast-path also preserves
		// `selectivity` for free — the common source-and-predicate-unchanged case).
		if (newSource === this.source && newPredicate === this.predicate) {
			return this;
		}

		// The stamped selectivity is predicate-specific: carry it through ONLY when
		// the predicate is unchanged; drop it (undefined → recompute default until
		// re-stamped) when the predicate changes.
		//
		// Dropping it here is routine, not exceptional: several passes re-mint stamped
		// Filters whenever they rewrite something inside a predicate
		// (`scalar-subquery-cache` wrapping a scalar subquery's inner in
		// PostOptimization; the materialization advisory marking or wrapping a
		// relational node inside a predicate's subquery). What makes the drop safe
		// regardless of WHICH pass re-mints is the `filter-selectivity-final`
		// registration of `rule-filter-selectivity` in `PassId.FinalEstimates` (order
		// 37) — it sits behind every plan-mutating pass and re-derives a number against
		// the NEW predicate rather than carrying the old one forward. (The
		// `filter-selectivity-restamp` PostOptimization registration is not redundant
		// with it: cost readers later in that same pass need the stamp back before
		// emission.)
		//
		// NOTE (tripwire): a carried selectivity was computed against THIS source's
		// table. If a pass ever re-sources a stamped Filter (same predicate object,
		// different source), the carried estimate goes slightly stale and nothing
		// re-derives it — the re-stamp rule declines on an already-stamped Filter. If
		// that shape appears, also drop selectivity when `newSource !== this.source`.
		const preservedSelectivity = newPredicate === this.predicate ? this.selectivity : undefined;

		// Create new instance preserving attributes (filter preserves source attributes)
		return new FilterNode(
			this.scope,
			newSource as RelationalPlanNode,
			newPredicate as ScalarPlanNode,
			undefined,
			preservedSelectivity,
		);
	}

	// PredicateCapable interface implementation
	getPredicate(): ScalarPlanNode | null {
		return this.predicate;
	}

	withPredicate(newPredicate: ScalarPlanNode | null): PlanNode {
		if (newPredicate === null) {
			// If predicate is null, return the source directly (no filter needed)
			return this.source;
		}

		if (newPredicate === this.predicate) {
			return this;
		}

		// Predicate changed → do NOT carry `selectivity` (it was predicate-specific);
		// leave it undefined so rule-filter-selectivity re-derives against the new one.
		return new FilterNode(this.scope, this.source, newPredicate);
	}

	// PredicateSourceCapable interface implementation:
	// expose a normalized form so plan-walk callers (constraint extractor, etc.)
	// see canonical predicates regardless of NOT-wrapping in the source AST.
	// Mirrors JoinNode.getPredicates().
	getPredicates(): readonly ScalarPlanNode[] {
		return [normalizePredicate(this.predicate)];
	}
}

/**
 * Walk inherited FDs and, for each one carrying a `guard`, ask
 * `predicateImpliesGuard` whether the surrounding predicate entails the guard.
 * Entailed guarded FDs are replaced with their unconditional twin (`stripGuard`,
 * kind-preserving). Unentailed guarded FDs pass through unchanged so a later
 * Filter / Join can still activate them once additional facts land.
 *
 * Activation is unconditional for every entailed FD — there is no endpoint
 * gate. Soundness lives on the reader side: a guarded determination activates
 * as a determination, which the kind-aware readers (`isUniqueDeterminant`)
 * never read as a uniqueness claim; a guarded 'unique' FD (partial UNIQUE
 * index) activates as 'unique', which is sound at the activating Filter (its
 * rows all satisfy the guard, and filtering only shrinks the row set —
 * fan-out hazards are handled by the join-side kind downgrade, not here).
 * (ticket fd-determination-reader-side-rule, replacing the
 * fd-guarded-activation / fd-oneway-guard-activation producer gates.)
 *
 * A genuine value-equality additionally surfaces its equality as an EC (returned
 * via `activatedEquivPairs`, lifted by the caller; `keysOf` never reads ECs, so
 * the EC is sound regardless of key-ness). The EC lift — and ONLY the EC lift —
 * keys off the `valueEquality` marker, NOT the FD shape, because a coincidental
 * mutual-determination mirror (two partial UNIQUE indexes on a 2-col table, or
 * `b=a+1` + `a=b-1` checks) is structurally identical to a value-equality pair
 * but does NOT hold `a = b`; lifting an EC there would be unsound. Losing the
 * marker (the `shiftFds`/`projectFds` join/projection path — though phase 1 made
 * it durable through both) would lose only the EC optimization — an under-claim —
 * never soundness.
 */
function activateGuardedFds(
	sourceFds: ReadonlyArray<FunctionalDependency>,
	predicate: ScalarPlanNode,
	ecs: ReadonlyArray<ReadonlyArray<number>>,
	bindings: ReadonlyArray<ConstantBinding>,
	attrIdToIndex: ReadonlyMap<number, number>,
	isColumnNonNullable: (col: number) => boolean,
	isColumnNumeric: (col: number) => boolean,
	declaredCollationOf: (col: number) => string,
): { fds: FunctionalDependency[]; activatedEquivPairs: Array<[number, number]> } {
	const out: FunctionalDependency[] = [];
	const activatedEquivPairs: Array<[number, number]> = [];
	for (const fd of sourceFds) {
		if (fd.guard === undefined) {
			out.push(fd);
			continue;
		}
		if (predicateImpliesGuard(predicate, fd.guard, ecs, bindings, attrIdToIndex, isColumnNonNullable, isColumnNumeric, declaredCollationOf)) {
			if (fd.valueEquality === true && fd.determinants.length === 1 && fd.dependents.length === 1) {
				activatedEquivPairs.push([fd.determinants[0], fd.dependents[0]]);
			}
			out.push(stripGuard(fd));
		} else {
			out.push(fd);
		}
	}
	return { fds: out, activatedEquivPairs };
}

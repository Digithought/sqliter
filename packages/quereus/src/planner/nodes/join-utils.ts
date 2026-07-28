import type { Attribute, ConstantBinding, DomainConstraint, FunctionalDependency, InclusionDependency, MonotonicOnInfo, PhysicalProperties } from './plan-node.js';
import type { JoinType, ExistenceColumnSpec } from './join-node.js';
import type { RelationType, ColRef, ColumnDef, ScalarType } from '../../common/datatype.js';
import { BOOLEAN_TYPE } from '../../types/builtin-types.js';
import {
	addEquivalence, addFd,
	closeConstantBindingsOverEcs,
	mergeConstantBindings,
	mergeDomainConstraints,
	mergeEquivClasses, mergeFds,
	mergeInds,
	shiftConstantBindings,
	shiftDomainConstraints,
	shiftEquivClasses, shiftFds,
	shiftInds,
	superkeyToFd,
} from '../util/fd-utils.js';

/**
 * An equi-join pair: left attribute = right attribute.
 * Attribute IDs are stable across plan transformations.
 *
 * Both flags are REQUIRED at every construction site — an implicit `true`
 * default would silently reproduce the over-claims they exist to prevent.
 */
export interface EquiJoinPair {
	leftAttrId: number;
	rightAttrId: number;

	/**
	 * True when both sides declare the SAME collation (`operandCollation`
	 * equality). Only merge join reads this: it requires both inputs physically
	 * ordered under the key's comparison collation, and
	 * `PhysicalProperties.ordering` is collation-blind (`{column, desc}` only) —
	 * a matched declared collation is what makes each input's advertised order
	 * equal the merge comparator's order. Hash/Bloom join does not care — its
	 * emitter resolves the pair collation symmetrically
	 * (`effectiveCollationOfTypes`) and normalizes both sides' keys under it.
	 */
	collationsMatch: boolean;

	/**
	 * True when rows this pair matches are genuinely value-equal
	 * (`isValueDiscriminatingEquality`). False for any possibly-text pair whose
	 * comparison collation is non-BINARY: such a comparison matches
	 * value-DIFFERENT rows ('Bob' = 'bob' under NOCASE), so the pair must not
	 * mint equivalence classes, determination FDs, key coverage, or
	 * monotonicity claims. It remains a perfectly good *join condition* — the
	 * runtime emitters key/compare under the resolved collation regardless.
	 */
	valueDiscriminating: boolean;
}

/**
 * Build the output attributes for a join node.
 *
 * If `preserveAttributeIds` is supplied (physical join nodes created from a
 * logical JoinNode) the preserved set is returned directly.  Otherwise the
 * attributes are computed from the left/right inputs and the join type.
 */
/**
 * The scalar type of an existence (`exists … as`) match flag: a clean
 * `{true,false}` boolean, genuinely NOT NULL (the null-extension test the column
 * replaces), and read-only (derived at the combinator).
 */
export const EXISTENCE_FLAG_TYPE: ScalarType = {
	typeClass: 'scalar',
	logicalType: BOOLEAN_TYPE,
	nullable: false,
	isReadOnly: true,
};

export function buildJoinAttributes(
	leftAttrs: readonly Attribute[],
	rightAttrs: readonly Attribute[],
	joinType: JoinType,
	preserveAttributeIds?: readonly Attribute[],
	existence?: readonly ExistenceColumnSpec[],
): Attribute[] {
	if (preserveAttributeIds) return preserveAttributeIds.slice() as Attribute[];
	if (joinType === 'semi' || joinType === 'anti') return leftAttrs.slice() as Attribute[];

	const attributes: Attribute[] = [];
	for (const attr of leftAttrs) {
		const isNullable = joinType === 'right' || joinType === 'full';
		attributes.push(isNullable ? { ...attr, type: { ...attr.type, nullable: true } } : attr);
	}
	for (const attr of rightAttrs) {
		const isNullable = joinType === 'left' || joinType === 'full';
		attributes.push(isNullable ? { ...attr, type: { ...attr.type, nullable: true } } : attr);
	}
	// Existence flags are appended AFTER both sides — boolean NOT NULL, never
	// marked nullable (the clean-boolean point), with their pre-minted stable ids.
	if (existence) {
		for (const spec of existence) {
			attributes.push({ id: spec.attrId, name: spec.name, type: EXISTENCE_FLAG_TYPE });
		}
	}
	return attributes;
}

/**
 * Build the `RelationType` for a join result.
 *
 * Semi/anti joins return the left type shape.  All other join types combine
 * columns from both sides with appropriate nullable marking.
 */
export function buildJoinRelationType(
	leftType: RelationType,
	rightType: RelationType,
	joinType: JoinType,
	keys?: ReadonlyArray<ReadonlyArray<ColRef>>,
	existence?: readonly ExistenceColumnSpec[],
): RelationType {
	if (joinType === 'semi' || joinType === 'anti') {
		return {
			typeClass: 'relation',
			columns: leftType.columns,
			isSet: leftType.isSet,
			isReadOnly: leftType.isReadOnly,
			keys: leftType.keys,
			rowConstraints: leftType.rowConstraints,
		};
	}

	const existenceColumns: ColumnDef[] = (existence ?? []).map(spec => ({
		name: spec.name,
		type: EXISTENCE_FLAG_TYPE,
	}));

	const combinedColumns = [
		...leftType.columns.map(col => {
			const isNullable = joinType === 'right' || joinType === 'full';
			return isNullable ? { ...col, type: { ...col.type, nullable: true } } : col;
		}),
		...rightType.columns.map(col => {
			const isNullable = joinType === 'left' || joinType === 'full';
			return isNullable ? { ...col, type: { ...col.type, nullable: true } } : col;
		}),
		// Existence flags appended after both sides; never part of any join key.
		...existenceColumns,
	];

	const isSet = (joinType === 'inner' || joinType === 'cross') &&
		leftType.isSet && rightType.isSet;

	return {
		typeClass: 'relation',
		columns: combinedColumns,
		isSet,
		isReadOnly: leftType.isReadOnly && rightType.isReadOnly,
		keys: (keys ?? []) as ColRef[][],
		rowConstraints: [...leftType.rowConstraints, ...rightType.rowConstraints],
	};
}

/**
 * Propagate `monotonicOn` through a join operator.
 *
 * Rules (see `1-monotonic-on-characteristic` ticket):
 * - cross / full-outer:                drop on both sides.
 * - semi / anti:                       preserve left's monotonicOn unchanged.
 * - inner / left / right:              for each equi-pair (l.X, r.X) where both
 *                                      sides are MonotonicOn on their respective X
 *                                      with matching direction, the non-null-extended
 *                                      side(s) propagate their monotonicOn(X) to the
 *                                      output (strictness = AND of the two inputs).
 *                                      Other monotonicOn entries (those not coupled
 *                                      by an equi-pair) are dropped.
 */
export function propagateJoinMonotonicOn(
	joinType: JoinType,
	leftPhys: PhysicalProperties | undefined,
	rightPhys: PhysicalProperties | undefined,
	equiPairs: ReadonlyArray<{ leftAttrId: number; rightAttrId: number }>,
): readonly MonotonicOnInfo[] | undefined {
	if (joinType === 'cross' || joinType === 'full') return undefined;

	const leftMon = leftPhys?.monotonicOn;
	if (joinType === 'semi' || joinType === 'anti') {
		return leftMon && leftMon.length > 0 ? leftMon : undefined;
	}

	const rightMon = rightPhys?.monotonicOn;
	if (!leftMon || !rightMon || leftMon.length === 0 || rightMon.length === 0) return undefined;
	if (equiPairs.length === 0) return undefined;

	const leftPreserved = joinType === 'inner' || joinType === 'left';
	const rightPreserved = joinType === 'inner' || joinType === 'right';

	const result: MonotonicOnInfo[] = [];
	for (const pair of equiPairs) {
		const l = leftMon.find(m => m.attrId === pair.leftAttrId);
		if (!l) continue;
		const r = rightMon.find(m => m.attrId === pair.rightAttrId && m.direction === l.direction);
		if (!r) continue;
		const strict = l.strict && r.strict;
		if (leftPreserved) {
			result.push({ attrId: pair.leftAttrId, direction: l.direction, strict });
		}
		if (rightPreserved) {
			result.push({ attrId: pair.rightAttrId, direction: l.direction, strict });
		}
	}
	return result.length > 0 ? result : undefined;
}

/**
 * Downgrade a fanned-out side's `'unique'` FDs to `'determination'`. A fanning
 * join duplicates that side's rows, destroying determinant row-uniqueness
 * while every value claim survives unchanged. Applies to guarded FDs too: a
 * guarded partial-unique FD crossing a fanning join is no longer row-unique
 * even within its guard's scope (the duplicated rows still satisfy the guard).
 * Preserves object identity for FDs that are already determinations.
 *
 * This downgrade fully replaces the former `dropSideKeyFds`: the value claims
 * survive as determinations (feeding ORDER BY pruning / GROUP BY
 * simplification downstream), and the kind-aware readers
 * (`isUniqueDeterminant`) never read them as uniqueness claims (ticket
 * fd-determination-reader-side-rule).
 */
function downgradeUniqueFds(
	fds: ReadonlyArray<FunctionalDependency>,
): ReadonlyArray<FunctionalDependency> {
	return fds.map(fd => (fd.kind === 'unique' ? { ...fd, kind: 'determination' as const } : fd));
}

/**
 * Propagate functional dependencies and equivalence classes through a join.
 *
 * Rules:
 * - inner / cross: union of left and right FDs (right's column indices shifted
 *   by leftColumnCount). For each equi-pair (L, R'), add bi-directional FDs
 *   `{L} → {R'}` and `{R'} → {L}` and merge `L ≡ R'` into the EC list.
 * - left outer: keep left's FDs/ECs on left's columns only. Right's FDs/ECs and
 *   equi-pair FDs/ECs are dropped — NULL-padded rows can violate them.
 * - right outer: mirror of left outer.
 * - full outer: drop both sides' FDs/ECs (conservative).
 * - semi / anti: left's FDs/ECs survive; no right contribution and no equi-pair
 *   FDs (right columns are not in the output). Left rows pass ≤1:1, so kinds
 *   are preserved verbatim.
 * - Fan-out kind downgrade (inner/cross/left/right): a side that is NOT
 *   preserved (no preserved key lies within it) is fanned out — its surviving
 *   FDs, guarded ones included, are downgraded `'unique'` → `'determination'`
 *   via `downgradeUniqueFds` so the kind invariant holds before any reader
 *   trusts it.
 */
export function propagateJoinFds(
	joinType: JoinType,
	leftPhys: PhysicalProperties | undefined,
	rightPhys: PhysicalProperties | undefined,
	equiPairs: ReadonlyArray<{ left: number; right: number }>,
	leftColumnCount: number,
	totalColumnCount: number,
	preservedKeys: ReadonlyArray<ReadonlyArray<number>>,
): {
	fds?: ReadonlyArray<FunctionalDependency>;
	equivClasses?: ReadonlyArray<ReadonlyArray<number>>;
	constantBindings?: ReadonlyArray<ConstantBinding>;
	domainConstraints?: ReadonlyArray<DomainConstraint>;
} {
	const leftFds = leftPhys?.fds ?? [];
	const rightFds = rightPhys?.fds ?? [];
	const leftEC = leftPhys?.equivClasses ?? [];
	const rightEC = rightPhys?.equivClasses ?? [];
	const leftBindings = leftPhys?.constantBindings ?? [];
	const rightBindings = rightPhys?.constantBindings ?? [];
	const leftDomains = leftPhys?.domainConstraints ?? [];
	const rightDomains = rightPhys?.domainConstraints ?? [];

	const opts = { keyHints: preservedKeys };

	/**
	 * Layer `preservedKeys` onto `fds` as `key → all_other_join_cols` FDs. An
	 * empty key `[]` (a ≤1-row join output) maps to the singleton `∅ → all_cols`
	 * FD via `superkeyToFd([], totalColumnCount)`, so emitting `[]` in
	 * `preservedKeys` is sufficient to propagate at-most-one-row. Duplicate keys
	 * (e.g. two `[]` entries) collapse in `addFd`.
	 */
	const withKeyFds = (fds: ReadonlyArray<FunctionalDependency>): ReadonlyArray<FunctionalDependency> => {
		let out = fds;
		for (const key of preservedKeys) {
			const keyFd = superkeyToFd(key, totalColumnCount);
			if (keyFd) out = addFd(out, keyFd, opts);
		}
		return out;
	};

	const wrap = (
		fds: ReadonlyArray<FunctionalDependency>,
		equiv: ReadonlyArray<ReadonlyArray<number>>,
		bindings: ReadonlyArray<ConstantBinding>,
		domains: ReadonlyArray<DomainConstraint>,
	) => ({
		fds: fds.length > 0 ? fds : undefined,
		equivClasses: equiv.length > 0 ? equiv : undefined,
		constantBindings: bindings.length > 0 ? bindings : undefined,
		domainConstraints: domains.length > 0 ? domains : undefined,
	});

	switch (joinType) {
		case 'inner':
		case 'cross': {
			// A fanning (non-1:1) join duplicates the rows of a side whose unique key is
			// not preserved (no preserved key lies entirely within that side's columns).
			// Such a side's FDs remain true as value claims but no longer encode
			// uniqueness in the product — downgrade them (guarded FDs included) to
			// 'determination'. The kind-aware readers (`isUniqueDeterminant`) are what
			// keep a downstream projection from re-deriving a spurious key off them
			// (ticket fd-determination-reader-side-rule, replacing `dropSideKeyFds`).
			const leftPreserved = preservedKeys.some(k => k.every(i => i < leftColumnCount));
			const rightPreserved = preservedKeys.some(k => k.every(i => i >= leftColumnCount));
			const keptLeftFds = leftPreserved ? leftFds : downgradeUniqueFds(leftFds);
			const keptRightFds = rightPreserved ? rightFds : downgradeUniqueFds(rightFds);
			let fds: ReadonlyArray<FunctionalDependency> = mergeFds(keptLeftFds, shiftFds(keptRightFds, leftColumnCount), opts);
			let equiv: ReadonlyArray<ReadonlyArray<number>> = mergeEquivClasses(leftEC, shiftEquivClasses(rightEC, leftColumnCount));
			// An equi-pair `{L}↔{R'}` is a value-equality claim: emit both directions
			// unconditionally as 'determination'. Uniqueness facts live exclusively on
			// the preserved-key FDs layered below (`withKeyFds` mints 'unique'); a
			// determination is never read as a uniqueness claim by the kind-aware
			// readers, so no endpoint gate is needed. The EC merge stays unconditional
			// too — value equality also carries constant propagation.
			for (const p of equiPairs) {
				const rShifted = p.right + leftColumnCount;
				fds = addFd(fds, { determinants: [p.left], dependents: [rShifted], kind: 'determination' }, opts);
				fds = addFd(fds, { determinants: [rShifted], dependents: [p.left], kind: 'determination' }, opts);
				equiv = addEquivalence(equiv, p.left, rShifted);
			}
			fds = withKeyFds(fds);
			// Bindings: union of both sides, then close over the merged EC list so
			// a one-sided constant `t.k = 5` plus an equi-pair `t.k = u.k` lands as
			// a binding covering both `t.k` and `u.k`.
			const mergedBindings = mergeConstantBindings(
				leftBindings,
				shiftConstantBindings(rightBindings, leftColumnCount),
			);
			const bindings = closeConstantBindingsOverEcs(mergedBindings, equiv);
			const domains = mergeDomainConstraints(
				leftDomains,
				shiftDomainConstraints(rightDomains, leftColumnCount),
			);
			return wrap(fds, equiv, bindings, domains);
		}
		case 'left': {
			// A LEFT join fans out left rows when the equi-predicate does not cover a
			// right-side key (one left row can match several right rows). When left's
			// key is therefore NOT preserved, downgrade its FDs (guarded included) to
			// 'determination' — mirrors the inner/cross arm; the kind-aware readers
			// keep a downstream key-dropping projection from re-deriving the left key.
			const leftPreserved = preservedKeys.some(k => k.every(i => i < leftColumnCount));
			const keptLeftFds = leftPreserved ? leftFds : downgradeUniqueFds(leftFds);
			// Left's bindings survive on left's columns; right's are dropped (the
			// NULL-padding from unmatched left rows breaks any right-side pin).
			const fds = withKeyFds(keptLeftFds.slice());
			return wrap(fds, leftEC.map(c => c.slice()), leftBindings.map(b => ({ ...b })), leftDomains.slice());
		}
		case 'right': {
			// Mirror of LEFT: a RIGHT join fans out right rows when the equi-predicate
			// does not cover a left-side key. Downgrade the right side's FDs when no
			// preserved key lies within the right side.
			const rightPreserved = preservedKeys.some(k => k.every(i => i >= leftColumnCount));
			const keptRightFds = rightPreserved ? rightFds : downgradeUniqueFds(rightFds);
			let fds: ReadonlyArray<FunctionalDependency> = shiftFds(keptRightFds, leftColumnCount);
			fds = withKeyFds(fds);
			const equiv = shiftEquivClasses(rightEC, leftColumnCount);
			const bindings = shiftConstantBindings(rightBindings, leftColumnCount);
			const domains = shiftDomainConstraints(rightDomains, leftColumnCount);
			return wrap(fds, equiv, bindings, domains);
		}
		case 'full':
			return {};
		case 'semi':
		case 'anti': {
			const fds = withKeyFds(leftFds.slice());
			return wrap(fds, leftEC.map(c => c.slice()), leftBindings.map(b => ({ ...b })), leftDomains.slice());
		}
		default:
			return {};
	}
}

/**
 * Propagate inclusion dependencies through a join operator. The IND analogue of
 * `propagateJoinFds` — it MUST stay consistent with that function and
 * `analyzeJoinKeyCoverage`.
 *
 * INDs assert per-row existence in another relation, so a NULL-padded side can
 * violate the claim and is dropped conservatively:
 * - inner / cross: union of left INDs and `shiftInds(right, leftColumnCount)`.
 * - left (preserved = left): keep left INDs; drop the right side's INDs (the
 *   right columns are NULL-padded for unmatched left rows).
 * - right (preserved = right): keep `shiftInds(right, leftColumnCount)`; drop left.
 * - semi / anti: keep left INDs only (right columns are not in the output).
 * - full: drop both (either side can be NULL-padded).
 */
export function propagateJoinInds(
	joinType: JoinType,
	leftPhys: PhysicalProperties | undefined,
	rightPhys: PhysicalProperties | undefined,
	leftColumnCount: number,
): ReadonlyArray<InclusionDependency> | undefined {
	const leftInds = leftPhys?.inds ?? [];
	const rightInds = rightPhys?.inds ?? [];

	let result: ReadonlyArray<InclusionDependency>;
	switch (joinType) {
		case 'inner':
		case 'cross':
			result = mergeInds(leftInds, shiftInds(rightInds, leftColumnCount));
			break;
		case 'left':
		case 'semi':
		case 'anti':
			result = leftInds.slice();
			break;
		case 'right':
			result = shiftInds(rightInds, leftColumnCount);
			break;
		case 'full':
		default:
			result = [];
			break;
	}
	return result.length > 0 ? result : undefined;
}

/**
 * Estimate the number of output rows for a join given the input cardinalities.
 */
export function estimateJoinRows(
	leftRows: number | undefined,
	rightRows: number | undefined,
	joinType: JoinType,
): number | undefined {
	if (leftRows === undefined || rightRows === undefined) return undefined;

	switch (joinType) {
		case 'cross':
			return leftRows * rightRows;
		case 'inner':
			return Math.max(1, leftRows * rightRows * 0.1);
		case 'left':
			return leftRows;
		case 'right':
			return rightRows;
		case 'full':
			return leftRows + rightRows;
		case 'semi':
		case 'anti':
			return Math.max(1, Math.floor(leftRows * 0.5));
		default:
			return leftRows * rightRows * 0.1;
	}
}

/**
 * Functional dependency (FD) and equivalence-class (EC) helpers used by
 * `computePhysical` on relational plan nodes. See `docs/optimizer-fd.md`
 * for the propagation table and design rationale.
 */

import { createLogger } from '../../common/logger.js';
import type { ConstantBinding, ConstantValue, DomainConstraint, FunctionalDependency, GuardClause, GuardPredicate, InclusionDependency, IndTarget, PhysicalProperties, ScalarPlanNode } from '../nodes/plan-node.js';
import type { RelationType } from '../../common/datatype.js';
import { ColumnReferenceNode, ParameterReferenceNode } from '../nodes/reference.js';
import { BetweenNode, BinaryOpNode, CastNode, CollateNode, LiteralNode, UnaryOpNode } from '../nodes/scalar.js';
import { InNode } from '../nodes/subquery.js';
import type { SqlValue } from '../../common/types.js';
import { compareSqlValues, normalizeCollationName, semanticOrderingsAgree } from '../../util/comparison.js';
import { flipComparison, literalValue } from '../analysis/predicate-shape.js';
import { effectiveBetweenBoundCollation, effectiveComparisonCollation, effectiveInCollation, isValueDiscriminatingEquality, operandCollation } from '../analysis/comparison-collation.js';

const log = createLogger('planner:fd');

/**
 * Per-node cap on the number of FDs we materialize. The propagation rules
 * are conservative enough that hitting this in practice is rare; the cap
 * is a safety valve for pathological plans.
 */
export const MAX_FDS_PER_NODE = 64;

/**
 * Closure of `attrs` under `fds`. Iterative fixed-point.
 *
 * Guarded FDs (`fd.guard !== undefined`) are skipped — they are only valid
 * under a surrounding predicate, and the closure layer has no notion of one.
 * Filter activation strips the guard before the FD reaches closure consumers.
 *
 * O(|fds| × growth) — terminates when no new attribute is added in a pass.
 */
export function computeClosure(
	attrs: ReadonlySet<number>,
	fds: ReadonlyArray<FunctionalDependency>,
): Set<number> {
	const closure = new Set<number>(attrs);
	let changed = true;
	while (changed) {
		changed = false;
		for (const fd of fds) {
			if (fd.guard !== undefined) continue;
			if (fd.determinants.every(d => closure.has(d))) {
				for (const dep of fd.dependents) {
					if (!closure.has(dep)) {
						closure.add(dep);
						changed = true;
					}
				}
			}
		}
	}
	return closure;
}

/**
 * Expand a list of equivalence classes into bi-directional FDs over the same
 * column indices, then concatenate with the existing FDs. For a class
 * `{c0, c1, ..., ck}` this emits `{ci} → {cj}` for every distinct ordered pair
 * — enough for `computeClosure` to derive every member from any one of them.
 * EC-derived FDs are pure value claims (`kind: 'determination'`) — an equality
 * never implies row-uniqueness of either endpoint.
 */
export function expandEcsToFds(
	ecs: ReadonlyArray<ReadonlyArray<number>>,
	fds: ReadonlyArray<FunctionalDependency>,
): FunctionalDependency[] {
	const out: FunctionalDependency[] = fds.slice();
	for (const cls of ecs) {
		if (cls.length < 2) continue;
		for (let i = 0; i < cls.length; i++) {
			for (let j = 0; j < cls.length; j++) {
				if (i === j) continue;
				out.push({ determinants: [cls[i]], dependents: [cls[j]], kind: 'determination' });
			}
		}
	}
	return out;
}

/** True iff `attrs` determines every attribute in `target` under `fds`. */
export function determines(
	attrs: ReadonlySet<number>,
	target: ReadonlySet<number>,
	fds: ReadonlyArray<FunctionalDependency>,
): boolean {
	if (target.size === 0) return true;
	const closure = computeClosure(attrs, fds);
	for (const t of target) {
		if (!closure.has(t)) return false;
	}
	return true;
}

/**
 * Smallest subset of `attrs` whose closure equals the closure of `attrs`.
 * Greedy minimization: try dropping each attribute; keep the drop iff the
 * resulting closure is unchanged. O(|attrs|² × |fds|).
 */
export function minimalCover(
	attrs: ReadonlySet<number>,
	fds: ReadonlyArray<FunctionalDependency>,
): Set<number> {
	const fullClosure = computeClosure(attrs, fds);
	const result = new Set<number>(attrs);
	for (const a of [...result]) {
		const trial = new Set<number>(result);
		trial.delete(a);
		const trialClosure = computeClosure(trial, fds);
		if (trialClosure.size === fullClosure.size) {
			let same = true;
			for (const x of fullClosure) {
				if (!trialClosure.has(x)) { same = false; break; }
			}
			if (same) result.delete(a);
		}
	}
	return result;
}

// Structural-only equality: compares determinants/dependents/guard. The
// optional `source` provenance tag (`declared-check` vs `assertion`) is NOT
// compared here, so two structurally-identical FDs from different sources
// collapse to one in `addFd` / `mergeFds`. The first-merged source wins —
// table references merge declared-check contributions before hoisted
// assertion contributions, so `declared-check` is preferred on collisions.
// `kind` and `valueEquality` are likewise NOT compared; `addFd` reconciles
// `kind` on collisions with an "'unique' wins" rule (uniqueness is a property
// of the determinant set, so equal-determinant claims compose).
function fdsEqual(a: FunctionalDependency, b: FunctionalDependency): boolean {
	if (a.determinants.length !== b.determinants.length) return false;
	if (a.dependents.length !== b.dependents.length) return false;
	const aDet = new Set(a.determinants);
	for (const d of b.determinants) if (!aDet.has(d)) return false;
	const aDep = new Set(a.dependents);
	for (const d of b.dependents) if (!aDep.has(d)) return false;
	return guardsEqual(a.guard, b.guard);
}

function guardsEqual(a: GuardPredicate | undefined, b: GuardPredicate | undefined): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	if (a.clauses.length !== b.clauses.length) return false;
	// Order-insensitive clause comparison.
	const used = new Array<boolean>(b.clauses.length).fill(false);
	for (const ac of a.clauses) {
		let matched = false;
		for (let i = 0; i < b.clauses.length; i++) {
			if (used[i]) continue;
			if (guardClauseEquals(ac, b.clauses[i])) {
				used[i] = true;
				matched = true;
				break;
			}
		}
		if (!matched) return false;
	}
	return true;
}

function guardClauseEquals(a: GuardClause, b: GuardClause): boolean {
	if (a.kind !== b.kind) return false;
	if (a.kind === 'eq-literal' && b.kind === 'eq-literal') {
		return a.column === b.column && sqlValueEquals(a.value, b.value);
	}
	if (a.kind === 'eq-column' && b.kind === 'eq-column') {
		// Order-insensitive on left/right.
		return (a.left === b.left && a.right === b.right)
			|| (a.left === b.right && a.right === b.left);
	}
	if (a.kind === 'is-null' && b.kind === 'is-null') {
		return a.column === b.column && a.negated === b.negated;
	}
	if (a.kind === 'range' && b.kind === 'range') {
		if (a.column !== b.column) return false;
		const aHasMin = a.min !== undefined;
		const bHasMin = b.min !== undefined;
		if (aHasMin !== bHasMin) return false;
		if (aHasMin && !sqlValueEquals(a.min!, b.min!)) return false;
		if (aHasMin && a.minInclusive !== b.minInclusive) return false;
		const aHasMax = a.max !== undefined;
		const bHasMax = b.max !== undefined;
		if (aHasMax !== bHasMax) return false;
		if (aHasMax && !sqlValueEquals(a.max!, b.max!)) return false;
		if (aHasMax && a.maxInclusive !== b.maxInclusive) return false;
		return true;
	}
	if (a.kind === 'or-of' && b.kind === 'or-of') {
		if (a.clauses.length !== b.clauses.length) return false;
		// Order-insensitive sub-clause comparison.
		const used = new Array<boolean>(b.clauses.length).fill(false);
		for (const ac of a.clauses) {
			let matched = false;
			for (let i = 0; i < b.clauses.length; i++) {
				if (used[i]) continue;
				if (guardClauseEquals(ac, b.clauses[i])) {
					used[i] = true;
					matched = true;
					break;
				}
			}
			if (!matched) return false;
		}
		return true;
	}
	return false;
}

function determinantsEqual(a: readonly number[], b: readonly number[]): boolean {
	if (a.length !== b.length) return false;
	const aSet = new Set(a);
	for (const x of b) if (!aSet.has(x)) return false;
	return true;
}

function dependentsSubset(sub: readonly number[], sup: readonly number[]): boolean {
	const supSet = new Set(sup);
	for (const x of sub) if (!supSet.has(x)) return false;
	return true;
}

export interface AddFdOptions {
	/**
	 * Hint: column subsets that are known full-cover keys on the relation.
	 * Used by `enforceCap` to prefer FDs whose determinants are subsets of
	 * any such key when truncating; otherwise unused. Optional.
	 */
	keyHints?: ReadonlyArray<ReadonlyArray<number>>;
	cap?: number;
}

/**
 * Add a single FD, dropping any existing entry with the same determinants
 * (and same guard) whose dependents are a subset of the new one (subsumption).
 * When the resulting list exceeds the cap, drop FDs whose determinants are
 * not a subset of any `keyHints` entry on the same node.
 *
 * Guard-aware: FDs with different `guard` predicates are kept side-by-side
 * even when their determinants/dependents match — they are logically distinct
 * facts and may be activated by different surrounding predicates.
 *
 * Kind reconciliation: on a merge between entries with equal determinants and
 * guards, the surviving entry's `kind` is `'unique'` when EITHER side claims
 * it — uniqueness is a property of the determinant set, so equal-determinant
 * claims compose. This includes upgrading a kept 'determination' entry in
 * place when the subsumed newcomer is 'unique'. Equal-determinant entries with
 * incomparable dependent sets both survive and each keeps its own kind (a
 * sound under-claim). Object identity is preserved when nothing changes.
 */
export function addFd(
	fds: ReadonlyArray<FunctionalDependency>,
	next: FunctionalDependency,
	opts: AddFdOptions = {},
): FunctionalDependency[] {
	if (next.dependents.length === 0) return fds.slice();

	const result: FunctionalDependency[] = [];
	let subsumedByExisting = false;
	// 'unique' wins on merge: a dropped-or-subsumed 'unique' twin upgrades the survivor.
	let nextKind = next.kind;
	for (const existing of fds) {
		if (fdsEqual(existing, next)) {
			subsumedByExisting = true;
			result.push(next.kind === 'unique' && existing.kind !== 'unique'
				? { ...existing, kind: 'unique' }
				: existing);
			continue;
		}
		if (
			determinantsEqual(existing.determinants, next.determinants) &&
			guardsEqual(existing.guard, next.guard)
		) {
			// Same determinants and guard: keep whichever has the larger dependent set.
			if (dependentsSubset(existing.dependents, next.dependents)) {
				// existing ⊂ next, drop existing — its uniqueness claim survives on next.
				if (existing.kind === 'unique') nextKind = 'unique';
				continue;
			}
			if (dependentsSubset(next.dependents, existing.dependents)) {
				subsumedByExisting = true;
				result.push(next.kind === 'unique' && existing.kind !== 'unique'
					? { ...existing, kind: 'unique' }
					: existing);
				continue;
			}
		}
		result.push(existing);
	}
	if (!subsumedByExisting) {
		result.push(nextKind === next.kind ? next : { ...next, kind: nextKind });
	}

	return enforceCap(result, opts);
}

function enforceCap(
	fds: FunctionalDependency[],
	opts: AddFdOptions,
): FunctionalDependency[] {
	const cap = opts.cap ?? MAX_FDS_PER_NODE;
	if (fds.length <= cap) return fds;

	const keyHints = opts.keyHints ?? [];
	const keySet = keyHints.map(k => new Set(k));

	const isSubsetOfAnyKey = (det: readonly number[]): boolean => {
		if (keySet.length === 0) return false;
		return keySet.some(ks => det.every(d => ks.has(d)));
	};

	const preferred = fds.filter(fd => isSubsetOfAnyKey(fd.determinants));
	const other = fds.filter(fd => !isSubsetOfAnyKey(fd.determinants));

	// Quality bias within each partition: keep 'unique' FDs ahead of plain
	// determinations. Evicting a uniqueness witness can only cause downstream
	// under-claims (sound), but it is cheap to avoid.
	const uniqueFirst = (list: FunctionalDependency[]): FunctionalDependency[] => [
		...list.filter(fd => fd.kind === 'unique'),
		...list.filter(fd => fd.kind !== 'unique'),
	];

	let kept: FunctionalDependency[];
	if (preferred.length >= cap) {
		kept = uniqueFirst(preferred).slice(0, cap);
	} else {
		kept = preferred.concat(uniqueFirst(other).slice(0, cap - preferred.length));
	}

	log('FD cap reached: dropped %d FD(s) from %d', fds.length - kept.length, fds.length);
	return kept;
}

/** Merge two FD lists, applying subsumption via `addFd`. */
export function mergeFds(
	a: ReadonlyArray<FunctionalDependency>,
	b: ReadonlyArray<FunctionalDependency>,
	opts: AddFdOptions = {},
): FunctionalDependency[] {
	let result: FunctionalDependency[] = a.slice();
	for (const fd of b) {
		result = addFd(result, fd, opts);
	}
	return result;
}

/**
 * Project FDs through a column mapping (oldCol → newCol). FDs whose
 * determinants lose any column are dropped entirely (the projection breaks
 * the determinant set). Dependents that don't survive are filtered out;
 * an FD whose dependents are completely filtered is dropped.
 *
 * Exception: an FD with empty determinants (the singleton "at-most-one-row"
 * marker) survives as long as at least one dependent does — losing some
 * dependent columns to projection doesn't invalidate the at-most-one-row
 * claim on the surviving columns.
 *
 * Guarded FDs additionally require every column referenced in `guard.clauses`
 * to be in the mapping — if any guard column is dropped the guard becomes
 * unobservable and the FD can never be re-activated downstream.
 *
 * Rebuilds via spread so `kind` / `source` / `valueEquality` survive verbatim.
 * Preserving `kind` is sound: a projection maps rows 1:1 (no merge, no
 * duplication), so determinant row-uniqueness survives whenever the
 * determinants survive — which the determinant-loss drop above already
 * requires. The empty-determinant exception keeps its kind too: a 'unique'
 * singleton stays ≤1-row under projection; a 'determination' constant pin
 * stays a mere pin.
 */
export function projectFds(
	fds: ReadonlyArray<FunctionalDependency>,
	mapping: ReadonlyMap<number, number>,
): FunctionalDependency[] {
	const result: FunctionalDependency[] = [];
	for (const fd of fds) {
		const newDet: number[] = [];
		let miss = false;
		for (const d of fd.determinants) {
			const m = mapping.get(d);
			if (m === undefined) { miss = true; break; }
			newDet.push(m);
		}
		if (miss) continue;

		const newDep: number[] = [];
		for (const d of fd.dependents) {
			const m = mapping.get(d);
			if (m !== undefined) newDep.push(m);
		}
		if (newDep.length === 0) continue;

		let newGuard: GuardPredicate | undefined;
		if (fd.guard !== undefined) {
			const mappedGuard = projectGuard(fd.guard, mapping);
			if (!mappedGuard) continue;
			newGuard = mappedGuard;
		}

		result.push(newGuard
			? { ...fd, determinants: newDet, dependents: newDep, guard: newGuard }
			: { ...fd, determinants: newDet, dependents: newDep });
	}
	return result;
}

function projectGuard(
	guard: GuardPredicate,
	mapping: ReadonlyMap<number, number>,
): GuardPredicate | undefined {
	const clauses: GuardClause[] = [];
	for (const clause of guard.clauses) {
		const mapped = projectClause(clause, mapping);
		if (mapped === undefined) return undefined;
		clauses.push(mapped);
	}
	return { clauses };
}

function projectClause(
	clause: GuardClause,
	mapping: ReadonlyMap<number, number>,
): GuardClause | undefined {
	switch (clause.kind) {
		case 'eq-literal': {
			const m = mapping.get(clause.column);
			if (m === undefined) return undefined;
			return { kind: 'eq-literal', column: m, value: clause.value };
		}
		case 'eq-column': {
			const ml = mapping.get(clause.left);
			const mr = mapping.get(clause.right);
			if (ml === undefined || mr === undefined) return undefined;
			return { kind: 'eq-column', left: ml, right: mr };
		}
		case 'is-null': {
			const m = mapping.get(clause.column);
			if (m === undefined) return undefined;
			return { kind: 'is-null', column: m, negated: clause.negated };
		}
		case 'range': {
			const m = mapping.get(clause.column);
			if (m === undefined) return undefined;
			return { ...clause, column: m };
		}
		case 'or-of': {
			const sub: GuardClause[] = [];
			for (const c of clause.clauses) {
				const mapped = projectClause(c, mapping);
				// Same conservative rule as the rest of projectGuard: if any nested
				// column drops out the whole clause is unrecoverable.
				if (mapped === undefined) return undefined;
				sub.push(mapped);
			}
			return { kind: 'or-of', clauses: sub };
		}
	}
}

/**
 * Shift all column indices in `fds` (including any `guard` columns) by `offset`.
 * Rebuilds via spread so `kind` / `source` / `valueEquality` survive verbatim —
 * a shift is a pure column relabel, so every claim (uniqueness included) holds
 * unchanged on the relabeled columns.
 */
export function shiftFds(
	fds: ReadonlyArray<FunctionalDependency>,
	offset: number,
): FunctionalDependency[] {
	if (offset === 0) return fds.slice();
	return fds.map(fd => {
		const shifted: FunctionalDependency = {
			...fd,
			determinants: fd.determinants.map(d => d + offset),
			dependents: fd.dependents.map(d => d + offset),
		};
		if (fd.guard !== undefined) {
			return { ...shifted, guard: shiftGuard(fd.guard, offset) };
		}
		return shifted;
	});
}

function shiftGuard(guard: GuardPredicate, offset: number): GuardPredicate {
	return { clauses: guard.clauses.map(c => shiftClause(c, offset)) };
}

function shiftClause(clause: GuardClause, offset: number): GuardClause {
	switch (clause.kind) {
		case 'eq-literal':
			return { kind: 'eq-literal', column: clause.column + offset, value: clause.value };
		case 'eq-column':
			return { kind: 'eq-column', left: clause.left + offset, right: clause.right + offset };
		case 'is-null':
			return { kind: 'is-null', column: clause.column + offset, negated: clause.negated };
		case 'range':
			return { ...clause, column: clause.column + offset };
		case 'or-of':
			return { kind: 'or-of', clauses: clause.clauses.map(c => shiftClause(c, offset)) };
	}
}

/**
 * Return the unconditional twin of `fd` — drop the guard but keep every other
 * field (`kind` / `source` / `valueEquality` survive verbatim). Used by Filter
 * activation when the surrounding predicate entails the guard. Preserving
 * 'unique' is sound at the activating Filter: its rows all satisfy the guard,
 * and filtering only shrinks the row set — fan-out hazards are handled by the
 * join-side downgrade, not here.
 */
export function stripGuard(fd: FunctionalDependency): FunctionalDependency {
	if (fd.guard === undefined) return fd;
	const { guard: _guard, ...rest } = fd;
	return rest;
}

/** Shift all column indices in `classes` by `offset`. */
export function shiftEquivClasses(
	classes: ReadonlyArray<ReadonlyArray<number>>,
	offset: number,
): number[][] {
	if (offset === 0) return classes.map(c => c.slice());
	return classes.map(c => c.map(x => x + offset));
}

function normalizeClass(cls: ReadonlyArray<number>): number[] {
	const dedup = Array.from(new Set(cls));
	dedup.sort((a, b) => a - b);
	return dedup;
}

/**
 * Merge two equivalence-class sets, taking the transitive closure of
 * overlapping classes (union-find style).
 */
export function mergeEquivClasses(
	a: ReadonlyArray<ReadonlyArray<number>>,
	b: ReadonlyArray<ReadonlyArray<number>>,
): number[][] {
	const classes: number[][] = [...a, ...b].map(c => normalizeClass(c));

	let merged = true;
	while (merged) {
		merged = false;
		outer:
		for (let i = 0; i < classes.length; i++) {
			const ci = classes[i];
			const ciSet = new Set(ci);
			for (let j = i + 1; j < classes.length; j++) {
				const cj = classes[j];
				let overlap = false;
				for (const x of cj) {
					if (ciSet.has(x)) { overlap = true; break; }
				}
				if (overlap) {
					classes[i] = normalizeClass([...ci, ...cj]);
					classes.splice(j, 1);
					merged = true;
					break outer;
				}
			}
		}
	}

	return classes.filter(c => c.length >= 2);
}

/** Add a new equality `a ≡ b` to an existing class list. */
export function addEquivalence(
	classes: ReadonlyArray<ReadonlyArray<number>>,
	a: number,
	b: number,
): number[][] {
	if (a === b) return classes.map(c => c.slice());
	return mergeEquivClasses(classes, [[a, b]]);
}

/**
 * Build an FD `key → {0..columnCount-1} \ key` from a superkey. The canonical
 * way to encode "K is a unique key on a relation": K determines every other
 * output column. K = ∅ produces the "at-most-one-row" singleton FD.
 *
 * Emits `kind: 'unique'` — every caller passes a genuine key (declared or
 * projected keys, fan-out-aware join `preservedKeys`, the aggregate group key,
 * the set-op data-columns key, lens key obligations, TVF-declared keys), so
 * the relation has at most one row per determinant tuple at the minting site.
 *
 * Returns undefined when K covers every column (the all-columns case has no
 * non-trivial encoding — that case is communicated via `RelationType.isSet`
 * instead).
 */
export function superkeyToFd(
	key: readonly number[],
	columnCount: number,
): FunctionalDependency | undefined {
	const keySet = new Set(key);
	const dependents: number[] = [];
	for (let i = 0; i < columnCount; i++) {
		if (!keySet.has(i)) dependents.push(i);
	}
	if (dependents.length === 0) return undefined;
	return { determinants: key.slice(), dependents, kind: 'unique' };
}

/**
 * True iff the closure of `attrs` under `fds` covers `{0..columnCount-1}`.
 * COVERAGE ONLY — this is a pure value-determination claim and says NOTHING
 * about row-uniqueness: over a bag, a determination-only closure path can
 * cover every column while the relation still holds duplicate rows. For the
 * uniqueness question ("at most one row per attrs-tuple?") use
 * `isUniqueDeterminant`. (Renamed from `isSuperkey`, whose name read as a
 * uniqueness claim and invited exactly that misuse — ticket
 * `fd-determination-reader-side-rule`.)
 */
export function closureCoversAll(
	attrs: ReadonlySet<number>,
	fds: ReadonlyArray<FunctionalDependency> | undefined,
	columnCount: number,
): boolean {
	if (columnCount <= 0) return true;
	const closure = computeClosure(attrs, fds ?? []);
	for (let i = 0; i < columnCount; i++) {
		if (!closure.has(i)) return false;
	}
	return true;
}

/**
 * True iff `attrs` is provably row-unique on the relation: its FD closure
 * covers every column AND uniqueness is reachable —
 *   - the relation is a set (two rows agreeing on `attrs` would agree on all
 *     columns = a duplicate, impossible in a set), or
 *   - some unguarded `kind: 'unique'` FD has determinants ⊆ closure(attrs)
 *     (rows agreeing on `attrs` agree on that unique determinant set; ≤1 row
 *     per its tuple ⇒ ≤1 row per attrs-tuple).
 *
 * Coverage alone (a determination-only closure path over a bag) proves
 * nothing — that is the over-claim family the kind-aware readers exist to
 * prevent (ticket `fd-determination-reader-side-rule`). This is the single
 * reader-side uniqueness primitive; producers no longer gate determinations.
 *
 * Guarded FDs participate in neither branch: `computeClosure` skips them, and
 * only UNguarded 'unique' FDs can witness (a guarded uniqueness claim holds
 * only under its predicate, which this layer cannot see).
 */
export function isUniqueDeterminant(
	attrs: ReadonlySet<number>,
	fds: ReadonlyArray<FunctionalDependency> | undefined,
	columnCount: number,
	isSet: boolean,
): boolean {
	const fdList = fds ?? [];
	const closure = computeClosure(attrs, fdList);
	for (let i = 0; i < columnCount; i++) {
		if (!closure.has(i)) return false;
	}
	if (isSet) return true;
	return fdList.some(fd =>
		fd.guard === undefined &&
		fd.kind === 'unique' &&
		fd.determinants.every(d => closure.has(d)),
	);
}

/**
 * Enumerate the minimal full-cover key sets discoverable from `fds`: for each
 * FD `K → Y` where `K` is a provably row-unique determinant
 * (`isUniqueDeterminant` — coverage AND uniqueness reachability), return `K`
 * (greedily minimized within `K`). Deduplicated by set equality.
 *
 * `minimalCover` preserves the closure, so the minimized key keeps both
 * coverage and the unique witness (witness determinants ⊆ the unchanged
 * closure).
 *
 * Excludes the trivial "all-columns is a key of a set" tautology — only FDs
 * with `K ⊊ all_cols` are considered, since the all-cols case is encoded via
 * `RelationType.isSet` (the `keysOf` fallback).
 */
export function deriveKeysFromFds(
	fds: ReadonlyArray<FunctionalDependency> | undefined,
	columnCount: number,
	isSet: boolean,
): number[][] {
	if (!fds || fds.length === 0) return [];
	const results: number[][] = [];
	const seen = new Set<string>();
	for (const fd of fds) {
		if (fd.guard !== undefined) continue;
		if (fd.determinants.length >= columnCount) continue;
		const det = new Set(fd.determinants);
		if (!isUniqueDeterminant(det, fds, columnCount, isSet)) continue;
		const minimal = minimalCover(det, fds);
		const sorted = Array.from(minimal).sort((a, b) => a - b);
		const key = sorted.join(',');
		if (seen.has(key)) continue;
		seen.add(key);
		results.push(sorted);
	}
	return results;
}

/**
 * True iff the FD set encodes any non-trivial key — i.e., there exists some
 * FD whose determinants are a provably row-unique determinant set
 * (`isUniqueDeterminant`) strictly smaller than all columns. This is the
 * FD-surface replacement for "the relation has a known unique key smaller
 * than its full column list" (the old `uniqueKeys.length > 0` check),
 * excluding the tautological all-columns case which carries no information.
 */
export function hasAnyKey(
	fds: ReadonlyArray<FunctionalDependency> | undefined,
	columnCount: number,
	isSet: boolean,
): boolean {
	if (!fds || fds.length === 0) return false;
	return fds.some(fd =>
		fd.guard === undefined &&
		fd.determinants.length < columnCount &&
		isUniqueDeterminant(new Set(fd.determinants), fds, columnCount, isSet),
	);
}

/**
 * True iff the relation is provably at-most-one-row from its FD surface —
 * `isUniqueDeterminant(∅, …)`: the closure of the empty set covers every
 * column AND uniqueness is reachable (the relation is a set, or an unguarded
 * 'unique' FD witnesses). Replaces the legacy `[[]]` singleton marker on
 * `uniqueKeys`.
 *
 * On a bag, constant pins (`∅ → col` determinations from `where a = 1`) no
 * longer over-claim ≤1-row; on a set, pinning every column IS a sound ≤1-row
 * derivation. Zero-column relations return false — the `∅ → all_cols` FD is
 * unrepresentable there, so the ≤1-row claim rides `estimatedRows` instead
 * (see `characteristics.guaranteesUniqueRows`).
 */
export function hasSingletonFd(
	fds: ReadonlyArray<FunctionalDependency> | undefined,
	columnCount: number,
	isSet: boolean,
): boolean {
	if (columnCount <= 0) return false;
	return isUniqueDeterminant(new Set<number>(), fds, columnCount, isSet);
}

/**
 * Build the singleton FD `∅ → {0..columnCount-1}` that encodes
 * "at-most-one-row". `kind: 'unique'` — ∅ row-unique ⟺ ≤1 row, which is
 * exactly what every caller asserts. Returns undefined when
 * `columnCount === 0` (no dependents).
 */
export function singletonFd(columnCount: number): FunctionalDependency | undefined {
	if (columnCount <= 0) return undefined;
	const dependents: number[] = [];
	for (let i = 0; i < columnCount; i++) dependents.push(i);
	return { determinants: [], dependents, kind: 'unique' };
}

/**
 * Fold the singleton FD `∅ → {0..columnCount-1}` ("at-most-one-row") into `fds`
 * via `addFd`. The canonical producer-side spelling of the ≤1-row fact — every
 * `computePhysical` site that proves a relation emits ≤1 row should reach for
 * this rather than open-coding `singletonFd` + `addFd`.
 *
 * A no-op returning a copy of `fds` when `columnCount === 0` (since
 * `singletonFd(0)` is `undefined` — a zero-column relation cannot carry the
 * marker). Pairs with the `hasSingletonFd` / `isAtMostOneRow` read surface.
 */
export function addSingletonFd(
	fds: ReadonlyArray<FunctionalDependency>,
	columnCount: number,
): FunctionalDependency[] {
	const singleton = singletonFd(columnCount);
	return singleton ? addFd(fds, singleton) : fds.slice();
}

// NOTE: the former `isAssertedKey` (per-FD determinant anchoring + coverage)
// is subsumed by `isUniqueDeterminant`, which is strictly more general (the
// closure composes multi-FD paths the per-FD anchoring missed) and genuinely a
// uniqueness predicate. Former callers (the sort/window strict-monotonicOn
// checks) call `isUniqueDeterminant` directly.

// ---------------------------------------------------------------------------
// Unified uniqueness read surface (keysOf / isUnique)
// ---------------------------------------------------------------------------

/**
 * The minimal slice of a relational plan node needed to read its uniqueness
 * facts. `getType()` supplies the declared `keys`, the `isSet` flag, and the
 * output column count; `physical?.fds` supplies the derived FD surface.
 */
export interface KeyRel {
	getType(): RelationType;
	physical?: PhysicalProperties;
}

/**
 * Normalize a list of candidate keys to the minimal, deduped set:
 *   - each key is sorted and de-duplicated internally,
 *   - duplicate keys collapse,
 *   - any key that is a (non-strict) superset of another retained key is
 *     dropped — only minimal keys survive.
 *
 * The empty key `[]` (proven ≤1-row) is a subset of every other key, so when
 * present it subsumes them all and is the sole survivor.
 */
function normalizeKeys(keys: readonly (readonly number[])[]): number[][] {
	const sorted = keys.map(k => Array.from(new Set(k)).sort((a, b) => a - b));
	const uniq: number[][] = [];
	const seen = new Set<string>();
	for (const k of sorted) {
		const sig = k.join(',');
		if (seen.has(sig)) continue;
		seen.add(sig);
		uniq.push(k);
	}
	const result: number[][] = [];
	for (const k of uniq) {
		const kSet = new Set(k);
		const subsumed = uniq.some(other =>
			other !== k &&
			other.length < k.length &&
			other.every(c => kSet.has(c)),
		);
		if (!subsumed) result.push(k);
	}
	return result;
}

function allColumns(columnCount: number): number[] {
	const cols: number[] = [];
	for (let i = 0; i < columnCount; i++) cols.push(i);
	return cols;
}

/**
 * Canonical minimal candidate keys of a relation, each a sorted readonly
 * `number[]` of output column indices, normalized and deduped. This is the
 * single uniqueness read path — it reconciles all three surfaces a uniqueness
 * fact can live on (declared `RelationType.keys`, the `PhysicalProperties.fds`
 * FD set, and `RelationType.isSet`) so consumers never have to "check all
 * three" by hand.
 *
 * Keys are gathered cheap → expensive:
 *   1. Declared `keys` (mapped to column indices). The empty key `[]`
 *      (TableDee / ≤1-row) is preserved as an empty entry and subsumes all.
 *   2. The `∅ → all_cols` FD (`hasSingletonFd`) ⇒ the empty key `[]`.
 *   3. FD-derived keys via `deriveKeysFromFds`.
 *   4. All-columns fallback: if nothing smaller was found AND the relation is
 *      a set (`getType().isSet`), the all-columns key `[0..n-1]`.
 *
 * Result is `[]` (no entries) ⟺ the relation is a bag (no provable key).
 *
 * **Enumeration bound (soundness vs completeness):** deriving minimal keys
 * from a general FD set is the candidate-key enumeration problem (NP-hard in
 * column count). We do NOT enumerate column subsets — `deriveKeysFromFds`
 * seeds one candidate per existing FD and minimizes within it, and the
 * declared keys + all-columns fallback are always emitted regardless of
 * FD-enumeration cost. Over-capping here costs **completeness only** (a real
 * key may go unlisted), never **soundness** (a listed key always holds). Use
 * `isUnique` for the soundness-critical "is this set a superkey?" question —
 * it additionally consults FD closure, which can prove a superkey absent from
 * this minimal list.
 */
export function keysOf(rel: KeyRel): readonly (readonly number[])[] {
	const type = rel.getType();
	const columnCount = type.columns.length;
	const fds = rel.physical?.fds;

	const keys: number[][] = [];

	// 1. Declared keys (RelationType.keys). An empty ColRef[] ⇒ the empty key.
	for (const key of type.keys) {
		keys.push(key.map(ref => ref.index));
	}

	// 2. Provable ≤1-row (kind-aware) ⇒ the empty key.
	if (hasSingletonFd(fds, columnCount, type.isSet)) {
		keys.push([]);
	}

	// 3. FD-derived keys (already bounded to FDs with det.length < columnCount).
	// `isSet` threads through so a determination-only covering determinant over
	// a set (e.g. above a DISTINCT) derives a genuine key.
	for (const k of deriveKeysFromFds(fds, columnCount, type.isSet)) {
		keys.push(k);
	}

	const normalized = normalizeKeys(keys);

	// 4. All-columns fallback, gated on set-ness. Only when nothing smaller was
	// found — a set always has the all-columns key, but it is the weakest one.
	if (normalized.length === 0 && type.isSet && columnCount > 0) {
		return [allColumns(columnCount)];
	}

	return normalized;
}

/**
 * True iff `cols` is a superkey of `rel` — i.e., the relation has at most one
 * row per distinct `cols` tuple. The soundness-critical uniqueness predicate.
 *
 * Returns true iff any of:
 *   - `cols` is a (non-strict) superset of some `keysOf(rel)` entry (covers
 *     declared keys, the ≤1-row empty key, FD-derived keys, and the
 *     all-columns/set key), OR
 *   - `cols` is a provably row-unique determinant (`isUniqueDeterminant`:
 *     closure coverage AND uniqueness reachability) — this proves a superkey
 *     even when it is absent from the minimal `keysOf` list.
 *
 * No all-columns guard is needed on the closure branch: an all-columns probe
 * on a bag fails `isUniqueDeterminant` on its own (no unique FD ⇒ false; if a
 * unique FD exists the relation cannot hold duplicate rows, so true is
 * correct).
 */
export function isUnique(cols: readonly number[], rel: KeyRel): boolean {
	const type = rel.getType();
	const columnCount = type.columns.length;
	const colSet = new Set(cols);

	for (const key of keysOf(rel)) {
		if (key.every(c => colSet.has(c))) return true;
	}

	return isUniqueDeterminant(colSet, rel.physical?.fds, columnCount, type.isSet);
}

/**
 * The single named spelling of the node-level "at-most-one-row" predicate:
 * true iff `rel` is provably ≤1-row. Defined as `isUnique([], rel)` — the empty
 * key is a subset of every column set, so a relation carrying it (via a declared
 * empty key, the `∅ → all_cols` singleton FD, or any other channel `keysOf`
 * reconciles) reports unique on the empty column list.
 *
 * Use this at node / rule level. The FD-only `hasSingletonFd` is the lower-level
 * test `keysOf` itself calls; `isAtMostOneRow` is the surface consumers (joins,
 * sort elimination) should reach for. Note it does **not** capture the
 * zero-column `estimatedRows === 1` case — a zero-column relation has no
 * representable empty key — so consumers needing that fallback keep their own
 * check (see `characteristics.guaranteesUniqueRows`).
 */
export function isAtMostOneRow(rel: KeyRel): boolean {
	return isUnique([], rel);
}

/**
 * Re-export so callers can import the binding shape from this module
 * alongside the helpers (avoids reaching into `plan-node.js` for types
 * that are conceptually part of the FD/EC layer).
 */
export type { ConstantBinding, ConstantValue };

/**
 * Extracted FD/EC/binding contributions from an equality-shaped predicate.
 *
 * - `fds`: FDs of the form `∅ → col` (column constant under the predicate)
 *   or `col1 → col2` / `col2 → col1` (mutual determination from `col1 = col2`).
 * - `equivPairs`: `[col1, col2]` pairs to be merged into the EC list.
 * - `constantBindings`: per-column constant bindings (one per `col = const`
 *   or `col = ?` conjunct). The caller is responsible for closing these
 *   over the resulting EC list.
 */
export interface EqualityFds {
	readonly fds: ReadonlyArray<FunctionalDependency>;
	readonly equivPairs: ReadonlyArray<readonly [number, number]>;
	readonly constantBindings: ReadonlyArray<ConstantBinding>;
}

/**
 * Walk `predicate` (assumed to be a normalized conjunction) and extract FDs,
 * equivalence-class contributions, and constant bindings from equality
 * conjuncts.
 *
 * `attrIdToIndex` maps an attribute ID to its column index in the predicate's
 * relation. Equality conjuncts referencing attributes outside this map
 * (correlated subqueries, etc.) are silently ignored.
 *
 * Recognized shapes (per AND-conjunct):
 *   - `col = literal`  ⇒ FD `∅ → col`  +  binding `{col} → literal value`.
 *   - `col = ?`        ⇒ FD `∅ → col`  +  binding `{col} → parameter ref`.
 *   - `col1 = col2`    ⇒ FDs `{col1} → {col2}` and `{col2} → {col1}` plus an
 *     equivalence pair `[col1, col2]`.
 *
 * Non-equality conjuncts contribute nothing.
 *
 * **Collation gate (all shapes).** Every extracted fact is a VALUE-level claim
 * (a pinned column has one value across rows; `col1 = col2` rows are
 * value-equal), so a conjunct only contributes when its comparison is
 * value-discriminating (`isValueDiscriminatingEquality`): for textual operands
 * the effective comparison collation must be BINARY. A NOCASE/RTRIM comparison —
 * via a `COLLATE` wrapper on either side or a non-BINARY declared column
 * collation — passes value-DIFFERENT rows ('Bob' = 'bob' NOCASE), so its facts
 * would over-claim (false ≤1-row keys, false EC-driven inferences, wrong insert
 * defaults — ticket `collation-blind-equality-fact-extraction`). Declared-
 * collation covered-key ≤1-row detection is NOT lost: it flows through the
 * independent (and collation-sound) `extractConstraints` path in
 * `FilterNode.computePhysical`.
 *
 * **Semantic-ordering gate (`col1 = col2` ONLY).** A few logical types compare
 * by meaning rather than by stored text (`timespan`: 'PT1H' = 'PT60M'; `json`:
 * '{"a":1}' = '{ "a" : 1 }'). For a MIXED pair — `d timespan = s text` — the
 * mirror FDs and the equivalence class are both FALSE: two surviving rows can
 * agree on `d` (same elapsed time) while disagreeing on `s` (distinct strings),
 * because the two columns have no common notion of "same value". So the col=col
 * arm additionally requires `semanticOrderingsAgree` on the two declared logical
 * types, mirroring the two join-side extractors that mint the same kind of fact
 * (`extractEquiPairsFromCondition` in `nodes/join-node.ts`, `extractEquiPairs`
 * in `rules/join/equi-pair-extractor.ts`). Same-type pairs (`timespan =
 * timespan`) stay admitted — under the type's own identity both facts hold.
 * Invariant OPT-051; ticket `debt-filter-equality-facts-ignore-semantic-ordering`.
 *
 * **The constant-pin arms are deliberately NOT semantic-ordering-gated.** This is
 * intentional, not an oversight. `where d = 'PT60M'` keeps every row whose `d` is
 * one hour whatever text it stores, and under the engine's identity for a
 * `timespan` column — the same identity `distinct`/`group by`/`unique` use —
 * those rows all hold *the same value*, so `∅ → d` is true. The
 * `ConstantBinding` claim is likewise true as defined (see its declaration in
 * `nodes/plan-node.ts`): the column *compares equal to* the bound value under its
 * own comparison. Gating this arm would decline EVERY constant pin on a
 * `timespan`/`json` column (a literal never declares a semantic-ordering type),
 * losing real optimizations to "fix" a claim that is not wrong.
 */
export function extractEqualityFds(
	predicate: ScalarPlanNode,
	attrIdToIndex: ReadonlyMap<number, number>,
): EqualityFds {
	const fds: FunctionalDependency[] = [];
	const equivPairs: Array<readonly [number, number]> = [];
	const constantBindings: ConstantBinding[] = [];

	const stack: ScalarPlanNode[] = [predicate];
	while (stack.length > 0) {
		const n = stack.pop()!;
		if (!(n instanceof BinaryOpNode)) continue;
		const op = n.expression.operator;
		if (op === 'AND') {
			stack.push(n.left, n.right);
			continue;
		}
		if (op !== '=') continue;
		// Value-level facts only from value-discriminating comparisons (see doc).
		if (!isValueDiscriminatingEquality(n.left, n.right)) continue;

		const lIsCol = n.left instanceof ColumnReferenceNode;
		const rIsCol = n.right instanceof ColumnReferenceNode;
		const lConst = constantValueOf(n.left);
		const rConst = constantValueOf(n.right);

		if (lIsCol && rIsCol) {
			// Semantic-ordering gate — cross-COLUMN facts only (see doc). A mixed
			// pair has no shared notion of "same value", so neither the mirror FDs
			// nor the equivalence class hold. Symmetric, so operand order is moot.
			if (!semanticOrderingsAgree(n.left.getType().logicalType, n.right.getType().logicalType)) continue;
			const lIdx = attrIdToIndex.get((n.left as ColumnReferenceNode).attributeId);
			const rIdx = attrIdToIndex.get((n.right as ColumnReferenceNode).attributeId);
			if (lIdx !== undefined && rIdx !== undefined && lIdx !== rIdx) {
				// Mirror FDs from `col1 = col2` are pure value claims — equality
				// never makes either endpoint row-unique.
				fds.push({ determinants: [lIdx], dependents: [rIdx], kind: 'determination' });
				fds.push({ determinants: [rIdx], dependents: [lIdx], kind: 'determination' });
				equivPairs.push([lIdx, rIdx]);
			}
			continue;
		}

		if (lIsCol && rConst !== undefined) {
			const lIdx = attrIdToIndex.get((n.left as ColumnReferenceNode).attributeId);
			if (lIdx !== undefined) {
				// `∅ → col` from a constant pin is deliberately 'determination': a
				// pinned column does NOT imply the relation has at most one row.
				fds.push({ determinants: [], dependents: [lIdx], kind: 'determination' });
				constantBindings.push({ attrs: [lIdx], value: rConst });
			}
			continue;
		}

		if (rIsCol && lConst !== undefined) {
			const rIdx = attrIdToIndex.get((n.right as ColumnReferenceNode).attributeId);
			if (rIdx !== undefined) {
				fds.push({ determinants: [], dependents: [rIdx], kind: 'determination' });
				constantBindings.push({ attrs: [rIdx], value: lConst });
			}
			continue;
		}
	}

	return { fds, equivPairs, constantBindings };
}

// ---------------------------------------------------------------------------
// Guard implication checking
// ---------------------------------------------------------------------------

/**
 * Conjuncts pulled from a predicate, indexed for fast guard-clause matching.
 * Built once per Filter and reused across every guarded FD on the source.
 */
interface PredicateFacts {
	/** column index → literal value seen in `col = literal`. */
	readonly literalEqs: ReadonlyMap<number, SqlValue>;
	/** column index → set of column indices it's directly equated to. */
	readonly columnEqs: ReadonlyMap<number, ReadonlySet<number>>;
	/** column indices known to be NULL via `col IS NULL`. */
	readonly isNullCols: ReadonlySet<number>;
	/** column indices known to be NOT NULL via `col IS NOT NULL`. */
	readonly isNotNullCols: ReadonlySet<number>;
	/**
	 * column index → set of literal values from `col IN (lit, lit, …)`.
	 * Only populated for literal-only IN-lists (no subqueries, no parameters,
	 * no function calls). Used to discharge `or-of [eq-literal …]` guards.
	 */
	readonly inListEqs: ReadonlyMap<number, ReadonlySet<SqlValue>>;
	/**
	 * column index → intersected range over every literal-bounded `<`/`<=`/
	 * `>`/`>=` conjunct (and column-vs-literal-vs-literal BETWEEN) observed in
	 * the filter. The strongest bounds win on intersection: on equal values the
	 * exclusive flag is preferred. Used to discharge `range` guards.
	 */
	readonly rangeBounds: ReadonlyMap<number, FilterRange>;
}

/**
 * Mutable per-column range fact accumulated during `buildPredicateFacts`. At
 * least one bound side is defined; inclusivity for absent sides is unused.
 */
interface FilterRange {
	min?: SqlValue;
	max?: SqlValue;
	minInclusive: boolean;
	maxInclusive: boolean;
}

/**
 * Collect per-column facts from a filter predicate for guard discharge.
 *
 * **Collation gate (per conjunct).** A fact may only discharge a guard when
 * the filter's runtime comparison keeps filter-rows ⊆ guard-scope-rows. The
 * guard predicate is evaluated under the column's *declared* collation at
 * enforcement time — index maintenance for partial-UNIQUE guards, write-time
 * CHECK evaluation for implication-form CHECK guards (constraint-builder
 * threads declared collations into the CHECK scope types) — and guard
 * recognition (`partial-unique-extraction.ts`, `check-extraction.ts`) only
 * accepts bare column/literal AST shapes, so guard comparisons resolve to the
 * declared collation. Hence:
 *
 *  - `col = lit` / singleton-IN facts: sound when the conjunct's effective
 *    comparison collation is BINARY (value-equality implies equality under any
 *    collation) OR equals the column's declared collation (same comparison the
 *    guard scope uses; the strict `sqlValueEquals` literal match at discharge
 *    then under-claims at worst). The previous code stripped `CollateNode`
 *    from the literal side unconditionally, so `b = 'bob' collate nocase`
 *    discharged a BINARY `eq-literal{b,'bob'}` guard while admitting rows
 *    outside the partial-index scope (ticket
 *    `collation-blind-equality-fact-extraction`, repro 4).
 *  - `col1 = col2` facts: sound when both columns' contributed collations are
 *    equal — then any operand-resolution order (filter conjunct or guard
 *    spelling) lands on the same collation.
 *  - range facts over TEXT bounds: the discharge subset check
 *    (`filterRangeSubsetOfGuardRange`) compares bounds under BINARY, so the
 *    filter's effective collation AND the column's declared collation must
 *    both be BINARY (a BINARY bound comparison does not bound a NOCASE-ordered
 *    row set). Non-text bounds are collation-inert and stay ungated. This is
 *    deliberately stricter than the equality gate — a completeness loss for
 *    collated text ranges, never a soundness one.
 *  - plain `col IN (lits)`: the runtime (`emitIn`) compares under the
 *    condition operand's collation, which for the only recognized shape (a
 *    bare column) IS the declared collation; listed values' COLLATE wrappers
 *    are inert. Gated uniformly anyway for future-proofing.
 */
function buildPredicateFacts(
	predicate: ScalarPlanNode,
	attrIdToIndex: ReadonlyMap<number, number>,
	isColumnNumeric: (col: number) => boolean,
	declaredCollationOf: (col: number) => string,
): PredicateFacts {
	const literalEqs = new Map<number, SqlValue>();
	const columnEqs = new Map<number, Set<number>>();
	const isNullCols = new Set<number>();
	const isNotNullCols = new Set<number>();
	const inListEqs = new Map<number, Set<SqlValue>>();
	const rangeBounds = new Map<number, FilterRange>();

	const addColumnEq = (a: number, b: number): void => {
		if (a === b) return;
		let aSet = columnEqs.get(a);
		if (!aSet) { aSet = new Set<number>(); columnEqs.set(a, aSet); }
		aSet.add(b);
		let bSet = columnEqs.get(b);
		if (!bSet) { bSet = new Set<number>(); columnEqs.set(b, bSet); }
		bSet.add(a);
	};

	const columnIndexOf = (n: ScalarPlanNode): number | undefined => {
		if (n instanceof ColumnReferenceNode) {
			return attrIdToIndex.get(n.attributeId);
		}
		return undefined;
	};

	// Equality-fact gate: BINARY, or matching the column's declared collation
	// (the collation guard scopes are evaluated under). See the function doc.
	const equalityCollationOk = (col: number, effColl: string): boolean =>
		effColl === 'BINARY' || effColl === normalizeCollationName(declaredCollationOf(col));

	// Range-fact gate for TEXT bounds: the discharge subset check is BINARY, so
	// both the filter comparison and the guard-scope (declared) collation must be.
	const rangeCollationOk = (col: number, effColl: string, bound: SqlValue): boolean =>
		typeof bound !== 'string'
		|| (effColl === 'BINARY' && normalizeCollationName(declaredCollationOf(col)) === 'BINARY');

	const tightenLowerBound = (col: number, value: SqlValue, inclusive: boolean): void => {
		const cur = rangeBounds.get(col);
		if (!cur) {
			rangeBounds.set(col, { min: value, minInclusive: inclusive, maxInclusive: false });
			return;
		}
		if (cur.min === undefined) {
			cur.min = value;
			cur.minInclusive = inclusive;
			return;
		}
		const cmp = compareSqlValues(value, cur.min);
		if (cmp > 0) {
			cur.min = value;
			cur.minInclusive = inclusive;
		} else if (cmp === 0 && cur.minInclusive && !inclusive) {
			// Tighten: same value, but new bound is exclusive (excludes the boundary).
			cur.minInclusive = false;
		}
	};

	const tightenUpperBound = (col: number, value: SqlValue, inclusive: boolean): void => {
		const cur = rangeBounds.get(col);
		if (!cur) {
			rangeBounds.set(col, { max: value, maxInclusive: inclusive, minInclusive: false });
			return;
		}
		if (cur.max === undefined) {
			cur.max = value;
			cur.maxInclusive = inclusive;
			return;
		}
		const cmp = compareSqlValues(value, cur.max);
		if (cmp < 0) {
			cur.max = value;
			cur.maxInclusive = inclusive;
		} else if (cmp === 0 && cur.maxInclusive && !inclusive) {
			cur.maxInclusive = false;
		}
	};

	const recordComparison = (col: number, op: string, lit: SqlValue): void => {
		switch (op) {
			case '>':
				tightenLowerBound(col, lit, false);
				return;
			case '>=':
				tightenLowerBound(col, lit, true);
				return;
			case '<':
				tightenUpperBound(col, lit, false);
				return;
			case '<=':
				tightenUpperBound(col, lit, true);
				return;
		}
	};

	const stack: ScalarPlanNode[] = [predicate];
	while (stack.length > 0) {
		const n = stack.pop()!;
		if (n instanceof BinaryOpNode) {
			const op = n.expression.operator;
			if (op === 'AND') {
				stack.push(n.left, n.right);
				continue;
			}
			if (op === '=' || op === '==') {
				const lIdx = columnIndexOf(n.left);
				const rIdx = columnIndexOf(n.right);
				if (lIdx !== undefined && rIdx !== undefined) {
					// Both sides are bare column refs; require their contributed
					// collations to agree so any resolution order matches the guard's.
					// NOTE: deliberately NOT semantic-ordering-gated, unlike the
					// cross-column arm of `extractEqualityFds` (invariant OPT-051).
					// A `columnEqs` fact only ever discharges an `eq-column` guard
					// clause, which is the SAME comparison re-evaluated under the same
					// declared types at enforcement time — so filter-rows and
					// guard-scope-rows coincide whether or not semantic ordering is in
					// play. Adding the gate here for symmetry would be a pure
					// completeness loss. Do not "fix".
					if (operandCollation(n.left) === operandCollation(n.right)) {
						addColumnEq(lIdx, rIdx);
					}
					continue;
				}
				const effColl = effectiveComparisonCollation(n.left, n.right);
				if (lIdx !== undefined) {
					const lit = literalSqlValueOf(n.right);
					if (lit !== undefined && equalityCollationOk(lIdx, effColl)) literalEqs.set(lIdx, lit);
					continue;
				}
				if (rIdx !== undefined) {
					const lit = literalSqlValueOf(n.left);
					if (lit !== undefined && equalityCollationOk(rIdx, effColl)) literalEqs.set(rIdx, lit);
				}
				continue;
			}
			// IS / IS NOT may be written as binary with literal NULL on the right.
			if (op === 'IS' || op === 'IS NOT') {
				const lIdx = columnIndexOf(n.left);
				if (lIdx === undefined) continue;
				const lit = literalSqlValueOf(n.right);
				if (lit !== null) continue;
				if (op === 'IS') isNullCols.add(lIdx);
				else isNotNullCols.add(lIdx);
				continue;
			}
			if (op === '<' || op === '<=' || op === '>' || op === '>=') {
				const lIdx = columnIndexOf(n.left);
				const rIdx = columnIndexOf(n.right);
				const effColl = effectiveComparisonCollation(n.left, n.right);
				if (lIdx !== undefined && rIdx === undefined) {
					const lit = literalSqlValueOf(n.right);
					if (lit === undefined || lit === null) continue;
					if (!rangeCollationOk(lIdx, effColl, lit)) continue;
					recordComparison(lIdx, op, lit);
				} else if (rIdx !== undefined && lIdx === undefined) {
					const lit = literalSqlValueOf(n.left);
					if (lit === undefined || lit === null) continue;
					if (!rangeCollationOk(rIdx, effColl, lit)) continue;
					recordComparison(rIdx, flipComparison(op), lit);
				}
				continue;
			}
			continue;
		}
		if (n instanceof BetweenNode) {
			if (n.expression.not === true) continue;
			const cIdx = columnIndexOf(n.expr);
			if (cIdx === undefined) continue;
			const lo = literalSqlValueOf(n.lower);
			const hi = literalSqlValueOf(n.upper);
			// Per-bound effective collation (emitBetween: bound wins over expr).
			if (lo !== undefined && lo !== null
				&& rangeCollationOk(cIdx, effectiveBetweenBoundCollation(n.expr, n.lower), lo)) {
				tightenLowerBound(cIdx, lo, true);
			}
			if (hi !== undefined && hi !== null
				&& rangeCollationOk(cIdx, effectiveBetweenBoundCollation(n.expr, n.upper), hi)) {
				tightenUpperBound(cIdx, hi, true);
			}
			continue;
		}
		if (n instanceof UnaryOpNode) {
			const op = n.expression.operator;
			const cIdx = columnIndexOf(n.operand);
			if (cIdx === undefined) continue;
			if (op === 'IS NULL') isNullCols.add(cIdx);
			else if (op === 'IS NOT NULL') isNotNullCols.add(cIdx);
			// `WHERE NOT col` excludes both NULL and zero rows. Pin `col = 0` so
			// it discharges partial-UC guards rewritten the same way at production.
			// Numeric-only: for TEXT/BLOB/BOOLEAN columns `col = 0` (strict
			// `sqlValueEquals`) is not equivalent to `NOT col` (TEXT `''` and
			// boolean `false` are falsy but compare unequal to integer 0), so the
			// rewrite would falsely discharge a `col = 0` guard for rows the
			// runtime filter actually keeps. `IS NOT NULL` is still recorded —
			// that's sound regardless of type.
			else if (op === 'NOT') {
				if (isColumnNumeric(cIdx)) literalEqs.set(cIdx, 0);
				isNotNullCols.add(cIdx);
			}
			continue;
		}
		if (n instanceof InNode) {
			// Literal-only IN-list with a column-reference condition: capture
			// the OR-set so `or-of [eq-literal …]` guards can discharge.
			if (n.source !== undefined) continue;
			if (!n.values || n.values.length === 0) continue;
			const cIdx = columnIndexOf(n.condition);
			if (cIdx === undefined) continue;
			// emitIn resolves ONE collation through the provenance lattice over the
			// condition AND the listed values — a collate-wrapped element (folded
			// to a literal whose type carries rank-3 NOCASE) can outrank the bare
			// column recognized here, so this gate is load-bearing.
			if (!equalityCollationOk(cIdx, effectiveInCollation(n))) continue;
			const set = new Set<SqlValue>();
			let allLiterals = true;
			for (const v of n.values) {
				const lit = literalSqlValueOf(v);
				if (lit === undefined) { allLiterals = false; break; }
				set.add(lit);
			}
			if (!allLiterals) continue;
			// If a previous IN on the same column was captured, intersect to keep
			// the strongest set (`col IN (a,b) AND col IN (b,c)` ⇒ {b}).
			const prev = inListEqs.get(cIdx);
			if (prev) {
				const intersected = new Set<SqlValue>();
				for (const x of set) {
					for (const y of prev) {
						if (sqlValueEquals(x, y)) intersected.add(x);
					}
				}
				inListEqs.set(cIdx, intersected);
			} else {
				inListEqs.set(cIdx, set);
			}
			// A singleton IN also pins the literal.
			if (set.size === 1) {
				const only = set.values().next().value as SqlValue;
				literalEqs.set(cIdx, only);
			}
		}
	}

	return { literalEqs, columnEqs, isNullCols, isNotNullCols, inListEqs, rangeBounds };
}

function literalSqlValueOf(n: ScalarPlanNode): SqlValue | undefined {
	let cur: ScalarPlanNode = n;
	while (cur instanceof CastNode || cur instanceof CollateNode) {
		cur = cur.operand;
	}
	if (cur instanceof LiteralNode) {
		return literalValue(cur.expression);
	}
	return undefined;
}

function ecIndexOf(
	col: number,
	ecs: ReadonlyArray<ReadonlyArray<number>>,
): number | undefined {
	for (let i = 0; i < ecs.length; i++) {
		if (ecs[i].includes(col)) return i;
	}
	return undefined;
}

function bindingForColumn(
	col: number,
	bindings: ReadonlyArray<ConstantBinding>,
): ConstantBinding | undefined {
	for (const b of bindings) if (b.attrs.includes(col)) return b;
	return undefined;
}

/**
 * Decide whether the surrounding `predicate` (combined with the source's ECs
 * and constant bindings) entails every clause in `guard`. Conservative — when
 * in doubt, returns `false`.
 *
 * `isColumnNonNullable(col)` reports whether the source's output column is
 * declared NOT NULL; the helper uses it to discharge `is-null negated:true`
 * guards from type information alone.
 *
 * `isColumnNumeric(col)` reports whether the source's output column has a
 * numeric logical type. Used to gate the `NOT col → col = 0` rewrite: only
 * sound for numeric columns since the consumer matches `eq-literal{col, 0}`
 * via strict `sqlValueEquals`, which treats TEXT `''`, BLOB, and boolean
 * `false` as unequal to integer 0.
 *
 * `declaredCollationOf(col)` reports the source's output column collation
 * (normalized or not; `'BINARY'` when undeclared). Used by the per-conjunct
 * collation gate in `buildPredicateFacts` — see its doc.
 */
export function predicateImpliesGuard(
	predicate: ScalarPlanNode,
	guard: GuardPredicate,
	ecs: ReadonlyArray<ReadonlyArray<number>>,
	bindings: ReadonlyArray<ConstantBinding>,
	attrIdToIndex: ReadonlyMap<number, number>,
	isColumnNonNullable: (col: number) => boolean,
	isColumnNumeric: (col: number) => boolean,
	declaredCollationOf: (col: number) => string,
): boolean {
	const facts = buildPredicateFacts(predicate, attrIdToIndex, isColumnNumeric, declaredCollationOf);

	for (const clause of guard.clauses) {
		if (!clauseEntailed(clause, facts, ecs, bindings, isColumnNonNullable)) {
			return false;
		}
	}
	return true;
}

function clauseEntailed(
	clause: GuardClause,
	facts: PredicateFacts,
	ecs: ReadonlyArray<ReadonlyArray<number>>,
	bindings: ReadonlyArray<ConstantBinding>,
	isColumnNonNullable: (col: number) => boolean,
): boolean {
	switch (clause.kind) {
		case 'eq-literal': {
			const { column, value } = clause;
			// Direct conjunct match.
			const direct = facts.literalEqs.get(column);
			if (direct !== undefined && sqlValueEquals(direct, value)) return true;
			// Via EC: any column in `column`'s EC pinned to the literal.
			const ecIdx = ecIndexOf(column, ecs);
			if (ecIdx !== undefined) {
				for (const peer of ecs[ecIdx]) {
					const peerLit = facts.literalEqs.get(peer);
					if (peerLit !== undefined && sqlValueEquals(peerLit, value)) return true;
				}
			}
			// Via binding: source already pins `column` to the same literal.
			const binding = bindingForColumn(column, bindings);
			if (binding && binding.value.kind === 'literal' && sqlValueEquals(binding.value.value, value)) {
				return true;
			}
			return false;
		}
		case 'eq-column': {
			const { left, right } = clause;
			if (left === right) return true;
			// Same EC.
			const li = ecIndexOf(left, ecs);
			const ri = ecIndexOf(right, ecs);
			if (li !== undefined && li === ri) return true;
			// Direct conjunct match.
			const leftPeers = facts.columnEqs.get(left);
			if (leftPeers && leftPeers.has(right)) return true;
			// Bound to the same ConstantValue (literal or parameter) on both sides.
			const lBind = bindingForColumn(left, bindings);
			const rBind = bindingForColumn(right, bindings);
			if (lBind && rBind && constantValueEquals(lBind.value, rBind.value)) return true;
			return false;
		}
		case 'is-null': {
			const { column, negated } = clause;
			if (negated) {
				// "col IS NOT NULL" guard.
				if (facts.isNotNullCols.has(column)) return true;
				if (isColumnNonNullable(column)) return true;
				return false;
			}
			// "col IS NULL" guard.
			return facts.isNullCols.has(column);
		}
		case 'range': {
			// Try the guard column and every EC peer / binding-shared column —
			// any of them carrying a subset range discharges the guard.
			const cands = candidateColumns(clause.column, ecs, bindings);
			for (const c of cands) {
				const filter = facts.rangeBounds.get(c);
				if (filter && filterRangeSubsetOfGuardRange(filter, clause)) return true;
			}
			return false;
		}
		case 'or-of': {
			// (a) Any sub-clause directly entailed by facts ⇒ OR entailed.
			for (const sub of clause.clauses) {
				if (clauseEntailed(sub, facts, ecs, bindings, isColumnNonNullable)) return true;
			}
			// (b) Pure-IN specialization: every sub-clause is eq-literal on the
			//     same column. Entailed when the filter pins that column to a
			//     subset of the OR-set.
			return inListEntailed(clause, facts, ecs, bindings);
		}
	}
}

/**
 * Specialized discharge for `or-of` clauses whose sub-clauses are all
 * `eq-literal` on the same column (the IN-list shape). Entailed when the
 * filter pins that column — via direct literal, IN-list, EC peer, or constant
 * binding — to a subset of the OR-set. Returns false for any other `or-of`
 * shape.
 */
function inListEntailed(
	clause: GuardClause & { kind: 'or-of' },
	facts: PredicateFacts,
	ecs: ReadonlyArray<ReadonlyArray<number>>,
	bindings: ReadonlyArray<ConstantBinding>,
): boolean {
	if (clause.clauses.length === 0) return false;
	let column: number | undefined;
	const orSet: SqlValue[] = [];
	for (const sub of clause.clauses) {
		if (sub.kind !== 'eq-literal') return false;
		if (column === undefined) column = sub.column;
		else if (column !== sub.column) return false;
		orSet.push(sub.value);
	}
	if (column === undefined) return false;

	const inOrSet = (v: SqlValue): boolean => {
		for (const x of orSet) if (sqlValueEquals(x, v)) return true;
		return false;
	};

	// Try the column itself and every EC peer plus columns bound to the same
	// ConstantValue (those are pinned to the same literal).
	const cands = candidateColumns(column, ecs, bindings);

	for (const c of cands) {
		const direct = facts.literalEqs.get(c);
		if (direct !== undefined && inOrSet(direct)) return true;

		const inList = facts.inListEqs.get(c);
		if (inList !== undefined && inList.size > 0) {
			let allIn = true;
			for (const v of inList) {
				if (!inOrSet(v)) { allIn = false; break; }
			}
			if (allIn) return true;
		}

		// Source binding pins this candidate to a literal in the OR-set.
		const binding = bindingForColumn(c, bindings);
		if (binding && binding.value.kind === 'literal' && inOrSet(binding.value.value)) {
			return true;
		}
	}
	return false;
}

/**
 * True iff every value satisfying `filter` also satisfies `guard`. Per-side
 * check: a guard side with no bound is trivially satisfied; otherwise the
 * filter must have a matching bound that is strictly tighter, or equal-and-
 * compatible on inclusivity. BINARY collation for text comparison — consistent
 * with how DomainConstraint range subsumption is handled today.
 */
function filterRangeSubsetOfGuardRange(
	filter: FilterRange,
	guard: GuardClause & { kind: 'range' },
): boolean {
	if (guard.min !== undefined) {
		if (filter.min === undefined) return false;
		const cmp = compareSqlValues(filter.min, guard.min);
		if (cmp < 0) return false;
		if (cmp === 0 && filter.minInclusive && !guard.minInclusive) return false;
	}
	if (guard.max !== undefined) {
		if (filter.max === undefined) return false;
		const cmp = compareSqlValues(filter.max, guard.max);
		if (cmp > 0) return false;
		if (cmp === 0 && filter.maxInclusive && !guard.maxInclusive) return false;
	}
	return true;
}

function candidateColumns(
	column: number,
	ecs: ReadonlyArray<ReadonlyArray<number>>,
	bindings: ReadonlyArray<ConstantBinding>,
): number[] {
	const out = new Set<number>();
	out.add(column);
	const ecIdx = ecIndexOf(column, ecs);
	if (ecIdx !== undefined) {
		for (const c of ecs[ecIdx]) out.add(c);
	}
	// Columns sharing a ConstantBinding with `column` are also pinned to the
	// same value.
	const ownBinding = bindingForColumn(column, bindings);
	if (ownBinding) {
		for (const c of ownBinding.attrs) out.add(c);
	}
	return Array.from(out);
}

/**
 * If `n` is "constant" relative to the filter's input stream — true for one
 * full execution — return its `ConstantValue`; otherwise undefined.
 *
 * `LiteralNode` is constant at all times. `ParameterReferenceNode` is
 * constant for the duration of a single execution: the parameter is bound
 * once before iteration and the same value is observed by every row. That
 * matches the scope `computePhysical` describes (per-execution properties),
 * so the EC layer treats parameters and literals uniformly. Subqueries /
 * correlated expressions remain rejected — they can vary per-row.
 *
 * `CastNode` and `CollateNode` are peeled through: they don't change row-wise
 * behaviour (constant-after-cast is still constant). For a literal under a
 * cast the inner `SqlValue` is reported as-is — downstream consumers needing
 * the post-cast value must apply the cast themselves.
 */
function constantValueOf(n: ScalarPlanNode): ConstantValue | undefined {
	while (n instanceof CastNode || n instanceof CollateNode) {
		n = n.operand;
	}
	if (n instanceof LiteralNode) {
		const v = literalValue(n.expression);
		if (v === undefined) return undefined;
		return { kind: 'literal', value: v };
	}
	if (n instanceof ParameterReferenceNode) {
		return { kind: 'parameter', paramRef: n.nameOrIndex };
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// ConstantBinding helpers
// ---------------------------------------------------------------------------

// Structural value-equality used by `mergeConstantBindings` to coalesce
// bindings on identical values. ConstantBinding.source is NOT compared at
// merge time — see `fdsEqual` for the dedup-precedence rule.
function constantValueEquals(a: ConstantValue, b: ConstantValue): boolean {
	if (a.kind !== b.kind) return false;
	if (a.kind === 'literal' && b.kind === 'literal') {
		const av = a.value;
		const bv = b.value;
		if (av === bv) return true;
		// Compare bigint/number/string by their textual form; everything else by identity.
		if (av instanceof Uint8Array && bv instanceof Uint8Array) {
			if (av.length !== bv.length) return false;
			for (let i = 0; i < av.length; i++) if (av[i] !== bv[i]) return false;
			return true;
		}
		return false;
	}
	if (a.kind === 'parameter' && b.kind === 'parameter') {
		return a.paramRef === b.paramRef;
	}
	return false;
}

function unionAttrs(a: readonly number[], b: readonly number[]): number[] {
	const out = new Set<number>(a);
	for (const x of b) out.add(x);
	return Array.from(out).sort((x, y) => x - y);
}

function normalizeBinding(b: ConstantBinding): ConstantBinding {
	const attrs = Array.from(new Set(b.attrs)).sort((x, y) => x - y);
	return { attrs, value: b.value };
}

/**
 * Merge two binding lists, coalescing bindings that share a `ConstantValue`
 * by unioning their `attrs`. Caps the result at `MAX_FDS_PER_NODE`; later
 * additions are dropped when the cap is exceeded — bindings sourced from
 * earlier nodes are preferred since they typically sit closer to keyed
 * columns. Truncations are logged under `quereus:planner:fd`.
 */
export function mergeConstantBindings(
	a: ReadonlyArray<ConstantBinding>,
	b: ReadonlyArray<ConstantBinding>,
): ConstantBinding[] {
	const result: ConstantBinding[] = a.map(normalizeBinding);
	for (const raw of b) {
		const next = normalizeBinding(raw);
		let merged = false;
		for (let i = 0; i < result.length; i++) {
			if (constantValueEquals(result[i].value, next.value)) {
				result[i] = { attrs: unionAttrs(result[i].attrs, next.attrs), value: result[i].value };
				merged = true;
				break;
			}
		}
		if (!merged) result.push(next);
	}
	return enforceBindingCap(result);
}

function enforceBindingCap(bindings: ConstantBinding[]): ConstantBinding[] {
	if (bindings.length <= MAX_FDS_PER_NODE) return bindings;
	const kept = bindings.slice(0, MAX_FDS_PER_NODE);
	log('ConstantBinding cap reached: dropped %d binding(s) from %d', bindings.length - kept.length, bindings.length);
	return kept;
}

/**
 * Extend `bindings` over `ecs`: if a binding pins column `c` to value `v` and
 * `c` is in an equivalence class `{c, c2, ...}`, fold every member of that
 * class into the binding's `attrs`. This is what lets predicate-inference
 * rules consume bindings directly without walking ECs.
 */
export function closeConstantBindingsOverEcs(
	bindings: ReadonlyArray<ConstantBinding>,
	ecs: ReadonlyArray<ReadonlyArray<number>>,
): ConstantBinding[] {
	if (bindings.length === 0) return [];
	if (ecs.length === 0) return bindings.map(normalizeBinding);

	const result: ConstantBinding[] = [];
	for (const binding of bindings) {
		const expanded = new Set<number>(binding.attrs);
		let grew = true;
		while (grew) {
			grew = false;
			for (const cls of ecs) {
				const overlap = cls.some(c => expanded.has(c));
				if (!overlap) continue;
				for (const c of cls) {
					if (!expanded.has(c)) {
						expanded.add(c);
						grew = true;
					}
				}
			}
		}
		result.push({ attrs: Array.from(expanded).sort((x, y) => x - y), value: binding.value });
	}

	// Two bindings might now alias to the same value/attrs after closure; coalesce.
	return mergeConstantBindings(result, []);
}

/**
 * Project bindings through `mapping` (oldCol → newCol). A binding whose
 * `attrs` lose every member is dropped; otherwise the surviving members are
 * remapped.
 */
export function projectConstantBindings(
	bindings: ReadonlyArray<ConstantBinding>,
	mapping: ReadonlyMap<number, number>,
): ConstantBinding[] {
	const out: ConstantBinding[] = [];
	for (const binding of bindings) {
		const mapped: number[] = [];
		for (const c of binding.attrs) {
			const m = mapping.get(c);
			if (m !== undefined && !mapped.includes(m)) mapped.push(m);
		}
		if (mapped.length === 0) continue;
		out.push({ attrs: mapped.sort((x, y) => x - y), value: binding.value });
	}
	return mergeConstantBindings(out, []);
}

/** Shift `attrs` by `offset` (column-index translation for joins). */
export function shiftConstantBindings(
	bindings: ReadonlyArray<ConstantBinding>,
	offset: number,
): ConstantBinding[] {
	if (offset === 0) return bindings.map(normalizeBinding);
	return bindings.map(binding => ({
		attrs: binding.attrs.map(c => c + offset).sort((x, y) => x - y),
		value: binding.value,
	}));
}

// ---------------------------------------------------------------------------
// DomainConstraint helpers
// ---------------------------------------------------------------------------

export type { DomainConstraint };

function sqlValueEquals(a: import('../../common/types.js').SqlValue, b: import('../../common/types.js').SqlValue): boolean {
	if (a === b) return true;
	if (a instanceof Uint8Array && b instanceof Uint8Array) {
		if (a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
		return true;
	}
	return false;
}

// Structural-only equality. The optional `source` provenance tag is NOT
// compared — see `fdsEqual` above for the dedup-precedence rule.
function domainConstraintEquals(a: DomainConstraint, b: DomainConstraint): boolean {
	if (a.column !== b.column || a.kind !== b.kind) return false;
	if (a.kind === 'range' && b.kind === 'range') {
		const aHasMin = a.min !== undefined;
		const bHasMin = b.min !== undefined;
		if (aHasMin !== bHasMin) return false;
		if (aHasMin && !sqlValueEquals(a.min!, b.min!)) return false;
		if (aHasMin && a.minInclusive !== b.minInclusive) return false;
		const aHasMax = a.max !== undefined;
		const bHasMax = b.max !== undefined;
		if (aHasMax !== bHasMax) return false;
		if (aHasMax && !sqlValueEquals(a.max!, b.max!)) return false;
		if (aHasMax && a.maxInclusive !== b.maxInclusive) return false;
		return true;
	}
	if (a.kind === 'enum' && b.kind === 'enum') {
		if (a.values.length !== b.values.length) return false;
		for (let i = 0; i < a.values.length; i++) {
			if (!sqlValueEquals(a.values[i], b.values[i])) return false;
		}
		return true;
	}
	return false;
}

/**
 * Concatenate two domain-constraint lists, dropping structurally equal
 * duplicates. We deliberately do NOT intersect overlapping range/enum
 * constraints on the same column — that's deferred to the
 * predicate-contradiction-detection ticket. Caps at `MAX_FDS_PER_NODE`.
 */
export function mergeDomainConstraints(
	a: ReadonlyArray<DomainConstraint>,
	b: ReadonlyArray<DomainConstraint>,
): DomainConstraint[] {
	const result: DomainConstraint[] = a.slice();
	for (const next of b) {
		if (result.some(existing => domainConstraintEquals(existing, next))) continue;
		result.push(next);
	}
	return enforceDomainCap(result);
}

function enforceDomainCap(domains: DomainConstraint[]): DomainConstraint[] {
	if (domains.length <= MAX_FDS_PER_NODE) return domains;
	const kept = domains.slice(0, MAX_FDS_PER_NODE);
	log('DomainConstraint cap reached: dropped %d domain(s) from %d', domains.length - kept.length, domains.length);
	return kept;
}

/**
 * Project domain constraints through `mapping` (oldCol → newCol). Drops any
 * constraint whose column is not in the mapping; remaps the rest.
 */
export function projectDomainConstraints(
	domains: ReadonlyArray<DomainConstraint>,
	mapping: ReadonlyMap<number, number>,
): DomainConstraint[] {
	const out: DomainConstraint[] = [];
	for (const domain of domains) {
		const mapped = mapping.get(domain.column);
		if (mapped === undefined) continue;
		out.push({ ...domain, column: mapped });
	}
	return mergeDomainConstraints(out, []);
}

/** Shift every domain constraint's `column` by `offset` (join translation). */
export function shiftDomainConstraints(
	domains: ReadonlyArray<DomainConstraint>,
	offset: number,
): DomainConstraint[] {
	if (offset === 0) return domains.slice();
	return domains.map(domain => ({ ...domain, column: domain.column + offset }));
}

// ---------------------------------------------------------------------------
// InclusionDependency helpers
// ---------------------------------------------------------------------------

export type { InclusionDependency, IndTarget };

/**
 * Per-node cap on the number of INDs we materialize, mirroring
 * `MAX_FDS_PER_NODE`. A safety valve for pathological plans; truncations are
 * logged under the `quereus:planner:fd` logger like the FD/binding/domain caps.
 */
export const MAX_INDS_PER_NODE = 64;

function sameOrderedList(a: readonly number[], b: readonly number[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

function indTargetsEqual(a: IndTarget, b: IndTarget): boolean {
	if (a.kind !== b.kind) return false;
	if (a.kind === 'table' && b.kind === 'table') {
		return a.schema === b.schema && a.table === b.table && sameOrderedList(a.targetCols, b.targetCols);
	}
	if (a.kind === 'relation' && b.kind === 'relation') {
		return a.relationId === b.relationId && sameOrderedList(a.targetCols, b.targetCols);
	}
	return false;
}

/**
 * Structural equality for IND dedup. `cols` and `target.targetCols` are
 * compared as *ordered* lists — the positional pairing between them is
 * load-bearing (`cols[i]` is the child column matched to `targetCols[i]`), so a
 * reordering is a different fact and must not collapse. Stricter than
 * `fdsEqual`'s set comparison; over-keeping a reordered twin is harmless
 * (redundancy, capped), whereas collapsing distinct facts would lose an IND.
 */
function indsEqual(a: InclusionDependency, b: InclusionDependency): boolean {
	return a.nullRejecting === b.nullRejecting
		&& sameOrderedList(a.cols, b.cols)
		&& indTargetsEqual(a.target, b.target);
}

export interface AddIndOptions {
	cap?: number;
}

/**
 * Add a single IND, skipping it when a structurally-equal entry (per
 * `indsEqual`) already exists. Enforces the per-node cap; truncations are
 * logged. Mirrors `addFd` minus the determinant-subsumption logic (an IND has
 * no determinant/dependent split to subsume).
 */
export function addInd(
	inds: ReadonlyArray<InclusionDependency>,
	next: InclusionDependency,
	opts: AddIndOptions = {},
): InclusionDependency[] {
	const result = inds.slice();
	if (!result.some(existing => indsEqual(existing, next))) {
		result.push(next);
	}
	return enforceIndCap(result, opts);
}

function enforceIndCap(
	inds: InclusionDependency[],
	opts: AddIndOptions,
): InclusionDependency[] {
	const cap = opts.cap ?? MAX_INDS_PER_NODE;
	if (inds.length <= cap) return inds;
	const kept = inds.slice(0, cap);
	log('IND cap reached: dropped %d IND(s) from %d', inds.length - kept.length, inds.length);
	return kept;
}

/** Merge two IND lists: concat with structural dedup via `addInd`, capped. */
export function mergeInds(
	a: ReadonlyArray<InclusionDependency>,
	b: ReadonlyArray<InclusionDependency>,
	opts: AddIndOptions = {},
): InclusionDependency[] {
	let result: InclusionDependency[] = a.slice();
	for (const ind of b) {
		result = addInd(result, ind, opts);
	}
	return result;
}

/**
 * Project INDs through a column mapping (oldCol → newCol). An IND's `cols` is
 * **all-or-nothing**: drop the IND when ANY of its `cols` loses its mapping (the
 * relation no longer carries the witnessing columns) — there is no partial-
 * dependent survival as in `projectFds`. Survivors have their `cols` remapped to
 * output indices; `target.targetCols` index into the *target* relation, NOT this
 * relation's output, so they are NOT remapped. Result is deduped + capped.
 */
export function projectInds(
	inds: ReadonlyArray<InclusionDependency>,
	mapping: ReadonlyMap<number, number>,
): InclusionDependency[] {
	const out: InclusionDependency[] = [];
	for (const ind of inds) {
		const newCols: number[] = [];
		let miss = false;
		for (const c of ind.cols) {
			const m = mapping.get(c);
			if (m === undefined) { miss = true; break; }
			newCols.push(m);
		}
		if (miss) continue;
		out.push({ cols: newCols, target: ind.target, nullRejecting: ind.nullRejecting });
	}
	return mergeInds([], out);
}

/**
 * Shift each IND's `cols` by `offset` (mirrors `shiftFds` for join column
 * translation). `target.targetCols` are target-relative ⇒ NOT shifted.
 */
export function shiftInds(
	inds: ReadonlyArray<InclusionDependency>,
	offset: number,
): InclusionDependency[] {
	if (offset === 0) return inds.slice();
	return inds.map(ind => ({
		cols: ind.cols.map(c => c + offset),
		target: ind.target,
		nullRejecting: ind.nullRejecting,
	}));
}

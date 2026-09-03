import { isRelationalNode, PlanNode } from './plan-node.js';
import type {
	RelationalPlanNode,
	Attribute,
	PhysicalProperties,
	FunctionalDependency,
	ConstantBinding,
	DomainConstraint,
} from './plan-node.js';
import type { RelationType, ColRef } from '../../common/datatype.js';
import { PlanNodeType } from './plan-node-type.js';
import type { Scope } from '../scopes/scope.js';
import { Cached } from '../../util/cached.js';
import { quereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import {
	closeConstantBindingsOverEcs,
	hasSingletonFd,
	mergeConstantBindings,
	mergeDomainConstraints,
	mergeEquivClasses,
	mergeFds,
	shiftConstantBindings,
	shiftDomainConstraints,
	shiftEquivClasses,
	shiftFds,
} from '../util/fd-utils.js';
import { mergeSetOpAdvertisedType } from '../analysis/set-op-type-merge.js';
import { gatherRowsFrom, physicalSourceRows } from '../util/row-estimates.js';

/**
 * How {@link AsyncGatherNode} combines rows from its N independent child relations.
 *
 * - `unionAll`: yield every row from every branch in arrival order — multiset
 *   union (no dedup). All children must have matching column counts.
 *
 * - `crossProduct`: drain every branch fully, then yield the full Cartesian
 *   product. The output attributes are the concatenation of all children's
 *   attributes. **Materialises every branch in memory before yielding the
 *   first row** — see emitter docs in `runtime/emit/async-gather.ts`.
 *
 * - `zipByKey`: full N-way outer join on the key columns named **per branch** by
 *   `branchKeyAttrs`. For each distinct key value present in any branch, emit
 *   exactly one composed row: the K merged key columns once (carrying the
 *   gather-minted `outputKeyAttrs` ids), then each branch's non-key columns
 *   (NULL when that branch has no row for that key). Implemented as an **eager
 *   hash-merge** over a `BTree` keyed by the key tuple — **drains every branch
 *   in memory before yielding the first row** (see emitter docs). It is *not*
 *   a chained binary full-outer-join lowering.
 *
 *   The gather genuinely **originates** the K merged key columns (their ids,
 *   `outputKeyAttrs`, appear in no child — "branch0's key, or branch1's key, …,
 *   whichever row is present") and **forwards** each branch's non-key ids (each
 *   appears in exactly one child). This is provenance-clean by construction:
 *   no id is output by two branches, so `validatePhysicalTree` passes.
 *
 * The discriminated-union shape is deliberate: future variants (e.g.
 * `mergeOrdered`) will attach per-combinator config without breaking the
 * constructor.
 */
export type AsyncGatherCombinator =
	| { readonly kind: 'unionAll' }
	| { readonly kind: 'crossProduct' }
	| {
		readonly kind: 'zipByKey',
		/**
		 * Per branch b, the attribute IDs of that branch's K key columns, in
		 * key-position order. Distinct per branch (provenance-clean — each branch
		 * originates its own key id). `length === children.length`; every inner
		 * list has the same length K.
		 */
		readonly branchKeyAttrs: readonly (readonly number[])[],
		/**
		 * The K output key attribute IDs the gather mints (originates). One per
		 * key position. Pairwise distinct and disjoint from every child's
		 * attribute IDs. Output key columns sit at index 0..K-1, in this order.
		 */
		readonly outputKeyAttrs: readonly number[],
	};

/**
 * Per-branch column-index mapping for a `zipByKey` gather, resolved from the
 * per-branch {@link AsyncGatherCombinator.branchKeyAttrs} lists against each
 * child's attribute layout. Consumed by the node's type inference and by the
 * runtime emitter (via {@link AsyncGatherNode.getZipByKeyIndices}).
 */
export interface ZipByKeyIndices {
	/** Per branch, the column index of each key attribute, in `branchKeyAttrs[b]` order. */
	readonly branchKeyIndices: readonly (readonly number[])[];
	/** Per branch, the column indices of non-key columns, in declared order. */
	readonly branchNonKeyIndices: readonly (readonly number[])[];
}

/**
 * Physical N-ary relational node that drives ≥ 2 independent (uncorrelated)
 * child relations concurrently via {@link ParallelDriver.drive} and combines
 * their outputs with the configured {@link AsyncGatherCombinator}.
 *
 * Properties:
 *
 * - `unionAll`: ordering is dropped (arrival-order interleave is
 *   non-deterministic); FDs / ECs / constant bindings / domain constraints
 *   are dropped (same conservatism `SetOperationNode.computePhysical` already
 *   applies); attribute IDs mirror `children[0]` to preserve downstream
 *   `ORDER BY` references; `isSet` is `false` (duplicates allowed); per-column
 *   nullability is the OR across children.
 *
 * - `crossProduct`: ordering is dropped; FDs / ECs / bindings / domain
 *   constraints are the pairwise N-ary fold of the children (the same fold
 *   `JoinNode(cross)` does, repeated); attribute IDs are the verbatim
 *   concatenation of children; per-column nullability flows through
 *   unchanged. Cartesian product order is deterministic-but-unspecified
 *   (a function of the per-branch arrival order). **Buffers all branches
 *   before yielding** — not suitable for large branches.
 *
 * `concurrencySafe` and `expectedLatencyMs` are NOT propagated by this node:
 * those fields are not yet defined on {@link PhysicalProperties} (the parallel
 * track has not landed them). Once a successor ticket (5.5 or later) adds
 * them, the intended merge is `AND` across children for `concurrencySafe` and
 * `max` across children for `expectedLatencyMs`; update this node's
 * `computePhysical` at that time. The fields currently inherited from
 * `PlanNode.physical`'s default child-merge are `deterministic`,
 * `idempotent`, and `readonly` (AND across children).
 */
export class AsyncGatherNode extends PlanNode implements RelationalPlanNode {
	override readonly nodeType = PlanNodeType.AsyncGather;
	private attributesCache: Cached<readonly Attribute[]>;
	private zipIndicesCache: Cached<ZipByKeyIndices>;

	constructor(
		scope: Scope,
		public readonly children: readonly RelationalPlanNode[],
		public readonly combinator: AsyncGatherCombinator,
		public readonly concurrencyCap: number,
		public readonly preserveAttributeIds?: readonly Attribute[],
	) {
		AsyncGatherNode.validateConstruction(children, combinator, concurrencyCap);
		// Self-cost only: every child is in getChildren(), so their subtree costs
		// flow in via getTotalCost(). The gather's own overhead is negligible.
		super(scope, 0.01);
		this.attributesCache = new Cached(() => this.buildAttributes());
		this.zipIndicesCache = new Cached(() => this.computeZipByKeyIndices());
	}

	private static validateConstruction(
		children: readonly RelationalPlanNode[],
		combinator: AsyncGatherCombinator,
		concurrencyCap: number,
	): void {
		if (children.length < 2) {
			quereusError(
				`AsyncGatherNode requires >= 2 children, got ${children.length}`,
				StatusCode.INTERNAL,
			);
		}
		if (!Number.isInteger(concurrencyCap) || concurrencyCap < 1) {
			quereusError(
				`AsyncGatherNode concurrencyCap must be a positive integer, got ${concurrencyCap}`,
				StatusCode.INTERNAL,
			);
		}
		if (combinator.kind === 'unionAll') {
			const firstColCount = children[0].getType().columns.length;
			for (let i = 1; i < children.length; i++) {
				const colCount = children[i].getType().columns.length;
				if (colCount !== firstColCount) {
					quereusError(
						`AsyncGatherNode(unionAll) column count mismatch: child 0 has ${firstColCount}, child ${i} has ${colCount}`,
						StatusCode.ERROR,
					);
				}
			}
		} else if (combinator.kind === 'zipByKey') {
			AsyncGatherNode.validateZipByKey(children, combinator.branchKeyAttrs, combinator.outputKeyAttrs);
		}
	}

	/**
	 * Validate a `zipByKey` combinator under the per-branch-refs representation:
	 *
	 * - `branchKeyAttrs` has one list per branch, all of the same non-empty
	 *   length K.
	 * - `outputKeyAttrs` has length K, its ids are pairwise distinct AND disjoint
	 *   from every child attribute id (load-bearing: a collision would let the
	 *   provenance walk treat an output key id as forwarded, breaking the
	 *   origination contract this design relies on).
	 * - each `branchKeyAttrs[b][k]` resolves in branch b.
	 * - per key position, affinity (physical storage class) agrees across all
	 *   branches (the codebase has no distinct affinity field). Nullability may
	 *   differ between branches; it gets OR'd in {@link getType}.
	 * - per key position, the declared collation agrees across all branches. The
	 *   runtime key comparator derives solely from branch 0's key-column
	 *   collations, so a disagreement would let branch 0 win silently and merge
	 *   (or fail to merge) rows under the wrong collation. Guarding it here means
	 *   both the recognition rule and manual construction are protected. An
	 *   absent `collationName` normalizes to the binary collation.
	 */
	private static validateZipByKey(
		children: readonly RelationalPlanNode[],
		branchKeyAttrs: readonly (readonly number[])[],
		outputKeyAttrs: readonly number[],
	): void {
		if (branchKeyAttrs.length !== children.length) {
			quereusError(
				`AsyncGatherNode(zipByKey): branchKeyAttrs has ${branchKeyAttrs.length} lists but there are ${children.length} branches`,
				StatusCode.INTERNAL,
			);
		}
		const k = branchKeyAttrs.length > 0 ? branchKeyAttrs[0].length : 0;
		if (k === 0) {
			quereusError(
				'AsyncGatherNode(zipByKey) requires >= 1 key column',
				StatusCode.ERROR,
			);
		}
		for (let i = 0; i < branchKeyAttrs.length; i++) {
			if (branchKeyAttrs[i].length !== k) {
				quereusError(
					`AsyncGatherNode(zipByKey): branch ${i} has ${branchKeyAttrs[i].length} key columns, expected ${k}`,
					StatusCode.ERROR,
				);
			}
		}
		if (outputKeyAttrs.length !== k) {
			quereusError(
				`AsyncGatherNode(zipByKey): outputKeyAttrs has ${outputKeyAttrs.length} ids, expected ${k}`,
				StatusCode.ERROR,
			);
		}
		// outputKeyAttrs must be pairwise distinct AND disjoint from every child id.
		const allChildIds = new Set<number>();
		for (const child of children) {
			for (const a of child.getAttributes()) allChildIds.add(a.id);
		}
		const seenOutput = new Set<number>();
		for (const id of outputKeyAttrs) {
			if (seenOutput.has(id)) {
				quereusError(
					`AsyncGatherNode(zipByKey): outputKeyAttrs contains duplicate id ${id}`,
					StatusCode.ERROR,
				);
			}
			seenOutput.add(id);
			if (allChildIds.has(id)) {
				quereusError(
					`AsyncGatherNode(zipByKey): output key id ${id} collides with a child attribute id (the gather must originate it freshly)`,
					StatusCode.ERROR,
				);
			}
		}
		// Resolve every per-branch key attribute in its own branch.
		const resolved: number[][] = [];
		for (let i = 0; i < children.length; i++) {
			const attrs = children[i].getAttributes();
			const idToIndex = new Map<number, number>();
			attrs.forEach((a, ix) => idToIndex.set(a.id, ix));
			const indices: number[] = [];
			for (const id of branchKeyAttrs[i]) {
				const ix = idToIndex.get(id);
				if (ix === undefined) {
					quereusError(
						`AsyncGatherNode(zipByKey): key attribute ${id} not found in branch ${i}`,
						StatusCode.ERROR,
					);
				}
				indices.push(ix);
			}
			resolved.push(indices);
		}
		// Key affinities AND collations must agree across branches, per key
		// position. Affinity disagreement breaks the storage-class contract; a
		// collation disagreement would silently defer to branch 0's collation in
		// the runtime comparator (see {@link getZipByKeyType}/emitter).
		const child0Cols = children[0].getType().columns;
		const normCollation = (c: string | undefined): string => (c && c.length > 0 ? c.toUpperCase() : 'BINARY');
		for (let pos = 0; pos < k; pos++) {
			const baseCol = child0Cols[resolved[0][pos]];
			const baseAffinity = baseCol.type.logicalType.physicalType;
			const baseCollation = normCollation(baseCol.type.collationName);
			for (let i = 1; i < children.length; i++) {
				const col = children[i].getType().columns[resolved[i][pos]];
				const affinity = col.type.logicalType.physicalType;
				if (affinity !== baseAffinity) {
					quereusError(
						`AsyncGatherNode(zipByKey): key position ${pos} affinity mismatch: branch 0 has ${baseAffinity}, branch ${i} has ${affinity}`,
						StatusCode.ERROR,
					);
				}
				const collation = normCollation(col.type.collationName);
				if (collation !== baseCollation) {
					quereusError(
						`AsyncGatherNode(zipByKey): key position ${pos} collation mismatch: branch 0 has ${baseCollation}, branch ${i} has ${collation}`,
						StatusCode.ERROR,
					);
				}
			}
		}
	}

	/**
	 * Resolve each branch's own `branchKeyAttrs[b]` list against that branch's
	 * attribute layout, yielding per-branch key/non-key column indices. Memoised;
	 * only valid for a `zipByKey` combinator.
	 */
	private computeZipByKeyIndices(): ZipByKeyIndices {
		if (this.combinator.kind !== 'zipByKey') {
			quereusError(
				'AsyncGatherNode.computeZipByKeyIndices called on a non-zipByKey gather',
				StatusCode.INTERNAL,
			);
		}
		const branchKeyAttrs = this.combinator.branchKeyAttrs;
		const branchKeyIndices: number[][] = [];
		const branchNonKeyIndices: number[][] = [];
		for (let b = 0; b < this.children.length; b++) {
			const attrs = this.children[b].getAttributes();
			const idToIndex = new Map<number, number>();
			attrs.forEach((a, ix) => idToIndex.set(a.id, ix));
			const keySet = new Set(branchKeyAttrs[b]);
			branchKeyIndices.push(branchKeyAttrs[b].map(id => idToIndex.get(id)!));
			const nonKey: number[] = [];
			attrs.forEach((a, ix) => { if (!keySet.has(a.id)) nonKey.push(ix); });
			branchNonKeyIndices.push(nonKey);
		}
		return { branchKeyIndices, branchNonKeyIndices };
	}

	/** Public accessor for the resolved zipByKey index mapping (used by the emitter). */
	getZipByKeyIndices(): ZipByKeyIndices {
		return this.zipIndicesCache.value;
	}

	private buildAttributes(): readonly Attribute[] {
		if (this.preserveAttributeIds) {
			return this.preserveAttributeIds.slice();
		}
		if (this.combinator.kind === 'unionAll') {
			// Mirror SetOperationNode.buildAttributes: keep left (children[0])
			// attribute IDs verbatim so ORDER BY references continue to resolve,
			// but carry the cross-branch merged column types (getType's unionAll
			// derivation) so the attributes and the relation type cannot drift.
			const mergedColumns = this.getType().columns;
			return this.children[0].getAttributes().map((attr, i) =>
				mergedColumns[i] && attr.type !== mergedColumns[i].type
					? { ...attr, type: mergedColumns[i].type }
					: attr);
		}
		if (this.combinator.kind === 'zipByKey') {
			return this.buildZipByKeyAttributes();
		}
		// crossProduct: concatenate children's attributes verbatim.
		const out: Attribute[] = [];
		for (const child of this.children) {
			for (const attr of child.getAttributes()) {
				out.push(attr);
			}
		}
		return out;
	}

	/**
	 * Build the `zipByKey` output attribute layout: the K merged key attributes
	 * first (type/nullability/collation derived from branch 0's key column at
	 * position k, nullability OR'd across branches because a NULL-keyed row can
	 * surface — but **carrying the gather-minted `outputKeyAttrs[k]` id**, since
	 * the gather originates these merged columns), then each branch's non-key
	 * attributes in declared order, each forced nullable (NULL when the branch is
	 * absent for a key). Non-key attribute IDs are unique across branches and the
	 * minted key ids are disjoint from all of them, so there is no ID collision.
	 */
	private buildZipByKeyAttributes(): readonly Attribute[] {
		const { branchKeyIndices, branchNonKeyIndices } = this.getZipByKeyIndices();
		const { outputKeyAttrs } = this.combinator as { outputKeyAttrs: readonly number[] };
		const childAttrs = this.children.map(c => c.getAttributes());
		const out: Attribute[] = [];
		// Merged key attributes: type/collation from branch 0, nullability OR'd
		// across branches, id from the gather-minted outputKeyAttrs.
		for (let k = 0; k < outputKeyAttrs.length; k++) {
			const baseAttr = childAttrs[0][branchKeyIndices[0][k]];
			let nullable = baseAttr.type.nullable;
			for (let b = 1; b < this.children.length; b++) {
				nullable = nullable || childAttrs[b][branchKeyIndices[b][k]].type.nullable;
			}
			out.push({
				...baseAttr,
				id: outputKeyAttrs[k],
				type: nullable === baseAttr.type.nullable ? baseAttr.type : { ...baseAttr.type, nullable: true },
			});
		}
		// Non-key attributes per branch, forced nullable.
		for (let b = 0; b < this.children.length; b++) {
			for (const ix of branchNonKeyIndices[b]) {
				const attr = childAttrs[b][ix];
				out.push(attr.type.nullable ? attr : { ...attr, type: { ...attr.type, nullable: true } });
			}
		}
		return out;
	}

	getAttributes(): readonly Attribute[] {
		return this.attributesCache.value;
	}

	getType(): RelationType {
		if (this.combinator.kind === 'unionAll') {
			// Per-column logical type is the same symmetric cross-branch merge
			// `SetOperationNode` advertises (a left-deep fold matches the unionAll
			// chain this gather replaced); nullability is the OR across all
			// children; isSet is false (unionAll allows duplicates). Other fields
			// fall through from children[0].
			const types = this.children.map(c => c.getType());
			const baseType = types[0];
			const columns = baseType.columns.map((baseCol, i) => {
				let logicalType = baseCol.type.logicalType;
				let nullable = baseCol.type.nullable;
				for (let j = 1; j < types.length; j++) {
					const childType = types[j].columns[i].type;
					logicalType = mergeSetOpAdvertisedType(logicalType, childType.logicalType);
					nullable = nullable || childType.nullable;
				}
				return logicalType === baseCol.type.logicalType && nullable === baseCol.type.nullable
					? baseCol
					: { ...baseCol, type: { ...baseCol.type, logicalType, nullable } };
			});
			return {
				typeClass: 'relation',
				columns,
				isSet: false,
				isReadOnly: types.every(t => t.isReadOnly),
				keys: [],
				rowConstraints: [],
			} as RelationType;
		}

		if (this.combinator.kind === 'zipByKey') {
			return this.getZipByKeyType();
		}

		// crossProduct: concatenate columns; keys are the N-ary Cartesian product
		// of per-child keys (each child contributes one key; offsets accumulate).
		const types = this.children.map(c => c.getType());
		const columns = types.flatMap(t => t.columns.map(col => col));
		const isReadOnly = types.every(t => t.isReadOnly);
		const rowConstraints = types.flatMap(t => t.rowConstraints.map(rc => rc));

		// Fold keys pairwise: at each step, combine accumulated keys with the
		// next child's keys, shifting the next child's column indices by the
		// running column count.
		let keys: ColRef[][] = types[0].keys.map(k => k.map(c => ({ index: c.index, desc: c.desc })));
		let runningCols = types[0].columns.length;
		for (let i = 1; i < types.length; i++) {
			const next = types[i];
			const shiftedNextKeys: ColRef[][] = next.keys.map(k =>
				k.map(c => ({ index: c.index + runningCols, desc: c.desc })),
			);
			const combined: ColRef[][] = [];
			if (keys.length === 0) {
				// Accumulated side has no key; result has no key either (we cannot
				// build a Cartesian key without one from every side).
				keys = [];
			} else if (shiftedNextKeys.length === 0) {
				keys = [];
			} else {
				for (const k1 of keys) {
					for (const k2 of shiftedNextKeys) {
						combined.push([...k1, ...k2]);
					}
				}
				keys = combined;
			}
			runningCols += next.columns.length;
		}

		const isSet = types.every(t => t.isSet);
		return {
			typeClass: 'relation',
			columns,
			isSet,
			isReadOnly,
			keys,
			rowConstraints,
		} as RelationType;
	}

	/**
	 * Build the `zipByKey` output relation type. Column layout mirrors
	 * {@link buildZipByKeyAttributes}: deduped key columns (nullability OR'd),
	 * then each branch's non-key columns forced nullable. The key columns
	 * `[0..K-1]` form the output's unique key — multiple NULL-keyed rows do not
	 * violate this (SQL UNIQUE permits multiple NULLs). `isSet` is false because
	 * NULL-keyed standalone rows can repeat.
	 */
	private getZipByKeyType(): RelationType {
		const { branchKeyIndices, branchNonKeyIndices } = this.getZipByKeyIndices();
		const { outputKeyAttrs } = this.combinator as { outputKeyAttrs: readonly number[] };
		const types = this.children.map(c => c.getType());
		const columns: RelationType['columns'][number][] = [];
		// Key columns from children[0], nullability OR'd across branches.
		for (let k = 0; k < outputKeyAttrs.length; k++) {
			const baseCol = types[0].columns[branchKeyIndices[0][k]];
			let nullable = baseCol.type.nullable;
			for (let b = 1; b < this.children.length; b++) {
				nullable = nullable || types[b].columns[branchKeyIndices[b][k]].type.nullable;
			}
			columns.push(nullable === baseCol.type.nullable
				? baseCol
				: { ...baseCol, type: { ...baseCol.type, nullable: true } });
		}
		// Non-key columns per branch, forced nullable.
		for (let b = 0; b < this.children.length; b++) {
			for (const ix of branchNonKeyIndices[b]) {
				const col = types[b].columns[ix];
				columns.push(col.type.nullable ? col : { ...col, type: { ...col.type, nullable: true } });
			}
		}
		const k = outputKeyAttrs.length;
		const keys: ColRef[][] = [Array.from({ length: k }, (_v, i) => ({ index: i }))];
		return {
			typeClass: 'relation',
			columns,
			isSet: false,
			isReadOnly: types.every(t => t.isReadOnly),
			keys,
			rowConstraints: [],
		} as RelationType;
	}

	computePhysical(childrenPhysical: PhysicalProperties[]): Partial<PhysicalProperties> {
		if (this.combinator.kind === 'unionAll' || this.combinator.kind === 'zipByKey') {
			// Same conservatism as SetOperationNode: drop relational invariants
			// that can't be guaranteed across the merge. Ordering is dropped
			// (arrival-order interleave is non-deterministic). For zipByKey the
			// output's key is carried in getType().keys, not in physical FDs;
			// conditional non-key FDs (branch-i FDs hold only when the branch-i
			// row exists) are future work, not implemented here.
			return {
				estimatedRows: this.physicalRows(childrenPhysical),
				ordering: undefined,
				monotonicOn: undefined,
				fds: undefined,
				equivClasses: undefined,
				constantBindings: undefined,
				domainConstraints: undefined,
			};
		}

		// crossProduct: fold pairwise — column-layout-wise identical to N
		// applications of JoinNode(cross). Each child's FDs hold on its slice of
		// the output row; concatenation preserves them after shifting column
		// indices. The kind downgrade below records uniqueness loss on the FD
		// itself; the kind-aware readers (ticket fd-determination-reader-side-rule)
		// make any side-key FD drop unnecessary — JoinNode now matches.
		//
		// Kind downgrade: a child's 'unique' FD stays 'unique' only when every
		// OTHER child is provably ≤1-row (the child's rows are never duplicated);
		// otherwise the cross product fans the child out and only the value claim
		// ('determination') survives — guarded FDs included.
		//
		// INDs could shift+merge here exactly like FDs (a cross product preserves
		// each child's per-row inclusion claims). Deferred — no consumer reads
		// `inds` in this wave, so we leave it undefined rather than carry it
		// through AsyncGather. Revisit when a consumer lands.
		const childColCounts = this.children.map(c => c.getType().columns.length);
		// `hasSingletonFd` is kind-aware (ticket fd-determination-reader-side-rule):
		// 'determination' constant pins on a bag no longer over-claim ≤1-row, so
		// this probe — and therefore the keep-'unique' decision — is sound.
		const childIsSingleton = childrenPhysical.map((phys, i) =>
			hasSingletonFd(phys.fds, childColCounts[i], this.children[i].getType().isSet));
		const kindAdjustedFds = (idx: number): ReadonlyArray<FunctionalDependency> => {
			const childFds = childrenPhysical[idx].fds ?? [];
			const keepUnique = childIsSingleton.every((s, j) => j === idx || s);
			return keepUnique
				? childFds
				: childFds.map(fd => (fd.kind === 'unique' ? { ...fd, kind: 'determination' as const } : fd));
		};

		let fds: ReadonlyArray<FunctionalDependency> = kindAdjustedFds(0);
		let equiv: ReadonlyArray<ReadonlyArray<number>> = childrenPhysical[0].equivClasses ?? [];
		let bindings: ReadonlyArray<ConstantBinding> = childrenPhysical[0].constantBindings ?? [];
		let domains: ReadonlyArray<DomainConstraint> = childrenPhysical[0].domainConstraints ?? [];
		let runningCols = childColCounts[0];

		for (let i = 1; i < this.children.length; i++) {
			const rightPhys = childrenPhysical[i];
			const rightFds = kindAdjustedFds(i);
			const rightEC = rightPhys.equivClasses ?? [];
			const rightBindings = rightPhys.constantBindings ?? [];
			const rightDomains = rightPhys.domainConstraints ?? [];

			fds = mergeFds(fds, shiftFds(rightFds, runningCols));
			equiv = mergeEquivClasses(equiv, shiftEquivClasses(rightEC, runningCols));
			const mergedBindings = mergeConstantBindings(
				bindings,
				shiftConstantBindings(rightBindings, runningCols),
			);
			bindings = closeConstantBindingsOverEcs(mergedBindings, equiv);
			domains = mergeDomainConstraints(domains, shiftDomainConstraints(rightDomains, runningCols));

			runningCols += childColCounts[i];
		}

		return {
			estimatedRows: this.physicalRows(childrenPhysical),
			ordering: undefined,
			monotonicOn: undefined,
			fds: fds.length > 0 ? fds : undefined,
			equivClasses: equiv.length > 0 ? equiv : undefined,
			constantBindings: bindings.length > 0 ? bindings : undefined,
			domainConstraints: domains.length > 0 ? domains : undefined,
		};
	}

	getChildren(): readonly PlanNode[] {
		return this.children;
	}

	getRelations(): readonly RelationalPlanNode[] {
		return this.children;
	}

	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		if (newChildren.length !== this.children.length) {
			quereusError(
				`AsyncGatherNode expects ${this.children.length} children, got ${newChildren.length}`,
				StatusCode.INTERNAL,
			);
		}

		let changed = false;
		const typed: RelationalPlanNode[] = [];
		for (let i = 0; i < newChildren.length; i++) {
			const child = newChildren[i];
			if (!isRelationalNode(child)) {
				quereusError(
					`AsyncGatherNode: child ${i} must be a RelationalPlanNode`,
					StatusCode.INTERNAL,
				);
			}
			if (child !== this.children[i]) changed = true;
			typed.push(child as RelationalPlanNode);
		}

		if (!changed) return this;

		return new AsyncGatherNode(
			this.scope,
			typed,
			this.combinator,
			this.concurrencyCap,
			this.preserveAttributeIds,
		);
	}

	/**
	 * Pre-optimization branch composition. The per-combinator arms live in
	 * {@link gatherRowsFrom} so this getter and {@link computePhysical} cannot
	 * drift — the same discipline `aggregateRowsFrom` applies to the aggregates.
	 */
	get estimatedRows(): number | undefined {
		return gatherRowsFrom(this.combinator.kind, this.children.map(c => c.estimatedRows));
	}

	/**
	 * The same composition over the PHYSICAL branch counts. `rule-parallel-gather`
	 * substitutes this node for a `union all` on high-latency plans, so without this
	 * stamp the branch meant to PRESERVE the estimate would be the one that loses it
	 * — the children are physical access nodes by then and declare no logical getter
	 * (see `physicalSourceRows`).
	 */
	private physicalRows(childrenPhysical: PhysicalProperties[]): number | undefined {
		return gatherRowsFrom(
			this.combinator.kind,
			this.children.map((child, i) => physicalSourceRows(childrenPhysical[i], child)),
		);
	}

	override toString(): string {
		return `ASYNC_GATHER(${this.combinator.kind}, N=${this.children.length}, cap=${this.concurrencyCap})`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			combinator: this.combinator.kind,
			branchCount: this.children.length,
			concurrencyCap: this.concurrencyCap,
			...(this.combinator.kind === 'zipByKey'
				? { branchKeyAttrs: this.combinator.branchKeyAttrs, outputKeyAttrs: this.combinator.outputKeyAttrs }
				: {}),
		};
	}
}


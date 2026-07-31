import { PlanNodeType } from './plan-node-type.js';
import {
	PlanNode,
	isRelationalNode,
	type RelationalPlanNode,
	type Attribute,
	type PhysicalProperties,
	type ConstantBinding,
	type DomainConstraint,
	type FunctionalDependency,
	type InclusionDependency,
} from './plan-node.js';
import type { RelationType } from '../../common/datatype.js';
import type { Scope } from '../scopes/scope.js';
import { Cached } from '../../util/cached.js';
import { StatusCode } from '../../common/types.js';
import { quereusError } from '../../common/errors.js';
import { propagateJoinFds, propagateJoinInds } from './join-utils.js';
import { physicalSourceRows } from '../util/row-estimates.js';

/**
 * The mode a FanOutLookupJoin branch contributes for one outer row:
 *
 * - `atMostOne-left` — like LEFT JOIN: branch yields zero or one row; a zero-row
 *   match emits NULLs for the branch's output columns and keeps the outer row.
 * - `atMostOne-inner` — like INNER JOIN: branch yields zero or one row; a
 *   zero-row match drops the outer row entirely.
 * - `cross` — like an inner nested-loop join: the branch yields *n* rows per
 *   outer row (data-driven cardinality) and the node emits one wide row per
 *   `(outer, branch-row)` combination — the Cartesian product. A zero-row
 *   branch drops the outer row entirely (inner-drop semantics), matching the
 *   chain of inner nested-loop joins it replaces.
 * - `cross-left` — like a LEFT nested-loop join with a data-driven 1:n match:
 *   a non-empty branch contributes every row (Cartesian product, like `cross`),
 *   but a zero-row branch emits one NULL-padded factor row so the outer row is
 *   preserved (LEFT semantics). Its output attributes are nullable-widened, like
 *   `atMostOne-left`.
 *
 * The `array` mode is deferred to a follow-up backlog ticket.
 */
export type FanOutBranchMode = 'atMostOne-left' | 'atMostOne-inner' | 'cross' | 'cross-left';

/**
 * True when the branch preserves the outer row on an empty match (LEFT
 * semantics) and therefore nullable-widens its output attributes. Shared by the
 * node's attribute/type widening, the recognition rule's `preserveAttrs`
 * widening, and the emit composer's empty-buffer NULL-pad path.
 */
export function isLeftBranchMode(mode: FanOutBranchMode): boolean {
	return mode === 'atMostOne-left' || mode === 'cross-left';
}

/**
 * True when the branch contributes a data-driven 1:n Cartesian factor (`cross`
 * or `cross-left`). Used by the memory guard and the cardinality estimate.
 */
export function isCrossBranchMode(mode: FanOutBranchMode): boolean {
	return mode === 'cross' || mode === 'cross-left';
}

/**
 * How the node drives the outer side:
 *
 * - `serial` — drive one outer row at a time: fork its branches, run them
 *   concurrently (bounded by `concurrencyCap`), compose, yield, then read the
 *   next outer row. The N branches of one row overlap; the next row's lookups
 *   do not begin until the current row is fully resolved. **Default.**
 * - `batched` — pipeline lookups *across* outer rows: admit multiple outer
 *   rows ahead of the emit frontier (bounded read-ahead with backpressure),
 *   share a single global in-flight budget across all of them, and re-order
 *   completed rows back into outer order before emitting. Saturates block I/O
 *   when there are many outer rows but few branches per row.
 *
 * Output order is identical for both modes (outer order); only the internal
 * scheduling differs. The recognition rule that *chooses* `batched` is a
 * separate concern — nothing in the optimizer constructs a batched node yet,
 * so `serial` keeps existing plans byte-for-byte unchanged.
 */
export type FanOutOuterMode = 'serial' | 'batched';

/**
 * Per-branch specification for {@link FanOutLookupJoinNode}.
 *
 * `child` is a parameterized sub-plan that, for one outer row, produces the
 * lookup-row stream for this branch. The sub-plan reads its outer-binding
 * dependencies via the surrounding `RuntimeContext.context` map; the emitter
 * sets the outer row's slot on the parent context *before* forking so the
 * fork's snapshot already carries the binding.
 *
 * `outputAttrs` carries the output-side attribute identities the branch
 * contributes to the FanOutLookupJoin's wide output row, in `child` output
 * order. They are tracked separately from `child.getAttributes()` so a
 * recognition rule can preserve a surrounding Project's attribute IDs across
 * the rewrite (mirroring `BloomJoinNode.preserveAttributeIds`).
 *
 * `concurrencySafe` is computed by the constructor (rule layer, or test) from
 * `getModuleConcurrencyMode` on the child's underlying table reference plus a
 * read-only-subtree check. The emitter consults it to decide whether to drive
 * the branch raw or wrap it in `acquireConnectionLock` against the active
 * connection.
 *
 * `connectionKey` is an optional identity hint used to choose the lock target:
 * when two branches reference distinct connections, both can run unsynchronized
 * even if both modules declare `'serial'`. When unset, the emitter falls back
 * to `rctx.activeConnection` as the lock target.
 */
export interface FanOutBranchSpec {
	readonly child: RelationalPlanNode;
	readonly mode: FanOutBranchMode;
	readonly outputAttrs: readonly Attribute[];
	readonly concurrencySafe: boolean;
	readonly connectionKey?: object;
}

/**
 * Physical relational node that, for one outer row, forks N parameterized
 * child sub-plans concurrently, collects `atMostOne` row per branch, and
 * assembles a wide result row.
 *
 * Replaces a chain of N nested-loop LEFT/INNER joins where each branch is a
 * key-aligned (FK→PK) lookup against an independent table, or — for `cross`
 * branches — an unconstrained 1:n inner nested-loop join. The runtime drives
 * the N branch factories through {@link ParallelDriver.drive}, bounded by
 * `concurrencyCap`.
 *
 * Attribute layout: outer's attributes first, then each branch's
 * `outputAttrs` in declared order. `preserveAttributeIds`, when supplied,
 * fixes the entire layout verbatim so rewrites can preserve a surrounding
 * Project's attribute IDs.
 *
 * **Key/FD propagation is conservative.** v1 folds the branches in left-to-
 * right per-branch `propagateJoinFds` calls with **empty equi-pair lists** —
 * the node does not carry per-branch FK→PK alignment, so the propagation
 * cannot derive the cross-branch FDs the optimizer rule (4.5) would otherwise
 * see. The result is correct, just less precise than what the rule layer
 * could produce after recognizing FK alignment. Once the rule lands and a
 * per-branch equi-pair surface is added to {@link FanOutBranchSpec}, this can
 * tighten without changing the emitter.
 *
 * Outer ordering passes through; v1 emits rows in outer order (for `cross`
 * branches, all product rows of one outer row are emitted contiguously before
 * the next outer row). The `array` branch mode is deferred to a follow-up.
 */
export class FanOutLookupJoinNode extends PlanNode implements RelationalPlanNode {
	override readonly nodeType = PlanNodeType.FanOutLookupJoin;
	private readonly attributesCache: Cached<readonly Attribute[]>;

	constructor(
		scope: Scope,
		public readonly outer: RelationalPlanNode,
		public readonly branches: readonly FanOutBranchSpec[],
		public readonly concurrencyCap: number,
		public readonly preserveAttributeIds?: readonly Attribute[],
		public readonly outerMode: FanOutOuterMode = 'serial',
	) {
		FanOutLookupJoinNode.validateConstruction(outer, branches, concurrencyCap, preserveAttributeIds, outerMode);
		// Self-cost only: the outer and every branch child are in getChildren(), so
		// their subtree costs flow in via getTotalCost(). The fan-out node's own
		// overhead is negligible (it forks child sub-plans; no per-row work of its own).
		super(scope, 0.01);
		this.attributesCache = new Cached(() => this.buildAttributes());
	}

	private static validateConstruction(
		outer: RelationalPlanNode,
		branches: readonly FanOutBranchSpec[],
		concurrencyCap: number,
		preserveAttributeIds: readonly Attribute[] | undefined,
		outerMode: FanOutOuterMode,
	): void {
		if (outerMode !== 'serial' && outerMode !== 'batched') {
			quereusError(
				`FanOutLookupJoinNode: unknown outerMode '${String(outerMode)}'`,
				StatusCode.INTERNAL,
			);
		}
		if (branches.length < 1) {
			quereusError(
				`FanOutLookupJoinNode requires >= 1 branch, got ${branches.length}`,
				StatusCode.INTERNAL,
			);
		}
		if (!Number.isInteger(concurrencyCap) || concurrencyCap < 1) {
			quereusError(
				`FanOutLookupJoinNode concurrencyCap must be a positive integer, got ${concurrencyCap}`,
				StatusCode.INTERNAL,
			);
		}
		for (let i = 0; i < branches.length; i++) {
			const b = branches[i];
			const childAttrCount = b.child.getAttributes().length;
			if (b.outputAttrs.length !== childAttrCount) {
				quereusError(
					`FanOutLookupJoinNode: branch ${i} outputAttrs length (${b.outputAttrs.length}) does not match child attributes (${childAttrCount})`,
					StatusCode.INTERNAL,
				);
			}
		}
		if (preserveAttributeIds !== undefined) {
			let expected = outer.getAttributes().length;
			for (const b of branches) expected += b.outputAttrs.length;
			if (preserveAttributeIds.length !== expected) {
				quereusError(
					`FanOutLookupJoinNode: preserveAttributeIds length (${preserveAttributeIds.length}) does not match outer+branches attribute count (${expected})`,
					StatusCode.INTERNAL,
				);
			}
		}
	}

	private buildAttributes(): readonly Attribute[] {
		if (this.preserveAttributeIds) {
			return this.preserveAttributeIds.slice();
		}
		const out: Attribute[] = [];
		for (const a of this.outer.getAttributes()) out.push(a);
		for (const b of this.branches) {
			const nullable = isLeftBranchMode(b.mode);
			for (const a of b.outputAttrs) {
				if (nullable && !a.type.nullable) {
					out.push({ ...a, type: { ...a.type, nullable: true } });
				} else {
					out.push(a);
				}
			}
		}
		return out;
	}

	getAttributes(): readonly Attribute[] {
		return this.attributesCache.value;
	}

	getType(): RelationType {
		const outerType = this.outer.getType();
		let isReadOnly = outerType.isReadOnly;
		const columns = [
			...outerType.columns.map(col => col),
			...this.branches.flatMap(b => {
				const nullable = isLeftBranchMode(b.mode);
				return b.child.getType().columns.map(col =>
					nullable && !col.type.nullable
						? { ...col, type: { ...col.type, nullable: true } }
						: col,
				);
			}),
		];
		const rowConstraints = [
			...outerType.rowConstraints.map(rc => rc),
			...this.branches.flatMap(b => b.child.getType().rowConstraints.map(rc => rc)),
		];
		for (const b of this.branches) {
			isReadOnly = isReadOnly && b.child.getType().isReadOnly;
		}
		return {
			typeClass: 'relation',
			columns,
			isSet: false,
			isReadOnly,
			keys: [],
			rowConstraints,
		} as RelationType;
	}

	computePhysical(childrenPhysical: readonly PhysicalProperties[]): Partial<PhysicalProperties> {
		const outerPhys = childrenPhysical[0];
		let fds: ReadonlyArray<FunctionalDependency> = outerPhys.fds ?? [];
		let equiv: ReadonlyArray<ReadonlyArray<number>> = outerPhys.equivClasses ?? [];
		let bindings: ReadonlyArray<ConstantBinding> = outerPhys.constantBindings ?? [];
		let domains: ReadonlyArray<DomainConstraint> = outerPhys.domainConstraints ?? [];
		// INDs fold through the branch joins the same way FDs do: each fan-out
		// branch is an inner/left join, so `propagateJoinInds` keeps the outer's
		// seeded INDs (outer columns stay at their original indices) and unions in
		// each inner branch's shifted INDs. Without this the FK-seeded INDs the
		// JoinNode would have carried are lost the moment `rule-fanout-lookup-join`
		// rewrites the join chain into this node.
		let inds: ReadonlyArray<InclusionDependency> = outerPhys.inds ?? [];
		let leftColCount = this.outer.getAttributes().length;

		for (let i = 0; i < this.branches.length; i++) {
			const b = this.branches[i];
			const rightPhys = childrenPhysical[i + 1];
			const branchCols = b.outputAttrs.length;
			const totalCols = leftColCount + branchCols;
			const joinType = isLeftBranchMode(b.mode) ? 'left' : 'inner';

			const leftPhys: PhysicalProperties = {
				fds,
				equivClasses: equiv,
				constantBindings: bindings,
				domainConstraints: domains,
				inds,
			};
			const merged = propagateJoinFds(
				joinType,
				leftPhys,
				rightPhys,
				[],
				leftColCount,
				totalCols,
				[],
			);

			fds = merged.fds ?? [];
			equiv = merged.equivClasses ?? [];
			bindings = merged.constantBindings ?? [];
			domains = merged.domainConstraints ?? [];
			inds = propagateJoinInds(joinType, leftPhys, rightPhys, leftColCount) ?? [];
			leftColCount = totalCols;
		}

		return {
			ordering: outerPhys.ordering,
			monotonicOn: outerPhys.monotonicOn,
			fds: fds.length > 0 ? fds : undefined,
			equivClasses: equiv.length > 0 ? equiv : undefined,
			constantBindings: bindings.length > 0 ? bindings : undefined,
			domainConstraints: domains.length > 0 ? domains : undefined,
			inds: inds.length > 0 ? inds : undefined,
			estimatedRows: this.computeEstimatedRows(childrenPhysical),
		};
	}

	/**
	 * Outer cardinality multiplied by each cross branch's per-outer-row fan-out
	 * (`cross` and `cross-left`; at-most-one branches contribute a ×1 factor). A
	 * cross branch whose child has no estimate falls back to ×1 for that branch
	 * rather than poisoning the whole estimate to `undefined`. (A `cross-left`
	 * branch preserves the outer row when empty, so its true factor is at least 1;
	 * the child-estimate product is an upper-leaning approximation either way.)
	 * Returns `undefined` only when the outer side itself has no estimate.
	 *
	 * `childrenPhysical` is supplied by `computePhysical` so the fan-out reads each
	 * child's PHYSICAL cardinality (`getChildren()` order: outer, then one entry per
	 * branch); the logical getter reads `undefined` through a physical access node.
	 * Omitted by the `estimatedRows` getter, which is the pre-optimization view.
	 */
	private computeEstimatedRows(childrenPhysical?: readonly PhysicalProperties[]): number | undefined {
		const rowsOf = (node: RelationalPlanNode, childIndex: number): number | undefined =>
			childrenPhysical ? physicalSourceRows(childrenPhysical[childIndex], node) : node.estimatedRows;

		const outerEst = rowsOf(this.outer, 0);
		if (outerEst === undefined) return undefined;
		let est = outerEst;
		this.branches.forEach((b, i) => {
			if (isCrossBranchMode(b.mode)) {
				const childEst = rowsOf(b.child, i + 1);
				if (childEst !== undefined) est *= childEst;
			}
		});
		return est;
	}

	get estimatedRows(): number | undefined {
		return this.computeEstimatedRows();
	}

	getChildren(): readonly PlanNode[] {
		return [this.outer, ...this.branches.map(b => b.child)];
	}

	getRelations(): readonly RelationalPlanNode[] {
		return [this.outer, ...this.branches.map(b => b.child)];
	}

	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		const expected = 1 + this.branches.length;
		if (newChildren.length !== expected) {
			quereusError(
				`FanOutLookupJoinNode expects ${expected} children, got ${newChildren.length}`,
				StatusCode.INTERNAL,
			);
		}
		const [newOuter, ...newBranchChildren] = newChildren;
		if (!isRelationalNode(newOuter)) {
			quereusError('FanOutLookupJoinNode: outer child must be a RelationalPlanNode', StatusCode.INTERNAL);
		}
		let changed = newOuter !== this.outer;
		for (let i = 0; i < newBranchChildren.length; i++) {
			const child = newBranchChildren[i];
			if (!isRelationalNode(child)) {
				quereusError(
					`FanOutLookupJoinNode: branch ${i} child must be a RelationalPlanNode`,
					StatusCode.INTERNAL,
				);
			}
			if (child !== this.branches[i].child) changed = true;
		}
		if (!changed) return this;

		const newBranches: FanOutBranchSpec[] = this.branches.map((b, i) => ({
			child: newBranchChildren[i] as RelationalPlanNode,
			mode: b.mode,
			outputAttrs: b.outputAttrs,
			concurrencySafe: b.concurrencySafe,
			connectionKey: b.connectionKey,
		}));

		return new FanOutLookupJoinNode(
			this.scope,
			newOuter as RelationalPlanNode,
			newBranches,
			this.concurrencyCap,
			this.preserveAttributeIds,
			this.outerMode,
		);
	}

	override toString(): string {
		const branchSummary = this.branches
			.map((b, i) => `b${i}:${b.mode}${b.concurrencySafe ? '' : '/locked'}`)
			.join(', ');
		const modeSuffix = this.outerMode === 'batched' ? ', batched' : '';
		return `FANOUT_LOOKUP_JOIN(N=${this.branches.length}, cap=${this.concurrencyCap}${modeSuffix}) [${branchSummary}]`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			branchCount: this.branches.length,
			concurrencyCap: this.concurrencyCap,
			outerMode: this.outerMode,
			branches: this.branches.map(b => ({
				mode: b.mode,
				concurrencySafe: b.concurrencySafe,
				outputColCount: b.outputAttrs.length,
			})),
		};
	}
}

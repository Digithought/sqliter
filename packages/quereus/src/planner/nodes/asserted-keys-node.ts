import { PlanNode, type RelationalPlanNode, type UnaryRelationalNode, type Attribute, type PhysicalProperties, type FunctionalDependency } from './plan-node.js';
import type { RelationType } from '../../common/datatype.js';
import { PlanNodeType } from './plan-node-type.js';
import type { Scope } from '../scopes/scope.js';
import { addFd } from '../util/fd-utils.js';
import { physicalSourceRows } from '../util/row-estimates.js';

/**
 * A unary pass-through that contributes a set of **asserted** functional
 * dependencies onto its source's physical FD surface — the declared logical
 * key(s) a lens *proves* or *enforces* at the inlined-view boundary that the
 * compiled body alone may not surface (docs/lens.md § Constraint Attachment;
 * docs/optimizer-fd.md).
 *
 * Pure planning-time marker, modeled on {@link AliasNode} / {@link RetrieveNode}:
 *  - column shape and attribute IDs are unchanged (`getType` / `getAttributes`
 *    return the source's directly);
 *  - `computePhysical` passes every child physical property through unchanged and
 *    merges {@link assertedFds} into the child's FD set via `addFd`;
 *  - the emitter (`runtime/emit/asserted-keys.ts`) emits the source directly, so
 *    the node vanishes at runtime (zero cost — exactly like `emitAlias`).
 *
 * `assertedFds` are expressed in this node's **output**-column-index space (==
 * the source's, since the shape is unchanged). The wiring site
 * (`planner/building/select.ts` `buildFrom`) populates them via
 * `computeLensAssertedKeyFds` and only inlines the node when ≥1 FD is produced.
 */
export class AssertedKeysNode extends PlanNode implements UnaryRelationalNode {
	override readonly nodeType = PlanNodeType.AssertedKeys;

	constructor(
		scope: Scope,
		public readonly source: RelationalPlanNode,
		/** The encoded logical keys, in this node's output-column-index space. */
		public readonly assertedFds: readonly FunctionalDependency[],
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
		// exactly like RetrieveNode — then merge the asserted declared-key FDs into
		// the child's FD set. `addFd` subsumes a redundant key (when local
		// propagation already surfaced it) and is load-bearing when it did not.
		let fds = src.fds ?? [];
		const keyHints = this.assertedFds.map(fd => fd.determinants);
		for (const fd of this.assertedFds) {
			fds = addFd(fds, fd, { keyHints });
		}

		return {
			estimatedRows: physicalSourceRows(src, this.source),
			ordering: src.ordering,
			monotonicOn: src.monotonicOn,
			fds,
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
			throw new Error(`AssertedKeysNode expects 1 child, got ${newChildren.length}`);
		}

		const [newSource] = newChildren;

		// Return same instance if nothing changed (the asserted FDs are immutable).
		if (newSource === this.source) {
			return this;
		}

		return new AssertedKeysNode(
			this.scope,
			newSource as RelationalPlanNode,
			this.assertedFds,
		);
	}

	override toString(): string {
		return `ASSERTED KEYS (${this.assertedFds.length})`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			assertedFds: this.assertedFds.map(fd => {
				const guard = fd.guard ? ` [guard ${fd.guard.clauses.length}]` : '';
				return `{${fd.determinants.join(',')}} -> {${fd.dependents.join(',')}}${guard}`;
			}),
		};
	}
}

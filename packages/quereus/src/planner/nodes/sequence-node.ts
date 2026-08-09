import type { Scope } from '../scopes/scope.js';
import { PlanNode, type RelationalPlanNode, type PhysicalProperties, type Attribute, isRelationalNode } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';
import type { BaseType } from '../../common/datatype.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';

/**
 * Sequences ordered side-effect statements ahead of a main statement.
 *
 * Built by `buildBlock` when a top-level statement's WITH clause contains a
 * data-modifying member the rest of the statement never references: each such
 * member is rebuilt, Sink-wrapped, and threaded here as an `effect` so its write
 * still runs — SQLite and PostgreSQL both perform the write of every named
 * `insert`/`update`/`delete` member whether or not anything reads it.
 *
 * The effects run strictly BEFORE the main statement, each driven to completion
 * in list order (see `runtime/emit/sequence.ts`). Effects-first is the only
 * ordering that can guarantee the writes at all: a main statement abandoned
 * early (`limit 0`) would never reach a trailing effect.
 *
 * Not a `BlockNode`: a nested block erases the result relation's shape
 * (`BlockNode.getType()` is void, so column names are lost) and its emitter
 * passes statements as bare params, which the scheduler starts concurrently
 * (see `emitViewMutation`'s header for why bare params cannot carry ordering).
 * This node instead delegates its type/attributes/rows to the main child — a
 * relational main keeps its columns, a void-DML (Sink-topped) main keeps its
 * scalar affected-row shape — and its emitter drives the effects sequentially
 * as sub-program callbacks before delegating to the main child.
 */
export class SequenceNode extends PlanNode {
	override readonly nodeType = PlanNodeType.Sequence;

	constructor(
		scope: Scope,
		/** Ordered side-effect statements, each driven to completion before the next. */
		public readonly effects: readonly PlanNode[],
		/** The statement whose result this node surfaces unchanged. */
		public readonly main: PlanNode,
	) {
		// Self-cost only: effects and main are getChildren(), so their subtree
		// costs flow in via getTotalCost(). Self is the sequencing overhead.
		super(scope, 0.1);
		if (effects.length === 0) {
			throw new QuereusError('SequenceNode requires at least one effect', StatusCode.INTERNAL);
		}
	}

	getType(): BaseType {
		return this.main.getType();
	}

	/** The main child's attributes, or `[]` when it is a void side-effect statement. */
	getAttributes(): readonly Attribute[] {
		return isRelationalNode(this.main) ? this.main.getAttributes() : [];
	}

	getChildren(): readonly PlanNode[] {
		// Order: effects first, main last. `withChildren` slices back in this same
		// order, and the emitter threads its params identically.
		return [...this.effects, this.main];
	}

	getRelations(): readonly RelationalPlanNode[] {
		// The effects are Sink-topped side-effect statements, not relational inputs
		// (mirrors ViewMutationNode.getRelations). A relational main surfaces so the
		// attribute-provenance walk treats this node's forwarded attributes as
		// forwarded, not originated.
		return isRelationalNode(this.main) ? [this.main] : [];
	}

	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		if (newChildren.length !== this.effects.length + 1) {
			throw new QuereusError(
				`SequenceNode expects ${this.effects.length + 1} children, got ${newChildren.length}`,
				StatusCode.INTERNAL
			);
		}
		const newEffects = newChildren.slice(0, this.effects.length);
		const newMain = newChildren[this.effects.length];
		if (newMain === this.main && newEffects.every((child, i) => child === this.effects[i])) {
			return this;
		}
		return new SequenceNode(this.scope, newEffects, newMain);
	}

	get estimatedRows(): number | undefined {
		return isRelationalNode(this.main) ? this.main.estimatedRows : undefined;
	}

	computePhysical(): Partial<PhysicalProperties> {
		return {
			readonly: false, // the effects write base tables
			idempotent: false,
			deterministic: false,
		};
	}

	override toString(): string {
		return `SEQUENCE (${this.effects.length} effect${this.effects.length === 1 ? '' : 's'})`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			effects: this.effects.length,
			mainType: this.main.nodeType,
		};
	}
}

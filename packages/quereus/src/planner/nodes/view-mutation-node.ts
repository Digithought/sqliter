import type { Scope } from '../scopes/scope.js';
import { PlanNode, type RelationalPlanNode, type ScalarPlanNode, type PhysicalProperties, type TableDescriptor, type RowDescriptor, type Attribute, isRelationalNode } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';
import type { RelationType, ScalarType } from '../../common/datatype.js';
import { INTEGER_TYPE } from '../../types/builtin-types.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';

/** When a separate {@link ViewMutationNode.returning} relation is captured. */
export type ReturningTiming = 'pre' | 'post';

/**
 * The up-front base-PK identity capture side input for a multi-source **update** or
 * multi-side **delete** fan-out (docs/vu-operators.md § Inner Join; docs/view-updateability.md § `returning`
 * Clauses).
 *
 * `source` selects each affected view row's base-PK identities (one capture column per
 * side per PK column, named `k<side>_<j>`); the emitter materializes it **before** the
 * base ops run and stashes the rows in `rctx.tableContexts` under {@link descriptor}.
 * The readers scan it back through an `InternalRecursiveCTERefNode` carrying the same
 * `descriptor`:
 *   - when more than one base op runs against live state (an update assigning **both**
 *     sides, an n-way fan-out, or a lenient delete fanned out to multiple candidate
 *     sides), each per-side base op's identifying correlated EXISTS over `__vmupd_keys`
 *     (matching that side's PK columns), so the first op cannot empty the join — or
 *     rewrite a predicate column — out from under a later op; and
 *   - when an update carries RETURNING, the post-mutation
 *     {@link ViewMutationNode.returning} re-query, re-projecting exactly the updated
 *     logical rows by captured identity — even when the update rewrote the column
 *     its own WHERE filtered on.
 *
 * Materialized whenever present (a both-sides update / multi-side delete without
 * RETURNING still needs it for the base ops), so it is independent of the RETURNING
 * branch. Parallel to {@link MutationEnvelope} (the insert surrogate).
 */
export interface IdentityCapture {
	readonly source: RelationalPlanNode;
	readonly descriptor: TableDescriptor;
}

/**
 * The **shared-surrogate mutation envelope** for a multi-source view INSERT.
 *
 * `source` is the per-row augmented source (the supplied view columns) — built
 * once and materialized by the emitter *before* the base ops run. Each base op
 * reads it back through an `EnvelopeScanNode` carrying the same {@link descriptor},
 * so the fan-out shares one set of rows.
 *
 * When `keyDefault` is present the emitter appends a shared key as the last envelope
 * column. It is the anchor key column's declared `default`, evaluated **once per
 * produced row** at the envelope (with `mutation_ordinal()` resolving to the row's
 * 1-based ordinal, and any `max()` subquery observing pre-mutation state since no base
 * write has fired yet). The single evaluated value is threaded into every base insert
 * of that row via the equivalence class, so the branches cannot diverge. The engine
 * itself mints nothing — the basis author declares the policy in the column default
 * (`docs/vu-mutation-context.md` § Mutation Context). Absent ⇒ the shared key is
 * directly supplied (no appended column).
 *
 * A `keyDefault` may itself read a supplied sibling via `new.<col>` (e.g.
 * `default (coalesce((select max(rid) from anchor), 0) + new.seq)`); its column
 * references resolve against {@link keyDefaultRowDescriptor}, which the emitter
 * installs over each source row (before the `__shared_key` is appended) for the
 * duration of the per-row evaluation.
 */
export interface MutationEnvelope {
	readonly source: RelationalPlanNode;
	readonly descriptor: TableDescriptor;
	/**
	 * The anchor key column's compiled `default`, evaluated once per produced row at
	 * the envelope to fill the appended `__shared_key` column. Absent ⇒ the shared
	 * key is directly supplied.
	 */
	readonly keyDefault?: ScalarPlanNode;
	/**
	 * The row descriptor over the supplied envelope columns the {@link keyDefault}'s
	 * `new.<col>` references resolve through — the emitter installs it (as a row slot)
	 * over each source row while evaluating the key default. Present only when a
	 * `keyDefault` reads supplied siblings; the descriptor's attribute ids are fresh
	 * (minted alongside the key default's column refs), so the reference is
	 * self-contained and the optimizer cannot dangle it.
	 */
	readonly keyDefaultRowDescriptor?: RowDescriptor;
}

/**
 * The substrate node for view-/materialized-view-mediated DML.
 *
 * A view mutation decomposes into an ordered list of base-table operations
 * (`propagate()` in `planner/mutation/propagate.ts`, or the multi-source insert
 * builder). Each base op is built into a *fully-formed* base-table DML subtree by
 * the ordinary base-table builder, so every constraint / conflict / FK /
 * mutation-context / RETURNING-rejection rule is reused verbatim. The
 * `ViewMutation` node sequences those subtrees.
 *
 * For the single-source case the list holds exactly one entry (today's rewrite
 * output, wrapped). Multi-source update/delete ordering rides the same list
 * (sequenced in the order `propagate` emits). Multi-source **insert** additionally
 * carries an {@link MutationEnvelope}: the emitter materializes it once and stashes
 * its rows in context, then drives the base ops, each of which reads the shared
 * surrogate back through an `EnvelopeScanNode`.
 *
 * **RETURNING-through-view.** A view mutation with a `returning` clause yields the
 * view-projected post-mutation rows, so the node is **relational** (its row type /
 * attributes are the view's projected columns). There are two shapes:
 *   - *single-source*: the RETURNING clause is rewritten into base terms and
 *     attached to the (sole) base op, which then plans to a relational
 *     `ReturningNode`. No separate {@link returning} child — the emitter surfaces
 *     that base op's rows (NEW for insert/update, OLD for delete — post-mutation by
 *     construction). {@link returning} is undefined; {@link resultRelation} finds
 *     the relational base op.
 *   - *multi-source* update/delete: the view row spans both base tables, so the
 *     rows are produced by a separate {@link returning} relation — a re-query of
 *     the view restricted to the mutation's predicate — evaluated **before** the
 *     base ops for a delete (the rows are about to disappear) or **after** for an
 *     update ({@link returningTiming}).
 *
 * Without a `returning` clause the node is a void side-effect statement (like
 * {@link SinkNode}): the emitter drains each base op in list order and yields
 * nothing, and {@link getType} reports the scalar affected-row shape.
 */
export class ViewMutationNode extends PlanNode {
	override readonly nodeType = PlanNodeType.ViewMutation;

	constructor(
		scope: Scope,
		/**
		 * Ordered base-table DML subtrees the view/MV mutation decomposes into.
		 * Single-source = exactly one (the retired-rewrite output, wrapped). When a
		 * single-source mutation carries RETURNING, that one base op is a relational
		 * `ReturningNode` (the rewritten view-projected clause).
		 */
		public readonly baseOps: readonly PlanNode[],
		/**
		 * Separate RETURNING relation producing the view-projected rows — set only
		 * for a **multi-source** update/delete RETURNING (the view row spans both
		 * base tables, so a re-query of the view supplies it). Single-source
		 * RETURNING leaves this undefined and surfaces the relational base op
		 * instead. When set, it is threaded through `getChildren`/`getRelations`/
		 * `withChildren` and drives `getType`/`getAttributes`.
		 */
		public readonly returning?: RelationalPlanNode,
		/**
		 * The shared-surrogate envelope for a multi-source insert (undefined for
		 * single-source spines and multi-source update/delete).
		 */
		public readonly envelope?: MutationEnvelope,
		/**
		 * When {@link returning} is set, whether it is captured `pre` (before the
		 * base ops — a delete, whose rows vanish) or `post` (after — an update,
		 * whose post-mutation image the re-query reads). Ignored when `returning`
		 * is undefined.
		 */
		public readonly returningTiming?: ReturningTiming,
		/**
		 * The up-front base-PK identity capture for a multi-source **update** or
		 * multi-side **delete** fan-out: its `source` is materialized into context
		 * **before** the base ops run, and read back by `descriptor` by the multi-side
		 * base ops' identifying subqueries and/or the post-mutation {@link returning}
		 * re-query. Set whenever a multi-source update assigns both sides (⇒ more than
		 * one base op) or carries RETURNING, or a lenient delete fans out to both sides
		 * (⇒ more than one base op); absent for single-source, single-side delete
		 * (whose RETURNING re-queries the view `pre`), and the void/insert paths.
		 */
		public readonly identityCapture?: IdentityCapture,
		/**
		 * Additional identity captures materialized **after** {@link identityCapture}, in
		 * array order, **before** the base ops. Each entry's `source` may scan a
		 * STRICTLY-earlier capture's materialized rows (the primary {@link identityCapture}
		 * or an earlier `nestedCaptures` entry, read back through an
		 * `InternalRecursiveCTERefNode` carrying that capture's descriptor) — so they
		 * materialize in list order (primary → nested[0] → nested[1] → …) and tear down in
		 * reverse. A nested source may depend only on a strictly-earlier capture, never a
		 * later one or itself.
		 *
		 * Load-bearing for the set-op multi-source leg compose, where a join branch's inner
		 * base-PK capture chains off the outer set-op capture (its `memberExists` predicate
		 * scans the outer capture's `__vmupd_keys`). Empty / undefined for every other
		 * producer — a single-capture (or capture-free) statement lowers and runs
		 * byte-identically to the pre-list substrate.
		 *
		 * The list is independent of {@link identityCapture}: although the set-op use always
		 * has the outer capture as the primary, the emitter orders materialization off
		 * whatever captures are present (primary-then-nested), so a `nestedCaptures` with no
		 * primary is handled cleanly too.
		 */
		public readonly nestedCaptures?: readonly IdentityCapture[],
	) {
		// Self-cost only: every base op (and the returning re-query / capture /
		// envelope children) is in getChildren(), so their subtree costs flow in via
		// getTotalCost(). Self is the fixed mutation-sequencing overhead. (Previously
		// only baseOps were folded, so the other children were under-counted.)
		super(scope, 0.1);
		if (baseOps.length === 0) {
			throw new QuereusError('ViewMutationNode requires at least one base operation', StatusCode.INTERNAL);
		}
	}

	/**
	 * The relation whose rows this mutation yields, or `undefined` when it is a
	 * void side-effect statement. A separate {@link returning} re-query wins;
	 * otherwise a relational base op (single-source RETURNING rewritten onto the
	 * base op) is surfaced.
	 */
	resultRelation(): RelationalPlanNode | undefined {
		if (this.returning) return this.returning;
		return this.baseOps.find(isRelationalNode);
	}

	getType(): RelationType | ScalarType {
		const result = this.resultRelation();
		if (result) {
			// RETURNING-through-view: the row type is the view's projected columns.
			return result.getType();
		}
		// A void view mutation is a side-effect statement: like SinkNode it reports
		// the affected-row count.
		return {
			typeClass: 'scalar',
			isReadOnly: true,
			logicalType: INTEGER_TYPE,
			nullable: false,
		};
	}

	/** The view-projected RETURNING attributes, or `[]` for a void mutation. */
	getAttributes(): readonly Attribute[] {
		return this.resultRelation()?.getAttributes() ?? [];
	}

	/** Extra (non-base-op) plan children: the envelope source + optional key-default expr. */
	private envelopeChildren(): PlanNode[] {
		if (!this.envelope) return [];
		return this.envelope.keyDefault
			? [this.envelope.source, this.envelope.keyDefault]
			: [this.envelope.source];
	}

	getChildren(): readonly PlanNode[] {
		// Order: base ops, then the optional RETURNING re-query, then the optional
		// primary identity-capture source, then the nested-capture sources (in list
		// order), then the envelope children. `withChildren` slices back in this same
		// order, and the emitter threads its params identically.
		return [
			...this.baseOps,
			...(this.returning ? [this.returning] : []),
			...(this.identityCapture ? [this.identityCapture.source] : []),
			...(this.nestedCaptures ?? []).map(c => c.source),
			...this.envelopeChildren(),
		];
	}

	getRelations(): readonly RelationalPlanNode[] {
		// Mirrors BlockNode: the base ops are Sink-topped DML statements, not
		// relational inputs, so they are excluded here (the optimizer and the
		// change-scope / binding walks descend via getChildren). A relational base
		// op — a single-source RETURNING op — surfaces, as does the separate
		// multi-source RETURNING re-query, so the attribute-provenance walk treats
		// this node's forwarded RETURNING attributes as forwarded (not originated).
		// The identity-capture source (like the envelope source) is a side input
		// materialized into context, not part of this node's forwarded output, so it
		// is excluded — only reachable via getChildren for optimization/withChildren.
		// The nested-capture sources are excluded for the same reason: each is a side
		// input materialized into context (after the primary capture), never a forwarded
		// relation. (Holds for the both-sides void update too: its base ops are
		// Sink-topped, so the node stays void and no capture source is forwarded.)
		const rels = this.baseOps.filter(isRelationalNode);
		if (this.returning) rels.push(this.returning);
		return rels;
	}

	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		let cursor = this.baseOps.length;
		const newBaseOps = newChildren.slice(0, cursor);

		let newReturning = this.returning;
		if (this.returning) {
			newReturning = newChildren[cursor] as RelationalPlanNode;
			cursor += 1;
		}

		let newCapture = this.identityCapture;
		if (this.identityCapture) {
			const newCaptureSource = newChildren[cursor] as RelationalPlanNode;
			cursor += 1;
			newCapture = { source: newCaptureSource, descriptor: this.identityCapture.descriptor };
		}

		// Slice the nested-capture sources back in the same order getChildren laid them
		// out, rebuilding each IdentityCapture with its PRESERVED descriptor (the readers
		// bind to the descriptor by identity — minting a fresh `{}` would orphan them).
		let newNestedCaptures = this.nestedCaptures;
		if (this.nestedCaptures && this.nestedCaptures.length > 0) {
			newNestedCaptures = this.nestedCaptures.map(c => {
				const source = newChildren[cursor] as RelationalPlanNode;
				cursor += 1;
				return { source, descriptor: c.descriptor };
			});
		}

		let newEnvelope = this.envelope;
		if (this.envelope) {
			const newSource = newChildren[cursor] as RelationalPlanNode;
			cursor += 1;
			const newKeyDefault = this.envelope.keyDefault ? newChildren[cursor] as ScalarPlanNode : undefined;
			newEnvelope = {
				source: newSource,
				descriptor: this.envelope.descriptor,
				keyDefault: newKeyDefault,
				keyDefaultRowDescriptor: this.envelope.keyDefaultRowDescriptor,
			};
		}

		const unchanged = newChildren.length === this.getChildren().length
			&& newBaseOps.every((child, i) => child === this.baseOps[i])
			&& newReturning === this.returning
			&& (!this.identityCapture || newCapture!.source === this.identityCapture.source)
			&& (!this.nestedCaptures || this.nestedCaptures.every((c, i) => newNestedCaptures![i].source === c.source))
			&& (!this.envelope || (newEnvelope!.source === this.envelope.source
				&& newEnvelope!.keyDefault === this.envelope.keyDefault));
		if (unchanged) {
			return this;
		}
		return new ViewMutationNode(this.scope, newBaseOps, newReturning, newEnvelope, this.returningTiming, newCapture, newNestedCaptures);
	}

	get estimatedRows(): number | undefined {
		return this.resultRelation()?.estimatedRows ?? 1;
	}

	computePhysical(): Partial<PhysicalProperties> {
		return {
			readonly: false, // drives base-table writes
			idempotent: false,
			deterministic: false,
		};
	}

	override toString(): string {
		const env = this.envelope ? ` +envelope${this.envelope.keyDefault ? '(default)' : ''}` : '';
		// Show a `+capture(<primary>+<nested>)` breakdown when nested captures chain off
		// the primary; keep the bare `+capture` for the common single-capture case.
		const nestedCount = this.nestedCaptures?.length ?? 0;
		const cap = nestedCount > 0
			? ` +capture(${this.identityCapture ? 1 : 0}+${nestedCount})`
			: this.identityCapture ? ' +capture' : '';
		const ret = this.resultRelation() ? ` returning${this.returning ? `(${this.returningTiming})` : ''}` : '';
		return `VIEW MUTATION (${this.baseOps.length} base op${this.baseOps.length === 1 ? '' : 's'}${env}${cap}${ret})`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			baseOps: this.baseOps.length,
			envelope: this.envelope ? (this.envelope.keyDefault ? 'default' : 'shared') : undefined,
			identityCapture: this.identityCapture ? 'identity' : undefined,
			nestedCaptures: this.nestedCaptures && this.nestedCaptures.length > 0 ? this.nestedCaptures.length : undefined,
			returning: this.resultRelation() ? (this.returning ? `requery(${this.returningTiming})` : 'base-op') : undefined,
		};
	}
}

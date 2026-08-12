import { PlanNodeType } from './plan-node-type.js';
import { PlanNode, type Attribute, type RelationalPlanNode, type UnaryRelationalNode, type ScalarPlanNode, type PhysicalProperties, type MonotonicOnInfo } from './plan-node.js';
import type { WindowFunctionCallNode } from './window-function.js';
import type { RelationType } from '../../common/datatype.js';
import type { Scope } from '../scopes/scope.js';
import { Cached } from '../../util/cached.js';
import type * as AST from '../../parser/ast.js';
import { quereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import { ColumnReferenceNode } from './reference.js';
import { isUniqueDeterminant } from '../util/fd-utils.js';
import { physicalSourceRows } from '../util/row-estimates.js';
import { extractOrderingFromSortKeys } from '../framework/physical-utils.js';

export interface WindowSpec {
	partitionBy: AST.Expression[];
	orderBy: AST.OrderByClause[];
	frame?: AST.WindowFrame;
}

/**
 * Per-function streaming mode chosen by `rule-monotonic-window`. Indexed
 * parallel to `WindowNode.functions`.
 *
 *   - rowNumber / rank / denseRank — single counter + last-key state.
 *   - lag / lead — ring/read-ahead buffer with a literal offset and default value.
 *   - firstValue — caches the first row's expression for the partition.
 *   - lastValue — under the streaming default frame (`UNBOUNDED PRECEDING TO
 *     CURRENT ROW`) `LAST_VALUE(expr)` is `expr` evaluated on the current row.
 *   - runningAgg — fold via the registered step/final hooks (default frame only).
 *   - slidingAgg — `SUM/COUNT/AVG/MIN/MAX/FIRST_VALUE/LAST_VALUE` over a sliding
 *     frame of the form `ROWS BETWEEN n PRECEDING AND m FOLLOWING` (literal `n`,
 *     `m`, both ≥ 0) or `RANGE BETWEEN <num> PRECEDING AND <num> FOLLOWING`
 *     (single numeric ORDER BY, literal non-negative offsets).
 */
export type StreamingWindowFunctionMode =
	| { kind: 'rowNumber' }
	| { kind: 'rank' }
	| { kind: 'denseRank' }
	| { kind: 'lag'; offset: number }
	| { kind: 'lead'; offset: number }
	| { kind: 'firstValue' }
	| { kind: 'lastValue' }
	| { kind: 'runningAgg' }
	| {
		kind: 'slidingAgg';
		/** Underlying aggregate / value function name (lower-case). */
		name: 'sum' | 'count' | 'avg' | 'min' | 'max' | 'first_value' | 'last_value';
		frameMode: 'rows' | 'range';
		/** Non-negative integer literal, in both frame modes. `CURRENT ROW` is 0. */
		preceding: number;
		/** Same constraints as preceding. */
		following: number;
	};

/**
 * Marker added to a `WindowNode` by `rule-monotonic-window` when the source's
 * emit order already covers `[PARTITION BY..., ORDER BY[0]]`. Drives the
 * runtime's streaming emitter and signals to `computePhysical()` that the
 * window output preserves the source's `monotonicOn` unchanged.
 */
export interface StreamingWindowConfig {
	readonly modes: ReadonlyArray<StreamingWindowFunctionMode>;
}

/**
 * Represents a window operation that computes window functions over partitions of rows.
 * This node groups window functions that share the same window specification for efficiency.
 */
export class WindowNode extends PlanNode implements UnaryRelationalNode {
	override readonly nodeType = PlanNodeType.Window;

	private outputTypeCache: Cached<RelationType>;
	private attributesCache: Cached<Attribute[]>;

	constructor(
		scope: Scope,
		public readonly source: RelationalPlanNode,
		public readonly windowSpec: WindowSpec,
		public readonly functions: WindowFunctionCallNode[],
		public readonly partitionExpressions: ScalarPlanNode[],
		public readonly orderByExpressions: ScalarPlanNode[],
		public readonly functionArguments: ScalarPlanNode[][],
		estimatedCostOverride?: number,
		/**
		 * The WINDOW-GENERATED output attributes (one per function), supplied by
		 * `withChildren`/`withStreaming` so a window result column keeps ONE attribute
		 * id for the whole life of the plan. Only these are carried — the pass-through
		 * source attributes are always taken from the CURRENT source, so an optimizer
		 * rewrite of the source (AggregateNode → HashAggregate, an inserted Retrieve)
		 * cannot orphan the ids the projection above references.
		 */
		public readonly predefinedWindowAttributes?: Attribute[],
		/** Set by `rule-monotonic-window` when the source streams in window order. */
		public readonly streaming?: StreamingWindowConfig,
	) {
		super(scope, estimatedCostOverride);

		this.outputTypeCache = new Cached(() => {
			const sourceType = this.source.getType();

			// Add window function columns to the source columns
			const windowColumns = this.functions.map(func => ({
				name: func.alias || func.functionName.toLowerCase(),
				type: func.getType(),
				generated: true
			}));

			return {
				typeClass: 'relation',
				isReadOnly: sourceType.isReadOnly,
				isSet: sourceType.isSet, // Window functions preserve set/bag semantics
				columns: [...sourceType.columns, ...windowColumns],
				keys: sourceType.keys, // Window functions don't change key structure
				rowConstraints: sourceType.rowConstraints,
			} satisfies RelationType;
		});

		this.attributesCache = new Cached(() => {
			// Pass-through attributes always come from the CURRENT source; only the
			// window-generated tail is preserved (or minted once, at build time).
			const sourceAttrs = this.source.getAttributes();
			const windowAttrs = this.predefinedWindowAttributes
				?? this.functions.map((func) => ({
					id: PlanNode.nextAttrId(),
					name: func.alias || func.functionName.toLowerCase(),
					type: func.getType(),
					sourceRelation: `${this.nodeType}:${this.id}`
				}));

			return [...sourceAttrs, ...windowAttrs];
		});
	}

	getType(): RelationType {
		return this.outputTypeCache.value;
	}

	getAttributes(): Attribute[] {
		return this.attributesCache.value;
	}

	/**
	 * The window-generated output attributes (one per function, parallel to
	 * `functions`), excluding the pass-through source attributes. This is the list
	 * `withChildren`/`withStreaming` carry across rebuilds, and the list the window
	 * phase records so the projection above addresses each window result by
	 * attribute id.
	 */
	getWindowAttributes(): Attribute[] {
		return this.getAttributes().slice(this.source.getAttributes().length);
	}

	getChildren(): readonly PlanNode[] {
		return [
			// Include *both* the relational source and all scalar expression children so
			// that generic optimizer passes (e.g. access-path selection) can traverse
			// into the relational subtree.
			this.source,

			// Scalar expressions: partition expressions, order-by expressions, and
			// all function arguments (flattened from per-function arrays)
			...this.partitionExpressions,
			...this.orderByExpressions,
			...this.functionArguments.flat()
		];
	}

	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		const totalFuncArgs = this.functionArguments.reduce((sum, args) => sum + args.length, 0);
		const expectedLength = 1 + // relational source
			this.partitionExpressions.length +
			this.orderByExpressions.length +
			totalFuncArgs;

		if (newChildren.length !== expectedLength) {
			quereusError(`WindowNode expects ${expectedLength} children, got ${newChildren.length}`, StatusCode.INTERNAL);
		}

		// First child is the relational *source*.
		const newSource = newChildren[0] as RelationalPlanNode;
		let childIndex = 1;

		// Remaining children are scalar expressions.
		const newPartitionExpressions = newChildren.slice(childIndex, childIndex + this.partitionExpressions.length) as ScalarPlanNode[];
		childIndex += this.partitionExpressions.length;

		const newOrderByExpressions = newChildren.slice(childIndex, childIndex + this.orderByExpressions.length) as ScalarPlanNode[];
		childIndex += this.orderByExpressions.length;

		// Rebuild per-function argument arrays using original arg counts
		const newFunctionArguments: ScalarPlanNode[][] = [];
		for (const args of this.functionArguments) {
			newFunctionArguments.push(newChildren.slice(childIndex, childIndex + args.length) as ScalarPlanNode[]);
			childIndex += args.length;
		}

		// Detect changes
		const sourceChanged = newSource !== this.source;
		const partitionChanged = newPartitionExpressions.some((expr, i) => expr !== this.partitionExpressions[i]);
		const orderByChanged = newOrderByExpressions.some((expr, i) => expr !== this.orderByExpressions[i]);
		const functionArgsChanged = newFunctionArguments.some((funcArgs, fi) =>
			funcArgs.some((arg, ai) => arg !== this.functionArguments[fi][ai])
		);

		if (!sourceChanged && !partitionChanged && !orderByChanged && !functionArgsChanged) {
			return this;
		}

		return new WindowNode(
			this.scope,
			newSource,
			this.windowSpec,
			this.functions,
			newPartitionExpressions,
			newOrderByExpressions,
			newFunctionArguments,
			undefined,
			// **CRITICAL**: always carry the window-generated attribute ids — the
			// projection above references them, so they must survive even (especially)
			// when the optimizer replaces the source. Pass-through attributes are
			// recomputed from the new source.
			this.getWindowAttributes(),
			this.streaming,
		);
	}

	/** Return a new WindowNode with the given streaming config attached. */
	withStreaming(config: StreamingWindowConfig): WindowNode {
		return new WindowNode(
			this.scope,
			this.source,
			this.windowSpec,
			this.functions,
			this.partitionExpressions,
			this.orderByExpressions,
			this.functionArguments,
			undefined,
			this.getWindowAttributes(),
			config,
		);
	}

	getRelations(): readonly [RelationalPlanNode] {
		return [this.source];
	}

	/**
	 * The window's ORDER BY expressed as sort keys, in the shape
	 * `extractOrderingFromSortKeys` expects. `AST.OrderByClause.direction` is
	 * optional; anything that is not `'desc'` is ascending — the same reading
	 * `rule-monotonic-window` and the `monotonicOn` derivation use.
	 */
	private windowSortKeys(): { expression: ScalarPlanNode; direction: 'asc' | 'desc' }[] {
		return this.orderByExpressions.map((expression, i) => ({
			expression,
			direction: this.windowSpec.orderBy[i]?.direction === 'desc' ? 'desc' : 'asc',
		}));
	}

	computePhysical(childrenPhysical: PhysicalProperties[]): Partial<PhysicalProperties> {
		const sourcePhysical = childrenPhysical[0];

		// `ordering` (the exact emit order) and `monotonicOn` (the stronger
		// per-attribute claim) come out of ONE split over [streaming, PARTITION BY,
		// ORDER BY], so they cannot drift apart from each other or from what
		// `runtime/emit/window.ts` yields. The four cases and the emitter function
		// behind each are tabulated in docs/window-functions.md § "What the
		// WindowNode advertises as its emit order".
		// Column indices from `extractOrderingFromSortKeys` are positions in the
		// SOURCE row; the window only APPENDS columns, so they need no shifting.
		// NOTE: like SortNode, the derived `ordering` carries no NULLS FIRST/LAST
		// information — it is `{ column, desc }` only. Harmless while every ordering
		// consumer is null-placement-blind (merge join skips NULL keys wherever they
		// land); if one is ever taught to honour an explicit `nulls`, this derivation
		// and SortNode's must both withhold the ordering when `windowSpec.orderBy[i]
		// .nulls` contradicts that consumer's convention.
		// TODO: the partitioned case can be tightened (e.g. when the partition keys
		// themselves are functionally determined by the candidate attribute) — out
		// of scope for the carrier ticket.
		let ordering: { column: number; desc: boolean }[] | undefined;
		let monotonicOn: readonly MonotonicOnInfo[] | undefined;
		if (this.streaming) {
			// Row pass-through: emitted in source order.
			ordering = sourcePhysical?.ordering;
			monotonicOn = sourcePhysical?.monotonicOn;
		} else if (this.partitionExpressions.length === 0) {
			if (this.orderByExpressions.length === 0) {
				// Buffered, but nothing to sort by — still source order.
				ordering = sourcePhysical?.ordering;
				monotonicOn = sourcePhysical?.monotonicOn;
			} else {
				// Sorted by the window's ORDER BY; the source's order is gone.
				const sourceAttrs = this.source.getAttributes();
				ordering = extractOrderingFromSortKeys(this.windowSortKeys(), sourceAttrs);

				const leadExpr = this.orderByExpressions[0];
				if (leadExpr instanceof ColumnReferenceNode) {
					const leadAttrId = leadExpr.attributeId;
					const leadIdx = this.source.getAttributeIndex().get(leadAttrId) ?? -1;
					if (leadIdx >= 0) {
						const direction = this.windowSpec.orderBy[0]?.direction === 'desc' ? 'desc' : 'asc';
						const strict = isUniqueDeterminant(new Set([leadIdx]), sourcePhysical?.fds, sourceAttrs.length, this.source.getType().isSet);
						monotonicOn = [{ attrId: leadAttrId, direction, strict }];
					}
				}
			}
		}
		// Buffered with a PARTITION BY falls through: whole partitions emit in
		// first-seen order, so neither claim survives and both stay undefined.

		return {
			// Window functions don't change the row count — relay the PHYSICAL one.
			estimatedRows: physicalSourceRows(sourcePhysical, this.source),
			ordering,
			monotonicOn,
			// Window functions append columns but don't change the source row stream;
			// FDs, equivalence classes, and constant bindings pass through on the
			// source columns. (Window output columns are not in any new FDs — deferred.)
			fds: sourcePhysical?.fds,
			equivClasses: sourcePhysical?.equivClasses,
			constantBindings: sourcePhysical?.constantBindings,
			domainConstraints: sourcePhysical?.domainConstraints,
		};
	}

	get estimatedRows(): number | undefined {
		return this.source.estimatedRows; // Window functions don't change row count
	}

	override toString(): string {
		const partitionClause = this.windowSpec.partitionBy.length > 0
			? `PARTITION BY ${this.windowSpec.partitionBy.map(_e => '...').join(', ')}`
			: '';
		const orderClause = this.windowSpec.orderBy.length > 0
			? `ORDER BY ${this.windowSpec.orderBy.map(_o => '...').join(', ')}`
			: '';
		const clauses = [partitionClause, orderClause].filter(c => c).join(' ');
		const funcNames = this.functions.map(f => f.functionName).join(', ');

		return `WINDOW ${funcNames} OVER (${clauses})`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		const attrs: Record<string, unknown> = {
			windowSpec: {
				partitionBy: this.windowSpec.partitionBy.length,
				orderBy: this.windowSpec.orderBy.length,
				frame: this.windowSpec.frame ? 'custom' : 'default'
			},
			functions: this.functions.map(f => ({
				name: f.functionName,
				alias: f.alias,
				distinct: f.isDistinct
			}))
		};
		if (this.streaming) {
			attrs.streaming = {
				modes: this.streaming.modes.map(m => m.kind),
			};
		}
		return attrs;
	}
}

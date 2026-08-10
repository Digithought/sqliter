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
		/** Optional predefined attributes for preserving IDs during optimization */
		public readonly predefinedAttributes?: Attribute[],
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
			// If predefined attributes are provided, use them (for optimization)
			if (this.predefinedAttributes) {
				return this.predefinedAttributes.slice(); // Return a copy
			}

			// Preserve source attributes and add window function attributes
			const sourceAttrs = this.source.getAttributes();
			const windowAttrs = this.functions.map((func) => ({
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

		// **CRITICAL**: Preserve original attribute IDs to maintain column reference stability
		const originalAttributes = this.getAttributes();

		return new WindowNode(
			this.scope,
			newSource,
			this.windowSpec,
			this.functions,
			newPartitionExpressions,
			newOrderByExpressions,
			newFunctionArguments,
			undefined,
			// Preserve attributes only when the source is unchanged so that column IDs
			// stay consistent. If the source relation changed, let the WindowNode rebuild
			// its attribute list so that descriptors match the new underlying schema.
			sourceChanged ? undefined : originalAttributes,
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
			this.getAttributes() as Attribute[],
			config,
		);
	}

	getRelations(): readonly [RelationalPlanNode] {
		return [this.source];
	}

	computePhysical(childrenPhysical: PhysicalProperties[]): Partial<PhysicalProperties> {
		const sourcePhysical = childrenPhysical[0];

		// Window output ordering is determined by [PARTITION BY, ORDER BY]:
		//   - streaming set: the runtime walks the source in source order and emits
		//     in source order — windowing is row-pass-through. Source's monotonicOn
		//     survives unchanged.
		//   - PARTITION BY non-empty (buffered): the runtime groups rows by partition
		//     key in insertion order then sorts within each partition, so a
		//     single-attribute monotonicOn does not survive at the relation level.
		//   - PARTITION BY empty, ORDER BY present (buffered): output is sorted by
		//     the window's ORDER BY — derive monotonicOn from the leading key
		//     (mirrors SortNode).
		//   - PARTITION BY empty, ORDER BY empty: rows pass through in source order;
		//     preserve source's monotonicOn unchanged.
		// TODO: the partitioned case can be tightened (e.g. when the partition keys
		// themselves are functionally determined by the candidate attribute) — out
		// of scope for the carrier ticket.
		let monotonicOn: readonly MonotonicOnInfo[] | undefined;
		if (this.streaming) {
			monotonicOn = sourcePhysical?.monotonicOn;
		} else if (this.partitionExpressions.length === 0) {
			if (this.orderByExpressions.length === 0) {
				monotonicOn = sourcePhysical?.monotonicOn;
			} else {
				const leadExpr = this.orderByExpressions[0];
				if (leadExpr instanceof ColumnReferenceNode) {
					const sourceAttrs = this.source.getAttributes();
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

		return {
			// Window functions don't change the row count — relay the PHYSICAL one.
			estimatedRows: physicalSourceRows(sourcePhysical, this.source),
			ordering: sourcePhysical?.ordering,
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

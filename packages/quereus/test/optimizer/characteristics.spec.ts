/**
 * Tests for characteristics-based plan node analysis
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it } from 'mocha';
import { expect } from 'chai';
import {
	PlanNodeCharacteristics,
	CapabilityDetectors,
	CachingAnalysis
} from '../../src/planner/framework/characteristics.js';
import type { PlanNode } from '../../src/planner/nodes/plan-node.js';
import type { Scope } from '../../src/planner/scopes/scope.js';
import { AggregateNode } from '../../src/planner/nodes/aggregate-node.js';
import { StreamAggregateNode } from '../../src/planner/nodes/stream-aggregate.js';
import { HashAggregateNode } from '../../src/planner/nodes/hash-aggregate.js';
import { JoinNode } from '../../src/planner/nodes/join-node.js';
import { MergeJoinNode } from '../../src/planner/nodes/merge-join-node.js';
import { BloomJoinNode } from '../../src/planner/nodes/bloom-join-node.js';
import { FilterNode } from '../../src/planner/nodes/filter.js';
import { SortNode } from '../../src/planner/nodes/sort.js';
import { LimitOffsetNode } from '../../src/planner/nodes/limit-offset.js';
import { ProjectNode } from '../../src/planner/nodes/project-node.js';
import { CacheNode } from '../../src/planner/nodes/cache-node.js';
import { CTENode } from '../../src/planner/nodes/cte-node.js';
import { TableReferenceNode, ColumnReferenceNode } from '../../src/planner/nodes/reference.js';
import { SeqScanNode } from '../../src/planner/nodes/table-access-nodes.js';
import { WindowFunctionCallNode } from '../../src/planner/nodes/window-function.js';
import { AggregateFunctionCallNode } from '../../src/planner/nodes/aggregate-function.js';
import { ScalarFunctionCallNode } from '../../src/planner/nodes/function.js';
import { InternalRecursiveCTERefNode } from '../../src/planner/nodes/internal-recursive-cte-ref-node.js';
import { FunctionFlags } from '../../src/common/constants.js';
import type { AggregateFunctionSchema, ScalarFunctionSchema } from '../../src/schema/function.js';
import type * as AST from '../../src/parser/ast.js';

describe('PlanNodeCharacteristics', () => {
	describe('Physical Properties', () => {
		it('should provide utility methods for physical property analysis', () => {
			// Mock node with physical properties
			const mockNode = {
				physical: {
					readonly: true,
					deterministic: true,
					idempotent: true,
					constant: false,
					estimatedRows: 1000
				}
			} as PlanNode;

			expect(PlanNodeCharacteristics.hasSideEffects(mockNode)).to.be.false;
			expect(PlanNodeCharacteristics.isReadOnly(mockNode)).to.be.true;
			expect(PlanNodeCharacteristics.isDeterministic(mockNode)).to.be.true;
			expect(PlanNodeCharacteristics.estimatesRows(mockNode)).to.equal(1000);
		});

		it('should detect expensive operations based on row estimates', () => {
			const expensiveNode = {
				physical: { estimatedRows: 50000 }
			} as PlanNode;

			const cheapNode = {
				physical: { estimatedRows: 100 }
			} as PlanNode;

			expect(PlanNodeCharacteristics.isExpensive(expensiveNode)).to.be.true;
			expect(PlanNodeCharacteristics.isExpensive(cheapNode)).to.be.false;
		});
	});
});

describe('CapabilityDetectors', () => {
	it('detects a capability by its brand, not by method shape', () => {
		// A node carrying the brand is detected...
		const predicateNode = {
			isPredicateCapable: true,
			getPredicate: () => null,
			withPredicate: (_pred: any) => predicateNode
		} as any;

		// ...while a look-alike that has the methods but NOT the brand is rejected.
		// This is the whole point of branding: "is detected" == "declared implementer".
		const lookAlike = {
			getPredicate: () => null,
			withPredicate: (_pred: any) => lookAlike
		} as any;

		const regularNode = {} as PlanNode;

		expect(CapabilityDetectors.canPushDownPredicate(predicateNode)).to.be.true;
		expect(CapabilityDetectors.canPushDownPredicate(lookAlike)).to.be.false;
		expect(CapabilityDetectors.canPushDownPredicate(regularNode)).to.be.false;
	});
});

describe('CachingAnalysis', () => {
	it('should calculate appropriate cache thresholds', () => {
		const node = {
			physical: { estimatedRows: 5000 }
		} as PlanNode;

		const threshold = CachingAnalysis.getCacheThreshold(node);
		expect(threshold).to.be.a('number');
		expect(threshold).to.be.greaterThan(0);
	});
});

describe('Characteristics-Based Benefits', () => {
	it('should enable type-safe capability detection', () => {
		// Mock aggregation-capable node — carries the brand.
		const aggregateNode = {
			isAggregationCapable: true,
			getType: () => ({ typeClass: 'relation' }),
			getGroupingKeys: () => [],
			getAggregateExpressions: () => []
		} as any;

		const regularNode = {
			getType: () => ({ typeClass: 'scalar' })
		} as any;

		expect(CapabilityDetectors.isAggregating(aggregateNode)).to.be.true;
		expect(CapabilityDetectors.isAggregating(regularNode)).to.be.false;
	});

	it('should detect any node that declares the capability brand, not just AggregateNode', () => {
		// A non-standard class is detected iff it carries the brand — the brand IS the
		// contract, so a custom node opts in by setting it (post-branding; the old
		// duck-typed detection accepted the method shape alone).
		class CustomAggregateNode {
			readonly isAggregationCapable = true as const;
			getType() {
				return { typeClass: 'relation' as const };
			}

			getGroupingKeys() {
				return [];
			}

			getAggregateExpressions() {
				return [];
			}
		}

		const customNode = new CustomAggregateNode();
		expect(CapabilityDetectors.isAggregating(customNode as any)).to.be.true;

		// The same class WITHOUT the brand is not detected.
		const unbranded = { getGroupingKeys: () => [], getAggregateExpressions: () => [] } as any;
		expect(CapabilityDetectors.isAggregating(unbranded)).to.be.false;
	});
});

// ---------------------------------------------------------------------------
// Behavior preservation: every branded guard must accept exactly the real
// implementer set the old duck-typed guard accepted (no more, no less). We
// construct one real instance of each implementer and assert `true`, then a
// structurally-similar sibling (a real node that is NOT that capability) and
// assert `false`. The base-class-less aggregate family (AggregateNode plus the
// physical StreamAggregate/HashAggregate) is the case a naive
// `instanceof AggregateNode` guard would have silently broken.
// ---------------------------------------------------------------------------

describe('CapabilityDetectors — brand behavior preservation', () => {
	const mockScope = { resolveSymbol: () => undefined } as unknown as Scope;
	const scalarRet = { typeClass: 'scalar', logicalType: {}, nullable: true, isReadOnly: true } as any;

	/** Minimal relational source: enough surface for the constructors under test. */
	function relSource(): any {
		return {
			nodeType: 'MockRel',
			estimatedRows: 100,
			getType: () => ({ typeClass: 'relation', columns: [], keys: [], rowConstraints: [], isReadOnly: true, isSet: false }),
			getAttributes: () => [],
			getAttributeIndex: () => new Map(),
			getChildren: () => [],
			getRelations: () => [],
			physical: {},
		};
	}

	const src = relSource();
	const scalarPredicate = { nodeType: 'MockScalar', expression: {}, getType: () => ({ typeClass: 'scalar' }) } as any;
	const funcExpr = { type: 'function', name: 'count', args: [], distinct: false } as AST.FunctionExpr;
	const aggSchema: AggregateFunctionSchema = {
		name: 'count', numArgs: 0, flags: FunctionFlags.DETERMINISTIC, returnType: scalarRet,
		stepFunction: (acc: number) => acc + 1,
		finalizeFunction: (acc: number) => acc,
	};
	const scalarSchema: ScalarFunctionSchema = {
		name: 'abs', numArgs: 1, flags: FunctionFlags.DETERMINISTIC, returnType: scalarRet,
		implementation: (v: any) => v,
	};

	// One real instance of each capability implementer.
	const aggregate = new AggregateNode(mockScope, src, [], []);
	const streamAgg = new StreamAggregateNode(mockScope, src, [], []);
	const hashAgg = new HashAggregateNode(mockScope, src, [], []);
	const join = new JoinNode(mockScope, src, src, 'inner');
	const mergeJoin = new MergeJoinNode(mockScope, src, src, 'inner', []);
	const bloomJoin = new BloomJoinNode(mockScope, src, src, 'inner', []);
	const filter = new FilterNode(mockScope, src, scalarPredicate);
	const sort = new SortNode(mockScope, src, []);
	const limit = new LimitOffsetNode(mockScope, src, undefined, undefined);
	const project = new ProjectNode(mockScope, src, []);
	const cache = new CacheNode(mockScope, src);
	const cte = new CTENode(mockScope, 'c', undefined, src, undefined);
	const tableRef = new TableReferenceNode(mockScope, {} as any, {} as any);
	const seqScan = new SeqScanNode(mockScope, tableRef, { indexInfoOutput: { estimatedCost: 1 } } as any);
	const colRef = new ColumnReferenceNode(mockScope, { type: 'column', name: 'x' } as any, {} as any, 1, 0);
	const windowFn = new WindowFunctionCallNode(mockScope, {} as any, 'row_number');
	const aggFn = new AggregateFunctionCallNode(mockScope, funcExpr, 'count', aggSchema, []);
	const scalarFn = new ScalarFunctionCallNode(mockScope, funcExpr, scalarSchema, []);
	const recursiveRef = new InternalRecursiveCTERefNode(mockScope, 'c', [], {} as any, {});

	it('accepts every real implementer of each capability', () => {
		expect(CapabilityDetectors.isAggregating(aggregate)).to.equal(true);
		expect(CapabilityDetectors.isJoin(join)).to.equal(true);
		expect(CapabilityDetectors.isJoin(mergeJoin)).to.equal(true);
		expect(CapabilityDetectors.isJoin(bloomJoin)).to.equal(true);
		expect(CapabilityDetectors.isPredicateSource(join)).to.equal(true);
		expect(CapabilityDetectors.isPredicateSource(mergeJoin)).to.equal(true);
		expect(CapabilityDetectors.isPredicateSource(bloomJoin)).to.equal(true);
		expect(CapabilityDetectors.isPredicateSource(filter)).to.equal(true);
		expect(CapabilityDetectors.canPushDownPredicate(filter)).to.equal(true);
		expect(CapabilityDetectors.isSortable(sort)).to.equal(true);
		expect(CapabilityDetectors.isLimit(limit)).to.equal(true);
		expect(CapabilityDetectors.canProject(project)).to.equal(true);
		expect(CapabilityDetectors.isCached(cache)).to.equal(true);
		expect(CapabilityDetectors.isCTE(cte)).to.equal(true);
		expect(CapabilityDetectors.isTableAccess(tableRef)).to.equal(true);
		expect(CapabilityDetectors.isColumnBindingProvider(tableRef)).to.equal(true);
		expect(CapabilityDetectors.isTableAccess(seqScan)).to.equal(true); // brand inherited from TableAccessNode base
		expect(CapabilityDetectors.isColumnReference(colRef)).to.equal(true);
		expect(CapabilityDetectors.isWindowFunction(windowFn)).to.equal(true);
		expect(CapabilityDetectors.isAggregateFunction(aggFn)).to.equal(true);
		expect(CapabilityDetectors.isRecursiveCTERef(recursiveRef)).to.equal(true);
	});

	it('recognizes StreamAggregate and HashAggregate as aggregating (base-class-less family)', () => {
		// The exact case a naive `instanceof AggregateNode` guard would silently drop.
		expect(CapabilityDetectors.isAggregating(streamAgg)).to.equal(true);
		expect(CapabilityDetectors.isAggregating(hashAgg)).to.equal(true);
	});

	it('rejects structurally-similar sibling nodes that lack the brand', () => {
		// Real relational nodes that are not that capability.
		expect(CapabilityDetectors.isAggregating(cache)).to.equal(false);
		expect(CapabilityDetectors.isAggregating(filter)).to.equal(false);
		expect(CapabilityDetectors.isJoin(cache)).to.equal(false);
		expect(CapabilityDetectors.isColumnReference(cache)).to.equal(false);
		// A physical table-access node is table-access but NOT a binding provider
		// (only TableReferenceNode carries that brand).
		expect(CapabilityDetectors.isColumnBindingProvider(seqScan)).to.equal(false);
	});

	it('tells aggregate, window, and scalar function calls apart by brand alone', () => {
		// AggregateFunctionCallNode and ScalarFunctionCallNode share
		// nodeType === ScalarFunctionCall; the brand is the sole discriminant.
		expect(CapabilityDetectors.isAggregateFunction(scalarFn)).to.equal(false);
		expect(CapabilityDetectors.isAggregateFunction(windowFn)).to.equal(false);
		expect(CapabilityDetectors.isWindowFunction(aggFn)).to.equal(false);
		expect(CapabilityDetectors.isWindowFunction(scalarFn)).to.equal(false);
	});
});

/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from 'chai';
import { mergeSetOpColumnType, mergeSetOpAdvertisedType } from '../../src/planner/analysis/set-op-type-merge.js';
import { NULL_TYPE, INTEGER_TYPE, REAL_TYPE, NUMERIC_TYPE, TEXT_TYPE, BLOB_TYPE, ANY_TYPE } from '../../src/types/builtin-types.js';
import { JSON_TYPE } from '../../src/types/json-type.js';
import { DATE_TYPE } from '../../src/types/temporal-types.js';
import type { LogicalType } from '../../src/types/logical-type.js';
import { PlanNode, type Attribute, type PhysicalProperties } from '../../src/planner/nodes/plan-node.js';
import { PlanNodeType } from '../../src/planner/nodes/plan-node-type.js';
import type { BaseType, ScalarType } from '../../src/common/datatype.js';
import type { Scope } from '../../src/planner/scopes/scope.js';
import { SetOperationNode } from '../../src/planner/nodes/set-operation-node.js';

describe('set-op-type-merge', () => {
	/** Assert the merge of (a, b) — and, symmetrically, (b, a) — lands on `expected`. */
	function expectMerge(a: LogicalType, b: LogicalType, expected: LogicalType, convert?: 'left' | 'right') {
		const forward = mergeSetOpColumnType(a, b);
		expect(forward.logicalType, `${a.name} ∪ ${b.name}`).to.equal(expected);
		expect(forward.convert, `${a.name} ∪ ${b.name} convert`).to.equal(convert);
		// Order independence: the merged type never changes; the convert side flips.
		const backward = mergeSetOpColumnType(b, a);
		expect(backward.logicalType, `${b.name} ∪ ${a.name}`).to.equal(expected);
		const flipped = convert === 'left' ? 'right' : convert === 'right' ? 'left' : undefined;
		expect(backward.convert, `${b.name} ∪ ${a.name} convert`).to.equal(flipped);
	}

	it('rule 1: identical types keep their type', () => {
		for (const t of [INTEGER_TYPE, REAL_TYPE, TEXT_TYPE, BLOB_TYPE, JSON_TYPE, DATE_TYPE, ANY_TYPE]) {
			expectMerge(t, t, t);
		}
	});

	it('rule 2: NULL yields to the other side', () => {
		expectMerge(NULL_TYPE, TEXT_TYPE, TEXT_TYPE);
		expectMerge(NULL_TYPE, INTEGER_TYPE, INTEGER_TYPE);
		expectMerge(NULL_TYPE, JSON_TYPE, JSON_TYPE);
		expectMerge(NULL_TYPE, DATE_TYPE, DATE_TYPE);
	});

	it('rule 3: numeric promotion (never the CASE arms-differ-⇒-TEXT rule)', () => {
		// NUMERIC, not REAL: neither branch is converted, so the advertised type must
		// cover an unconverted bigint as well as a number.
		expectMerge(INTEGER_TYPE, REAL_TYPE, NUMERIC_TYPE);
		expectMerge(INTEGER_TYPE, NUMERIC_TYPE, NUMERIC_TYPE);
		expectMerge(REAL_TYPE, NUMERIC_TYPE, NUMERIC_TYPE);
	});

	it('rule 4: the object-physical side wins; the other side converts', () => {
		expectMerge(JSON_TYPE, TEXT_TYPE, JSON_TYPE, 'right');
		expectMerge(TEXT_TYPE, JSON_TYPE, JSON_TYPE, 'left');
		expectMerge(JSON_TYPE, INTEGER_TYPE, JSON_TYPE, 'right');
		expectMerge(JSON_TYPE, DATE_TYPE, JSON_TYPE, 'right');
	});

	it('rule 5: no principled common type advertises ANY', () => {
		expectMerge(DATE_TYPE, TEXT_TYPE, ANY_TYPE);
		expectMerge(BLOB_TYPE, TEXT_TYPE, ANY_TYPE);
		expectMerge(INTEGER_TYPE, TEXT_TYPE, ANY_TYPE);
		expectMerge(BLOB_TYPE, DATE_TYPE, ANY_TYPE);
	});

	it('advertised type collapses an unconverted rule-4 pair to ANY', () => {
		expect(mergeSetOpAdvertisedType(JSON_TYPE, TEXT_TYPE)).to.equal(ANY_TYPE);
		expect(mergeSetOpAdvertisedType(TEXT_TYPE, JSON_TYPE)).to.equal(ANY_TYPE);
		// Non-converting merges advertise the merged type itself.
		expect(mergeSetOpAdvertisedType(JSON_TYPE, JSON_TYPE)).to.equal(JSON_TYPE);
		expect(mergeSetOpAdvertisedType(INTEGER_TYPE, REAL_TYPE)).to.equal(NUMERIC_TYPE);
		expect(mergeSetOpAdvertisedType(NULL_TYPE, DATE_TYPE)).to.equal(DATE_TYPE);
		expect(mergeSetOpAdvertisedType(DATE_TYPE, TEXT_TYPE)).to.equal(ANY_TYPE);
	});
});

// ---------------------------------------------------------------------------
// SetOperationNode output-type derivation over the merge (mock operands)
// ---------------------------------------------------------------------------

const mockScope = { resolveSymbol: () => undefined } as unknown as Scope;

function scalar(logicalType: LogicalType, nullable: boolean): ScalarType {
	return { typeClass: 'scalar', logicalType, nullable, isReadOnly: false };
}

/** Minimal relational mock: one column named `c`, of the given scalar type. */
class MockRel extends PlanNode {
	override readonly nodeType = PlanNodeType.SeqScan;
	private readonly attr: Attribute;
	constructor(type: ScalarType) {
		super(mockScope, 0.01);
		this.attr = { id: PlanNode.nextAttrId(), name: 'c', type, sourceRelation: 'mock.t', relationName: 't' };
	}
	getType(): BaseType {
		return {
			typeClass: 'relation', isReadOnly: false, isSet: false,
			columns: [{ name: 'c', type: this.attr.type }], keys: [], rowConstraints: [],
		} as any;
	}
	getChildren(): readonly PlanNode[] { return []; }
	withChildren(): PlanNode { return this; }
	override computePhysical(_c: readonly PhysicalProperties[]): Partial<PhysicalProperties> { return {}; }
	override getAttributes(): readonly Attribute[] { return [this.attr]; }
}

describe('SetOperationNode cross-branch output type', () => {
	function outputType(leftType: ScalarType, rightType: ScalarType, op: 'union' | 'unionAll' = 'unionAll'): ScalarType {
		const node = SetOperationNode.create(
			mockScope, new MockRel(leftType) as any, new MockRel(rightType) as any, op);
		return node.getType().columns[0].type as ScalarType;
	}

	it('merges nullability as OR across the branches', () => {
		expect(outputType(scalar(TEXT_TYPE, false), scalar(TEXT_TYPE, true)).nullable).to.equal(true);
		expect(outputType(scalar(TEXT_TYPE, true), scalar(TEXT_TYPE, false)).nullable).to.equal(true);
		expect(outputType(scalar(TEXT_TYPE, false), scalar(TEXT_TYPE, false)).nullable).to.equal(false);
	});

	it('advertises the merged logical type, independent of arm order', () => {
		expect(outputType(scalar(INTEGER_TYPE, false), scalar(REAL_TYPE, false)).logicalType).to.equal(NUMERIC_TYPE);
		expect(outputType(scalar(REAL_TYPE, false), scalar(INTEGER_TYPE, false)).logicalType).to.equal(NUMERIC_TYPE);
		expect(outputType(scalar(DATE_TYPE, false), scalar(TEXT_TYPE, false)).logicalType).to.equal(ANY_TYPE);
		expect(outputType(scalar(NULL_TYPE, true), scalar(DATE_TYPE, false)).logicalType).to.equal(DATE_TYPE);
	});

	it('aligns a rule-4 pair: the factory casts the non-object branch to JSON', () => {
		const node = SetOperationNode.create(
			mockScope, new MockRel(scalar(JSON_TYPE, false)) as any, new MockRel(scalar(TEXT_TYPE, false)) as any, 'union');
		// Both branches now report JSON, so the node advertises JSON — not ANY.
		expect((node.getType().columns[0].type as ScalarType).logicalType).to.equal(JSON_TYPE);
		expect((node.right.getType().columns[0].type as ScalarType).logicalType).to.equal(JSON_TYPE);
		// The left (already-JSON) branch is untouched.
		expect(node.left).to.be.instanceOf(MockRel);
	});

	it('an unaligned rule-4 pair (direct construction) advertises ANY, not the object type', () => {
		const node = new SetOperationNode(
			mockScope, new MockRel(scalar(JSON_TYPE, false)) as any, new MockRel(scalar(TEXT_TYPE, false)) as any, 'unionAll');
		expect((node.getType().columns[0].type as ScalarType).logicalType).to.equal(ANY_TYPE);
	});
});

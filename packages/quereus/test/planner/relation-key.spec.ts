import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { Parser } from '../../src/parser/parser.js';
import { GlobalScope } from '../../src/planner/scopes/global.js';
import { ParameterScope } from '../../src/planner/scopes/param.js';
import { BuildTimeDependencyTracker, type PlanningContext } from '../../src/planner/planning-context.js';
import { buildBlock } from '../../src/planner/building/block.js';
import { isRelationalNode, type PlanNode, type RelationalPlanNode } from '../../src/planner/nodes/plan-node.js';
import { TableReferenceNode } from '../../src/planner/nodes/reference.js';
import type * as AST from '../../src/parser/ast.js';
import {
	collectTableReferences,
	relationBaseName,
	relationKeyBase,
	relationKeyFrom,
	relationKeyHasNodeId,
	relationKeyOf,
	relationKeyOfRelation,
	relationKeyWithBase,
} from '../../src/planner/analysis/relation-key.js';
import { analyzeRowSpecific, createTableInfoFromNode } from '../../src/planner/analysis/constraint-extractor.js';
import { extractBindings } from '../../src/planner/analysis/binding-extractor.js';

/**
 * `planner/analysis/relation-key.ts` is the one owner of the label that names a single
 * *read* of a table inside a plan (`<schema>.<table>#<nodeId>`, lowercased). Its recipe
 * drifted three times while it was spelled by hand, and every drift failed silently:
 * two sites computed labels for the same read, the strings differed, the lookup found
 * nothing, and the feature quietly degraded.
 *
 * The unit block below pins the spelling. The `agree` block is the generalized guard:
 * it asserts the key SETS produced by three independent subsystems over one plan are
 * equal, so a future site that re-spells the label breaks a test instead of degrading
 * in silence.
 */

function analyzedPlan(db: Database, sql: string): PlanNode {
	const ast = new Parser().parse(sql) as AST.Statement;
	const ctx: PlanningContext = {
		db,
		schemaManager: db.schemaManager,
		parameters: {},
		scope: new ParameterScope(new GlobalScope(db.schemaManager)),
		cteNodes: new Map(),
		schemaDependencies: new BuildTimeDependencyTracker(),
		schemaCache: new Map(),
		cteReferenceCache: new Map(),
		cteDescriptors: new Map(),
		outputScopes: new Map(),
	};
	return db.optimizer.optimizeForAnalysis(buildBlock(ctx, [ast]), db) as unknown as PlanNode;
}

const sorted = (keys: Iterable<string>): string[] => [...keys].sort();

/** The single `TableReferenceNode` in a one-table plan. */
function soleRef(plan: PlanNode): TableReferenceNode {
	const refs = [...collectTableReferences(plan).values()];
	expect(refs, 'expected exactly one table reference').to.have.lengthOf(1);
	return refs[0].node;
}

/** The shallowest relational node in `plan` that is NOT a `TableReferenceNode`. */
function firstNonTableRelation(plan: PlanNode): RelationalPlanNode {
	const queue: PlanNode[] = [plan];
	while (queue.length > 0) {
		const node = queue.shift()!;
		if (isRelationalNode(node) && !(node instanceof TableReferenceNode)) return node;
		queue.push(...(node.getChildren() as unknown as PlanNode[]));
	}
	throw new Error('no non-table relational node in plan');
}

describe('relation key', () => {
	describe('spelling', () => {
		it('lowercases the qualified base name', () => {
			expect(relationBaseName({ schemaName: 'MAIN', name: 'Entity' })).to.equal('main.entity');
		});

		it('emits the #unknown suffix for a missing node id', () => {
			expect(relationKeyFrom('main.orders', null)).to.equal('main.orders#unknown');
			expect(relationKeyFrom('main.orders', undefined)).to.equal('main.orders#unknown');
			expect(relationKeyHasNodeId('main.orders#unknown', null)).to.equal(true);
		});

		it('round-trips base ↔ key', () => {
			const key = relationKeyFrom('main.orders', '42');
			expect(key).to.equal('main.orders#42');
			expect(relationKeyBase(key)).to.equal('main.orders');
			expect(relationKeyWithBase(key, 'main.sales')).to.equal('main.sales#42');
		});

		it('round-trips a base that itself contains a #', () => {
			// `create table "we#ird"` is legal, so the parse must split at the LAST '#'
			// (a node id never contains one).
			const key = relationKeyFrom('main.we#ird', '42');
			expect(key).to.equal('main.we#ird#42');
			expect(relationKeyBase(key)).to.equal('main.we#ird');
			expect(relationKeyWithBase(key, 'main.tame')).to.equal('main.tame#42');
			expect(relationKeyWithBase(relationKeyFrom('main.tame', '42'), 'main.we#ird')).to.equal(key);
		});

		it('does not confuse node id 42 with node id 142', () => {
			expect(relationKeyHasNodeId('main.orders#142', '42')).to.equal(false);
			expect(relationKeyHasNodeId('main.orders#142', '142')).to.equal(true);
			expect(relationKeyHasNodeId('main.orders#42', '42')).to.equal(true);
			// A base whose own text ends in the id must not match either.
			expect(relationKeyHasNodeId('main.x#42#7', '42')).to.equal(false);
		});

		it('returns the whole string when there is no # at all', () => {
			expect(relationKeyBase('main.orders')).to.equal('main.orders');
			expect(relationKeyHasNodeId('main.orders', '42')).to.equal(false);
		});
	});

	describe('over a plan', () => {
		let db: Database;

		beforeEach(async () => {
			db = new Database();
			// Deliberately non-lowercase identifiers: the incident this module exists to
			// prevent was a site that forgot to lowercase.
			await db.exec('create table Orders (id integer primary key, cust integer, amt integer) using memory');
			await db.exec('create table Items (id integer primary key, oid integer, sku text) using memory');
		});

		afterEach(async () => {
			await db.close();
		});

		it('lowercases the base regardless of the declared identifier case', () => {
			const plan = analyzedPlan(db, 'select id from Orders');
			const keys = sorted(collectTableReferences(plan).keys());
			expect(keys).to.have.lengthOf(1);
			expect(relationKeyBase(keys[0])).to.equal('main.orders');
		});

		it('gives a self-join two distinct keys over one base table', () => {
			const plan = analyzedPlan(db, 'select a.id from Orders a join Orders b on a.cust = b.cust');
			const refs = collectTableReferences(plan);
			expect(refs.size).to.equal(2);
			expect([...refs.values()].map(r => r.base)).to.deep.equal(['main.orders', 'main.orders']);
			// Two distinct reads ⇒ two distinct node ids.
			expect(new Set(sorted(refs.keys())).size).to.equal(2);
		});

		it('finds a table read under a scalar subquery', () => {
			// The walk descends getChildren(), not getRelations(): the inner read hangs off
			// a scalar predicate. This is the shape almost every assertion body has.
			const plan = analyzedPlan(db,
				'select id from Orders o where not exists (select 1 from Items i where i.oid = o.id)');
			const bases = new Set([...collectTableReferences(plan).values()].map(r => r.base));
			expect(sorted(bases)).to.deep.equal(['main.items', 'main.orders']);
		});

		it('agrees across the walk, the classifier, and the binding extractor', () => {
			// The generalized guard. Any site that re-spells the label differently breaks
			// this rather than silently finding nothing at a lookup.
			for (const sql of [
				'select a.id from Orders a join Orders b on a.cust = b.cust',
				'select id from Orders o where not exists (select 1 from Items i where i.oid = o.id)',
				'select cust, sum(amt) from Orders group by cust',
				'select id from Orders where id = 7',
				// `committed.` is a pseudo-schema, not a real one: it resolves to the same
				// `main` table and must key identically.
				'select id from committed.Orders where id = 7',
			]) {
				const plan = analyzedPlan(db, sql);
				const walk = sorted(collectTableReferences(plan).keys());
				const classified = sorted(analyzeRowSpecific(plan).classifications.keys());
				const bound = sorted(extractBindings(plan as RelationalPlanNode).perRelation.keys());
				expect(classified, `classifications disagree with the walk for: ${sql}`).to.deep.equal(walk);
				expect(bound, `bindings disagree with the walk for: ${sql}`).to.deep.equal(walk);
			}
		});

		it('ignores the committed. pseudo-schema prefix a table reference prints', () => {
			// `TableReferenceNode.toString()` prefixes `committed.` for a committed read.
			// The two callers that pass NO display name to `createTableInfoFromNode`
			// (`nodes/filter.ts`, `rules/access/rule-monotonic-range-access.ts`) used to
			// key off that string, so their key base was `committed.main.orders`. The owner
			// canonicalizes off the table schema instead, so every caller agrees.
			const ref = soleRef(analyzedPlan(db, 'select id from committed.Orders where id = 7'));
			expect(ref.readCommitted, 'expected a committed read').to.equal(true);
			expect(ref.toString().toLowerCase()).to.equal('committed.main.orders');
			expect(relationKeyBase(relationKeyOf(ref))).to.equal('main.orders');
			expect(createTableInfoFromNode(ref).relationKey).to.equal(relationKeyOf(ref));
		});

		it('falls back to the display string for a non-table relational node', () => {
			// Only a TableReferenceNode has a schema-qualified name to canonicalize on;
			// anything else keys off the name it is given, lowercased.
			const rel = firstNonTableRelation(analyzedPlan(db, 'select id from Orders'));
			expect(relationKeyOfRelation(rel)).to.equal(relationKeyFrom(rel.toString().toLowerCase(), rel.id));
			expect(relationKeyOfRelation(rel, 'MyLabel')).to.equal(relationKeyFrom('mylabel', rel.id));
			expect(relationKeyOfRelation(rel, ''), 'empty display name falls back, never keys on ""')
				.to.equal(relationKeyOfRelation(rel));
		});

		it('keys a table whose quoted name contains a # and recovers the base', async () => {
			await db.exec('create table "we#ird" (id integer primary key, v integer) using memory');
			const plan = analyzedPlan(db, 'select id from "we#ird"');
			const refs = collectTableReferences(plan);
			expect(refs.size).to.equal(1);
			const [key, ref] = [...refs.entries()][0];
			expect(ref.base).to.equal('main.we#ird');
			expect(relationKeyBase(key)).to.equal('main.we#ird');
			expect(relationKeyOf(ref.node)).to.equal(key);
		});
	});
});

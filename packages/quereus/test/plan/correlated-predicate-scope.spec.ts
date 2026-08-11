import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import type { SqlValue } from '../../src/common/types.js';
import { programOf, topLevelProgram } from '../util/debug-program.js';
import { Parser } from '../../src/parser/parser.js';
import { GlobalScope } from '../../src/planner/scopes/global.js';
import { ParameterScope } from '../../src/planner/scopes/param.js';
import { BuildTimeDependencyTracker, type PlanningContext } from '../../src/planner/planning-context.js';
import { buildBlock } from '../../src/planner/building/block.js';
import { extractConstraintsForTable, type PredicateConstraint } from '../../src/planner/analysis/constraint-extractor.js';
import { relationKeyOf } from '../../src/planner/analysis/relation-key.js';
import { TableReferenceNode } from '../../src/planner/nodes/reference.js';
import type { PlanNode, RelationalPlanNode } from '../../src/planner/nodes/plan-node.js';
import type * as AST from '../../src/parser/ast.js';

/**
 * A subquery's predicate must not be attributed to — or placed over — the outer relation.
 *
 * Regression guard for `bug-correlated-predicate-hoisted-onto-outer` (invariant OPT-025).
 * `rule-grow-retrieve`'s `trySortAbsorbViaIndexOrdering` path is the only caller that
 * sweeps constraints out of a whole subtree rather than out of a single Filter's own
 * predicate, so it needs an ORDER BY the outer table's primary-key walk already satisfies.
 * A correlated subquery body hangs off a scalar predicate, so that subtree contained the
 * inner `t.s = a.i`; attributing it to `a` produced an unhandled constraint, then a
 * residual predicate, then a Filter reading column `s` over the scan of `a`. The fix
 * gates the sweep on scope in `constraint-extractor.ts` (`walkPredicatesConstraining`):
 * a predicate is visited only when the target table reference sits in that predicate's
 * own relational input.
 *
 * Row-set coverage lives in test/logic/07.7.6-correlated-predicate-scope.sqllogic. This
 * suite pins the *plan shape*: the outer scan must carry no Filter referencing an inner
 * column, and the Sort must still be absorbed (otherwise the shape assertion would pass
 * for the wrong reason — the buggy path would simply not be taken). A row-set-only test
 * would start passing again if a later rewrite merely relocated the duplicated predicate.
 *
 * The `extractConstraintsForTable` block at the end calls the changed function directly,
 * so the invariant stays pinned even if the optimizer stops routing this query through
 * the sort-absorb path and defangs every plan-shape assertion above it.
 */

async function collect(db: Database, sql: string): Promise<Array<Record<string, SqlValue>>> {
	const rows: Array<Record<string, SqlValue>> = [];
	for await (const r of db.eval(sql)) rows.push(r);
	return rows;
}

/** Number of `filter(...)` instructions in a program dump. */
function filterCount(program: string): number {
	return (program.match(/; filter\(/g) ?? []).length;
}

const UNORDERED = 'select a.id from a where exists (select 1 from t where t.s = a.i)';
const ORDERED = `${UNORDERED} order by a.id`;

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

/** The single `TableReferenceNode` for `tableName` in an analyzed plan. */
function soleTableRef(plan: PlanNode, tableName: string): TableReferenceNode {
	const found: TableReferenceNode[] = [];
	const seen = new Set<string>();
	const visit = (node: PlanNode): void => {
		if (seen.has(node.id)) return;
		seen.add(node.id);
		if (node instanceof TableReferenceNode && node.tableSchema.name === tableName) found.push(node);
		for (const rel of node.getRelations()) visit(rel as unknown as PlanNode);
		for (const child of node.getChildren()) visit(child);
	};
	visit(plan);
	expect(found.length, `expected exactly one TableReferenceNode for ${tableName}`).to.equal(1);
	return found[0];
}

/** `extractConstraintsForTable` for `tableName`, as the access-path rules call it. */
function constraintsFor(db: Database, sql: string, tableName: string): PredicateConstraint[] {
	const plan = analyzedPlan(db, sql);
	const ref = soleTableRef(plan, tableName);
	const key = relationKeyOf(ref);
	return extractConstraintsForTable(plan as RelationalPlanNode, key);
}

describe('Plan shape: a correlated subquery predicate stays in its own scope', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table a (id integer primary key, i integer) using memory');
		await db.exec('create table t (id integer primary key, s text) using memory');
		await db.exec('insert into a values (1, 1), (2, 2), (3, 3)');
		await db.exec("insert into t values (1, '1'), (2, '2')");
	});

	afterEach(async () => {
		await db.close();
	});

	it('does not place a Filter on an inner column over the outer scan', () => {
		const prog = topLevelProgram(db, ORDERED);
		expect(prog, 'the hoisted copy of the inner comparison must not appear over the scan of `a`')
			.to.not.contain('filter(cast(t.s as numeric) = a.i)');
		expect(filterCount(prog), 'the only top-level filter is the EXISTS predicate itself')
			.to.equal(1);
		expect(prog, 'and that one filter is the EXISTS')
			.to.contain('filter(EXISTS (subquery))');
	});

	it('still absorbs the Sort into the index scan (the precondition being guarded)', () => {
		// If this stops holding, the plan no longer takes the sort-absorb path and the
		// test above would pass for the wrong reason.
		expect(topLevelProgram(db, ORDERED), 'ascending order is satisfied by the primary-key walk')
			.to.not.contain('sort(');
	});

	it('keeps the inner predicate inside the subquery program', () => {
		// The predicate must still exist — the fix removes the duplicate on the outer
		// relation, not the original. Its rendering also pins the `wrapInCast` AST fix:
		// the synthesized cast used to print its placeholder as `cast(null as integer)`.
		expect(programOf(db, ORDERED), 'the inner comparison lives in the EXISTS sub-program')
			.to.contain('filter(cast(t.s as numeric) = a.i)');
	});

	it('returns the same rows with and without the absorbed ORDER BY', async () => {
		const unordered = await collect(db, UNORDERED);
		const ordered = await collect(db, ORDERED);
		expect(ordered).to.deep.equal(unordered);
		expect(ordered.map(r => r.id)).to.deep.equal([1, 2]);
	});

	it('does not hoist the inner predicate under NOT EXISTS either', async () => {
		// The top-level filter here renders the whole NOT EXISTS predicate — its SQL text
		// mentions `t.s`, so match on the hoisted *comparison* instruction, not on the name.
		const sql = 'select a.id from a where not exists (select 1 from t where t.s = a.i) order by a.id';
		const prog = topLevelProgram(db, sql);
		expect(prog).to.not.contain('filter(cast(t.s as numeric) = a.i)');
		expect(filterCount(prog), 'only the NOT EXISTS filter').to.equal(1);
		const rows = await collect(db, sql);
		expect(rows.map(r => r.id)).to.deep.equal([3]);
	});

	it('does not hoist an outer column compared to a constant inside the subquery', async () => {
		// The one shape `PredicateConstraint.correlated` cannot flag: the value side is a
		// literal, so `a.i = 2` looks like an ordinary covering equality on `a`. Hoisted, it
		// seeks the outer scan and NOT EXISTS then returns nothing at all.
		const sql = 'select a.id from a where not exists (select 1 from t where a.i = 2) order by a.id';
		const prog = topLevelProgram(db, sql);
		expect(prog, 'the subquery-scoped comparison must not appear over the scan of `a`')
			.to.not.contain('filter(a.i = 2)');
		expect(filterCount(prog), 'only the NOT EXISTS filter').to.equal(1);
		const rows = await collect(db, sql);
		expect(rows.map(r => r.id)).to.deep.equal([1, 3]);
	});

	// The plan-shape assertions above all depend on the sort-absorb path being taken. These
	// call the changed function directly, so they keep pinning OPT-025 even if a later
	// rewrite stops routing this query through `trySortAbsorbViaIndexOrdering`.
	describe('extractConstraintsForTable', () => {
		it('attributes no constraint to the outer table from a subquery predicate', () => {
			expect(constraintsFor(db, UNORDERED, 'a')).to.deep.equal([]);
		});

		it('still attributes the outer conjunct alongside the subquery', () => {
			const constraints = constraintsFor(db, `select a.id from a where a.id > 1 and exists (select 1 from t where t.s = a.i)`, 'a');
			expect(constraints.map(c => ({ columnIndex: c.columnIndex, op: c.op })))
				.to.deep.equal([{ columnIndex: 0, op: '>' }]);
		});

		it('still collects a subquery scan\'s own predicates', () => {
			// The gate must only stop predicates crossing OUT of the subquery — the recursion
			// still enters the body, so the inner scan collects its own constraints.
			const sql = 'select a.id from a where exists (select 1 from t where t.id > 0 and t.s = \'x\')';
			expect(constraintsFor(db, sql, 't').map(c => ({ columnIndex: c.columnIndex, op: c.op })))
				.to.deep.equal([{ columnIndex: 0, op: '>' }, { columnIndex: 1, op: '=' }]);
		});
	});

	it('leaves the same-table self-reference shape alone', async () => {
		// Not a regression guard: the inner scan is a distinct TableReferenceNode with its
		// own attribute ids, so `a2.id = 2` never matched the outer instance even pre-fix.
		// Kept to pin that the gate did not break the self-reference shape.
		const sql = 'select a.id from a where exists (select 1 from a a2 where a2.id = 2) order by a.id';
		const rows = await collect(db, sql);
		expect(rows.map(r => r.id)).to.deep.equal([1, 2, 3]);
	});
});

import { describe, it } from 'mocha';
import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { Parser } from '../../src/parser/parser.js';
import { BuildTimeDependencyTracker, type PlanningContext } from '../../src/planner/planning-context.js';
import { GlobalScope } from '../../src/planner/scopes/global.js';
import { ParameterScope } from '../../src/planner/scopes/param.js';
import { buildInsertStmt } from '../../src/planner/building/insert.js';
import { buildUpdateStmt } from '../../src/planner/building/update.js';
import { buildDeleteStmt } from '../../src/planner/building/delete.js';
import { buildSelectStmt } from '../../src/planner/building/select.js';
import { ViewMutationError } from '../../src/planner/mutation/mutation-diagnostic.js';
import { PlanNodeType } from '../../src/planner/nodes/plan-node-type.js';
import { ViewMutationNode, type IdentityCapture } from '../../src/planner/nodes/view-mutation-node.js';
import type { DmlExecutorNode } from '../../src/planner/nodes/dml-executor-node.js';
import { isRelationalNode, type PlanNode, type RelationalPlanNode, type TableDescriptor } from '../../src/planner/nodes/plan-node.js';
import type * as AST from '../../src/parser/ast.js';

/**
 * Parity gate for the view-mutation substrate (ticket 3.1).
 *
 * A single-source projection-and-filter view write must plan to a single
 * `ViewMutationNode` over exactly one base op, and the wrapped base-table DML
 * subtree must still carry the real `DmlExecutorNode` on the underlying base
 * table — the structural proof that the substrate reuses the base-table builder
 * verbatim (the retired AST rewrite's output, wrapped).
 */
describe('View Mutation Substrate (single-source parity)', () => {
	async function ctxFor(): Promise<PlanningContext> {
		const db = new Database();
		await db.exec(`create table t (id integer primary key, name text, color text)`);
		await db.exec(`create view gv as select id, name from t where color = 'green'`);
		// Assemble a root planning context the same way Statement compilation does.
		const parameterScope = new ParameterScope(new GlobalScope(db.schemaManager));
		return {
			db,
			schemaManager: db.schemaManager,
			parameters: {},
			scope: parameterScope,
			cteNodes: new Map(),
			schemaDependencies: new BuildTimeDependencyTracker(),
			schemaCache: new Map(),
			cteReferenceCache: new Map(),
			outputScopes: new Map(),
		};
	}

	/** Depth-first search for the first DmlExecutorNode in a plan subtree. */
	function findDmlExecutor(node: PlanNode): DmlExecutorNode | undefined {
		if (node.nodeType === PlanNodeType.UpdateExecutor) return node as DmlExecutorNode;
		for (const child of node.getChildren()) {
			const found = findDmlExecutor(child);
			if (found) return found;
		}
		return undefined;
	}

	function assertSingleSourceSubstrate(plan: PlanNode, expectedBase: string): void {
		expect(plan.nodeType).to.equal(PlanNodeType.ViewMutation);
		const vm = plan as ViewMutationNode;
		expect(vm.baseOps.length).to.equal(1);
		const dml = findDmlExecutor(vm);
		expect(dml, 'wrapped DmlExecutorNode present').to.not.equal(undefined);
		expect(dml!.table.tableSchema.name).to.equal(expectedBase);
	}

	it('insert through a view builds a ViewMutationNode over one base op on the base table', async () => {
		const ctx = await ctxFor();
		const ast = new Parser().parseAll(`insert into gv (id, name) values (1, 'bob')`)[0] as AST.InsertStmt;
		assertSingleSourceSubstrate(buildInsertStmt(ctx, ast), 't');
	});

	it('update through a view builds a ViewMutationNode over one base op on the base table', async () => {
		const ctx = await ctxFor();
		const ast = new Parser().parseAll(`update gv set name = 'x' where id = 1`)[0] as AST.UpdateStmt;
		assertSingleSourceSubstrate(buildUpdateStmt(ctx, ast), 't');
	});

	it('delete through a view builds a ViewMutationNode over one base op on the base table', async () => {
		const ctx = await ctxFor();
		const ast = new Parser().parseAll(`delete from gv where id = 1`)[0] as AST.DeleteStmt;
		assertSingleSourceSubstrate(buildDeleteStmt(ctx, ast), 't');
	});

	it('builds a relational ViewMutationNode for single-source RETURNING-through-view', async () => {
		const ctx = await ctxFor();
		const ast = new Parser().parseAll(`insert into gv (id, name) values (1, 'bob') returning id, name`)[0] as AST.InsertStmt;
		const plan = buildInsertStmt(ctx, ast);
		expect(plan.nodeType).to.equal(PlanNodeType.ViewMutation);
		const vm = plan as ViewMutationNode;
		// The node is relational: its row type / attributes are the view-projected
		// RETURNING columns (named as the user wrote them).
		expect(vm.getType().typeClass).to.equal('relation');
		expect(vm.getAttributes().map(a => a.name)).to.deep.equal(['id', 'name']);
		// Single-source: the RETURNING rides the (sole) base op, which is now relational.
		expect(vm.returning, 'no separate re-query node for single-source').to.equal(undefined);
		expect(vm.baseOps.some(op => isRelationalNode(op)), 'base op carries the RETURNING projection').to.equal(true);
		// And it still wraps the real base-table DmlExecutorNode on the base table.
		const dml = findDmlExecutor(vm);
		expect(dml!.table.tableSchema.name).to.equal('t');
	});
});

/**
 * Structured-reason gate for the 1:many cross-source `set` reject (ticket
 * `view-write-cross-source-set-1n-diagnostic`). A cross-source `update v set
 * owner.x = partner.y` is well-defined only when the owning (assigned) side joins
 * **at most one** partner row; the reverse (1:many) direction is rejected at plan
 * time with the dedicated `cross-source-ambiguous-cardinality` reason rather than
 * failing at runtime with the generic `Scalar subquery returned more than one row`.
 * Asserts the machine-readable `reason` (the sqllogic suite pins only the message).
 */
describe('View Mutation Substrate (cross-source cardinality)', () => {
	async function joinCtx(): Promise<PlanningContext> {
		const db = new Database();
		await db.exec(`create table xs1n_p (pid integer primary key, pv integer)`);
		await db.exec(`create table xs1n_c (cid integer primary key, pref integer, cv integer)`);
		// Owner side p joins MANY children (the 1:many direction); the join pins only
		// xs1n_c.pref, which is no unique key of xs1n_c.
		await db.exec(`create view xs1n_v as
			select p.pid as pid, p.pv as pv, c.cv as cv
			from xs1n_p p join xs1n_c c on c.pref = p.pid`);
		const parameterScope = new ParameterScope(new GlobalScope(db.schemaManager));
		return {
			db,
			schemaManager: db.schemaManager,
			parameters: {},
			scope: parameterScope,
			cteNodes: new Map(),
			schemaDependencies: new BuildTimeDependencyTracker(),
			schemaCache: new Map(),
			cteReferenceCache: new Map(),
			outputScopes: new Map(),
		};
	}

	it('rejects the 1:many cross-source set with cross-source-ambiguous-cardinality', async () => {
		const ctx = await joinCtx();
		const ast = new Parser().parseAll(`update xs1n_v set pv = cv where pid = 10`)[0] as AST.UpdateStmt;
		let caught: unknown;
		try {
			buildUpdateStmt(ctx, ast);
		} catch (e) {
			caught = e;
		}
		expect(caught, 'a ViewMutationError is raised at plan time').to.be.instanceOf(ViewMutationError);
		const err = caught as ViewMutationError;
		expect(err.mutationDiagnostic.reason).to.equal('cross-source-ambiguous-cardinality');
		// The message names the cross-source ambiguity, not the runtime scalar-subquery error.
		expect(err.message).to.contain('assigned side joins more than one');
		expect(err.message.toLowerCase()).to.not.contain('scalar subquery');
	});

	it('accepts the at-most-one direction (FK child reads parent PK)', async () => {
		const db = new Database();
		await db.exec(`create table xs1n_p (pid integer primary key, pv integer)`);
		await db.exec(`create table xs1n_c (cid integer primary key, pref integer, cv integer)`);
		// Owner side c (child) joins AT MOST ONE parent: the join pins p.pid, the parent's PK.
		await db.exec(`create view xs1n_cv as
			select c.cid as cid, c.cv as cv, p.pv as pv
			from xs1n_c c join xs1n_p p on p.pid = c.pref`);
		const parameterScope = new ParameterScope(new GlobalScope(db.schemaManager));
		const ctx: PlanningContext = {
			db,
			schemaManager: db.schemaManager,
			parameters: {},
			scope: parameterScope,
			cteNodes: new Map(),
			schemaDependencies: new BuildTimeDependencyTracker(),
			schemaCache: new Map(),
			cteReferenceCache: new Map(),
			outputScopes: new Map(),
		};
		const ast = new Parser().parseAll(`update xs1n_cv set cv = pv where cid = 1`)[0] as AST.UpdateStmt;
		// Does not throw: the proof admits the at-most-one direction.
		const plan = buildUpdateStmt(ctx, ast);
		expect(plan.nodeType).to.equal(PlanNodeType.ViewMutation);
	});
});

/**
 * Machine-readable reason gate for the `with defaults (col = expr, …)`
 * unknown-column guard: a clause entry naming a column that is neither a view
 * nor a base column raises `default-target-not-found` at plan time. The
 * sqllogic suite (93.4) pins only the human message; this pins the `reason`.
 */
describe('View Mutation Substrate (with defaults unknown column)', () => {
	it('rejects an unknown insert-defaults column with default-target-not-found', async () => {
		const db = new Database();
		await db.exec(`create table dft (id integer primary key, created integer)`);
		await db.exec(`create view dft_v as select id from dft with defaults (nope = 1)`);
		const parameterScope = new ParameterScope(new GlobalScope(db.schemaManager));
		const ctx: PlanningContext = {
			db,
			schemaManager: db.schemaManager,
			parameters: {},
			scope: parameterScope,
			cteNodes: new Map(),
			schemaDependencies: new BuildTimeDependencyTracker(),
			schemaCache: new Map(),
			cteReferenceCache: new Map(),
			outputScopes: new Map(),
		};
		const ast = new Parser().parseAll(`insert into dft_v values (1)`)[0] as AST.InsertStmt;
		let caught: unknown;
		try {
			buildInsertStmt(ctx, ast);
		} catch (e) {
			caught = e;
		}
		expect(caught, 'a ViewMutationError is raised at plan time').to.be.instanceOf(ViewMutationError);
		const err = caught as ViewMutationError;
		expect(err.mutationDiagnostic.reason).to.equal('default-target-not-found');
		expect(err.message).to.contain(`names column 'nope'`);
	});
});

/**
 * Structural gate for the ordered multi-capture substrate
 * (ticket `view-mutation-ordered-multi-capture`). `ViewMutationNode` carries an
 * optional `nestedCaptures` list materialized AFTER the primary `identityCapture`,
 * in list order, before the base ops. No producer fills the list yet (the set-op
 * leg compose does), so the load-bearing cursor arithmetic — `getChildren` order,
 * the `withChildren` round-trip, descriptor preservation, and the unchanged
 * short-circuit — is otherwise unexercised. These tests construct the node
 * directly (the only `nestedCaptures`-bearing shape available pre-compose).
 */
describe('View Mutation Substrate (ordered multi-capture)', () => {
	async function ctx(): Promise<PlanningContext> {
		const db = new Database();
		await db.exec(`create table mc (id integer primary key, v integer)`);
		const parameterScope = new ParameterScope(new GlobalScope(db.schemaManager));
		return {
			db,
			schemaManager: db.schemaManager,
			parameters: {},
			scope: parameterScope,
			cteNodes: new Map(),
			schemaDependencies: new BuildTimeDependencyTracker(),
			schemaCache: new Map(),
			cteReferenceCache: new Map(),
			outputScopes: new Map(),
		};
	}

	/** A fresh relational plan node to stand in as a capture/base-op source. */
	function relSource(pc: PlanningContext, sql: string): RelationalPlanNode {
		const ast = new Parser().parseAll(sql)[0] as AST.SelectStmt;
		return buildSelectStmt(pc, ast) as RelationalPlanNode;
	}

	function cap(source: RelationalPlanNode): IdentityCapture {
		return { source, descriptor: {} as TableDescriptor };
	}

	it('threads getChildren in order base ops -> primary capture -> nested captures', async () => {
		const pc = await ctx();
		const baseOp = relSource(pc, `select id from mc where id = 1`);
		const primary = cap(relSource(pc, `select id from mc where id = 2`));
		const nested0 = cap(relSource(pc, `select id from mc where id = 3`));
		const nested1 = cap(relSource(pc, `select id from mc where id = 4`));
		const vm = new ViewMutationNode(pc.scope, [baseOp], undefined, undefined, undefined, primary, [nested0, nested1]);

		// Order is the contract the emitter's param cursor mirrors exactly.
		expect(vm.getChildren()).to.deep.equal([baseOp, primary.source, nested0.source, nested1.source]);
		// Side inputs (captures) are materialized into context, never forwarded.
		expect(vm.getRelations()).to.not.include(primary.source);
		expect(vm.getRelations()).to.not.include(nested0.source);
		expect(vm.getRelations()).to.not.include(nested1.source);
		// Diagnostics reflect the breakdown.
		expect(vm.toString()).to.contain('+capture(1+2)');
		expect(vm.getLogicalAttributes().nestedCaptures).to.equal(2);
		expect(vm.getLogicalAttributes().identityCapture).to.equal('identity');
	});

	it('withChildren returns this when every source is reference-identical', async () => {
		const pc = await ctx();
		const baseOp = relSource(pc, `select id from mc where id = 1`);
		const primary = cap(relSource(pc, `select id from mc where id = 2`));
		const nested0 = cap(relSource(pc, `select id from mc where id = 3`));
		const vm = new ViewMutationNode(pc.scope, [baseOp], undefined, undefined, undefined, primary, [nested0]);
		expect(vm.withChildren(vm.getChildren())).to.equal(vm);
	});

	it('withChildren rebuilds a replaced nested source while preserving every descriptor identity', async () => {
		const pc = await ctx();
		const baseOp = relSource(pc, `select id from mc where id = 1`);
		const primary = cap(relSource(pc, `select id from mc where id = 2`));
		const nested0 = cap(relSource(pc, `select id from mc where id = 3`));
		const nested1 = cap(relSource(pc, `select id from mc where id = 4`));
		const vm = new ViewMutationNode(pc.scope, [baseOp], undefined, undefined, undefined, primary, [nested0, nested1]);

		// Replace only nested[1]'s source (the last child) — everything else identical.
		const replacement = relSource(pc, `select id from mc where id = 99`);
		const newChildren = [...vm.getChildren()];
		newChildren[newChildren.length - 1] = replacement;
		const rebuilt = vm.withChildren(newChildren) as ViewMutationNode;

		expect(rebuilt).to.not.equal(vm);
		expect(rebuilt.nestedCaptures!.length).to.equal(2);
		// Descriptors are bound to by identity — a rebuild must reuse the SAME object.
		expect(rebuilt.identityCapture!.descriptor).to.equal(primary.descriptor);
		expect(rebuilt.nestedCaptures![0].descriptor).to.equal(nested0.descriptor);
		expect(rebuilt.nestedCaptures![1].descriptor).to.equal(nested1.descriptor);
		// Unchanged sources kept; replaced source picked up.
		expect(rebuilt.nestedCaptures![0].source).to.equal(nested0.source);
		expect(rebuilt.nestedCaptures![1].source).to.equal(replacement);
	});

	it('handles nested captures with no primary (defensive shape: base ops -> nested)', async () => {
		const pc = await ctx();
		const baseOp = relSource(pc, `select id from mc where id = 1`);
		const nested0 = cap(relSource(pc, `select id from mc where id = 3`));
		const vm = new ViewMutationNode(pc.scope, [baseOp], undefined, undefined, undefined, undefined, [nested0]);

		expect(vm.getChildren()).to.deep.equal([baseOp, nested0.source]);
		expect(vm.toString()).to.contain('+capture(0+1)');
		expect(vm.getLogicalAttributes().identityCapture).to.equal(undefined);
		expect(vm.getLogicalAttributes().nestedCaptures).to.equal(1);
		// Round-trips.
		expect(vm.withChildren(vm.getChildren())).to.equal(vm);
	});

	it('an empty/absent nested list lowers byte-identically to the pre-list substrate', async () => {
		const pc = await ctx();
		const baseOp = relSource(pc, `select id from mc where id = 1`);
		const primary = cap(relSource(pc, `select id from mc where id = 2`));
		const vm = new ViewMutationNode(pc.scope, [baseOp], undefined, undefined, undefined, primary);

		expect(vm.getChildren()).to.deep.equal([baseOp, primary.source]);
		// Bare `+capture` (no breakdown) for the common single-capture case.
		expect(vm.toString()).to.contain('+capture');
		expect(vm.toString()).to.not.contain('+capture(');
		expect(vm.getLogicalAttributes().nestedCaptures).to.equal(undefined);
		expect(vm.withChildren(vm.getChildren())).to.equal(vm);
	});
});

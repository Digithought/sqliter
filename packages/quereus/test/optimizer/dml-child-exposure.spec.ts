import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { PlanNode } from '../../src/planner/nodes/plan-node.js';
import { DmlExecutorNode } from '../../src/planner/nodes/dml-executor-node.js';
import { ConstraintCheckNode } from '../../src/planner/nodes/constraint-check-node.js';
import { AlterTableNode } from '../../src/planner/nodes/alter-table-node.js';

/**
 * Structural guard for bug-dml-side-expressions-invisible-to-optimizer and
 * bug-alter-add-column-relation-default-fails-to-emit (OPT-009, "every held
 * expression is a child"): `DmlExecutorNode` (ON CONFLICT assignments / WHERE,
 * and WITH CONTEXT values), `ConstraintCheckNode` (WITH CONTEXT values,
 * alongside its existing CHECK and NOT NULL DEFAULT children), and
 * `AlterTableNode` (ADD COLUMN's per-row DEFAULT / GENERATED ALWAYS AS
 * backfill, and any CHECK predicates on that column) must expose every held
 * expression through `getChildren()` so the optimizer can rewrite subqueries
 * inside them, and `withChildren()` must slice a round-trip back to an
 * equivalent node.
 *
 * `plan-validator.ts`'s "no logical-only node reaches emission" check cannot
 * serve as this guard — it walks `getChildren()` too, so it is blind to
 * exactly the subtrees this ticket exposes: a broken getChildren() would just
 * make the validator agree there is nothing to check.
 */

/** First node matching `predicate`, depth-first over `getChildren()`. */
function findNode<T extends PlanNode>(root: PlanNode, predicate: (n: PlanNode) => n is T): T {
	const stack: PlanNode[] = [root];
	const seen = new Set<PlanNode>();
	while (stack.length > 0) {
		const node = stack.pop()!;
		if (seen.has(node)) continue;
		seen.add(node);
		if (predicate(node)) return node;
		for (const child of node.getChildren()) stack.push(child);
	}
	throw new Error('no matching node found in plan');
}

const isDmlExecutor = (n: PlanNode): n is DmlExecutorNode => n instanceof DmlExecutorNode;
const isConstraintCheck = (n: PlanNode): n is ConstraintCheckNode => n instanceof ConstraintCheckNode;
const isAlterTable = (n: PlanNode): n is AlterTableNode => n instanceof AlterTableNode;

describe('DML side-expression exposure to the optimizer', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table src (id integer primary key, v integer)');
		await db.exec("insert into src values (1, 10), (2, 20)");
		await db.exec(`
			create table t (
				id integer primary key,
				email text unique,
				tag text,
				w integer not null default 0,
				constraint chk check (w >= 0)
			) with context (
				who integer
			)
		`);
		await db.exec("insert into t (id, email, tag, w) values (1, 'a@x', 'A', 1)");
		await db.exec("insert into t (id, email, tag, w) values (2, 'b@x', 'B', 1)");
	});
	afterEach(async () => { await db.close(); });

	// Two ON CONFLICT clauses (each with its own subquery assignment AND subquery
	// WHERE) plus a subquery WITH CONTEXT value — exercises every slot both node
	// types must expose, and their ordering relative to each other.
	const UPSERT_SQL = `
		insert into t (id, email, tag, w) values (1, 'new@x', 'ignored', 1)
		on conflict (id) do update set tag = (select count(*) from src) where (select count(*) from src) > 0
		on conflict (email) do update set tag = (select count(*) from src) where (select count(*) from src) > 0
		with context who = (select count(*) from src)
	`;

	it('DmlExecutorNode.getChildren() includes every upsert assignment/WHERE and every context value', () => {
		const node = findNode(db.getPlan(UPSERT_SQL), isDmlExecutor);

		// Anti-vacuity: the shape under test is really non-trivial.
		expect(node.upsertClauses?.length, 'two ON CONFLICT clauses').to.equal(2);
		expect(node.mutationContextValues?.size, 'one context value').to.equal(1);

		const upsertExprs = (node.upsertClauses ?? []).flatMap(clause => [
			...(clause.assignments?.values() ?? []),
			...(clause.whereCondition ? [clause.whereCondition] : []),
		]);
		const ctxExprs = [...(node.mutationContextValues?.values() ?? [])];

		const children = node.getChildren();
		expect(children.length).to.equal(1 + upsertExprs.length + ctxExprs.length);
		for (const expr of [...upsertExprs, ...ctxExprs]) {
			expect(children, `expression ${expr.toString()} must be a child`).to.include(expr);
		}
	});

	it('DmlExecutorNode.withChildren(getChildren()) round-trips to the same instance', () => {
		const node = findNode(db.getPlan(UPSERT_SQL), isDmlExecutor);
		expect(node.withChildren(node.getChildren())).to.equal(node);
	});

	it('ConstraintCheckNode.getChildren() includes constraints, NOT NULL defaults, and every context value', () => {
		const node = findNode(db.getPlan(UPSERT_SQL), isConstraintCheck);

		// Anti-vacuity: constraint, default, and context slots are all non-empty, so
		// the bound between them (the exact bug: an unbounded default-slice would
		// swallow the context tail) is actually exercised.
		expect(node.constraintChecks.length, 'one CHECK constraint').to.equal(1);
		expect(node.notNullDefaults?.length, 'one NOT NULL default').to.equal(1);
		expect(node.mutationContextValues?.size, 'one context value').to.equal(1);

		const children = node.getChildren();
		const expected = 1 + node.constraintChecks.length + (node.notNullDefaults?.length ?? 0)
			+ (node.mutationContextValues?.size ?? 0);
		expect(children.length).to.equal(expected);

		for (const check of node.constraintChecks) {
			expect(children, `constraint expression ${check.constraint.name} must be a child`).to.include(check.expression);
		}
		for (const d of node.notNullDefaults ?? []) {
			expect(children, `NOT NULL default for column ${d.columnIndex} must be a child`).to.include(d.defaultNode);
		}
		for (const expr of node.mutationContextValues?.values() ?? []) {
			expect(children, `context expression ${expr.toString()} must be a child`).to.include(expr);
		}
	});

	it('ConstraintCheckNode.withChildren(getChildren()) round-trips to the same instance', () => {
		const node = findNode(db.getPlan(UPSERT_SQL), isConstraintCheck);
		expect(node.withChildren(node.getChildren())).to.equal(node);
	});

	// The identity round-trip above only exercises the short-circuit. These substitute a
	// distinct node into one slot and check that EVERY slot lands where getChildren() laid
	// it out — the failure mode a slice-math bug produces (one clause's rewritten
	// expression cross-wired into another's, or the context tail swallowed by the
	// preceding slice) is invisible to an identity round-trip.

	it('DmlExecutorNode.withChildren slices rewritten expressions back into their own slots', () => {
		const node = findNode(db.getPlan(UPSERT_SQL), isDmlExecutor);
		const children = node.getChildren();
		expect(children.length, 'source + 2 clauses x (assignment + WHERE) + 1 context value').to.equal(6);

		// Substitute clause 2's WHERE node into clause 1's assignment slot: distinct from
		// what belongs there, so a cross-wire or off-by-one shows up as a slot mismatch.
		const substituted = [...children];
		substituted[1] = children[4];

		const rebuilt = node.withChildren(substituted) as DmlExecutorNode;
		expect(rebuilt, 'a changed child must produce a new instance').to.not.equal(node);
		expect(rebuilt.getChildren()).to.deep.equal(substituted);

		const [clause1, clause2] = rebuilt.upsertClauses!;
		expect([...clause1.assignments!.values()]).to.deep.equal([children[4]]);
		expect(clause1.whereCondition).to.equal(children[2]);
		expect([...clause2.assignments!.values()]).to.deep.equal([children[3]]);
		expect(clause2.whereCondition).to.equal(children[4]);
		expect([...rebuilt.mutationContextValues!.values()]).to.deep.equal([children[5]]);

		// Assignment keys are column indices — rebuilding the map must not renumber them.
		expect([...clause1.assignments!.keys()]).to.deep.equal([...node.upsertClauses![0].assignments!.keys()]);
	});

	it('ConstraintCheckNode.withChildren slices rewritten expressions back into their own slots', () => {
		const node = findNode(db.getPlan(UPSERT_SQL), isConstraintCheck);
		const children = node.getChildren();
		expect(children.length, 'source + 1 constraint + 1 NOT NULL default + 1 context value').to.equal(4);

		// Substitute the constraint expression into the context-value slot.
		const substituted = [...children];
		substituted[3] = children[1];

		const rebuilt = node.withChildren(substituted) as ConstraintCheckNode;
		expect(rebuilt, 'a changed child must produce a new instance').to.not.equal(node);
		expect(rebuilt.getChildren()).to.deep.equal(substituted);
		expect(rebuilt.constraintChecks[0].expression, 'constraint slot untouched').to.equal(children[1]);
		expect(rebuilt.notNullDefaults![0].defaultNode, 'default slot untouched').to.equal(children[2]);
		expect([...rebuilt.mutationContextValues!.keys()], 'context keys preserved')
			.to.deep.equal([...node.mutationContextValues!.keys()]);
		expect([...rebuilt.mutationContextValues!.values()]).to.deep.equal([children[1]]);
	});

	it('withChildren rejects a child count that does not match getChildren()', () => {
		const plan = db.getPlan(UPSERT_SQL);
		const dml = findNode(plan, isDmlExecutor);
		const check = findNode(plan, isConstraintCheck);
		expect(() => dml.withChildren(dml.getChildren().slice(0, 1))).to.throw(/expects 6 children/);
		expect(() => check.withChildren(check.getChildren().slice(0, 1))).to.throw(/expects 4 children/);
	});
});

describe('AlterTableNode ADD COLUMN expression exposure to the optimizer', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table d (k integer)');
		await db.exec('insert into d values (1)');
		await db.exec('create table a1 (id integer primary key)');
		await db.exec('insert into a1 values (1)');
	});
	afterEach(async () => { await db.close(); });

	// Non-foldable DEFAULT (a subquery) — compiles to a backfill node, no CHECK on the column.
	const BACKFILL_ONLY_SQL = `alter table a1 add column w integer default (select count(*) from d)`;
	// Non-foldable DEFAULT plus an inline CHECK that itself reads another table — a CHECK
	// predicate only ever exists alongside a backfill (see AddColumnCheck), so this is the
	// shape that exercises both slots and their relative order.
	const BACKFILL_AND_CHECK_SQL = `
		alter table a1 add column z integer default (new.id) check ((select count(*) from d) = 1)
	`;
	// Two inline CHECKs (both legal, both unnamed) — three slots, so `withChildren`'s cursor
	// has to walk past more than one predicate. A two-slot case cannot catch a cursor that
	// stalls or over-advances inside the predicate list.
	const BACKFILL_AND_TWO_CHECKS_SQL = `
		alter table a1 add column z integer default (new.id)
			check ((select count(*) from d) = 1)
			check ((select count(*) from d) > 0)
	`;
	const RENAME_SQL = `alter table a1 rename to a2`;

	it('getChildren() exposes the backfill expression when there is no CHECK', () => {
		const node = findNode(db.getPlan(BACKFILL_ONLY_SQL), isAlterTable);
		if (node.action.type !== 'addColumn') throw new Error('unreachable');

		// Anti-vacuity: the DEFAULT really did compile to a backfill node, not fold to a literal.
		expect(node.action.backfill, 'a subquery DEFAULT must compile to a backfill node').to.not.equal(undefined);
		expect(node.action.checks, 'no CHECK on this column').to.equal(undefined);

		const children = node.getChildren();
		expect(children.length).to.equal(1);
		expect(children[0]).to.equal(node.action.backfill!.node);
	});

	it('getChildren() exposes backfill first then every CHECK predicate, matching the emitter slot order', () => {
		const node = findNode(db.getPlan(BACKFILL_AND_CHECK_SQL), isAlterTable);
		if (node.action.type !== 'addColumn') throw new Error('unreachable');

		expect(node.action.backfill, '`new.id` default must compile to a backfill node').to.not.equal(undefined);
		expect(node.action.checks?.predicates.length, 'one CHECK predicate').to.equal(1);

		const children = node.getChildren();
		expect(children.length).to.equal(2);
		expect(children[0]).to.equal(node.action.backfill!.node);
		expect(children[1]).to.equal(node.action.checks!.predicates[0].node);
	});

	it('withChildren rotates three slots back into backfill + both CHECK predicates in order', () => {
		const node = findNode(db.getPlan(BACKFILL_AND_TWO_CHECKS_SQL), isAlterTable);
		if (node.action.type !== 'addColumn') throw new Error('unreachable');
		expect(node.action.checks?.predicates.length, 'two CHECK predicates').to.equal(2);

		const children = node.getChildren();
		expect(children.length).to.equal(3);
		expect(children[0]).to.equal(node.action.backfill!.node);
		expect(children[1]).to.equal(node.action.checks!.predicates[0].node);
		expect(children[2]).to.equal(node.action.checks!.predicates[1].node);

		// Rotate rather than swap: a cursor that stalls on the first predicate would still
		// satisfy a two-element swap, but lands the wrong node in predicate slot 1 here.
		const rotated = [children[2], children[0], children[1]];
		const rebuilt = node.withChildren(rotated) as AlterTableNode;
		if (rebuilt.action.type !== 'addColumn') throw new Error('unreachable');
		expect(rebuilt.action.backfill!.node).to.equal(rotated[0]);
		expect(rebuilt.action.checks!.predicates[0].node).to.equal(rotated[1]);
		expect(rebuilt.action.checks!.predicates[1].node).to.equal(rotated[2]);
		expect(rebuilt.getChildren()).to.deep.equal(rotated);
	});

	it('getChildren() is empty for a non-addColumn action', () => {
		const node = findNode(db.getPlan(RENAME_SQL), isAlterTable);
		expect(node.action.type).to.equal('renameTable');
		expect(node.getChildren()).to.deep.equal([]);
	});

	it('withChildren(getChildren()) round-trips to the same instance', () => {
		const node = findNode(db.getPlan(BACKFILL_AND_CHECK_SQL), isAlterTable);
		expect(node.withChildren(node.getChildren())).to.equal(node);
	});

	it('withChildren substitutes a distinct node into each slot, not just an identity round-trip', () => {
		const node = findNode(db.getPlan(BACKFILL_AND_CHECK_SQL), isAlterTable);
		const children = node.getChildren();
		expect(children.length).to.equal(2);

		// Swap the two slots: a slot-order bug (e.g. the CHECK predicate written into the
		// backfill slot) shows up as a mismatch here, invisible to an identity round-trip.
		const swapped = [children[1], children[0]];
		const rebuilt = node.withChildren(swapped) as AlterTableNode;
		expect(rebuilt, 'a changed child must produce a new instance').to.not.equal(node);
		if (rebuilt.action.type !== 'addColumn') throw new Error('unreachable');
		expect(rebuilt.action.backfill!.node, 'backfill slot took the substituted node').to.equal(swapped[0]);
		expect(rebuilt.action.checks!.predicates[0].node, 'check slot took the substituted node').to.equal(swapped[1]);
		expect(rebuilt.getChildren()).to.deep.equal(swapped);
	});

	it('withChildren rejects a child count that does not match getChildren()', () => {
		const node = findNode(db.getPlan(BACKFILL_AND_CHECK_SQL), isAlterTable);
		expect(() => node.withChildren(node.getChildren().slice(0, 1))).to.throw(/expects 2 children/);
	});
});

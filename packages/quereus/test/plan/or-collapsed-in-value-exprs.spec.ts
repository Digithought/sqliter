import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import type { SqlParameters, SqlValue } from '../../src/common/types.js';
import type { PlanNode, ScalarPlanNode } from '../../src/planner/nodes/plan-node.js';
import { PlanNodeType } from '../../src/planner/nodes/plan-node-type.js';
import { IndexSeekNode } from '../../src/planner/nodes/table-access-nodes.js';
import { assertSeekKeysRowIndependent } from '../../src/planner/rules/access/rule-select-access-path.js';

/**
 * Regression cover for `or-collapsed-in-value-exprs`.
 *
 * `where col = <literal> or col = :param` is collapsed by the planner into a
 * single `col in (<literal>, :param)` constraint that carries a parallel array
 * of *value* expressions — one per list member. The literal branches used to
 * fill their slot with the branch's whole comparison (`col = 10`) instead of
 * the value (`10`). A module that claims the collapsed IN as a multi-seek then
 * received `col = 10` as a seek key, and evaluating it before any row is read
 * failed with "No row context found for column ...".
 *
 * The built-in memory module claims these as multi-seeks whenever the column is
 * indexed, so every shape here reproduces without an external module. Rows are
 * asserted (not merely the absence of a throw) so a future regression that
 * seeks on the wrong key cannot pass by returning nothing.
 */
describe('OR-collapsed IN: mixed literal/dynamic seek keys', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table p (id integer primary key, i integer, t text) using memory');
		await db.exec('create index p_i on p(i)');
		await db.exec('create index p_t on p(t)');
		await db.exec("insert into p values (1, 10, 'aa'), (2, 20, 'bb'), (3, 30, 'cc')");
		await db.exec('create table c (a integer, b integer, v integer, primary key (a, b)) using memory');
		await db.exec('insert into c values (1, 1, 100), (1, 2, 200), (1, 3, 300), (2, 1, 400)');
	});

	afterEach(async () => {
		await db.close();
	});

	const col = async (sql: string, params?: SqlParameters): Promise<SqlValue[]> => {
		const out: SqlValue[] = [];
		for await (const row of db.eval(sql, params)) {
			out.push(Object.values(row)[0]);
		}
		return out.sort((x, y) => (x! < y! ? -1 : x! > y! ? 1 : 0));
	};

	describe('literal-or-parameter collapse', () => {
		it('primary key', async () => {
			expect(await col('select i from p where id = 1 or id = :p', { p: 3 }))
				.to.deep.equal([10, 30]);
		});

		it('indexed integer column', async () => {
			expect(await col('select id from p where i = 10 or i = :p', { p: 30 }))
				.to.deep.equal([1, 3]);
		});

		it('indexed text column', async () => {
			expect(await col("select id from p where t = 'aa' or t = :p", { p: 'cc' }))
				.to.deep.equal([1, 3]);
		});

		it('three-way OR with a trailing parameter', async () => {
			expect(await col('select id from p where i = 10 or i = 20 or i = :p', { p: 30 }))
				.to.deep.equal([1, 2, 3]);
		});

		it('all-literal IN branch OR-ed with a parameter equality', async () => {
			expect(await col('select id from p where i in (10, 20) or i = :p', { p: 30 }))
				.to.deep.equal([1, 2, 3]);
		});

		it('composite key: pinned leading column with an OR on the trailing column', async () => {
			expect(await col('select v from c where a = 1 and (b = 1 or b = :p)', { p: 2 }))
				.to.deep.equal([100, 200]);
		});

		it('parameter that matches nothing yields only the literal branch', async () => {
			expect(await col('select id from p where i = 10 or i = :p', { p: 999 }))
				.to.deep.equal([1]);
		});

		it('null parameter yields only the literal branch', async () => {
			expect(await col('select id from p where i = 10 or i = :p', { p: null }))
				.to.deep.equal([1]);
		});
	});

	describe('controls that were already correct', () => {
		it('all-literal OR (no parallel expression array is built)', async () => {
			expect(await col('select id from p where i = 10 or i = 30')).to.deep.equal([1, 3]);
		});

		it('all-parameter OR', async () => {
			expect(await col('select id from p where i = :p or i = :q', { p: 10, q: 30 }))
				.to.deep.equal([1, 3]);
		});

		it('directly written mixed IN list', async () => {
			expect(await col('select id from p where i in (10, :p)', { p: 30 }))
				.to.deep.equal([1, 3]);
		});
	});

	describe('seek-key row-context invariant', () => {
		const walk = (node: PlanNode, out: PlanNode[] = []): PlanNode[] => {
			out.push(node);
			for (const child of node.getChildren()) walk(child, out);
			return out;
		};

		// The guard has no SQL-level trigger left once the OR collapse is fixed, so
		// feed it a hand-built violation: a seek whose key is a column reference to
		// the very table being sought. Both nodes come from a real plan, so the
		// attribute ids are the ones the planner actually mints.
		it('rejects a seek key referencing a column of the sought table', () => {
			const nodes = walk(db.getPlan('select id from p where i = 10'));
			const seek = nodes.find(n => n instanceof IndexSeekNode) as IndexSeekNode | undefined;
			expect(seek, 'expected an IndexSeek for an indexed equality').to.not.be.undefined;

			const ownIds = new Set(seek!.source.getAttributes().map(a => a.id));
			const ownColumnRef = nodes.find(n =>
				n.nodeType === PlanNodeType.ColumnReference &&
				ownIds.has((n as unknown as { attributeId: number }).attributeId)
			) as ScalarPlanNode | undefined;
			expect(ownColumnRef, 'expected a column reference to table p in the plan').to.not.be.undefined;

			expect(() => assertSeekKeysRowIndependent(seek!.source, [ownColumnRef!], 'eqSeek'))
				.to.throw(/references that table's own column/);
		});

		it('accepts seek keys that reference no column of the sought table', () => {
			const nodes = walk(db.getPlan('select id from p where i = 10'));
			const seek = nodes.find(n => n instanceof IndexSeekNode) as IndexSeekNode | undefined;
			expect(seek).to.not.be.undefined;
			expect(() => assertSeekKeysRowIndependent(seek!.source, seek!.seekKeys, 'eqSeek')).to.not.throw();
		});
	});
});

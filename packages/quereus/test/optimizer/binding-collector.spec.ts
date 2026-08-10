import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import type { SqlParameters } from '../../src/common/types.js';

describe('Binding collector (collectBindingsInExpr / collectBindingsInPlan)', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	async function setup(): Promise<void> {
		await db.exec('CREATE TABLE bc (id INTEGER PRIMARY KEY, name TEXT, value INTEGER) USING memory');
		await db.exec("INSERT INTO bc VALUES (1, 'Alice', 10), (2, 'Bob', 20), (3, 'Charlie', 30)");
	}

	async function collect(sql: string, params?: SqlParameters): Promise<unknown[]> {
		const rows: unknown[] = [];
		for await (const r of db.eval(sql, params)) rows.push(r);
		return rows;
	}

	// --- Parameter binding collection ---

	describe('Parameter bindings', () => {
		it('single named parameter is collected and resolves correctly', async () => {
			await setup();
			const rows = await collect('select name from bc where id = :id', { id: 2 });
			expect(rows).to.deep.equal([{ name: 'Bob' }]);
		});

		it('single positional parameter is collected and resolves correctly', async () => {
			await setup();
			const rows = await collect('select name from bc where id = ?', [1]);
			expect(rows).to.deep.equal([{ name: 'Alice' }]);
		});

		it('multiple parameters in same expression', async () => {
			await setup();
			const rows = await collect(
				'select name from bc where id >= :lo and id <= :hi order by id',
				{ lo: 1, hi: 2 }
			);
			expect(rows).to.deep.equal([{ name: 'Alice' }, { name: 'Bob' }]);
		});

		it('same parameter referenced multiple times is deduplicated', async () => {
			await setup();
			// :val used in both WHERE conditions - should deduplicate
			const rows = await collect(
				'select name from bc where id = :val or value = :val order by id',
				{ val: 2 }
			);
			// id=2 matches Bob; value=2 matches nothing
			expect(rows).to.deep.equal([{ name: 'Bob' }]);
		});

		it('parameter in projection is collected', async () => {
			await setup();
			const rows = await collect('select name, :tag as tag from bc where id = 1', { tag: 'hello' });
			expect(rows).to.deep.equal([{ name: 'Alice', tag: 'hello' }]);
		});
	});

	// --- Correlated column reference collection ---

	describe('Correlated column references', () => {
		it('correlated EXISTS subquery collects outer column reference', async () => {
			await setup();
			const rows = await collect(
				'select b1.name from bc b1 where exists (select 1 from bc b2 where b2.id = b1.id) order by b1.id'
			);
			expect(rows).to.deep.equal([
				{ name: 'Alice' },
				{ name: 'Bob' },
				{ name: 'Charlie' },
			]);
		});

		it('correlated scalar subquery collects outer column reference', async () => {
			await setup();
			const rows = await collect(
				'select name, (select max(value) from bc b2 where b2.id <= b1.id) as running_max from bc b1 order by b1.id'
			);
			expect(rows).to.deep.equal([
				{ name: 'Alice', running_max: 10 },
				{ name: 'Bob', running_max: 20 },
				{ name: 'Charlie', running_max: 30 },
			]);
		});

		it('non-correlated subquery does not collect outer bindings', async () => {
			await setup();
			// Non-correlated subquery - inner query has no reference to outer
			const rows = await collect(
				'select name from bc where id in (select id from bc where value > 15) order by id'
			);
			expect(rows).to.deep.equal([{ name: 'Bob' }, { name: 'Charlie' }]);
		});
	});

	// --- dedupeById edge cases ---

	describe('Deduplication of bindings', () => {
		it('same parameter used in filter AND projection yields correct results', async () => {
			await setup();
			const rows = await collect(
				'select name, :x as param from bc where value > :x order by id',
				{ x: 15 }
			);
			expect(rows).to.deep.equal([
				{ name: 'Bob', param: 15 },
				{ name: 'Charlie', param: 15 },
			]);
		});

		it('no bindings needed for pure literal query', async () => {
			// No parameters, no correlations - should still work correctly
			const rows = await collect('select 1 + 2 as result');
			expect(rows).to.deep.equal([{ result: 3 }]);
		});
	});

	// --- Plan-level binding collection (collectBindingsInPlan) ---

	describe('Plan-level binding walking', () => {
		it('parameter bindings in JOIN conditions', async () => {
			await setup();
			await db.exec('CREATE TABLE bc2 (id INTEGER PRIMARY KEY, category TEXT) USING memory');
			await db.exec("INSERT INTO bc2 VALUES (1, 'A'), (2, 'B'), (3, 'A')");

			const rows = await collect(
				'select bc.name, bc2.category from bc join bc2 on bc.id = bc2.id where bc2.category = :cat order by bc.id',
				{ cat: 'A' }
			);
			expect(rows).to.deep.equal([
				{ name: 'Alice', category: 'A' },
				{ name: 'Charlie', category: 'A' },
			]);
		});

		it('parameter in subquery within JOIN', async () => {
			await setup();
			const rows = await collect(
				'select bc.name from bc where bc.value > :threshold order by bc.id',
				{ threshold: 10 }
			);
			expect(rows).to.deep.equal([
				{ name: 'Bob' },
				{ name: 'Charlie' },
			]);
		});

		it('parameter in LIMIT clause', async () => {
			await setup();
			const rows = await collect(
				'select name from bc order by id limit :n',
				{ n: 2 }
			);
			expect(rows).to.deep.equal([{ name: 'Alice' }, { name: 'Bob' }]);
		});
	});

	// --- Mixed bindings ---

	describe('Mixed parameter and correlation bindings', () => {
		it('parameter and correlation in same subquery', async () => {
			await setup();
			const rows = await collect(
				'select name from bc b1 where exists (select 1 from bc b2 where b2.id = b1.id and b2.value > :threshold) order by b1.id',
				{ threshold: 15 }
			);
			expect(rows).to.deep.equal([{ name: 'Bob' }, { name: 'Charlie' }]);
		});
	});
});

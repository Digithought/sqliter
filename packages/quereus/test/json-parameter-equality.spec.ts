import { expect } from 'chai';
import { Database } from '../src/core/database.js';
import type { SqlValue } from '../src/common/types.js';

type ResultRow = Record<string, SqlValue>;

/**
 * Bound parameters compared against a JSON column (ticket
 * `bug-json-equality-not-structural`).
 *
 * An unhinted parameter's plan-time type is TEXT, so it is the non-object side of
 * the comparison and `insertCrossTypeCoercion` wraps it in a cast to JSON — the
 * same treatment an inline text literal gets. `JSON_TYPE.parse` passes a native
 * object straight through, so binding an already-parsed document keeps working.
 *
 * Parameters are awkward to express in `.sqllogic`, so the structural-equality
 * contract for the literal forms lives in
 * `test/logic/06.9.2-json-structural-equality.sqllogic` and only the parameter
 * forms are pinned here.
 */
describe('JSON column equality with bound parameters', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table j (id integer primary key, v json)');
		await db.exec(`insert into j values (1, '{"a":1,"b":2}'), (2, '[1,2,3]')`);
	});

	afterEach(async () => {
		await db.close();
	});

	async function collect(sql: string, params?: SqlValue[] | Record<string, SqlValue>): Promise<ResultRow[]> {
		const rows: ResultRow[] = [];
		for await (const row of db.eval(sql, params)) {
			rows.push(row);
		}
		return rows;
	}

	/** Run the whole parameter contract, so it can be re-run with an index in place. */
	function describeContract(withIndex: boolean): void {
		const label = withIndex ? 'with a unique index' : 'without an index';

		describe(label, () => {
			beforeEach(async () => {
				if (withIndex) await db.exec('create unique index j_v on j (v)');
			});

			it('matches a text parameter holding byte-identical JSON source', async () => {
				expect(await collect('select id from j where v = ?', ['{"a":1,"b":2}']))
					.to.deep.equal([{ id: 1 }]);
			});

			it('matches a text parameter spaced and key-reordered differently', async () => {
				expect(await collect('select id from j where v = ?', ['{ "b" : 2 , "a" : 1 }']))
					.to.deep.equal([{ id: 1 }]);
			});

			it('matches a named text parameter', async () => {
				expect(await collect('select id from j where v = :doc', { doc: '{ "a" : 1 , "b" : 2 }' }))
					.to.deep.equal([{ id: 1 }]);
			});

			it('matches a natively-parsed object parameter', async () => {
				expect(await collect('select id from j where v = ?', [{ b: 2, a: 1 } as unknown as SqlValue]))
					.to.deep.equal([{ id: 1 }]);
			});

			it('keeps array element order significant', async () => {
				expect(await collect('select id from j where v = ?', ['[1,2,3]']))
					.to.deep.equal([{ id: 2 }]);
				expect(await collect('select id from j where v = ?', ['[3,2,1]']))
					.to.deep.equal([]);
			});

			it('returns no rows — not an error — for a parameter that is not valid JSON', async () => {
				expect(await collect('select id from j where v = ?', ['not json'])).to.deep.equal([]);
			});

			it('is UNKNOWN for a NULL parameter', async () => {
				expect(await collect('select id from j where v = ?', [null])).to.deep.equal([]);
			});

			it('applies the same coercion inside an IN list', async () => {
				expect(await collect('select id from j where v in (?, ?) order by id', ['{"b":2,"a":1}', '[1,2,3]']))
					.to.deep.equal([{ id: 1 }, { id: 2 }]);
			});

			it('applies the same coercion to BETWEEN bounds', async () => {
				expect(await collect('select id from j where v between ? and ?', ['{"a":1,"b":1}', '{"a":1,"b":3}']))
					.to.deep.equal([{ id: 1 }]);
			});

			it('returns the stored native document, not the parameter text', async () => {
				expect(await collect('select v from j where v = ?', ['{ "b" : 2 , "a" : 1 }']))
					.to.deep.equal([{ v: { a: 1, b: 2 } }]);
			});

			it('re-binds a prepared statement to a different document', async () => {
				const stmt = db.prepare('select id from j where v = ?');
				try {
					const first: ResultRow[] = [];
					for await (const row of stmt.all(['{ "b" : 2 , "a" : 1 }'])) first.push(row);
					expect(first).to.deep.equal([{ id: 1 }]);

					const second: ResultRow[] = [];
					for await (const row of stmt.all(['[1,2,3]'])) second.push(row);
					expect(second).to.deep.equal([{ id: 2 }]);
				} finally {
					await stmt.finalize();
				}
			});
		});
	}

	describeContract(false);
	describeContract(true);
});

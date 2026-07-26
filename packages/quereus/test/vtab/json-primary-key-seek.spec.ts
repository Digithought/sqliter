/**
 * Regression: a JSON value that is itself a JS array must not be mistaken for a
 * composite key tuple (ticket bug-json-index-range-seek-order).
 *
 * A one-column primary key stores the raw value as a SCALAR BTree key; a
 * multi-column one stores a `SqlValue[]` tuple. The memory scan path used to
 * recover that shape with `Array.isArray`, so a stored document like `[1]` or
 * `[null]` was read as a one-element tuple: range bounds compared against the
 * document's FIRST ELEMENT, and the seek-key NULL test saw `[null]` as a
 * NULL-bearing key and returned no rows at all.
 *
 * The shape now comes from the structure's arity. Cross-module coverage for the
 * SECONDARY-index half lives in `test/logic/06.9.3-json-index-range-seek.sqllogic`;
 * a JSON *primary key* is awkward to express there (store mode keys differently),
 * so it is pinned here against the memory module directly.
 */

import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import type { SqlValue } from '../../src/common/types.js';
import type { DatabaseDataChangeEvent } from '../../src/core/database-events.js';

/** Documents spanning every JSON kind, plus the array shapes that broke. */
const CORPUS: ReadonlyArray<readonly [string, string]> = [
	['false', 'f'],
	['true', 't'],
	['-1', 'neg'],
	['5', 'five'],
	['"a"', 'sa'],
	['"z"', 'sz'],
	['[]', 'arr0'],
	['[1]', 'arr1'],
	['[null]', 'arrnull'],
	['[9,9]', 'arr99'],
	['[[1,2],[3]]', 'nested'],
	['{}', 'obj0'],
	['{"a":1}', 'a1'],
	['{"a":10}', 'a10'],
];

describe('JSON primary key seeks (memory vtab)', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		// `k` keys on the JSON column (scalar PK); `n` has an integer PK so the same
		// predicate runs as a plain filter — the reference answer.
		await db.exec('create table k (v json primary key, tag text) using memory');
		await db.exec('create table n (id integer primary key, v json, tag text) using memory');
		let id = 0;
		for (const [doc, tag] of CORPUS) {
			await db.exec(`insert into k values ('${doc}', '${tag}')`);
			await db.exec(`insert into n values (${++id}, '${doc}', '${tag}')`);
		}
	});

	afterEach(async () => {
		await db.close();
	});

	async function tags(sql: string): Promise<string[]> {
		const out: string[] = [];
		for await (const row of db.eval(sql)) out.push(String((row as { tag: unknown }).tag));
		return out;
	}

	for (const predicate of [
		`where v > json('5')`,
		`where v >= json('5')`,
		`where v < json('"a"')`,
		`where v <= json('[1]')`,
		`where v > json('[1]')`,
		`where v between json('[1]') and json('{"a":1}')`,
		`where v = json('[null]')`,
		`where v = json('[1]')`,
		`where v = json('[]')`,
		`where v = json('[9,9]')`,
		`where v = json('{}')`,
		`where v in (json('[null]'), json('[1]'), json('{"a":10}'))`,
	]) {
		it(`PK seek matches the unindexed answer: ${predicate}`, async () => {
			const reference = await tags(`select tag from n ${predicate} order by tag`);
			const seek = await tags(`select tag from k ${predicate} order by tag`);
			expect(seek, predicate).to.deep.equal(reference);
			// Guard against the reference itself going empty and making the assert vacuous.
			expect(reference, `${predicate} must select at least one row`).to.not.be.empty;
		});
	}

	it('scalar JSON PK ordering matches the unindexed order', async () => {
		expect(await tags('select tag from k order by v')).to.deep.equal(
			await tags('select tag from n order by v'));
	});

	it('a document-valued PK does not lose its NULL-containing elements', async () => {
		// `[null]` is the shape a bound-comparison-only fix would leave broken: the
		// seek-key NULL test short-circuits before the tree lookup.
		expect(await tags(`select tag from k where v = json('[null]')`)).to.deep.equal(['arrnull']);
	});

	it('emits the data-change key as a one-component array for a scalar JSON PK', async () => {
		// The event contract carries the PK as a component array, so a scalar key is
		// wrapped: a document `[7]` must arrive as `[[7]]`, not as `[7]`.
		const events: DatabaseDataChangeEvent[] = [];
		const unsub = db.onDataChange(e => { events.push(e); });
		try {
			await db.exec(`insert into k values ('[7]', 'arr7')`);
		} finally {
			unsub();
		}
		const inserted = events.filter(e => e.tableName === 'k' && e.type === 'insert');
		expect(inserted, 'one insert event').to.have.length(1);
		expect(inserted[0].key as SqlValue[]).to.deep.equal([[7]]);
	});

	it('emits the data-change key with one component per column for a composite PK', async () => {
		await db.exec('create table c (a integer, b integer, primary key (a, b)) using memory');
		const events: DatabaseDataChangeEvent[] = [];
		const unsub = db.onDataChange(e => { events.push(e); });
		try {
			await db.exec('insert into c values (1, 2)');
		} finally {
			unsub();
		}
		const inserted = events.filter(e => e.tableName === 'c' && e.type === 'insert');
		expect(inserted, 'one insert event').to.have.length(1);
		expect(inserted[0].key as SqlValue[]).to.deep.equal([1, 2]);
	});
});

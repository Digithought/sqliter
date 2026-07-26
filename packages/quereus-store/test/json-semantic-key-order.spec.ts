/**
 * JSON key order and identity in the persistent store.
 *
 * Under the semantic-ordering ruling (docs/types.md "Semantic ordering"), a declared
 * JSON column orders by the structural deep-compare: type rank null < boolean <
 * number < string < array < object, then element/key-wise recursion with a length
 * tiebreak. The store encodes a JSON PK / index key member through the structural
 * byte form (`jsonStructuralKey`, src/common/json-key.ts), so its physical scan
 * order IS that order — previously the key bytes were canonical JSON text, which
 * scanned `[10]` before `[2]` and misaligned the isolation overlay's merge (an
 * in-transaction update surfaced a row twice, a delete left it visible — fix
 * `bug-json-pk-store-scan-order`).
 *
 * A memory table is the oracle throughout (its typed BTree emits structural order).
 * The isolation-layer section replays the original defect's repro verbatim.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database, asyncIterableToArray, type SqlValue } from '@quereus/quereus';
import { StoreModule, createIsolatedStoreModule, InMemoryKVStore, type KVStoreProvider } from '../src/index.js';

function createInMemoryProvider(): KVStoreProvider {
	const stores = new Map<string, InMemoryKVStore>();
	const get = (key: string) => {
		if (!stores.has(key)) stores.set(key, new InMemoryKVStore());
		return stores.get(key)!;
	};
	return {
		async getStore(s, t) { return get(`${s}.${t}`); },
		async getIndexStore(s, t, i) { return get(`${s}.${t}_idx_${i}`); },
		async getStatsStore(s, t) { return get(`${s}.${t}.__stats__`); },
		async getCatalogStore() { return get('__catalog__'); },
		async closeStore() {},
		async closeIndexStore() {},
		async closeAll() {
			for (const store of stores.values()) await store.close();
			stores.clear();
		},
	};
}

/** Every value of `column` produced by `sql`, in emission order. */
async function column(db: Database, sql: string, name: string): Promise<SqlValue[]> {
	return (await asyncIterableToArray(db.eval(sql))).map(r => r[name] as SqlValue);
}

/** Runs `sql`, returning the thrown error or null. */
async function attempt(db: Database, sql: string): Promise<Error | null> {
	try {
		await db.exec(sql);
		return null;
	} catch (e) {
		return e as Error;
	}
}

describe('JSON structural key order (store)', () => {
	let db: Database;
	let provider: KVStoreProvider;

	beforeEach(() => {
		db = new Database();
		provider = createInMemoryProvider();
		db.registerModule('store', new StoreModule(provider));
	});

	afterEach(async () => {
		await provider.closeAll();
		await db.close();
	});

	describe('plain-scan order matches the memory table', () => {
		it('emits array keys structurally: [2] < [3] < [10], not text order', async () => {
			await db.exec(`create table t (j json primary key) using store`);
			await db.exec(`create table m (j json primary key)`);
			for (const tbl of ['t', 'm']) {
				await db.exec(`insert into ${tbl} values ('[2]'), ('[10]'), ('[3]')`);
			}
			// Canonical-text bytes emitted ['[10]','[2]','[3]'] here.
			const scan = await column(db, `select json_quote(j) as q from t`, 'q');
			expect(scan).to.deep.equal(['[2]', '[3]', '[10]']);
			expect(scan).to.deep.equal(await column(db, `select json_quote(j) as q from m`, 'q'));
		});

		it('ranks all six JSON kinds: null < boolean < number < string < array < object', async () => {
			await db.exec(`create table t (j json primary key) using store`);
			await db.exec(`create table m (j json primary key)`);
			for (const tbl of ['t', 'm']) {
				await db.exec(
					`insert into ${tbl} values ('{"a":1}'), ('[2]'), ('"abc"'), ('7'), ('true'), ('null')`);
			}
			const scan = await column(db, `select json_quote(j) as q from t`, 'q');
			expect(scan).to.deep.equal(['null', 'true', '7', '"abc"', '[2]', '{"a":1}']);
			expect(scan).to.deep.equal(await column(db, `select json_quote(j) as q from m`, 'q'));
		});

		it('orders nested structures by element-wise recursion', async () => {
			await db.exec(`create table t (j json primary key) using store`);
			await db.exec(`create table m (j json primary key)`);
			for (const tbl of ['t', 'm']) {
				await db.exec(`insert into ${tbl} values `
					+ `('{"a":{"b":10}}'), ('[[2]]'), ('[[1],2]'), ('{"a":{"b":2}}'), ('[[1]]')`);
			}
			const scan = await column(db, `select json_quote(j) as q from t`, 'q');
			expect(scan).to.deep.equal(['[[1]]', '[[1],2]', '[[2]]', '{"a":{"b":2}}', '{"a":{"b":10}}']);
			expect(scan).to.deep.equal(await column(db, `select json_quote(j) as q from m`, 'q'));
		});

		it('applies the length tiebreak, and keys {} apart from {"":0}', async () => {
			await db.exec(`create table t (j json primary key) using store`);
			await db.exec(`create table m (j json primary key)`);
			for (const tbl of ['t', 'm']) {
				await db.exec(`insert into ${tbl} values ('[2,0]'), ('{"":0}'), ('[2]'), ('{}')`);
			}
			// A proper prefix sorts first; an empty-string key is a real (distinct) key.
			const scan = await column(db, `select json_quote(j) as q from t`, 'q');
			expect(scan).to.deep.equal(['[2]', '[2,0]', '{}', '{"":0}']);
			expect(scan).to.deep.equal(await column(db, `select json_quote(j) as q from m`, 'q'));
		});

		it('keeps JSON-number-spelled string scalars distinct, in code-point order', async () => {
			// '"9"' and '"9.0"' are both string leaves, not numbers — they must stay
			// separate rows and scan in code-point order ('"10"' < '"9"' < '"9.0"'),
			// not numeric order.
			await db.exec(`create table t (j json primary key) using store`);
			await db.exec(`create table m (j json primary key)`);
			for (const tbl of ['t', 'm']) {
				await db.exec(`insert into ${tbl} values ('"9"'), ('"9.0"'), ('"10"')`);
			}
			const scan = await column(db, `select json_quote(j) as q from t`, 'q');
			expect(scan).to.deep.equal(['"10"', '"9"', '"9.0"']);
			expect(scan).to.deep.equal(await column(db, `select json_quote(j) as q from m`, 'q'));
		});

		it('iterates a DESC JSON PK in reverse structural order', async () => {
			// DESC bit-inverts the structural blob's key bytes — variable-length, escaped,
			// 0x00-terminated — which must still reverse cleanly.
			await db.exec(`create table t (j json, primary key (j desc)) using store`);
			await db.exec(`insert into t values ('[2]'), ('[10]'), ('[3]')`);
			expect(await column(db, `select json_quote(j) as q from t`, 'q'))
				.to.deep.equal(['[10]', '[3]', '[2]']);
		});

		it('still runs a real Sort for order by (advertisement stays declined)', async () => {
			await db.exec(`create table t (j json primary key) using store`);
			await db.exec(`create table m (j json primary key)`);
			for (const tbl of ['t', 'm']) {
				await db.exec(`insert into ${tbl} values ('[10]'), ('{"a":1}'), ('[2]')`);
			}
			expect(await column(db, `select json_quote(j) as q from t order by j`, 'q'))
				.to.deep.equal(await column(db, `select json_quote(j) as q from m order by j`, 'q'));
		});
	});

	describe('primary key identity', () => {
		it('rejects a reorder-equal object spelling as a duplicate PK, as the memory table does', async () => {
			await db.exec(`create table t (j json primary key, v text) using store`);
			await db.exec(`create table m (j json primary key, v text)`);

			for (const tbl of ['t', 'm']) {
				await db.exec(`insert into ${tbl} values ('{"a":1,"b":2}', 'first')`);
				const err = await attempt(db, `insert into ${tbl} values ('{"b":2,"a":1}', 'second')`);
				expect(err, `${tbl} must reject the reorder-equal spelling`).to.not.be.null;
				expect(String(err)).to.match(/unique/i);
				expect((await db.get(`select count(*) as cnt from ${tbl}`))?.cnt).to.equal(1);
			}
		});

		it('rejects a JSON-number-spelled string PK as a duplicate when it collides via a UNIQUE column, as the memory table does', async () => {
			// Repro for bug-json-pk-equality-drops-collation: '"9"' and '"9.0"' are
			// distinct string-scalar PKs, but the store's self-PK-exclusion check used to
			// build its equality comparator with no collation, which made JSON_TYPE.compare
			// re-parse both as the number 9 and call them the same row — so the second
			// insert's own UNIQUE conflict search excluded the first row from consideration
			// and the violation went unraised.
			await db.exec(`create table t (j json primary key, u text unique) using store`);
			await db.exec(`create table m (j json primary key, u text unique)`);

			for (const tbl of ['t', 'm']) {
				await db.exec(`insert into ${tbl} values ('"9"', 'dup')`);
				const err = await attempt(db, `insert into ${tbl} values ('"9.0"', 'dup')`);
				expect(err, `${tbl} must reject the duplicate 'u' value`).to.not.be.null;
				expect(String(err)).to.match(/unique/i);
				expect((await db.get(`select count(*) as cnt from ${tbl}`))?.cnt).to.equal(1);
			}
		});

		it('honors `insert or ignore` and `insert or replace` across reorder-equal spellings', async () => {
			// NOTE: rows are addressed through `v` here — a JSON column compared against a
			// TEXT literal (`where j = '{"a":1}'`) matches nothing on the memory backend
			// either (storage-class mismatch in the generic EQ path), so cross-spelling
			// predicate addressing is out of this spec's scope.
			await db.exec(`create table t (j json primary key, v text) using store`);
			await db.exec(`insert into t values ('{"a":1,"b":2}', 'orig')`);

			await db.exec(`insert or ignore into t values ('{"b":2,"a":1}', 'ignored')`);
			expect((await db.get(`select count(*) as cnt from t`))?.cnt).to.equal(1);
			expect((await db.get(`select v from t`))?.v).to.equal('orig');

			await db.exec(`insert or replace into t values ('{"b":2,"a":1}', 'replaced')`);
			expect((await db.get(`select count(*) as cnt from t`))?.cnt).to.equal(1);
			expect((await db.get(`select v from t`))?.v).to.equal('replaced');
		});
	});

	describe('secondary UNIQUE identity', () => {
		it('rejects a reorder-equal duplicate in a UNIQUE json column', async () => {
			await db.exec(`create table t (id integer primary key, j json unique) using store`);
			await db.exec(`insert into t values (1, '{"a":1,"b":2}')`);
			const err = await attempt(db, `insert into t values (2, '{"b":2,"a":1}')`);
			expect(err, 'the enforcement seek must land on the reorder-equal entry').to.not.be.null;
			expect(String(err)).to.match(/unique/i);
		});

		it('rejects `create unique index` over existing reorder-equal spellings', async () => {
			await db.exec(`create table t (id integer primary key, j json) using store`);
			await db.exec(`insert into t values (1, '{"a":1,"b":2}'), (2, '{"b":2,"a":1}')`);
			const err = await attempt(db, `create unique index t_j on t (j)`);
			expect(err, 'the build-time dedup must see one identity').to.not.be.null;
			expect(String(err)).to.match(/unique/i);
		});
	});
});

describe('JSON structural key order (isolated store)', () => {
	let db: Database;
	let provider: KVStoreProvider;

	beforeEach(async () => {
		db = new Database();
		provider = createInMemoryProvider();
		db.registerModule('store', createIsolatedStoreModule({ provider }));
		await db.exec(`create table t (j json primary key, v int) using store`);
	});

	afterEach(async () => {
		await provider.closeAll();
		await db.close();
	});

	it('an in-transaction UPDATE surfaces the row ONCE (the original repro)', async () => {
		// With canonical-text key bytes the merge lost alignment and this select
		// returned FOUR rows: the updated row in both its new and committed form.
		await db.exec(`insert into t values ('[2]', 1), ('[10]', 2), ('[3]', 3)`);

		await db.exec('begin');
		await db.exec(`update t set v = 99 where v = 1`);
		const staged = await asyncIterableToArray(db.eval(`select json_quote(j) as q, v from t`));
		expect(staged).to.have.lengthOf(3);
		expect(staged.map(r => `${r.q}:${r.v}`).sort())
			.to.deep.equal(['[10]:2', '[2]:99', '[3]:3']);
		await db.exec('commit');

		const final = await asyncIterableToArray(db.eval(`select json_quote(j) as q, v from t`));
		expect(final.map(r => `${r.q}:${r.v}`).sort())
			.to.deep.equal(['[10]:2', '[2]:99', '[3]:3']);
	});

	it('an in-transaction DELETE hides the row (the original repro)', async () => {
		// With canonical-text key bytes this select still returned the deleted row.
		await db.exec(`insert into t values ('[2]', 1), ('[10]', 2), ('[3]', 3)`);

		await db.exec('begin');
		await db.exec(`delete from t where v = 1`);
		expect(await column(db, `select json_quote(j) as q from t`, 'q'))
			.to.deep.equal(['[3]', '[10]']);
		await db.exec('commit');
		expect((await db.get(`select count(*) as cnt from t`))?.cnt).to.equal(2);
	});

	it('an overlay rewrite spelled with reordered keys shadows the committed row', async () => {
		await db.exec(`create table o (j json primary key, v text) using store`);
		await db.exec(`insert into o values ('{"a":1,"b":2}', 'committed')`);

		await db.exec('begin');
		await db.exec(`insert or replace into o values ('{"b":2,"a":1}', 'staged')`);
		const staged = await asyncIterableToArray(db.eval(`select v from o`));
		expect(staged).to.have.lengthOf(1);
		expect(staged[0].v).to.equal('staged');
		await db.exec('commit');

		expect((await db.get(`select count(*) as cnt from o`))?.cnt).to.equal(1);
	});

	it('keeps a JSON-number-spelled string PK distinct from a committed row across `insert or replace`', async () => {
		// Repro for bug-json-pk-equality-drops-collation, replayed through the isolation
		// overlay: staging '"9.0"' as `insert or replace` must NOT be treated as a
		// rewrite of the committed '"9"' row — they are different rows. (UPDATE/DELETE
		// of a JSON string-scalar row are out of scope here — see
		// bug-json-string-scalar-not-round-trip-safe.)
		await db.exec(`create table o (j json primary key, v text) using store`);
		await db.exec(`insert into o values ('"9"', 'committed')`);

		await db.exec('begin');
		await db.exec(`insert or replace into o values ('"9.0"', 'staged')`);
		const staged = await asyncIterableToArray(db.eval(`select json_quote(j) as q, v from o`));
		expect(staged).to.have.lengthOf(2);
		expect(staged.map(r => `${r.q}:${r.v}`).sort())
			.to.deep.equal(['"9":committed', '"9.0":staged']);
		await db.exec('commit');

		const final = await asyncIterableToArray(db.eval(`select json_quote(j) as q, v from o`));
		expect(final).to.have.lengthOf(2);
		expect(final.map(r => `${r.q}:${r.v}`).sort())
			.to.deep.equal(['"9":committed', '"9.0":staged']);
	});

	it('shadows inside an equal-integer group of a composite (int, json) PK', async () => {
		// The leading integer members tie, so the merge's alignment hinges entirely on
		// the JSON member's order — exactly where text-vs-structural divergence hid.
		await db.exec(`create table c (a integer, j json, v text, primary key (a, j)) using store`);
		await db.exec(`insert into c values (1, '[2]', 'a'), (1, '[10]', 'b'), (1, '[3]', 'c'), (2, '[2]', 'd')`);

		await db.exec('begin');
		await db.exec(`update c set v = 'X' where a = 1 and v = 'a'`);
		const afterUpdate = await asyncIterableToArray(db.eval(`select a, json_quote(j) as q, v from c`));
		expect(afterUpdate).to.have.lengthOf(4);
		expect(afterUpdate.filter(r => r.v === 'X')).to.have.lengthOf(1);

		await db.exec(`delete from c where a = 1 and v = 'b'`);
		expect((await db.get(`select count(*) as cnt from c`))?.cnt).to.equal(3);
		await db.exec('commit');

		const final = await asyncIterableToArray(db.eval(`select json_quote(j) as q, v from c`));
		expect(final.map(r => `${r.q}:${r.v}`).sort())
			.to.deep.equal(['[2]:X', '[2]:d', '[3]:c']);
	});

	describe('DELETE of a JSON string-scalar key does not re-coerce the tombstone', () => {
		// Repro for bug-json-tombstone-recoerces-stored-key: the delete tombstone
		// carried the deleted row's already-converted PK back through the overlay's
		// own coercion pass. A string-scalar key that happens to look like a JSON
		// number ('"9"') got parsed a second time into the number 9, so the
		// tombstone landed at the wrong key and the row stayed visible. A key
		// whose text is not valid JSON source ('"abc"') threw instead.

		it('removes exactly the targeted row in autocommit, leaving its sibling', async () => {
			await db.exec(`create table sd (j json primary key, v text) using store`);
			await db.exec(`insert into sd values ('"9"', 'a'), ('"9.0"', 'b')`);

			await db.exec(`delete from sd where v = 'a'`);

			const rows = await asyncIterableToArray(db.eval(`select json_quote(j) as q, v from sd`));
			expect(rows).to.have.lengthOf(1);
			expect(rows[0].q).to.equal('"9.0"');
		});

		it('removes exactly the targeted row inside an explicit transaction', async () => {
			await db.exec(`create table sd2 (j json primary key, v text) using store`);
			await db.exec(`insert into sd2 values ('"9"', 'a'), ('"9.0"', 'b')`);

			await db.exec('begin');
			await db.exec(`delete from sd2 where v = 'a'`);
			const staged = await asyncIterableToArray(db.eval(`select json_quote(j) as q, v from sd2`));
			expect(staged).to.have.lengthOf(1);
			expect(staged[0].q).to.equal('"9.0"');
			await db.exec('commit');

			const final = await asyncIterableToArray(db.eval(`select json_quote(j) as q, v from sd2`));
			expect(final).to.have.lengthOf(1);
			expect(final[0].q).to.equal('"9.0"');
		});

		it('does not throw deleting a key whose text is not valid JSON source, in autocommit', async () => {
			await db.exec(`create table sd3 (j json primary key, v text) using store`);
			await db.exec(`insert into sd3 values ('"abc"', 'a')`);

			await db.exec(`delete from sd3 where v = 'a'`);

			expect((await db.get(`select count(*) as cnt from sd3`))?.cnt).to.equal(0);
		});

		it('does not throw deleting a key whose text is not valid JSON source, inside an explicit transaction', async () => {
			await db.exec(`create table sd4 (j json primary key, v text) using store`);
			await db.exec(`insert into sd4 values ('"abc"', 'a')`);

			await db.exec('begin');
			await db.exec(`delete from sd4 where v = 'a'`);
			expect((await db.get(`select count(*) as cnt from sd4`))?.cnt).to.equal(0);
			await db.exec('commit');

			expect((await db.get(`select count(*) as cnt from sd4`))?.cnt).to.equal(0);
		});

		it('converts an overlay row staged earlier in the same transaction into a tombstone', async () => {
			// The other delete cases shadow a COMMITTED row (fresh-tombstone insert). This
			// one re-writes a row the overlay itself already holds, which takes the
			// convert-to-tombstone update instead — a separate write that carried the same
			// double-coercion defect.
			await db.exec(`create table sd5 (j json primary key, v text) using store`);
			await db.exec(`insert into sd5 values ('"9"', 'a'), ('"9.0"', 'b')`);

			await db.exec('begin');
			await db.exec(`insert or replace into sd5 values ('"9"', 'z')`);
			await db.exec(`delete from sd5 where v = 'z'`);
			const staged = await asyncIterableToArray(db.eval(`select json_quote(j) as q, v from sd5`));
			expect(staged.map(r => `${r.q}:${r.v}`)).to.deep.equal(['"9.0":b']);
			await db.exec('commit');

			const final = await asyncIterableToArray(db.eval(`select json_quote(j) as q, v from sd5`));
			expect(final.map(r => `${r.q}:${r.v}`)).to.deep.equal(['"9.0":b']);
		});

		it('tombstones the row a UNIQUE `or replace` evicts', async () => {
			// The eviction routes through the shared insertTombstoneForPK helper rather
			// than the delete branch, so it exercises the third fixed tombstone write.
			await db.exec(`create table su (j json primary key, v text unique) using store`);
			await db.exec(`insert into su values ('"9"', 'a'), ('"7"', 'keep')`);

			await db.exec('begin');
			await db.exec(`insert or replace into su values ('"9.0"', 'a')`);
			const staged = await asyncIterableToArray(db.eval(`select json_quote(j) as q, v from su`));
			expect(staged.map(r => `${r.q}:${r.v}`).sort()).to.deep.equal(['"7":keep', '"9.0":a']);
			await db.exec('commit');

			const final = await asyncIterableToArray(db.eval(`select json_quote(j) as q, v from su`));
			expect(final.map(r => `${r.q}:${r.v}`).sort()).to.deep.equal(['"7":keep', '"9.0":a']);
		});
	});
});

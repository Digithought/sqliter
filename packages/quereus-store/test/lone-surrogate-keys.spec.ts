/**
 * A JS string is a sequence of 16-bit code units. A character above U+FFFF is stored as a
 * SURROGATE PAIR — a high unit (U+D800–U+DBFF) followed by a low unit (U+DC00–U+DFFF). A
 * string may also hold a LONE (unpaired) surrogate: a half with no matching other half.
 * That is a legal JS string and a legal Quereus `text` value, but it is not valid Unicode:
 * it denotes no character, and no UTF-8 byte sequence encodes it.
 *
 * The store keys text by its UTF-8 bytes, and `TextEncoder` silently folds EVERY unpaired
 * surrogate to U+FFFD (`EF BF BD`). All 2048 of them would therefore share one key byte
 * string: `insert into s values ('\uD800'), ('\uD801')` raised a spurious `UNIQUE`
 * violation, and — the invisible half — an upsert keyed on a lone surrogate would overwrite
 * a row holding a *different* value. Secondary-index keys collided the same way.
 *
 * The fix rejects the value at encode time rather than merging rows: `encodeText` raises. A
 * memory table keeps accepting it (it compares strings, never encodes them), so this is the
 * one deliberate memory-vs-store divergence, and these tests pin it from both sides —
 * the store must raise a message that NAMES the problem (never a `UNIQUE` violation), and
 * memory must still store both values as distinct rows.
 *
 * Well-formed astral characters are unaffected and keep working; their ordering is
 * `astral-text-keys.spec.ts`.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database, asyncIterableToArray, type SqlValue } from '@quereus/quereus';
import { StoreModule, InMemoryKVStore, type KVStoreProvider } from '../src/index.js';

/** Lone high surrogate — no low surrogate follows. */
const LONE_HIGH = '\uD800';
/** A different lone high surrogate. Distinct value; identical UTF-8 bytes under TextEncoder. */
const LONE_HIGH_2 = '\uD801';
/** Lone low surrogate — no high surrogate precedes. */
const LONE_LOW = '\uDC00';
/** U+10000 — the same two code-unit ranges, legally PAIRED. Must keep working. */
const ASTRAL = '\u{10000}';

/** The error every store-side rejection must carry; never a UNIQUE violation. */
const REJECTED = /unpaired surrogate/i;

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

/**
 * Asserts `sql` rejects with the unpaired-surrogate error, and NOT with a UNIQUE violation.
 * A `select` is drained rather than `exec`'d: its rows are produced lazily, so an error
 * raised while building a seek bound only surfaces once the cursor is pulled.
 */
async function rejects(db: Database, sql: string): Promise<void> {
	let raised: unknown;
	try {
		if (/^\s*select/i.test(sql)) await asyncIterableToArray(db.eval(sql));
		else await db.exec(sql);
	} catch (e) {
		raised = e;
	}
	expect(raised, `expected \`${sql}\` to raise`).to.be.an('error');
	const message = (raised as Error).message;
	expect(message, `must name the real problem: ${message}`).to.match(REJECTED);
	expect(message, `a spurious UNIQUE violation is the bug, not the fix: ${message}`)
		.to.not.match(/unique/i);
}

describe('Lone surrogates are refused by the store and accepted in memory', () => {
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

	describe('a text primary key', () => {
		beforeEach(async () => {
			await db.exec(`create table s (k text primary key, v text) using store`);
			await db.exec(`create table m (k text primary key, v text)`);
		});

		it('stores both lone surrogates as distinct rows in memory (the oracle)', async () => {
			// The values ARE distinct. The store's old key bytes said otherwise.
			await db.exec(`insert into m values ('${LONE_HIGH}', 'one'), ('${LONE_HIGH_2}', 'two')`);
			expect(await column(db, `select v from m order by k`, 'v')).to.deep.equal(['one', 'two']);
		});

		it('rejects the first insert of a lone surrogate rather than waiting to collide', async () => {
			await rejects(db, `insert into s values ('${LONE_HIGH}', 'one')`);
			expect(await column(db, `select k from s`, 'k'), 'nothing was written').to.deep.equal([]);
		});

		it('rejects the second insert without reporting a UNIQUE violation', async () => {
			// The original bug: this pair raised `UNIQUE constraint failed: s PK`, claiming two
			// different values were the same row.
			await rejects(db, `insert into s values ('${LONE_HIGH}', 'one'), ('${LONE_HIGH_2}', 'two')`);
		});

		it('rejects a lone LOW surrogate, and one embedded mid-string', async () => {
			await rejects(db, `insert into s values ('${LONE_LOW}', 'low')`);
			await rejects(db, `insert into s values ('a${LONE_HIGH}b', 'mid')`);
		});

		it('rejects an update that moves an existing row onto a lone-surrogate key', async () => {
			await db.exec(`insert into s values ('a', 'one')`);
			await rejects(db, `update s set k = '${LONE_HIGH}' where k = 'a'`);
			expect(await column(db, `select k from s`, 'k'), 'the row is untouched').to.deep.equal(['a']);
		});

		it('rejects an upsert keyed on a lone surrogate rather than overwriting an unrelated row', async () => {
			// The invisible half of the bug: `\uD801` and `\uD800` share one key, so this
			// `or replace` would have silently clobbered the `\uD800` row.
			await rejects(db, `insert or replace into s values ('${LONE_HIGH}', 'one')`);
		});

		it('rejects a delete keyed on a lone surrogate rather than deleting an unrelated row', async () => {
			// The delete's seek bound encodes exactly as the insert's key did. Unguarded,
			// `delete from s where k = '\uD801'` would have removed the `\uD800` row.
			await db.exec(`insert into s values ('a', 'one')`);
			await rejects(db, `delete from s where k = '${LONE_HIGH}'`);
			expect(await column(db, `select k from s`, 'k'), 'the row is untouched').to.deep.equal(['a']);
		});

		it('still accepts a well-formed astral key', async () => {
			await db.exec(`insert into s values ('${ASTRAL}', 'astral')`);
			expect((await db.get(`select v from s where k = '${ASTRAL}'`))?.v).to.equal('astral');
		});

		it('rejects a range-seek bound built from a lone-surrogate literal', async () => {
			// A bound that cannot be encoded must NOT be silently widened (extra rows) or
			// narrowed (missing rows) — it has no faithful byte position at all.
			await db.exec(`insert into s values ('a', 'one'), ('${ASTRAL}', 'astral')`);
			await rejects(db, `select k from s where k > '${LONE_HIGH}'`);
			await rejects(db, `select k from s where k = '${LONE_HIGH}'`);
		});

		it('rejects under NOCASE and RTRIM key collations too', async () => {
			await db.exec(`create table sn (k text collate nocase primary key) using store`);
			await db.exec(`create table sr (k text collate rtrim primary key) using store`);
			await rejects(db, `insert into sn values ('${LONE_HIGH}')`);
			await rejects(db, `insert into sr values ('${LONE_HIGH}')`);
		});
	});

	describe('a secondary index over a text column', () => {
		beforeEach(async () => {
			await db.exec(`create table s (id integer primary key, k text) using store`);
			await db.exec(`create index ix_sk on s (k)`);
		});

		it('rejects an insert whose indexed column carries a lone surrogate', async () => {
			// Index-key encoding collides exactly as the PK does; the guard sits under both.
			await rejects(db, `insert into s values (1, '${LONE_HIGH}')`);
		});

		it('rejects an update that writes a lone surrogate into the indexed column', async () => {
			await db.exec(`insert into s values (1, 'a')`);
			await rejects(db, `update s set k = '${LONE_HIGH}' where id = 1`);
			expect(await column(db, `select k from s`, 'k')).to.deep.equal(['a']);
		});
	});

	describe('a non-key text column', () => {
		// Row VALUES are serialized with `JSON.stringify`, which is well-formed (ES2019) and
		// escapes a lone surrogate to the ASCII characters `\ud800`. Only KEY bytes are lost,
		// so an unindexed column stores and returns the value intact — the divergence from a
		// memory table is confined to keys.
		beforeEach(async () => {
			await db.exec(`create table s (id integer primary key, v text) using store`);
		});

		it('stores and returns a lone surrogate unchanged', async () => {
			await db.exec(`insert into s values (1, '${LONE_HIGH}'), (2, '${LONE_HIGH_2}')`);
			expect(await column(db, `select v from s order by id`, 'v'))
				.to.deep.equal([LONE_HIGH, LONE_HIGH_2]);
		});

		it('keeps the two values distinct under a comparator predicate', async () => {
			await db.exec(`insert into s values (1, '${LONE_HIGH}'), (2, '${LONE_HIGH_2}')`);
			expect(await column(db, `select id from s where v = '${LONE_HIGH}'`, 'id')).to.deep.equal([1]);
		});
	});

	describe('an `any` primary key holding JSON', () => {
		// `encodeObject` encodes `JSON.stringify`'s output, so a lone surrogate inside a JSON
		// value is already escaped to ASCII before the UTF-8 step. No collision, no rejection.
		it('keys two JSON values differing only in a lone surrogate as distinct rows', async () => {
			await db.exec(`create table s (k any primary key, v text) using store`);
			await db.exec(`insert into s values (json('["\\ud800"]'), 'one'), (json('["\\ud801"]'), 'two')`);
			expect(await column(db, `select v from s order by k`, 'v')).to.have.lengthOf(2);
		});
	});

	describe('a declared `json` primary key', () => {
		// A DECLARED-json key member encodes structurally (json-key.ts): string leaves and
		// object keys are keyed by their own UTF-8 bytes, so a lone surrogate inside them
		// is refused exactly as a text key is — unlike the `any` column above, whose
		// canonical-text encoding is accidentally safe behind JSON.stringify's ASCII
		// escapes. The memory table keeps accepting the value; same deliberate divergence.
		beforeEach(async () => {
			await db.exec(`create table j (k json primary key, v text) using store`);
		});

		it('rejects a JSON key whose string leaf carries a lone surrogate', async () => {
			await rejects(db, `insert into j values ('["\\ud800"]', 'one')`);
			expect(await column(db, `select v from j`, 'v'), 'nothing was written').to.deep.equal([]);
		});

		it('rejects a JSON key whose object key carries a lone surrogate', async () => {
			await rejects(db, `insert into j values ('{"\\ud800":1}', 'one')`);
		});

		it('the memory table accepts the same JSON value (the divergence oracle)', async () => {
			await db.exec(`create table jm (k json primary key, v text)`);
			await db.exec(`insert into jm values ('["\\ud800"]', 'one'), ('["\\ud801"]', 'two')`);
			expect(await column(db, `select v from jm`, 'v')).to.have.lengthOf(2);
		});

		it('still accepts a well-formed astral leaf', async () => {
			await db.exec(`insert into j values ('["${ASTRAL}"]', 'astral')`);
			expect((await db.get(`select count(*) as cnt from j`))?.cnt).to.equal(1);
		});
	});

	describe('an identifier or persisted DDL text carrying a lone surrogate', () => {
		// Companion to the value-side guard above: `buildCatalogKey` folded an unpaired
		// surrogate in a TABLE NAME to U+FFFD exactly like `encodeText` did for a value —
		// so two tables whose quoted names differed only in a lone surrogate shared one
		// catalog key, and the second table's DDL write silently clobbered the first's on
		// reopen (`bug-store-catalog-key-lone-surrogate-identifier-collision`). DDL text is
		// persisted lazily, on first access to the table's underlying store (see
		// `StoreTable.initializeStore`), so the rejection surfaces on the first INSERT/SELECT
		// against the table, not at `CREATE TABLE` itself.

		it('rejects persisting DDL for a table named with a lone surrogate, on first data access', async () => {
			await db.exec(`create table "${LONE_HIGH}" (k integer primary key) using store`);
			await rejects(db, `insert into "${LONE_HIGH}" values (1)`);
			// Nothing was silently written under a folded U+FFFD key.
			const mod = new StoreModule(provider);
			expect((await mod.loadAllDDL())).to.deep.equal([]);
		});

		it('rejects both of two tables whose names differ only in a lone surrogate, never colliding', async () => {
			// Pre-fix this was the invisible half of the bug: the SECOND create's lazy DDL
			// save would silently overwrite the FIRST's catalog entry. Now both are refused
			// outright — the identifier is invalid, independent of whether another table
			// happens to share its folded bytes.
			await db.exec(`create table "${LONE_HIGH}" (k integer primary key) using store`);
			await db.exec(`create table "${LONE_HIGH_2}" (k integer primary key) using store`);
			await rejects(db, `insert into "${LONE_HIGH}" values (1)`);
			await rejects(db, `insert into "${LONE_HIGH_2}" values (2)`);
		});

		it('rejects a schema.table pair persisted via CREATE INDEX (a direct, non-lazy save path)', async () => {
			await db.exec(`create table "${LONE_HIGH}" (id integer primary key, v integer) using store`);
			await rejects(db, `create index ix on "${LONE_HIGH}" (v)`);
		});

		it('rejects a column name carrying a lone surrogate, not just the table name', async () => {
			// The DDL-text guard fires on the FULL persisted text, so a quoted column name
			// is caught even though the table's own name is clean.
			await db.exec(`create table t (id integer primary key, "${LONE_HIGH}" text) using store`);
			await rejects(db, `insert into t (id, "${LONE_HIGH}") values (1, 'x')`);
		});

		it('rejects a DEFAULT string literal carrying a lone surrogate', async () => {
			// Neither the table name nor any identifier is at fault here — a column
			// DEFAULT's string constant is reconstructed verbatim into the persisted DDL,
			// so it must be guarded too (not just the catalog-key identifiers).
			await db.exec(`create table t2 (id integer primary key, v text default '${LONE_HIGH}') using store`);
			await rejects(db, `insert into t2 (id) values (1)`);
		});
	});
});

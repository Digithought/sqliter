/**
 * The store writes each text key as UTF-8 bytes and physically orders rows by `memcmp` of
 * those bytes — Unicode CODE-POINT order. The built-in collations (`BINARY`, `NOCASE`,
 * `RTRIM`) and the OBJECT-class branch of `compareSameType` therefore compare by code point
 * too (`compareCodePoints`), rather than with JS `<`/`>`, which orders by UTF-16 CODE UNIT.
 *
 * The two orders agree below U+D800 and disagree above U+FFFF: an astral character such as
 * U+1F600 (😀) is a surrogate pair whose leading unit lies in U+D800–U+DBFF, so `<` sorts it
 * BELOW every U+E000–U+FFFF character — including U+FF21 (Ａ, fullwidth capital A) and the
 * rest of the Halfwidth/Fullwidth Forms — while its UTF-8 encoding (`F0 9F 98 80`) sorts
 * ABOVE theirs (`EF BC A1`).
 *
 * When the comparator disagreed with the bytes, the `orderPreserving` stamp the built-ins
 * carry was a lie, and the store acted on it: a range predicate narrowed to a byte window and
 * dropped the residual filter (so `k < 'Ａ'` silently lost the emoji row), and the PK-order
 * advertisement elided the `Sort` (so `order by k` emitted byte order, not comparator order).
 *
 * A memory table — which orders and filters purely by comparator — is the oracle. Every test
 * here asserts store output EQUALS memory output, and that the plan still contains its
 * `IndexSeek` / still elides its `Sort`: a future regression that fixed the rows by silently
 * retracting the stamp would pass the row checks alone.
 *
 * Unpaired surrogates are out of scope here — they have no UTF-8 encoding at all, so no
 * comparator can be order-preserving over them. The store refuses to key them instead; see
 * `lone-surrogate-keys.spec.ts`.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database, asyncIterableToArray, type SqlValue } from '@quereus/quereus';
import { StoreModule, InMemoryKVStore, type KVStoreProvider } from '../src/index.js';

/** U+1F600 GRINNING FACE — astral; UTF-8 `F0 9F 98 80`. */
const EMOJI = '\u{1F600}';
/** U+FF21 FULLWIDTH LATIN CAPITAL LETTER A — BMP, above the surrogates; UTF-8 `EF BC A1`. */
const WIDE_A = 'Ａ';
/** U+FF41 FULLWIDTH LATIN SMALL LETTER A — `toLowerCase(WIDE_A)`. */
const WIDE_a = 'ａ';
/** U+10400 DESERET CAPITAL LONG I — astral, and it has a lowercase form. */
const DESERET_UPPER = '\u{10400}';
/** U+10428 DESERET SMALL LONG I — `toLowerCase(DESERET_UPPER)`. */
const DESERET_LOWER = '\u{10428}';

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

/** The JSON array of physical operator names for `query`'s plan. */
async function planOps(db: Database, query: string): Promise<string> {
	const rows = await asyncIterableToArray(
		db.eval(`select json_group_array(op) as ops from query_plan(?)`, [query]),
	);
	expect(rows).to.have.lengthOf(1);
	return rows[0].ops as string;
}

const SEEK = /INDEXSEEK|INDEX SEEK|IndexSeek/i;

describe('Astral text keys order identically in the store and in memory', () => {
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

	/** Creates `t` (store) and `m` (memory) from the same DDL, then fills both from `values`. */
	async function twin(ddl: (name: string, using: string) => string, values: string): Promise<void> {
		await db.exec(ddl('t', 'using store'));
		await db.exec(ddl('m', ''));
		for (const name of ['t', 'm']) {
			await db.exec(`insert into ${name} values ${values}`);
		}
	}

	/**
	 * Asserts the store answers `sql` (over `t`) exactly as memory answers it (over `m`).
	 * Rewrites only the `from t` clause, never every bare `t` token, so a query whose
	 * literals or aliases happen to contain a standalone `t` still derives correctly.
	 */
	async function agreesWithMemory(sql: string, name: string): Promise<SqlValue[]> {
		const memorySql = sql.replace(/\bfrom\s+t\b/gi, 'from m');
		expect(memorySql, `query must read the store twin \`t\`: ${sql}`).to.not.equal(sql);
		const fromStore = await column(db, sql, name);
		const fromMemory = await column(db, memorySql, name);
		expect(fromStore, `store and memory disagree for: ${sql}`).to.deep.equal(fromMemory);
		return fromStore;
	}

	describe('a BINARY text primary key', () => {
		const ddl = (name: string, using: string) =>
			`create table ${name} (k text collate binary primary key) ${using}`;

		beforeEach(async () => {
			// Code-point order: 'z' (U+007A) < WIDE_A (U+FF21) < EMOJI (U+1F600).
			// UTF-16 code-unit order would put EMOJI first of the two — the bug.
			await twin(ddl, `('z'), ('${WIDE_A}'), ('${EMOJI}')`);
		});

		it('emits comparator order for `order by k`, with the Sort still elided', async () => {
			const q = `select k from t order by k`;
			expect(await agreesWithMemory(q, 'k')).to.deep.equal(['z', WIDE_A, EMOJI]);
			expect(await planOps(db, q), 'byte order IS comparator order, so the Sort stays elided')
				.to.not.match(/sort/i);
		});

		it('keeps every qualifying row for a range below the astral character', async () => {
			// The regression: EMOJI's key (`F0 …`) sits ABOVE WIDE_A's (`EF …`), so a byte window
			// ending at WIDE_A must exclude it — and the comparator must agree, or the row that the
			// dropped residual filter would have rechecked is silently lost.
			const q = `select k from t where k < '${WIDE_A}'`;
			expect(await agreesWithMemory(q, 'k')).to.deep.equal(['z']);
			expect(await planOps(db, q), 'the PK seek must be kept').to.match(SEEK);
		});

		it('keeps every qualifying row for a range that spans the surrogate divide', async () => {
			const q = `select k from t where k > 'z'`;
			expect(await agreesWithMemory(q, 'k')).to.deep.equal([WIDE_A, EMOJI]);
			expect(await planOps(db, q), 'the PK seek must be kept').to.match(SEEK);
		});

		it('still answers a point seek on the astral key', async () => {
			expect((await db.get(`select k from t where k = '${EMOJI}'`))?.k).to.equal(EMOJI);
		});
	});

	describe('a secondary index over an astral-bearing text column', () => {
		const ddl = (name: string, using: string) =>
			`create table ${name} (id integer primary key, k text collate nocase) ${using}`;

		beforeEach(async () => {
			await twin(ddl, `(1, 'z'), (2, '${WIDE_A}'), (3, '${EMOJI}')`);
			await db.exec(`create index ix_tk on t (k)`);
			await db.exec(`create index ix_mk on m (k)`);
		});

		it('keeps every qualifying row for a range over the index', async () => {
			const q = `select id from t where k > 'z'`;
			expect(await agreesWithMemory(q, 'id')).to.deep.equal([2, 3]);
			expect(await planOps(db, q), 'the index seek must be kept').to.match(SEEK);
		});

		it('keeps every qualifying row for a range below the astral character', async () => {
			const q = `select id from t where k < '${WIDE_A}'`;
			expect(await agreesWithMemory(q, 'id')).to.deep.equal([1]);
			expect(await planOps(db, q), 'the index seek must be kept').to.match(SEEK);
		});
	});

	describe('a NOCASE text primary key', () => {
		const ddl = (name: string, using: string) =>
			`create table ${name} (k text collate nocase primary key, v text) ${using}`;

		beforeEach(async () => {
			// Normalized (lowercased) keys: 'z' (U+007A) < WIDE_a (U+FF41) < DESERET_LOWER (U+10428).
			await twin(ddl, `('z', 'ascii'), ('${WIDE_A}', 'wide'), ('${DESERET_UPPER}', 'deseret')`);
		});

		it('folds an astral case pair on a point seek', async () => {
			expect((await db.get(`select v from t where k = '${DESERET_LOWER}'`))?.v).to.equal('deseret');
		});

		it('emits comparator order for `order by k`, with the Sort still elided', async () => {
			const q = `select k from t order by k`;
			expect(await agreesWithMemory(q, 'k')).to.deep.equal(['z', WIDE_A, DESERET_UPPER]);
			expect(await planOps(db, q)).to.not.match(/sort/i);
		});

		it('keeps the range seek across the surrogate divide', async () => {
			const q = `select v from t where k > '${WIDE_a}'`;
			expect(await agreesWithMemory(q, 'v')).to.deep.equal(['deseret']);
			expect(await planOps(db, q), 'the PK seek must be kept').to.match(SEEK);
		});
	});

	describe('an RTRIM text primary key', () => {
		const ddl = (name: string, using: string) =>
			`create table ${name} (k text collate rtrim primary key, v text) ${using}`;

		beforeEach(async () => {
			// Trailing ASCII spaces never split a surrogate pair, so the trimmed prefixes compare
			// exactly as the trimmed strings' UTF-8 bytes do.
			await twin(ddl, `('z', 'ascii'), ('${WIDE_A}', 'wide'), ('${EMOJI} ', 'emoji')`);
		});

		it('emits comparator order for `order by k`, with the Sort still elided', async () => {
			const q = `select k from t order by k`;
			expect(await agreesWithMemory(q, 'k')).to.deep.equal(['z', WIDE_A, `${EMOJI} `]);
			expect(await planOps(db, q)).to.not.match(/sort/i);
		});

		it('keeps the range seek across the surrogate divide, ignoring trailing spaces', async () => {
			const q = `select v from t where k > '${WIDE_A}  '`;
			expect(await agreesWithMemory(q, 'v')).to.deep.equal(['emoji']);
			expect(await planOps(db, q), 'the PK seek must be kept').to.match(SEEK);
		});
	});

	describe('an `any` primary key holding JSON', () => {
		// `encodeObject` writes the canonical JSON string as UTF-8, and `compareSameType`'s
		// OBJECT-class branch compares that same string — by code point, so the two agree.
		// An undecorated `any` member keys under BINARY (see `any-json-pk-binary-key.spec.ts`);
		// collation would not touch OBJECT-class values regardless — only TEXT/TEXT pairs
		// consult it.
		const ddl = (name: string, using: string) =>
			`create table ${name} (k any primary key) ${using}`;

		beforeEach(async () => {
			await twin(ddl, `(json('["${EMOJI}"]')), (json('["${WIDE_A}"]'))`);
		});

		it('emits comparator order for `order by k`, with the Sort still elided', async () => {
			// The canonical strings differ first at index 2, where WIDE_A (U+FF21) precedes the
			// EMOJI's code point (U+1F600) — the reverse of UTF-16 code-unit order.
			const q = `select json_quote(k) as k from t order by k`;
			expect(await agreesWithMemory(q, 'k'))
				.to.deep.equal([`["${WIDE_A}"]`, `["${EMOJI}"]`]);
			expect(await planOps(db, `select k from t order by k`)).to.not.match(/sort/i);
		});
	});
});

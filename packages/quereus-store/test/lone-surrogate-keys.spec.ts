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
import {
	StoreModule,
	InMemoryKVStore,
	createIsolatedStoreModule,
	buildCatalogKey,
	buildMaterializedViewCatalogKey,
	type KVStoreProvider,
} from '../src/index.js';

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

/** The DDL text persisted under `key`, or undefined when no entry exists. */
async function catalogDDL(provider: KVStoreProvider, key: Uint8Array): Promise<string | undefined> {
	const bytes = await (await provider.getCatalogStore()).get(key);
	return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
}

/** Whether a maintained table's row-time maintenance was released (`stale`). */
function isStale(db: Database, name: string): boolean {
	const mv = db.schemaManager.getTable('main', name) as { derivation?: { stale?: boolean } } | undefined;
	return mv?.derivation?.stale === true;
}

describe('Lone surrogates are refused by the store and accepted in memory', () => {
	let db: Database;
	let provider: KVStoreProvider;
	let storeModule: StoreModule;

	beforeEach(() => {
		db = new Database();
		provider = createInMemoryProvider();
		storeModule = new StoreModule(provider);
		db.registerModule('store', storeModule);
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

		it('rejects a range-seek bound built from a lone-surrogate literal', async () => {
			// The json PK's range window is re-opened (feat-store-semantic-key-range-seeks)
			// and encodes its bound through the structural key form, which raises for a
			// lone surrogate exactly as the text PK's bound above does: a bound with no
			// faithful byte position is refused, never silently widened or narrowed.
			// (Before the re-open such a query full-scanned and answered by storage class —
			// this raise is a deliberate behaviour change that aligns json with text.)
			await db.exec(`insert into j values ('["a"]', 'one'), ('["${ASTRAL}"]', 'astral')`);
			await rejects(db, `select v from j where k > '${LONE_HIGH}'`);
			await rejects(db, `select v from j where k >= 'a${LONE_HIGH}b'`);
		});

		it('rejects an EQUALITY probe built from a lone-surrogate literal', async () => {
			// The point arm is re-opened too (feat-store-semantic-key-point-seeks), and it
			// encodes its probe through the same structural key form. `jsonKeyEncodable`
			// deliberately does NOT decline an unpaired surrogate — a probe with no faithful
			// byte position is refused, never silently widened or narrowed — so this RAISES
			// rather than returning the zero rows the pre-re-open full scan produced. Same
			// rule the text PK's `where k = '<lone surrogate>'` above already carries.
			await db.exec(`insert into j values ('["a"]', 'one'), ('["${ASTRAL}"]', 'astral')`);
			await rejects(db, `select v from j where k = json('["\\ud800"]')`);
			await rejects(db, `select v from j where k = json('{"\\ud800":1}')`);
			// A bare TEXT probe reaches the same encoder (a JSON string scalar is TEXT-class).
			await rejects(db, `select v from j where k = '${LONE_HIGH}'`);
		});

		it('rejects an EQUALITY probe over a lone-surrogate literal on a json SECONDARY index', async () => {
			await db.exec(`create table js (id integer primary key, k json) using store`);
			await db.exec(`create index ix_jk on js (k)`);
			await db.exec(`insert into js values (1, '["a"]')`);
			await rejects(db, `select id from js where k = json('["\\ud800"]')`);
		});
	});

	describe('an identifier or persisted DDL text carrying a lone surrogate', () => {
		// Companion to the value-side guard above: `buildCatalogKey` folded an unpaired
		// surrogate in a TABLE NAME to U+FFFD exactly like `encodeText` did for a value —
		// so two tables whose quoted names differed only in a lone surrogate shared one
		// catalog key, and the second table's DDL write silently clobbered the first's on
		// reopen (`bug-store-catalog-key-lone-surrogate-identifier-collision`).
		//
		// Three different rejection timings live here, and the difference is the point:
		//   - A bad TABLE / INDEX NAME is refused at `CREATE`, by the identifier guard in
		//     `buildDataStoreName` / `buildIndexStoreName` — the PHYSICAL store name is
		//     built before the statement's first side effect, so the create is a clean
		//     no-op (`bug-store-physical-store-name-lone-surrogate-collision`).
		//   - A bad identifier or literal that only shows up in the persisted DDL TEXT (a
		//     column name, a `default` string) leaves the table's own name clean, so the
		//     store-name guard never sees it. DDL text is persisted lazily, on first access
		//     to the table's underlying store (see `StoreTable.initializeStore`), so those
		//     surface on the first INSERT/SELECT rather than at `CREATE TABLE`.
		//   - A VIEW / MATERIALIZED VIEW is refused at `CREATE` too, but by a different
		//     mechanism: a synchronous pre-flight veto over every registered module
		//     (`VirtualTableModule.assertCatalogObjectPersistable`), run before the object
		//     is registered. See the dedicated block below for why nothing later can work.

		it('rejects CREATE TABLE for a table named with a lone surrogate', async () => {
			await rejects(db, `create table "${LONE_HIGH}" (k integer primary key) using store`);
			// Nothing was silently written under a folded U+FFFD key.
			const mod = new StoreModule(provider);
			expect((await mod.loadAllDDL())).to.deep.equal([]);
		});

		it('rejects both of two tables whose names differ only in a lone surrogate, never colliding', async () => {
			// Pre-fix this was the invisible half of the bug: both names survived CREATE and
			// folded onto ONE physical store (and one catalog key), so the second silently
			// overwrote the first. Now both creates are refused outright — the identifier is
			// invalid, independent of whether another table happens to share its folded bytes.
			await rejects(db, `create table "${LONE_HIGH}" (k integer primary key) using store`);
			await rejects(db, `create table "${LONE_HIGH_2}" (k integer primary key) using store`);
			const mod = new StoreModule(provider);
			expect((await mod.loadAllDDL())).to.deep.equal([]);
		});

		it('rejects an index whose own name carries a lone surrogate', async () => {
			await db.exec(`create table t3 (id integer primary key, v integer) using store`);
			await db.exec(`insert into t3 values (1, 10), (2, 20)`);
			await rejects(db, `create index "${LONE_HIGH}" on t3 (v)`);
			// The rejected index build never touched t3's own rows.
			expect(await column(db, `select v from t3 order by id`, 'v')).to.deep.equal([10, 20]);
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

	describe('a view or materialized view the store could not persist', () => {
		// A view / MV catalog entry is written FIRE-AND-FORGET: the store persists it from a
		// `SchemaChangeNotifier` listener (which try/catches every listener and only logs)
		// through an async persist queue (which `.catch`-logs). Neither layer can fail the
		// statement. So before the fix, `create view "<lone surrogate>"` SUCCEEDED, answered
		// queries for the rest of the session, wrote no catalog entry, and was simply gone
		// after reopen — the loss visible only as a `console.warn`.
		//
		// The fix is a synchronous pre-flight veto (`assertCatalogObjectPersistable`) asked of
		// every registered module before the object is registered, so a refusal leaves the
		// statement a clean no-op. It checks the FULL generated DDL, so a lone surrogate in the
		// view's own NAME and one in a string literal in its BODY are both caught — the body
		// case is why "reject lone surrogates in identifiers" would not have been enough.

		beforeEach(async () => {
			// The store module persists only for the `Database` it is subscribed to, and it
			// subscribes on its first create/connect — so a store table must exist before the
			// veto is live. Any real store-backed session has one; this mirrors that.
			await db.exec(`create table t (id integer primary key, v integer) using store`);
			await db.exec(`insert into t values (1, 10)`);
		});

		it('rejects CREATE VIEW for a view named with a lone surrogate, and does not register it', async () => {
			await rejects(db, `create view "${LONE_HIGH}" as select id from t`);
			// The bug was that the view WAS present in-session and only missing after reopen.
			expect(db.schemaManager.getView('main', LONE_HIGH), 'the view must not be registered')
				.to.be.undefined;
		});

		it('rejects a view whose BODY carries a lone surrogate, even though its name is clean', async () => {
			// A string literal in a view body is a VALUE, and values carrying lone surrogates
			// are deliberately accepted by the engine and by memory tables. Only the module
			// that would have to persist the generated DDL can judge this one.
			await rejects(db, `create view v as select '${LONE_HIGH}' as tag from t`);
			expect(db.schemaManager.getView('main', 'v'), 'the view must not be registered')
				.to.be.undefined;
		});

		it('rejects a memory-backed materialized view named with a lone surrogate, leaving no backing table', async () => {
			// Default (memory) backing, so the store's physical-store-name guard never runs —
			// the veto is the only thing standing between this and a silent drop. It fires
			// inside `materializeView`'s existing rollback arm, so the half-built backing table
			// created under the MV's own name is dropped again.
			await rejects(db, `create materialized view "${LONE_HIGH}" as select id, v from t`);
			expect(db.schemaManager.getTable('main', LONE_HIGH), 'no backing table may survive')
				.to.be.undefined;
		});

		it('keeps rejecting a store-backed materialized view named with a lone surrogate', async () => {
			// This one already failed loudly before the fix — `StoreModule.create` builds the
			// physical store name before any side effect. Pinned so the two paths stay aligned.
			await rejects(db, `create materialized view "${LONE_HIGH}" using store as select id, v from t`);
			expect(db.schemaManager.getTable('main', LONE_HIGH)).to.be.undefined;
		});

		it('rejects ALTER VIEW … SET TAGS carrying a lone surrogate, leaving the tags unchanged', async () => {
			// Tags ride the persisted DDL text, so the same silent drop applied to a tag swap
			// on an already-persisted view — in the tag KEY (a quoted identifier) or its VALUE.
			await db.exec(`create view v as select id from t`);
			await rejects(db, `alter view v set tags ("${LONE_HIGH}" = 1)`);
			await rejects(db, `alter view v set tags (k = '${LONE_HIGH}')`);
			// The view itself must survive the refusal — asserting only on `?.tags` would
			// pass just as happily if the veto had taken the whole view with it.
			const view = db.schemaManager.getView('main', 'v');
			expect(view, 'the view must survive the refused ALTER').to.not.be.undefined;
			expect(view?.tags, 'tags must be unchanged').to.be.undefined;
		});

		it('rejects ALTER MATERIALIZED VIEW … SET TAGS carrying a lone surrogate', async () => {
			await db.exec(`create materialized view mv as select id, v from t`);
			await rejects(db, `alter materialized view mv set tags ("${LONE_HIGH}" = 1)`);
			const mv = db.schemaManager.getTable('main', 'mv');
			expect(mv, 'the MV must survive the refused ALTER').to.not.be.undefined;
			expect(mv?.tags, 'tags must be unchanged').to.be.undefined;
		});

		it('still accepts a well-formed astral view name and body literal', async () => {
			await db.exec(`create view "${ASTRAL}" as select '${ASTRAL}' as tag from t`);
			expect((await db.get(`select tag from "${ASTRAL}"`))?.tag).to.equal(ASTRAL);
		});

		it('a database with no store module registered keeps accepting all of it', async () => {
			// The memory-vs-store divergence is deliberate: nothing is persisted, so nothing
			// can be lost. Only a module that would have to write the entry gets a veto.
			const mem = new Database();
			try {
				await mem.exec(`create table t (id integer primary key, v integer)`);
				await mem.exec(`create view "${LONE_HIGH}" as select id from t`);
				await mem.exec(`create view vb as select '${LONE_HIGH}' as tag from t`);
				await mem.exec(`create materialized view "${LONE_LOW}" as select id, v from t`);
				expect(mem.schemaManager.getView('main', LONE_HIGH)).to.not.be.undefined;
				expect(mem.schemaManager.getTable('main', LONE_LOW)).to.not.be.undefined;
			} finally {
				await mem.close();
			}
		});

		it('an isolation-wrapped store still vetoes — the wrapper forwards the hook', async () => {
			// `allModules()` yields the REGISTERED module, which here is the `IsolationModule`
			// wrapper, not the store inside it. Without `IsolationModule`'s forward the store
			// is never asked and every isolated deployment keeps the silent-drop bug.
			const isoProvider = createInMemoryProvider();
			const iso = new Database();
			iso.registerModule('store', createIsolatedStoreModule({ provider: isoProvider }));
			try {
				await iso.exec(`create table t (id integer primary key, v integer) using store`);
				await rejects(iso, `create view "${LONE_HIGH}" as select id from t`);
				expect(iso.schemaManager.getView('main', LONE_HIGH), 'the view must not be registered')
					.to.be.undefined;
				await rejects(iso, `create view vb as select '${LONE_HIGH}' as tag from t`);
				expect(iso.schemaManager.getView('main', 'vb')).to.be.undefined;
			} finally {
				await isoProvider.closeAll();
				await iso.close();
			}
		});
	});

	describe('a RENAME that would make a persisted view, materialized view or table unwritable', () => {
		// The CREATE-side veto left the RENAME paths uncovered. `alter table … rename to` and
		// `alter table … rename column` rewrite the new name into every dependent view / MV
		// body and into every dependent TABLE's foreign keys, CHECK expressions and
		// partial-index predicates, then re-persist them; renaming a materialized view
		// additionally MOVES its own catalog entry. All of that rides
		// `SchemaChangeNotifier` (try/catch per listener,
		// log only) and then the store's async persist queue (`.catch`-log), so nothing there
		// can fail the statement. Before the fix each of these renames REPORTED SUCCESS and:
		//   - deleted the MV's catalog entry outright (the MV answered queries all session and
		//     was simply absent after reopen);
		//   - or left the persisted view/MV entry holding the OLD text while the live body
		//     carried the new one — live and durable definitions silently diverged;
		//   - or, for a store-backed dependent MV, threw mid-propagation into
		//     `failMaterializedViewRenamePropagation`, leaving the MV permanently stale with a
		//     body naming a column that no longer existed — and no `console.warn` at all.
		//
		// The fix is a pre-flight dependent scan that runs BEFORE the first side effect of
		// either rename arm: each dependent body is rewritten on a spine CLONE, and the
		// prospective object goes through the same `assertCatalogObjectPersistable` veto the
		// CREATE paths use. A refusal therefore leaves the catalog and all physical storage
		// untouched — the same clean-no-op guarantee CREATE gives.

		beforeEach(async () => {
			// A store table so the module is subscribed (and so the veto is live), plus a
			// MEMORY table to rename: the store's own physical-store-name guard would
			// otherwise fire first and hide whether the pre-flight works at all.
			await db.exec(`create table st (id integer primary key, v integer) using store`);
			await db.exec(`insert into st values (1, 10)`);
			await db.exec(`create table m (id integer primary key, x integer)`);
			await db.exec(`insert into m values (1, 100)`);
		});

		it('refuses to rename a memory-backed materialized view into a lone surrogate, keeping its catalog entry', async () => {
			// Case A — the loudest loss: the rename fired `materialized_view_removed` for the
			// old name and `materialized_view_added` for the unwritable new one, so the store
			// DELETED the entry and wrote nothing back. Assert the durable entry, not just the
			// in-memory record: the bug was invisible until reopen.
			await db.exec(`create materialized view mv as select id, x from m`);
			await storeModule.whenCatalogPersisted();

			await rejects(db, `alter table mv rename to "${LONE_HIGH}"`);

			expect(db.schemaManager.getTable('main', 'mv'), 'the MV must survive under its own name')
				.to.not.be.undefined;
			expect(db.schemaManager.getTable('main', LONE_HIGH), 'nothing may be registered under the new name')
				.to.be.undefined;
			expect(await column(db, `select x from mv`, 'x')).to.deep.equal([100]);
			await storeModule.whenCatalogPersisted();
			expect(await catalogDDL(provider, buildMaterializedViewCatalogKey('main', 'mv')),
				'the MV catalog entry must still be there').to.not.be.undefined;
		});

		it('refuses to rename a memory table that a persisted view reads, leaving the view body intact', async () => {
			// Case B. The live view body was rewritten to name the new table while the persisted
			// entry kept the old text. Querying the view is the load-bearing assertion: had the
			// pre-flight leaked its rewrite onto the LIVE AST, this would fail to resolve.
			await db.exec(`create view vm as select id, x from m`);

			await rejects(db, `alter table m rename to "${LONE_HIGH}"`);

			expect(db.schemaManager.getTable('main', 'm'), 'the table keeps its name').to.not.be.undefined;
			expect(db.schemaManager.getTable('main', LONE_HIGH)).to.be.undefined;
			expect(await column(db, `select x from vm`, 'x'), 'the view body still names m').to.deep.equal([100]);
		});

		it('refuses to rename a COLUMN of a memory table that a persisted view reads', async () => {
			await db.exec(`create view vm as select id, x from m`);

			await rejects(db, `alter table m rename column x to "${LONE_HIGH}"`);

			expect(db.schemaManager.getTable('main', 'm')?.columnIndexMap.has('x'),
				'the column keeps its name').to.be.true;
			expect(await column(db, `select x from vm`, 'x'), 'the view body still names x').to.deep.equal([100]);
		});

		it('refuses a table rename a dependent memory-backed materialized view could not persist', async () => {
			// Case F: the MV's own catalog entry diverged exactly as the plain view's did.
			await db.exec(`create materialized view mvm as select id, x from m`);

			await rejects(db, `alter table m rename to "${LONE_HIGH}"`);

			expect(db.schemaManager.getTable('main', 'm')).to.not.be.undefined;
			expect(await column(db, `select x from mvm`, 'x')).to.deep.equal([100]);
			expect(isStale(db, 'mvm'), 'the MV must not be left stale').to.be.false;
		});

		it('refuses a table rename a dependent STORE-backed materialized view could not persist', async () => {
			// Case G — the quietest one. The propagation got as far as renaming the MV's
			// backing column, threw inside the store, and `failMaterializedViewRenamePropagation`
			// swallowed it: the MV was left permanently stale with a body naming a vanished
			// table, reported only on the debug log channel.
			await db.exec(`create materialized view mvs using store as select id, x from m`);

			await rejects(db, `alter table m rename to "${LONE_HIGH}"`);

			expect(db.schemaManager.getTable('main', 'm')).to.not.be.undefined;
			expect(await column(db, `select x from mvs`, 'x')).to.deep.equal([100]);
			expect(isStale(db, 'mvs'), 'the MV must not be left stale').to.be.false;
		});

		it('refuses a column rename a dependent memory-backed materialized view could not persist', async () => {
			await db.exec(`create materialized view mvm as select id, x from m`);

			await rejects(db, `alter table m rename column x to "${LONE_HIGH}"`);

			expect(db.schemaManager.getTable('main', 'm')?.columnIndexMap.has('x')).to.be.true;
			expect(await column(db, `select x from mvm`, 'x')).to.deep.equal([100]);
			expect(isStale(db, 'mvm'), 'the MV must not be left stale').to.be.false;
		});

		it('refuses a column rename a dependent STORE-backed materialized view could not persist', async () => {
			await db.exec(`create materialized view mvs using store as select id, x from m`);

			await rejects(db, `alter table m rename column x to "${LONE_HIGH}"`);

			expect(db.schemaManager.getTable('main', 'm')?.columnIndexMap.has('x')).to.be.true;
			expect(await column(db, `select x from mvs`, 'x')).to.deep.equal([100]);
			expect(isStale(db, 'mvs'), 'the MV must not be left stale').to.be.false;
		});

		// ── Dependent TABLES: the FK / CHECK / partial-index rewrites the propagation
		//    pushes into OTHER tables, whose store-backed catalog entries must re-persist ──
		//
		// Before the fix each of these reported success, rewrote the live definition, and
		// left the on-disk one holding the old name — reported only as a `[StoreModule]
		// Failed to persist catalog DDL after schema change: …` console line.
		//
		// Every case inserts a row into the dependent store table first: a store table that
		// was created but never written to has NO catalog entry yet (that lazy-persist gap is
		// `bug-store-untouched-table-and-early-view-never-persisted`), so without the insert
		// there is no persisted DDL to diverge and the test would assert nothing.

		it('refuses a table rename a store-backed dependent could not persist through its FOREIGN KEY', async () => {
			await db.exec(`create table s2 (id integer primary key, mid integer references m(id)) using store`);
			await db.exec(`insert into s2 values (1, 1)`);
			await storeModule.whenCatalogPersisted();

			await rejects(db, `alter table m rename to "${LONE_HIGH}"`);

			expect(db.schemaManager.getTable('main', 'm'), 'the table keeps its name').to.not.be.undefined;
			expect(db.schemaManager.getTable('main', LONE_HIGH)).to.be.undefined;
			// The LIVE catalog must be untouched too — the probe rewrites a clone.
			expect(db.schemaManager.getTable('main', 's2')?.foreignKeys?.[0]?.referencedTable.toLowerCase(),
				'the live FK must still target m').to.equal('m');
			await storeModule.whenCatalogPersisted();
			const ddl = await catalogDDL(provider, buildCatalogKey('main', 's2'));
			expect(ddl, 'the persisted DDL must still name m').to.match(/\bm\b/);
			expect(ddl, 'no lone surrogate may have reached the catalog').to.not.include(LONE_HIGH);
		});

		it('refuses a column rename a store-backed dependent could not persist through its FOREIGN KEY', async () => {
			// The referenced-COLUMN list is the rewrite here (`references m(id)` → `m("\uD800")`).
			await db.exec(`create table s2 (id integer primary key, mid integer references m(id)) using store`);
			await db.exec(`insert into s2 values (1, 1)`);
			await storeModule.whenCatalogPersisted();

			await rejects(db, `alter table m rename column id to "${LONE_HIGH}"`);

			expect(db.schemaManager.getTable('main', 'm')?.columnIndexMap.has('id'),
				'the column keeps its name').to.be.true;
			expect(db.schemaManager.getTable('main', 's2')?.foreignKeys?.[0]?.referencedColumnNames?.[0]?.toLowerCase(),
				'the live FK must still name the id column').to.equal('id');
			await storeModule.whenCatalogPersisted();
			const ddl = await catalogDDL(provider, buildCatalogKey('main', 's2'));
			expect(ddl, 'the persisted DDL must still name id').to.match(/\bid\b/);
			expect(ddl, 'no lone surrogate may have reached the catalog').to.not.include(LONE_HIGH);
		});

		it('refuses a table rename a store-backed dependent could not persist through its CHECK expression', async () => {
			await db.exec(`create table s3 (id integer primary key, v integer check (v < (select count(*) from m))) using store`);
			await db.exec(`insert into s3 values (1, 0)`);
			await storeModule.whenCatalogPersisted();

			await rejects(db, `alter table m rename to "${LONE_HIGH}"`);

			expect(db.schemaManager.getTable('main', 'm'), 'the table keeps its name').to.not.be.undefined;
			await storeModule.whenCatalogPersisted();
			const ddl = await catalogDDL(provider, buildCatalogKey('main', 's3'));
			expect(ddl, 'the persisted CHECK must still name m').to.match(/\bfrom\s+(main\.)?"?m"?/i);
			expect(ddl, 'no lone surrogate may have reached the catalog').to.not.include(LONE_HIGH);
			// The live CHECK still resolves against m — proof the probe rewrote a clone.
			await db.exec(`insert into s3 values (2, 0)`);
		});

		// The third rewrite arm — a partial-index PREDICATE naming another table — has no test
		// because it has no reachable shape today: a predicate can only name another table
		// through a subquery, and the store's index-build predicate compiler refuses one
		// (`Unsupported expression in partial-index predicate: subquery`, raised from
		// `store-module-index-build.ts`). The scan covers the arm anyway, since
		// `rewriteTableForTableRename` / `rewriteTableForColumnRename` walk predicates; if
		// subqueries in index predicates ever land, add the case here.

		it('still permits the rename when the only dependent table is memory-backed', async () => {
			// The false positive the ownership self-filter exists to prevent: a store module is
			// registered and live (`st` above), but `mem2` has no catalog entry of ours to lose,
			// so nothing may refuse on our behalf.
			await db.exec(`create table mem2 (id integer primary key, mid integer references m(id))`);
			await db.exec(`insert into mem2 values (1, 1)`);

			await db.exec(`alter table m rename to "${LONE_HIGH}"`);

			expect(db.schemaManager.getTable('main', LONE_HIGH), 'the rename went through').to.not.be.undefined;
			expect(db.schemaManager.getTable('main', 'mem2')?.foreignKeys?.[0]?.referencedTable,
				'the memory dependent was rewritten as always').to.equal(LONE_HIGH);
		});

		it('refuses a rename an ISOLATION-WRAPPED store dependent could not persist, after a reopen', async () => {
			// The ownership self-filter (`ownsTableCatalogEntry`) end-to-end, through the isolation
			// wrapper and across a reopen — the deployment shape that has the most to lose, since
			// the dependent's catalog entry is already on disk and the write path would re-persist
			// it under the new name. Make the filter answer `false` and this test fails with the
			// original bug verbatim: the rename succeeds and logs `[StoreModule] Failed to persist
			// catalog DDL after schema change: …`.
			//
			// (Rehydration does put the table back in the store's `tables` map, so the first arm of
			// the filter still claims it here; the `underlying === this` arm stays defensive, held
			// for parity with `StoreModule.resolveOwnedTable`.)
			// The renamed table must be MEMORY-backed, or the store's own `alterTable` /
			// `renameTable` guard refuses first and the dependent scan proves nothing. A memory
			// table does not survive a reopen, so it is re-created in phase 2 before rehydration,
			// which is what lets the rehydrated store table's CHECK resolve against it again.
			const isoProvider = createInMemoryProvider();
			const memoryTable = `create table rm (id integer primary key)`;
			const storeDependent =
				`create table rc (id integer primary key, v integer check (v < (select count(*) from rm))) using store`;

			// Phase 1 — persist the dependent.
			const db1 = new Database();
			const mod1 = createIsolatedStoreModule({ provider: isoProvider });
			db1.registerModule('store', mod1);
			await db1.exec(memoryTable);
			await db1.exec(`insert into rm values (1)`);
			await db1.exec(storeDependent);
			await db1.exec(`insert into rc values (1, 0)`);
			await (mod1.underlying as StoreModule).whenCatalogPersisted();
			await db1.close();

			// Phase 2 — fresh Database and wrapper over the SAME provider; nothing touches `rc`.
			const db2 = new Database();
			const mod2 = createIsolatedStoreModule({ provider: isoProvider });
			db2.registerModule('store', mod2);
			const inner = mod2.underlying as StoreModule;
			try {
				await db2.exec(memoryTable);
				expect((await inner.rehydrateCatalog(db2)).errors, 'catalog rehydrates cleanly')
					.to.have.lengthOf(0);

				await rejects(db2, `alter table rm rename to "${LONE_HIGH}"`);

				expect(db2.schemaManager.getTable('main', 'rm'), 'the table keeps its name').to.not.be.undefined;
				expect(db2.schemaManager.getTable('main', LONE_HIGH)).to.be.undefined;
				await inner.whenCatalogPersisted();
				const ddl = await catalogDDL(isoProvider, buildCatalogKey('main', 'rc'));
				expect(ddl, 'the persisted CHECK must still name rm').to.match(/\brm\b/);
				expect(ddl, 'no lone surrogate may have reached the catalog').to.not.include(LONE_HIGH);
			} finally {
				await db2.close();
				await isoProvider.closeAll();
			}
		});

		// ── Regression pins: already-loud paths must STAY loud and stay clean no-ops ──
		//
		// The store's physical store-name / DDL-text guard already refused these. The
		// pre-flight now runs ahead of it whenever the object HAS a dependent, so for those
		// the reported message shifts from `cannot store the identifier …` to `cannot store
		// persisted schema text …`. Both name an unpaired surrogate and both leave a clean
		// no-op, so `rejects()` asserts on the shared substance rather than exact wording.

		it('keeps rejecting a store-backed table rename into a lone surrogate', async () => {
			await rejects(db, `alter table st rename to "${LONE_HIGH}"`);
			expect(db.schemaManager.getTable('main', 'st'), 'the table survives').to.not.be.undefined;
			expect(await column(db, `select v from st`, 'v')).to.deep.equal([10]);
		});

		it('keeps rejecting a store-backed table rename into a lone surrogate with a view over it', async () => {
			await db.exec(`create view vs as select id, v from st`);
			await rejects(db, `alter table st rename to "${LONE_HIGH}"`);
			expect(await column(db, `select v from vs`, 'v')).to.deep.equal([10]);
		});

		it('keeps rejecting a store-backed table COLUMN rename into a lone surrogate', async () => {
			await rejects(db, `alter table st rename column v to "${LONE_HIGH}"`);
			expect(db.schemaManager.getTable('main', 'st')?.columnIndexMap.has('v')).to.be.true;
			expect(await column(db, `select v from st`, 'v')).to.deep.equal([10]);
		});

		it('keeps rejecting a store-backed materialized-view rename into a lone surrogate', async () => {
			await db.exec(`create materialized view mvs using store as select id, v from st`);
			await rejects(db, `alter table mvs rename to "${LONE_HIGH}"`);
			expect(db.schemaManager.getTable('main', 'mvs'), 'the MV survives').to.not.be.undefined;
			expect(await column(db, `select v from mvs`, 'v')).to.deep.equal([10]);
		});

		it('still accepts a well-formed astral rename of a table and a column', async () => {
			// The guard must not over-reject: an astral character is a PAIRED surrogate and
			// encodes fine. All three dependent kinds are present so the pre-flight actually
			// renders a prospective view, a prospective MV and a prospective TABLE before
			// letting the rename through — and the dependent table must then RE-PERSIST under
			// the new name rather than merely be allowed.
			await db.exec(`create view vm as select id, x from m`);
			await db.exec(`create materialized view mvm as select id, x from m`);
			await db.exec(`create table s2 (id integer primary key, mid integer references m(id)) using store`);
			await db.exec(`insert into s2 values (1, 1)`);
			await storeModule.whenCatalogPersisted();

			await db.exec(`alter table m rename to "${ASTRAL}"`);
			expect(await column(db, `select x from vm`, 'x')).to.deep.equal([100]);
			expect(await column(db, `select x from mvm`, 'x')).to.deep.equal([100]);
			await storeModule.whenCatalogPersisted();
			expect(await catalogDDL(provider, buildCatalogKey('main', 's2')),
				'the dependent FK re-persisted under the new name').to.include(ASTRAL);

			await db.exec(`alter table "${ASTRAL}" rename column x to "${ASTRAL}"`);
			expect(await column(db, `select "${ASTRAL}" from vm`, ASTRAL)).to.deep.equal([100]);
		});

		it('a database with no store module registered keeps accepting all of it', async () => {
			// Same deliberate divergence as the CREATE side: nothing is persisted, so nothing
			// can be lost. Only a module that would have to write the entry gets a veto.
			const mem = new Database();
			try {
				await mem.exec(`create table m (id integer primary key, x integer)`);
				await mem.exec(`insert into m values (1, 100)`);
				await mem.exec(`create view vm as select id, x from m`);
				await mem.exec(`create materialized view mvm as select id, x from m`);

				await mem.exec(`alter table mvm rename to "${LONE_LOW}"`);
				await mem.exec(`alter table m rename column x to "${LONE_HIGH}"`);
				await mem.exec(`alter table m rename to "${LONE_HIGH_2}"`);

				expect(mem.schemaManager.getTable('main', LONE_LOW)).to.not.be.undefined;
				expect(mem.schemaManager.getTable('main', LONE_HIGH_2)).to.not.be.undefined;
				expect(mem.schemaManager.getView('main', 'vm')).to.not.be.undefined;
			} finally {
				await mem.close();
			}
		});
	});
});

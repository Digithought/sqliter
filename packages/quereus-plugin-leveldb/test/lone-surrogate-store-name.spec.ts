/**
 * Regression: an identifier carrying a LONE (unpaired) surrogate must never reach a
 * physical store name.
 *
 * A JS string holds 16-bit code units; a character above U+FFFF is a PAIR (high
 * U+D800–U+DBFF then low U+DC00–U+DFFF). An unpaired half is a legal JS string but not
 * valid Unicode, and no UTF-8 sequence encodes it — `TextEncoder` folds all 2048 of them
 * to U+FFFD. `LevelDBProvider.encodeSublevelName` runs the logical store name through
 * `TextEncoder`, so pre-fix `main.\uD800` and `main.\uD801` both became the sublevel
 * `main.%EF%BF%BD`: two distinct tables, one physical store.
 *
 * Worse, RENAME relocated storage BEFORE rewriting the catalog, and only the catalog
 * write was guarded. `alter table p rename to "<lone surrogate>"` therefore raised — after
 * LevelDB had already moved p's rows into the orphan `main.%EF%BF%BD` sublevel and emptied
 * `main.p`. The statement errored and the table came back permanently empty.
 *
 * The fix guards `buildDataStoreName` / `buildIndexStoreName` themselves. Every call site
 * builds the physical name before its first side effect, so the throw lands on a clean
 * no-op. These tests wire a real `Database` + `StoreModule` over a real `LevelDBProvider`
 * and assert engine-visible rows survive, plus (for the rename) that no orphan U+FFFD
 * sublevel exists on disk.
 */

import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ClassicLevel } from 'classic-level';
import { Database, asyncIterableToArray, type SqlValue } from '@quereus/quereus';
import { StoreModule } from '@quereus/store';
import { createLevelDBProvider, type LevelDBProvider } from '../src/provider.js';

/** Lone high surrogate — no low surrogate follows. */
const LONE_HIGH = '\uD800';
/** A different lone high surrogate: distinct value, identical UTF-8 bytes under TextEncoder. */
const LONE_HIGH_2 = '\uD801';
/** The percent-escaped U+FFFD replacement byte sequence a folded name would produce. */
const FOLDED = '%EF%BF%BD';
/** U+10000 — the same two code-unit ranges, legally PAIRED. Must keep working end to end. */
const ASTRAL = '\u{10000}';
/** U+10001 — a second, distinct astral character; must land on its own sublevel. */
const ASTRAL_2 = '\u{10001}';

describe('LevelDB lone-surrogate physical store names', () => {
	let testDir: string;
	let db: Database;
	let provider: LevelDBProvider;
	let mod: StoreModule;
	let closed: boolean;

	beforeEach(() => {
		testDir = path.join(os.tmpdir(), `quereus-lonesurr-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		fs.mkdirSync(testDir, { recursive: true });
		db = new Database();
		provider = createLevelDBProvider({ basePath: testDir });
		mod = new StoreModule(provider);
		db.registerModule('store', mod);
		closed = false;
	});

	afterEach(async () => {
		if (!closed) {
			try {
				await mod.closeAll();
			} catch {
				/* may already be closed */
			}
		}
		fs.rmSync(testDir, { recursive: true, force: true });
	});

	async function rows(sql: string): Promise<Record<string, SqlValue>[]> {
		return await asyncIterableToArray(db.eval(sql)) as Record<string, SqlValue>[];
	}

	async function attempt(sql: string): Promise<Error | null> {
		try {
			await db.exec(sql);
			return null;
		} catch (e) {
			return e instanceof Error ? e : new Error(String(e));
		}
	}

	/**
	 * Every raw root key, as a lossy utf8 string. Closes the module first — LevelDB is
	 * single-writer, so the provider must release the directory lock before a second open.
	 * Only the sublevel prefix (`!<sublevel>!`) is inspected, and that is pure ASCII after
	 * percent-escaping, so lossy decoding of the binary key suffix does not matter.
	 */
	async function rawKeys(): Promise<string[]> {
		await mod.closeAll();
		closed = true;
		const root = new ClassicLevel<string, string>(testDir, { keyEncoding: 'utf8', valueEncoding: 'utf8' });
		await root.open();
		try {
			return await root.keys().all();
		} finally {
			await root.close();
		}
	}

	it('rejects CREATE TABLE whose name carries a lone surrogate', async () => {
		const err = await attempt(`create table "${LONE_HIGH}" (id integer primary key, v integer) using store`);
		expect(err, 'CREATE TABLE with a lone-surrogate name must reject').to.be.instanceOf(Error);
		expect((err as Error).message).to.match(/unpaired surrogate/i);
	});

	it('rejects two tables differing only in which lone surrogate they use — never one shared sublevel', async () => {
		// Pre-fix both creates SUCCEEDED and both resolved to sublevel `main.%EF%BF%BD`.
		expect(await attempt(`create table "${LONE_HIGH}" (id integer primary key, v integer) using store`))
			.to.be.instanceOf(Error);
		expect(await attempt(`create table "${LONE_HIGH_2}" (id integer primary key, v integer) using store`))
			.to.be.instanceOf(Error);

		// A normal table in the same database is unaffected by the rejected creates.
		await db.exec(`create table ok (id integer primary key, v integer) using store`);
		await db.exec(`insert into ok values (1, 11)`);
		expect(await rows(`select v from ok`)).to.deep.equal([{ v: 11 }]);

		expect((await rawKeys()).filter(k => k.includes(FOLDED)), 'no folded sublevel on disk').to.deep.equal([]);
	});

	it('RENAME onto a lone-surrogate name rejects WITHOUT losing the table\'s rows', async () => {
		// The data-loss regression. Pre-fix: the rename raised (the catalog guard fired) but
		// the physical relocation had already run, so p's rows sat in an orphan
		// `main.%EF%BF%BD` sublevel and `select * from p` returned nothing.
		await db.exec(`create table p (id integer primary key, v integer) using store`);
		await db.exec(`insert into p values (1, 111), (2, 222)`);

		const err = await attempt(`alter table p rename to "${LONE_HIGH}"`);
		expect(err, 'rename onto a lone-surrogate name must reject').to.be.instanceOf(Error);
		expect((err as Error).message).to.match(/unpaired surrogate/i);

		// The rows are still there under the original name.
		expect(await rows(`select v from p order by id`)).to.deep.equal([{ v: 111 }, { v: 222 }]);

		// p stays writable — the reject was a clean no-op, not a half-applied rename.
		await db.exec(`insert into p values (3, 333)`);
		expect(await rows(`select v from p order by id`)).to.deep.equal([{ v: 111 }, { v: 222 }, { v: 333 }]);

		// And nothing was stranded under the folded orphan store name.
		expect((await rawKeys()).filter(k => k.includes(FOLDED)), 'no orphan folded sublevel').to.deep.equal([]);
	});

	it('rejects CREATE INDEX whose name carries a lone surrogate; the table stays fully usable', async () => {
		await db.exec(`create table t (id integer primary key, b integer) using store`);
		await db.exec(`create index ix_b on t (b)`);
		await db.exec(`insert into t values (1, 10), (2, 20)`);

		const err = await attempt(`create index "${LONE_HIGH}" on t (b)`);
		expect(err, 'CREATE INDEX with a lone-surrogate name must reject').to.be.instanceOf(Error);
		expect((err as Error).message).to.match(/unpaired surrogate/i);

		// t's rows and its existing index-backed lookup are unharmed.
		expect(await rows(`select id from t where b = 20`)).to.deep.equal([{ id: 2 }]);
		expect(await rows(`select b from t order by id`)).to.deep.equal([{ b: 10 }, { b: 20 }]);

		expect((await rawKeys()).filter(k => k.includes(FOLDED)), 'no folded index sublevel').to.deep.equal([]);
	});

	// The over-rejection direction. A WELL-FORMED astral character occupies the same two
	// code-unit ranges as a lone surrogate, so a guard that tested code units instead of
	// pairs would refuse it — and the unit tests alone would not catch a provider that
	// mangled it deeper down. This drives one end to end: table name, index name, rename
	// target, and a second astral character that must not share the first's sublevel.
	it('accepts well-formed astral characters end to end, on distinct sublevels', async () => {
		await db.exec(`create table "t${ASTRAL}" (id integer primary key, b integer) using store`);
		await db.exec(`create index "ix${ASTRAL}" on "t${ASTRAL}" (b)`);
		await db.exec(`insert into "t${ASTRAL}" values (1, 10), (2, 20)`);
		expect(await rows(`select id from "t${ASTRAL}" where b = 20`)).to.deep.equal([{ id: 2 }]);

		// A sibling named with a DIFFERENT astral character keeps its own rows — the two
		// names must not fold onto one store the way two lone surrogates would have.
		await db.exec(`create table "t${ASTRAL_2}" (id integer primary key, b integer) using store`);
		await db.exec(`insert into "t${ASTRAL_2}" values (1, 99)`);
		expect(await rows(`select b from "t${ASTRAL}" order by id`)).to.deep.equal([{ b: 10 }, { b: 20 }]);
		expect(await rows(`select b from "t${ASTRAL_2}" order by id`)).to.deep.equal([{ b: 99 }]);

		// Rename onto another astral name relocates rows rather than rejecting.
		await db.exec(`alter table "t${ASTRAL}" rename to "u${ASTRAL_2}"`);
		expect(await rows(`select b from "u${ASTRAL_2}" order by id`)).to.deep.equal([{ b: 10 }, { b: 20 }]);
		expect(await rows(`select id from "u${ASTRAL_2}" where b = 20`)).to.deep.equal([{ id: 2 }]);
	});
});

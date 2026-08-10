/**
 * Regression tests for the core engine re-splitting a flat lowercased base key
 * `` `${schema}.${table}` `` on the FIRST dot. A quoted table name may legally
 * contain a dot (e.g. `create table "a.b" (...)` → key `main.a.b`); a naive
 * `base.split('.')` truncates the table to `'a'` and drops the `.b` segment, so
 * the change-tracking code looks up the wrong table (or none). The fix routes
 * every recovery site through `splitBaseKey` (splits on the first dot only) — see
 * ticket bug-core-fq-name-split-mis-routes-dotted-table-names.
 *
 * Two of the five recovery sites are strict pre/post discriminators (a wrong
 * result before the fix): the materialized-view covering-conflict lookup silently
 * MISSED a UNIQUE conflict, and `explain_assertion` emitted NULL prepared-param
 * names. The assertion residual-dispatch site degrades harmlessly to a global
 * re-evaluation when the PK is unknown (the delta executor's `if (!pkIndices)`
 * guard falls back to global), so an assertion still fires pre-fix — that test is
 * a correctness floor, not a strict discriminator.
 */

import { expect } from 'chai';
import { Database } from '../src/core/database.js';

describe('dotted table name (quoted identifier containing a dot) — core engine', () => {
	let db: Database;
	afterEach(async () => { if (db) await db.close(); });

	async function selectAll(sql: string): Promise<Record<string, unknown>[]> {
		const rows: Record<string, unknown>[] = [];
		for await (const row of db.eval(sql)) rows.push(row);
		return rows;
	}

	async function expectThrows(fn: () => Promise<unknown>, substr: string): Promise<void> {
		let err: unknown;
		try { await fn(); } catch (e) { err = e; }
		expect(err, `expected an error containing "${substr}"`).to.not.be.undefined;
		expect(String((err as Error).message)).to.contain(substr);
	}

	// ── Materialized-view covering conflict (strict discriminator) ──
	// The covering-MV enforcement path resolves the source of a UNIQUE conflict by
	// splitting `plan.sourceBase` (`main.a.b`). Pre-fix: `['main','a','b']` →
	// `_findTable('a','main')` → undefined → `lookupCoveringConflicts` returns [] →
	// the duplicate is silently admitted. When a covering MV is linked it is the
	// SOLE enforcement structure (the auto-index is skipped), so the miss is real.
	it('materialized view: a UNIQUE conflict on a dotted-name source is detected, not missed', async () => {
		db = new Database();
		await db.exec('create table "a.b" (id integer primary key, x integer not null, y integer not null, unique (x, y))');
		await db.exec('create materialized view ix as select x, y, id from "a.b" order by x, y');

		// The covering MV is linked to the dotted source and enforcement-ready.
		const uc = db.schemaManager.getTable('main', 'a.b')!.uniqueConstraints![0];
		expect(uc.coveringStructureName, 'covering MV linked to the dotted source').to.equal('ix');
		expect(db._findRowTimeCoveringStructure('main', 'a.b', uc)?.name, 'covering MV is enforcement-ready').to.equal('ix');

		await db.exec('insert into "a.b" values (1, 5, 5)');
		// A second (5, 5) duplicates the first — the covering-conflict lookup must
		// resolve the dotted source and find it (pre-fix: mis-split → [] → admitted).
		await expectThrows(() => db.exec('insert into "a.b" values (2, 5, 5)'), 'UNIQUE constraint failed: a.b (x, y)');
		expect(await selectAll('select count(*) as n from "a.b"'), 'the duplicate was rejected').to.deep.equal([{ n: 1 }]);

		// A genuinely distinct (x, y) still inserts.
		await db.exec('insert into "a.b" values (3, 6, 6)');
		expect(await selectAll('select count(*) as n from "a.b"')).to.deep.equal([{ n: 2 }]);
	});

	// ── Assertion residual dispatch (correctness floor) ──
	// A row-classified assertion over `"a.b"` builds `pkIndicesByBase` for base
	// `main.a.b` via the same first-dot recovery. Pre-fix the entry is absent, so
	// the delta executor cannot fetch per-tuple deltas and falls back to a global
	// re-evaluation — still correct, just not the per-row residual path. This test
	// pins that the assertion FIRES on a violating commit (and rolls back) over a
	// dotted table; the strict PK-resolution discriminator lives in the explain
	// test below (the same `_findTable(splitBaseKey(base))` recovery).
	it('assertion: a violation on a dotted-name table is raised at commit and rolled back', async () => {
		db = new Database();
		await db.exec('create table "a.b" (id integer primary key, balance integer not null)');
		await db.exec('create assertion nonneg check (not exists (select 1 from "a.b" where balance < 0))');
		await db.exec('insert into "a.b" values (1, 100)');

		// A commit that drives the balance negative violates the assertion.
		await expectThrows(async () => {
			await db.exec('begin');
			await db.exec('update "a.b" set balance = -10 where id = 1');
			await db.exec('commit');
		}, 'Integrity assertion failed: nonneg');

		// The failing transaction rolled back — the original row survives intact.
		expect(await selectAll('select balance from "a.b" where id = 1')).to.deep.equal([{ balance: 100 }]);

		// A compatible commit still succeeds.
		await db.exec('begin');
		await db.exec('update "a.b" set balance = 50 where id = 1');
		await db.exec('commit');
		expect(await selectAll('select balance from "a.b" where id = 1')).to.deep.equal([{ balance: 50 }]);
	});

	// ── explain_assertion prepared params (strict discriminator) ──
	// `explain_assertion` recovers `(schema, table)` from the flat `base` to look up
	// the table's PK / group-key columns for the emitted prepared params. Pre-fix:
	// `'main.a.b'.split('.')` → `_findTable('a','main')` → undefined → the params are
	// NULL. Post-fix the dotted table resolves and the params carry its columns.
	async function explainRows(assertionName: string): Promise<Array<{ classification: string; prepared_pk_params: string | null; base: string }>> {
		const rows: Array<{ classification: string; prepared_pk_params: string | null; base: string }> = [];
		for await (const r of db.eval(
			`select classification, prepared_pk_params, base from explain_assertion('${assertionName}') where base = 'main.a.b'`,
		)) {
			rows.push(r as unknown as { classification: string; prepared_pk_params: string | null; base: string });
		}
		return rows;
	}

	it('explain: prepared params for a GROUP-classified assertion carry the dotted table’s key column', async () => {
		db = new Database();
		await db.exec('create table "a.b" (id integer primary key, v text) using memory');
		await db.exec('create assertion a_group check ((select count(*) from (select id from "a.b" group by id)) >= 0)');

		const rows = await explainRows('a_group');
		expect(rows, 'exactly one classification entry for the dotted base').to.have.length(1);
		expect(rows[0].base, 'the full dotted base survives').to.equal('main.a.b');
		expect(rows[0].classification).to.equal('group');
		// Pre-fix this was NULL (the truncated 'a' did not resolve to a table).
		expect(rows[0].prepared_pk_params).to.equal('["id"]');
	});
});

import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import type { SqlValue } from '../../src/common/types.js';

/**
 * Reserved-tag handling across `ALTER VIEW / MATERIALIZED VIEW … {SET|ADD|DROP}
 * TAGS` and prepared write-through statements.
 *
 * No reserved tag carries view-mutation *behavior* anymore (routing is per-row
 * presence/membership columns; omitted-with defaults are the first-class
 * `with defaults (…)` clause), so the old observable this spec pinned — a
 * cached write-through plan re-ROUTING after a tag change — no longer exists.
 * (`buildViewMutation` still records the `view` plan dependency, and the tag
 * setters still fire `view_modified` / `materialized_view_modified`; that
 * dependency recording and the invalidation it drives are pinned at the unit
 * level in `view-dependency-invalidation.spec.ts`, via `_buildPlan` deps and
 * plan-object identity across `compile()` calls.) What remains pinned here:
 *
 * - `SET TAGS` / `ADD TAGS` validate eagerly at the `view-ddl` site
 *   (`buildSetObjectTags`), so a retired `quereus.update.*` key can never be
 *   INTRODUCED through ALTER — the statement itself fails.
 * - A direct `create view … with tags (…)` stores tags UNVALIDATED (the lazy
 *   view-ddl posture), so a retired key surfaces on the first write-through
 *   plan instead; `DROP TAGS` does no value validation, making it the
 *   migration escape hatch — and the SAME prepared statement must recover
 *   after the drop (a failed compile must not be cached as the answer).
 *
 * The `.sqllogic` harness re-prepares every statement and so cannot express
 * prepared-statement reuse across an `ALTER`; hence this focused spec.
 */
describe('View tag mutation vs. prepared write-through plans', () => {
	let db: Database;
	beforeEach(() => { db = new Database(); });
	afterEach(async () => { await db.close(); });

	const rows = async (sql: string): Promise<Record<string, SqlValue>[]> => {
		const out: Record<string, SqlValue>[] = [];
		for await (const row of db.eval(sql)) out.push(row);
		return out;
	};

	/** Await `run`, expecting the unknown-reserved-tag error. */
	const expectInvalidTag = async (run: () => Promise<unknown>): Promise<void> => {
		try {
			await run();
			expect.fail('expected an unknown-reserved-tag failure');
		} catch (e) {
			expect(String(e)).to.match(/unknown reserved tag/i);
		}
	};

	it('rejects a retired quereus.update.* key eagerly on ALTER VIEW SET / ADD TAGS (view unchanged)', async () => {
		await db.exec(`
			create table t (id integer primary key, created integer null);
			create view v as select id from t with tags (display_name = 'V');
		`);

		await expectInvalidTag(() => db.exec(`alter view v set tags ("quereus.update.default_for.created" = '100');`));
		await expectInvalidTag(() => db.exec(`alter view v add tags ("quereus.update.default_for.created" = '100');`));

		// The failed ALTERs left the view's tags (and writability) untouched.
		await db.exec('insert into v (id) values (1);');
		expect(await rows('select id from t order by id')).to.deep.equal([{ id: 1 }]);
	});

	it('rejects a retired quereus.update.* key eagerly on ALTER MATERIALIZED VIEW SET / ADD TAGS', async () => {
		await db.exec(`
			create table t (id integer primary key, created integer null);
			create materialized view mv as select id from t;
		`);

		await expectInvalidTag(() => db.exec(`alter materialized view mv set tags ("quereus.update.default_for.created" = '100');`));
		await expectInvalidTag(() => db.exec(`alter materialized view mv add tags ("quereus.update.default_for.created" = '100');`));

		await db.exec('insert into mv (id) values (1);');
		expect(await rows('select id from t order by id')).to.deep.equal([{ id: 1 }]);
	});

	it('a prepared insert through a view carrying a retired tag fails at plan time and recovers after DROP TAGS', async () => {
		// Direct CREATE stores the tag unvalidated (lazy view-ddl posture) — the
		// retired key surfaces on the write-through plan, not at create.
		await db.exec(`
			create table t (id integer primary key, created integer null);
			create view v as select id from t
				with tags ("quereus.update.default_for.created" = '100');
		`);

		const stmt = db.prepare('insert into v (id) values (?)');
		await expectInvalidTag(() => stmt.run([1]));

		// DROP TAGS removes by key with no value validation — the migration escape
		// hatch off the retired tag. The SAME prepared statement must re-plan
		// against the cleaned tag set and succeed (the compile failure above must
		// not stick to the statement).
		await db.exec(`alter view v drop tags ("quereus.update.default_for.created");`);
		await stmt.run([2]);
		expect(await rows('select id from t order by id'))
			.to.deep.equal([{ id: 2 }], 'the prepared statement recovers once the retired tag is dropped');

		await stmt.finalize();
	});

	it('recovers a prepared MV insert the same way (MATERIALIZED VIEW DROP TAGS)', async () => {
		// An MV-mediated write routes through the same view-mutation substrate (the
		// insert builder funnels `getView ?? maintainedTableViewLike(getMaintainedTable)`
		// into buildViewMutation), so the lazy-create / drop-to-recover contract matches.
		await db.exec(`
			create table t (id integer primary key, created integer null);
			create materialized view mv as select id from t
				with tags ("quereus.update.default_for.created" = '100');
		`);

		const stmt = db.prepare('insert into mv (id) values (?)');
		await expectInvalidTag(() => stmt.run([1]));

		await db.exec(`alter materialized view mv drop tags ("quereus.update.default_for.created");`);
		await stmt.run([2]);
		expect(await rows('select id from t order by id'))
			.to.deep.equal([{ id: 2 }], 'the prepared MV statement recovers once the retired tag is dropped');

		await stmt.finalize();
	});

	it('resolves a case-differing ALTER identifier to the canonical view for the recovery path', async () => {
		// SQL identifiers are case-insensitive: `alter view MYVIEW drop tags` must
		// resolve and swap the canonically-named `MyView`, or the prepared statement
		// would keep failing against the stale tag set.
		await db.exec(`
			create table t (id integer primary key, created integer null);
			create view MyView as select id from t
				with tags ("quereus.update.default_for.created" = '100');
		`);

		const stmt = db.prepare('insert into MyView (id) values (?)');
		await expectInvalidTag(() => stmt.run([1]));

		await db.exec(`alter view MYVIEW drop tags ("quereus.update.default_for.created");`);
		await stmt.run([2]);
		expect(await rows('select id from t order by id'))
			.to.deep.equal([{ id: 2 }], 'case-differing ALTER must still clean the canonical view');

		await stmt.finalize();
	});

	it('a fresh statement validates the current tags (control)', async () => {
		await db.exec(`
			create table t (id integer primary key, created integer null);
			create view v as select id from t
				with tags ("quereus.update.default_for.created" = '100');
		`);

		await expectInvalidTag(() => db.exec('insert into v (id) values (1);'));

		await db.exec(`alter view v drop tags ("quereus.update.default_for.created");`);
		await db.exec('insert into v (id) values (2);');
		expect(await rows('select id from t order by id'))
			.to.deep.equal([{ id: 2 }], 'each fresh statement re-plans with the current tags');
	});
});

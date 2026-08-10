/**
 * ALTER TABLE/COLUMN RENAME propagation into dependent materialized views —
 * the catalog-level invariants the sqllogic file
 * (53.2-materialized-view-rename-propagation.sqllogic) cannot see:
 *
 *   1. Derived-field re-keying: `derivation.sourceTables`, `derivation.bodyHash`,
 *      the on-demand DDL (`generateMaintainedTableDDL`), and the
 *      `materialized_view_modified` event a store-backed catalog re-persists from.
 *   2. The staleness discipline: a pre-existing stale flag is never cleared by
 *      the rename (the backing may already be behind), but the body IS rewritten
 *      so a later REFRESH resolves the new name — before the fix it could not.
 *   3. The failure path: a mid-propagation failure (re-registration throws)
 *      leaves the MV stale with its row-time plan released, rather than serving
 *      a silently frozen snapshot as live.
 *   4. The end-of-statement restoration pass (`restoreUnaffectedMaterializedViews`)
 *      retries every MV the statement left stale: a persistent failure stays
 *      stale (REFRESH recovers), a transient one is healed within the statement.
 */

import { expect } from 'chai';
import { Database } from '../src/core/database.js';
import { parse } from '../src/parser/index.js';
import type { MaintainedTableSchema } from '../src/schema/derivation.js';
import { generateMaintainedTableDDL } from '../src/schema/ddl-generator.js';
import type { SchemaChangeEvent } from '../src/schema/change-events.js';

async function rows(db: Database, sql: string): Promise<Record<string, unknown>[]> {
	const out: Record<string, unknown>[] = [];
	for await (const r of db.eval(sql)) out.push(r as Record<string, unknown>);
	return out;
}

/** Collect every schema-change event a database fires while `fn` runs. */
async function captureEvents(db: Database, fn: () => Promise<void>): Promise<SchemaChangeEvent[]> {
	const events: SchemaChangeEvent[] = [];
	const off = db.schemaManager.getChangeNotifier().addListener(e => events.push(e));
	try {
		await fn();
	} finally {
		off();
	}
	return events;
}

function getMv(db: Database, name: string): MaintainedTableSchema {
	const mv = db.schemaManager.getMaintainedTable('main', name);
	expect(mv, `materialized view '${name}' exists`).to.not.equal(undefined);
	return mv!;
}

describe('MV rename propagation: derived fields and events', () => {
	it('TABLE rename re-keys sourceTables/bodyHash/sql and fires materialized_view_modified', async () => {
		const db = new Database();
		try {
			await db.exec('create table t (id integer primary key, v integer not null)');
			await db.exec('insert into t values (1, 10)');
			await db.exec('create materialized view mv as select id, v from t');
			const before = getMv(db, 'mv');
			const hashBefore = before.derivation.bodyHash;
			expect(before.derivation.sourceTables).to.deep.equal(['main.t']);

			const events = await captureEvents(db, () => db.exec('alter table t rename to t2'));

			const mv = getMv(db, 'mv');
			expect(mv.derivation.stale ?? false, 'MV stays live').to.equal(false);
			expect(mv.derivation.sourceTables, 'source key re-keyed to the new base').to.deep.equal(['main.t2']);
			expect(mv.derivation.bodyHash, 'body hash follows the rewritten body').to.not.equal(hashBefore);
			const ddl = generateMaintainedTableDDL(mv);
			expect(ddl.toLowerCase(), 'regenerated DDL names the new table').to.include('t2');
			// The unified model's canonical form is `create table … maintained as`, which
			// re-parses as a createTable carrying a maintained clause (not the MV sugar).
			const reparsed = parse(ddl);
			expect(reparsed.type, 'regenerated DDL re-parses').to.equal('createTable');
			expect((reparsed as { maintained?: unknown }).maintained, 'as a maintained table').to.not.equal(undefined);

			const modified = events.filter(e => e.type === 'materialized_view_modified');
			expect(modified, 'one materialized_view_modified (the store re-persist trigger)').to.have.length(1);
			if (modified[0].type === 'materialized_view_modified') {
				expect(modified[0].objectName).to.equal('mv');
				expect(generateMaintainedTableDDL(modified[0].newObject as MaintainedTableSchema).toLowerCase()).to.include('t2');
			}
			expect(events.filter(e => e.type === 'materialized_view_added'), 'no re-create event').to.have.length(0);
		} finally {
			await db.close();
		}
	});

	it('COLUMN rename renames the shifted backing column in place (data preserved)', async () => {
		const db = new Database();
		try {
			await db.exec('create table s (id integer primary key, v integer not null)');
			await db.exec('insert into s values (1, 10)');
			await db.exec('create materialized view mv as select id, v from s');
			const hashBefore = getMv(db, 'mv').derivation.bodyHash;

			await db.exec('alter table s rename column v to w');

			const mv = getMv(db, 'mv');
			expect(mv.derivation.stale ?? false, 'MV stays live').to.equal(false);
			expect(mv.derivation.sourceTables, 'table key unchanged by a column rename').to.deep.equal(['main.s']);
			expect(mv.derivation.bodyHash).to.not.equal(hashBefore);

			// The MV's own table (the maintained table) carries the stored columns.
			const stored = db.schemaManager.getTable('main', 'mv');
			expect(stored, 'MV table exists').to.not.equal(undefined);
			expect(stored!.columns.map(c => c.name), 'stored column follows the exposed output name')
				.to.deep.equal(['id', 'w']);
			// Data-preserving: the pre-rename row is still there under the new name.
			expect(await rows(db, 'select id, w from mv order by id')).to.deep.equal([{ id: 1, w: 10 }]);
		} finally {
			await db.close();
		}
	});

	it('COLUMN rename preserves the MV table tags while shifting the backing column', async () => {
		// The source-rename relabel rebuilds the backing record from the module's
		// post-ALTER schema, which carries no catalog tags — the rebuild must graft
		// them back (renameShiftedBackingColumns / graftReshapedRecord).
		const db = new Database();
		try {
			await db.exec('create table s (id integer primary key, v integer not null)');
			await db.exec('insert into s values (1, 10)');
			await db.exec(`create materialized view mv as select id, v from s with tags ("team.owner" = 'sre')`);
			expect(db.schemaManager.getTable('main', 'mv')!.tags?.['team.owner'], 'tag set at create')
				.to.equal('sre');

			await db.exec('alter table s rename column v to w');

			const stored = db.schemaManager.getTable('main', 'mv')!;
			expect(stored.columns.map(c => c.name), 'backing column followed the rename')
				.to.deep.equal(['id', 'w']);
			expect(stored.tags?.['team.owner'], 'tags survive the source-rename relabel').to.equal('sre');
		} finally {
			await db.close();
		}
	});

	it('TABLE rename reaches an MV reading the renamed table THROUGH a plain view', async () => {
		const db = new Database();
		try {
			await db.exec('create table t (id integer primary key, v integer not null)');
			await db.exec('insert into t values (1, 10)');
			await db.exec('create view tv as select id, v from t');
			await db.exec('create materialized view mv as select id, v from tv');
			expect(getMv(db, 'mv').derivation.sourceTables, 'source resolves through the view').to.deep.equal(['main.t']);

			await db.exec('alter table t rename to t2');

			const mv = getMv(db, 'mv');
			expect(mv.derivation.stale ?? false, 'MV stays live').to.equal(false);
			expect(mv.derivation.sourceTables, 're-keyed even though the MV AST never names the table').to.deep.equal(['main.t2']);
			// Row-time maintenance re-registered under the new base: writes propagate.
			await db.exec('insert into t2 values (2, 20)');
			expect(await rows(db, 'select id, v from mv order by id'))
				.to.deep.equal([{ id: 1, v: 10 }, { id: 2, v: 20 }]);
		} finally {
			await db.close();
		}
	});
});

describe('MV rename propagation: staleness discipline', () => {
	it('a pre-existing stale flag survives the rename, and REFRESH then resolves the new name', async () => {
		const db = new Database();
		try {
			await db.exec('create table t (id integer primary key, v integer not null)');
			await db.exec('insert into t values (1, 10)');
			await db.exec('create materialized view mv as select id, v from t');

			// A body-relevant source change (retyping the projected column v) marks the MV stale
			// and releases its plan.
			await db.exec('alter table t alter column v set data type real');
			expect(getMv(db, 'mv').derivation.stale, 'stale from the un-refreshed source change').to.equal(true);
			// Writes during staleness are NOT maintained — the stored rows are now behind.
			await db.exec('insert into t values (2, 20)');
			expect(await rows(db, 'select id, v from mv order by id')).to.deep.equal([{ id: 1, v: 10 }]);

			await db.exec('alter table t rename to t2');

			const mv = getMv(db, 'mv');
			expect(mv.derivation.stale, 'rename must NOT clear a pre-existing stale flag').to.equal(true);
			expect(mv.derivation.sourceTables, 'but the body IS rewritten for a later refresh').to.deep.equal(['main.t2']);
			expect(generateMaintainedTableDDL(mv).toLowerCase()).to.include('t2');
			// Still behind: no re-registration happened.
			await db.exec('insert into t2 values (3, 30)');
			expect(await rows(db, 'select id, v from mv order by id')).to.deep.equal([{ id: 1, v: 10 }]);

			// REFRESH resolves the rewritten body (errored "Table 't' not found" before the fix),
			// clears the flag, and re-attaches maintenance.
			await db.exec('refresh materialized view mv');
			expect(getMv(db, 'mv').derivation.stale).to.equal(false);
			expect(await rows(db, 'select id, v from mv order by id'))
				.to.deep.equal([{ id: 1, v: 10 }, { id: 2, v: 20 }, { id: 3, v: 30 }]);
			await db.exec('insert into t2 values (4, 40)');
			expect(await rows(db, 'select id, v from mv order by id'))
				.to.deep.equal([{ id: 1, v: 10 }, { id: 2, v: 20 }, { id: 3, v: 30 }, { id: 4, v: 40 }]);
		} finally {
			await db.close();
		}
	});

	it('a mid-propagation failure leaves the MV stale (not silently frozen); REFRESH recovers', async () => {
		const db = new Database();
		try {
			await db.exec('create table t (id integer primary key, v integer not null)');
			await db.exec('insert into t values (1, 10)');
			await db.exec('create materialized view mv as select id, v from t');

			// Make re-registration fail for the whole statement — both the rewrite
			// path and the end-of-statement restoration pass (which retries every MV
			// the statement left stale) hit it.
			const original = db.registerMaterializedView.bind(db);
			let failures = 0;
			db.registerMaterializedView = (_mv: MaintainedTableSchema) => {
				failures++;
				throw new Error('injected registration failure');
			};

			// The statement itself succeeds — propagation is best-effort per MV.
			await db.exec('alter table t rename to t2');
			expect(failures, 'the rewrite and the restoration pass both attempted re-registration').to.equal(2);

			const mv = getMv(db, 'mv');
			expect(mv.derivation.stale, 'failure path force-marks the MV stale').to.equal(true);
			// Row-time plan released: writes do not propagate while stale.
			await db.exec('insert into t2 values (2, 20)');
			expect(await rows(db, 'select id, v from mv order by id')).to.deep.equal([{ id: 1, v: 10 }]);

			// Heal the registration hook; the body WAS rewritten before the failure,
			// so REFRESH recovers fully.
			db.registerMaterializedView = original;
			await db.exec('refresh materialized view mv');
			expect(getMv(db, 'mv').derivation.stale).to.equal(false);
			expect(await rows(db, 'select id, v from mv order by id'))
				.to.deep.equal([{ id: 1, v: 10 }, { id: 2, v: 20 }]);
			await db.exec('insert into t2 values (3, 30)');
			expect(await rows(db, 'select id, v from mv order by id'))
				.to.deep.equal([{ id: 1, v: 10 }, { id: 2, v: 20 }, { id: 3, v: 30 }]);
		} finally {
			await db.close();
		}
	});

	it('a transient mid-propagation failure is healed by the end-of-statement restoration pass', async () => {
		const db = new Database();
		try {
			await db.exec('create table t (id integer primary key, v integer not null)');
			await db.exec('insert into t values (1, 10)');
			await db.exec('create materialized view mv as select id, v from t');

			// Fail only the FIRST re-registration (the changed-AST rewrite path). The
			// restoration pass at the end of the statement retries: the rewritten body
			// revalidates against the renamed catalog and the stored shape matches,
			// so the MV is restored live within the same statement.
			const original = db.registerMaterializedView.bind(db);
			let failures = 0;
			db.registerMaterializedView = (mv: MaintainedTableSchema) => {
				failures++;
				if (failures === 1) throw new Error('injected transient registration failure');
				original(mv);
			};

			await db.exec('alter table t rename to t2');
			expect(failures, 'the rewrite failed once, then the restoration pass retried').to.equal(2);

			const mv = getMv(db, 'mv');
			expect(mv.derivation.stale ?? false, 'restored live by the restoration pass').to.equal(false);
			// Maintenance re-attached: writes propagate again.
			await db.exec('insert into t2 values (2, 20)');
			expect(await rows(db, 'select id, v from mv order by id'))
				.to.deep.equal([{ id: 1, v: 10 }, { id: 2, v: 20 }]);
		} finally {
			await db.close();
		}
	});
});

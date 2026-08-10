/**
 * `Database.watch` over a materialized-view chain (`mv2` over `mv1` over `w`).
 *
 * A watch's change scope is computed by `analyzeChangeScope`, which replaces a
 * materialized-view reference with the view's **direct** source union
 * (`buildSourceUnionScope`, cached as `derivation.sourceScope` at registration).
 * That projection is one level deep: for `mv2` defined over `mv1`, the projected
 * scope is a `full` watch on `main.mv1`, not on the chain's root source `w`.
 *
 * So `mv2`'s watcher fires only if `main.mv1` is itself a real *changed base* in the
 * transaction change log — which it is only because row-time maintenance records each
 * realized backing delta (`MaterializedViewManager.recordMaintenanceChanges`). Without
 * that recording the chain's consumer silently never fires; this spec pins it.
 */

import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import type { SqlValue } from '../../src/common/types.js';
import type { WatchEvent } from '../../src/index.js';

describe('Database.watch over an MV-over-MV chain', () => {
	let db: Database;
	beforeEach(() => { db = new Database(); });
	afterEach(async () => { if (db) await db.close(); });

	async function createChain(): Promise<void> {
		await db.exec('create table w (x integer primary key, v integer)');
		await db.exec('create materialized view mv1 as select x, v from w');
		await db.exec('create materialized view mv2 as select x, v from mv1');
	}

	it('fires the consumer watcher on an insert into the chain root', async () => {
		await createChain();
		const scope1 = db.prepare('select * from mv1').getChangeScope();
		const scope2 = db.prepare('select * from mv2').getChangeScope();

		const fired: string[] = [];
		const sub1 = db.watch(scope1, () => { fired.push('mv1'); });
		const sub2 = db.watch(scope2, () => { fired.push('mv2'); });

		await db.exec('insert into w values (1, 10)');

		sub1.unsubscribe();
		sub2.unsubscribe();
		expect(fired).to.have.members(['mv1', 'mv2']);
	});

	it('fires the consumer watcher on update and delete too', async () => {
		await createChain();
		await db.exec('insert into w values (1, 10)');

		const scope2 = db.prepare('select * from mv2').getChangeScope();
		const events: WatchEvent[] = [];
		const sub = db.watch(scope2, e => { events.push(e); });

		await db.exec('update w set v = 20 where x = 1');
		expect(events.length, 'update fires the chain consumer').to.be.greaterThan(0);

		const afterUpdate = events.length;
		await db.exec('delete from w where x = 1');
		expect(events.length, 'delete fires the chain consumer').to.be.greaterThan(afterUpdate);

		sub.unsubscribe();
	});

	it('leaves the chain consistent through to the tail view', async () => {
		await createChain();
		await db.exec('insert into w values (1, 10), (2, 20)');
		const rows: Array<Record<string, SqlValue>> = [];
		for await (const row of db.eval('select x, v from mv2 order by x')) rows.push(row);
		expect(rows).to.deep.equal([{ x: 1, v: 10 }, { x: 2, v: 20 }]);
	});
});

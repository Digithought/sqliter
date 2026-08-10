import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database } from '../src/index.js';

/**
 * Maintained-table dispatch for names resolved through the SCHEMA PATH rather
 * than the current schema. The DML builders' view/MV dispatch defaults an
 * unqualified name to the current schema, while `buildTableReference` resolves
 * through the schema path — so a maintained table reachable only via the path
 * (e.g. it lives in `temp` while the current schema is `main`) used to slip
 * past the write-through rewrite into a DIRECT table write, silently diverging
 * the derived contents from the source. The resolved-table backstop in
 * insert/update/delete routes that spelling through the same view-mutation
 * rewrite; the select-side mirror keeps the stale re-validation guard.
 */
describe('Maintained-table dispatch through the schema path', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table temp.src (id integer primary key, v integer)');
		await db.exec('insert into temp.src values (1, 10)');
		await db.exec('create materialized view temp.mv as select id, v from temp.src');
		await db.exec("pragma schema_path = 'main,temp'");
	});
	afterEach(async () => { await db.close(); });

	async function rows(sql: string): Promise<unknown[]> {
		const out: unknown[] = [];
		for await (const r of db.eval(sql)) out.push(r);
		return out;
	}

	it('insert via the unqualified name routes write-through to the source', async () => {
		await db.exec('insert into mv values (2, 20)');
		expect(await rows('select * from temp.src order by id'), 'source received the row')
			.to.deep.equal([{ id: 1, v: 10 }, { id: 2, v: 20 }]);
		expect(await rows('select * from temp.mv order by id'), 'MV maintained from the source')
			.to.deep.equal([{ id: 1, v: 10 }, { id: 2, v: 20 }]);
	});

	it('update via the unqualified name routes write-through to the source', async () => {
		await db.exec('update mv set v = 99 where id = 1');
		expect(await rows('select v from temp.src where id = 1')).to.deep.equal([{ v: 99 }]);
		expect(await rows('select v from temp.mv where id = 1')).to.deep.equal([{ v: 99 }]);
	});

	it('delete via the unqualified name routes write-through to the source', async () => {
		await db.exec('delete from mv where id = 1');
		expect(await rows('select count(*) as n from temp.src')).to.deep.equal([{ n: 0 }]);
		expect(await rows('select count(*) as n from temp.mv')).to.deep.equal([{ n: 0 }]);
	});

	it('a stale MV read via the unqualified name still hits the stale re-validation guard', async () => {
		// A structural source change the body cannot survive marks the MV stale.
		await db.exec('alter table temp.src drop column v');
		let err: Error | undefined;
		try {
			await rows('select * from mv');
		} catch (e) {
			err = e instanceof Error ? e : new Error(String(e));
		}
		expect(err, 'stale diagnostic raised for the path-resolved spelling').to.not.be.undefined;
		expect(err!.message).to.contain('stale');
	});
});

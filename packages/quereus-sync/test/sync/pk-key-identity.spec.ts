import { expect } from 'chai';
import { makePeer, closePeer, localWrite, relay, collect, changesFor, type Peer } from './_peer-harness.js';

describe('sync pk identity honours key collation and semantic key transforms', () => {
	let a: Peer;
	let b: Peer;

	const setup = async (ddl: string) => {
		a = await makePeer('A');
		b = await makePeer('B');
		await a.db.exec(ddl);
		await b.db.exec(ddl);
	};

	afterEach(async () => {
		await closePeer(a);
		await closePeer(b);
	});

	it('nocase: one row files under one pk identity', async () => {
		await setup(`create table t (k text collate nocase primary key, v text) using store`);
		await localWrite(a, `insert into t values ('apple', 'v1')`);
		await localWrite(a, `update t set k = 'APPLE', v = 'v2' where k = 'apple'`);

		const changes = await changesFor(a, b.manager.getSiteId());
		const pkSpellings = new Set(changes.map(c => JSON.stringify(c.pk)));
		expect([...pkSpellings], 'one row => one pk identity').to.have.length(1);
	});

	it('nocase: a delete under one spelling blocks a stale write under the other', async () => {
		await setup(`create table t (k text collate nocase primary key, v text) using store`);
		await localWrite(a, `insert into t values ('apple', 'v1')`);
		await relay(a, b);
		await localWrite(a, `update t set k = 'APPLE', v = 'v2' where k = 'apple'`);
		await localWrite(b, `delete from t where k = 'apple'`);

		await relay(b, a);
		expect(await collect(a.db, `select k from t`), 'delete wins on A').to.deep.equal([]);
		await relay(a, b);
		expect(await collect(b.db, `select k from t`), 'later delete not undone').to.deep.equal([]);
	});

	it('nocase: concurrent insert of one row under two spellings converges', async () => {
		await setup(`create table t (k text collate nocase primary key, v text) using store`);
		await localWrite(a, `insert into t values ('apple', 'fromA')`);
		await localWrite(b, `insert into t values ('APPLE', 'fromB')`);

		await relay(a, b);
		await relay(b, a);
		await relay(a, b);
		await relay(b, a);

		expect(await collect(a.db, `select k, v from t`), 'peers converge')
			.to.deep.equal(await collect(b.db, `select k, v from t`));
	});

	it('timespan: concurrent insert under two equal-elapsed spellings converges', async () => {
		await setup(`create table t (d timespan primary key, v text) using store`);
		await localWrite(a, `insert into t values ('PT1H', 'fromA')`);
		await localWrite(b, `insert into t values ('PT60M', 'fromB')`);

		await relay(a, b);
		await relay(b, a);
		await relay(a, b);
		await relay(b, a);

		expect(await collect(a.db, `select d, v from t`), 'peers converge')
			.to.deep.equal(await collect(b.db, `select d, v from t`));
	});

	it('timespan: a delete under one spelling blocks a stale write under the other', async () => {
		await setup(`create table t (d timespan primary key, v text) using store`);
		await localWrite(a, `insert into t values ('PT1H', 'v1')`);
		await relay(a, b);
		await localWrite(a, `update t set d = 'PT60M', v = 'v2' where d = 'PT1H'`);
		await localWrite(b, `delete from t where d = 'PT1H'`);

		await relay(b, a);
		expect(await collect(a.db, `select d from t`), 'delete wins on A').to.deep.equal([]);
		await relay(a, b);
		expect(await collect(b.db, `select d from t`), 'later delete not undone').to.deep.equal([]);
	});

	it('bigint: an integer pk beyond the double-safe range still replicates', async () => {
		await setup(`create table t (id integer primary key, v text) using store`);
		await localWrite(a, `insert into t values (9007199254740993, 'x')`);

		await relay(a, b);
		expect(await collect(b.db, `select v from t where id = 9007199254740993`), 'row arrives on B')
			.to.deep.equal([{ v: 'x' }]);
	});
});

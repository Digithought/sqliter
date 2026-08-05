/**
 * Regression: `MemoryTableManager.tryCollapseLayers` used to detach a committed layer
 * (`clearBase()`) that other live layers were still inheriting from. inheritree tracks the
 * base-immutability contract with a version total, and dropping the base pointer removes the
 * base's whole contribution from it — so every already-derived child's snapshot stops matching
 * and its next `checkBase()` raises `MutatedBaseError: Base tree was mutated while a derived
 * child was live`, even though no row moved.
 *
 * The throw surfaces later than the collapse: `checkBase()` runs from `getCount()`, and
 * `new BTree(…, { base })` calls `base.getCount()`, so it lands in the `TransactionLayer`
 * constructor the next commit builds.
 *
 * Both shapes below drive the same path — a delete against a table another table references
 * `on delete cascade`, where the cascade opens a savepoint on the parent's connection. The
 * eager savepoint moves the connection's uncommitted layer into `readLayer` and nulls
 * `pendingTransactionLayer`, which is what used to let `disconnect` drop a live connection and
 * the collapse then run with no record of it.
 */
import { expect } from 'chai';
import { Database } from '../../src/core/database.js';

async function rows(db: Database, sql: string): Promise<Record<string, unknown>[]> {
	const out: Record<string, unknown>[] = [];
	for await (const r of db.eval(sql)) out.push(r as Record<string, unknown>);
	return out;
}

describe('layer collapse vs. live derived layers (MutatedBaseError)', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	it('commits a delete that cascades to NO child rows, then an unrelated update', async () => {
		// Zero matching child rows is the trigger: the cascade still opens (and releases) a
		// savepoint on the parent's connection, but performs no delete of its own, so the
		// layer ordering that dodges the bug when rows are present never happens.
		await db.exec('create table P (id integer primary key, name text)');
		await db.exec(`create table C (id integer primary key,
			pid integer not null references P(id) on delete cascade)`);
		await db.exec("insert into P values (1, 'A')");
		await db.exec("insert into P values (2, 'B')");

		await db.exec('delete from P where id = 2');
		await db.exec("update P set name = 'z' where id = 1");

		expect(await rows(db, 'select id, name from P order by id')).to.deep.equal([{ id: 1, name: 'z' }]);
		expect(await rows(db, 'select id from C')).to.deep.equal([]);
	});

	it('commits a delete that cascades to real child rows', async () => {
		// The passing-before-the-fix case, kept so the guard cannot be "fixed" by breaking it.
		await db.exec('create table P (id integer primary key, name text)');
		await db.exec(`create table C (id integer primary key,
			pid integer not null references P(id) on delete cascade)`);
		await db.exec("insert into P values (1, 'A'), (2, 'B')");
		await db.exec('insert into C values (10, 1), (20, 2)');

		await db.exec('delete from P where id = 2');
		await db.exec("update P set name = 'z' where id = 1");

		expect(await rows(db, 'select id, name from P order by id')).to.deep.equal([{ id: 1, name: 'z' }]);
		expect(await rows(db, 'select id from C order by id')).to.deep.equal([{ id: 10 }]);
	});

	it('commits two interleaved write chains on one database', async () => {
		// `insert or replace` over an existing row runs the delete side, so it takes the same
		// cascade path as the delete above — here with two chains interleaving on one Database.
		await db.exec(`create table IntegrationState (
			integration_id text primary key, state text, last_transition_ts integer)`);
		await db.exec('create index idx_integrationstate_state on IntegrationState(state)');
		await db.exec(`create table WebhookEndpoint (
			integration_id text primary key, path_token text,
			foreign key (integration_id) references IntegrationState(integration_id) on delete cascade)`);
		await db.exec(`create table ConnectionEvent (
			id integer primary key, integration_id text, ts integer, to_state text)`);
		await db.exec('create index idx_connectionevent_integration on ConnectionEvent(integration_id, ts)');

		let nextId = 1;
		const transition = async (integrationId: string, to: string): Promise<void> => {
			const id = nextId++;
			await db.exec(
				'insert into ConnectionEvent (id, integration_id, ts, to_state) values (?, ?, ?, ?)',
				[id, integrationId, id * 10, to]);
			await db.exec(
				`insert or replace into IntegrationState (integration_id, state, last_transition_ts)
				 values (?, ?, ?)`,
				[integrationId, to, id * 10]);
		};

		const chain = async (integrationId: string): Promise<void> => {
			await transition(integrationId, 'connecting');
			await transition(integrationId, 'connected');
			await transition(integrationId, 'degraded');
		};

		await Promise.all([chain('int-a'), chain('int-b')]);

		expect(await rows(db, 'select count(*) as c from ConnectionEvent')).to.deep.equal([{ c: 6 }]);
		expect(await rows(db, 'select integration_id, state from IntegrationState order by integration_id'))
			.to.deep.equal([
				{ integration_id: 'int-a', state: 'degraded' },
				{ integration_id: 'int-b', state: 'degraded' },
			]);
	});
});

/**
 * A schema migration's version counter is per `(schema, object KIND, object name)`.
 *
 * `create index orders on orders (note)` is legal when a table `orders` exists —
 * the engine's index-name uniqueness rule (SCH-001, docs/invariants.md) is
 * index-vs-index only. Before the `sm:` key carried the object kind, that index
 * and that table shared one migration stream: the index migration bumped the
 * TABLE's version, and a concurrent table migration on another peer landed on
 * the same `(object, version)` key — so the HLC-dominance skip in
 * `change-applicator.ts` dropped one of them permanently, with no error and no
 * retry path.
 *
 * The peers here are deliberately NOT both built with `createOrders`: two
 * independent `create table orders` statements produce two version-1 table
 * migrations whose HLCs tie on wall time and break on the random site id, so
 * which one dominates — and therefore whether the receiver's own definition is
 * challenged — would vary run to run. Bootstrapping `y`'s schema by relaying
 * `x`'s create instead gives both peers the SAME version-1 migration, so every
 * later assertion is about the collision under test and nothing else.
 */

import { expect } from 'chai';
import { makePeer, closePeer, localWrite, relayAll, type Peer } from './_peer-harness.js';

const ORDERS_DDL = 'create table orders (id integer primary key, note text) using store';

/** The index `orders` on table `orders` — the name collision under test. */
const COLLIDING_INDEX = 'create index orders on orders (note)';

/** A TABLE migration on `orders`, concurrent with the index one. */
const CONCURRENT_ALTER = 'alter table orders add column qty integer';

const indexOwner = (peer: Peer, name: string): string | undefined =>
	peer.db.schemaManager.findIndexOwner('main', name)?.table.name;

const version = (peer: Peer, kind: 'table' | 'index', name: string): Promise<number> =>
	peer.manager.schemaMigrations.getCurrentVersion('main', kind, name);

describe('schema migration version keys carry the object kind', () => {
	let x: Peer;
	let y: Peer;

	beforeEach(async () => {
		x = await makePeer('x', { createOrders: true, ordersDdl: ORDERS_DDL });
		y = await makePeer('y');
		// Bootstrap y's schema from x, so both hold the identical version-1
		// `create table orders` migration (same DDL, same HLC).
		await relayAll(x, y);
		expect(y.db.schemaManager.getTable('main', 'orders'), 'y bootstrapped orders').to.not.be.undefined;
		expect(await version(y, 'table', 'orders'), 'y holds x\'s create at version 1').to.equal(1);
	});

	afterEach(async () => {
		await closePeer(x);
		await closePeer(y);
	});

	it('an index named after a table does not advance the table version', async () => {
		expect(await version(x, 'table', 'orders'), 'create table orders is version 1').to.equal(1);
		expect(await version(x, 'index', 'orders'), 'no index stream yet').to.equal(0);

		await localWrite(x, COLLIDING_INDEX);
		expect(indexOwner(x, 'orders'), 'the colliding index is accepted').to.equal('orders');

		expect(
			await version(x, 'table', 'orders'),
			'the table counter is untouched by an index migration',
		).to.equal(1);
		expect(
			await version(x, 'index', 'orders'),
			'the index gets its own version-1 stream',
		).to.equal(1);
	});

	it('dropping the colliding index also stays in the index stream', async () => {
		await localWrite(x, COLLIDING_INDEX);
		await localWrite(x, 'drop index orders');

		expect(indexOwner(x, 'orders'), 'the index is gone').to.be.undefined;
		expect(await version(x, 'index', 'orders'), 'create + drop are versions 1 and 2').to.equal(2);
		expect(await version(x, 'table', 'orders'), 'neither touched the table stream').to.equal(1);
		expect(x.db.schemaManager.getTable('main', 'orders'), 'the table survives').to.not.be.undefined;
	});

	it('a concurrent table migration does not suppress the colliding index migration', async () => {
		// x: index `orders` — table-version 2 under the old, kind-less key.
		await localWrite(x, COLLIDING_INDEX);
		// y: a later-HLC table migration that claimed that same old key.
		await localWrite(y, CONCURRENT_ALTER);
		expect(await version(y, 'table', 'orders'), 'y\'s alter is table version 2').to.equal(2);

		const res = await relayAll(x, y);

		expect(indexOwner(y, 'orders'), 'y receives the index').to.equal('orders');
		expect(await version(y, 'index', 'orders'), 'recorded in its own stream').to.equal(1);
		expect(res.applied, 'the index migration is applied, not skipped').to.equal(1);
		// y's own alter survives untouched — the two migrations no longer contend.
		expect(await version(y, 'table', 'orders')).to.equal(2);
	});

	it('the same holds when the colliding index is the LATER of the two migrations', async () => {
		// Reversed order so the result does not depend on which side's HLC wins.
		await localWrite(y, CONCURRENT_ALTER);
		await localWrite(x, COLLIDING_INDEX);

		const res = await relayAll(x, y);

		expect(indexOwner(y, 'orders'), 'y receives the index').to.equal('orders');
		expect(await version(y, 'index', 'orders')).to.equal(1);
		expect(res.applied).to.equal(1);
	});

	it('re-relaying the same batch is idempotent', async () => {
		await localWrite(x, COLLIDING_INDEX);
		await localWrite(y, CONCURRENT_ALTER);

		await relayAll(x, y);
		const second = await relayAll(x, y);

		expect(indexOwner(y, 'orders'), 'the index survives the re-relay').to.equal('orders');
		expect(second.applied, 'nothing new on the second pass').to.equal(0);
	});
});

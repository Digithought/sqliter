/**
 * A local UPDATE that MOVES a row's primary key must reach a synced peer as a move:
 * the old identity retired, the new one created — never both rows present.
 *
 * The engine's data-event contract is what makes this work (docs/usage.md § Subscribing to
 * Data Changes): a relocating key change is delivered as a `delete` at the old key followed by
 * an `insert` at the new key, never as one `update`. Sync is a plain consumer of that — it
 * writes a tombstone only for a `delete` event and column versions under `event.key` for
 * anything else — so a single post-image-keyed `update` would file the moved row under the new
 * identity and leave the OLD one alive forever: the receiving peer would end up holding both
 * rows. This spec is the end-to-end proof that it does not, and the reason the contract splits
 * rather than merely re-keying.
 */

import { expect } from 'chai';
import {
	changesFor,
	closePeer,
	collect,
	localWrite,
	makePeer,
	relay,
	type Peer,
} from './_peer-harness.js';

describe('a PK-changing update replicates as a move, not a duplication', () => {
	let a: Peer;
	let b: Peer;

	beforeEach(async () => {
		a = await makePeer('A', { createOrders: true });
		b = await makePeer('B', { createOrders: true });
	});

	afterEach(async () => {
		await closePeer(a);
		await closePeer(b);
	});

	it('leaves the receiver holding only the new pk', async () => {
		await localWrite(a, "insert into orders values (1, 'x')");
		await relay(a, b);
		expect(await collect(b.db, 'select * from orders order by id')).to.deep.equal([{ id: 1, note: 'x' }]);

		await localWrite(a, 'update orders set id = 2 where id = 1');
		await relay(a, b);

		expect(await collect(a.db, 'select * from orders order by id')).to.deep.equal([{ id: 2, note: 'x' }]);
		expect(await collect(b.db, 'select * from orders order by id')).to.deep.equal([{ id: 2, note: 'x' }]);
	});

	it('tombstones the old pk and records column versions under the new one', async () => {
		await localWrite(a, "insert into orders values (1, 'x')");
		await relay(a, b);
		await localWrite(a, 'update orders set id = 2 where id = 1');

		const oldTombstone = await a.manager.tombstones.getTombstone('main', 'orders', [1]);
		expect(oldTombstone, 'the retired identity must be tombstoned').to.not.equal(undefined);
		const newTombstone = await a.manager.tombstones.getTombstone('main', 'orders', [2]);
		expect(newTombstone, 'the live identity must not be tombstoned').to.equal(undefined);

		const newVersions = await a.manager.columnVersions.getRowVersions('main', 'orders', [2]);
		expect([...newVersions.keys()].sort()).to.deep.equal(['id', 'note']);
	});

	it('relays a delete for the old pk and a full cell set for the new one', async () => {
		// The insert half carries no before-image, so EVERY column is recorded under the new
		// pk — not just the key column the statement named. A post-image-keyed single `update`
		// would diff against `oldRow` and relay only `id`, leaving `note` unset at the new
		// identity (and the old identity alive).
		await localWrite(a, "insert into orders values (1, 'x')");
		await relay(a, b);
		await localWrite(a, 'update orders set id = 2 where id = 1');

		const changes = (await changesFor(a, b.manager.getSiteId()))
			.filter(c => c.table === 'orders');
		expect(changes.map(c => ({ type: c.type, pk: c.pk }))).to.deep.equal([
			{ type: 'delete', pk: [1] },
			{ type: 'column', pk: [2] },
			{ type: 'column', pk: [2] },
		]);
	});

	it('a case-only rewrite under a NOCASE key moves nothing, so nothing is tombstoned', async () => {
		// The row never leaves its slot, so the contract keeps it a single `update` and sync
		// files it as a plain column-version write under the (unchanged) identity. A producer
		// that mistook the byte change for a move would tombstone the row's own live identity.
		const ddl = 'create table orders (k text not null collate nocase, note text, primary key (k)) using store';
		const ca = await makePeer('CA', { createOrders: true, ordersDdl: ddl });
		const cb = await makePeer('CB', { createOrders: true, ordersDdl: ddl });
		try {
			await localWrite(ca, "insert into orders values ('apple', 'x')");
			await relay(ca, cb);
			await localWrite(ca, "update orders set k = 'APPLE' where k = 'apple'");
			await relay(ca, cb);

			expect(await collect(ca.db, 'select * from orders')).to.deep.equal([{ k: 'APPLE', note: 'x' }]);
			expect(await collect(cb.db, 'select * from orders')).to.deep.equal([{ k: 'APPLE', note: 'x' }]);
			expect(await ca.manager.tombstones.getTombstone('main', 'orders', ['APPLE'])).to.equal(undefined);
		} finally {
			await closePeer(ca);
			await closePeer(cb);
		}
	});
});

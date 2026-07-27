/**
 * Drop-table / create-index / drop-index migrations actually reach a peer.
 *
 * Sync replicates a schema change by shipping the DDL text the originating
 * device recorded for it and re-running that text on the receiver. Only the
 * create-table event used to set that text; drop table, create index and drop
 * index emitted none, so they crossed the wire as an empty statement and the
 * receiver ran nothing — a device that dropped a table or added an index stayed
 * silently diverged from its peers.
 *
 * The receiving half (`store-adapter.ts` § `decideSchemaChange`) was already
 * built and is covered against synthetic migrations by
 * `schema-replication-idempotency.spec.ts`. These specs drive the same branches
 * with the REAL DDL now flowing from the store module's emit sites, end to end
 * over two real engines via `relayAll`.
 */

import { expect } from 'chai';
import { generateIndexDDL } from '@quereus/quereus';
import type { SchemaChangeEvent } from '@quereus/store';
import {
	closePeer,
	collect,
	localWrite,
	makePeer,
	relayAll,
	settle,
	type Peer,
} from './_peer-harness.js';

const NOTE_INDEX = 'idx_orders_note';
const CREATE_NOTE_INDEX = `create index ${NOTE_INDEX} on orders (note)`;

/** Two peers that each already created the identical `orders` table. */
async function makeSyncedPair(): Promise<[Peer, Peer]> {
	const a = await makePeer('a', { createOrders: true });
	const b = await makePeer('b', { createOrders: true });
	return [a, b];
}

/** The live index schema on a peer, or undefined when it has no such index. */
function findIndex(peer: Peer, tableName: string, indexName: string) {
	const table = peer.db.schemaManager.getTable('main', tableName);
	return table?.indexes?.find(i => i.name.toLowerCase() === indexName.toLowerCase());
}

/** Canonical `CREATE INDEX` for a live index, rendered exactly as the origin does. */
function indexDDL(peer: Peer, tableName: string, indexName: string): string {
	const table = peer.db.schemaManager.getTable('main', tableName)!;
	return generateIndexDDL(findIndex(peer, tableName, indexName)!, table);
}

/** Collect a peer's schema events for the duration of `body`. */
async function captureSchemaEvents(
	peer: Peer,
	body: () => Promise<void>,
): Promise<SchemaChangeEvent[]> {
	const seen: SchemaChangeEvent[] = [];
	const unsubscribe = peer.events.onSchemaChange(e => seen.push(e));
	try {
		await body();
		await settle();
	} finally {
		unsubscribe();
	}
	return seen;
}

/** `[type, objectType, objectName, remote]` tuples, for readable deep-equals. */
const signatures = (events: SchemaChangeEvent[]) =>
	events.map(e => [e.type, e.objectType, e.objectName, e.remote ?? false]);

describe('schema DDL replication', () => {
	let a: Peer;
	let b: Peer;

	beforeEach(async () => {
		[a, b] = await makeSyncedPair();
	});

	afterEach(async () => {
		await closePeer(a);
		await closePeer(b);
	});

	describe('drop table', () => {
		it('drops the table on the receiving peer', async () => {
			await localWrite(a, 'drop table orders');

			await relayAll(a, b);

			expect(b.db.schemaManager.getTable('main', 'orders')).to.be.undefined;
		});

		it('converges silently when the receiver already dropped the table', async () => {
			await localWrite(a, 'drop table orders');
			const sets = await a.manager.getChangesSince(b.manager.getSiteId());

			// Applying the SAME batch twice: the second pass finds the table already
			// gone and must converge rather than fail "no such table".
			await b.manager.applyChanges(sets);
			await b.manager.applyChanges(sets);

			expect(b.db.schemaManager.getTable('main', 'orders')).to.be.undefined;
		});

		it('applies alongside row changes for the dropped table without resurrecting it', async () => {
			// DDL runs before DML, so the batch's own drop makes `orders` unknown for
			// the data phase (`computeBatchTableDelta`) and its rows divert instead of
			// hitting a missing table. Previously unexercised: the drop was a no-op.
			await localWrite(a, "insert into orders values (1, 'from A')");
			await localWrite(a, 'drop table orders');

			const result = await relayAll(a, b);

			expect(b.db.schemaManager.getTable('main', 'orders')).to.be.undefined;
			expect(result.unknownTable ?? 0, 'diverted row changes').to.be.greaterThan(0);
		});

		it('leaves no stale remote-event expectation when the dropped table had an index', async () => {
			await localWrite(a, CREATE_NOTE_INDEX);
			await localWrite(a, 'drop table orders');

			const inbound = await captureSchemaEvents(b, async () => {
				await relayAll(a, b);
			});

			// One event per executed migration, each marked remote. A `drop table`
			// over an indexed table must NOT also emit a per-index drop: expectations
			// are matched one for one and never expire, so a surplus event leaks a
			// local-looking change back onto the wire.
			expect(signatures(inbound)).to.deep.equal([
				['create', 'index', NOTE_INDEX, true],
				['drop', 'table', 'orders', true],
			]);

			// ...and no expectation lingered to swallow the next genuine LOCAL DDL of
			// the same signature (a swallowed local event is filtered out of the
			// SyncManager's capture and never replicates).
			const local = await captureSchemaEvents(b, async () => {
				await b.db.exec('create table orders (id integer primary key, note text) using store');
				await b.db.exec(CREATE_NOTE_INDEX);
				await b.db.exec(`drop index ${NOTE_INDEX}`);
				await b.db.exec('drop table orders');
			});
			expect(signatures(local)).to.deep.equal([
				['create', 'table', 'orders', false],
				['create', 'index', NOTE_INDEX, false],
				['drop', 'index', NOTE_INDEX, false],
				['drop', 'table', 'orders', false],
			]);
		});
	});

	describe('create index', () => {
		it('creates the index on the receiving peer', async () => {
			await localWrite(a, CREATE_NOTE_INDEX);

			await relayAll(a, b);

			expect(findIndex(b, 'orders', NOTE_INDEX), 'index on b').to.not.be.undefined;
			// Both peers must render the SAME canonical DDL, or the receiver's
			// already-applied check would report a conflict instead of converging.
			expect(indexDDL(b, 'orders', NOTE_INDEX)).to.equal(indexDDL(a, 'orders', NOTE_INDEX));
		});

		it('converges when the receiver independently created the identical index', async () => {
			await localWrite(a, CREATE_NOTE_INDEX);
			await localWrite(b, CREATE_NOTE_INDEX);

			await relayAll(a, b);

			expect(findIndex(b, 'orders', NOTE_INDEX), 'index on b').to.not.be.undefined;
		});

		it('converges when the same batch is applied twice', async () => {
			await localWrite(a, CREATE_NOTE_INDEX);
			const sets = await a.manager.getChangesSince(b.manager.getSiteId());

			await b.manager.applyChanges(sets);
			await b.manager.applyChanges(sets);

			expect(findIndex(b, 'orders', NOTE_INDEX), 'index on b').to.not.be.undefined;
		});

		it('surfaces a conflict for a same-name index over different columns', async () => {
			// `localWrite` settles 25ms between the two, so b's migration always carries
			// the strictly greater HLC. Relaying b → a is therefore the direction that
			// actually admits the incoming migration; a → b is HLC-dominated and skipped
			// before it ever reaches the adapter.
			await localWrite(a, CREATE_NOTE_INDEX);
			await localWrite(b, `create index ${NOTE_INDEX} on orders (id)`);

			let caught: Error | undefined;
			try {
				await relayAll(b, a);
			} catch (e) {
				caught = e as Error;
			}

			expect(caught, 'expected the divergent index to be surfaced').to.be.instanceOf(Error);
			expect(caught!.message).to.include(NOTE_INDEX);
			expect(caught!.message).to.include('add_index');
			// Both definitions are printed so an operator can see WHAT diverged.
			expect(caught!.message).to.include('local:');
			expect(caught!.message).to.include('remote:');
		});

		it('keeps the replicated index maintained for subsequent rows', async () => {
			await localWrite(a, CREATE_NOTE_INDEX);
			await relayAll(a, b);

			await localWrite(a, "insert into orders values (1, 'from A')");
			await relayAll(a, b);

			expect(await collect(b.db, "select id from orders where note = 'from A'"))
				.to.deep.equal([{ id: 1 }]);
		});
	});

	describe('drop index', () => {
		it('drops the index on the receiving peer', async () => {
			await localWrite(a, CREATE_NOTE_INDEX);
			await relayAll(a, b);
			expect(findIndex(b, 'orders', NOTE_INDEX), 'index on b before drop').to.not.be.undefined;

			await localWrite(a, `drop index ${NOTE_INDEX}`);
			await relayAll(a, b);

			expect(findIndex(b, 'orders', NOTE_INDEX), 'index on b after drop').to.be.undefined;
		});

		it('converges when the same batch is applied twice', async () => {
			await localWrite(a, CREATE_NOTE_INDEX);
			await relayAll(a, b);
			await localWrite(a, `drop index ${NOTE_INDEX}`);

			const sets = await a.manager.getChangesSince(b.manager.getSiteId());
			await b.manager.applyChanges(sets);
			await b.manager.applyChanges(sets);

			expect(findIndex(b, 'orders', NOTE_INDEX), 'index on b').to.be.undefined;
		});

		it('converges when the receiver never had the index', async () => {
			// b never received the create, so the drop arrives for an index it does
			// not have — the already-applied branch.
			await localWrite(a, CREATE_NOTE_INDEX);
			await localWrite(a, `drop index ${NOTE_INDEX}`);

			await relayAll(a, b);

			expect(findIndex(b, 'orders', NOTE_INDEX), 'index on b').to.be.undefined;
		});
	});
});

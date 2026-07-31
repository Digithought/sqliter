/**
 * `applyChanges` is ORDER-INDEPENDENT: a batch handed to it in any order must leave
 * the same committed state as the HLC-ordered array.
 *
 * The failure this pins: resolution and the in-batch delete reconciliation decide by
 * HLC, while the store adapter replays each row group in LIST order (a
 * `DataChangeToApply` carries no timestamp). They agree only while list order happens
 * to match HLC order — which `getChangesSince` guarantees for ONE sender, but which
 * `applyChanges`' callers do not: the coordinator's approval hook returns a
 * caller-supplied array, the REST/WebSocket ingress accepts an arbitrary array, and a
 * caller merging two senders' changesets produces an interleaving neither sender
 * emitted. Pre-fix, a reordered batch could delete a row from the table while the
 * metadata recorded it as resurrected — so the replica advertised a row it did not
 * have. `change-applicator.ts` now sorts the store apply list by HLC.
 *
 * Every spec here runs on real `Database` peers (`_peer-harness.ts`), so it compares
 * the actual table contents against the CRDT metadata, not metadata against itself.
 */

import { expect } from 'chai';
import { type ChangeSet, type SyncConfig } from '../../src/sync/protocol.js';
import { compareHLC } from '../../src/clock/hlc.js';
import { generateSiteId } from '../../src/clock/site.js';
import {
	closePeer,
	collect,
	flattenSets,
	localWrite,
	makePeer,
	relay,
	reviveOrders,
	type Peer,
} from './_peer-harness.js';

const RESURRECT: Partial<SyncConfig> = { allowResurrection: true };

/** Drop schema migrations: every peer here is built with `orders` already created. */
const dataOnly = (sets: ChangeSet[]): ChangeSet[] => sets.map(cs => ({ ...cs, schemaMigrations: [] }));

/** Pull `from`'s data changesets addressed to `to`, without applying them. */
async function pull(from: Peer, to: Peer): Promise<ChangeSet[]> {
	return dataOnly(await from.manager.getChangesSince(to.manager.getSiteId()));
}

/** The row's live cell records, comparable across peers (sorted, HLCs included). */
async function cells(peer: Peer, pk: number): Promise<unknown> {
	const versions = await peer.manager.columnVersions.getRowVersions('main', 'orders', [pk]);
	return [...versions.entries()].sort(([a], [b]) => a.localeCompare(b));
}

/** What this peer would relay onward to a never-seen third site. */
async function relayedTo(peer: Peer, third: ReturnType<typeof generateSiteId>): Promise<unknown> {
	return flattenSets(await peer.manager.getChangesSince(third));
}

/**
 * Origin does three separate local transactions on `orders` row 1: insert `'x'`,
 * delete, re-insert `'y'`. The origin's own delete cleanup removes the first insert's
 * metadata, so a fresh receiver pulls exactly two transactions — the delete, then the
 * re-creation — and reversing that array puts the re-creation BEFORE the delete.
 */
async function makeOriginWithRecreatedRow(): Promise<Peer> {
	const origin = await makePeer('origin', { createOrders: true });
	await localWrite(origin, "insert into orders (id, note) values (1, 'x')");
	await localWrite(origin, 'delete from orders where id = 1');
	await localWrite(origin, "insert into orders (id, note) values (1, 'y')");
	return origin;
}

/** Guard a repro's premise: this array really is not in HLC order. */
function expectNotHLCOrdered(sets: ChangeSet[]): void {
	const hlcs = flattenSets(sets).map(c => c.hlc);
	expect(hlcs.length).to.be.greaterThan(1);
	expect(hlcs.some((hlc, i) => i > 0 && compareHLC(hlcs[i - 1], hlc) > 0)).to.equal(true);
}

describe('applyChanges order independence', () => {
	describe('reversed changeset array (one sender)', () => {
		// Pre-fix: the reordered receiver's table was EMPTY while its cell records and
		// change log were identical to the in-order receiver's — so it relayed row 1 to
		// every peer while not having it.
		it('allowResurrection: true — keeps the re-created row in the table AND the metadata', async () => {
			const origin = await makeOriginWithRecreatedRow();
			const inOrder = await makePeer('in-order', { createOrders: true, config: RESURRECT });
			const reordered = await makePeer('reordered', { createOrders: true, config: RESURRECT });
			try {
				await inOrder.manager.applyChanges(await pull(origin, inOrder));

				const reversed = [...(await pull(origin, reordered))].reverse();
				expectNotHLCOrdered(reversed);
				await reordered.manager.applyChanges(reversed);

				// The table row survives the reordering...
				expect(await collect(reordered.db, 'select id, note from orders'))
					.to.deep.equal([{ id: 1, note: 'y' }]);
				expect(await collect(reordered.db, 'select id, note from orders'))
					.to.deep.equal(await collect(inOrder.db, 'select id, note from orders'));

				// ...and so does the metadata, identically to the in-order receiver.
				expect(await cells(reordered, 1)).to.deep.equal(await cells(inOrder, 1));
				const third = generateSiteId();
				expect(await relayedTo(reordered, third)).to.deep.equal(await relayedTo(inOrder, third));
			} finally {
				await closePeer(origin);
				await closePeer(inOrder);
				await closePeer(reordered);
			}
		});

		it('allowResurrection: false (default) — leaves the row deleted in the table AND the metadata', async () => {
			const origin = await makeOriginWithRecreatedRow();
			const inOrder = await makePeer('in-order', { createOrders: true });
			const reordered = await makePeer('reordered', { createOrders: true });
			try {
				const inOrderResult = await inOrder.manager.applyChanges(await pull(origin, inOrder));

				const reversed = [...(await pull(origin, reordered))].reverse();
				expectNotHLCOrdered(reversed);
				const reorderedResult = await reordered.manager.applyChanges(reversed);

				// The delete blocks every same-batch column write whatever its HLC, so
				// both receivers end with no row and only the tombstone's metadata.
				expect(await collect(reordered.db, 'select id, note from orders')).to.deep.equal([]);
				expect(await collect(inOrder.db, 'select id, note from orders')).to.deep.equal([]);
				expect(await cells(reordered, 1)).to.deep.equal([]);
				expect(await cells(reordered, 1)).to.deep.equal(await cells(inOrder, 1));

				expect({ applied: reorderedResult.applied, skipped: reorderedResult.skipped, conflicts: reorderedResult.conflicts })
					.to.deep.equal({ applied: inOrderResult.applied, skipped: inOrderResult.skipped, conflicts: inOrderResult.conflicts });

				const third = generateSiteId();
				expect(await relayedTo(reordered, third)).to.deep.equal(await relayedTo(inOrder, third));
			} finally {
				await closePeer(origin);
				await closePeer(inOrder);
				await closePeer(reordered);
			}
		});
	});

	// Not reachable from ONE sender's getChangesSince: the change log keeps at most one
	// entry per (pk, column), so a single sender never emits two facts for one column.
	// It needs a caller that merges two senders' batches — which the coordinator's
	// approval hook and the REST/WebSocket ingress do not prevent.
	describe('two senders merged later-HLC-first', () => {
		// Pre-fix: the table read `note = 'a'` (store kept the last-ARRIVING write) while
		// the cell record read `note = 'b'` (metadata kept the max-HLC write).
		it('lands the max-HLC value in the table and the cell record alike', async () => {
			const a = await makePeer('a', { createOrders: true });
			const b = await makePeer('b', { createOrders: true });
			const receiver = await makePeer('receiver', { createOrders: true });
			try {
				await localWrite(a, "insert into orders (id, note) values (7, 'a')");
				await relay(a, b);
				await localWrite(b, "update orders set note = 'b' where id = 7");

				// The merge a caller can legitimately assemble: B's batch (which carries
				// the LATER write) placed before A's.
				const merged = [...(await pull(b, receiver)), ...(await pull(a, receiver))];
				expectNotHLCOrdered(merged);
				await receiver.manager.applyChanges(merged);

				expect(await collect(receiver.db, 'select id, note from orders'))
					.to.deep.equal([{ id: 7, note: 'b' }]);
				const versions = await receiver.manager.columnVersions.getRowVersions('main', 'orders', [7]);
				expect(versions.get('note')!.value).to.equal('b');
			} finally {
				await closePeer(a);
				await closePeer(b);
				await closePeer(receiver);
			}
		});
	});

	// Schema migrations reach the store adapter as a plain array replayed in list order
	// too, and two migrations for ONE table are order-dependent — so the DDL list is
	// HLC-sorted for the same reason the data list is.
	describe('reversed schema migrations', () => {
		// Pre-fix: the reordered receiver ran `drop_table` first (a no-op — it had no
		// such table) and then `create_table`, ending with a table the origin had
		// already dropped.
		it('replays create_table then drop_table in HLC order, not arrival order', async () => {
			const origin = await makePeer('origin');
			const inOrder = await makePeer('in-order');
			const reordered = await makePeer('reordered');
			try {
				await localWrite(origin, 'create table widgets (id integer primary key, w text) using store');
				await localWrite(origin, 'drop table widgets');

				const sets = await origin.manager.getChangesSince(inOrder.manager.getSiteId());
				const migrationTypes = sets.flatMap(cs => cs.schemaMigrations).map(m => m.type);
				expect(migrationTypes).to.deep.equal(['create_table', 'drop_table']);

				await inOrder.manager.applyChanges(sets);
				await reordered.manager.applyChanges(
					[...(await origin.manager.getChangesSince(reordered.manager.getSiteId()))].reverse(),
				);

				expect(reordered.db.schemaManager.getTable('main', 'widgets')).to.equal(undefined);
				expect(inOrder.db.schemaManager.getTable('main', 'widgets')).to.equal(undefined);
			} finally {
				await closePeer(origin);
				await closePeer(inOrder);
				await closePeer(reordered);
			}
		});
	});

	// The drain path builds its store apply list the same way applyChanges does. Held
	// entries already come back HLC-ordered (`buildQuarantineKey` puts the HLC bytes
	// first), so this pins that contract rather than exercising a live inversion — the
	// reordering here is absorbed by the hold, not by the sort.
	describe('drain of held changes', () => {
		it('re-creates the row from a reordered batch that was quarantined first', async () => {
			const origin = await makeOriginWithRecreatedRow();
			// No `orders` locally, so every data change is diverted to quarantine.
			const receiver = await makePeer('receiver', { disposition: 'quarantine', config: RESURRECT });
			try {
				const reversed = [...(await pull(origin, receiver))].reverse();
				expectNotHLCOrdered(reversed);
				const result = await receiver.manager.applyChanges(reversed);
				expect(result.unknownTable).to.equal(flattenSets(reversed).length);

				await reviveOrders(receiver);
				expect(await receiver.manager.drainHeldChanges('main', 'orders'))
					.to.equal(flattenSets(reversed).length);

				expect(await collect(receiver.db, 'select id, note from orders'))
					.to.deep.equal([{ id: 1, note: 'y' }]);
				const versions = await receiver.manager.columnVersions.getRowVersions('main', 'orders', [1]);
				expect([...versions.keys()].sort()).to.deep.equal(['id', 'note']);
				expect(versions.get('note')!.value).to.equal('y');
			} finally {
				await closePeer(origin);
				await closePeer(receiver);
			}
		});
	});
});

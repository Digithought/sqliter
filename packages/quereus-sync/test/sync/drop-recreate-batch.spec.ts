/**
 * A batch that DROPS a table and RE-CREATES it under the same name must leave the
 * receiver holding the new incarnation's rows, in the table, in that same apply.
 *
 * The failure this pins: unknown-table detection used to reduce the batch's schema
 * steps to two order-blind sets (`created` / `dropped`) and call a table absent when it
 * appeared in both. A `create → drop → create` batch put the table in both sets, so
 * every row for it was diverted as "belongs to a table I do not have" — even though the
 * same batch's schema steps, replayed in timestamp order, leave the table present and
 * empty, ready for exactly those rows. With the default `quarantine` disposition the
 * rows were held and only surfaced on the next maintenance sweep (a convergence delay);
 * with `ignore` they were lost permanently. `change-applicator.ts` now derives one
 * per-table verdict from the schema steps' HLCs (`computeBatchTableFates`) and reads it
 * at all three sites: the row-admission gate, `freshLocalTable`, and the reactive drain.
 *
 * The `freshLocalTable` half of that verdict is deliberately narrow: read-free resolution
 * skips the LWW comparison, so it is reserved for the batch whose `drop_table` this
 * receiver actually applies. A re-delivered batch changes no local schema and must resolve
 * normally.
 *
 * Every spec here runs on real `Database` peers (`_peer-harness.ts`), so it asserts what
 * `select` returns, not what the metadata believes.
 */

import { expect } from 'chai';
import { type ChangeSet } from '../../src/sync/protocol.js';
import { compareHLC } from '../../src/clock/hlc.js';
import {
	closePeer,
	collect,
	localWrite,
	makePeer,
	relayAll,
	settle,
	type Peer,
} from './_peer-harness.js';

const WIDGETS_DDL = 'create table widgets (id integer primary key, w text) using store';

/** Guard a repro's premise: this array really is not in HLC order. */
function expectNotHLCOrdered(sets: ChangeSet[]): void {
	const hlcs = sets.flatMap(cs => [...cs.schemaMigrations.map(m => m.hlc), ...cs.changes.map(c => c.hlc)]);
	expect(hlcs.length).to.be.greaterThan(1);
	expect(hlcs.some((hlc, i) => i > 0 && compareHLC(hlcs[i - 1], hlc) > 0)).to.equal(true);
}

/**
 * Origin creates `widgets`, drops it, re-creates it, then inserts a row — four separate
 * local transactions, so a fresh receiver pulls all three schema steps AND the new
 * incarnation's row in ONE batch.
 */
async function makeOriginWithRecreatedTable(): Promise<Peer> {
	const origin = await makePeer('origin');
	await localWrite(origin, WIDGETS_DDL);
	await localWrite(origin, 'drop table widgets');
	await localWrite(origin, WIDGETS_DDL);
	await localWrite(origin, "insert into widgets (id, w) values (2, 'new')");
	return origin;
}

describe('drop + re-create in one batch', () => {
	it('lands the re-created table\'s rows in the same apply (quarantine default)', async () => {
		const origin = await makeOriginWithRecreatedTable();
		const receiver = await makePeer('receiver', { disposition: 'quarantine' });
		try {
			const sets = await origin.manager.getChangesSince(receiver.manager.getSiteId());
			// Premise: all three schema steps and the row travel together.
			expect(sets.flatMap(cs => cs.schemaMigrations).map(m => m.type))
				.to.deep.equal(['create_table', 'drop_table', 'create_table']);

			const result = await receiver.manager.applyChanges(sets);

			// Nothing diverted, and the row is queryable WITHOUT a drain.
			expect(result.unknownTable, 'no rows diverted as unknown-table').to.be.undefined;
			expect(await collect(receiver.db, 'select id, w from widgets'))
				.to.deep.equal([{ id: 2, w: 'new' }]);
			// Nothing was held, so an explicit drain has nothing left to do.
			expect(await receiver.manager.drainHeldChanges('main', 'widgets')).to.equal(0);
		} finally {
			await closePeer(origin);
			await closePeer(receiver);
		}
	});

	// The permanent-loss case: `ignore` holds nothing, so a diverted row never comes back.
	it('lands the rows under disposition `ignore` (nothing is held to recover from)', async () => {
		const origin = await makeOriginWithRecreatedTable();
		const receiver = await makePeer('receiver', { disposition: 'ignore' });
		try {
			const result = await receiver.manager.applyChanges(
				await origin.manager.getChangesSince(receiver.manager.getSiteId()),
			);

			expect(result.unknownTable).to.be.undefined;
			expect(await collect(receiver.db, 'select id, w from widgets'))
				.to.deep.equal([{ id: 2, w: 'new' }]);
		} finally {
			await closePeer(origin);
			await closePeer(receiver);
		}
	});

	// The verdict comes from the steps' HLCs, not their arrival position, so a reordered
	// batch must commit the same state (the sibling contract in
	// `apply-order-independence.spec.ts`).
	it('commits the same state when the batch arrives reversed', async () => {
		const origin = await makeOriginWithRecreatedTable();
		const inOrder = await makePeer('in-order');
		const reordered = await makePeer('reordered');
		try {
			await inOrder.manager.applyChanges(
				await origin.manager.getChangesSince(inOrder.manager.getSiteId()),
			);

			const reversed = [...(await origin.manager.getChangesSince(reordered.manager.getSiteId()))].reverse();
			expectNotHLCOrdered(reversed);
			const result = await reordered.manager.applyChanges(reversed);

			expect(result.unknownTable).to.be.undefined;
			expect(await collect(reordered.db, 'select id, w from widgets'))
				.to.deep.equal([{ id: 2, w: 'new' }]);
			expect(await collect(reordered.db, 'select id, w from widgets'))
				.to.deep.equal(await collect(inOrder.db, 'select id, w from widgets'));
		} finally {
			await closePeer(origin);
			await closePeer(inOrder);
			await closePeer(reordered);
		}
	});

	// The other half of the same rule: a TRAILING drop_table still hides the table, so
	// its rows divert exactly as before.
	it('a trailing drop_table still hides the table and diverts its rows', async () => {
		const origin = await makePeer('origin');
		const receiver = await makePeer('receiver', { disposition: 'quarantine' });
		try {
			await localWrite(origin, WIDGETS_DDL);
			await localWrite(origin, "insert into widgets (id, w) values (1, 'doomed')");
			await localWrite(origin, 'drop table widgets');

			const result = await receiver.manager.applyChanges(
				await origin.manager.getChangesSince(receiver.manager.getSiteId()),
			);

			expect(result.unknownTable, 'rows for the dropped table are diverted').to.be.greaterThan(0);
			expect(receiver.db.schemaManager.getTable('main', 'widgets')).to.equal(undefined);
			expect(await receiver.manager.quarantine.list('main', 'widgets')).to.have.lengthOf(result.unknownTable!);
		} finally {
			await closePeer(origin);
			await closePeer(receiver);
		}
	});

	// The reactive drain reads the same verdict: a drop+re-create batch leaves the table
	// PRESENT, so previously-held changes replay from inside `applyChanges` with no
	// explicit `drainHeldChanges` call (`drainOnReappear` defaults true).
	it('reactively drains changes held from an earlier batch', async () => {
		const holder = await makePeer('holder');
		const receiver = await makePeer('receiver', { disposition: 'quarantine' });
		try {
			// Round 1: `holder` has widgets and writes a row; `receiver` does not have the
			// table at all, so the row is quarantined.
			await localWrite(holder, WIDGETS_DDL);
			await localWrite(holder, "insert into widgets (id, w) values (5, 'held')");
			const firstSets = await holder.manager.getChangesSince(receiver.manager.getSiteId());
			const firstResult = await receiver.manager.applyChanges(
				// Strip the DDL so the table stays absent and the rows really are held.
				firstSets.map(cs => ({ ...cs, schemaMigrations: [] })),
			);
			expect(firstResult.unknownTable).to.be.greaterThan(0);
			const heldCount = (await receiver.manager.quarantine.list('main', 'widgets')).length;
			expect(heldCount).to.be.greaterThan(0);

			// Round 2: a second origin's batch drops and re-creates `widgets`. Nothing in
			// the batch touches pk 5, so the held row is the only thing that can fill it.
			const origin = await makePeer('origin');
			try {
				await localWrite(origin, WIDGETS_DDL);
				await localWrite(origin, 'drop table widgets');
				await localWrite(origin, WIDGETS_DDL);
				await receiver.manager.applyChanges(
					await origin.manager.getChangesSince(receiver.manager.getSiteId()),
				);
			} finally {
				await closePeer(origin);
			}
			await settle();

			// No explicit drain call: the held row is in the table and out of the hold.
			expect(await collect(receiver.db, 'select id, w from widgets'))
				.to.deep.equal([{ id: 5, w: 'held' }]);
			expect(await receiver.manager.quarantine.list('main', 'widgets')).to.have.lengthOf(0);
		} finally {
			await closePeer(holder);
			await closePeer(receiver);
		}
	});

	// A primary key REUSED across the two incarnations. The receiver holds the dropped
	// incarnation's row at that pk, so this pins both halves of "the rows land in the new
	// incarnation": the drop reclaims the old row (no phantom survivor) and the new
	// incarnation's write for the same pk lands, leaving the receiver equal to the origin.
	it('lands a row whose primary key existed in the dropped incarnation', async () => {
		const origin = await makePeer('origin');
		const receiver = await makePeer('receiver');
		try {
			await localWrite(origin, WIDGETS_DDL);
			await localWrite(origin, "insert into widgets (id, w) values (1, 'old')");
			await relayAll(origin, receiver);
			expect(await collect(receiver.db, 'select id, w from widgets'))
				.to.deep.equal([{ id: 1, w: 'old' }]);

			await localWrite(origin, 'drop table widgets');
			await localWrite(origin, WIDGETS_DDL);
			await localWrite(origin, "insert into widgets (id, w) values (1, 'new')");

			const result = await receiver.manager.applyChanges(
				await origin.manager.getChangesSince(receiver.manager.getSiteId()),
			);

			expect(result.unknownTable).to.be.undefined;
			expect(await collect(receiver.db, 'select id, w from widgets'))
				.to.deep.equal([{ id: 1, w: 'new' }]);
			expect(await collect(receiver.db, 'select id, w from widgets'))
				.to.deep.equal(await collect(origin.db, 'select id, w from widgets'));
		} finally {
			await closePeer(origin);
			await closePeer(receiver);
		}
	});

	// The other half of the `freshLocalTable` arm: read-free resolution skips the LWW
	// comparison entirely, so it must be reserved for the batch that actually PERFORMS the
	// re-create. A re-delivered batch's schema steps are all HLC-dominated and change no
	// local schema — the local table is already the post-re-create incarnation and its
	// metadata belongs to it, so the batch's rows have to lose to anything newer.
	// Re-application is a live path, not a hypothetical (see
	// `schema-replication-idempotency.spec.ts`: a peer re-applies the same batch on every
	// sync until its watermark advances).
	it('a re-delivered batch does not clobber a newer local write read-free', async () => {
		const origin = await makePeer('origin');
		const receiver = await makePeer('receiver');
		try {
			await localWrite(origin, WIDGETS_DDL);
			await localWrite(origin, 'drop table widgets');
			await localWrite(origin, WIDGETS_DDL);
			await localWrite(origin, "insert into widgets (id, w) values (1, 'origin')");

			const sets = await origin.manager.getChangesSince(receiver.manager.getSiteId());
			await receiver.manager.applyChanges(sets);
			expect(await collect(receiver.db, 'select id, w from widgets'))
				.to.deep.equal([{ id: 1, w: 'origin' }]);

			// A strictly newer local value for the same cell.
			await localWrite(receiver, "update widgets set w = 'newer' where id = 1");

			// The same batch again (a from-zero re-sync, or a duplicate relay hop).
			await receiver.manager.applyChanges(sets);
			expect(await collect(receiver.db, 'select id, w from widgets'))
				.to.deep.equal([{ id: 1, w: 'newer' }]);
		} finally {
			await closePeer(origin);
			await closePeer(receiver);
		}
	});

	// The `freshLocalTable` arm. Dropping a table does NOT purge its sync metadata, so a
	// receiver that already has `widgets` still holds the OLD incarnation's tombstone for
	// pk 1. The re-created table is a new, empty incarnation, so its rows must resolve
	// read-free — resolving them against that tombstone discards them silently under the
	// default `allowResurrection: false`.
	//
	// The tombstone is seeded by a LOCAL delete on the receiver, so the drop/re-create
	// batch carries no delete of its own and the stored tombstone is the only blocker in
	// play. An in-batch delete from the dropped incarnation is a separate, still-open
	// blocker, as is a tombstone whose drop/re-create landed in an EARLIER batch (this
	// arm is same-batch only) — both are
	// `bug-sync-recreated-table-inherits-dropped-table-metadata`.
	it('a stale tombstone from the dropped incarnation does not block the new one\'s row', async () => {
		const origin = await makePeer('origin');
		const receiver = await makePeer('receiver');
		try {
			// Round 1: the origin creates `widgets` and inserts pk 2; the receiver takes both,
			// so it HAS the table before the drop/re-create batch arrives.
			await localWrite(origin, WIDGETS_DDL);
			await localWrite(origin, "insert into widgets (id, w) values (2, 'other')");
			await relayAll(origin, receiver);
			expect(await collect(receiver.db, 'select id, w from widgets'))
				.to.deep.equal([{ id: 2, w: 'other' }]);

			// The receiver writes and deletes pk 1 locally, leaving itself a tombstone for
			// pk 1. The origin never touches pk 1 before the drop, so the round-2 batch
			// carries no delete — this stored tombstone is the only blocker under test.
			await localWrite(receiver, "insert into widgets (id, w) values (1, 'local')");
			await localWrite(receiver, 'delete from widgets where id = 1');
			expect(await receiver.manager.tombstones.getTombstone('main', 'widgets', [1]), 'stale tombstone seeded')
				.to.not.be.undefined;

			// Round 2: the origin drops and re-creates `widgets`, then inserts pk 1 into the
			// NEW incarnation. The receiver already HAS the table, so `!inBasis` is false and
			// only the `recreated` verdict can make this row resolve read-free.
			await localWrite(origin, 'drop table widgets');
			await localWrite(origin, WIDGETS_DDL);
			await localWrite(origin, "insert into widgets (id, w) values (1, 'reborn')");

			const result = await receiver.manager.applyChanges(
				await origin.manager.getChangesSince(receiver.manager.getSiteId()),
			);

			expect(result.unknownTable).to.be.undefined;
			expect(await collect(receiver.db, 'select id, w from widgets where id = 1'))
				.to.deep.equal([{ id: 1, w: 'reborn' }]);
		} finally {
			await closePeer(origin);
			await closePeer(receiver);
		}
	});

	it('a name RENAMED away and re-created in one batch resolves read-free too', async () => {
		// The rename arm of the same verdict: a `rename_table` VACATES the old name, so a
		// table CREATED under that name in the same batch is a fresh incarnation exactly
		// as after a `drop_table`. The metadata stranded under the name belongs to the
		// table that was renamed AWAY, so consulting it would let its tombstone discard
		// the new incarnation's row. Note the deciding step is the `create_table` — a
		// table that arrives under a name by being renamed INTO it brings its rows along
		// and is NOT fresh. (`computeBatchTableFates` in `change-applicator.ts`.)
		const origin = await makePeer('origin');
		const receiver = await makePeer('receiver');
		try {
			await localWrite(origin, WIDGETS_DDL);
			await localWrite(origin, "insert into widgets (id, w) values (2, 'other')");
			await relayAll(origin, receiver);

			await localWrite(receiver, "insert into widgets (id, w) values (1, 'local')");
			await localWrite(receiver, 'delete from widgets where id = 1');
			expect(await receiver.manager.tombstones.getTombstone('main', 'widgets', [1]), 'stale tombstone seeded')
				.to.not.be.undefined;

			// Rename `widgets` away, then create a NEW `widgets` and write pk 1 into it.
			await localWrite(origin, 'alter table widgets rename to widgets2');
			await localWrite(origin, WIDGETS_DDL);
			await localWrite(origin, "insert into widgets (id, w) values (1, 'reborn')");

			const result = await receiver.manager.applyChanges(
				await origin.manager.getChangesSince(receiver.manager.getSiteId()),
			);

			expect(result.unknownTable).to.be.undefined;
			expect(await collect(receiver.db, 'select id, w from widgets where id = 1'))
				.to.deep.equal([{ id: 1, w: 'reborn' }]);
			expect(receiver.db.schemaManager.getTable('main', 'widgets2'), 'the renamed-away table came across')
				.to.not.be.undefined;
		} finally {
			await closePeer(origin);
			await closePeer(receiver);
		}
	});
});

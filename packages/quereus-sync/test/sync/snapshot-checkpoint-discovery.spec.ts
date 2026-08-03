/**
 * Discovering an interrupted snapshot transfer.
 *
 * `getSnapshotCheckpoint(snapshotId)` can only be called by someone who already
 * knows the id — but the id only ever arrives in the snapshot's HEADER chunk, so
 * a client that restarted mid-transfer has forgotten it. `listSnapshotCheckpoints()`
 * is the discovery path: it answers "is there a partial transfer sitting here?"
 * without any prior knowledge.
 *
 * For that answer to be trustworthy, a checkpoint must exist for the WHOLE
 * duration of an apply. `applySnapshotStream` therefore saves one at header time,
 * immediately after `clearExistingMetadata` — previously the first save came from
 * `flushMetadataBatch` (every 1000 metadata entries), leaving a window in which
 * local metadata was already wiped and nothing recorded that a transfer was
 * underway. The converse must hold too: a snapshot REJECTED by the header gates
 * (wire format, clock drift) never touched local state, so it must leave no
 * checkpoint — otherwise every later connect would try to resume a transfer that
 * was never allowed to start.
 */

import { expect } from 'chai';
import type { ApplyToStoreCallback, SnapshotChunk, SnapshotHeaderChunk } from '../../src/sync/protocol.js';
import { SNAPSHOT_WIRE_FORMAT_VERSION } from '../../src/sync/protocol.js';
import { closePeer, collect, localWrite, makePeer, toStream, type Peer } from './_peer-harness.js';

const ROWS = 25;

const chunksOf = async (peer: Peer): Promise<SnapshotChunk[]> => {
	const chunks: SnapshotChunk[] = [];
	for await (const c of peer.manager.getSnapshotStream()) chunks.push(c);
	return chunks;
};

const headerOf = (chunks: SnapshotChunk[]): SnapshotHeaderChunk => {
	const header = chunks.find((c): c is SnapshotHeaderChunk => c.type === 'header');
	if (!header) throw new Error('sender stream has no header chunk');
	return header;
};

/** Create `table` and fill it with `rows` rows in one source transaction. */
async function seedTable(peer: Peer, table: string, rows: number): Promise<void> {
	await peer.db.exec(`create table ${table} (id integer primary key, v text) using store`);
	const values = Array.from({ length: rows }, (_, i) => `(${i + 1}, 'v${i + 1}')`).join(', ');
	await localWrite(peer, `insert into ${table} (id, v) values ${values}`);
}

/**
 * Yield ONLY the header, then drop the connection. This is the window the
 * header-time checkpoint save closes: local metadata has been cleared, but no
 * metadata batch has flushed, so no `flushMetadataBatch` checkpoint exists.
 */
async function* headerThenDrop(chunks: SnapshotChunk[]): AsyncIterable<SnapshotChunk> {
	yield headerOf(chunks);
	throw new Error('simulated connection drop right after the header');
}

/** Replace the header of a collected chunk array, leaving every other chunk alone. */
function withHeader(chunks: SnapshotChunk[], header: SnapshotHeaderChunk): SnapshotChunk[] {
	return chunks.map((c) => (c.type === 'header' ? header : c));
}

/** Run `apply` and return the rejection it produced, failing if it resolved. */
async function expectRejection(apply: Promise<void>, what: string): Promise<unknown> {
	let thrown: unknown;
	try {
		await apply;
	} catch (error) {
		thrown = error;
	}
	expect(thrown, `${what} surfaces as a rejection`).to.be.instanceOf(Error);
	return thrown;
}

describe('snapshot checkpoint discovery', () => {
	let sender: Peer;
	let receiver: Peer;

	beforeEach(async () => {
		sender = await makePeer('sender');
		receiver = await makePeer('receiver');
	});

	afterEach(async () => {
		await closePeer(sender);
		await closePeer(receiver);
	});

	it('a replica that never applied a snapshot has no checkpoints', async () => {
		expect(await receiver.manager.listSnapshotCheckpoints()).to.deep.equal([]);
	});

	it('an interruption before the first metadata flush still leaves a discoverable checkpoint', async () => {
		await seedTable(sender, 'big', ROWS);
		const chunks = await chunksOf(sender);
		const header = headerOf(chunks);

		await expectRejection(
			receiver.manager.applySnapshotStream(headerThenDrop(chunks)),
			'the dropped connection',
		);

		const checkpoints = await receiver.manager.listSnapshotCheckpoints();
		expect(checkpoints.length, 'the header-time save recorded the in-flight transfer').to.equal(1);
		expect(checkpoints[0].snapshotId, 'and it names the interrupted snapshot').to.equal(header.snapshotId);
		expect(checkpoints[0].completedTables, 'no table finished before the drop').to.deep.equal([]);

		// The discovered checkpoint is the one `getSnapshotCheckpoint` would return —
		// discovery and by-id lookup must agree, since a resume runs off the latter.
		const byId = await receiver.manager.getSnapshotCheckpoint(header.snapshotId);
		expect(byId?.snapshotId).to.equal(header.snapshotId);
	});

	it('a checkpoint discovered without its id resumes the transfer', async () => {
		await seedTable(sender, 'big', ROWS);
		const chunks = await chunksOf(sender);

		await expectRejection(
			receiver.manager.applySnapshotStream(headerThenDrop(chunks)),
			'the dropped connection',
		);

		// The whole point of discovery: the caller never saw the header, so this
		// checkpoint is its ONLY handle on the interrupted transfer.
		const [discovered] = await receiver.manager.listSnapshotCheckpoints();
		await receiver.manager.applySnapshotStream(sender.manager.resumeSnapshotStream(discovered));

		expect(Number((await collect(receiver.db, 'select count(*) as n from big'))[0].n)).to.equal(ROWS);
		expect(await receiver.manager.listSnapshotCheckpoints(), 'the resumed transfer cleared it').to.deep.equal([]);
	});

	it('a completed apply leaves no checkpoint', async () => {
		await seedTable(sender, 'big', ROWS);

		await receiver.manager.applySnapshotStream(toStream(await chunksOf(sender)));

		expect(await receiver.manager.listSnapshotCheckpoints(), 'the footer cleared the header-time save')
			.to.deep.equal([]);
	});

	it('a snapshot rejected for wire-format mismatch leaves no checkpoint', async () => {
		await seedTable(sender, 'big', ROWS);
		const chunks = await chunksOf(sender);
		const stale = withHeader(chunks, {
			...headerOf(chunks),
			snapshotFormat: SNAPSHOT_WIRE_FORMAT_VERSION + 1,
		});

		await expectRejection(receiver.manager.applySnapshotStream(toStream(stale)), 'the format gate');

		expect(await receiver.manager.listSnapshotCheckpoints(), 'a refused snapshot is not a partial transfer')
			.to.deep.equal([]);
	});

	it('a snapshot rejected for clock drift leaves no checkpoint', async () => {
		await seedTable(sender, 'big', ROWS);
		const chunks = await chunksOf(sender);
		const header = headerOf(chunks);
		// An hour ahead — far outside MAX_DRIFT_MS (1 minute).
		const farFuture = withHeader(chunks, {
			...header,
			hlc: { ...header.hlc, wallTime: BigInt(Date.now()) + 3_600_000n },
		});

		await expectRejection(receiver.manager.applySnapshotStream(toStream(farFuture)), 'the drift gate');

		expect(await receiver.manager.listSnapshotCheckpoints(), 'a refused snapshot is not a partial transfer')
			.to.deep.equal([]);
	});

	it('a failed bootstrap finalize keeps the checkpoint so the transfer retries', async () => {
		await seedTable(sender, 'big', ROWS);
		const chunks = await chunksOf(sender);
		const header = headerOf(chunks);

		// The footer issues `bootstrapFinalize` BEFORE clearing the checkpoint,
		// deliberately: rows are already durable, so a retry's finalize rebuilds
		// cleanly — but only if the checkpoint survived to point at the transfer.
		const internals = receiver.manager as unknown as { applyToStore?: ApplyToStoreCallback };
		const original = internals.applyToStore!;
		internals.applyToStore = async (dataChanges, schemaChanges, options) => {
			if (options.bootstrapFinalize) throw new Error('simulated finalize failure');
			return original(dataChanges, schemaChanges, options);
		};

		await expectRejection(receiver.manager.applySnapshotStream(toStream(chunks)), 'the finalize failure');

		const checkpoints = await receiver.manager.listSnapshotCheckpoints();
		expect(checkpoints.map((c) => c.snapshotId), 'the checkpoint outlived the failed finalize')
			.to.deep.equal([header.snapshotId]);
	});

	it('several abandoned transfers coexist, and a later apply\'s metadata clear spares them', async () => {
		await seedTable(sender, 'big', ROWS);

		const first = await chunksOf(sender);
		const second = await chunksOf(sender);
		expect(headerOf(second).snapshotId, 'each stream is its own transfer')
			.to.not.equal(headerOf(first).snapshotId);

		await expectRejection(receiver.manager.applySnapshotStream(headerThenDrop(first)), 'the first drop');
		await expectRejection(receiver.manager.applySnapshotStream(headerThenDrop(second)), 'the second drop');

		// The second apply ran `clearExistingMetadata` (which sweeps cv:/tb:/cl:) at its
		// header. If that sweep ever grew to include `sc:`, the FIRST checkpoint would be
		// gone here — deleting a resume position at the moment it is needed.
		const ids = (await receiver.manager.listSnapshotCheckpoints()).map((c) => c.snapshotId).sort();
		expect(ids, 'both abandoned transfers are listed; neither is deduplicated away')
			.to.deep.equal([headerOf(first).snapshotId, headerOf(second).snapshotId].sort());
	});

	it('clearSnapshotCheckpoint discards a transfer the caller will not resume', async () => {
		await seedTable(sender, 'big', ROWS);
		const chunks = await chunksOf(sender);

		await expectRejection(receiver.manager.applySnapshotStream(headerThenDrop(chunks)), 'the dropped connection');
		expect((await receiver.manager.listSnapshotCheckpoints()).length).to.equal(1);

		await receiver.manager.clearSnapshotCheckpoint(headerOf(chunks).snapshotId);

		expect(await receiver.manager.listSnapshotCheckpoints(), 'the abandoned transfer is gone')
			.to.deep.equal([]);
		expect(await receiver.manager.getSnapshotCheckpoint(headerOf(chunks).snapshotId)).to.equal(undefined);
	});
});

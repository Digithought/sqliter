/**
 * Regression tests for a quoted table name that legally contains a COLON
 * (`create table "a:b" (...)`).
 *
 * Every sync metadata key packs the table name into its key. Before every key
 * component was length-prefixed, the layout was `{schema}.{table}:…` and each
 * parser recovered the table by hunting for the first `.` and the first `:` —
 * so a colon in the table name landed the split in the wrong place. Two distinct
 * failures followed, both silent:
 *
 *  - `cv:` / `cl:` keys failed to parse at all, so the table's rows never
 *    replicated (`getChangesSince`, `getSnapshot`, `getSnapshotStream` all skip
 *    an unparseable record) AND were deleted locally on the next snapshot apply
 *    (`clearExistingMetadata` treats "unparseable" as "not on the preserve list").
 *  - `tb:` keys parsed CONFIDENTLY WRONG: a tombstone for `a:b` read back as a
 *    tombstone for a table named `a`, so a peer could be told to delete a row
 *    from the wrong table entirely.
 *
 * See ticket bug-sync-metadata-key-delimiters-ambiguous. Modelled on
 * `dotted-table-name.spec.ts`, which covers the same hazard for a dot.
 */

import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import { StoreModule, StoreEventEmitter, InMemoryKVStore } from '@quereus/store';
import { createStoreAdapter } from '../../src/sync/store-adapter.js';
import { SyncManagerImpl } from '../../src/sync/sync-manager-impl.js';
import { SyncEventEmitterImpl } from '../../src/sync/events.js';
import { DEFAULT_SYNC_CONFIG, SNAPSHOT_WIRE_FORMAT_VERSION } from '../../src/sync/protocol.js';
import type { SnapshotChunk } from '../../src/sync/protocol.js';
import { generateSiteId } from '../../src/clock/site.js';
import { HLCManager } from '../../src/clock/hlc.js';
import { buildColumnVersionKey, encodeRawPkIdentity, parseColumnVersionKey } from '../../src/metadata/keys.js';
import { serializeColumnVersion } from '../../src/metadata/column-version.js';
import { createInMemoryProvider, collect, makePeer, localWrite, relay, closePeer, settle } from './_peer-harness.js';

const COLON_DDL = 'create table "a:b" (id integer primary key, v text) using store';
/** The sibling a mis-parsed `a:b` key truncates to — same pk, so a stray delete would land. */
const SIBLING_DDL = 'create table a (id integer primary key, v text) using store';

describe('colon table name (quoted identifier containing a colon)', () => {
	it('a relayed insert reaches the peer, not silently dropped', async () => {
		const p1 = await makePeer('p1');
		const p2 = await makePeer('p2');
		try {
			await p1.db.exec(COLON_DDL);
			await p2.db.exec(COLON_DDL);

			await localWrite(p1, `insert into "a:b" values (1, 'x')`);
			const res = await relay(p1, p2);

			expect(res.applied, 'the colon-table change applied, not dropped').to.be.greaterThan(0);
			expect(await collect(p2.db, 'select id, v from "a:b"')).to.deep.equal([{ id: 1, v: 'x' }]);
		} finally {
			await closePeer(p1);
			await closePeer(p2);
		}
	});

	it('a delete removes only the "a:b" row, never the sibling table "a"', async () => {
		const p1 = await makePeer('p1');
		const p2 = await makePeer('p2');
		try {
			for (const p of [p1, p2]) {
				await p.db.exec(COLON_DDL);
				await p.db.exec(SIBLING_DDL);
			}

			await localWrite(p1, `insert into "a:b" values (1, 'colon')`);
			await localWrite(p1, `insert into a values (1, 'sibling')`);
			await relay(p1, p2);
			expect(await collect(p2.db, 'select v from "a:b"')).to.deep.equal([{ v: 'colon' }]);
			expect(await collect(p2.db, 'select v from a')).to.deep.equal([{ v: 'sibling' }]);

			await localWrite(p1, `delete from "a:b" where id = 1`);
			await relay(p1, p2);

			expect(await collect(p2.db, 'select v from "a:b"'), 'the colon table row is gone').to.deep.equal([]);
			expect(await collect(p2.db, 'select v from a'), 'the sibling table is untouched')
				.to.deep.equal([{ v: 'sibling' }]);
		} finally {
			await closePeer(p1);
			await closePeer(p2);
		}
	});

	it('getSnapshot() and getSnapshotStream() carry the full colon name, tombstones included', async () => {
		const p1 = await makePeer('p1');
		try {
			await p1.db.exec(COLON_DDL);
			await p1.db.exec(SIBLING_DDL);
			await localWrite(p1, `insert into "a:b" values (1, 'x'), (2, 'y')`);
			await localWrite(p1, `delete from "a:b" where id = 2`);

			const snapshot = await p1.manager.getSnapshot();
			const colonTable = snapshot.tables.find(t => t.table === 'a:b');
			void expect(colonTable, 'the colon table appears in the snapshot').to.exist;
			expect(colonTable!.schema).to.equal('main');
			expect(colonTable!.columnVersions.length, 'its cells travel').to.be.greaterThan(0);
			expect(snapshot.tombstones.filter(t => t.table === 'a:b'), 'its tombstone travels')
				.to.have.lengthOf(1);
			expect(snapshot.tombstones.filter(t => t.table === 'a'), 'no tombstone misattributed to "a"')
				.to.have.lengthOf(0);

			const chunks: SnapshotChunk[] = [];
			for await (const chunk of p1.manager.getSnapshotStream()) chunks.push(chunk);

			const tableNames = chunks
				.filter((c): c is Extract<SnapshotChunk, { type: 'table-start' }> => c.type === 'table-start')
				.map(c => c.table);
			expect(tableNames, 'the stream names the colon table').to.include('a:b');

			const tombstoneChunks = chunks
				.filter((c): c is Extract<SnapshotChunk, { type: 'tombstone' }> => c.type === 'tombstone');
			expect(tombstoneChunks.map(c => c.table), 'the tombstone chunk names "a:b", not "a"')
				.to.deep.equal(['a:b']);
		} finally {
			await closePeer(p1);
		}
	});

	it('a resumed snapshot apply preserves the completed colon table\'s local cells', async () => {
		// Mirrors dotted-table-name.spec.ts's resume test: the sender skips a table it
		// already streamed, so the receiver's up-front `clearExistingMetadata` must
		// recognise that table's own `cv:` keys and preserve them. An unparseable key
		// is "not on the preserve list" — i.e. deleted and never rewritten.
		const db = new Database();
		const { provider } = createInMemoryProvider();
		const events = new StoreEventEmitter();
		const storeModule = new StoreModule(provider, events);
		db.registerModule('store', storeModule);
		const applyToStore = createStoreAdapter({ db, storeModule, events });

		try {
			// tableB is re-streamed (it needs a real backing store); "a:b" is the
			// already-completed table the resumed stream never re-emits.
			await db.exec('create table tableB (id text primary key, v text) using store');

			const kv = new InMemoryKVStore();
			const syncManager = await SyncManagerImpl.create(
				kv, undefined, { ...DEFAULT_SYNC_CONFIG }, new SyncEventEmitterImpl(), applyToStore,
				(schemaName, tableName) => db.schemaManager.getTable(schemaName, tableName),
			);

			const remoteSiteId = generateSiteId();
			const remoteHLC = new HLCManager(remoteSiteId);
			const snapshotId = 'snap-resume-colon-1';

			// Seed via the key builder directly: "a:b" does not exist locally in this
			// test, so a store-level pk write (which resolves identity through the
			// schema oracle) would throw by design.
			await kv.put(
				buildColumnVersionKey('main', 'a:b', encodeRawPkIdentity(['a1']), 'v'),
				serializeColumnVersion({ hlc: remoteHLC.tick(), value: 'survives', pk: ['a1'] }),
			);

			const checkpoint = {
				snapshotId,
				siteId: remoteSiteId,
				hlc: remoteHLC.tick(),
				lastTableIndex: 1,
				lastEntryIndex: 1,
				completedTables: ['main.a:b'],
				entriesProcessed: 1,
				createdAt: 0,
			};
			const ckptJson = JSON.stringify({
				...checkpoint,
				hlc: {
					wallTime: checkpoint.hlc.wallTime.toString(),
					counter: checkpoint.hlc.counter,
					siteId: Array.from(checkpoint.hlc.siteId),
					opSeq: checkpoint.hlc.opSeq,
				},
				siteId: Array.from(checkpoint.siteId),
			});
			await kv.put(new TextEncoder().encode(`sc:${snapshotId}`), new TextEncoder().encode(ckptJson));

			const chunks: SnapshotChunk[] = [
				{ type: 'header', siteId: remoteSiteId, hlc: remoteHLC.tick(), snapshotFormat: SNAPSHOT_WIRE_FORMAT_VERSION, tableCount: 2, migrationCount: 0, snapshotId },
				{ type: 'table-start', schema: 'main', table: 'tableB', estimatedEntries: 1 },
				{
					type: 'column-versions', schema: 'main', table: 'tableB',
					entries: [{ column: 'v', hlc: remoteHLC.tick(), value: 'bval', pk: ['b1'] }],
				},
				{ type: 'table-end', schema: 'main', table: 'tableB', entriesWritten: 1 },
				{ type: 'footer', snapshotId, totalTables: 2, totalEntries: 1, totalMigrations: 0 },
			];
			async function* stream(): AsyncIterable<SnapshotChunk> {
				for (const c of chunks) yield c;
			}

			await syncManager.applySnapshotStream(stream());
			await settle();

			const survivors: string[] = [];
			for await (const entry of kv.iterate()) {
				const parsed = parseColumnVersionKey(entry.key);
				if (parsed?.table === 'a:b') survivors.push(parsed.column);
			}
			expect(survivors, 'the preserved table\'s cells were not wiped').to.deep.equal(['v']);
		} finally {
			await db.close();
			await provider.closeAll();
		}
	});
});

/**
 * Regression tests for `tableKey.split('.')` mis-routing a quoted identifier
 * that legally contains a dot (e.g. `create table "a.b" (...)`). A composite
 * `"<schema>.<table>"` grouping key was split back apart to recover the pair
 * instead of carrying the already-known `(schema, table)` forward — see
 * ticket bug-sync-tablekey-split-mis-routes-dotted-identifiers. Mirrors
 * `packages/quereus-store/test/rehydrate-catalog.spec.ts`'s dotted-name test.
 */

import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import { StoreModule, StoreEventEmitter, InMemoryKVStore } from '@quereus/store';
import { createStoreAdapter } from '../../src/sync/store-adapter.js';
import { SyncManagerImpl } from '../../src/sync/sync-manager-impl.js';
import { SyncEventEmitterImpl } from '../../src/sync/events.js';
import { DEFAULT_SYNC_CONFIG } from '../../src/sync/protocol.js';
import type { SnapshotChunk } from '../../src/sync/protocol.js';
import { generateSiteId } from '../../src/clock/site.js';
import { HLCManager } from '../../src/clock/hlc.js';
import { encodeRawPkIdentity, buildColumnVersionKey } from '../../src/metadata/keys.js';
import { serializeColumnVersion } from '../../src/metadata/column-version.js';
import { SNAPSHOT_WIRE_FORMAT_VERSION } from '../../src/sync/protocol.js';
import { createInMemoryProvider, collect, makePeer, localWrite, relay, closePeer, settle } from './_peer-harness.js';

const DOTTED_DDL = 'create table "a.b" (id integer primary key, v text) using store';

describe('dotted table name (quoted identifier containing a dot)', () => {
	it('store-adapter: relayed change applies to "a.b", not truncated to "a"', async () => {
		const p1 = await makePeer('p1');
		const p2 = await makePeer('p2');
		try {
			await p1.db.exec(DOTTED_DDL);
			await p2.db.exec(DOTTED_DDL);

			await localWrite(p1, `insert into "a.b" values (1, 'x')`);
			const res = await relay(p1, p2);

			expect(res.applied, 'the dotted-table change applied, not left unresolved').to.be.greaterThan(0);
			expect(await collect(p2.db, 'select id, v from "a.b"')).to.deep.equal([{ id: 1, v: 'x' }]);
		} finally {
			await closePeer(p1);
			await closePeer(p2);
		}
	});

	it('snapshot.ts getSnapshot(): table snapshot keeps the full dotted name, not truncated', async () => {
		const db = new Database();
		const { provider } = createInMemoryProvider();
		const events = new StoreEventEmitter();
		const storeModule = new StoreModule(provider, events);
		db.registerModule('store', storeModule);
		const applyToStore = createStoreAdapter({ db, storeModule, events });

		try {
			const syncManager = await SyncManagerImpl.create(
				new InMemoryKVStore(), db, { ...DEFAULT_SYNC_CONFIG }, new SyncEventEmitterImpl(), applyToStore,
				(schemaName, tableName) => db.schemaManager.getTable(schemaName, tableName),
			);

			await db.exec(DOTTED_DDL);
			await db.exec(`insert into "a.b" values (1, 'x')`);
			await settle();

			const snapshot = await syncManager.getSnapshot();
			expect(snapshot.tables).to.have.length(1);
			expect(snapshot.tables[0]).to.include({ schema: 'main', table: 'a.b' });
		} finally {
			await db.close();
			await provider.closeAll();
		}
	});

	it('snapshot-stream.ts streamSnapshotChunks(): chunks carry the full dotted table name', async () => {
		const db = new Database();
		const { provider } = createInMemoryProvider();
		const events = new StoreEventEmitter();
		const storeModule = new StoreModule(provider, events);
		db.registerModule('store', storeModule);
		const applyToStore = createStoreAdapter({ db, storeModule, events });

		try {
			const syncManager = await SyncManagerImpl.create(
				new InMemoryKVStore(), db, { ...DEFAULT_SYNC_CONFIG }, new SyncEventEmitterImpl(), applyToStore,
				(schemaName, tableName) => db.schemaManager.getTable(schemaName, tableName),
			);

			await db.exec(DOTTED_DDL);
			await db.exec(`insert into "a.b" values (1, 'x')`);
			await settle();

			const chunks: SnapshotChunk[] = [];
			for await (const chunk of syncManager.getSnapshotStream()) chunks.push(chunk);

			const tableStart = chunks.find(c => c.type === 'table-start');
			const columnVersions = chunks.find(c => c.type === 'column-versions');
			const tableEnd = chunks.find(c => c.type === 'table-end');

			void expect(tableStart, 'table-start chunk present').to.exist;
			void expect(columnVersions, 'column-versions chunk present').to.exist;
			void expect(tableEnd, 'table-end chunk present').to.exist;

			expect((tableStart as { table: string }).table).to.equal('a.b');
			expect((columnVersions as { table: string }).table).to.equal('a.b');
			expect((tableEnd as { table: string }).table).to.equal('a.b');
		} finally {
			await db.close();
			await provider.closeAll();
		}
	});

	describe('parseBootstrapTables(): resumed stream with a dotted completed-table name', () => {
		it('bootstrapFinalize coarse-notifies the correct dotted table, not a truncated one', async () => {
			const db = new Database();
			const { provider } = createInMemoryProvider();
			const events = new StoreEventEmitter();
			const storeModule = new StoreModule(provider, events);
			db.registerModule('store', storeModule);
			const applyToStore = createStoreAdapter({ db, storeModule, events });

			try {
				// tableB is re-streamed (needs a real backing store); "a.b" is the
				// already-completed dotted table the resumed stream skips entirely —
				// its (schema, table) pair only survives via the checkpoint's flat
				// `completedTables` string, exercising parseBootstrapTables directly.
				await db.exec('create table tableB (id text primary key, v text) using store');

				const notified: Array<{ table: string; schema?: string }> = [];
				const origNotify = db.notifyExternalChange.bind(db);
				db.notifyExternalChange = (table, schema) => {
					notified.push({ table, schema });
					return origNotify(table, schema);
				};

				const kv = new InMemoryKVStore();
				const syncManager = await SyncManagerImpl.create(
					kv, undefined, { ...DEFAULT_SYNC_CONFIG }, new SyncEventEmitterImpl(), applyToStore,
					(schemaName, tableName) => db.schemaManager.getTable(schemaName, tableName),
				);

				const remoteSiteId = generateSiteId();
				const remoteHLC = new HLCManager(remoteSiteId);
				const snapshotId = 'snap-resume-dotted-1';

				// Raw-key seed via the key builder directly: "a.b" does not exist locally
				// in this test (only its metadata survives via the checkpoint), so a
				// store-level pk-based write — which resolves the identity through the
				// schema oracle — would throw by design.
				await kv.put(
					buildColumnVersionKey('main', 'a.b', encodeRawPkIdentity(['a1']), 'v'),
					serializeColumnVersion({ hlc: remoteHLC.tick(), value: 'survives', pk: ['a1'] }),
				);
				const checkpoint = {
					snapshotId,
					siteId: remoteSiteId,
					hlc: remoteHLC.tick(),
					lastTableIndex: 1,
					lastEntryIndex: 1,
					completedTables: ['main.a.b'],
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

				// Before the fix: `'main.a.b'.split('.')` → schema='main', table='a' —
				// notifying the WRONG table ('a', which doesn't exist) instead of 'a.b'.
				expect(notified.map(n => n.table), 'the full dotted table name is notified').to.include('a.b');
				expect(notified.map(n => n.table), 'not truncated to the first segment after schema').to.not.include('a');
			} finally {
				await db.close();
				await provider.closeAll();
			}
		});
	});
});

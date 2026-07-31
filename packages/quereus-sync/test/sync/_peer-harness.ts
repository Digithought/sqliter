import { Database, type SqlValue } from '@quereus/quereus';
import { StoreModule, StoreEventEmitter, InMemoryKVStore, type KVStoreProvider } from '@quereus/store';
import { createStoreAdapter } from '../../src/sync/store-adapter.js';
import { SyncManagerImpl } from '../../src/sync/sync-manager-impl.js';
import { SyncEventEmitterImpl } from '../../src/sync/events.js';
import { type SiteId } from '../../src/clock/site.js';
import {
	DEFAULT_SYNC_CONFIG,
	type ApplyResult, type Change, type ChangeSet, type SnapshotChunk, type SyncConfig, type UnknownTableDisposition,
} from '../../src/sync/protocol.js';

export const COLUMNS_PER_FRESH_INSERT = 2;
export const DEFAULT_ORDERS_DDL = 'create table orders (id integer primary key, note text) using store';

export function createInMemoryProvider(): { provider: KVStoreProvider; stores: Map<string, InMemoryKVStore> } {
	const stores = new Map<string, InMemoryKVStore>();
	const get = (key: string): InMemoryKVStore => {
		let s = stores.get(key);
		if (!s) {
			s = new InMemoryKVStore();
			stores.set(key, s);
		}
		return s;
	};
	const provider: KVStoreProvider = {
		async getStore(s, t) { return get(`${s}.${t}`); },
		async getIndexStore(s, t, i) { return get(`${s}.${t}_idx_${i}`); },
		async getStatsStore(s, t) { return get(`${s}.${t}.__stats__`); },
		async getCatalogStore() { return get('__catalog__'); },
		async closeStore() {},
		async closeIndexStore() {},
		// A real provider reclaims a dropped table's physical storage. Without this the
		// module falls back to `closeStore` (a no-op here) and `getStore` hands the
		// re-created table the DROPPED incarnation's rows — so a drop/re-create spec
		// would silently test a table that is not actually empty.
		// Drop the map entry WITHOUT closing the handle (as
		// `quereus-store/test/coordinator-callback-leak.spec.ts`'s provider does): the
		// transaction coordinator keys buffered ops on the handle, and a drop in the same
		// transaction as a write to that table still replays them at commit.
		async deleteTableStores(s, t, indexNames) {
			stores.delete(`${s}.${t}`);
			stores.delete(`${s}.${t}.__stats__`);
			for (const i of indexNames) stores.delete(`${s}.${t}_idx_${i}`);
		},
		async closeAll() {
			for (const store of stores.values()) await store.close();
			stores.clear();
		},
	};
	return { provider, stores };
}

/** Replay a collected chunk array as the `AsyncIterable` `applySnapshotStream` consumes. */
export async function* toStream(chunks: SnapshotChunk[]): AsyncIterable<SnapshotChunk> {
	for (const c of chunks) yield c;
}

export async function collect(db: Database, sql: string): Promise<Record<string, SqlValue>[]> {
	const out: Record<string, SqlValue>[] = [];
	for await (const row of db.eval(sql)) out.push(row);
	return out;
}

/**
 * Local-change capture is anchored to the engine transaction boundary and runs
 * fire-and-forget *after* the commit, so this manual-relay harness must let the
 * capture settle before reading the change log.
 */
export const settle: () => Promise<void> = () => new Promise<void>(resolve => setTimeout(resolve, 25));

export interface Peer {
	readonly name: string;
	readonly db: Database;
	readonly provider: KVStoreProvider;
	readonly events: StoreEventEmitter;
	readonly storeModule: StoreModule;
	readonly manager: SyncManagerImpl;
}

/**
 * Build a real-engine peer. `createOrders` creates the `orders` base table with
 * `ordersDdl` (defaults to DEFAULT_ORDERS_DDL). `disposition` overrides
 * `unknownTableDisposition` in the SyncConfig; `config` overrides any other
 * SyncConfig fields (e.g. `allowResurrection`).
 */
export async function makePeer(
	name: string,
	opts?: {
		createOrders?: boolean;
		disposition?: UnknownTableDisposition;
		ordersDdl?: string;
		config?: Partial<SyncConfig>;
	},
): Promise<Peer> {
	const { provider } = createInMemoryProvider();
	const events = new StoreEventEmitter();
	const db = new Database();
	const storeModule = new StoreModule(provider, events);
	db.registerModule('store', storeModule);
	const applyToStore = createStoreAdapter({ db, storeModule, events });

	const config: SyncConfig = {
		...DEFAULT_SYNC_CONFIG,
		...(opts?.disposition ? { unknownTableDisposition: opts.disposition } : {}),
		...opts?.config,
	};

	const manager = await SyncManagerImpl.create(
		new InMemoryKVStore(),
		db,
		config,
		new SyncEventEmitterImpl(),
		applyToStore,
		(schemaName, tableName) => db.schemaManager.getTable(schemaName, tableName),
		undefined,
		db.getKeyNormalizerResolver(),
	);

	// Forward a logical `apply schema` lens deployment to the basis-table lifecycle
	// recorder exactly as production does (worker wiring), so the lens-redeploy
	// revival path drives `recordLensDeployment` end-to-end. Harmless to the data-only
	// tests: they never run `apply schema`, so this never fires.
	storeModule.setLensDeploymentListener((listenerDb, logicalSchemaName, snapshot) =>
		manager.recordLensDeployment(listenerDb, logicalSchemaName, snapshot));

	if (opts?.createOrders) {
		await db.exec(opts.ordersDdl ?? DEFAULT_ORDERS_DDL);
	}

	return { name, db, provider, events, storeModule, manager };
}

export async function closePeer(peer: Peer): Promise<void> {
	await peer.db.close();
	await peer.provider.closeAll();
}

export async function localWrite(peer: Peer, sql: string): Promise<void> {
	await peer.db.exec(sql);
	await settle();
}

/**
 * One-directional full DATA relay (from-zero, schema migrations stripped).
 * Returns the full ApplyResult so callers can inspect `.applied` or other fields.
 *
 * Schema migrations are stripped because these peers are built by
 * {@link makePeer} with `createOrders`, so BOTH already have `orders` — the
 * data-focused specs care about row convergence, not about re-running the DDL
 * they already ran. Use {@link relayAll} when the schema migrations themselves
 * are the subject under test.
 */
export const relay = (from: Peer, to: Peer): Promise<ApplyResult> =>
	relayWith(from, to, sets => sets.map(cs => ({ ...cs, schemaMigrations: [] })));

/**
 * One-directional FULL relay — identical to {@link relay} but keeps each
 * ChangeSet's `schemaMigrations`, so replicated DDL actually reaches the
 * receiver's `applyToStore`. This is the wire shape a real transport carries;
 * `relay`'s stripping is a test-only narrowing.
 */
export const relayAll = (from: Peer, to: Peer): Promise<ApplyResult> =>
	relayWith(from, to, sets => sets);

/** Shared relay body: settle, pull from-zero, apply the shaped sets, advance the watermark. */
async function relayWith(
	from: Peer,
	to: Peer,
	shape: (sets: ChangeSet[]) => ChangeSet[],
): Promise<ApplyResult> {
	await settle();
	const sets = await from.manager.getChangesSince(to.manager.getSiteId());
	const res = await to.manager.applyChanges(shape(sets));
	await settle();
	await to.manager.updatePeerSyncState(from.manager.getSiteId(), from.manager.getCurrentHLC());
	return res;
}

/** Flatten a peer's relayable log, excluding the given siteId. Settles before reading. */
export async function changesFor(peer: Peer, excludeSiteId: SiteId): Promise<Change[]> {
	await settle();
	const sets = await peer.manager.getChangesSince(excludeSiteId);
	return sets.flatMap(cs => [...cs.changes]);
}

export const flattenSets = (sets: ChangeSet[]): Change[] => sets.flatMap(cs => [...cs.changes]);
export const hasOrders = (changes: Change[]): boolean => changes.some(c => c.table === 'orders');

/**
 * Re-create the `orders` base table on a peer that had it retired.
 * The live basis oracle flips `orders` back into basis the instant the table exists.
 */
export async function reviveOrders(peer: Peer, ddl: string = DEFAULT_ORDERS_DDL): Promise<void> {
	await peer.db.exec(ddl);
	await settle();
}

/**
 * Deploy the `app` logical lens that maps `orders` onto the (sole physical) `main`
 * basis. `apply schema app` is the firing transaction: it drives
 * `notifyLensDeploymentAll` → `StoreModule.notifyLensDeployment` →
 * `manager.recordLensDeployment`, fully awaited (including any reactive drain), so
 * `select … from orders` still resolves to the physical `main.orders`, not the
 * logical `app.orders` view.
 */
export async function deployOrdersLens(peer: Peer): Promise<void> {
	await peer.db.exec('declare logical schema app { table orders { id integer primary key, note text } }');
	await peer.db.exec('apply schema app');
	await settle();
}

/**
 * Retire `orders` on a holder via an empty-lens redeploy.
 *
 * Ordering is load-bearing: the physical `drop table orders` MUST precede the empty
 * `declare logical schema app { }` redeploy. Dropping first takes `orders` out of
 * basis, so the empty redeploy classifies it `detached` (out of basis AND unmapped) —
 * the precondition the revive's `detached → present` reactive drain depends on. If the
 * empty lens were redeployed while `orders` was still present, it would classify
 * `unreferenced` (in basis, unmapped), and the later revive would transition
 * `unreferenced → directly-mapped` — NOT `detached → present` — so no reactive drain
 * would fire and the test would silently prove nothing.
 */
export async function retireOrdersViaRedeploy(peer: Peer): Promise<void> {
	await peer.db.exec('drop table orders');
	await peer.db.exec('declare logical schema app { }');
	await peer.db.exec('apply schema app');
	await settle();
}

/**
 * Bring `orders` back on a holder: re-create the store-backed basis table (so the live
 * basis oracle flips it back into basis), then re-map it via {@link deployOrdersLens}.
 * The `apply schema app` inside the lens deploy is the trigger under test — it fires
 * the reactive `detached → present` drain WITHOUT any explicit `drainHeldChanges` call.
 * `ddl` overrides the basis column set (the schema-drift case re-creates without `memo`).
 */
export async function reviveOrdersViaRedeploy(peer: Peer, ddl: string = DEFAULT_ORDERS_DDL): Promise<void> {
	await peer.db.exec(ddl);
	await deployOrdersLens(peer);
}

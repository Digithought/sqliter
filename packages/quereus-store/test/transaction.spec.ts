/**
 * Tests for TransactionCoordinator.
 *
 * The coordinator is module-wide: one instance is shared by every table of a
 * storage module, and every op is addressed by its explicit target store handle
 * (data ops included — there is no longer a default-store bucket). A single
 * commit therefore writes EVERY touched store of EVERY table in one atomic batch
 * (when the provider exposes one), giving cross-table all-or-nothing commit.
 */

import { expect } from 'chai';
import { TransactionCoordinator, type PendingStoreOps } from '../src/common/transaction.js';
import { StoreEventEmitter, type DataChangeEvent } from '../src/common/events.js';
import { InMemoryKVStore } from '../src/common/memory-store.js';
import type { AtomicBatch, KVStore } from '../src/common/kv-store.js';
import { bytesToHex, compareBytes } from '../src/common/bytes.js';

/** A shared-domain in-memory AtomicBatch factory with spies (module-scope so the
 *  atomic-path and cross-table describes can both use it). `InMemoryKVStore`
 *  cannot crash, so "atomic" is modeled trivially (buffer ops keyed by store
 *  handle, apply on write); the spies let the coordinator's atomic-path routing
 *  be asserted deterministically. */
interface AtomicSpy {
	factory: () => AtomicBatch | undefined;
	beginCalls: number;
	writeCalls: number;
	/** When false, the factory yields undefined → coordinator falls back. */
	yieldBatch: boolean;
	/** When true, the produced batch's write() rejects. */
	failWrite: boolean;
	/** Every store handle passed to put/delete (to assert per-store routing). */
	storeHandles: KVStore[];
}

function makeAtomicSpy(): AtomicSpy {
	const spy: AtomicSpy = {
		factory: () => undefined,
		beginCalls: 0,
		writeCalls: 0,
		yieldBatch: true,
		failWrite: false,
		storeHandles: [],
	};
	spy.factory = () => {
		spy.beginCalls++;
		if (!spy.yieldBatch) return undefined;
		const ops: Array<{ type: 'put' | 'delete'; store: KVStore; key: Uint8Array; value?: Uint8Array }> = [];
		return {
			put(store, key, value) {
				spy.storeHandles.push(store);
				ops.push({ type: 'put', store, key, value });
			},
			delete(store, key) {
				spy.storeHandles.push(store);
				ops.push({ type: 'delete', store, key });
			},
			async write() {
				spy.writeCalls++;
				if (spy.failWrite) throw new Error('atomic write failed');
				for (const op of ops) {
					if (op.type === 'put') {
						await op.store.put(op.key, op.value!);
					} else {
						await op.store.delete(op.key);
					}
				}
				ops.length = 0;
			},
			clear() {
				ops.length = 0;
			},
		};
	};
	return spy;
}

/** Monkey-patch a store's batch() to count fallback-path invocations. */
function spyBatch(target: InMemoryKVStore): () => number {
	const orig = target.batch.bind(target);
	let n = 0;
	target.batch = () => { n++; return orig(); };
	return () => n;
}

/** Run `fn` with console.warn captured; returns the first warning, or null. */
function captureWarn(fn: () => void): string | null {
	const original = console.warn;
	let captured: string | null = null;
	console.warn = (...args: unknown[]) => { if (captured === null) captured = args.map(String).join(' '); };
	try {
		fn();
	} finally {
		console.warn = original;
	}
	return captured;
}

describe('TransactionCoordinator', () => {
	let store: InMemoryKVStore;
	let emitter: StoreEventEmitter;
	let coordinator: TransactionCoordinator;

	beforeEach(() => {
		store = new InMemoryKVStore();
		emitter = new StoreEventEmitter();
		coordinator = new TransactionCoordinator(emitter);
	});

	afterEach(async () => {
		await store.close();
	});

	describe('begin / isInTransaction', () => {
		it('starts not in transaction', () => {
			expect(coordinator.isInTransaction()).to.be.false;
		});

		it('enters transaction after begin', () => {
			coordinator.begin();
			expect(coordinator.isInTransaction()).to.be.true;
		});

		it('begin is idempotent when already in transaction', () => {
			coordinator.begin();
			coordinator.begin(); // no-op
			expect(coordinator.isInTransaction()).to.be.true;
		});
	});

	describe('put / delete outside transaction', () => {
		it('throws when put called outside transaction', () => {
			expect(() => coordinator.put(new Uint8Array([1]), new Uint8Array([2]), store)).to.throw(/outside transaction/i);
		});

		it('throws when delete called outside transaction', () => {
			expect(() => coordinator.delete(new Uint8Array([1]), store)).to.throw(/outside transaction/i);
		});
	});

	describe('commit', () => {
		it('writes pending operations to the store', async () => {
			coordinator.begin();
			coordinator.put(new Uint8Array([1]), new Uint8Array([10]), store);
			coordinator.put(new Uint8Array([2]), new Uint8Array([20]), store);
			await coordinator.commit();

			expect(await store.get(new Uint8Array([1]))).to.deep.equal(new Uint8Array([10]));
			expect(await store.get(new Uint8Array([2]))).to.deep.equal(new Uint8Array([20]));
			expect(coordinator.isInTransaction()).to.be.false;
		});

		it('fires pending events on commit', async () => {
			const events: DataChangeEvent[] = [];
			emitter.onDataChange(e => events.push(e));

			coordinator.begin();
			coordinator.queueEvent({ type: 'insert', schemaName: 'main', tableName: 't' });
			coordinator.queueEvent({ type: 'update', schemaName: 'main', tableName: 't' });
			expect(events).to.have.length(0);
			await coordinator.commit();
			expect(events).to.have.length(2);
		});

		it('commit when not in transaction is a no-op', async () => {
			await coordinator.commit(); // should not throw
		});

		it('notifies callbacks on commit', async () => {
			let committed = false;
			coordinator.registerCallbacks({ onCommit: () => { committed = true; }, onRollback: () => {} });
			coordinator.begin();
			await coordinator.commit();
			expect(committed).to.be.true;
		});
	});

	describe('rollback', () => {
		it('discards pending operations', async () => {
			coordinator.begin();
			coordinator.put(new Uint8Array([1]), new Uint8Array([10]), store);
			coordinator.rollback();

			expect(await store.get(new Uint8Array([1]))).to.be.undefined;
			expect(coordinator.isInTransaction()).to.be.false;
		});

		it('discards pending events', () => {
			const events: DataChangeEvent[] = [];
			emitter.onDataChange(e => events.push(e));

			coordinator.begin();
			coordinator.queueEvent({ type: 'insert', schemaName: 'main', tableName: 't' });
			coordinator.rollback();
			expect(events).to.have.length(0);
		});

		it('rollback when not in transaction is a no-op', () => {
			coordinator.rollback(); // should not throw
		});

		it('notifies callbacks on rollback', () => {
			let rolledBack = false;
			coordinator.registerCallbacks({ onCommit: () => {}, onRollback: () => { rolledBack = true; } });
			coordinator.begin();
			coordinator.rollback();
			expect(rolledBack).to.be.true;
		});
	});

	describe('callback disposer (hard-eviction deregistration)', () => {
		// The coordinator is module-wide and never prunes on its own; a hard table
		// eviction (drop / recreate / rename) must run its disposer or the pair —
		// and the StoreTable its closures capture — stays pinned for the module's
		// lifetime. registerCallbacks returns that disposer.
		it('registerCallbacks returns a disposer that removes exactly that pair', () => {
			const base = coordinator.callbackCount;
			const dispose = coordinator.registerCallbacks({ onCommit: () => {}, onRollback: () => {} });
			expect(coordinator.callbackCount).to.equal(base + 1);
			dispose();
			expect(coordinator.callbackCount).to.equal(base);
		});

		it('double-dispose is a no-op (does not splice an unrelated pair)', () => {
			const base = coordinator.callbackCount;
			coordinator.registerCallbacks({ onCommit: () => {}, onRollback: () => {} }); // survivor
			const dispose = coordinator.registerCallbacks({ onCommit: () => {}, onRollback: () => {} });
			dispose();
			dispose(); // second call must find nothing and leave the survivor intact
			expect(coordinator.callbackCount).to.equal(base + 1);
		});

		it('a disposed callback no longer fires on commit (only the survivor runs)', async () => {
			let survivorCommits = 0;
			let disposedCommits = 0;
			coordinator.registerCallbacks({ onCommit: () => { survivorCommits++; }, onRollback: () => {} });
			const dispose = coordinator.registerCallbacks({ onCommit: () => { disposedCommits++; }, onRollback: () => {} });
			dispose();

			coordinator.begin();
			await coordinator.commit();
			expect(survivorCommits).to.equal(1);
			expect(disposedCommits).to.equal(0);
		});

		it('a disposed callback no longer fires on rollback (only the survivor runs)', () => {
			let survivorRollbacks = 0;
			let disposedRollbacks = 0;
			coordinator.registerCallbacks({ onCommit: () => {}, onRollback: () => { survivorRollbacks++; } });
			const dispose = coordinator.registerCallbacks({ onCommit: () => {}, onRollback: () => { disposedRollbacks++; } });
			dispose();

			coordinator.begin();
			coordinator.rollback();
			expect(survivorRollbacks).to.equal(1);
			expect(disposedRollbacks).to.equal(0);
		});

		it('callbackCount returns to baseline after N register→dispose cycles (no O(N) growth)', () => {
			const base = coordinator.callbackCount;
			// Two long-lived "tables" plus repeated drop/recreate churn of a third.
			coordinator.registerCallbacks({ onCommit: () => {}, onRollback: () => {} });
			coordinator.registerCallbacks({ onCommit: () => {}, onRollback: () => {} });
			for (let i = 0; i < 50; i++) {
				const dispose = coordinator.registerCallbacks({ onCommit: () => {}, onRollback: () => {} });
				dispose(); // hard eviction each cycle
			}
			// O(live tables) == base + 2, not base + 52.
			expect(coordinator.callbackCount).to.equal(base + 2);
		});
	});

	describe('queueEvent outside transaction', () => {
		it('emits immediately when not in transaction', () => {
			const events: DataChangeEvent[] = [];
			emitter.onDataChange(e => events.push(e));
			coordinator.queueEvent({ type: 'insert', schemaName: 'main', tableName: 't' });
			expect(events).to.have.length(1);
		});
	});

	describe('savepoints', () => {
		it('creates and releases savepoint', async () => {
			coordinator.begin();
			coordinator.put(new Uint8Array([1]), new Uint8Array([10]), store);
			coordinator.createSavepoint(0);
			coordinator.put(new Uint8Array([2]), new Uint8Array([20]), store);
			coordinator.releaseSavepoint(0);
			await coordinator.commit();

			expect(await store.get(new Uint8Array([1]))).to.deep.equal(new Uint8Array([10]));
			expect(await store.get(new Uint8Array([2]))).to.deep.equal(new Uint8Array([20]));
		});

		it('rollback to savepoint discards ops after savepoint', async () => {
			coordinator.begin();
			coordinator.put(new Uint8Array([1]), new Uint8Array([10]), store);
			coordinator.createSavepoint(0);
			coordinator.put(new Uint8Array([2]), new Uint8Array([20]), store);
			coordinator.rollbackToSavepoint(0);
			await coordinator.commit();

			expect(await store.get(new Uint8Array([1]))).to.deep.equal(new Uint8Array([10]));
			expect(await store.get(new Uint8Array([2]))).to.be.undefined;
		});

		it('rollback to savepoint also discards queued events', async () => {
			const events: DataChangeEvent[] = [];
			emitter.onDataChange(e => events.push(e));

			coordinator.begin();
			coordinator.queueEvent({ type: 'insert', schemaName: 'main', tableName: 't' });
			coordinator.createSavepoint(0);
			coordinator.queueEvent({ type: 'update', schemaName: 'main', tableName: 't' });
			coordinator.rollbackToSavepoint(0);
			await coordinator.commit();

			expect(events).to.have.length(1);
			expect(events[0].type).to.equal('insert');
		});

		it('nested savepoints', async () => {
			coordinator.begin();
			coordinator.put(new Uint8Array([1]), new Uint8Array([10]), store);
			coordinator.createSavepoint(0);
			coordinator.put(new Uint8Array([2]), new Uint8Array([20]), store);
			coordinator.createSavepoint(1);
			coordinator.put(new Uint8Array([3]), new Uint8Array([30]), store);
			coordinator.rollbackToSavepoint(1);
			await coordinator.commit();

			expect(await store.get(new Uint8Array([1]))).to.deep.equal(new Uint8Array([10]));
			expect(await store.get(new Uint8Array([2]))).to.deep.equal(new Uint8Array([20]));
			expect(await store.get(new Uint8Array([3]))).to.be.undefined;
		});

		it('rollbackToSavepoint with invalid depth warns and returns (no throw)', () => {
			coordinator.begin();
			// Out-of-range depth within an active transaction: warn-and-return, matching memory.
			expect(() => coordinator.rollbackToSavepoint(5)).to.not.throw();
		});
	});

	describe('savepoint ops after a commit clear', () => {
		it('rollbackToSavepoint after commit does not throw', async () => {
			// Simulate a store DDL-commit clearing the stack: begin → createSavepoint → commit.
			coordinator.begin();
			coordinator.createSavepoint(0);
			await coordinator.commit(); // clears savepointStack via clearTransaction()

			// Engine still broadcasts rollback-to at depth 0 — must not throw.
			expect(() => coordinator.rollbackToSavepoint(0)).to.not.throw();
		});

		it('releaseSavepoint after commit does not pad the stack', async () => {
			coordinator.begin();
			coordinator.createSavepoint(0);
			await coordinator.commit(); // stack cleared

			// releaseSavepoint(1) on an empty stack would pad with undefined → guard must fire.
			expect(() => coordinator.releaseSavepoint(1)).to.not.throw();

			// Follow-up savepoint round-trip on the same coordinator must still work correctly.
			coordinator.begin();
			coordinator.createSavepoint(0);
			coordinator.put(new Uint8Array([1]), new Uint8Array([10]), store);
			coordinator.createSavepoint(1);
			coordinator.put(new Uint8Array([2]), new Uint8Array([20]), store);
			coordinator.rollbackToSavepoint(1);
			await coordinator.commit();
			expect(await store.get(new Uint8Array([1]))).to.deep.equal(new Uint8Array([10]));
			expect(await store.get(new Uint8Array([2]))).to.be.undefined;
		});

		it('in-transaction out-of-range rollbackToSavepoint also warns and returns', () => {
			// Depth uniformity: the guard fires regardless of whether the stack was
			// cleared by a commit or simply never reached that depth.
			coordinator.begin();
			coordinator.createSavepoint(0);
			expect(() => coordinator.rollbackToSavepoint(5)).to.not.throw();
		});
	});

	describe('multi-store operations', () => {
		let indexStore: InMemoryKVStore;

		beforeEach(() => {
			indexStore = new InMemoryKVStore();
		});

		afterEach(async () => {
			await indexStore.close();
		});

		it('commit writes to both stores, each in its own bucket', async () => {
			coordinator.begin();
			coordinator.put(new Uint8Array([1]), new Uint8Array([10]), store);
			coordinator.put(new Uint8Array([2]), new Uint8Array([20]), indexStore);
			await coordinator.commit();

			expect(await store.get(new Uint8Array([1]))).to.deep.equal(new Uint8Array([10]));
			expect(await indexStore.get(new Uint8Array([2]))).to.deep.equal(new Uint8Array([20]));
			// Ensure no cross-contamination
			expect(await store.get(new Uint8Array([2]))).to.be.undefined;
			expect(await indexStore.get(new Uint8Array([1]))).to.be.undefined;
		});

		it('rollback discards operations on all stores', async () => {
			coordinator.begin();
			coordinator.put(new Uint8Array([1]), new Uint8Array([10]), store);
			coordinator.put(new Uint8Array([2]), new Uint8Array([20]), indexStore);
			coordinator.rollback();

			expect(await store.get(new Uint8Array([1]))).to.be.undefined;
			expect(await indexStore.get(new Uint8Array([2]))).to.be.undefined;
		});

		it('delete targets the explicit store', async () => {
			// Pre-populate the index store
			await indexStore.put(new Uint8Array([5]), new Uint8Array([50]));

			coordinator.begin();
			coordinator.delete(new Uint8Array([5]), indexStore);
			await coordinator.commit();

			expect(await indexStore.get(new Uint8Array([5]))).to.be.undefined;
		});

		it('savepoint rollback discards multi-store ops after savepoint', async () => {
			coordinator.begin();
			coordinator.put(new Uint8Array([1]), new Uint8Array([10]), store);
			coordinator.put(new Uint8Array([2]), new Uint8Array([20]), indexStore);
			coordinator.createSavepoint(0);
			coordinator.put(new Uint8Array([3]), new Uint8Array([30]), store);
			coordinator.put(new Uint8Array([4]), new Uint8Array([40]), indexStore);
			coordinator.rollbackToSavepoint(0);
			await coordinator.commit();

			// Before savepoint: committed
			expect(await store.get(new Uint8Array([1]))).to.deep.equal(new Uint8Array([10]));
			expect(await indexStore.get(new Uint8Array([2]))).to.deep.equal(new Uint8Array([20]));
			// After savepoint: rolled back
			expect(await store.get(new Uint8Array([3]))).to.be.undefined;
			expect(await indexStore.get(new Uint8Array([4]))).to.be.undefined;
		});
	});

	describe('pending-op index (getPendingOpsForStore)', () => {
		/** A recorded op, mirroring what the coordinator buffers. */
		interface RefOp { type: 'put' | 'delete'; store: KVStore; key: Uint8Array; value?: Uint8Array }

		/**
		 * Reference implementation replicating the legacy full-array-scan
		 * semantics of getPendingOpsForStore, for equivalence checking.
		 */
		function referenceView(ops: RefOp[], target: KVStore): PendingStoreOps {
			const puts = new Map<string, { key: Uint8Array; value: Uint8Array }>();
			const deletes = new Set<string>();
			for (const op of ops) {
				if (op.store !== target) continue;
				const hex = bytesToHex(op.key);
				if (op.type === 'put') {
					puts.set(hex, { key: op.key, value: op.value! });
					deletes.delete(hex);
				} else {
					deletes.add(hex);
					puts.delete(hex);
				}
			}
			return { puts, deletes };
		}

		function expectViewsEqual(actual: PendingStoreOps, expected: PendingStoreOps): void {
			expect([...actual.deletes].sort()).to.deep.equal([...expected.deletes].sort());
			const actualPuts = [...actual.puts.entries()]
				.map(([hex, p]) => [hex, bytesToHex(p.value)])
				.sort((a, b) => a[0].localeCompare(b[0]));
			const expectedPuts = [...expected.puts.entries()]
				.map(([hex, p]) => [hex, bytesToHex(p.value)])
				.sort((a, b) => a[0].localeCompare(b[0]));
			expect(actualPuts).to.deep.equal(expectedPuts);
		}

		/** Deterministic PRNG (mulberry32) so the property run is reproducible. */
		function mulberry32(seed: number): () => number {
			let a = seed >>> 0;
			return () => {
				a = (a + 0x6d2b79f5) >>> 0;
				let t = a;
				t = Math.imul(t ^ (t >>> 15), t | 1);
				t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
				return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
			};
		}

		it('matches legacy array-scan semantics over random op sequences', () => {
			const rand = mulberry32(0xc0ffee);
			const idx1 = new InMemoryKVStore();
			const idx2 = new InMemoryKVStore();
			// Three explicit stores in one op log — the coordinator must bucket each
			// by its own handle (there is no longer any default/role addressing).
			const stores = [store, idx1, idx2];

			for (let round = 0; round < 50; round++) {
				const ops: RefOp[] = [];
				coordinator.begin();
				for (let i = 0; i < 40; i++) {
					const key = new Uint8Array([Math.floor(rand() * 8)]);
					const isPut = rand() < 0.6;
					const target = stores[Math.floor(rand() * stores.length)];
					if (isPut) {
						const value = new Uint8Array([Math.floor(rand() * 256)]);
						coordinator.put(key, value, target);
						ops.push({ type: 'put', store: target, key, value });
					} else {
						coordinator.delete(key, target);
						ops.push({ type: 'delete', store: target, key });
					}
				}

				for (const target of stores) {
					expectViewsEqual(
						coordinator.getPendingOpsForStore(target),
						referenceView(ops, target),
					);
				}
				coordinator.rollback();
			}
		});

		it('last-write-wins: put then delete then put on the same key', () => {
			const key = new Uint8Array([7]);
			coordinator.begin();
			coordinator.put(key, new Uint8Array([1]), store);
			coordinator.delete(key, store);
			let view = coordinator.getPendingOpsForStore(store);
			expect(view.deletes.has(bytesToHex(key))).to.be.true;
			expect(view.puts.has(bytesToHex(key))).to.be.false;

			coordinator.put(key, new Uint8Array([2]), store);
			view = coordinator.getPendingOpsForStore(store);
			expect(view.deletes.has(bytesToHex(key))).to.be.false;
			expect(view.puts.get(bytesToHex(key))!.value).to.deep.equal(new Uint8Array([2]));
		});

		it('clears on commit and rollback', async () => {
			coordinator.begin();
			coordinator.put(new Uint8Array([1]), new Uint8Array([10]), store);
			await coordinator.commit();
			expect(coordinator.getPendingOpsForStore(store).puts.size).to.equal(0);

			coordinator.begin();
			coordinator.delete(new Uint8Array([1]), store);
			coordinator.rollback();
			expect(coordinator.getPendingOpsForStore(store).deletes.size).to.equal(0);
		});

		it('rollback-to-savepoint rebuild equals a from-scratch replay', () => {
			const k1 = new Uint8Array([1]);
			const k2 = new Uint8Array([2]);
			coordinator.begin();
			coordinator.put(k1, new Uint8Array([10]), store);
			coordinator.delete(k2, store);
			coordinator.createSavepoint(0);
			coordinator.put(k1, new Uint8Array([99]), store); // overwrite
			coordinator.put(k2, new Uint8Array([20]), store); // un-deletes k2
			coordinator.rollbackToSavepoint(0);

			// State must equal the pre-savepoint log replayed from scratch.
			const view = coordinator.getPendingOpsForStore(store);
			expect(view.puts.get(bytesToHex(k1))!.value).to.deep.equal(new Uint8Array([10]));
			expect(view.puts.has(bytesToHex(k2))).to.be.false;
			expect(view.deletes.has(bytesToHex(k2))).to.be.true;

			// And the index must keep tracking ops queued after the rollback-to.
			coordinator.put(k2, new Uint8Array([21]), store);
			const after = coordinator.getPendingOpsForStore(store);
			expect(after.puts.get(bytesToHex(k2))!.value).to.deep.equal(new Uint8Array([21]));
			expect(after.deletes.has(bytesToHex(k2))).to.be.false;
		});

		it('savepoint rebuild restores per-store separation', () => {
			const idx = new InMemoryKVStore();
			const key = new Uint8Array([5]);
			coordinator.begin();
			coordinator.put(key, new Uint8Array([1]), idx);
			coordinator.createSavepoint(0);
			coordinator.put(key, new Uint8Array([2]), store); // other store, same key bytes
			coordinator.rollbackToSavepoint(0);

			expect(coordinator.getPendingOpsForStore(store).puts.size).to.equal(0);
			expect(coordinator.getPendingOpsForStore(idx).puts.get(bytesToHex(key))!.value)
				.to.deep.equal(new Uint8Array([1]));
		});
	});

	describe('getOrderedPendingOps', () => {
		it('returns puts sorted ascending by key bytes plus the delete set', () => {
			coordinator.begin();
			coordinator.put(new Uint8Array([3, 1]), new Uint8Array([30]), store);
			coordinator.put(new Uint8Array([1]), new Uint8Array([10]), store);
			coordinator.put(new Uint8Array([2, 0xff]), new Uint8Array([20]), store);
			coordinator.delete(new Uint8Array([9]), store);

			const ordered = coordinator.getOrderedPendingOps(store);
			const keys = ordered.puts.map(p => Array.from(p.key));
			expect(keys).to.deep.equal([[1], [2, 0xff], [3, 1]]);
			for (let i = 1; i < ordered.puts.length; i++) {
				expect(compareBytes(ordered.puts[i - 1].key, ordered.puts[i].key)).to.be.lessThan(0);
			}
			expect(ordered.deletes.has(bytesToHex(new Uint8Array([9])))).to.be.true;
		});

		it('returns an empty view when there are no ops for the store', () => {
			coordinator.begin();
			const ordered = coordinator.getOrderedPendingOps(store);
			expect(ordered.puts).to.have.length(0);
			expect(ordered.deletes.size).to.equal(0);
		});

		it('buckets two stores separately', () => {
			const idx = new InMemoryKVStore();
			coordinator.begin();
			coordinator.put(new Uint8Array([1]), new Uint8Array([10]), store);
			coordinator.put(new Uint8Array([2]), new Uint8Array([20]), idx);
			expect(coordinator.getOrderedPendingOps(store).puts).to.have.length(1);
			expect(coordinator.getOrderedPendingOps(idx).puts).to.have.length(1);
			// Each store sees only its own op.
			expect(coordinator.getOrderedPendingOps(store).puts[0].value).to.deep.equal(new Uint8Array([10]));
			expect(coordinator.getOrderedPendingOps(idx).puts[0].value).to.deep.equal(new Uint8Array([20]));
		});

		it('returns a stable snapshot unaffected by later coordinator mutations', () => {
			// Merge scans hold the view across awaits where pipelined DML can queue
			// further ops — those must not bleed into an in-flight scan's view.
			coordinator.begin();
			coordinator.put(new Uint8Array([1]), new Uint8Array([10]), store);
			coordinator.delete(new Uint8Array([2]), store);

			const view = coordinator.getOrderedPendingOps(store);
			coordinator.put(new Uint8Array([3]), new Uint8Array([30]), store);
			coordinator.delete(new Uint8Array([4]), store);
			coordinator.put(new Uint8Array([2]), new Uint8Array([20]), store); // un-deletes 2

			expect(view.puts.map(p => Array.from(p.key))).to.deep.equal([[1]]);
			expect([...view.deletes]).to.deep.equal([bytesToHex(new Uint8Array([2]))]);
		});
	});

	describe('atomic batch path', () => {
		it('routes through the atomic batch when the factory yields one (data + index together)', async () => {
			const spy = makeAtomicSpy();
			const idx = new InMemoryKVStore();
			const dataBatchCount = spyBatch(store);
			const idxBatchCount = spyBatch(idx);
			const coord = new TransactionCoordinator(emitter, spy.factory);

			coord.begin();
			coord.put(new Uint8Array([1]), new Uint8Array([10]), store);    // data store
			coord.put(new Uint8Array([2]), new Uint8Array([20]), idx);      // index store
			await coord.commit();

			// One atomic commit, no per-store batch() fallback.
			expect(spy.beginCalls).to.equal(1);
			expect(spy.writeCalls).to.equal(1);
			expect(dataBatchCount()).to.equal(0);
			expect(idxBatchCount()).to.equal(0);
			// Data + index landed together.
			expect(await store.get(new Uint8Array([1]))).to.deep.equal(new Uint8Array([10]));
			expect(await idx.get(new Uint8Array([2]))).to.deep.equal(new Uint8Array([20]));
			await idx.close();
		});

		it('falls back to per-store batch() when the factory yields undefined', async () => {
			const spy = makeAtomicSpy();
			spy.yieldBatch = false;
			const idx = new InMemoryKVStore();
			const dataBatchCount = spyBatch(store);
			const idxBatchCount = spyBatch(idx);
			const coord = new TransactionCoordinator(emitter, spy.factory);

			coord.begin();
			coord.put(new Uint8Array([1]), new Uint8Array([10]), store);
			coord.put(new Uint8Array([2]), new Uint8Array([20]), idx);
			await coord.commit();

			expect(spy.beginCalls).to.equal(1);
			expect(spy.writeCalls).to.equal(0);
			expect(dataBatchCount()).to.equal(1);
			expect(idxBatchCount()).to.equal(1);
			expect(await store.get(new Uint8Array([1]))).to.deep.equal(new Uint8Array([10]));
			expect(await idx.get(new Uint8Array([2]))).to.deep.equal(new Uint8Array([20]));
			await idx.close();
		});

		it('byte-identical fallback when no factory is supplied at all', async () => {
			// The capability-absent default: a coordinator with no factory must
			// behave exactly as before (per-store batch loop).
			const idx = new InMemoryKVStore();
			const dataBatchCount = spyBatch(store);
			const coord = new TransactionCoordinator(emitter);

			coord.begin();
			coord.put(new Uint8Array([1]), new Uint8Array([10]), store);
			coord.put(new Uint8Array([2]), new Uint8Array([20]), idx);
			await coord.commit();

			expect(dataBatchCount()).to.equal(1);
			expect(await store.get(new Uint8Array([1]))).to.deep.equal(new Uint8Array([10]));
			expect(await idx.get(new Uint8Array([2]))).to.deep.equal(new Uint8Array([20]));
			await idx.close();
		});

		it('a rejected atomic write propagates, clears state, and leaks no ops', async () => {
			const spy = makeAtomicSpy();
			spy.failWrite = true;
			const coord = new TransactionCoordinator(emitter, spy.factory);

			coord.begin();
			coord.put(new Uint8Array([1]), new Uint8Array([10]), store);

			let err: unknown;
			try { await coord.commit(); } catch (e) { err = e; }
			expect(err).to.be.instanceOf(Error);
			expect((err as Error).message).to.match(/atomic write failed/);
			// finally { clearTransaction() } still ran.
			expect(coord.isInTransaction()).to.be.false;
			// write() threw before applying — nothing landed.
			expect(await store.get(new Uint8Array([1]))).to.be.undefined;

			// No ops leak into the next transaction; a now-succeeding write commits clean.
			spy.failWrite = false;
			coord.begin();
			coord.put(new Uint8Array([2]), new Uint8Array([20]), store);
			await coord.commit();
			expect(await store.get(new Uint8Array([1]))).to.be.undefined; // not resurrected
			expect(await store.get(new Uint8Array([2]))).to.deep.equal(new Uint8Array([20]));
		});

		it('fires pending events and commit callbacks on the atomic path', async () => {
			const spy = makeAtomicSpy();
			const events: DataChangeEvent[] = [];
			emitter.onDataChange(e => events.push(e));
			let committed = false;
			const coord = new TransactionCoordinator(emitter, spy.factory);
			coord.registerCallbacks({ onCommit: () => { committed = true; }, onRollback: () => {} });

			coord.begin();
			coord.put(new Uint8Array([1]), new Uint8Array([10]), store);
			coord.queueEvent({ type: 'insert', schemaName: 'main', tableName: 't' });
			await coord.commit();

			expect(spy.writeCalls).to.equal(1);
			expect(events).to.have.length(1);
			expect(committed).to.be.true;
		});

		it('routes a single-store bucket through one atomic batch', async () => {
			const spy = makeAtomicSpy();
			const coord = new TransactionCoordinator(emitter, spy.factory);
			coord.begin();
			coord.put(new Uint8Array([1]), new Uint8Array([10]), store);
			await coord.commit();
			expect(spy.writeCalls).to.equal(1);
			expect(await store.get(new Uint8Array([1]))).to.deep.equal(new Uint8Array([10]));
		});

		it('commit after rollback-to-savepoint writes exactly the surviving ops via the atomic batch', async () => {
			const spy = makeAtomicSpy();
			const idx = new InMemoryKVStore();
			const coord = new TransactionCoordinator(emitter, spy.factory);
			coord.begin();
			coord.put(new Uint8Array([1]), new Uint8Array([10]), store);
			coord.put(new Uint8Array([2]), new Uint8Array([20]), idx);
			coord.createSavepoint(0);
			coord.put(new Uint8Array([3]), new Uint8Array([30]), store);
			coord.put(new Uint8Array([4]), new Uint8Array([40]), idx);
			coord.rollbackToSavepoint(0);
			await coord.commit();

			expect(spy.writeCalls).to.equal(1);
			expect(await store.get(new Uint8Array([1]))).to.deep.equal(new Uint8Array([10]));
			expect(await idx.get(new Uint8Array([2]))).to.deep.equal(new Uint8Array([20]));
			expect(await store.get(new Uint8Array([3]))).to.be.undefined;
			expect(await idx.get(new Uint8Array([4]))).to.be.undefined;
			await idx.close();
		});

		it('opens no atomic batch for an empty transaction', async () => {
			const spy = makeAtomicSpy();
			const coord = new TransactionCoordinator(emitter, spy.factory);
			coord.begin();
			await coord.commit();
			expect(spy.beginCalls).to.equal(0);
			expect(spy.writeCalls).to.equal(0);
		});
	});

	describe('commit failure clears pending callback state (stats-delta leak fix)', () => {
		// Models a StoreTable's stats-callback pair: a delta accumulates during the
		// transaction (trackMutation with inTransaction=true), onCommit folds it into
		// the committed total and zeroes it, onRollback just discards it. The bug: a
		// commit that throws fired NEITHER callback, so `pendingDelta` survived
		// `clearTransaction()` and leaked into the next transaction on this module-wide
		// coordinator.
		function makeStatsTable() {
			const t = {
				pendingDelta: 0,
				committed: 0,
				onCommitCalls: 0,
				onRollbackCalls: 0,
				callbacks: {
					onCommit: () => { t.onCommitCalls++; t.committed += t.pendingDelta; t.pendingDelta = 0; },
					onRollback: () => { t.onRollbackCalls++; t.pendingDelta = 0; },
				},
			};
			return t;
		}

		it('atomic-path write failure fires onRollback (not onCommit) for every table and leaks no delta', async () => {
			const spy = makeAtomicSpy();
			spy.failWrite = true;
			const coord = new TransactionCoordinator(emitter, spy.factory);
			const a = makeStatsTable();
			const b = makeStatsTable();
			coord.registerCallbacks(a.callbacks);
			coord.registerCallbacks(b.callbacks);

			// Two tables mutate in one transaction, buffering their deltas.
			coord.begin();
			coord.put(new Uint8Array([1]), new Uint8Array([10]), store);
			a.pendingDelta = 3;
			b.pendingDelta = 5;

			let err: unknown;
			try { await coord.commit(); } catch (e) { err = e; }
			expect(err).to.be.instanceOf(Error);

			// onRollback fired for BOTH; onCommit for neither.
			expect(a.onCommitCalls).to.equal(0);
			expect(b.onCommitCalls).to.equal(0);
			expect(a.onRollbackCalls).to.equal(1);
			expect(b.onRollbackCalls).to.equal(1);
			// Deltas discarded — nothing survives clearTransaction().
			expect(a.pendingDelta).to.equal(0);
			expect(b.pendingDelta).to.equal(0);
			expect(a.committed).to.equal(0);
			expect(b.committed).to.equal(0);

			// The next transaction starts from the pre-failure baseline, not
			// baseline + leaked delta: a clean commit of +2 yields committed === 2,
			// not 3 + 2.
			spy.failWrite = false;
			coord.begin();
			coord.put(new Uint8Array([2]), new Uint8Array([20]), store);
			a.pendingDelta = 2;
			await coord.commit();
			expect(a.onCommitCalls).to.equal(1);
			expect(a.committed).to.equal(2);
		});

		it('fallback-path (no atomic factory) write failure also clears pending deltas', async () => {
			// A per-store batch whose write() rejects — the capability-absent commit path.
			const throwingStore = new InMemoryKVStore();
			throwingStore.batch = () => ({
				put() {}, delete() {}, clear() {},
				async write() { throw new Error('batch write failed'); },
			});
			const coord = new TransactionCoordinator(emitter); // no atomic factory → fallback loop
			const a = makeStatsTable();
			coord.registerCallbacks(a.callbacks);

			coord.begin();
			coord.put(new Uint8Array([1]), new Uint8Array([10]), throwingStore);
			a.pendingDelta = 7;

			let err: unknown;
			try { await coord.commit(); } catch (e) { err = e; }
			expect(err).to.be.instanceOf(Error);
			expect(a.onCommitCalls).to.equal(0);
			expect(a.onRollbackCalls).to.equal(1);
			expect(a.pendingDelta).to.equal(0);
			await throwingStore.close();
		});

		it('a clean commit fires onCommit only — the failure-path onRollback never runs', async () => {
			const spy = makeAtomicSpy();
			const coord = new TransactionCoordinator(emitter, spy.factory);
			const a = makeStatsTable();
			coord.registerCallbacks(a.callbacks);

			coord.begin();
			coord.put(new Uint8Array([1]), new Uint8Array([10]), store);
			a.pendingDelta = 4;
			await coord.commit();

			expect(a.onCommitCalls).to.equal(1);
			expect(a.onRollbackCalls).to.equal(0);
			expect(a.committed).to.equal(4);
		});
	});

	describe('cross-table atomicity', () => {
		// Two tables, each with a data store and a secondary-index store — four
		// distinct handles on ONE module coordinator. The headline guarantee: a
		// transaction touching both tables commits/rolls back as a single batch.
		it('commits two tables (data + index) in one atomic batch spanning all stores', async () => {
			const spy = makeAtomicSpy();
			const tADataC = spyBatch(store);             // table A data = `store`
			const tAIdx = new InMemoryKVStore();
			const tBData = new InMemoryKVStore();
			const tBIdx = new InMemoryKVStore();
			const coord = new TransactionCoordinator(emitter, spy.factory);

			coord.begin();
			coord.put(new Uint8Array([1]), new Uint8Array([10]), store);   // A data
			coord.put(new Uint8Array([2]), new Uint8Array([20]), tAIdx);   // A index
			coord.put(new Uint8Array([3]), new Uint8Array([30]), tBData);  // B data
			coord.put(new Uint8Array([4]), new Uint8Array([40]), tBIdx);   // B index
			await coord.commit();

			// One atomic batch carried every store; no per-store fallback.
			expect(spy.writeCalls).to.equal(1);
			expect(tADataC()).to.equal(0);
			expect(new Set(spy.storeHandles).size).to.equal(4);
			expect(new Set(spy.storeHandles)).to.deep.equal(new Set([store, tAIdx, tBData, tBIdx]));

			// All four stores landed together.
			expect(await store.get(new Uint8Array([1]))).to.deep.equal(new Uint8Array([10]));
			expect(await tAIdx.get(new Uint8Array([2]))).to.deep.equal(new Uint8Array([20]));
			expect(await tBData.get(new Uint8Array([3]))).to.deep.equal(new Uint8Array([30]));
			expect(await tBIdx.get(new Uint8Array([4]))).to.deep.equal(new Uint8Array([40]));

			await Promise.all([tAIdx.close(), tBData.close(), tBIdx.close()]);
		});

		it('a fault at write time leaves ALL tables unchanged (all-or-nothing)', async () => {
			const spy = makeAtomicSpy();
			spy.failWrite = true;
			const tBData = new InMemoryKVStore();
			const coord = new TransactionCoordinator(emitter, spy.factory);

			// Pre-seed both tables with committed state that must survive the failed commit.
			await store.put(new Uint8Array([0]), new Uint8Array([100]));
			await tBData.put(new Uint8Array([0]), new Uint8Array([200]));

			coord.begin();
			coord.put(new Uint8Array([1]), new Uint8Array([10]), store);
			coord.put(new Uint8Array([2]), new Uint8Array([20]), tBData);

			let err: unknown;
			try { await coord.commit(); } catch (e) { err = e; }
			expect(err).to.be.instanceOf(Error);
			expect(coord.isInTransaction()).to.be.false;

			// Neither table received any of the transaction's writes...
			expect(await store.get(new Uint8Array([1]))).to.be.undefined;
			expect(await tBData.get(new Uint8Array([2]))).to.be.undefined;
			// ...and pre-existing committed state on both tables is intact.
			expect(await store.get(new Uint8Array([0]))).to.deep.equal(new Uint8Array([100]));
			expect(await tBData.get(new Uint8Array([0]))).to.deep.equal(new Uint8Array([200]));

			await tBData.close();
		});

		it('without the atomic capability, each store gets its own batch (no worse than prior per-table commits)', async () => {
			const tBData = new InMemoryKVStore();
			const aBatchCount = spyBatch(store);
			const bBatchCount = spyBatch(tBData);
			const coord = new TransactionCoordinator(emitter); // no factory → fallback

			coord.begin();
			coord.put(new Uint8Array([1]), new Uint8Array([10]), store);
			coord.put(new Uint8Array([2]), new Uint8Array([20]), tBData);
			await coord.commit();

			// One batch per store (two stores → two batches).
			expect(aBatchCount()).to.equal(1);
			expect(bBatchCount()).to.equal(1);
			expect(await store.get(new Uint8Array([1]))).to.deep.equal(new Uint8Array([10]));
			expect(await tBData.get(new Uint8Array([2]))).to.deep.equal(new Uint8Array([20]));

			await tBData.close();
		});
	});

	describe('module-wide savepoints (idempotency)', () => {
		// With one shared coordinator, N connections (plus registerConnection's
		// savepoint replay) all push the SAME depth onto one stack. createSavepoint
		// must be depth-idempotent so a duplicate same-depth push is ignored.
		it('a duplicate createSavepoint at the same depth (registration replay) does not double-push', () => {
			coordinator.begin();
			coordinator.put(new Uint8Array([1]), new Uint8Array([10]), store);
			coordinator.createSavepoint(0);   // first connection: pushes depth 0
			coordinator.createSavepoint(0);   // registerConnection replay: must be a no-op

			// Only depth 0 exists: a rollback-to depth 1 is out of range and warns.
			// (Had the duplicate pushed a second entry, depth 1 would exist and not warn.)
			const warned = captureWarn(() => coordinator.rollbackToSavepoint(1));
			expect(warned).to.match(/out of range/i);

			coordinator.rollback();
		});

		it('a broadcast second savepoint to all connections records exactly one entry', () => {
			coordinator.begin();
			coordinator.createSavepoint(0);   // push depth 0 (length 1)
			coordinator.createSavepoint(1);   // push depth 1 (length 2)
			coordinator.createSavepoint(1);   // broadcast duplicate at depth 1: no-op

			// Depth 1 exists (no warn) but depth 2 does not (warn).
			expect(captureWarn(() => coordinator.rollbackToSavepoint(1))).to.equal(null);
			expect(captureWarn(() => coordinator.rollbackToSavepoint(2))).to.match(/out of range/i);

			coordinator.rollback();
		});

		it('rollbackToSavepoint after an idempotent savepoint undoes post-savepoint ops across both tables', async () => {
			const storeB = new InMemoryKVStore();

			coordinator.begin();
			coordinator.put(new Uint8Array([1]), new Uint8Array([10]), store);    // A pre-savepoint
			coordinator.put(new Uint8Array([1]), new Uint8Array([11]), storeB);   // B pre-savepoint
			coordinator.createSavepoint(0);   // first connection pushes
			coordinator.createSavepoint(0);   // second connection's replay: no-op
			coordinator.put(new Uint8Array([2]), new Uint8Array([20]), store);    // A post-savepoint
			coordinator.put(new Uint8Array([2]), new Uint8Array([21]), storeB);   // B post-savepoint
			coordinator.rollbackToSavepoint(0);
			await coordinator.commit();

			// Pre-savepoint writes survive on both tables...
			expect(await store.get(new Uint8Array([1]))).to.deep.equal(new Uint8Array([10]));
			expect(await storeB.get(new Uint8Array([1]))).to.deep.equal(new Uint8Array([11]));
			// ...post-savepoint writes are undone on both tables.
			expect(await store.get(new Uint8Array([2]))).to.be.undefined;
			expect(await storeB.get(new Uint8Array([2]))).to.be.undefined;

			await storeB.close();
		});
	});

	describe('idempotent commit / rollback ordering (sequential per-connection loop)', () => {
		// The engine commits each registered connection in turn. With a shared
		// coordinator the FIRST connection.commit() flushes everything; subsequent
		// commit()/rollback() calls on the same coordinator must no-op.
		it('a second commit after the first flushes nothing and does not throw', async () => {
			coordinator.begin();
			coordinator.put(new Uint8Array([1]), new Uint8Array([10]), store);
			await coordinator.commit();                  // first connection flushes
			expect(coordinator.isInTransaction()).to.be.false;

			await coordinator.commit();                  // second connection: no-op
			expect(await store.get(new Uint8Array([1]))).to.deep.equal(new Uint8Array([10]));
		});

		it('a rollback after a commit is a no-op (committed data survives)', async () => {
			coordinator.begin();
			coordinator.put(new Uint8Array([1]), new Uint8Array([10]), store);
			await coordinator.commit();

			coordinator.rollback();                      // not in transaction → no-op
			expect(await store.get(new Uint8Array([1]))).to.deep.equal(new Uint8Array([10]));
		});
	});
});

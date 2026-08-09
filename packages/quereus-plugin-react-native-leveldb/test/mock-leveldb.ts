/**
 * In-process stand-in for rn-leveldb, shared by every spec in this package.
 *
 * The real bindings are a native module that cannot load under Node, so the store's
 * behavior is pinned against this mock instead. It therefore has to be a FAITHFUL
 * LevelDB, not merely a convenient map — the shared conformance battery
 * (`test/conformance.spec.ts`) asserts byte ordering hard, and a mock defect and a
 * store defect look identical in the failure output. Specifically:
 *
 *   - keys are ordered by RAW LEXICOGRAPHIC BYTES (`compareBytes`), including the high
 *     bytes `0x80`-`0xff` and prefix-before-extension ([1] < [1,0]);
 *   - `seek(target)` lands on the first key `>= target`, `seekLast()` on the last key,
 *     and `prev()` off the front leaves the iterator INVALID (not wrapped);
 *   - the empty key is a real key, distinct from every other key;
 *   - `keyBuf()`/`valueBuf()` hand back FRESH buffers, as the native binding does, so a
 *     consumer scribbling on a yielded entry cannot corrupt stored data.
 *
 * The map is keyed by a latin1 string (one code unit per byte) rather than a joined
 * digit list: it is losslessly invertible for every byte value INCLUDING the empty key
 * (`''.split(',')` would decode to `[0]`), and its natural string order already matches
 * `compareBytes` — code-unit order equals byte order for 0x00-0xff, and a prefix sorts
 * before its extensions.
 *
 * An iterator is a SNAPSHOT taken at `newIterator()`, matching LevelDB's snapshot
 * semantics: writes committed after that point are invisible to the walk.
 */

import type {
	LevelDB,
	LevelDBIterator,
	LevelDBWriteBatch,
} from '../src/store.js';

/** Options for {@link MockLevelDB}. */
export interface MockLevelDBOptions {
	/**
	 * Called once per distinct entry the consumer touches through an iterator — the
	 * read meter the conformance suite's bounded-iteration tier needs. Positioning
	 * (`seek`, `seekLast`) does not itself count; reading a key or value at a position
	 * does, once per position however many times it is read there.
	 */
	onEntryRead?: () => void;
}

/** Compare two byte strings lexicographically — the LevelDB key order. */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
	const minLen = Math.min(a.length, b.length);
	for (let i = 0; i < minLen; i++) {
		if (a[i] !== b[i]) {
			return a[i] - b[i];
		}
	}
	return a.length - b.length;
}

/** Encode key bytes as a latin1 string — lossless, and string order matches byte order. */
function bytesToLatin1(bytes: Uint8Array): string {
	let out = '';
	for (let i = 0; i < bytes.length; i++) {
		out += String.fromCharCode(bytes[i]);
	}
	return out;
}

/** Inverse of {@link bytesToLatin1}. */
function latin1ToBytes(s: string): Uint8Array {
	const out = new Uint8Array(s.length);
	for (let i = 0; i < s.length; i++) {
		out[i] = s.charCodeAt(i) & 0xff;
	}
	return out;
}

/** Normalize rn-leveldb's `ArrayBuffer | string` key/value argument to bytes. */
function toBytes(value: ArrayBuffer | string): Uint8Array {
	return typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value);
}

/** Copy bytes into a standalone `ArrayBuffer`, as the native binding returns. */
function toFreshBuffer(bytes: Uint8Array): ArrayBuffer {
	const copy = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(copy).set(bytes);
	return copy;
}

/** A queued mock batch operation. */
type MockBatchOp =
	| { type: 'put'; key: Uint8Array; value: Uint8Array }
	| { type: 'del'; key: Uint8Array };

/**
 * Mock WriteBatch. Accumulates operations; {@link MockLevelDB.write} applies them.
 */
export class MockLevelDBWriteBatch implements LevelDBWriteBatch {
	private ops: MockBatchOp[] = [];

	put(key: ArrayBuffer | string, value: ArrayBuffer | string): void {
		this.ops.push({ type: 'put', key: toBytes(key), value: toBytes(value) });
	}

	delete(key: ArrayBuffer | string): void {
		this.ops.push({ type: 'del', key: toBytes(key) });
	}

	close(): void {
		this.ops = [];
	}

	/** Internal: the queued ops, in queue order. Read by {@link MockLevelDB.write}. */
	getOps(): readonly MockBatchOp[] {
		return this.ops;
	}
}

/**
 * Mock LevelDB database — synchronous, like rn-leveldb's real API.
 */
export class MockLevelDB implements LevelDB {
	private data = new Map<string, Uint8Array>();
	private closed = false;
	private readonly onEntryRead?: () => void;
	private readonly liveIterators = new Set<LevelDBIterator>();

	constructor(options?: MockLevelDBOptions) {
		this.onEntryRead = options?.onEntryRead;
	}

	/**
	 * Iterators handed out but not yet closed. A leaked native iterator is invisible to
	 * behavioral tests against a mock (nothing wedges), so this is how the store's
	 * release-on-early-termination is actually observed.
	 */
	openIteratorCount(): number {
		return this.liveIterators.size;
	}

	put(key: ArrayBuffer | string, value: ArrayBuffer | string): void {
		this.checkOpen();
		// Copy the value: the caller may reuse or mutate its buffer afterwards.
		this.data.set(bytesToLatin1(toBytes(key)), new Uint8Array(toBytes(value)));
	}

	getBuf(key: ArrayBuffer | string): ArrayBuffer | null {
		this.checkOpen();
		const value = this.data.get(bytesToLatin1(toBytes(key)));
		return value === undefined ? null : toFreshBuffer(value);
	}

	delete(key: ArrayBuffer | string): void {
		this.checkOpen();
		this.data.delete(bytesToLatin1(toBytes(key)));
	}

	write(batch: LevelDBWriteBatch): void {
		this.checkOpen();
		const mockBatch = batch as MockLevelDBWriteBatch;
		for (const op of mockBatch.getOps()) {
			if (op.type === 'put') {
				this.data.set(bytesToLatin1(op.key), new Uint8Array(op.value));
			} else {
				this.data.delete(bytesToLatin1(op.key));
			}
		}
	}

	close(): void {
		this.closed = true;
	}

	newIterator(): LevelDBIterator {
		this.checkOpen();
		const iterator = new MockLevelDBIterator(this.data, this.onEntryRead, () => {
			this.liveIterators.delete(iterator);
		});
		this.liveIterators.add(iterator);
		return iterator;
	}

	private checkOpen(): void {
		if (this.closed) {
			throw new Error('Database is closed');
		}
	}
}

/**
 * Mock iterator over a snapshot of the database, in `compareBytes` key order.
 */
class MockLevelDBIterator implements LevelDBIterator {
	private readonly entries: Array<{ key: Uint8Array; value: Uint8Array }>;
	private readonly onEntryRead?: () => void;
	private readonly onClose?: () => void;
	private index = -1;
	private closed = false;
	/** Position last counted against the read meter — so re-reading one entry counts once. */
	private countedIndex = -1;

	constructor(data: Map<string, Uint8Array>, onEntryRead?: () => void, onClose?: () => void) {
		this.onEntryRead = onEntryRead;
		this.onClose = onClose;
		this.entries = [...data].map(([keyStr, value]) => ({ key: latin1ToBytes(keyStr), value }));
		this.entries.sort((a, b) => compareBytes(a.key, b.key));
	}

	valid(): boolean {
		return !this.closed && this.index >= 0 && this.index < this.entries.length;
	}

	seek(target: ArrayBuffer | string): LevelDBIterator {
		this.checkOpen();
		const targetBytes = toBytes(target);
		const found = this.entries.findIndex((entry) => compareBytes(entry.key, targetBytes) >= 0);
		// Past the last key: an invalid position one past the end, as LevelDB reports.
		this.index = found === -1 ? this.entries.length : found;
		return this;
	}

	seekToFirst(): LevelDBIterator {
		this.checkOpen();
		this.index = this.entries.length > 0 ? 0 : -1;
		return this;
	}

	seekLast(): LevelDBIterator {
		this.checkOpen();
		this.index = this.entries.length > 0 ? this.entries.length - 1 : -1;
		return this;
	}

	next(): void {
		this.checkOpen();
		this.index++;
	}

	prev(): void {
		this.checkOpen();
		this.index--;
	}

	keyBuf(): ArrayBuffer {
		this.checkOpen();
		if (!this.valid()) throw new Error('Iterator not valid');
		this.meter();
		return toFreshBuffer(this.entries[this.index].key);
	}

	valueBuf(): ArrayBuffer {
		this.checkOpen();
		if (!this.valid()) throw new Error('Iterator not valid');
		this.meter();
		return toFreshBuffer(this.entries[this.index].value);
	}

	close(): void {
		this.closed = true;
		this.onClose?.();
	}

	/** Count this position once, however many of its buffers are read here. */
	private meter(): void {
		if (this.index !== this.countedIndex) {
			this.countedIndex = this.index;
			this.onEntryRead?.();
		}
	}

	private checkOpen(): void {
		if (this.closed) {
			throw new Error('Iterator is closed');
		}
	}
}

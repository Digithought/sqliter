import type { AnyVirtualTableModule, VtabConcurrencyMode } from './module.js';
import type { VirtualTableConnection } from './connection.js';

/**
 * Returns the module's declared concurrency mode, defaulting to `'serial'`
 * when the module does not declare one. Consumers in the parallel runtime
 * (e.g. fan-out lookup joins) call this before deciding whether to
 * serialize via `acquireConnectionLock` or to issue calls concurrently.
 */
export function getModuleConcurrencyMode(module: AnyVirtualTableModule): VtabConcurrencyMode {
	return module.concurrencyMode ?? 'serial';
}

/**
 * Whether the module declares that a `_readCommitted` connection serves a stable,
 * self-consistent snapshot of committed state for the life of the scan — the
 * precondition for running a read outside the execution mutex, concurrently with
 * another statement's virtual-table commit.
 *
 * Fails closed: an undeclared module (every module that predates the flag) reads
 * as `false` and keeps taking the serialized path. See
 * `VirtualTableModule.readCommittedSnapshot` for the obligation, and
 * `docs/module-authoring.md` § "Committed-Snapshot Reads (`_readCommitted`)".
 *
 * Deliberately NOT folded into {@link getModuleConcurrencyMode}: that answers a
 * per-connection reentrancy question, this one a cross-connection tearing question.
 */
export function getModuleReadCommittedSnapshot(module: AnyVirtualTableModule): boolean {
	return module.readCommittedSnapshot === true;
}

/**
 * Promise-chain tail per connection. The tail resolves when the current
 * critical section's release fires; subsequent acquirers await it and
 * chain a fresh promise on. WeakMap keyed by connection so a discarded
 * connection is GC-eligible without an explicit teardown.
 */
const connectionLockTails = new WeakMap<VirtualTableConnection, Promise<void>>();

/**
 * Cooperative per-connection mutex used by parallel runtime consumers to
 * serialize calls against a `'serial'` module when sibling branches share
 * a single connection.
 *
 * The lock is mode-agnostic — callers consult `getModuleConcurrencyMode`
 * first and only call this when serialization is required. Usage shape:
 *
 *   const release = await acquireConnectionLock(connection);
 *   try {
 *     for await (const row of vtab.query(filterInfo)) yield row;
 *   } finally {
 *     release();
 *   }
 *
 * Independent connections never block each other; the lock is keyed on
 * the connection identity.
 */
export async function acquireConnectionLock(
	connection: VirtualTableConnection,
): Promise<() => void> {
	const prevTail = connectionLockTails.get(connection);

	let release!: () => void;
	const nextTail = new Promise<void>((resolve) => {
		release = resolve;
	});
	connectionLockTails.set(connection, nextTail);

	if (prevTail !== undefined) {
		await prevTail;
	}
	return release;
}

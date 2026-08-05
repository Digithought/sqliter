import type { Database } from '../../core/database.js';
import type { VirtualTableConnection } from '../connection.js';

/** Handle returned by `CommittedReadConformanceOptions.stallCommit`. */
export interface CommitStallHandle {
	/**
	 * Optional. Resolves once a commit has actually ENTERED the stall. Supply it
	 * when your gate can tell — the conformance harness then waits for the writer
	 * to be provably parked before reading, instead of guessing with a settle
	 * window.
	 */
	readonly entered?: Promise<void>;
	/** Release the gate so the parked commit (and any later one) proceeds. Must be idempotent. */
	release(): void;
}

/**
 * A gate that parks the next virtual-table commit on a database, so a read can
 * be proven to overlap the commit's publish window.
 *
 * Built for {@link runCommittedReadConformance}'s `stallCommit` option — see
 * `docs/module-authoring.md` § "Committed-Snapshot Reads (`_readCommitted`)".
 */
export interface CommitStall {
	/** Arm the gate; the returned promise resolves when a commit ENTERS the stall. */
	arm(): Promise<void>;
	/** Release the gate (idempotent); the parked commit and any later one proceed. */
	release(): void;
	/** Arm the gate and wrap it as a `stallCommit` handle for the conformance harness. */
	asStallCommit(): CommitStallHandle;
}

/**
 * Installs a commit gate on `db` by wrapping every connection the database
 * registers, so the connection's `commit()` first awaits the gate. Disarmed
 * (the default), commits pass through untouched.
 *
 * Works for any module that registers its write connections with
 * `Database.registerConnection` — which a module must do for the engine to drive
 * its transactions, and which a wrapper module cannot intercept on the target's
 * behalf. A module that commits without ever registering needs its own stall;
 * pass whatever `stallCommit` you can build, or none at all (the conformance
 * harness then reports `observedCommitOverlap: false`).
 *
 * TEST SUPPORT ONLY: the patch is permanent for the life of `db` and there is no
 * uninstall. Use a database you own.
 */
export function installCommitStall(db: Database): CommitStall {
	let gate: Promise<void> | null = null;
	let releaseGate: (() => void) | null = null;
	let enteredResolve: (() => void) | null = null;

	const original = db.registerConnection.bind(db);
	(db as unknown as { registerConnection: typeof db.registerConnection }).registerConnection =
		async (conn: VirtualTableConnection) => {
			const realCommit = conn.commit.bind(conn);
			(conn as { commit: () => Promise<void> }).commit = async () => {
				if (gate) {
					enteredResolve?.();
					enteredResolve = null;
					await gate;
				}
				await realCommit();
			};
			return original(conn);
		};

	const stall: CommitStall = {
		arm() {
			// Re-arming must not orphan a commit already parked on the previous gate:
			// `release()` only resolves the CURRENT one, so an un-released predecessor
			// would hang forever.
			stall.release();
			const entered = new Promise<void>(resolve => {
				enteredResolve = resolve;
			});
			gate = new Promise<void>(resolve => {
				releaseGate = resolve;
			});
			return entered;
		},
		release() {
			gate = null;
			releaseGate?.();
			releaseGate = null;
			enteredResolve = null;
		},
		asStallCommit() {
			const entered = stall.arm();
			return { entered, release: () => stall.release() };
		},
	};
	return stall;
}

/**
 * Yield the event loop `macrotasks` times, so anything already pending has a fair
 * chance to run: a commit to reach the gate, or a read to settle. Used to pin
 * "this did NOT complete" without inventing a wall-clock timeout.
 *
 * `setTimeout` rather than `setImmediate` — the latter is Node-only.
 */
export async function settleMacrotasks(macrotasks = 20): Promise<void> {
	for (let i = 0; i < macrotasks; i++) {
		await new Promise<void>(resolve => setTimeout(resolve, 0));
	}
}

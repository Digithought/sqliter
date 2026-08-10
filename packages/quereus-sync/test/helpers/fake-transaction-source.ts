/**
 * Test double for the engine transaction-commit channel.
 *
 * The sync write side captures local changes from a {@link TransactionCommitSource}
 * — one grouped `onTransactionCommit` batch ⇒ one transaction ⇒ one HLC. In unit
 * tests we drive that channel directly instead of standing up a full engine: each
 * {@link FakeTransactionSource.commit} call delivers one committed transaction's
 * grouped events to the subscribed SyncManager, exactly as `flushBatch` would.
 *
 * The real engine grouping/projection is covered by
 * `packages/quereus/test/database-events.spec.ts`; the end-to-end real-`Database`
 * path is covered by `echo-loop-quiescence.spec.ts`.
 */

import type {
	TransactionCommitBatch,
	DatabaseDataChangeEvent,
	DatabaseSchemaChangeEvent,
} from '@quereus/quereus';
import type { TransactionCommitSource } from '../../src/create-sync-module.js';

/** Optional fields a test may omit; sensible local-DML defaults are filled in. */
type DataEventInput = Partial<DatabaseDataChangeEvent> &
	Pick<DatabaseDataChangeEvent, 'type' | 'schemaName' | 'tableName'>;
type SchemaEventInput = Partial<DatabaseSchemaChangeEvent> &
	Pick<DatabaseSchemaChangeEvent, 'type' | 'objectType' | 'schemaName' | 'objectName'>;

export class FakeTransactionSource implements TransactionCommitSource {
	private readonly listeners = new Set<(batch: TransactionCommitBatch) => void>();

	onTransactionCommit(listener: (batch: TransactionCommitBatch) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/**
	 * Deliver one committed transaction's grouped events to every subscriber.
	 * `data`/`schema` default to empty; each event defaults `moduleName: 'store'`
	 * and `remote: false` (local DML) so call sites stay terse.
	 */
	commit(batch: { data?: DataEventInput[]; schema?: SchemaEventInput[] }): void {
		const dataEvents = (batch.data ?? []).map(normalizeData);
		const schemaEvents = (batch.schema ?? []).map(normalizeSchema);
		const full: TransactionCommitBatch = { dataEvents, schemaEvents };
		for (const listener of this.listeners) listener(full);
	}

	/** Convenience: commit a single local data event as its own transaction. */
	commitData(event: DataEventInput): void {
		this.commit({ data: [event] });
	}

	/** Convenience: commit a single local schema event as its own transaction. */
	commitSchema(event: SchemaEventInput): void {
		this.commit({ schema: [event] });
	}
}

function normalizeData(e: DataEventInput): DatabaseDataChangeEvent {
	return { moduleName: 'store', remote: false, ...e };
}

function normalizeSchema(e: SchemaEventInput): DatabaseSchemaChangeEvent {
	return { moduleName: 'store', remote: false, ...e };
}

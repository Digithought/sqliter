import type { DatabaseSchemaChangeEvent } from '@quereus/quereus';

/**
 * Minimal structural view of the one primitive the listener calls. A real
 * SyncManager is structurally assignable to this interface.
 */
export interface LocalCreateDrainTarget {
	drainHeldChanges(schema?: string, table?: string): Promise<number>;
}

/**
 * Reports a failed eager drain. Advisory — the held entries stay for the
 * periodic sweep to pick up on the next interval.
 */
export type LocalCreateDrainLogger = (schema: string, table: string, error: unknown) => void;

/**
 * Build an onSchemaChange listener that eagerly replays a reappeared table's
 * held out-of-basis changes the moment the app locally re-creates it — as a
 * SEPARATE post-commit apply (the schema event fires after commit). Only a
 * local `create table` qualifies: remote create_table applies are drained
 * reactively inside the library (drainReappearedTables); alter/drop and
 * index/column events never revive a held table. Fire-and-forget: a drain
 * failure is logged, never re-thrown, so it can never surface as a failure of
 * the user's create table.
 */
export function createLocalCreateDrainListener(
	getTarget: () => LocalCreateDrainTarget | null,
	log: LocalCreateDrainLogger,
): (event: DatabaseSchemaChangeEvent) => void {
	return (event) => {
		if (event.type !== 'create' || event.objectType !== 'table' || event.remote) return;
		const target = getTarget();
		if (!target) return;
		void target
			.drainHeldChanges(event.schemaName, event.objectName)
			.catch((error) => log(event.schemaName, event.objectName, error));
	};
}

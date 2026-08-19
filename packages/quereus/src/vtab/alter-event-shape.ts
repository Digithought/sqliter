/**
 * The per-arm shape of an `ALTER TABLE` schema-change announcement, derived from the
 * {@link SchemaChangeInfo} the arm was called with. One derivation, shared by every
 * emitter-backed module, so a subscriber sees the same facts regardless of backend.
 */

import type { SchemaChangeInfo } from './module.js';
import type { VTableSchemaChangeEvent } from './events.js';

/** The fields of a schema-change event that an ALTER TABLE arm decides. */
export type AlterEventShape = Pick<
	VTableSchemaChangeEvent,
	'type' | 'objectType' | 'columnName' | 'oldColumnName'
>;

/**
 * Derive the `type` / `objectType` / column naming of an `ALTER TABLE` announcement:
 * `alter`/`column` naming the touched column for the column arms (`drop`/`column` for
 * DROP COLUMN), `alter`/`table` for the whole-table ones. Matches what the engine's own
 * no-emitter path reports for the same statements (`runtime/emit/alter-table.ts`) and
 * what `docs/usage.md` § What each `ALTER TABLE` arm reports promises.
 *
 * The caller supplies the rest of the event (`schemaName`, `objectName`, `ddl`) and owns
 * the emit-iff-`change.ddl` gate. `RENAME TO` is not an arm of this union — it goes
 * through `renameTable` and reports `alter`/`table` with `oldObjectName`.
 *
 * The `switch` is exhaustive over the union so a new arm fails the build here rather
 * than silently announcing the wrong shape.
 */
export function alterEventShape(change: SchemaChangeInfo): AlterEventShape {
	switch (change.type) {
		case 'addColumn':
			return { type: 'alter', objectType: 'column', columnName: change.columnDef.name };
		case 'dropColumn':
			return { type: 'drop', objectType: 'column', columnName: change.columnName };
		case 'renameColumn':
			return { type: 'alter', objectType: 'column', columnName: change.newName, oldColumnName: change.oldName };
		case 'alterColumn':
			return { type: 'alter', objectType: 'column', columnName: change.columnName };
		case 'alterPrimaryKey':
		case 'addConstraint':
		case 'dropConstraint':
		case 'renameConstraint':
			return { type: 'alter', objectType: 'table' };
	}
}

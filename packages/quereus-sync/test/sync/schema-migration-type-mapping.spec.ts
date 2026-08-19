/**
 * The full decision table of `mapSchemaMigrationType` — every
 * `(objectType, type)` combination the engine's schema channel can carry, plus the
 * `oldObjectName` discriminator that separates a `rename_table` from an ordinary
 * `alter_column`.
 *
 * The end-to-end specs (`schema-alter-replication.spec.ts`) prove the reachable
 * combinations replicate; this pins the mapping itself, including the two
 * combinations that are deliberately UNMAPPED. An unmapped combination makes the
 * caller record nothing and say nothing, which is exactly how column-shaped ALTER
 * events stopped reaching peers before — so the set of silent combinations belongs
 * in a test, not only in a comment.
 */

import { expect } from 'chai';
import type { DatabaseSchemaChangeEvent } from '@quereus/quereus';
import { mapSchemaMigrationType } from '../../src/sync/sync-manager-impl.js';
import type { SchemaMigrationType } from '../../src/sync/protocol.js';

function event(
	objectType: DatabaseSchemaChangeEvent['objectType'],
	type: DatabaseSchemaChangeEvent['type'],
	oldObjectName?: string,
): DatabaseSchemaChangeEvent {
	return {
		type,
		objectType,
		moduleName: 'store',
		schemaName: 'main',
		objectName: 'orders',
		oldObjectName,
		remote: false,
	};
}

/** `[objectType, type, oldObjectName, expected]` — `undefined` expected ⇒ deliberately untracked. */
const CASES: ReadonlyArray<[
	DatabaseSchemaChangeEvent['objectType'],
	DatabaseSchemaChangeEvent['type'],
	string | undefined,
	SchemaMigrationType | undefined,
]> = [
	['table', 'create', undefined, 'create_table'],
	['table', 'drop', undefined, 'drop_table'],
	['table', 'alter', undefined, 'alter_column'],
	['table', 'alter', 'orders_old', 'rename_table'],
	// Every column arm is a table-definition change replayed from the carried `ddl`.
	// `drop column` arrives as `drop`/`column` and must NOT become a `drop_table`.
	['column', 'alter', undefined, 'alter_column'],
	['column', 'drop', undefined, 'alter_column'],
	['index', 'create', undefined, 'add_index'],
	['index', 'drop', undefined, 'drop_index'],
	// Unreachable today (no emit site produces either), and untracked by design.
	// Should one become reachable, this is where the silence is visible.
	['column', 'create', undefined, undefined],
	['index', 'alter', undefined, undefined],
];

describe('mapSchemaMigrationType decision table', () => {
	for (const [objectType, type, oldObjectName, expected] of CASES) {
		const label = `${type}/${objectType}${oldObjectName ? ' (renamed)' : ''}`;
		it(`${label} → ${expected ?? 'untracked'}`, () => {
			expect(mapSchemaMigrationType(event(objectType, type, oldObjectName))).to.equal(expected);
		});
	}

	it('a rename discriminator on a column event does not turn it into a rename_table', () => {
		// `oldObjectName` is a RENAME TO field; a column event never sets it, but the
		// dispatch must not consult it outside the `table` branch either.
		expect(mapSchemaMigrationType(event('column', 'alter', 'orders_old'))).to.equal('alter_column');
	});
});

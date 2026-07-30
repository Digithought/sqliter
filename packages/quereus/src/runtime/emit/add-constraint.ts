import type { AddConstraintNode } from '../../planner/nodes/add-constraint-node.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { asRun } from '../types.js';
import type { EmissionContext } from '../emission-context.js';
import { QuereusError } from '../../common/errors.js';
import { SqlValue, StatusCode } from '../../common/types.js';
import { createLogger } from '../../common/logger.js';
import type { RowConstraintSchema, TableSchema } from '../../schema/table.js';
import { opsToMask, requireVtabModule } from '../../schema/table.js';
import { buildForeignKeyConstraintSchema, validateForeignKeyCollations } from '../../schema/constraint-builder.js';
import { assertDdlTransactionPolicy } from './ddl-transaction-policy.js';
import { emitAlterSchemaEvent } from './alter-schema-event.js';

const log = createLogger('runtime:emit:add-constraint');

export function emitAddConstraint(plan: AddConstraintNode, _ctx: EmissionContext): Instruction {
	const tableSchema = plan.table.tableSchema;

	async function run(rctx: RuntimeContext): Promise<SqlValue> {
		// Strict-policy gate (see ddl-transaction-policy.ts). ALTER TABLE ADD CONSTRAINT
		// is its own node but is a module-dispatching ALTER arm all the same, so gate it
		// before any dispatch or catalog mutation.
		assertDdlTransactionPolicy(
			rctx.db, requireVtabModule(tableSchema), tableSchema.vtabModuleName,
			`ALTER TABLE ${tableSchema.name} ADD CONSTRAINT`,
		);

		// Ensure we're in a transaction before DDL (lazy/JIT transaction start).
		await rctx.db._ensureTransaction();

		const constraint = plan.constraint;
		const schemaManager = rctx.db.schemaManager;
		const schema = schemaManager.getSchemaOrFail(tableSchema.schemaName);

		// A CHECK on a module without an `alterTable` hook stays engine-side (catalog
		// only — DROP/RENAME CONSTRAINT are unsupported on such a module anyway, so
		// there is no second copy to keep in sync). Every other case — including CHECK
		// on a module that DOES support `alterTable` — routes through the module so its
		// cached schema stays in lock-step with the catalog. Routing CHECK engine-side
		// while DROP/RENAME route through the module is exactly what stranded an
		// ALTER-added CHECK: the module never learned of it, so `resolveNamedConstraintClass`
		// against the module's stale schema reported it missing (and a later module-routed
		// ALTER returned a schema that silently dropped it from the catalog).
		if (constraint.type === 'check' && !tableSchema.vtabModule?.alterTable) {
			return runAddCheckEngineSide(rctx, tableSchema, schema, constraint);
		}

		return runAddConstraintViaModule(rctx, tableSchema, schema, constraint);
	}

	return {
		params: [],
		run: asRun(run),
		note: `addConstraint(${plan.table.tableSchema.name}, ${plan.constraint.name || 'unnamed'})`
	};
}

/**
 * Engine-side CHECK append for modules that do not implement `alterTable` (so the
 * CHECK can't route through the module). Mutates only the catalog's
 * `checkConstraints`. Modules that DO support `alterTable` take the module-routed
 * path instead (see {@link runAddConstraintViaModule}), keeping the module-cached
 * schema and the catalog consistent.
 */
async function runAddCheckEngineSide(
	rctx: RuntimeContext,
	tableSchema: TableSchema,
	schema: import('../../schema/schema.js').Schema,
	constraint: AddConstraintNode['constraint'],
): Promise<SqlValue> {
	if (!constraint.expr) {
		throw new QuereusError(
			'CHECK constraint requires an expression',
			StatusCode.ERROR
		);
	}

	// Note: We don't validate determinism here because constraints may reference NEW/OLD
	// which require special scoping. Determinism is validated at INSERT/UPDATE plan time
	// in constraint-builder.ts when the constraint is actually checked.
	const constraintSchema: RowConstraintSchema = {
		name: constraint.name || `check_${tableSchema.checkConstraints.length}`,
		expr: constraint.expr,
		operations: opsToMask(constraint.operations),
	};

	const updatedConstraints = [...tableSchema.checkConstraints, constraintSchema];
	const updatedTableSchema: TableSchema = {
		...tableSchema,
		checkConstraints: Object.freeze(updatedConstraints),
	};

	schema.addTable(updatedTableSchema);

	rctx.db.schemaManager.getChangeNotifier().notifyChange({
		type: 'table_modified',
		schemaName: tableSchema.schemaName,
		objectName: tableSchema.name,
		oldObject: tableSchema,
		newObject: updatedTableSchema
	});

	// A module with no `alterTable` hook is exactly the backend this fallback exists for, so
	// this path reports too — same `alter`/`table` shape as the module-routed one below.
	emitAlterSchemaEvent(rctx, tableSchema, {
		type: 'alter', objectType: 'table',
		objectName: tableSchema.name,
	});

	log('Added CHECK constraint %s to table %s.%s', constraintSchema.name, tableSchema.schemaName, tableSchema.name);

	return null;
}

async function runAddConstraintViaModule(
	rctx: RuntimeContext,
	tableSchema: TableSchema,
	schema: import('../../schema/schema.js').Schema,
	constraint: AddConstraintNode['constraint'],
): Promise<SqlValue> {
	const module = requireVtabModule(tableSchema);
	if (!module.alterTable) {
		throw new QuereusError(
			`Module for table '${tableSchema.name}' does not support ADD CONSTRAINT`,
			StatusCode.UNSUPPORTED,
		);
	}

	// Reject a newly-added FK whose child/parent column collations declare a same-rank
	// conflict BEFORE calling module.alterTable, so a rejected ALTER never reaches the
	// module's persistence side effects (the store backend updateSchema's + saveTableDDL's
	// inside alterTable; a post-call throw would leave the conflicting FK on disk, only to
	// rehydrate on the next reopen). The FK's child columns already exist on the prior
	// `tableSchema`, so resolution against it is well-defined — and we build the FK via the
	// same `buildForeignKeyConstraintSchema` + `columnIndexMap` the module uses, so the
	// pre-built FK's column indices are identical to the module-returned FK's. Only FK ADD
	// CONSTRAINT has a collation pairing (UNIQUE has none), so gate on the type. The
	// module-side `validateForeignKeyOverExistingRows` stays where it is — it needs a row
	// scan, this is a pure schema check. (The `foreign_keys` pragma does NOT gate this:
	// a conflicting-collation declaration is malformed regardless of enforcement.)
	if (constraint.type === 'foreignKey') {
		const fk = buildForeignKeyConstraintSchema(
			constraint,
			tableSchema.columnIndexMap,
			tableSchema.name,
			tableSchema.schemaName,
		);
		validateForeignKeyCollations(rctx.db, tableSchema, fk);
	}

	const updatedTableSchema = await module.alterTable(
		rctx.db,
		tableSchema.schemaName,
		tableSchema.name,
		{ type: 'addConstraint', constraint },
	);

	schema.addTable(updatedTableSchema);

	rctx.db.schemaManager.getChangeNotifier().notifyChange({
		type: 'table_modified',
		schemaName: tableSchema.schemaName,
		objectName: tableSchema.name,
		oldObject: tableSchema,
		newObject: updatedTableSchema,
	});

	emitAlterSchemaEvent(rctx, tableSchema, {
		type: 'alter', objectType: 'table',
		objectName: tableSchema.name,
	});

	log('Added %s constraint %s to table %s.%s',
		constraint.type, constraint.name || 'unnamed', tableSchema.schemaName, tableSchema.name);

	return null;
}

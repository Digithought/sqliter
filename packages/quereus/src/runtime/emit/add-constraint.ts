import type { AddConstraintNode } from '../../planner/nodes/add-constraint-node.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { asRun } from '../types.js';
import type { EmissionContext } from '../emission-context.js';
import { QuereusError } from '../../common/errors.js';
import { SqlValue, StatusCode } from '../../common/types.js';
import { createLogger } from '../../common/logger.js';
import type { RowConstraintSchema, TableSchema } from '../../schema/table.js';
import type { Schema } from '../../schema/schema.js';
import { assertConstraintNameFree, opsToMask, requireVtabModule } from '../../schema/table.js';
import { buildForeignKeyConstraintSchema, validateForeignKeyCollations } from '../../schema/constraint-builder.js';
import { assertUniqueConstraintIndexNameFree, assertUniqueConstraintNotDuplicated } from '../../schema/catalog.js';
import { assertDdlTransactionPolicy } from './ddl-transaction-policy.js';
import { emitAlterSchemaEvent, withStatementScopedSchemaEvents } from './alter-schema-event.js';

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

		// Within-table constraint-name uniqueness (see `assertConstraintNameFree` for why it
		// precedes both the module dispatch and the index-name guard). Placed above the
		// engine-side / module-routed branch below so one guard covers both arms. An unnamed
		// constraint has no user-supplied identity to collide.
		//
		// NOTE: when the same-named existing constraint is a UNIQUE synthesized from
		// `CREATE UNIQUE INDEX` (`derivedFromIndex` set), this says a constraint with that
		// name exists rather than naming the index. That is still true, and it is what the
		// rename path already reports for the same shape.
		if (constraint.name) assertConstraintNameFree(tableSchema, constraint.name);

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
			return runAddCheckEngineSide(rctx, tableSchema, schema, constraint, plan.sql);
		}

		// Same statement-scoped schema-event scope every `ALTER TABLE` arm runs in: the module
		// announces from inside its own `alterTable`, so anything that throws after that call
		// must retract the announcement. The engine-side branch above needs no scope — the
		// backend it exists for ships no emitter, and its own emit is already at the tail.
		return withStatementScopedSchemaEvents(rctx, () =>
			runAddConstraintViaModule(rctx, tableSchema, schema, constraint, plan.sql));
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
	schema: Schema,
	constraint: AddConstraintNode['constraint'],
	sql: string,
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
		ddl: sql,
	});

	log('Added CHECK constraint %s to table %s.%s', constraintSchema.name, tableSchema.schemaName, tableSchema.name);

	return null;
}

/**
 * The module-routed ADD CONSTRAINT arm. Its caller runs it inside the statement-scoped
 * schema-event scope every `ALTER TABLE` arm runs in (see
 * {@link withStatementScopedSchemaEvents}): the module announces from inside its own
 * `alterTable`, so anything that throws after that call must retract the announcement. The
 * window is narrow today — the module call is this arm's last real work — but leaving one
 * ALTER statement path unscoped is how the ADD COLUMN leak comes back.
 */
async function runAddConstraintViaModule(
	rctx: RuntimeContext,
	tableSchema: TableSchema,
	schema: Schema,
	constraint: AddConstraintNode['constraint'],
	sql: string,
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

	// Two UNIQUE guards, both pre-dispatch for the same reason the FK check above is: the
	// store's `alterTable` persists, so a later throw would leave the damage on disk (for
	// the name collision, a dropped `CREATE INDEX` line in the catalog entry).
	//
	// Order is load-bearing. The duplicate-constraint test runs FIRST because it compares
	// the constraint itself (its column set), which both backends carry, while the
	// index-name test compares a backing structure only the memory backend materializes —
	// letting the latter rule first made the two backends disagree on a plain duplicate
	// and reported it as a collision with an index the user never created.
	if (constraint.type === 'unique') {
		const columnNames = (constraint.columns ?? []).map(c => c.name);
		const operation = `add ${constraint.name ? `constraint '${constraint.name}'` : 'UNIQUE constraint'} to table '${tableSchema.name}'`;
		assertUniqueConstraintNotDuplicated(tableSchema, constraint.name, columnNames, operation);
		assertUniqueConstraintIndexNameFree(tableSchema, constraint.name, columnNames, operation);
	}

	// `ddl` marks this call as the statement's own action — unlike the per-inline-constraint
	// installs `runAddColumn` makes through the same arm, which pass none and stay silent.
	const updatedTableSchema = await module.alterTable(
		rctx.db,
		tableSchema.schemaName,
		tableSchema.name,
		{ type: 'addConstraint', constraint, ddl: sql },
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
		ddl: sql,
	});

	log('Added %s constraint %s to table %s.%s',
		constraint.type, constraint.name || 'unnamed', tableSchema.schemaName, tableSchema.name);

	return null;
}

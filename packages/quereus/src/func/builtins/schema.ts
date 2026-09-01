import type { Row } from "../../common/types.js";
import type { SqlValue } from "../../common/types.js";
import { createIntegratedTableValuedFunction } from "../registration.js";
import { QuereusError } from "../../common/errors.js";
import { StatusCode } from "../../common/types.js";
import type { Database } from "../../core/database.js";
import type { FunctionSchema } from "../../schema/function.js";
import { isScalarFunctionSchema, isTableValuedFunctionSchema, isAggregateFunctionSchema } from "../../schema/function.js";
import { isWindowFunction } from "../../schema/window-function.js";
import { Schema } from "../../schema/schema.js";
import { displayIndexesForTable } from "../../schema/catalog.js";
import { isMaintainedTable } from "../../schema/derivation.js";
import { generateMaintainedTableDDL, generateIndexDDL, generateTableDDL } from "../../schema/ddl-generator.js";
import { INTEGER_TYPE, TEXT_TYPE } from "../../types/builtin-types.js";
import { FunctionFlags } from "../../common/constants.js";
import { resolveReferencedColumns, RowOpFlag, type ForeignKeyConstraintSchema, type IndexSchema, type TableSchema } from "../../schema/table.js";
import { jsonStringify } from "../../util/serialization.js";
import { expressionToString } from "../../emit/ast-stringify.js";
import { createLogger } from "../../common/logger.js";
import type * as AST from "../../parser/ast.js";
import { firstDataModifyingCte } from "../../parser/utils.js";
import type { RelationalPlanNode, UpdateSite } from "../../planner/nodes/plan-node.js";
import { TableReferenceNode } from "../../planner/nodes/reference.js";
import { isJoinBody, isDecomposableJoinBody } from "../../planner/mutation/multi-source.js";
import { isSetOpMembershipBody, isSetOpBranchWritable, setOpHasSubtreeOperand, setOpJoinLegsInsertable, surfacedInnerFlagNames, isSetOpFlaglessWritableBody, flaglessDiscriminatorColumnNames } from "../../planner/mutation/set-op.js";
import { type ViewSchema, bodyDefaults } from "../../schema/view.js";

const log = createLogger('func:view_info');

/**
 * Encodes a tag bag as a JSON object string. Returns null when there are no
 * tags so callers can use `WHERE tags IS NULL` to filter untagged objects.
 * BigInt values are coerced to JSON-safe numbers/strings via `jsonStringify`.
 */
function tagsToJson(tags: Readonly<Record<string, SqlValue>> | undefined): string | null {
	if (!tags) return null;
	const keys = Object.keys(tags);
	if (keys.length === 0) return null;
	return jsonStringify(tags);
}

/**
 * Renders the canonical `CREATE INDEX` DDL for a `schema()` row via
 * {@link generateIndexDDL} (no `db`, so the result is fully qualified /
 * fully annotated and re-parses to the object it describes in any session).
 * Returns `null` on any render failure (e.g. an out-of-range column index)
 * so the listing degrades that one row instead of failing outright.
 */
function renderIndexCreateSql(index: IndexSchema, tableSchema: TableSchema): string | null {
	try {
		return generateIndexDDL(index, tableSchema);
	} catch {
		return null;
	}
}

/**
 * Converts a RowOpMask bitmask to a comma-joined operations list.
 * An empty/default mask returns the canonical default-all string so the
 * value round-trips cleanly.
 */
function rowOpMaskToString(mask: number): string {
	const parts: string[] = [];
	if (mask & RowOpFlag.INSERT) parts.push('insert');
	if (mask & RowOpFlag.UPDATE) parts.push('update');
	if (mask & RowOpFlag.DELETE) parts.push('delete');
	if (parts.length === 0) return 'insert,update,delete';
	return parts.join(',');
}

/**
 * Generates a function signature string for display
 */
function stringifyCreateFunction(func: FunctionSchema): string {
	const argsString = func.numArgs === -1
		? '...' // Indicate variable arguments
		: Array(func.numArgs).fill('?').join(', ');
	return `FUNCTION ${func.name}(${argsString})`;
}

// Schema introspection function (table-valued function)
export const schemaFunc = createIntegratedTableValuedFunction(
	{
		name: 'schema',
		numArgs: 0,
		deterministic: false, // Schema can change
		returnType: {
			typeClass: 'relation',
			isReadOnly: true,
			isSet: false,
			columns: [
				{ name: 'schema', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'type', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'name', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'tbl_name', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'sql', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'tags', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true }
			],
			keys: [],
			rowConstraints: []
		}
	},
	async function* (db: Database): AsyncIterable<Row> {
		try {
			const schemaManager = db.schemaManager;

			const processSchemaInstance = function* (schemaInstance: Schema) {
				const schemaName = schemaInstance.name;

				// Process Tables
				for (const tableSchema of schemaInstance.getAllTables()) {
					let createSql: string | null = null;
					try {
						if (isMaintainedTable(tableSchema)) {
							// A maintained table (materialized view) lists exactly ONCE,
							// as itself, with its canonical create-materialized-view DDL.
							createSql = generateMaintainedTableDDL(tableSchema);
						} else {
							// No `db`: fully qualified, always-annotated DDL that re-parses
							// to the object it describes in any session (see ddl-generator.js
							// header). Longer / uppercase than the old hand-rolled string, but
							// that hand-rolled form dropped the key, nullability, defaults,
							// collations and constraints — this is a deliberate change, not a
							// regression.
							createSql = generateTableDDL(tableSchema);
						}
					} catch {
						createSql = null;
					}

					yield [
						schemaName,
						tableSchema.isView ? 'view' : isMaintainedTable(tableSchema) ? 'materialized_view' : 'table',
						tableSchema.name,
						tableSchema.name,
						createSql,
						tagsToJson(tableSchema.tags)
					] as Row;

					// Process Indexes for this table. `displayIndexesForTable` applies the
					// same rule `collectSchemaCatalog` and `index_info()` do: a hidden
					// implicit covering structure (a plain UNIQUE's auto-built index) is a
					// backing detail and is skipped, the store-mode synthetics are
					// appended, and an exposed implicit structure renders as
					// `CREATE UNIQUE INDEX` on either backend.
					for (const { index } of displayIndexesForTable(tableSchema)) {
						yield [
							schemaName,
							'index',
							index.name,
							tableSchema.name,
							renderIndexCreateSql(index, tableSchema),
							tagsToJson(index.tags)
						] as Row;
					}
				}

				// Process Views
				for (const viewSchema of schemaInstance.getAllViews()) {
					yield [
						schemaName,
						'view',
						viewSchema.name,
						viewSchema.name,
						viewSchema.sql,
						tagsToJson(viewSchema.tags)
					] as Row;
				}

				// Process Functions (skip hidden internal helpers)
				for (const funcSchema of schemaInstance._getAllFunctions()) {
					if (funcSchema.hidden) continue;
					yield [
						schemaName,
						'function',
						funcSchema.name,
						funcSchema.name,
						stringifyCreateFunction(funcSchema),
						null
					] as Row;
				}
			};

			// Process all schemas
			for (const schemaInstance of schemaManager._getAllSchemas()) {
				yield* processSchemaInstance(schemaInstance);
			}

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		} catch (error: any) {
			// If schema introspection fails, yield an error row
			yield ['', 'error', 'schema_error', 'schema_error', `Failed to introspect schema: ${error.message}`, null];
		}
	}
);

// Table information function (table-valued function)
export const tableInfoFunc = createIntegratedTableValuedFunction(
	{
		name: 'table_info',
		numArgs: 1,
		deterministic: false, // Table structure can change
		returnType: {
			typeClass: 'relation',
			isReadOnly: true,
			isSet: false,
			columns: [
				{ name: 'cid', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'name', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'type', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'notnull', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'dflt_value', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'pk', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'tags', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'collation', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'generated', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true }
			],
			keys: [],
			rowConstraints: []
		},
		relationalAdvertisement: {
			isSet: true,
			// `cid` (column 0) is the column ordinal — unique per row.
			keys: [[{ index: 0 }]],
		},
	},
	async function* (db: Database, tableName: SqlValue): AsyncIterable<Row> {
		if (typeof tableName !== 'string') {
			throw new QuereusError('table_info() requires a table name string argument', StatusCode.ERROR);
		}

		const table = db._findTable(tableName);
		if (!table) {
			throw new QuereusError(`Table '${tableName}' not found`, StatusCode.ERROR);
		}

		for (let i = 0; i < table.columns.length; i++) {
			const column = table.columns[i];
			const isPrimaryKey = table.primaryKeyDefinition.some(pk => pk.index === i);
			// 0 = not generated, 1 = virtual generated, 2 = stored generated
			const generatedFlag = column.generated
				? (column.generatedStored ? 2 : 1)
				: 0;

			yield [
				i,                                    // cid
				column.name,                         // name
				column.logicalType.name,             // type
				column.notNull ? 1 : 0,             // notnull
				// `defaultValue` is an AST Expression, so it must be rendered by the
				// stringifier — the same emitter `generateTableDDL` uses for the DEFAULT
				// clause — not by `.toString()` (which yields "[object Object]").
				column.defaultValue ? expressionToString(column.defaultValue) : null, // dflt_value
				isPrimaryKey ? 1 : 0,               // pk
				tagsToJson(column.tags),            // tags
				column.collation || 'BINARY',       // collation
				generatedFlag                       // generated
			];
		}
	}
);

/**
 * Reports the parent column name behind each position of a foreign key, for
 * introspection. Positions that can't be resolved (unknown parent table, or a
 * parent key narrower than the child column list) come back as `null` rather
 * than raising — introspection must stay printable for malformed schemas.
 */
function resolveForeignKeyParentColumnNames(
	db: Database,
	childTable: TableSchema,
	fk: ForeignKeyConstraintSchema,
): ReadonlyArray<string | null> {
	// Declared names are reported verbatim, even if the parent (or the named
	// column) can't be resolved — no parent lookup needed.
	if (fk.referencedColumnNames && fk.referencedColumnNames.length > 0) {
		return fk.referencedColumnNames;
	}

	// An absent referencedSchema means the child's own schema, matching how
	// enforcement resolves the parent.
	const parentTable = db._findTable(fk.referencedTable, fk.referencedSchema ?? childTable.schemaName);
	if (!parentTable) return [];

	// With no declared names, resolveReferencedColumns takes the primary-key
	// path, which cannot throw.
	return resolveReferencedColumns(fk, parentTable).map(idx => parentTable.columns[idx]?.name ?? null);
}

// Foreign key information function (table-valued function)
export const foreignKeyInfoFunc = createIntegratedTableValuedFunction(
	{
		name: 'foreign_key_info',
		numArgs: 1,
		deterministic: false,
		returnType: {
			typeClass: 'relation',
			isReadOnly: true,
			isSet: false,
			columns: [
				{ name: 'id', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'name', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'table', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'from', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'referenced_table', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'referenced_schema', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'to', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'on_update', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'on_delete', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'deferred', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'seq', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'tags', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true },
			],
			keys: [],
			rowConstraints: []
		},
		relationalAdvertisement: {
			isSet: true,
			// Composite key (id, seq): each FK has one row per referenced column.
			keys: [[{ index: 0 }, { index: 10 }]],
		},
	},
	async function* (db: Database, tableName: SqlValue): AsyncIterable<Row> {
		if (typeof tableName !== 'string') {
			throw new QuereusError('foreign_key_info() requires a table name string argument', StatusCode.ERROR);
		}

		const table = db._findTable(tableName);
		if (!table) {
			throw new QuereusError(`Table '${tableName}' not found`, StatusCode.ERROR);
		}

		const foreignKeys = table.foreignKeys;
		if (!foreignKeys) return;

		for (let fkIdx = 0; fkIdx < foreignKeys.length; fkIdx++) {
			const fk = foreignKeys[fkIdx];
			const fkTagJson = tagsToJson(fk.tags);

			// Resolve parent column names once per FK, not per seq.
			const toColNames = resolveForeignKeyParentColumnNames(db, table, fk);

			for (let seq = 0; seq < fk.columns.length; seq++) {
				const fromCol = table.columns[fk.columns[seq]];
				const toColName = toColNames[seq] ?? null;

				yield [
					fkIdx,                              // id
					fk.name ?? null,                    // name
					table.name,                         // table
					fromCol.name,                       // from
					fk.referencedTable,                 // referenced_table
					fk.referencedSchema ?? null,        // referenced_schema
					toColName,                          // to
					fk.onUpdate,                        // on_update
					fk.onDelete,                        // on_delete
					fk.deferred ? 1 : 0,                // deferred
					seq,                                // seq
					fkTagJson,                          // tags
				];
			}
		}
	}
);

// Index information function (table-valued function)
export const indexInfoFunc = createIntegratedTableValuedFunction(
	{
		name: 'index_info',
		numArgs: 1,
		deterministic: false,
		returnType: {
			typeClass: 'relation',
			isReadOnly: true,
			isSet: false,
			columns: [
				{ name: 'index_name', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'seq', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'column_name', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'desc', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'collation', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'unique', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'partial', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'tags', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true },
			],
			keys: [],
			rowConstraints: []
		},
		relationalAdvertisement: {
			isSet: true,
			// Composite key (index_name, seq): each index has one row per indexed column position.
			keys: [[{ index: 0 }, { index: 1 }]],
		},
	},
	async function* (db: Database, tableName: SqlValue): AsyncIterable<Row> {
		if (typeof tableName !== 'string') {
			throw new QuereusError('index_info() requires a table name string argument', StatusCode.ERROR);
		}

		const table = db._findTable(tableName);
		if (!table) {
			throw new QuereusError(`Table '${tableName}' not found`, StatusCode.ERROR);
		}

		// The same list `schema()` and `collectSchemaCatalog` show — real indexes plus
		// any exposed implicit covering index the backend did not materialize as an
		// `IndexSchema` (store mode), each already display-rendered. That rendering is
		// what makes an exposed implicit covering index report `unique = 1` here and
		// `CREATE UNIQUE INDEX` in `schema()` — one answer, both backends. Enforcement
		// still routes through `uniqueConstraints`; this column describes, it does not
		// enforce.
		for (const { index: idx } of displayIndexesForTable(table)) {
			const tagJson = tagsToJson(idx.tags);
			const uniqueFlag = idx.unique ? 1 : 0;
			const partialFlag = idx.predicate ? 1 : 0;
			for (let seq = 0; seq < idx.columns.length; seq++) {
				const col = idx.columns[seq];
				const tableCol = table.columns[col.index];
				yield [
					idx.name,                       // index_name
					seq,                            // seq
					tableCol.name,                  // column_name
					col.desc ? 1 : 0,               // desc
					col.collation ?? null,          // collation
					uniqueFlag,                     // unique
					partialFlag,                    // partial
					tagJson,                        // tags
				];
			}
		}
	}
);

// CHECK constraint information function (table-valued function)
export const checkConstraintInfoFunc = createIntegratedTableValuedFunction(
	{
		name: 'check_constraint_info',
		numArgs: 1,
		deterministic: false,
		returnType: {
			typeClass: 'relation',
			isReadOnly: true,
			isSet: false,
			columns: [
				{ name: 'id', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'name', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'expr', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'operations', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'deferrable', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'initially_deferred', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'tags', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true },
			],
			keys: [],
			rowConstraints: []
		},
		relationalAdvertisement: {
			isSet: true,
			// `id` (column 0) is the constraint ordinal — unique per emitted row.
			keys: [[{ index: 0 }]],
		},
	},
	async function* (db: Database, tableName: SqlValue): AsyncIterable<Row> {
		if (typeof tableName !== 'string') {
			throw new QuereusError('check_constraint_info() requires a table name string argument', StatusCode.ERROR);
		}

		const table = db._findTable(tableName);
		if (!table) {
			throw new QuereusError(`Table '${tableName}' not found`, StatusCode.ERROR);
		}

		const checks = table.checkConstraints;
		for (let i = 0; i < checks.length; i++) {
			const cc = checks[i];
			yield [
				i,                                  // id
				cc.name ?? null,                    // name
				expressionToString(cc.expr),        // expr
				rowOpMaskToString(cc.operations),   // operations
				cc.deferrable ? 1 : 0,              // deferrable
				cc.initiallyDeferred ? 1 : 0,       // initially_deferred
				tagsToJson(cc.tags),                // tags
			];
		}
	}
);

// UNIQUE constraint information function (table-valued function)
export const uniqueConstraintInfoFunc = createIntegratedTableValuedFunction(
	{
		name: 'unique_constraint_info',
		numArgs: 1,
		deterministic: false,
		returnType: {
			typeClass: 'relation',
			isReadOnly: true,
			isSet: false,
			columns: [
				{ name: 'id', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'name', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'seq', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'column_name', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'partial', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'tags', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true },
			],
			keys: [],
			rowConstraints: []
		},
		relationalAdvertisement: {
			isSet: true,
			// Composite (id, seq): one row per (constraint, column position).
			keys: [[{ index: 0 }, { index: 2 }]],
		},
	},
	async function* (db: Database, tableName: SqlValue): AsyncIterable<Row> {
		if (typeof tableName !== 'string') {
			throw new QuereusError('unique_constraint_info() requires a table name string argument', StatusCode.ERROR);
		}

		const table = db._findTable(tableName);
		if (!table) {
			throw new QuereusError(`Table '${tableName}' not found`, StatusCode.ERROR);
		}

		const uniques = table.uniqueConstraints;
		if (!uniques) return;

		for (let i = 0; i < uniques.length; i++) {
			const uc = uniques[i];
			const tagJson = tagsToJson(uc.tags);
			const partialFlag = uc.predicate ? 1 : 0;
			for (let seq = 0; seq < uc.columns.length; seq++) {
				const tableCol = table.columns[uc.columns[seq]];
				yield [
					i,                          // id
					uc.name ?? null,            // name
					seq,                        // seq
					tableCol.name,              // column_name
					partialFlag,                // partial
					tagJson,                    // tags
				];
			}
		}
	}
);

// Assertion information function (table-valued function)
export const assertionInfoFunc = createIntegratedTableValuedFunction(
	{
		name: 'assertion_info',
		numArgs: 0,
		deterministic: false,
		returnType: {
			typeClass: 'relation',
			isReadOnly: true,
			isSet: false,
			columns: [
				{ name: 'schema_name', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'name', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'violation_sql', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'deferrable', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'initially_deferred', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'dependent_tables', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
			],
			keys: [],
			rowConstraints: []
		},
		relationalAdvertisement: {
			isSet: true,
			// Assertion names are unique per schema, not globally — the honest key
			// is the (schema_name, name) pair.
			keys: [[{ index: 0 }, { index: 1 }]],
		},
	},
	async function* (db: Database): AsyncIterable<Row> {
		for (const assertion of db.schemaManager.getAllAssertions()) {
			const deps = assertion.dependentTables ?? [];
			yield [
				assertion.schemaName,
				assertion.name,
				assertion.violationSql,
				assertion.deferrable ? 1 : 0,
				assertion.initiallyDeferred ? 1 : 0,
				jsonStringify(deps),
			];
		}
	}
);

export function classifyFunction(funcSchema: FunctionSchema): string {
	if (isWindowFunction(funcSchema.name)) return 'window';
	if (isScalarFunctionSchema(funcSchema)) return 'scalar';
	if (isTableValuedFunctionSchema(funcSchema)) return 'table';
	if (isAggregateFunctionSchema(funcSchema)) return 'aggregate';
	return 'unknown';
}

function* yieldFunctionRow(funcSchema: FunctionSchema) {
	const isDeterministic = (funcSchema.flags & FunctionFlags.DETERMINISTIC) !== 0;
	yield [
		funcSchema.name,
		funcSchema.numArgs,
		classifyFunction(funcSchema),
		isDeterministic ? 1 : 0,
		funcSchema.flags,
		stringifyCreateFunction(funcSchema)
	] as Row;
}

// Function information function (table-valued function)
export const functionInfoFunc = createIntegratedTableValuedFunction(
	{
		name: 'function_info',
		numArgs: -1,
		deterministic: false,
		returnType: {
			typeClass: 'relation',
			isReadOnly: true,
			isSet: false,
			columns: [
				{ name: 'name', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'num_args', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'type', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'deterministic', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'flags', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'signature', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true }
			],
			keys: [],
			rowConstraints: []
		},
		relationalAdvertisement: {
			isSet: true,
			// Composite (name, num_args): function-key matches the (name, numArgs) registration key.
			keys: [[{ index: 0 }, { index: 1 }]],
		},
	},
	async function* (db: Database, filterName?: SqlValue): AsyncIterable<Row> {
		const nameFilter = (typeof filterName === 'string') ? filterName.toLowerCase() : null;

		try {
			const schemaManager = db.schemaManager;

			for (const schemaInstance of schemaManager._getAllSchemas()) {
				for (const funcSchema of schemaInstance._getAllFunctions()) {
					if (nameFilter !== null && funcSchema.name.toLowerCase() !== nameFilter) continue;
					yield* yieldFunctionRow(funcSchema);
				}
			}

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		} catch (error: any) {
			yield ['error', -1, 'error', 0, 0, `Failed to get function info: ${error.message}`];
		}
	}
);

// ---------------------------------------------------------------------------
// view_info(): per-view updateability surface.
//
// The engine-idiomatic realization of `docs/view-updateability.md`
// § Information Schema Surface's `information_schema.views`: a read-only TVF
// (consistent with the `*_info` introspection family) projecting the four
// view-level updateability columns over plain (non-materialized) views.
// Maintained tables (materialized views) are deliberately excluded — they list
// as tables in `schema()`; their per-column write-through lineage surfaces
// through `column_info`, which walks the derivation body with the same
// classification (one consistent story across the two functions).
//
// Every value is derived **statically** from the planned view body's backward
// `updateLineage` / `attributeDefaults` (threaded onto `PhysicalProperties` by
// the view-mutation lineage pass) plus the base-table not-null/default/generated
// flags — no dry-run mutation. The substrate's `propagate()` insert / delete
// paths remain the authoritative *dynamic* check; this surface is the
// conservative static reading (cross-checked by test, not invoked here).
// ---------------------------------------------------------------------------

/** Derived view-level updateability facts (pre-`'YES'`/`'NO'` encoding). */
interface ViewInfoRow {
	readonly isInsertableInto: boolean;
	readonly isUpdatable: boolean;
	readonly isDeletable: boolean;
	/** Distinct base-table names reachable by default, sorted for determinism. */
	readonly effectiveTargets: string[];
}

/** The conservative all-`NO` / `[]` row for a body with no recoverable base lineage. */
const CONSERVATIVE_VIEW_INFO: ViewInfoRow = {
	isInsertableInto: false,
	isUpdatable: false,
	isDeletable: false,
	effectiveTargets: [],
};

/** SQL-standard `'YES'`/`'NO'` text encoding for a boolean updateability flag. */
function yesNo(value: boolean): string {
	return value ? 'YES' : 'NO';
}

/**
 * Resolve an UpdateSite to its underlying base reference: the producing
 * `TableReferenceNode` id + base column for a `base` site (plain or `null-extended`),
 * else `undefined` (a `computed` / leaf-less site). `nullExtended` is true when an
 * outer-join `null-extended` layer was unwrapped to reach the base — the column names a
 * base table/column (so it is insertable through the both-sides envelope and counts as
 * an effective target) but is read-only on UPDATE (the deferred per-row materialization),
 * so the per-column / `is_updatable` surfaces report it non-updatable.
 */
function baseSiteOf(site: UpdateSite | undefined): { readonly table: number; readonly baseColumn: string; readonly nullExtended: boolean } | undefined {
	let s = site;
	let nullExtended = false;
	while (s && s.kind === 'null-extended') { nullExtended = true; s = s.inner; }
	return s && s.kind === 'base' ? { table: s.table, baseColumn: s.baseColumn, nullExtended } : undefined;
}

/** Every relational node in the planned body (deduped), root-first. */
function collectBodyNodes(root: RelationalPlanNode): RelationalPlanNode[] {
	const out: RelationalPlanNode[] = [];
	const seen = new Set<RelationalPlanNode>();
	const visit = (n: RelationalPlanNode): void => {
		if (seen.has(n)) return;
		seen.add(n);
		out.push(n);
		for (const child of n.getRelations()) visit(child);
	};
	visit(root);
	return out;
}

/**
 * Index every `TableReferenceNode` in a planned body by its numeric node id.
 * Shared by `deriveViewInfo` and `deriveColumnInfo`: an UpdateSite's `table`
 * field is the producing reference's id, which both surfaces resolve back to a
 * base-table name through this map.
 */
function buildTableRefsById(nodes: RelationalPlanNode[]): Map<number, TableReferenceNode> {
	const tableRefsById = new Map<number, TableReferenceNode>();
	for (const n of nodes) {
		if (n instanceof TableReferenceNode) tableRefsById.set(Number(n.id), n);
	}
	return tableRefsById;
}

/**
 * True when the view body's own `WITH` clause defines a data-modifying block — an
 * `insert`/`update`/`delete … returning` CTE. The static shadow of the dynamic write
 * path's `rejectDataModifyingBodyCTE` gate, so `view_info` reports the conservative row
 * for a shape every write through it rejects. Both read the same predicate
 * (`firstDataModifyingCte`) so the two cannot drift apart.
 */
function hasDataModifyingBodyCte(selectAst: AST.QueryExpr): boolean {
	if (selectAst.type !== 'select' || !selectAst.withClause) return false;
	return firstDataModifyingCte(selectAst.withClause) !== undefined;
}

/** Record `baseColumn` (lowercased) as defaultable for base table `table`. */
function addDefaultable(map: Map<number, Set<string>>, table: number, baseColumn: string): void {
	const set = map.get(table) ?? new Set<string>();
	set.add(baseColumn.toLowerCase());
	map.set(table, set);
}

/**
 * Derive the four view-level updateability columns statically from the planned
 * view body. The **logical** tree is used deliberately (via `_buildPlan`, not
 * `getPlan`): it preserves the Project/Filter/Join/TableReference operator
 * structure that threads `updateLineage`, whereas the optimizer degrades a join's
 * top-node lineage to `computed` (docs/view-updateability.md § surface authority).
 * This mirrors the view-mutation substrate (`planner/mutation/*`), which plans the
 * body logically for the same reason — so `effective_targets` agrees with the
 * base set `propagate()` reaches.
 *
 * Re-plans on every call (same re-plan-on-read posture as `deriveBackingShape`);
 * caching is a later optimization.
 */
function deriveViewInfo(db: Database, view: ViewSchema): ViewInfoRow {
	// Data-modifying body `with` block (`with m as (insert … returning …)`): the body plans
	// fine — and its lineage may look perfectly writable — but every write through the view
	// is rejected up front (`unsupported-body-cte-dml`, `rejectDataModifyingBodyCTE` in
	// `planner/building/view-mutation-builder.ts`), so reporting anything but the conservative
	// row would over-claim. Mirrors the `isJoinBody && !isDecomposableJoinBody` shape gate below;
	// answered from the AST alone, so it runs BEFORE the body re-plan below rather than after it.
	if (hasDataModifyingBodyCte(view.selectAst)) return CONSERVATIVE_VIEW_INFO;

	// Home-schema path: the body's unqualified names resolve next to the view.
	const { plan } = db._buildPlan([view.selectAst as AST.Statement], undefined, db._homeSchemaPath(view.schemaName));
	const root = plan.getRelations()[0];
	if (!root) return CONSERVATIVE_VIEW_INFO;

	const nodes = collectBodyNodes(root);

	// The minimal `MutableViewLike` the set-op insertability probe re-derives the branches from
	// (the same `{ name, schemaName, selectAst }` shape the write path / `deriveBackingShape` use).
	const viewAsMutable = { name: view.name, schemaName: view.schemaName, selectAst: view.selectAst };

	// Set-operation membership body: the per-branch fan-out makes the view
	// insertable-into (flag-routed insert-through), updatable (membership flip + data
	// fan-out), and deletable (delete fan-out), agreeing with the dynamic `propagate()`
	// truth (`set-op-membership-write`). The effective targets are the branch base
	// tables. A plain (flag-less) set-op body is NOT this case — it falls through to the
	// `targetIds.size === 0` conservative row below (no membership column to address a branch).
	if (isSetOpMembershipBody(view.selectAst)) {
		// Branch-writability shape gate (mirrors the non-decomposable join shape gate below):
		// a membership body the dynamic write (`analyzeSetOpView`) would reject — an outer
		// LIMIT/OFFSET (non-decomposable window), a non-SELECT right operand, a `select *`
		// leg, a computed leg, or legs with mismatched column counts — is gated out here.
		// Without this gate the
		// surface would over-claim writable from the membership flag's presence alone; report
		// the conservative all-`NO` row to agree with the dynamic `propagate()` reject.
		if (!isSetOpBranchWritable(view.selectAst)) return CONSERVATIVE_VIEW_INFO;
		const targets = [...new Set([...buildTableRefsById(nodes).values()].map(r => r.tableSchema.name))].sort();
		// Update / delete fan-out recurses through a subtree operand to its member leaves
		// (`nestable-flagged-set-ops`) AND composes a multi-source (INNER join) branch
		// (`set-op-write-multisource-leg-compose`), so updatable / deletable stay YES at any depth.
		// Insert through a join branch is now SHIPPED via the nested shared-surrogate envelope splice
		// (`set-op-write-multisource-leg-insert`), so `is_insertable_into` is YES for a body whose
		// join branches are ALL insertable — re-derived dynamically by `setOpJoinLegsInsertable`
		// (NO for a composite-key / no-default / non-equi join branch). It stays NO when EITHER
		// operand is a subtree: inserting into a multi-leaf subtree has no single deterministic
		// target leaf (product-coordinate addressing — `set-op-membership-nested`).
		const isInsertableInto = !setOpHasSubtreeOperand(view.selectAst)
			&& setOpJoinLegsInsertable(db._buildProbeContext(undefined, db._homeSchemaPath(view.schemaName)), viewAsMutable);
		return { isInsertableInto, isUpdatable: true, isDeletable: true, effectiveTargets: targets };
	}

	// Flag-less predicate-honest set-op body (`set-op-flagless-predicate-honest-writes`): a
	// flag-less body of literal-discriminator legs is insertable (routed to the consistent
	// legs), updatable (data-column fan-out; the literal discriminators are read-only), and
	// deletable (fan-out) — agreeing with the dynamic `buildFlaglessSetOpWrite` truth. The
	// recognizer is the static shadow of the dynamic write's shape acceptance (it admits
	// literal projections, unlike the membership probe), so a body it rejects (outer
	// LIMIT/OFFSET, `select *` / computed leg, deep intersect/except) falls through to the
	// `targetIds.size === 0` conservative row below.
	if (isSetOpFlaglessWritableBody(view.selectAst)) {
		const targets = [...new Set([...buildTableRefsById(nodes).values()].map(r => r.tableSchema.name))].sort();
		// Insert through a multi-source (join) leg is now SHIPPED via the nested shared-surrogate
		// envelope splice (`set-op-write-multisource-leg-insert`), so `is_insertable_into` is YES for
		// a body whose join legs are ALL insertable — re-derived dynamically by
		// `setOpJoinLegsInsertable` (NO for a composite-key / no-default / non-equi join leg) —
		// matching the dynamic `buildFlaglessInsert`; UPDATE / DELETE through the join leg stay YES.
		const isInsertableInto = setOpJoinLegsInsertable(db._buildProbeContext(undefined, db._homeSchemaPath(view.schemaName)), viewAsMutable);
		return { isInsertableInto, isUpdatable: true, isDeletable: true, effectiveTargets: targets };
	}

	// Non-decomposable join shape gate: cross / comma (implicit) / subquery- or
	// function-source join bodies are not write-through-able, so they must report the
	// conservative all-`NO` row. `propagate()` decomposes an n-way (≥2) equi-join —
	// `inner`/`left`/`right`/`full` (RIGHT now admitted, the LEFT mirror; FULL self-conservatizes), composite-PK
	// sides and self-joins included
	// (`isDecomposableJoinBody`, the boolean shadow of `collectJoinSources`) — and rejects
	// every other join shape, so without this gate the target walk below would resolve
	// their bases and over-report `is_updatable = 'YES'`. Outer joins ARE decomposable
	// now (partially writable), so they flow through to the per-column walk, which reports
	// a non-preserved (`null-extended`) column non-updatable via `baseSiteOf().nullExtended`
	// — agreeing with the dynamic `propagate()` truth (a non-preserved update rejects).
	if (isJoinBody(view.selectAst) && !isDecomposableJoinBody(view.selectAst)) {
		return CONSERVATIVE_VIEW_INFO;
	}

	const tableRefsById = buildTableRefsById(nodes);

	// Output-column lineage: effective targets, the per-table set of base columns
	// exposed by the projection, and the is_updatable flag (≥1 output column with a
	// PRESERVED base site — a non-preserved `null-extended` column is read-only on
	// update, so it does not make the view updatable). `preservedTargets` are the base
	// tables a column reaches non-null-extended — the only ones a DELETE routes to
	// (§ Outer Joins — Deletes), so they alone gate deletability below.
	const rootLineage = root.physical?.updateLineage;
	const targetIds = new Set<number>();
	const preservedTargets = new Set<number>();
	const exposed = new Map<number, Set<string>>();
	let anyBase = false;
	for (const attr of root.getAttributes()) {
		const site = rootLineage?.get(attr.id);
		// An authored (`with inverse`) column exposes each put's target base column —
		// it is writable through the put expressions, so the targets count toward base
		// reachability exactly like identity columns. INSERT coverage (`exposed`) is
		// counted only for a single-source body: the single-source spine evaluates the
		// puts per supplied row, but the multi-source insert envelope defers authored
		// puts, so counting them there would over-report `is_insertable_into`.
		if (site?.kind === 'authored') {
			for (const put of site.puts) {
				anyBase = true;
				preservedTargets.add(put.table);
				targetIds.add(put.table);
				if (!isJoinBody(view.selectAst)) {
					const set = exposed.get(put.table) ?? new Set<string>();
					set.add(put.baseColumn.toLowerCase());
					exposed.set(put.table, set);
				}
			}
			continue;
		}
		const bs = baseSiteOf(site);
		if (!bs) continue;
		if (!bs.nullExtended) { anyBase = true; preservedTargets.add(bs.table); }
		targetIds.add(bs.table);
		// A null-extended column still exposes its base column for INSERT coverage (the
		// both-sides envelope supplies it) — add it regardless of preservation.
		const set = exposed.get(bs.table) ?? new Set<string>();
		set.add(bs.baseColumn.toLowerCase());
		exposed.set(bs.table, set);
	}

	// No base lineage at the root ⇒ wholly read-only (VALUES / aggregate / set-op /
	// computed-only / recursive-CTE body). The conservative row falls straight out.
	if (targetIds.size === 0) return CONSERVATIVE_VIEW_INFO;

	// No PRESERVED base column ⇒ a FULL outer join (every side null-extended), or a
	// LEFT/RIGHT body that projects away its whole preserved side. v1 defers write-through
	// there (a full-outer write is per-row — § Outer Joins; a RIGHT body now reaches here
	// but always has a preserved anchor), so report the conservative
	// row, agreeing with the dynamic rejects (`unsupported-outer-join-update` on update,
	// `unsupported-join` on delete/insert through a side-less preserved set).
	if (preservedTargets.size === 0) return CONSERVATIVE_VIEW_INFO;

	// Defaultable base columns: every (node, attribute) carrying an insert default
	// (`constant-fd` selection pin, declared `base-default`, `view-insert-default`),
	// resolved through THAT node's own lineage back to a base column. Walking the
	// whole spine — not just the root — recovers a *projected-away* constant-FD
	// column (e.g. `select name from t where color = 'green'`, where `color`'s
	// default lives on the Filter, below the projection that drops it).
	const defaultable = new Map<number, Set<string>>();
	for (const n of nodes) {
		const nl = n.physical?.updateLineage;
		const nd = n.physical?.attributeDefaults;
		if (!nl || !nd) continue;
		for (const attrId of nd.keys()) {
			const bs = baseSiteOf(nl.get(attrId));
			if (!bs) continue;
			addDefaultable(defaultable, bs.table, bs.baseColumn);
		}
	}

	// View-level insert defaults (Divergence 1): the `view-insert-default`
	// provenance is never threaded onto `PhysicalProperties` (it is consumed only
	// in the rewrite), so this body is planned without the view's defaults and the
	// walk above misses them. Fold each `with defaults (col = expr, …)` clause
	// column (now stored on the body select AST) into `defaultable` directly,
	// mirroring `resolveDefaultForColumn` — a base column of a reachable target
	// (the common projected-away case) or a visible view-output column with base
	// lineage. Unlike the rewrite, an unresolvable name is silently skipped: a
	// read-only introspection surface stays on its never-throw posture (the
	// per-view try/catch would otherwise collapse the row to all-`NO`).
	const defaultedColumns = new Set<string>((bodyDefaults(view.selectAst) ?? []).map(d => d.column.toLowerCase()));
	for (const colName of defaultedColumns) {
		let resolved = false;
		for (const id of targetIds) {
			const match = tableRefsById.get(id)?.tableSchema.columns
				.find(c => c.name.toLowerCase() === colName);
			if (match) {
				addDefaultable(defaultable, id, match.name);
				resolved = true;
			}
		}
		if (resolved) continue;

		const attr = root.getAttributes().find(a => a.name.toLowerCase() === colName);
		const bs = attr && baseSiteOf(rootLineage?.get(attr.id));
		if (bs) addDefaultable(defaultable, bs.table, bs.baseColumn);
	}

	const targetNames = new Set<string>();
	let isDeletable = true;
	let isInsertableInto = true;
	for (const id of targetIds) {
		const ref = tableRefsById.get(id);
		if (!ref) {
			// A base-site id with no resolved TableReferenceNode should not happen
			// (root lineage ids come from the nodes we collected); fail conservative.
			isDeletable = false;
			isInsertableInto = false;
			continue;
		}
		const tbl = ref.tableSchema;
		targetNames.add(tbl.name);
		const exp = exposed.get(id) ?? new Set<string>();
		const def = defaultable.get(id) ?? new Set<string>();

		// Deletability + insertability are decided over the PRESERVED targets only — a
		// non-preserved (outer-join) target is never the delete route (deleting it merely
		// null-extends the row — § Outer Joins — Deletes) and is an *optional* member of
		// the insert fan-out (the preserved-only insert omits it). So a non-preserved
		// target's unexposed PK / uncovered not-null column does not block either flag; a
		// real both-sides insert that DOES supply it is gated at runtime instead.
		if (!preservedTargets.has(id)) continue;

		// Deletable iff every preserved target's PK is exposed through base lineage (so
		// `pk = <view value>` is constructible). A keyless preserved base is undeletable.
		const pkCols = tbl.primaryKeyDefinition.map(pk => tbl.columns[pk.index].name.toLowerCase());
		if (pkCols.length === 0 || !pkCols.every(c => exp.has(c))) isDeletable = false;

		// Insertable iff every not-null-without-declared-default, non-generated base
		// column has a recoverable value: projected (exposed) or carries an insert
		// default. Generated columns are computed/auto; nullable columns take null;
		// declared-default columns supply themselves.
		for (const col of tbl.columns) {
			if (col.generated || !col.notNull || col.defaultValue != null) continue;
			const name = col.name.toLowerCase();
			if (!exp.has(name) && !def.has(name)) {
				isInsertableInto = false;
				break;
			}
		}
	}

	return {
		isInsertableInto,
		isUpdatable: anyBase,
		isDeletable,
		effectiveTargets: [...targetNames].sort(),
	};
}

// View updateability function (table-valued function)
export const viewInfoFunc = createIntegratedTableValuedFunction(
	{
		name: 'view_info',
		numArgs: -1,
		deterministic: false, // Schema (and therefore lineage) can change
		returnType: {
			typeClass: 'relation',
			isReadOnly: true,
			isSet: false,
			columns: [
				{ name: 'schema', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'name', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'is_insertable_into', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'is_updatable', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'is_deletable', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'effective_targets', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
			],
			keys: [],
			rowConstraints: []
		},
		relationalAdvertisement: {
			isSet: true,
			// Composite (schema, name): a view is unique per (schema, name) — guards
			// against same-named views across schemas (main / temp / …).
			keys: [[{ index: 0 }, { index: 1 }]],
		},
	},
	async function* (db: Database, filterName?: SqlValue): AsyncIterable<Row> {
		const nameFilter = (typeof filterName === 'string') ? filterName.toLowerCase() : null;

		for (const schemaInstance of db.schemaManager._getAllSchemas()) {
			for (const view of schemaInstance.getAllViews()) {
				if (nameFilter !== null && view.name.toLowerCase() !== nameFilter) continue;

				let info: ViewInfoRow;
				try {
					info = deriveViewInfo(db, view);
				} catch (error) {
					// Per-view conservative fallback: a body that fails to plan (stale
					// source, unsupported shape) yields the all-`NO` / `[]` row rather
					// than throwing the whole TVF. Logged so a genuinely unexpected
					// failure is not silently swallowed.
					log('conservative row for view %s.%s: %s', schemaInstance.name, view.name,
						error instanceof Error ? error.message : String(error));
					info = CONSERVATIVE_VIEW_INFO;
				}

				yield [
					schemaInstance.name,
					view.name,
					yesNo(info.isInsertableInto),
					yesNo(info.isUpdatable),
					yesNo(info.isDeletable),
					jsonStringify(info.effectiveTargets),
				] as Row;
			}
		}
	}
);

// ---------------------------------------------------------------------------
// column_info(name): per-column updateability surface.
//
// The column-granular companion to `view_info()` — the engine-idiomatic
// realization of `docs/view-updateability.md` § Information Schema Surface's
// `information_schema.columns.is_updatable`, covering every column of every base
// table, plain view, and maintained table (materialized view).
// `view_info : schema()` :: `column_info : table_info`.
//
// A dedicated TVF (not a `table_info` extension): `table_info` resolves base
// tables only (`_findTable`), whereas views live in a separate catalog map and
// carry none of the per-column metadata `table_info` emits. `column_info`
// resolves *either* a base table or a view and emits only the column-granular
// updateability facts, uniformly.
//
// Every value is derived **statically**: a base column's `is_updatable` is just
// `!generated`; a view column's — and a maintained table's, through the same
// shared derivation-body walk — is read from the planned body's backward
// `updateLineage` (the same substrate `view_info()` reads) — no dry-run
// mutation, no new planner pass.
// ---------------------------------------------------------------------------

/** Per-column updateability facts for one emitted `column_info` row (pre-encoding). */
interface ColumnInfoRow {
	readonly schema: string;
	readonly objectName: string;
	readonly cid: number;
	readonly columnName: string;
	readonly isUpdatable: boolean;
	readonly baseTable: string | null;
	readonly baseColumn: string | null;
}

/**
 * Derive the per-column updateability rows for a base table, plain view, or
 * maintained table (materialized view).
 *
 * **Base table** (`_findTable` hit) — every non-generated column is trivially a
 * `base` write target; generated columns are computed/read-only. The `schema`
 * comes straight off the resolved `TableSchema.schemaName`.
 *
 * **Plain view** (first `getView` hit across schemas, main→temp→attached order
 * mirroring `_findTable`) — plan the body **logically** (via `_buildPlan`, not
 * `getPlan`, for the same lineage-preservation reason as `deriveViewInfo`) and
 * read each output attribute's backward `updateLineage` site. A `base` site
 * (unwrapped through `null-extended`) that resolves to a `TableReferenceNode`
 * is updatable and carries its base table/column trace; everything else is
 * read-only with `null` trace.
 *
 * Throws `'<name>' not found` when neither resolves (parity with `table_info`'s
 * required-target posture — `column_info` takes a *required* name, unlike
 * `view_info`'s optional filter). A view body that fails to plan or yields no
 * relational output produces *no rows* (logged) — the conservative, never-throw
 * posture `view_info` takes, but at row granularity there is no all-`NO` row to
 * emit.
 *
 * **Maintained table** (a `TableSchema` carrying a `TableDerivation` — what
 * `create materialized view` produces; detected via `isMaintainedTable`, never a
 * name pattern) — write-through inherits the view-updateability rules
 * (`maintainedTableViewLike` routes DML through the same view-mutation rewrite a
 * plain view uses), so the per-column rows come from the SAME derivation-body
 * lineage walk a plain view gets, not the trivially-all-updatable base branch:
 * passthrough/rename columns report their source base column and
 * `is_updatable = 'YES'`; non-invertible expression columns report `'NO'` with
 * null trace. The table's own registered columns are the authoritative output
 * names (the derivation's rename list is already folded into them), so they
 * override the body attribute names positionally. A derivation body that fails
 * to plan (e.g. stale source) degrades to conservative read-only rows over the
 * registered columns — unlike the view path's no-rows fallback, the columns ARE
 * known here. `view_info` continues to exclude maintained tables (its per-view
 * surface stays plain-view-only); the two functions tell one consistent
 * lineage story through this shared walk.
 */
function deriveColumnInfo(db: Database, name: string): ColumnInfoRow[] {
	// Base table first (mirrors table_info's `_findTable`-only resolution).
	const table = db._findTable(name);
	if (table) {
		if (isMaintainedTable(table)) {
			const columnNames = table.columns.map(c => c.name);
			try {
				return deriveBodyColumnRows(db, table.schemaName, table.name, table.derivation.selectAst, columnNames);
			} catch (error) {
				// Conservative fallback: the registered columns are known even when the
				// derivation body fails to plan — report each read-only with null trace.
				log('column_info: conservative rows for maintained table %s.%s: %s', table.schemaName, table.name,
					error instanceof Error ? error.message : String(error));
				return columnNames.map((columnName, i): ColumnInfoRow => ({
					schema: table.schemaName,
					objectName: table.name,
					cid: i,
					columnName,
					isUpdatable: false,
					baseTable: null,
					baseColumn: null,
				}));
			}
		}
		return table.columns.map((col, i): ColumnInfoRow => {
			const updatable = !col.generated;
			return {
				schema: table.schemaName,
				objectName: table.name,
				cid: i,
				columnName: col.name,
				isUpdatable: updatable,
				baseTable: updatable ? table.name : null,
				baseColumn: updatable ? col.name : null,
			};
		});
	}

	// View fallback: first `getView` hit across schemas (main → temp → attached,
	// the insertion order `_getAllSchemas` yields — same order `_findTable` uses).
	let view: ViewSchema | undefined;
	let schemaName: string | undefined;
	for (const schemaInstance of db.schemaManager._getAllSchemas()) {
		const v = schemaInstance.getView(name);
		if (v) { view = v; schemaName = schemaInstance.name; break; }
	}
	if (!view || schemaName === undefined) {
		throw new QuereusError(`'${name}' not found`, StatusCode.ERROR);
	}

	try {
		return deriveBodyColumnRows(db, schemaName, view.name, view.selectAst);
	} catch (error) {
		// A body that fails to plan (stale source, unsupported shape) yields no
		// rows rather than throwing the whole TVF — logged so a genuinely
		// unexpected failure is not silently swallowed.
		log('column_info: no rows for view %s.%s: %s', schemaName, view.name,
			error instanceof Error ? error.message : String(error));
		return [];
	}
}

/**
 * The shared body-lineage walk behind `column_info`'s view AND maintained-table
 * branches: plan `selectAst` **logically** (via `_buildPlan`, not `getPlan`, for
 * the same lineage-preservation reason as `deriveViewInfo`) and read each output
 * attribute's backward `updateLineage` site — the same classification the
 * write-through rewrite applies, so the static surface agrees with the dynamic
 * `propagate()` truth for both surfaces. Throws on plan failure; each caller
 * supplies its own conservative fallback. `columnNames`, when given (the
 * maintained-table caller), positionally overrides the body attribute names —
 * the owning table's registered columns are the authoritative output names.
 * Lineage classification (set-op flag membership) still keys off the body
 * attribute names the AST probes report.
 */
function deriveBodyColumnRows(
	db: Database,
	schemaName: string,
	objectName: string,
	selectAst: AST.QueryExpr,
	columnNames?: ReadonlyArray<string>,
): ColumnInfoRow[] {
	// Home-schema path: the body's unqualified names resolve next to the owner.
	const { plan } = db._buildPlan([selectAst as AST.Statement], undefined, db._homeSchemaPath(schemaName));
	const root = plan.getRelations()[0];
	if (!root) return [];

	const nodes = collectBodyNodes(root);

	// Set-operation membership body: every column is writable through an *effect*, not a
	// base mapping — a membership flag flips its branch's presence (insert/delete), a data
	// column fans out to its member branches (`set-op-membership-write`). So each reports
	// `is_updatable = 'YES'` with `base_table` / `base_column` = null (no single base
	// column), the same writable-through-effect shape a join-side existence flag reports.
	//
	// Gated on the branch-writability shape probe (parity with `deriveViewInfo`): a body
	// the dynamic write rejects (outer LIMIT/OFFSET, non-SELECT right, `select *` leg,
	// computed leg, mismatched leg arity) falls THROUGH to the per-column walk below
	// instead of the all-`YES` short-circuit. That walk reports every column non-updatable
	// with null base — a `SetOperationNode` root threads `updateLineage` ONLY for its
	// membership flags (a read-only `set-op-branch` existence site) and NONE for its data
	// columns, so `baseSiteOf` resolves no base for either, matching the dynamic reject.
	// Nested (subtree) operands (`nestable-flagged-set-ops`): data columns + own flags stay
	// writable-through-effect (`YES`); a SURFACED INNER flag (`inB`/`inC`) is read-only (`NO`) —
	// writing it addresses a branch inside a subtree (product-coordinate `set-op-membership-nested`).
	// Empty surfaced-inner set (the binary case) => all-`YES`, unchanged.
	if (isSetOpMembershipBody(selectAst) && isSetOpBranchWritable(selectAst)) {
		const innerFlags = new Set(surfacedInnerFlagNames(selectAst).map(n => n.toLowerCase()));
		return root.getAttributes().map((attr, i): ColumnInfoRow => ({
			schema: schemaName,
			objectName,
			cid: i,
			columnName: columnNames?.[i] ?? attr.name,
			isUpdatable: !innerFlags.has(attr.name.toLowerCase()),
			baseTable: null,
			baseColumn: null,
		}));
	}

	// Flag-less predicate-honest set-op body (`set-op-flagless-predicate-honest-writes`):
	// a plain (writable) data column reports `is_updatable = YES` (its data-column fan-out
	// writes the base column through every consistent leg); a literal **discriminator**
	// column reports `NO` (read-only — it routes rows and has no base inverse, surfacing
	// `no-inverse` on the dynamic write). Both with null base (no single base column). Gated
	// on the same shape recognizer as `deriveViewInfo`, so the static and dynamic answers
	// cannot drift.
	if (isSetOpFlaglessWritableBody(selectAst)) {
		const discriminators = new Set(flaglessDiscriminatorColumnNames(selectAst).map(n => n.toLowerCase()));
		return root.getAttributes().map((attr, i): ColumnInfoRow => ({
			schema: schemaName,
			objectName,
			cid: i,
			columnName: columnNames?.[i] ?? attr.name,
			isUpdatable: !discriminators.has(attr.name.toLowerCase()),
			baseTable: null,
			baseColumn: null,
		}));
	}

	// Non-decomposable join shape gate: cross / comma / subquery-source join bodies
	// are not write-through-able. `propagate()` decomposes an n-way (≥2) equi-join —
	// `inner`/`left`/`right`/`full` (RIGHT now admitted, the LEFT mirror; FULL self-conservatizes), composite-PK
	// sides and self-joins included
	// (`isDecomposableJoinBody`, the boolean shadow of `collectJoinSources`) — and
	// rejects every other join shape, so without this gate `baseSiteOf` would resolve
	// their bases and over-report `is_updatable = 'YES'`. Outer joins ARE decomposable
	// now; their non-preserved columns are reported updatable per-column below when a
	// preserved anchor exists (matching the dynamic matched-update / null-extended-insert
	// materialization), rather than short-circuiting the whole view to all-`NO`.
	const unsupportedJoinShape = isJoinBody(selectAst) && !isDecomposableJoinBody(selectAst);

	const tableRefsById = buildTableRefsById(nodes);
	const rootLineage = root.physical?.updateLineage;

	const attrs = root.getAttributes();
	// Whether the body exposes a PRESERVED base column — a preserved anchor that pins
	// each view row's identity. A LEFT join has one (the preserved side); a FULL outer
	// join (every column null-extended) does not, so a non-preserved update there stays
	// deferred. A non-preserved (`null-extended`) column is now updatable WHEN such an
	// anchor exists: the matched-update / null-extended-insert materialization keys off
	// it (`view-write-optional-member-transitions`), matching the dynamic accept.
	const hasPreservedBase = !unsupportedJoinShape && attrs.some(a => {
		const s = baseSiteOf(rootLineage?.get(a.id));
		return s !== undefined && !s.nullExtended;
	});

	const rows: ColumnInfoRow[] = [];
	for (let i = 0; i < attrs.length; i++) {
		const attr = attrs[i];
		const site = unsupportedJoinShape ? undefined : rootLineage?.get(attr.id);
		const bs = baseSiteOf(site);
		const ref = bs ? tableRefsById.get(bs.table) : undefined;
		// A join-side `exists … as` existence flag has NO base column but is writable
		// through an *effect* — its flip inserts/deletes the non-preserved side — when a
		// preserved anchor pins each row's identity (`outer-join-existence-column`).
		// Report it `is_updatable = 'YES'` with `base_table` / `base_column` = null (it
		// maps to no base column), matching the dynamic `propagate()` accept. Gated on a
		// preserved anchor like the non-preserved column: a FULL outer (none) stays
		// deferred. A `set-op-branch` existence flag is READ-ONLY in this read half
		// (`set-op-membership-read`) — it reports `is_updatable = 'NO'` with null base
		// (a set-op view has no preserved base anchor anyway); the write half flips it on.
		const isExistence = site?.kind === 'existence' && site.component.kind === 'join-side' && hasPreservedBase;
		// An authored (`with inverse`) column is writable (and insertable) through its
		// put expressions — report it updatable, with the base trace populated only
		// for a single-put inverse (a multi-target inverse maps to no single base
		// column, the same null-base shape an existence flag reports). Agrees with
		// the dynamic spines, which route authored sites on UPDATE and INSERT alike.
		const authored = site?.kind === 'authored' ? site : undefined;
		const authoredPutRef = authored && authored.puts.length === 1
			? tableRefsById.get(authored.puts[0].table)
			: undefined;
		// Updatable iff a base site resolves to a producing TableReferenceNode. A
		// PRESERVED base column is always updatable; a non-preserved (`null-extended`)
		// column is updatable when the body has a preserved anchor (the matched-update /
		// null-extended-insert materialization pins identity off it), and read-only only
		// when no anchor exists (a FULL outer — write-through stays deferred there). A
		// base id without a resolved ref should not happen; fail conservative if it does.
		const updatable = isExistence || authored !== undefined || !!(bs && ref && (!bs.nullExtended || hasPreservedBase));
		// Base trace is reported only for an actual base column write (an existence flag
		// is updatable but has no base mapping).
		const hasBaseTrace = updatable && bs !== undefined && ref !== undefined;
		rows.push({
			schema: schemaName,
			objectName,
			cid: i,
			columnName: columnNames?.[i] ?? attr.name,
			isUpdatable: updatable,
			baseTable: hasBaseTrace ? ref!.tableSchema.name : authoredPutRef ? authoredPutRef.tableSchema.name : null,
			baseColumn: hasBaseTrace ? bs!.baseColumn : authoredPutRef ? authored!.puts[0].baseColumn : null,
		});
	}
	return rows;
}

// Per-column updateability function (table-valued function)
export const columnInfoFunc = createIntegratedTableValuedFunction(
	{
		name: 'column_info',
		numArgs: 1,
		deterministic: false, // Schema (and therefore lineage) can change
		returnType: {
			typeClass: 'relation',
			isReadOnly: true,
			isSet: false,
			columns: [
				{ name: 'schema', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'name', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'cid', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'column_name', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'is_updatable', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'base_table', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'base_column', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true },
			],
			keys: [],
			rowConstraints: []
		},
		relationalAdvertisement: {
			isSet: true,
			// `cid` (column 2) is the column ordinal — unique per emitted row.
			keys: [[{ index: 2 }]],
		},
	},
	async function* (db: Database, tableName: SqlValue): AsyncIterable<Row> {
		if (typeof tableName !== 'string') {
			throw new QuereusError('column_info() requires a table or view name string argument', StatusCode.ERROR);
		}

		for (const r of deriveColumnInfo(db, tableName)) {
			yield [
				r.schema,
				r.objectName,
				r.cid,
				r.columnName,
				yesNo(r.isUpdatable),
				r.baseTable,
				r.baseColumn,
			] as Row;
		}
	}
);

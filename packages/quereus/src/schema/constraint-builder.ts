/**
 * Shared AST → constraint-schema builders plus the engine-level FK existing-row
 * validator. These are the single source of truth for turning a table-level
 * `ALTER TABLE … ADD <constraint>` (an `AST.TableConstraint`) into the
 * corresponding {@link UniqueConstraintSchema} / {@link ForeignKeyConstraintSchema},
 * reproducing the canonical mapping that {@link SchemaManager}'s
 * `extractUniqueConstraints` / `extractForeignKeys` table-level arms encode for
 * CREATE TABLE. Both the built-in modules (memory + store, via the
 * `@quereus/quereus` barrel) and the SchemaManager delegate here so the two
 * paths can never drift.
 *
 * Column resolution is always against the CHILD table's `columnIndexMap`
 * (`ALTER TABLE ADD CONSTRAINT` is always the table-level form). Parent-column
 * resolution for a FK stays deferred (the parent may not exist yet) exactly as
 * in the CREATE TABLE path.
 */

import type { Database } from '../core/database.js';
import type { TableSchema, UniqueConstraintSchema, ForeignKeyConstraintSchema, RowConstraintSchema } from './table.js';
import { resolveReferencedColumns, opsToMask, disambiguateAutoConstraintName } from './table.js';
import { QuereusError } from '../common/errors.js';
import { StatusCode, type SqlValue } from '../common/types.js';
import type * as AST from '../parser/ast.js';
import { quoteIdentifier, expressionToString } from '../emit/ast-stringify.js';
import { createLogger } from '../common/logger.js';
import { columnSchemaToScalarType } from '../planner/type-utils.js';
import { resolveComparisonCollation } from '../planner/analysis/comparison-collation.js';

const log = createLogger('schema:constraint-builder');

/**
 * Builds a {@link UniqueConstraintSchema} from a table-level UNIQUE
 * `AST.TableConstraint`, resolving each declared column name to its index in the
 * child table. Mirrors `SchemaManager.extractUniqueConstraints` (table-level arm).
 */
export function buildUniqueConstraintSchema(
	con: AST.TableConstraint,
	columnIndexMap: ReadonlyMap<string, number>,
): UniqueConstraintSchema {
	if (con.type !== 'unique' || !con.columns || con.columns.length === 0) {
		throw new QuereusError('UNIQUE constraint requires at least one column', StatusCode.ERROR);
	}
	const colIndices = con.columns.map(col => {
		const idx = columnIndexMap.get(col.name.toLowerCase());
		if (idx === undefined) {
			throw new QuereusError(`UNIQUE constraint column '${col.name}' not found`, StatusCode.ERROR);
		}
		return idx;
	});
	return {
		name: con.name,
		columns: Object.freeze(colIndices),
		defaultConflict: con.onConflict,
		tags: con.tags && Object.keys(con.tags).length > 0 ? Object.freeze({ ...con.tags }) : undefined,
	};
}

/**
 * Builds a {@link ForeignKeyConstraintSchema} from a table-level FOREIGN KEY
 * `AST.TableConstraint`, resolving child column names to indices and deferring
 * parent-column resolution (the parent table may not exist yet). Mirrors
 * `SchemaManager.extractForeignKeys` (table-level arm), including the
 * child/parent column-count mismatch error.
 *
 * `takenNames` is the CREATE TABLE path's statement-wide taken-set: when
 * provided, an unnamed FK's `_fk_<table>_<cols>` mint is disambiguated against —
 * and registered into — it (see `disambiguateAutoConstraintName`), so two
 * colliding mints in one declaration get distinct names. ALTER callers omit it
 * and keep the historical mint byte-identical.
 */
export function buildForeignKeyConstraintSchema(
	con: AST.TableConstraint,
	columnIndexMap: ReadonlyMap<string, number>,
	childTableName: string,
	childSchemaName: string,
	takenNames?: Set<string>,
): ForeignKeyConstraintSchema {
	if (con.type !== 'foreignKey' || !con.foreignKey || !con.columns) {
		throw new QuereusError('FOREIGN KEY constraint requires child columns and a REFERENCES clause', StatusCode.ERROR);
	}
	const fk = con.foreignKey;
	const childColIndices = con.columns.map(col => {
		const idx = columnIndexMap.get(col.name.toLowerCase());
		if (idx === undefined) {
			throw new QuereusError(`FK column '${col.name}' not found in table '${childTableName}'`, StatusCode.ERROR);
		}
		return idx;
	});

	const mintedName = `_fk_${childTableName}_${con.columns.map(c => c.name).join('_')}`;
	const fkName = con.name
		?? (takenNames !== undefined ? disambiguateAutoConstraintName(mintedName, takenNames) : mintedName);

	if (fk.columns && fk.columns.length !== childColIndices.length) {
		throw new QuereusError(
			`FK constraint '${fkName}' on table '${childTableName}': child column count (${childColIndices.length}) does not match parent column count (${fk.columns.length})`,
			StatusCode.ERROR,
		);
	}

	return {
		name: fkName,
		columns: Object.freeze(childColIndices),
		referencedTable: fk.table,
		referencedSchema: fk.schema ?? childSchemaName,
		referencedColumns: Object.freeze([]), // resolved at enforcement time
		referencedColumnNames: fk.columns, // deferred resolution via resolveReferencedColumns
		onDelete: fk.onDelete ?? 'restrict',
		onUpdate: fk.onUpdate ?? 'restrict',
		deferred: fk.initiallyDeferred ?? false,
		tags: con.tags && Object.keys(con.tags).length > 0 ? Object.freeze({ ...con.tags }) : undefined,
	};
}

/**
 * Builds a {@link RowConstraintSchema} from a table-level CHECK
 * `AST.TableConstraint` (the `ALTER TABLE … ADD CONSTRAINT … CHECK` form). The
 * single source of truth for that mapping, called by the built-in modules
 * (memory + store) so a CHECK added via ALTER lands in the *module-cached*
 * schema, in lock-step with the catalog — the same place inline-CREATE CHECKs
 * live and where `DROP/RENAME CONSTRAINT` later resolve the constraint class. An
 * unnamed CHECK is auto-named `check_<existingCount>`, preserving the engine's
 * prior in-emitter naming (`existingCount` = the number of CHECKs already on the
 * table). Determinism is intentionally NOT validated here — a CHECK may reference
 * `new.*`/`old.*`, which is checked at INSERT/UPDATE plan time.
 */
export function buildCheckConstraintSchema(
	con: AST.TableConstraint,
	existingCount: number,
): RowConstraintSchema {
	if (con.type !== 'check' || !con.expr) {
		throw new QuereusError('CHECK constraint requires an expression', StatusCode.ERROR);
	}
	return {
		name: con.name || `check_${existingCount}`,
		expr: con.expr,
		operations: opsToMask(con.operations),
		tags: con.tags && Object.keys(con.tags).length > 0 ? Object.freeze({ ...con.tags }) : undefined,
	};
}

/* ──────────────── ALTER TABLE ADD COLUMN inline constraints ────────────────
 * A constraint written inline on an added column (`add column c int unique`,
 * `… check (c > 0)`, `… references p(pid)`) has no table-level AST of its own, so
 * these three extractors synthesize the equivalent table-level
 * {@link AST.TableConstraint} over the new column. The emitter hands each to
 * `module.alterTable({ type: 'addConstraint', constraint })` — the very path
 * `ALTER TABLE … ADD CONSTRAINT` uses — so the MODULE ends up owning the
 * constraint, exactly as it owns one declared in CREATE TABLE.
 *
 * That ownership is what makes the constraint durable. Every later structural
 * ALTER (DROP COLUMN, RENAME COLUMN, …) asks the module for the new table schema
 * and installs the module's answer in the catalog verbatim; a constraint merged
 * only into the engine's catalog copy is silently dropped by the next one.
 */

/**
 * Extracts the column-level CHECK constraints declared on a single `ALTER TABLE
 * ADD COLUMN` ColumnDef into the equivalent table-level constraints.
 *
 * An unnamed CHECK is named `_check_<column>` HERE rather than left to
 * {@link buildCheckConstraintSchema} (which would auto-name it `check_<n>`,
 * the table-level `ADD CONSTRAINT` convention): the inline-CREATE-TABLE spelling
 * of the same declaration is named `_check_<column>`, and the two paths must agree.
 *
 * `takenNames` (when provided) is the disambiguation set the CREATE TABLE mint
 * sites share — the table's existing constraint names plus this statement's
 * user-written inline names — so two unnamed CHECKs on one new column (legal;
 * see `assertInlineConstraintNamesFree`) mint `_check_<col>` / `_check_<col>_2`
 * exactly as the CREATE TABLE spelling does, instead of two constraints one
 * name addresses. The mint is registered into the set as it is chosen.
 */
export function extractColumnLevelCheckConstraints(columnDef: AST.ColumnDef, takenNames?: Set<string>): AST.TableConstraint[] {
	const result: AST.TableConstraint[] = [];
	for (const con of columnDef.constraints ?? []) {
		if (con.type !== 'check' || !con.expr) continue;
		const mint = `_check_${columnDef.name}`;
		result.push({
			type: 'check',
			name: con.name ?? (takenNames !== undefined ? disambiguateAutoConstraintName(mint, takenNames) : mint),
			expr: con.expr,
			operations: con.operations,
			tags: con.tags,
		});
	}
	return result;
}

/**
 * Extracts the column-level FOREIGN KEY constraints declared on a single `ALTER
 * TABLE ADD COLUMN` ColumnDef into the equivalent table-level constraints over
 * the new column.
 *
 * The name is left unset for an unnamed FK so {@link buildForeignKeyConstraintSchema}
 * applies its `_fk_<table>_<column>` convention — the same name the inline-CREATE-TABLE
 * spelling produces.
 *
 * The single-child-column count match against the parent column list is enforced
 * here, ahead of the builder's identical check, so a malformed declaration is
 * rejected *before* the column is materialized rather than after.
 */
export function extractColumnLevelForeignKeys(columnDef: AST.ColumnDef): AST.TableConstraint[] {
	const result: AST.TableConstraint[] = [];
	for (const con of columnDef.constraints ?? []) {
		if (con.type !== 'foreignKey' || !con.foreignKey) continue;
		const fk = con.foreignKey;
		if (fk.columns && fk.columns.length !== 1) {
			throw new QuereusError(
				`FOREIGN KEY${con.name ? ` '${con.name}'` : ''} on ADD COLUMN '${columnDef.name}': `
					+ `child column count (1) does not match parent column count (${fk.columns.length})`,
				StatusCode.ERROR,
			);
		}
		result.push({
			type: 'foreignKey',
			name: con.name,
			columns: [{ name: columnDef.name }],
			foreignKey: fk,
			tags: con.tags,
		});
	}
	return result;
}

/**
 * Extracts the column-level UNIQUE constraints declared on a single `ALTER TABLE
 * ADD COLUMN` ColumnDef into the equivalent table-level constraints over the new
 * column.
 *
 * The synthetic constraint preserves a named inline UNIQUE's name (so it
 * round-trips), `ON CONFLICT`, and tags. `buildUniqueConstraintSchema` reads only
 * those fields plus `columns[].name`, so no `operations` / `direction` is emitted.
 * Each inline `unique` ColumnConstraint becomes its own single-column table
 * constraint over `columnDef.name` (multiple are rare but handled like CHECK / FK).
 */
export function extractColumnLevelUniqueConstraints(columnDef: AST.ColumnDef): AST.TableConstraint[] {
	const result: AST.TableConstraint[] = [];
	for (const con of columnDef.constraints ?? []) {
		if (con.type !== 'unique') continue;
		result.push({
			type: 'unique',
			name: con.name,
			columns: [{ name: columnDef.name }],
			onConflict: con.onConflict,
			tags: con.tags,
		});
	}
	return result;
}

/** Qualify a relation reference, eliding the `main.` prefix (the default schema). */
function qualifyRelation(schemaName: string, tableName: string): string {
	const prefix = schemaName.toLowerCase() !== 'main' ? `${quoteIdentifier(schemaName)}.` : '';
	return `${prefix}${quoteIdentifier(tableName)}`;
}

/* ──────────────── maintained-table derived-row attribution ────────────────
 * A maintained table's rows are written by its derivation, so a declared
 * CHECK / FK violation surfaces on a statement that targeted a DIFFERENT table
 * (a source write, or the create/attach statement). These two helpers produce
 * the table-attributed diagnostic both validation mechanisms share — the bulk
 * SQL-scan validators (create-fill / attach reconcile) and the per-row
 * maintenance evaluator (`core/derived-row-validator.ts`). The leading
 * `CHECK constraint failed:` / `FOREIGN KEY constraint failed:` prefixes are
 * load-bearing: existing assertions and downstream consumers key off them
 * (see `runtime/row-constraints.ts`). */

/** Attributed CHECK diagnostic for a row the derivation wrote into a maintained table. */
export function maintainedTableCheckViolationError(
	schemaName: string,
	tableName: string,
	constraintName: string,
	exprHint?: string,
): QuereusError {
	const hint = exprHint && exprHint.length <= 60 ? ` (${exprHint})` : '';
	return new QuereusError(
		`CHECK constraint failed: ${constraintName}${hint} — row derived into maintained table `
			+ `'${schemaName}.${tableName}' violates its declared constraint`,
		StatusCode.CONSTRAINT,
	);
}

/** Attributed child-side FK diagnostic for a row the derivation wrote into a maintained table. */
export function maintainedTableFkViolationError(
	schemaName: string,
	tableName: string,
	constraintName: string,
	parentSchemaName: string,
	parentTableName: string,
): QuereusError {
	return new QuereusError(
		`FOREIGN KEY constraint failed: ${constraintName} — row derived into maintained table `
			+ `'${schemaName}.${tableName}' references a missing '${parentSchemaName}.${parentTableName}'`,
		StatusCode.CONSTRAINT,
	);
}

/** Renders one constrained-column value for a key-collision diagnostic. */
export function formatKeyValue(v: SqlValue): string {
	if (v === null || v === undefined) return 'null';
	if (typeof v === 'string') return `'${v}'`;
	if (v instanceof Uint8Array) return `x'…'`;
	return String(v);
}

/**
 * Attributed secondary-UNIQUE diagnostic for rows the derivation wrote into a
 * maintained table. Unlike CHECK / FK (per-row properties), a UNIQUE collision
 * is a property of a PAIR of rows at distinct primary keys, so the diagnostic
 * names the colliding key values. Thrown by the backing hosts' post-batch
 * maintenance enforcement (memory `enforceSecondaryUniqueOnMaintenance`, store
 * `enforceSecondaryUniqueForMaintenance`) — see `vtab/backing-host.ts`
 * § Constraint validation.
 */
export function maintainedTableUniqueViolationError(
	schemaName: string,
	tableName: string,
	constraintName: string,
	columnNames: readonly string[],
	keyValues: readonly SqlValue[],
): QuereusError {
	return new QuereusError(
		`UNIQUE constraint failed: ${constraintName} (${columnNames.join(', ')}) — row derived into maintained table `
			+ `'${schemaName}.${tableName}' collides on its declared UNIQUE constraint (key: ${keyValues.map(formatKeyValue).join(', ')})`,
		StatusCode.CONSTRAINT,
	);
}

/**
 * Validates a table's EXISTING (effective, pending-over-committed) rows against
 * each CHECK in `checks`, throwing on the first violating row. The table-wide
 * sibling of the ADD-COLUMN backfill scan (`validateBackfillAgainstChecks` in
 * `runtime/emit/alter-table.ts`): one `select 1 from <t> where not (<expr>)
 * limit 1` scan per CHECK, so the NULL-pass rule falls out of SQL semantics
 * (`not NULL` is NULL — the row is not a violation). A subquery-bearing CHECK
 * is just SQL here; the scan reads final pending state.
 *
 * CAUTION — declared-constraint folding: the optimizer trusts a DECLARED CHECK
 * as a proven domain invariant, so if the LIVE catalog entry for `tableSchema`
 * still declares the CHECK being validated, `ruleFilterContradiction` folds the
 * `where not (<expr>)` scan to EmptyRelation and the validation vacuously
 * passes. Callers must scan against a live record that does NOT declare the
 * constraints under validation (see the stripped-schema swap in
 * `runtime/emit/materialized-view-helpers.ts`, mirroring the ADD COLUMN
 * intermediate-schema discipline).
 */
export async function validateChecksOverExistingRows(
	db: Database,
	tableSchema: TableSchema,
	checks: ReadonlyArray<RowConstraintSchema>,
	onViolation?: (check: RowConstraintSchema, exprSql: string) => QuereusError,
): Promise<void> {
	const tableRef = qualifyRelation(tableSchema.schemaName, tableSchema.name);
	for (const check of checks) {
		const exprSql = expressionToString(check.expr);
		const sql = `select 1 from ${tableRef} where not (${exprSql}) limit 1`;
		log('CHECK existing-row validation for %s.%s: %s', tableSchema.schemaName, tableSchema.name, sql);
		const stmt = db.prepare(sql);
		// The CHECK is SCHEMA-AUTHORED, so a bare relation name inside it means the OWNING
		// table's schema — not the session path this freshly-prepared scan would otherwise
		// inherit. Owning schema only, matching `schemaAuthoredContext`
		// (planner/building/schema-authored-context.ts), which decides the same thing for
		// every CHECK the DML builders compile.
		stmt._schemaPathOverride = [tableSchema.schemaName];
		try {
			for await (const _row of stmt._iterateRowsRaw()) {
				throw onViolation?.(check, exprSql) ?? new QuereusError(
					`CHECK constraint failed: ${check.name ?? exprSql} — existing rows in '${tableSchema.name}' violate the constraint`,
					StatusCode.CONSTRAINT,
				);
			}
		} finally {
			await stmt.finalize();
		}
	}
}

/**
 * Validates every existing CHILD row against a newly-added FOREIGN KEY,
 * throwing `StatusCode.CONSTRAINT` if any row references a non-existent parent.
 *
 * Engine-level and backend-agnostic: it reads committed/base data through
 * `db.prepare` + scan (which does not take any module schema-change latch, so it
 * is safe to call while a module holds its own schema-change lock). No-op when
 * `pragma foreign_keys` is off.
 *
 * MATCH SIMPLE semantics: a child row with ANY NULL FK column is allowed
 * regardless of the parent, so only fully-non-NULL orphans abort. When the
 * parent table is absent, no fully-non-NULL child row can be satisfied, so any
 * such row is an orphan (mirrors the child-side builder's null-guards-only
 * fallback in `planner/building/foreign-key-builder.ts`).
 *
 * `onViolation` overrides the default diagnostic — the maintained-table
 * derivation validator threads its table-attributed message through here.
 * Note the declared-constraint folding caveat on
 * {@link validateChecksOverExistingRows}: if the live child record already
 * declares this FK (it does NOT on the ADD COLUMN / ADD CONSTRAINT paths, but
 * DOES on the maintained-table path), the caller must scan against a
 * constraint-stripped record or `ruleAntiJoinFkEmpty` folds the anti-join away.
 */
export async function validateForeignKeyOverExistingRows(
	db: Database,
	childSchema: TableSchema,
	fk: ForeignKeyConstraintSchema,
	onViolation?: () => QuereusError,
): Promise<void> {
	if (!db.options.getBooleanOption('foreign_keys')) return;

	const childRef = qualifyRelation(childSchema.schemaName, childSchema.name);
	const childAlias = '_c';
	// MATCH SIMPLE: only rows where every FK column is non-NULL can violate.
	const notNullChain = fk.columns
		.map(idx => `${childAlias}.${quoteIdentifier(childSchema.columns[idx].name)} is not null`)
		.join(' and ');

	const parentSchemaName = fk.referencedSchema ?? childSchema.schemaName;
	const parentTable = db.schemaManager.findTable(fk.referencedTable, parentSchemaName);

	let sql: string;
	if (!parentTable) {
		// Parent absent: any fully-non-NULL child row references a non-existent parent.
		sql = `select 1 from ${childRef} as ${childAlias} where ${notNullChain} limit 1`;
	} else {
		const parentColIndices = resolveReferencedColumns(fk, parentTable);
		if (parentColIndices.length !== fk.columns.length) {
			throw new QuereusError(
				`FK constraint '${fk.name ?? `_fk_${childSchema.name}`}' on table '${childSchema.name}': child column count (${fk.columns.length}) does not match parent column count (${parentColIndices.length})`,
				StatusCode.ERROR,
			);
		}
		const parentRef = qualifyRelation(parentTable.schemaName, parentTable.name);
		const parentAlias = '_p';
		// Aliases keep the correlation unambiguous even for a self-referencing FK
		// (child table === parent table).
		const matchChain = fk.columns
			.map((childIdx, i) =>
				`${parentAlias}.${quoteIdentifier(parentTable.columns[parentColIndices[i]].name)} = ${childAlias}.${quoteIdentifier(childSchema.columns[childIdx].name)}`)
			.join(' and ');
		// `not exists` correlated subquery: a fully-non-NULL child row with no matching
		// parent is an orphan. (The decorrelator may turn this into an anti-join; that is
		// fine — the ADD COLUMN path deliberately validates against a live schema that does
		// NOT yet declare the new FK, so `ruleAntiJoinFkEmpty` has no FK to fold against.)
		sql = `select 1 from ${childRef} as ${childAlias} `
			+ `where ${notNullChain} `
			+ `and not exists (select 1 from ${parentRef} as ${parentAlias} where ${matchChain}) limit 1`;
	}

	log('FK existing-row validation for %s.%s: %s', childSchema.schemaName, childSchema.name, sql);

	const stmt = db.prepare(sql);
	try {
		for await (const _row of stmt._iterateRowsRaw()) {
			if (onViolation) throw onViolation();
			const colNames = fk.columns.map(idx => childSchema.columns[idx].name).join(', ');
			throw new QuereusError(
				`FOREIGN KEY constraint failed: ${childSchema.name} (${colNames}) has rows referencing a missing '${fk.referencedTable}'`,
				StatusCode.CONSTRAINT,
			);
		}
	} finally {
		await stmt.finalize();
	}
}

/**
 * Rejects a FOREIGN KEY whose child column and parent key column declare
 * conflicting explicit/declared collations — the same conflict the synthesized
 * `parent.ref = child.fk` enforcement comparison raises at plan time, surfaced
 * here at declaration time (CREATE TABLE / ALTER ADD CONSTRAINT / ADD COLUMN /
 * declarative apply). Pure schema check (no row scan).
 *
 * Stays in lockstep with enforcement by construction: it maps each column to a
 * `ScalarType` through {@link columnSchemaToScalarType} (the same map the FK
 * builder's comparison uses — `collationExplicit` → provenance `'declared'`,
 * else `'default'`) and resolves the pair through the same
 * {@link resolveComparisonCollation} lattice. So it fires on exactly the
 * conflicts the first DML against the child would, only sooner — never a
 * re-derived textuality- or name-based rule.
 *
 * Resolution rules (consequences of staying in lockstep, intended):
 *  - matching declared collations (nocase/nocase) resolve, no conflict;
 *  - one-sided declaration (declared nocase vs defaulted BINARY) resolves to
 *    NOCASE — a defaulted BINARY is the engine floor, it contributes nothing;
 *  - a *declared* `COLLATE BINARY` (rank 2) vs a declared NOCASE conflicts;
 *  - a divergent explicit COLLATE on non-text columns still conflicts — we
 *    mirror enforcement exactly rather than gating on textuality.
 *
 * The parent is resolved against the live catalog; a not-yet-created
 * (forward-declared) parent is skipped — its column types are unknown, so the
 * conflict cannot be seen yet and remains caught at first DML (the one
 * unavoidable residual). A self-referencing FK resolves against `childSchema`
 * directly so it validates at CREATE, before the table is registered.
 *
 * Unconditional — NOT gated on `pragma foreign_keys`. A conflicting-collation
 * declaration is a malformed declaration (same class as the child/parent
 * column-count mismatch the builders reject unconditionally), not an
 * enforcement concern, so a contradictory schema is rejected whether or not
 * enforcement is currently enabled.
 */
export function validateForeignKeyCollations(
	db: Database,
	childSchema: TableSchema,
	fk: ForeignKeyConstraintSchema,
): void {
	// Resolve the parent. A self-referencing FK names `childSchema` itself; resolve
	// it directly so the check fires at CREATE (the table is not yet registered).
	const parentSchemaName = fk.referencedSchema ?? childSchema.schemaName;
	const selfRef = fk.referencedTable.toLowerCase() === childSchema.name.toLowerCase()
		&& parentSchemaName.toLowerCase() === childSchema.schemaName.toLowerCase();
	const parent = selfRef
		? childSchema
		: db.schemaManager.findTable(fk.referencedTable, parentSchemaName);
	// Forward-declared parent: column types unknown — conflict stays caught at first DML.
	if (!parent) return;

	let parentColIndices: number[];
	try {
		parentColIndices = resolveReferencedColumns(fk, parent);
	} catch {
		// A missing referenced column is reported by the enforcement path; don't double-report.
		return;
	}
	// A child/parent column-count mismatch is already raised by the builders.
	if (parentColIndices.length !== fk.columns.length) return;

	for (let i = 0; i < fk.columns.length; i++) {
		const childCol = childSchema.columns[fk.columns[i]];
		const parentCol = parent.columns[parentColIndices[i]];
		const res = resolveComparisonCollation(
			columnSchemaToScalarType(childCol),
			columnSchemaToScalarType(parentCol),
		);
		if (res.kind === 'conflict') {
			throw new QuereusError(
				`FOREIGN KEY '${fk.name ?? `_fk_${childSchema.name}`}' on '${childSchema.name}': `
				+ `child column '${childSchema.name}.${childCol.name}' (collation ${childCol.collation}) `
				+ `and parent column '${parent.name}.${parentCol.name}' (collation ${parentCol.collation}) `
				+ `declare conflicting collations; declare a matching COLLATE on both sides.`,
				StatusCode.ERROR,
			);
		}
	}
}

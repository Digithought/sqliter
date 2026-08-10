import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import { CreateTableNode } from '../nodes/create-table-node.js';
import { CreateIndexNode } from '../nodes/create-index-node.js';
import { validateReservedTags } from '../../schema/reserved-tags.js';
import { columnTagDiagnostics, raiseStmtTagDiagnostics } from './tag-diagnostics.js';
import { planViewBody } from './create-view.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';

export function buildCreateTableStmt(
	context: PlanningContext,
	stmt: AST.CreateTableStmt,
): CreateTableNode {
	// Reject a misspelled / mis-sited reserved `quereus.*` tag at build time so the
	// direct CREATE path fails as loudly as ALTER ... SET TAGS and the declarative
	// differ — a typo can't be silently stored on the most common authoring path.
	raiseCreateTableTagDiagnostics(stmt);
	if (stmt.maintained) {
		raiseCreateMaintainedDiagnostics(context, stmt);
	}
	return new CreateTableNode(
		context.scope,
		stmt,
	);
}

/**
 * Build-time gates for the declared-shape maintained form, `create table …
 * maintained as <body>`: the body must be relational and non-DML (the CREATE
 * VIEW gate, same diagnostics as the MV sugar), its arity must match the
 * declared column count, the hosting module must implement the backing-host
 * capability, and the declared shape may not carry generated columns (the body
 * supplies every column's value — a generated column would silently diverge
 * from its expression). The full positional shape check (names / types /
 * collations / physical PK) runs in the emitter against the derived shape,
 * BEFORE any catalog registration.
 */
function raiseCreateMaintainedDiagnostics(context: PlanningContext, stmt: AST.CreateTableStmt): void {
	const tableName = stmt.table.name;
	// The body plans under the table's home-schema path (same landing rule as the
	// CREATE TABLE emitter: explicit qualifier, else the current schema) so its
	// unqualified source names resolve next to the maintained table.
	const sm = context.db.schemaManager;
	const homeSchemaName = stmt.table.schema ? sm.canonicalSchemaName(stmt.table.schema) : sm.getCurrentSchemaName();
	const planned = planViewBody(context, tableName, stmt.maintained!.select, homeSchemaName);
	const bodyArity = planned.getAttributes().length;
	if (bodyArity !== stmt.columns.length) {
		throw new QuereusError(
			`cannot create maintained table '${tableName}': body produces ${bodyArity} columns but the table declares ${stmt.columns.length}`,
			StatusCode.ERROR,
			undefined,
			stmt.table.loc?.start.line,
			stmt.table.loc?.start.column,
		);
	}
	// The optional `maintained (columns)` rename list is the authoritative output-name
	// vector (presence ⇒ explicit / arity-locked). It must positionally match the
	// declared columns — same length, same names case-insensitively — so the recorded
	// `derivation.columns` (declared casing) regenerates byte-identical canonical DDL
	// and a mismatched list can never be silently dropped at live exec.
	raiseMaintainedColumnListDiagnostics(stmt, tableName);
	const generated = stmt.columns.find(c => c.constraints?.some(con => con.type === 'generated'));
	if (generated) {
		throw new QuereusError(
			`cannot create maintained table '${tableName}': column '${generated.name}' is generated — a maintained table's columns are all derived by the body`,
			StatusCode.ERROR,
			undefined,
			stmt.table.loc?.start.line,
			stmt.table.loc?.start.column,
		);
	}
	// Resolve the hosting module exactly as CREATE TABLE will (the `using`
	// clause, else the session default) and require the backing-host capability.
	const moduleName = stmt.moduleName ?? sm.getDefaultVTabModuleName();
	const moduleInfo = sm.getModule(moduleName);
	if (!moduleInfo?.module) {
		throw new QuereusError(
			`no virtual table module named '${moduleName}'`,
			StatusCode.ERROR,
			undefined,
			stmt.table.loc?.start.line,
			stmt.table.loc?.start.column,
		);
	}
	if (!moduleInfo.module.getBackingHost) {
		throw new QuereusError(
			`cannot create maintained table '${tableName}': module '${moduleName}' cannot host a maintained table (it does not implement the backing-host capability)`,
			StatusCode.UNSUPPORTED,
			undefined,
			stmt.table.loc?.start.line,
			stmt.table.loc?.start.column,
		);
	}
}

/**
 * Validates the optional `maintained (columns)` rename list against the declared
 * column layout: the list (when present) must have one entry per declared column
 * and each entry must match the declared column name at the same position
 * (case-insensitive). A length or name mismatch is a sited error — this is what
 * kills the silent-drop hazard (a `maintained (x, y)` on a `(id, v)` table can no
 * longer succeed live discarding the authored list). The empty list is already
 * rejected at parse time, so `columns` here is either absent or non-empty.
 */
function raiseMaintainedColumnListDiagnostics(stmt: AST.CreateTableStmt, tableName: string): void {
	const list = stmt.maintained!.columns;
	if (!list) return;
	if (list.length !== stmt.columns.length) {
		throw new QuereusError(
			`cannot create maintained table '${tableName}': the maintained column list has ${list.length} columns but the table declares ${stmt.columns.length}`,
			StatusCode.ERROR,
			undefined,
			stmt.table.loc?.start.line,
			stmt.table.loc?.start.column,
		);
	}
	for (let i = 0; i < list.length; i++) {
		if (list[i].toLowerCase() !== stmt.columns[i].name.toLowerCase()) {
			throw new QuereusError(
				`cannot create maintained table '${tableName}': maintained column ${i + 1} is named '${list[i]}' but the table declares '${stmt.columns[i].name}' (the maintained rename list must match the declared column names)`,
				StatusCode.ERROR,
				undefined,
				stmt.table.loc?.start.line,
				stmt.table.loc?.start.column,
			);
		}
	}
}

export function buildCreateIndexStmt(
	context: PlanningContext,
	stmt: AST.CreateIndexStmt
): CreateIndexNode {
	// Index-level WITH TAGS validates at the physical-index site (mirrors the differ).
	raiseStmtTagDiagnostics(validateReservedTags(stmt.tags, 'physical-index'), stmt);
	return new CreateIndexNode(
		context.scope,
		stmt
	);
}

/**
 * Validate the four reserved-tag surfaces of a direct CREATE TABLE — table-level
 * `WITH TAGS`, each column's tags, each inline column constraint's tags, and each
 * table-level (named or unnamed) constraint's tags — at their matching physical
 * sites, mirroring the declarative differ (`schema-differ.ts`). The per-column legs
 * (a column's own tags + its inline constraints' tags) come from the shared
 * {@link columnTagDiagnostics} helper, which the ALTER … ADD COLUMN path reuses so the
 * two authoring surfaces never drift. Diagnostics accumulate table → per-column →
 * table-constraints and raise once via the shared policy (first error wins).
 */
function raiseCreateTableTagDiagnostics(stmt: AST.CreateTableStmt): void {
	const diagnostics = [
		...validateReservedTags(stmt.tags, 'physical-table'),
		...stmt.columns.flatMap(columnTagDiagnostics),
		...(stmt.constraints ?? []).flatMap(c => validateReservedTags(c.tags, 'physical-constraint')),
	];
	raiseStmtTagDiagnostics(diagnostics, stmt);
}

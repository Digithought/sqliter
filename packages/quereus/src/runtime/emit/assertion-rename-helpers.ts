import type { Database } from '../../core/database.js';
import type * as AST from '../../parser/ast.js';
import type { Schema } from '../../schema/schema.js';
import type { AssertionDependentTable, IntegrityAssertionSchema } from '../../schema/assertion.js';
import { buildAssertionViolationSql } from '../../schema/assertion.js';
import { renameTableInAst, renameColumnInAst } from '../../schema/rename-rewriter.js';
import type { ResolveColumnInSource } from '../../schema/rename-rewriter.js';
import { createLogger } from '../../common/logger.js';

const log = createLogger('runtime:emit:assertion-rename');

// NOTE: both passes walk only the renamed object's OWN schema — the same scope the
// plain-view and materialized-view loops in `alter-table.ts` use. An assertion's
// stored body resolves unqualified table names against the assertion's own schema
// first (`Database._homeSchemaPath`), so an unqualified `t` inside an assertion
// living in some other schema does not necessarily mean the renamed table, and
// rewriting it would be a false positive. The converse gap — an assertion that names
// the renamed table with an explicit `<other schema>.<table>` qualifier is NOT
// rewritten — is real, and shared verbatim with views and materialized views; it is
// tracked by `bug-rename-not-propagated-across-schemas`, which fixes all three object
// kinds with one "explicitly-qualified references only" rewriter mode.

/**
 * Rewrites every assertion in `schema` after a source TABLE RENAME — the assertion
 * mirror of the plain-view loop in `propagateTableRenameInSchema` (same same-schema
 * gate at the caller, same in-place `renameTableInAst` walk over a body that owns its
 * own FROM scopes).
 *
 * On a changed body the derived `violationSql` is regenerated from the rewritten
 * expression (the commit-time evaluator re-parses that text, so it is the field that
 * actually carries the rename into enforcement), `dependentTables` is string-mapped
 * old base → new base, and the record is re-registered through
 * {@link Database.schemaManager} so `assertion_modified` fires — which is what
 * invalidates the optimizer's assertion-hoist cache.
 */
export function propagateTableRenameToAssertions(
	db: Database,
	schema: Schema,
	renamedSchemaName: string,
	oldName: string,
	newName: string,
): void {
	const schemaLower = renamedSchemaName.toLowerCase();
	const oldBase = `${schemaLower}.${oldName.toLowerCase()}`;
	const newBase = `${schemaLower}.${newName.toLowerCase()}`;
	for (const assertion of Array.from(schema.getAllAssertions())) {
		const check = assertion.checkExpression;
		if (!check) continue;
		if (!renameTableInAst(check, oldName, newName, renamedSchemaName)) continue;
		reregisterRewrittenAssertion(db, schema, assertion, check,
			remapDependentTables(assertion.dependentTables, oldBase, newBase));
	}
}

/**
 * Rewrites every assertion in `schema` after a source COLUMN RENAME — the assertion
 * mirror of the plain-view loop in `propagateColumnRenameInSchema`.
 *
 * `renameColumnInAst` (unseeded) is the correct entry point, not
 * `renameColumnInCheckExpression`: an assertion body is a full expression that owns
 * its own FROM scopes (`not exists (select … from t …)`), so there is no implicit
 * binding to an owning table to seed. `resolveColumnInSource` keeps that scope walk
 * catalog-aware for the same reason the view-body loop threads it — an unqualified
 * ref binding to a like-named column on an inner subquery's own FROM must not be
 * false-captured.
 *
 * `dependentTables` is keyed by base table, so a column rename leaves it untouched.
 */
export function propagateColumnRenameToAssertions(
	db: Database,
	schema: Schema,
	renamedSchemaName: string,
	tableName: string,
	oldCol: string,
	newCol: string,
	resolveColumnInSource: ResolveColumnInSource,
): void {
	for (const assertion of Array.from(schema.getAllAssertions())) {
		const check = assertion.checkExpression;
		if (!check) continue;
		if (!renameColumnInAst(check, tableName, oldCol, newCol, renamedSchemaName, resolveColumnInSource)) continue;
		reregisterRewrittenAssertion(db, schema, assertion, check, assertion.dependentTables);
	}
}

/**
 * Swaps the rewritten assertion into the catalog. The CHECK expression AST was
 * already mutated in place by the caller's walker, mirroring how the view loop
 * treats `selectAst` — `oldObject` on the emitted event therefore shares the
 * rewritten AST (only the derived fields differ), which no consumer reads.
 *
 * Registration goes through `SchemaManager.addAssertion` rather than
 * `Schema.addAssertion` because only the former fires `assertion_modified`.
 *
 * NOTE: an assertion with no `checkExpression` (the schema field is optional, for
 * assertions reconstructed from persisted `violationSql` alone) is skipped by both
 * callers — there is no AST to walk. Unreachable today: nothing persists assertions
 * (`CatalogObjectKind` is `'view' | 'materializedView' | 'table'` and no store module
 * has an assertion catalog path), so every live assertion came from
 * `CREATE ASSERTION` and carries its expression. If an assertion-reconstruction path
 * is ever added, this pass needs a re-parse arm or those assertions break on rename.
 */
function reregisterRewrittenAssertion(
	db: Database,
	schema: Schema,
	assertion: IntegrityAssertionSchema,
	check: AST.Expression,
	dependentTables: AssertionDependentTable[] | undefined,
): void {
	const updated: IntegrityAssertionSchema = {
		...assertion,
		violationSql: buildAssertionViolationSql(check),
		dependentTables,
	};
	db.schemaManager.addAssertion(schema.name, updated);
	log('Rewrote assertion %s.%s for rename: %s', schema.name, assertion.name, updated.violationSql);
}

/**
 * Re-keys the informational `dependentTables` entries naming the renamed base.
 * Purely cosmetic (it feeds `assertion_info().dependent_tables`) — the commit-time
 * evaluator recomputes its own base set when it compiles the body. Deliberately a
 * string map rather than a re-plan of the rewritten body: this runs mid-DDL, where a
 * planning failure would be a new failure mode for no enforcement benefit.
 */
function remapDependentTables(
	deps: AssertionDependentTable[] | undefined,
	oldBase: string,
	newBase: string,
): AssertionDependentTable[] | undefined {
	if (!deps) return deps;
	let changed = false;
	const mapped = deps.map(dep => {
		if (dep.base !== oldBase) return dep;
		changed = true;
		// relationKey is `<base>#<nodeId>`; a base never contains '#'.
		const hash = dep.relationKey.indexOf('#');
		return {
			relationKey: hash >= 0 ? `${newBase}${dep.relationKey.slice(hash)}` : newBase,
			base: newBase,
		};
	});
	return changed ? mapped : deps;
}

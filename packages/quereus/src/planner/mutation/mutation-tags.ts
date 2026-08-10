import type * as AST from '../../parser/ast.js';
import type { SqlValue } from '../../common/types.js';
import { createLogger } from '../../common/logger.js';
import { validateReservedTags, type TagDiagnostic } from '../../schema/reserved-tags.js';
import { raiseReservedTagDiagnostics } from '../../schema/reserved-tags-policy.js';
import type { MutableViewLike } from './single-source.js';

const log = createLogger('mutation:tags');

/**
 * Reserved-tag **validation at the view-mutation boundary** — the `'view-ddl'`
 * site only. No reserved tag carries view-mutation behavior anymore — write
 * *routing* is per-row writable presence/membership columns (the outer-join
 * existence column and the set-op membership columns), and omitted-insert
 * *defaults* are the first-class `with defaults (col = expr, …)` body-select clause
 * (which retired the last `quereus.update.*` key, `default_for.<column>`). What
 * remains here is the guard: a typo'd or mis-sited `quereus.*` key declared on
 * the mutated view/MV must still fail loudly at mutation time — view-DDL tag
 * validation is lazy, so a stray reserved key on the view itself only surfaces
 * when the view is written through.
 *
 * Statement-level tags (`INSERT`/`UPDATE`/`DELETE … WITH TAGS`, on `stmt.tags`)
 * are NOT validated here: every DML statement — base-table, view-mediated, or
 * nested — validates its own tags at the `'dml-stmt'` site at the entry of
 * `buildInsertStmt`/`buildUpdateStmt`/`buildDeleteStmt` (via the shared
 * `building/tag-diagnostics.ts` helper), before the view dispatch is reached.
 * By the time this runs, the statement's own tags are already proven clean.
 */

/** The mutating statement's location, siting the view-ddl diagnostic. */
type TaggedStmt = Pick<AST.InsertStmt, 'loc'>;

/**
 * Validate the mutated view's reserved tags at the `'view-ddl'` site. A
 * `severity:'error'` diagnostic (unknown key, mis-sited key, malformed value)
 * is raised as a **sited** {@link QuereusError} carrying the statement's
 * line/column; `severity:'warning'` diagnostics are logged. A no-tags view
 * short-circuits (the common case — the propagation cost is unchanged).
 */
export function validateMutationTags(view: MutableViewLike, stmt: TaggedStmt): void {
	const viewTags = view.tags;
	if (!viewTags || Object.keys(viewTags).length === 0) {
		return;
	}
	raiseTagDiagnostics(validateReservedTags(viewTags as Record<string, SqlValue>, 'view-ddl'), view, stmt);
}

/**
 * Raise the first error diagnostic as a sited error; log any warnings. Threads
 * the statement location + the view-context prefix into the shared caller-policy
 * helper ({@link raiseReservedTagDiagnostics}).
 */
function raiseTagDiagnostics(diagnostics: TagDiagnostic[], view: MutableViewLike, stmt: TaggedStmt): void {
	raiseReservedTagDiagnostics(diagnostics, {
		messagePrefix: `view '${view.schemaName}.${view.name}' declares an invalid tag — `,
		loc: { line: stmt.loc?.start.line, column: stmt.loc?.start.column },
		log: (diag) => log('tag advisory (%s) on view-ddl %s.%s: %s', diag.reason, view.schemaName, view.name, diag.message),
	});
}

import type * as AST from '../../parser/ast.js';
import { validateReservedTags, type TagDiagnostic } from '../../schema/reserved-tags.js';
import { raiseReservedTagDiagnostics } from '../../schema/reserved-tags-policy.js';

/**
 * Validate one column's own tags at the physical-column site plus each of its inline
 * constraints' tags at the physical-constraint site, accumulating the diagnostics in
 * column → column-constraints order.
 *
 * The parser lifts a trailing `WITH TAGS` onto an inline constraint only when it is
 * *named*; an unnamed inline constraint defers its tags to the column (where
 * `cc.tags` is `undefined` and {@link validateReservedTags} is a no-op). So the
 * constraint leg carries no `cc.name` guard and there is no double-validation —
 * identical reasoning to `raiseCreateTableTagDiagnostics` in `ddl.ts`, which shares
 * this helper for its per-column leg. The direct CREATE TABLE path and the
 * ALTER … ADD COLUMN path both route through here so a typo'd / mis-sited reserved
 * key fails the same way on both authoring surfaces.
 */
export function columnTagDiagnostics(column: AST.ColumnDef): TagDiagnostic[] {
	return [
		...validateReservedTags(column.tags, 'physical-column'),
		...(column.constraints ?? []).flatMap(cc => validateReservedTags(cc.tags, 'physical-constraint')),
	];
}

/**
 * Raise the first error diagnostic via the shared reserved-tag policy, threading the
 * statement's source location for a sited error. Warnings (e.g. an empty ack
 * rationale) never block — they hit a no-op sink. Shared by every plan-build tag
 * surface (CREATE TABLE / CREATE INDEX / ALTER … ADD / ALTER … SET TAGS / the
 * INSERT/UPDATE/DELETE `WITH TAGS` dml-stmt entries) so they all raise through one
 * policy site.
 */
export function raiseStmtTagDiagnostics(diagnostics: TagDiagnostic[], stmt: AST.AstNode): void {
	raiseReservedTagDiagnostics(diagnostics, {
		loc: stmt.loc ? { line: stmt.loc.start.line, column: stmt.loc.start.column } : undefined,
		log: () => { /* warnings (e.g. empty ack rationale) never block */ },
	});
}

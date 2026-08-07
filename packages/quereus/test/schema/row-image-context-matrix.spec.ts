/**
 * The row-image context matrix: what a rename of a column of a table literally
 * named `new` does to each qualifier spelling, at each kind of expression site.
 *
 * `new` / `old` are not reserved words in this parser, so `create table "new"`
 * is legal and a bare `new.v` collides with the written-row namespace. The
 * column walker disambiguates with an explicit three-valued mode
 * ({@link RowImageContext}), threaded per SITE by the emit layer:
 *
 * - `'own'` — the walked expression is written-row context of the renamed table
 *   itself (its own CHECK / DEFAULT / generated body): a bare `new.` / `old.`
 *   names ITS row image and follows the rename.
 * - `'foreign'` — written-row context of ANOTHER table (that table's CHECK /
 *   DEFAULT / generated body), or a `with inverse` / `with defaults` subtree
 *   (whose `new.` names the enclosing select's output row): the qualifier names
 *   nothing this rename cares about and is IGNORED — neither rewritten nor
 *   resolved as a table called `new`.
 * - `'none'` — no written-row context (a view / assertion body, any partial
 *   index predicate): the qualifier is an ordinary table reference and resolves
 *   through the catalog, so `new.v` matches exactly because the table IS named
 *   `new` — and `old.v` does not.
 *
 * In every mode, an in-scope FROM binding (`from "new"`, an alias, a CTE) and a
 * schema qualifier (`main."new".v`) decide FIRST — those spellings are genuine
 * table references everywhere, which is the invariant the two control columns
 * pin. This spec is the class-level guard; the user-visible pins live in
 * test/logic/41.3 §62–64, 41.10.2 §37, 41.10.4 §16.
 */

import { expect } from 'chai';
import { parseExpressionString, parse } from '../../src/parser/index.js';
import { expressionToString } from '../../src/emit/ast-stringify.js';
import {
	objectRefKey,
	renameColumnInAst,
	renameColumnInCheckExpression,
	renameColumnInColumnExpressions,
	renameColumnInIndexPredicates,
	singleSchemaObjectRefResolver,
} from '../../src/schema/rename-rewriter.js';
import type * as AST from '../../src/parser/ast.js';

const resolve = singleSchemaObjectRefResolver('main');
const NEW_KEY = objectRefKey('main', 'new');

/** One qualifier spelling, as it appears inside a scalar expression. */
interface Spelling {
	name: string;
	/** Expression text containing exactly one `v` reference under the spelling. */
	expr: string;
	/** The same text after a v → w rewrite of that reference. */
	rewritten: string;
}

const SPELLINGS: readonly Spelling[] = [
	{ name: 'bare new.', expr: 'new.v > 0', rewritten: 'new.w > 0' },
	{ name: 'bare old.', expr: 'old.v > 0', rewritten: 'old.w > 0' },
	{
		name: 'FROM-bound "new".',
		expr: '(select max("new".v) from "new") > 0',
		rewritten: '(select max("new".w) from "new") > 0',
	},
	{ name: 'schema-qualified main."new".', expr: 'main."new".v > 0', rewritten: 'main."new".w > 0' },
];

/** Index into SPELLINGS → whether the site is expected to rewrite. */
type Row = readonly [boolean, boolean, boolean, boolean];

/** [bare new., bare old., FROM-bound, schema-qualified] */
const ALL: Row = [true, true, true, true];
const WRITTEN_ROW_FOREIGN: Row = [false, false, true, true];
const TABLE_REF: Row = [true, false, true, true];

/**
 * One expression site of the matrix: how the emit layer walks that kind of
 * stored expression for a rename of `main."new"`.`v` → `w`.
 */
interface Site {
	name: string;
	rewrite: (expr: AST.Expression) => boolean;
	expected: Row;
}

const exprSites: readonly Site[] = [
	{
		// rewriteTableForColumnRename, owning-table CHECK branch.
		name: 'own CHECK (seeded, own)',
		rewrite: e => renameColumnInCheckExpression(e, 'new', 'v', 'w', resolve, NEW_KEY, 'own'),
		expected: ALL,
	},
	{
		// rewriteTableForColumnRename, other-table CHECK branch.
		name: "another table's CHECK (unseeded, foreign)",
		rewrite: e => renameColumnInAst(e, 'new', 'v', 'w', resolve, NEW_KEY, 'foreign'),
		expected: WRITTEN_ROW_FOREIGN,
	},
	{
		// Own DEFAULT and generated body share one collection helper ('own' hardcoded).
		name: 'own DEFAULT (collection helper)',
		rewrite: e => renameColumnInColumnExpressions([{ defaultValue: e }], 'new', 'v', 'w', resolve, NEW_KEY),
		expected: ALL,
	},
	{
		name: 'own GENERATED body (collection helper)',
		rewrite: e => renameColumnInColumnExpressions([{ generatedExpr: e }], 'new', 'v', 'w', resolve, NEW_KEY),
		expected: ALL,
	},
	{
		// rewriteOtherTableColumnExpressions — DEFAULT and generated take the same call.
		name: "another table's DEFAULT / GENERATED body (unseeded, foreign)",
		rewrite: e => renameColumnInAst(e, 'new', 'v', 'w', resolve, NEW_KEY, 'foreign'),
		expected: WRITTEN_ROW_FOREIGN,
	},
	{
		// The indexed table is "new" itself: the seed binds the bare qualifier `new`
		// through the FROM-frame machinery, so `new.v` still rewrites — as a table
		// reference, not a row image. `old.v` shows the difference: no seed binding,
		// no written-row context, no match.
		name: 'partial-index predicate on "new" (collection helper, none)',
		rewrite: e => renameColumnInIndexPredicates([{ predicate: e }], 'new', 'v', 'w', resolve, NEW_KEY),
		expected: TABLE_REF,
	},
	{
		// An assertion body owns no `new.` / `old.` namespace at all.
		name: 'assertion body (unseeded, none)',
		rewrite: e => renameColumnInAst(e, 'new', 'v', 'w', resolve, NEW_KEY, 'none'),
		expected: TABLE_REF,
	},
];

describe('row-image context matrix (rename column v → w of a table named "new")', () => {
	for (const site of exprSites) {
		describe(site.name, () => {
			SPELLINGS.forEach((spelling, i) => {
				const shouldRewrite = site.expected[i];
				it(`${spelling.name} → ${shouldRewrite ? 'rewritten' : 'untouched'}`, () => {
					const expr = parseExpressionString(spelling.expr);
					const changed = site.rewrite(expr);
					expect(changed, 'changed flag').to.equal(shouldRewrite);
					const expectText = shouldRewrite ? spelling.rewritten : spelling.expr;
					expect(normalize(expressionToString(expr))).to.equal(normalize(parseRoundTrip(expectText)));
				});
			});
		});
	}

	// View-body sites take a full select rather than a scalar expression: the
	// plain body treats the spelling as an ordinary reference ('none'), while a
	// `with inverse` expression forces 'foreign' over its subtree regardless.
	describe('plain view body (unseeded, none)', () => {
		SPELLINGS.forEach((spelling, i) => {
			const shouldRewrite = TABLE_REF[i];
			it(`${spelling.name} → ${shouldRewrite ? 'rewritten' : 'untouched'}`, () => {
				const stmt = parse(`select id from People where ${spelling.expr}`) as AST.SelectStmt;
				const changed = renameColumnInAst(stmt, 'new', 'v', 'w', resolve, NEW_KEY, 'none');
				expect(changed, 'changed flag').to.equal(shouldRewrite);
				const where = expressionToString(stmt.where!);
				const expectText = shouldRewrite ? spelling.rewritten : spelling.expr;
				expect(normalize(where)).to.equal(normalize(parseRoundTrip(expectText)));
			});
		});
	});

	describe("view body `with inverse` expression (subtree-forced foreign)", () => {
		SPELLINGS.forEach((spelling, i) => {
			const shouldRewrite = WRITTEN_ROW_FOREIGN[i];
			it(`${spelling.name} → ${shouldRewrite ? 'rewritten' : 'untouched'}`, () => {
				// The projection is aliased so the select's OUTPUT names cannot shift —
				// isolating the subtree mode from the separate output-name-shift pass.
				const stmt = parse(
					`select id, code as v with inverse (code = case when ${spelling.expr} then new.v else null end) from People`,
				) as AST.SelectStmt;
				const changed = renameColumnInAst(stmt, 'new', 'v', 'w', resolve, NEW_KEY, 'none');
				expect(changed, 'changed flag').to.equal(shouldRewrite);
				const rc = stmt.columns[1] as AST.ResultColumnExpr;
				const inverseText = expressionToString(rc.inverse![0].expr);
				// The trailing `new.v` names the select's own output column `v` (which
				// did not shift) — inert in every cell of this row.
				expect(inverseText, 'output-row ref must never move').to.contain('new.v');
				if (shouldRewrite) {
					expect(normalize(inverseText)).to.contain(normalize(parseRoundTrip(spelling.rewritten)));
				} else {
					expect(normalize(inverseText)).to.contain(normalize(parseRoundTrip(spelling.expr)));
				}
			});
		});
	});
});

/** Canonical text of an expression as this engine stringifies it. */
function parseRoundTrip(exprText: string): string {
	return expressionToString(parseExpressionString(exprText));
}

function normalize(s: string): string {
	return s.replace(/\s+/g, ' ').trim();
}

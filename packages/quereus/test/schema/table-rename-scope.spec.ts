/**
 * Pins the scope rules of the table-rename walk (`rename/table-rename.ts`):
 * a name the body itself binds — a CTE, a FROM alias, a subquery/function
 * source, a DML CTE target — is NOT a reference to the renamed table, while
 * genuine references under shadow-adjacent shapes still rewrite; and a bare
 * `new.` / `old.` qualifier in a written-row context (rowImageContext) is the
 * row image, not a table.
 *
 * Also pins the single-traversal invariant: `tableReferencedInAst` (the DROP
 * guard's probe) and `renameTableInAst` are two sinks over ONE walk, so for
 * every case the probe answers exactly "would a rename have rewritten this".
 */

import { expect } from 'chai';
import { parseExpressionString } from '../../src/parser/index.js';
import { cloneExpr } from '../../src/planner/mutation/scope-transform.js';
import { renameTableInAst, tableReferencedInAst, type TableRenameOpts } from '../../src/schema/rename-rewriter.js';
import { expressionToString } from '../../src/emit/ast-stringify.js';

interface Case {
	title: string;
	sql: string;
	/** Table being renamed / probed. */
	table: string;
	opts?: TableRenameOpts;
	/** Whether the walk should find (and rewrite) a reference. */
	referenced: boolean;
	/** Substrings the rewritten form must contain (only when referenced). */
	contains?: string[];
	/** Substrings the rewritten form must still contain UNCHANGED. */
	preserves?: string[];
}

const NEW_NAME = 'renamed_tbl';

const CASES: Case[] = [
	{
		title: 'CTE shadowing the renamed name — body untouched',
		sql: 'exists (with zap as (select 1 as k) select k from zap)',
		table: 'zap',
		referenced: false,
	},
	{
		title: 'recursive CTE self-reference is the CTE, not the table',
		sql: 'exists (with recursive zap as (select 1 as k union all select k + 1 from zap where k < 3) select k from zap)',
		table: 'zap',
		referenced: false,
	},
	{
		title: 'forward reference to a LATER sibling binds the real table and rewrites',
		sql: 'exists (with x as (select k from fwd), fwd as (select 1 as k) select k from x)',
		table: 'fwd',
		referenced: true,
		contains: [NEW_NAME],
		// The later sibling CTE keeps its declared name.
		preserves: ['fwd as ('],
	},
	{
		title: 'aliased subquery source named like the renamed table — untouched',
		sql: 'exists (select zap.k from (select 5 as k) as zap)',
		table: 'zap',
		referenced: false,
	},
	{
		title: 'alias of a DIFFERENT table — `from other zap` + `zap.k` untouched',
		sql: 'exists (select zap.k from other as zap)',
		table: 'zap',
		referenced: false,
	},
	{
		title: 'aliased REAL source `from zap z` still rewrites the source (alias and z.k stay)',
		sql: 'exists (select z.k from zap as z)',
		table: 'zap',
		referenced: true,
		contains: [NEW_NAME],
		preserves: ['z.k'],
	},
	{
		title: 'schema-qualified refs inside a CTE-shadowed scope still rewrite',
		sql: 'exists (with zap as (select 1 as k) select main.zap.k from main.zap)',
		table: 'zap',
		referenced: true,
		contains: [`main.${NEW_NAME}.k`, `main.${NEW_NAME}`],
		preserves: ['zap as ('],
	},
	{
		title: 'genuine reference inside a non-recursive CTE body rewrites',
		sql: 'exists (with c as (select k from zap) select k from c)',
		table: 'zap',
		referenced: true,
		contains: [NEW_NAME],
	},
	{
		title: 'unqualified qualified-column ref over an unaliased source rewrites both sites',
		sql: 'exists (select zap.k from zap)',
		table: 'zap',
		referenced: true,
		contains: [`${NEW_NAME}.k`],
	},
	{
		title: 'DML target naming a CTE of the statement\'s own WITH — untouched',
		sql: 'exists (with zap as (select 1 as k) update zap set k = 2 where k in (select k from zap) returning k)',
		table: 'zap',
		referenced: false,
	},
	{
		title: 'DML target naming the real table rewrites',
		sql: 'exists (update zap set k = 1 returning k)',
		table: 'zap',
		referenced: true,
		contains: [NEW_NAME],
	},
	{
		title: 'schema-qualified DML target is never the same-named CTE — rewrites',
		sql: 'exists (with zap as (select 1 as k) insert into main.zap values (1) returning k)',
		table: 'zap',
		referenced: true,
		contains: [`main.${NEW_NAME}`],
		preserves: ['zap as ('],
	},
	{
		title: 'an ENCLOSING WITH does not shadow a nested DML target (mirrors resolveCteTarget)',
		sql: 'exists (with zap as (select 1 as k) select k from (insert into zap values (1) returning k) as y)',
		table: 'zap',
		referenced: true,
		contains: [`into ${NEW_NAME}`],
		preserves: ['zap as ('],
	},
	{
		title: 'inline subquery DML target: the correlation name is not a table — `v.k` untouched',
		sql: 'exists (update (select k from other) as v set k = 1 where v.k > 0 returning k)',
		table: 'v',
		referenced: false,
	},
	{
		title: 'inline subquery DML target: a real reference in its body still rewrites',
		sql: 'exists (update (select k from zap) as v set k = 1 where v.k > 0 returning k)',
		table: 'zap',
		referenced: true,
		contains: [NEW_NAME],
		preserves: ['as v', 'v.k'],
	},
	{
		title: 'join arm binds a real source — `zap.k` and the source both rewrite',
		sql: 'exists (select zap.k from a inner join zap on a.id = zap.id)',
		table: 'zap',
		referenced: true,
		contains: [`join ${NEW_NAME}`, `${NEW_NAME}.k`],
	},
	{
		title: 'join arm binds an aliased subquery source — untouched',
		sql: 'exists (select zap.k from a left join (select 1 as k, 1 as id) as zap on a.id = zap.id)',
		table: 'zap',
		referenced: false,
	},
	{
		title: 'aliased function source named like the renamed table — untouched',
		sql: 'exists (select zap.k from gen(1) as zap)',
		table: 'zap',
		referenced: false,
	},
	{
		title: 'row image: bare new.a in a written-row context is NOT a table reference',
		sql: 'new.a > 0',
		table: 'new',
		opts: { rowImageContext: true },
		referenced: false,
	},
	{
		title: 'row image: bare old.a in a written-row context is NOT a table reference',
		sql: 'old.a > 0',
		table: 'old',
		opts: { rowImageContext: true },
		referenced: false,
	},
	{
		title: 'without rowImageContext (index predicate), new.a IS a table reference',
		sql: 'new.a > 0',
		table: 'new',
		referenced: true,
		contains: [`${NEW_NAME}.a`],
	},
	{
		title: 'row image survives while a real FROM of the same-named table still rewrites',
		sql: 'new.a > 0 and (select count(*) from new) >= 0',
		table: 'new',
		opts: { rowImageContext: true },
		referenced: true,
		contains: [NEW_NAME],
		preserves: ['new.a'],
	},
	{
		title: 'a `new` REBOUND by an inner FROM is that table, not the row image — rewrites',
		sql: '(select max(new.a) from new) >= 0',
		table: 'new',
		opts: { rowImageContext: true },
		referenced: true,
		contains: [`${NEW_NAME}.a`],
	},
	{
		title: 'schema-qualified main.new.a is a real three-part reference even in row-image context',
		sql: 'main.new.a > 0',
		table: 'new',
		opts: { rowImageContext: true },
		referenced: true,
		contains: [`main.${NEW_NAME}.a`],
	},
	{
		title: 'reference through a table in another schema does not match by bare name',
		sql: 'exists (select zap.k from other_schema.zap)',
		table: 'zap',
		referenced: false,
	},
];

describe('table-rename scope rules', () => {
	for (const c of CASES) {
		it(c.title, () => {
			const ast = parseExpressionString(c.sql);
			const before = expressionToString(ast);
			const changed = renameTableInAst(ast, c.table, NEW_NAME, 'main', c.opts);
			expect(changed, 'changed flag').to.equal(c.referenced);
			const after = expressionToString(ast);
			if (!c.referenced) {
				expect(after, 'body must be byte-stable when nothing references the table').to.equal(before);
			}
			// Strip identifier quoting so `"new".a` and `new.a` compare alike.
			const afterBare = after.replace(/"/g, '');
			for (const s of c.contains ?? []) {
				expect(afterBare).to.contain(s);
			}
			for (const s of c.preserves ?? []) {
				expect(afterBare).to.contain(s);
			}
		});
	}

	it('probe and rename agree on every case (one traversal, two sinks)', () => {
		for (const c of CASES) {
			const ast = parseExpressionString(c.sql);
			const probed = tableReferencedInAst(ast, c.table, 'main', c.opts);
			const renamed = renameTableInAst(cloneExpr(ast), c.table, NEW_NAME, 'main', c.opts);
			expect(probed, `probe/rename drift on: ${c.title}`).to.equal(renamed);
			expect(probed, `expected outcome on: ${c.title}`).to.equal(c.referenced);
		}
	});

	it('rename is idempotent — a second pass finds nothing', () => {
		for (const c of CASES.filter(x => x.referenced)) {
			const ast = parseExpressionString(c.sql);
			expect(renameTableInAst(ast, c.table, NEW_NAME, 'main', c.opts)).to.equal(true);
			expect(renameTableInAst(ast, c.table, NEW_NAME, 'main', c.opts),
				`second pass must be a no-op on: ${c.title}`).to.equal(false);
		}
	});
});

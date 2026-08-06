/**
 * Pins that `cloneExpr` is a truly deep structural clone: the in-place rename
 * rewriters (schema differ rename reconcile, constraint-builder qualifier
 * strip) run over clones of DECLARED/stored ASTs, so any subtree shared by
 * reference with the source would leak the mutation back into the stored AST
 * — silently corrupting the declared expression that backs recreate DDL.
 *
 * Each case asserts both directions: the rewriter DID reach the subtree in
 * the clone (`changed === true`), and the source stringification is
 * byte-stable. Covers the three historically shared subtree kinds:
 * WITH-clause CTE bodies, window functions, and IUD-RETURNING subqueries.
 */

import { expect } from 'chai';
import { parseExpressionString } from '../../src/parser/index.js';
import { cloneExpr } from '../../src/planner/mutation/scope-transform.js';
import { renameTableInAst, renameColumnInCheckExpression, stripSelfQualifierInCheckExpression, objectRefKey, singleSchemaObjectRefResolver } from '../../src/schema/rename-rewriter.js';
import { expressionToString } from '../../src/emit/ast-stringify.js';

// Single-schema resolver: these are clone-isolation tests, not resolution tests.
const resolveMain = singleSchemaObjectRefResolver('main');
const OLD_T_KEY = objectRefKey('main', 'old_t');
const T_KEY = objectRefKey('main', 't');

describe('cloneExpr isolation vs in-place rename rewriters', () => {
	it('table rename through a CTE body does NOT leak into the source AST', () => {
		const src = parseExpressionString('exists (with c as (select x from old_t) select 1 from c)');
		const before = expressionToString(src);
		const clone = cloneExpr(src);
		const changed = renameTableInAst(clone, 'old_t', 'renamed_t', resolveMain, OLD_T_KEY);
		expect(changed, 'rewriter should hit the CTE body in the clone').to.equal(true);
		expect(expressionToString(clone)).to.contain('renamed_t');
		expect(expressionToString(src), 'source AST must be byte-stable').to.equal(before);
	});

	it('column rename through a CTE body does NOT leak into the source AST', () => {
		const src = parseExpressionString('(with c as (select v from t) select count(*) from c) > 0');
		const before = expressionToString(src);
		const clone = cloneExpr(src);
		const changed = renameColumnInCheckExpression(clone, 't', 'v', 'w', resolveMain, T_KEY);
		expect(changed, 'rewriter should hit the CTE body in the clone').to.equal(true);
		expect(expressionToString(src), 'source AST must be byte-stable').to.equal(before);
	});

	it('column rename through a window function does NOT leak into the source AST', () => {
		const src = parseExpressionString('exists (select sum(v) over (partition by v order by v) from t)');
		const before = expressionToString(src);
		const clone = cloneExpr(src);
		const changed = renameColumnInCheckExpression(clone, 't', 'v', 'w', resolveMain, T_KEY);
		expect(changed, 'rewriter should hit the window function in the clone').to.equal(true);
		expect(expressionToString(src), 'source AST must be byte-stable').to.equal(before);
	});

	it('table rename through an IUD-RETURNING subquery does NOT leak into the source AST', () => {
		const src = parseExpressionString('exists (insert into old_t (a) values (1) returning a)');
		const before = expressionToString(src);
		const clone = cloneExpr(src);
		const changed = renameTableInAst(clone, 'old_t', 'renamed_t', resolveMain, OLD_T_KEY);
		expect(changed, 'rewriter should hit the IUD target in the clone').to.equal(true);
		expect(expressionToString(clone)).to.contain('renamed_t');
		expect(expressionToString(src), 'source AST must be byte-stable').to.equal(before);
	});

	it('table rename through an UPDATE-RETURNING subquery does NOT leak into the source AST', () => {
		const src = parseExpressionString('exists (update old_t set a = a + 1 where a > 0 returning a)');
		const before = expressionToString(src);
		const clone = cloneExpr(src);
		const changed = renameTableInAst(clone, 'old_t', 'renamed_t', resolveMain, OLD_T_KEY);
		expect(changed, 'rewriter should hit the UPDATE target in the clone').to.equal(true);
		expect(expressionToString(clone)).to.contain('renamed_t');
		expect(expressionToString(src), 'source AST must be byte-stable').to.equal(before);
	});

	it('column rename through UPDATE-RETURNING assignments does NOT leak into the source AST', () => {
		const src = parseExpressionString('exists (update t set v = v + 1 where v > 0 returning v)');
		const before = expressionToString(src);
		const clone = cloneExpr(src);
		const changed = renameColumnInCheckExpression(clone, 't', 'v', 'w', resolveMain, T_KEY);
		expect(changed, 'rewriter should hit the assignments in the clone').to.equal(true);
		expect(expressionToString(src), 'source AST must be byte-stable').to.equal(before);
	});

	it('column rename through an upsert clause does NOT leak into the source AST', () => {
		const src = parseExpressionString(
			'exists (insert into t (v) values (1) on conflict (v) do update set v = v + 1 where v > 0 returning v)');
		const before = expressionToString(src);
		const clone = cloneExpr(src);
		const changed = renameColumnInCheckExpression(clone, 't', 'v', 'w', resolveMain, T_KEY);
		expect(changed, 'rewriter should hit the upsert clause in the clone').to.equal(true);
		expect(expressionToString(src), 'source AST must be byte-stable').to.equal(before);
	});

	it('table rename through a DELETE-RETURNING subquery does NOT leak into the source AST', () => {
		const src = parseExpressionString('exists (delete from old_t where a > 0 returning a)');
		const before = expressionToString(src);
		const clone = cloneExpr(src);
		const changed = renameTableInAst(clone, 'old_t', 'renamed_t', resolveMain, OLD_T_KEY);
		expect(changed, 'rewriter should hit the DELETE target in the clone').to.equal(true);
		expect(expressionToString(clone)).to.contain('renamed_t');
		expect(expressionToString(src), 'source AST must be byte-stable').to.equal(before);
	});

	it('table rename through a WITH clause on a DML subquery does NOT leak into the source AST', () => {
		const src = parseExpressionString(
			'exists (with c as (select x from old_t) insert into t2 (a) select x from c returning a)');
		const before = expressionToString(src);
		const clone = cloneExpr(src);
		const changed = renameTableInAst(clone, 'old_t', 'renamed_t', resolveMain, OLD_T_KEY);
		expect(changed, 'rewriter should hit the DML-attached CTE body in the clone').to.equal(true);
		expect(expressionToString(clone)).to.contain('renamed_t');
		expect(expressionToString(src), 'source AST must be byte-stable').to.equal(before);
	});

	it('self-qualifier strip through a window function does NOT leak into the source AST', () => {
		const src = parseExpressionString('exists (select sum(t.v) over (partition by t.v order by t.v) from u)');
		const before = expressionToString(src);
		const clone = cloneExpr(src);
		const changed = stripSelfQualifierInCheckExpression(clone, 't', 'main', () => false);
		expect(changed, 'strip should hit the window function in the clone').to.equal(true);
		expect(expressionToString(clone)).to.not.contain('t.v');
		expect(expressionToString(src), 'source AST must be byte-stable').to.equal(before);
	});
});

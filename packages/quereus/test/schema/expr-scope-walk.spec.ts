/**
 * Pins `walkSchemaExpressionScope` (`src/schema/expr-scope/walk.ts`) directly —
 * the ONE scope-aware traversal of a schema-authored expression (a `CHECK`
 * body, a `GENERATED ALWAYS AS` body), under both analyses layered on it: the
 * self-qualifier strip and the generated-column reference collector.
 *
 * Asserted at walk level rather than through either analysis, because what the
 * two share is exactly this: which leaves get reached, and what the frame stack
 * looks like when they do. A node kind taught to the walk gets covered here
 * once instead of twice, and a classification bug in one analysis cannot mask a
 * traversal bug in the shared walk.
 *
 * Records are `{ shape, name, qualifier, depth, sawOpaque }` — `depth` counts
 * the whole stack including the seed at index 0, and `sawOpaque` asks only
 * about frames ABOVE the seed (the classifiers' own convention).
 */

import { expect } from 'chai';
import { parseExpressionString } from '../../src/parser/index.js';
import type * as AST from '../../src/parser/ast.js';
import { walkSchemaExpressionScope, type ScopeWalkHandlers } from '../../src/schema/expr-scope/walk.js';
import type { ScopeFrame } from '../../src/schema/expr-scope/frame.js';
import { stripSelfQualifierInSchemaExpression } from '../../src/schema/rename-rewriter.js';
import { expressionToString } from '../../src/emit/ast-stringify.js';

interface Record_ {
	shape: 'column' | 'identifier';
	name: string;
	qualifier?: string;
	/** Stack size at the leaf, seed included — so a bare expression is 1. */
	depth: number;
	/** Any frame ABOVE the seed marked opaque. */
	sawOpaque: boolean;
	/** `<schema>.<name>` of every askable real source above the seed, outermost-first. */
	realSources: string[];
	/** Lowercase qualifiers bound above the seed, outermost-first per frame. */
	bound: string[][];
}

function record(stack: ReadonlyArray<ScopeFrame>): Omit<Record_, 'shape' | 'name' | 'qualifier'> {
	const above = stack.slice(1);
	return {
		depth: stack.length,
		sawOpaque: above.some(f => f.hasOpaque),
		realSources: above.flatMap(f => f.realSources.map(s => `${s.schema}.${s.name}`)),
		bound: above.map(f => [...f.bound]),
	};
}

/** Walk `sql` (parsed as a scalar expression) seeded with table `t` in `defaultSchema`. */
function walkExpr(sql: string, defaultSchema = 'main'): Record_[] {
	return walkNode(parseExpressionString(sql), defaultSchema);
}

function walkNode(node: AST.AstNode | undefined, defaultSchema = 'main', handlers?: Partial<ScopeWalkHandlers>): Record_[] {
	const recs: Record_[] = [];
	walkSchemaExpressionScope(node, { defaultSchema, seedBindings: ['t'] }, {
		onColumn: (col, stack) => recs.push({ shape: 'column', name: col.name, qualifier: col.table, ...record(stack) }),
		onIdentifier: (ident, stack) => recs.push({ shape: 'identifier', name: ident.name, ...record(stack) }),
		...handlers,
	});
	return recs;
}

describe('walkSchemaExpressionScope', () => {
	describe('the seed frame', () => {
		it('reaches a bare name with the seed as the only frame', () => {
			const recs = walkExpr('qty');
			expect(recs).to.have.lengthOf(1);
			expect(recs[0]).to.deep.include({ shape: 'column', name: 'qty', depth: 1, sawOpaque: false });
			expect(recs[0].bound).to.deep.equal([]);
		});

		it('hands a self-qualified name over with nothing above the seed binding it', () => {
			const recs = walkExpr('t.qty');
			expect(recs).to.have.lengthOf(1);
			expect(recs[0]).to.deep.include({ shape: 'column', name: 'qty', qualifier: 't', depth: 1 });
			// The seed binds `t`; the classifiers see it only by falling off the stack.
			expect(recs[0].bound).to.deep.equal([]);
		});

		it('binds every seedBinding into stack[0]', () => {
			let seed: ReadonlyArray<string> | undefined;
			walkSchemaExpressionScope(
				parseExpressionString('qty'),
				{ defaultSchema: 'main', seedBindings: ['t', 'alias_of_t'] },
				{ onColumn: (_col, stack) => { seed = [...stack[0].bound]; } },
			);
			expect(seed).to.deep.equal(['t', 'alias_of_t']);
		});

		it('returns without touching the handlers when there is no expression', () => {
			expect(walkNode(undefined)).to.deep.equal([]);
		});
	});

	describe('FROM frames', () => {
		it('exposes a real table source as askable', () => {
			const recs = walkExpr('exists (select qty from other)');
			expect(recs).to.have.lengthOf(1);
			expect(recs[0]).to.deep.include({ name: 'qty', sawOpaque: false });
			expect(recs[0].realSources).to.deep.equal(['main.other']);
		});

		it('qualifies an unqualified source with defaultSchema, not a search path', () => {
			const recs = walkExpr('exists (select qty from other)', 'temp');
			expect(recs[0].realSources).to.deep.equal(['temp.other']);
		});

		it('treats a CTE source as opaque and its body as a barrier', () => {
			const recs = walkExpr('exists (with c as (select z from src) select qty from c)');
			expect(recs.map(r => r.name)).to.deep.equal(['z', 'qty']);
			// Inside the CTE body: under a barrier, but its own FROM is still askable.
			expect(recs[0].sawOpaque).to.equal(true);
			expect(recs[0].realSources).to.deep.equal(['main.src']);
			// Outside it: `c` binds a name but exposes no askable columns.
			expect(recs[1].sawOpaque).to.equal(true);
			expect(recs[1].realSources).to.deep.equal([]);
			expect(recs[1].bound).to.deep.equal([[], ['c']]);
		});

		it('registers a CTE name only AFTER its own body is walked', () => {
			// `from c` inside `c`'s own body cannot see `c` — it is an ordinary
			// (askable) table source there. Swapping the registration order would
			// silently make it opaque.
			const recs = walkExpr('exists (with c as (select z from c) select qty from c)');
			expect(recs[0].name).to.equal('z');
			expect(recs[0].realSources).to.deep.equal(['main.c']);
		});

		it('treats a derived-table source as opaque and its body as a barrier', () => {
			const recs = walkExpr('exists (select qty from (select z from src) x)');
			expect(recs.map(r => r.name)).to.deep.equal(['qty', 'z']);
			expect(recs[0].sawOpaque).to.equal(true);
			expect(recs[0].bound).to.deep.equal([[], ['x']]);
			// The derived body sits under a barrier stacked ON the outer frame,
			// which still binds `x` — barriers stack, they do not replace.
			expect(recs[1].sawOpaque).to.equal(true);
			expect(recs[1].realSources).to.deep.equal(['main.src']);
			expect(recs[1].bound).to.deep.equal([[], ['x'], [], [], ['src']]);
		});

		it('pops a frame once its subtree is done', () => {
			const recs = walkExpr('exists (select qty from other) and t.v > 0');
			expect(recs.map(r => r.name)).to.deep.equal(['qty', 'v']);
			expect(recs[1]).to.deep.include({ depth: 1, sawOpaque: false });
		});
	});

	describe('DML statements', () => {
		// Reachable from a schema expression only via a scalar / EXISTS subquery over
		// `insert … returning` and friends. Everything inside is under ONE opaque
		// frame, so no reference there can be attributed to the written row.
		it('descends an INSERT source under a barrier', () => {
			const recs = walkExpr('exists (insert into other select qty from src returning k)');
			expect(recs.map(r => r.name)).to.deep.equal(['qty']);
			expect(recs[0].sawOpaque).to.equal(true);
		});

		it('descends UPDATE assignments and WHERE under a barrier', () => {
			const recs = walkExpr('exists (update other set v = qty where qty > 0 returning v)');
			expect(recs.map(r => r.name)).to.deep.equal(['qty', 'qty']);
			expect(recs.every(r => r.sawOpaque)).to.equal(true);
		});

		it('descends a DELETE WHERE under a barrier', () => {
			const recs = walkExpr('exists (delete from other where qty > 0 returning v)');
			expect(recs.map(r => r.name)).to.deep.equal(['qty']);
			expect(recs[0].sawOpaque).to.equal(true);
		});

		it('descends a DML-attached WITH clause under an extra barrier', () => {
			const recs = walkExpr('exists (with c as (select z from src) insert into other select 1 from c returning k)');
			expect(recs.map(r => r.name)).to.deep.equal(['z']);
			expect(recs[0].sawOpaque).to.equal(true);
		});

		it('does NOT descend a RETURNING list (owned by debt-schema-scope-walk-uncovered-subtrees)', () => {
			// Pinned as the CURRENT contract, not as desirable behaviour: both
			// hand-written walks this one merged had the same gap, and closing it is
			// the follow-on ticket's job. That ticket flips this assertion.
			expect(walkExpr('exists (insert into other values (1) returning k)')).to.deep.equal([]);
		});
	});

	describe('leaf handlers', () => {
		it('hands an identifier-shaped leaf to onIdentifier', () => {
			// The parser never produces an `identifier` node in expression position
			// today (`qty` parses as a `column`), but the collector classifies them
			// and a synthesised AST can carry one — so the walk must route it.
			const fn = parseExpressionString('coalesce(qty, 0)') as AST.FunctionExpr;
			fn.args[1] = { type: 'identifier', name: 'ctx_var' };
			const recs = walkNode(fn);
			expect(recs.map(r => `${r.shape}:${r.name}`)).to.deep.equal(['column:qty', 'identifier:ctx_var']);
			expect(recs[1].depth).to.equal(1);
		});

		it('treats an identifier as a terminal when no onIdentifier is supplied', () => {
			const fn = parseExpressionString('coalesce(qty, 0)') as AST.FunctionExpr;
			fn.args[1] = { type: 'identifier', name: 'ctx_var' };
			const seen: string[] = [];
			expect(() => walkSchemaExpressionScope(
				fn,
				{ defaultSchema: 'main', seedBindings: ['t'] },
				{ onColumn: col => { seen.push(col.name); } },
			)).to.not.throw();
			expect(seen).to.deep.equal(['qty']);
		});

		it('reaches window partition and order expressions in the enclosing frame', () => {
			const recs = walkExpr('exists (select sum(v) over (partition by p order by o) from other)');
			expect(recs.map(r => r.name)).to.deep.equal(['v', 'p', 'o']);
			expect(recs.every(r => r.realSources.join() === 'main.other')).to.equal(true);
		});
	});

	// One case per node kind the walk's `switch` descends, asserting only WHICH
	// leaves are reached and in what order — not the frame shape, which the
	// clause-position cases above own. A merge (or a future edit) that drops an
	// arm makes a leaf disappear here, which is the failure these guard.
	describe('every descended node kind reaches its leaves', () => {
		const cases: ReadonlyArray<[sql: string, names: string[]]> = [
			['case a when b then c else d end', ['a', 'b', 'c', 'd']],
			['case when a > b then c end', ['a', 'b', 'c']],
			['x in (a, b)', ['x', 'a', 'b']],
			['x in (select k from other)', ['x', 'k']],
			['x between a and b', ['x', 'a', 'b']],
			['(select k from other) > a', ['k', 'a']],
			['cast(a as integer)', ['a']],
			['a collate nocase', ['a']],
			['-a', ['a']],
			['not a', ['a']],
			['coalesce(a, b + c)', ['a', 'b', 'c']],
			['exists (select 1 from other o join other2 p on o.k = p.k where p.v > a)', ['k', 'k', 'v', 'a']],
			['exists (select 1 from f(a, b))', ['a', 'b']],
			['exists (select g from other group by g having sum(v) > a order by o limit l offset f)',
				['g', 'g', 'v', 'a', 'o', 'l', 'f']],
			['exists (select a from s1 union select b from s2)', ['a', 'b']],
			['exists (select 1 from (values (a)) v)', ['a']],
		];

		for (const [sql, names] of cases) {
			it(sql, () => {
				expect(walkExpr(sql).map(r => r.name)).to.deep.equal(names);
			});
		}

		// A ledger of every `AST.Expression` kind and how the walk treats it. Its
		// value is the COMPILE-TIME exhaustiveness: a new expression node kind
		// cannot enter the union without a decision recorded here, which is the
		// only cheap guard against the silent failure mode — a node kind the walk
		// does not descend hides a reference, and a hidden reference in a generated
		// body means no dependency edge and a column computed before what it reads.
		const EXPRESSION_KINDS: Record<AST.Expression['type'], 'descend' | 'leaf' | 'terminal'> = {
			binary: 'descend',
			unary: 'descend',
			function: 'descend',
			functionSource: 'descend',
			cast: 'descend',
			collate: 'descend',
			subquery: 'descend',
			windowFunction: 'descend',
			case: 'descend',
			in: 'descend',
			exists: 'descend',
			between: 'descend',
			column: 'leaf',
			identifier: 'leaf',
			literal: 'terminal',
			parameter: 'terminal',
		};

		it('reaches no leaf at all for the terminal kinds', () => {
			const terminals = Object.entries(EXPRESSION_KINDS)
				.filter(([, treatment]) => treatment === 'terminal')
				.map(([kind]) => kind);
			expect(terminals).to.deep.equal(['literal', 'parameter']);
			expect(walkExpr('1 + ?')).to.deep.equal([]);
		});
	});

	// The merge's behaviour-neutrality claim, checked on the analysis that gained
	// traversal reach: the self-qualifier strip.
	describe('the self-qualifier strip over the merged walk', () => {
		it('rewrites nothing under a barrier, even though it now walks there', () => {
			// The strip's predecessor traversal had no DML arms at all, so merging the
			// two walks made it VISIT these subtrees for the first time. It must still
			// rewrite none of them: every DML arm pushes an opaque frame, and
			// `stripColumnQualifier` bails at the first frame with `hasOpaque`.
			const cases = [
				'exists (insert into other select t.qty from src returning k)',
				'exists (update other set v = t.qty where t.qty > 0 returning v)',
				'exists (delete from other where t.qty > 0 returning v)',
				'exists (with c as (select t.qty from src) select 1 from c)',
				'exists (select 1 from (select t.qty from src) x)',
			];
			for (const sql of cases) {
				const expr = parseExpressionString(sql);
				const before = expressionToString(expr);
				const changed = stripSelfQualifierInSchemaExpression(expr, 't', 'main', () => false);
				expect(changed, sql).to.equal(false);
				expect(expressionToString(expr), sql).to.equal(before);
			}
		});

		it('still strips a self-qualifier the walk can prove nothing rebinds', () => {
			const expr = parseExpressionString('t.qty > 0');
			expect(stripSelfQualifierInSchemaExpression(expr, 't', 'main', () => false)).to.equal(true);
			expect(expressionToString(expr)).to.not.contain('t.qty');
		});

	});
});

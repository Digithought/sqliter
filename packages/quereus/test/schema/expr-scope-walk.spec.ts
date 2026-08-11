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
 * Records are `{ shape, name, qualifier, depth, sawOpaque, sawSealed }` —
 * `depth` counts the whole stack including the seed at index 0, and
 * `sawOpaque` / `sawSealed` ask only about frames ABOVE the seed (the
 * classifiers' own convention).
 */

import { expect } from 'chai';
import { parseExpressionString } from '../../src/parser/index.js';
import type * as AST from '../../src/parser/ast.js';
import { walkSchemaExpressionScope, type ScopeWalkHandlers } from '../../src/schema/expr-scope/walk.js';
import type { ScopeFrame } from '../../src/schema/expr-scope/frame.js';
import { stripSelfQualifierInSchemaExpression } from '../../src/schema/rename-rewriter.js';
import { collectGeneratedColumnRefs } from '../../src/schema/generated-column-refs.js';
import { expressionToString } from '../../src/emit/ast-stringify.js';

interface Record_ {
	shape: 'column' | 'identifier';
	name: string;
	qualifier?: string;
	/** Stack size at the leaf, seed included — so a bare expression is 1. */
	depth: number;
	/** Any frame ABOVE the seed marked opaque. */
	sawOpaque: boolean;
	/** Any frame ABOVE the seed sealed — write-through metadata, unreachable from the seed. */
	sawSealed: boolean;
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
		sawSealed: above.some(f => f.sealed),
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
			expect(recs.map(r => r.name)).to.deep.equal(['qty', 'k']);
			expect(recs.every(r => r.sawOpaque)).to.equal(true);
		});

		it('descends UPDATE assignments and WHERE under a barrier', () => {
			const recs = walkExpr('exists (update other set v = qty where qty > 0 returning v)');
			expect(recs.map(r => r.name)).to.deep.equal(['qty', 'qty', 'v']);
			expect(recs.every(r => r.sawOpaque)).to.equal(true);
		});

		it('descends a DELETE WHERE under a barrier', () => {
			const recs = walkExpr('exists (delete from other where qty > 0 returning v)');
			expect(recs.map(r => r.name)).to.deep.equal(['qty', 'v']);
			expect(recs.every(r => r.sawOpaque)).to.equal(true);
		});

		it('descends a DML-attached WITH clause under an extra barrier', () => {
			const recs = walkExpr('exists (with c as (select z from src) insert into other select 1 from c returning k)');
			expect(recs.map(r => r.name)).to.deep.equal(['z', 'k']);
			expect(recs.every(r => r.sawOpaque)).to.equal(true);
		});

		it('descends a RETURNING list under the barrier', () => {
			// A reference the walk cannot see is a reference the generated-column
			// analysis records no dependency edge for, so `returning` must be reached
			// even though everything under the DML barrier is undecidable.
			const recs = walkExpr('exists (insert into other values (1) returning k)');
			expect(recs.map(r => r.name)).to.deep.equal(['k']);
			expect(recs[0]).to.deep.include({ shape: 'column', sawOpaque: true, sawSealed: false });
		});

		it('descends UPSERT assignments and WHERE under the barrier', () => {
			const recs = walkExpr(
				'exists (insert into other values (1) on conflict (k) do update set v = a where b > 0 returning k)');
			expect(recs.map(r => r.name)).to.deep.equal(['a', 'b', 'k']);
			expect(recs.every(r => r.sawOpaque)).to.equal(true);
		});

		it('descends WITH CONTEXT assignments under the barrier', () => {
			const recs = walkExpr('exists (insert into other with context c = qty values (1) returning k)');
			expect(recs.map(r => r.name)).to.deep.equal(['k', 'qty']);
			expect(recs.every(r => r.sawOpaque)).to.equal(true);
		});
	});

	// View write-through metadata: expressions evaluated against the WRITTEN view
	// row, whose naming environment this walk does not model at all. A sealed frame
	// is stronger than a barrier — not even `new.<col>` may reach the seed from
	// inside one, since the classifiers check the `new.` / owning-table spellings
	// AFTER the frame loop and an opaque frame binds nothing.
	describe('sealed subtrees', () => {
		it("seals a result column's WITH INVERSE clause, leaving the projection alone", () => {
			const recs = walkExpr('exists (select a with inverse (b = new.a) from other)');
			expect(recs.map(r => r.name)).to.deep.equal(['a', 'a']);
			expect(recs[0]).to.deep.include({ qualifier: undefined, sawSealed: false, sawOpaque: false });
			expect(recs[1]).to.deep.include({ qualifier: 'new', sawSealed: true, sawOpaque: true });
		});

		it("seals a select's trailing WITH DEFAULTS clause", () => {
			const recs = walkExpr('exists (select a from other with defaults (c = d))');
			expect(recs.map(r => r.name)).to.deep.equal(['a', 'd']);
			expect(recs[0].sawSealed).to.equal(false);
			expect(recs[1]).to.deep.include({ sawSealed: true, sawOpaque: true });
		});

		it('does not leak the seal to a sibling reference in the same column list', () => {
			const recs = walkExpr('exists (select a with inverse (b = new.a) from other) and t.v > 0');
			expect(recs.map(r => `${r.name}:${r.sawSealed}`)).to.deep.equal(['a:false', 'a:true', 'v:false']);
			expect(recs[2].depth).to.equal(1);
		});

		it('stacks a seal on top of an enclosing barrier without disturbing it', () => {
			// The `with inverse` clause sits inside a CTE body, which is already opaque.
			const recs = walkExpr('exists (with c as (select z with inverse (b = new.z) from src) select 1 from c)');
			expect(recs.map(r => r.name)).to.deep.equal(['z', 'z']);
			expect(recs[0]).to.deep.include({ sawOpaque: true, sawSealed: false });
			expect(recs[1]).to.deep.include({ sawOpaque: true, sawSealed: true });
			// Frames stack, never replace: the CTE body's own askable source survives.
			expect(recs[1].realSources).to.deep.equal(['main.src']);
		});

		it('classifies every reference under a seal as undecidable, including `new.`', () => {
			// The whole point of the seal: `new.a` here names the WRITTEN VIEW row, so
			// claiming `'own'` would invent a dependency on the table being defined.
			const refs = collectGeneratedColumnRefs(
				parseExpressionString('exists (select a with inverse (b = new.a) from other)'),
				't', 'main', () => false);
			expect(refs.map(r => `${r.name}:${r.binding}`)).to.deep.equal(['a:own', 'a:unknown']);
		});

		it('rewrites nothing inside a sealed subtree', () => {
			const expr = parseExpressionString('exists (select a with inverse (b = t.a) from other)');
			const before = expressionToString(expr);
			expect(stripSelfQualifierInSchemaExpression(expr, 't', 'main', () => false)).to.equal(false);
			expect(expressionToString(expr)).to.equal(before);
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

		it('reaches a window frame bound expression in the enclosing frame', () => {
			// A frame bound is an ordinary correlated expression — same frame as
			// `partition by` / `order by`, no barrier and no seal.
			const recs = walkExpr('exists (select sum(x) over (rows between y preceding and current row) from other)');
			expect(recs.map(r => r.name)).to.deep.equal(['x', 'y']);
			expect(recs.every(r => !r.sawOpaque && !r.sawSealed)).to.equal(true);
			expect(recs[1].realSources).to.deep.equal(['main.other']);
		});

		it('reaches BOTH frame bounds, START before END', () => {
			const recs = walkExpr('exists (select sum(x) over (rows between y preceding and z following) from other)');
			expect(recs.map(r => r.name)).to.deep.equal(['x', 'y', 'z']);
		});

		it('records nothing for frame bounds that carry no expression', () => {
			// `currentRow` / `unboundedPreceding` / `unboundedFollowing` have no `value`
			// field at all, and a literal bound is a terminal.
			expect(walkExpr('exists (select sum(x) over (rows between unbounded preceding and current row) from other)')
				.map(r => r.name)).to.deep.equal(['x']);
			expect(walkExpr('exists (select sum(x) over (rows between 1 preceding and 2 following) from other)')
				.map(r => r.name)).to.deep.equal(['x']);
		});

		it('handles an END-less frame (`end` is explicitly null)', () => {
			const recs = walkExpr('exists (select sum(x) over (rows y preceding) from other)');
			expect(recs.map(r => r.name)).to.deep.equal(['x', 'y']);
		});
	});

	// Each leg of a compound is a self-contained relation that builds its OWN FROM
	// frame. Visiting a later leg inside the LEADING leg's frame would let that
	// leg's sources capture a bare name that should fall through to the seed —
	// `'foreign'` instead of `'own'`, which costs the generated-column analysis a
	// dependency edge and can compute a column before what it reads.
	describe('compound legs', () => {
		it("does not carry the leading leg's FROM frame into the second leg", () => {
			const recs = walkExpr('exists (select a from s1 union select b from s2)');
			expect(recs.map(r => r.name)).to.deep.equal(['a', 'b']);
			expect(recs[0].realSources).to.deep.equal(['main.s1']);
			expect(recs[1].realSources).to.deep.equal(['main.s2']);
			expect(recs[1].bound.flat()).to.not.include('s1');
		});

		it('still scopes a leading WITH clause over every leg', () => {
			// A `with` clause binds to the whole compound, so `c` must read as an opaque
			// CTE source in the SECOND leg too, not as an askable real table.
			const recs = walkExpr('exists (with c as (select z from src) select a from s1 union select b from c)');
			expect(recs.map(r => r.name)).to.deep.equal(['z', 'a', 'b']);
			expect(recs[2].realSources).to.deep.equal([]);
			expect(recs[2].sawOpaque).to.equal(true);
		});

		it('lets a bare name in the second leg fall through to the seed', () => {
			// `s1` exposes `qty`, `s2` does not: with the leading leg's frame still on
			// the stack the second leg's `qty` would classify `'foreign'`.
			const refs = collectGeneratedColumnRefs(
				parseExpressionString('exists (select 1 from s1 union select qty from s2)'),
				't', 'main',
				(_schema, name) => name === 's1',
			);
			expect(refs.map(r => `${r.name}:${r.binding}`)).to.deep.equal(['qty:own']);
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

		it('rewrites a self-qualifier inside a window frame bound', () => {
			// Intended, and consistent with how the strip already treats `partition by` /
			// `order by`: a frame bound is an ordinary correlated expression.
			const expr = parseExpressionString('sum(v) over (rows between t.y preceding and current row)');
			expect(stripSelfQualifierInSchemaExpression(expr, 't', 'main', () => false)).to.equal(true);
			expect(expressionToString(expr)).to.not.contain('t.y');
		});

		it('still strips a self-qualifier the walk can prove nothing rebinds', () => {
			const expr = parseExpressionString('t.qty > 0');
			expect(stripSelfQualifierInSchemaExpression(expr, 't', 'main', () => false)).to.equal(true);
			expect(expressionToString(expr)).to.not.contain('t.qty');
		});

	});
});

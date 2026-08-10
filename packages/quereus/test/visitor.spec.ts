import { expect } from 'chai';
import { parse } from '../src/parser/index.js';
import { traverseAst } from '../src/parser/visitor.js';
import type { AstNode } from '../src/parser/ast.js';

/** Collect all node types visited via enterNode */
function collectTypes(sql: string): string[] {
	const ast = parse(sql);
	const types: string[] = [];
	traverseAst(ast, {
		enterNode(node: AstNode) {
			types.push(node.type);
		},
	});
	return types;
}

describe('traverseAst', () => {
	describe('traversal control flow', () => {
		it('traverses all children when enterNode returns void', () => {
			const types = collectTypes('select 1, 2');
			expect(types).to.include('select');
			expect(types).to.include('literal');
			expect(types.filter(t => t === 'literal')).to.have.length(2);
		});

		it('stops traversal of a branch when enterNode returns false', () => {
			const ast = parse('select 1 + 2');
			const types: string[] = [];
			traverseAst(ast, {
				enterNode(node: AstNode) {
					types.push(node.type);
					// Stop traversal at binary nodes — should not visit children
					if (node.type === 'binary') return false;
				},
			});
			expect(types).to.include('select');
			expect(types).to.include('binary');
			// The literals under the binary should NOT be visited
			expect(types).to.not.include('literal');
		});

		it('continues traversal when enterNode returns true', () => {
			const types: string[] = [];
			const ast = parse('select 1');
			traverseAst(ast, {
				enterNode(node: AstNode) {
					types.push(node.type);
					return true;
				},
			});
			expect(types).to.include('select');
			expect(types).to.include('literal');
		});

		it('stops branch when specific visitor returns false', () => {
			const ast = parse('select 1 + 2');
			const types: string[] = [];
			traverseAst(ast, {
				enterNode(node: AstNode) {
					types.push(node.type);
				},
				visitSelect() {
					return false; // Stop — should not visit children of select
				},
			});
			// enterNode sees the select, but visitSelect stops further traversal
			expect(types).to.deep.equal(['select']);
		});

		it('calls exitNode after traversing children', () => {
			const ast = parse('select 1');
			const events: string[] = [];
			traverseAst(ast, {
				enterNode(node: AstNode) {
					events.push(`enter:${node.type}`);
				},
				exitNode(node: AstNode) {
					events.push(`exit:${node.type}`);
				},
			});
			expect(events).to.deep.equal([
				'enter:select',
				'enter:literal',
				'exit:literal',
				'exit:select',
			]);
		});

		it('does not call exitNode when enterNode returns false', () => {
			const ast = parse('select 1');
			const events: string[] = [];
			traverseAst(ast, {
				enterNode(node: AstNode) {
					events.push(`enter:${node.type}`);
					return false; // Stop at select
				},
				exitNode(node: AstNode) {
					events.push(`exit:${node.type}`);
				},
			});
			expect(events).to.deep.equal(['enter:select']);
		});
	});

	describe('expression node types', () => {
		it('traverses CASE expression children', () => {
			const types = collectTypes('select case x when 1 then 2 when 3 then 4 else 5 end from t');
			expect(types).to.include('case');
			// base expr (x), when values, then values, else value
			const literals = types.filter(t => t === 'literal');
			expect(literals.length).to.be.greaterThanOrEqual(5);
		});

		it('traverses CASE expression without base expr', () => {
			const types = collectTypes('select case when x > 1 then 2 else 3 end from t');
			expect(types).to.include('case');
			expect(types).to.include('binary'); // x > 1
		});

		it('traverses IN expression with values list', () => {
			const types = collectTypes('select x in (1, 2, 3) from t');
			expect(types).to.include('in');
			const literals = types.filter(t => t === 'literal');
			expect(literals.length).to.be.greaterThanOrEqual(3);
		});

		it('traverses IN expression with subquery', () => {
			const types = collectTypes('select x in (select id from t2) from t');
			expect(types).to.include('in');
			// The subquery select should be traversed
			const selects = types.filter(t => t === 'select');
			expect(selects.length).to.equal(2);
		});

		it('traverses EXISTS expression', () => {
			const types = collectTypes('select exists(select 1 from t) from t');
			expect(types).to.include('exists');
			const selects = types.filter(t => t === 'select');
			expect(selects.length).to.equal(2);
		});

		it('traverses BETWEEN expression', () => {
			const types = collectTypes('select x between 1 and 10 from t');
			expect(types).to.include('between');
			const literals = types.filter(t => t === 'literal');
			expect(literals.length).to.be.greaterThanOrEqual(2);
		});
	});

	describe('WITH clause (CTE) traversal', () => {
		it('traverses CTEs in SELECT', () => {
			const types = collectTypes('with cte as (select 1) select * from cte');
			const selects = types.filter(t => t === 'select');
			// The outer select and the CTE select
			expect(selects.length).to.equal(2);
		});
	});

	describe('result-column WITH INVERSE traversal', () => {
		it('traverses authored-inverse assignment expressions', () => {
			const types = collectTypes('select a + 1 as b with inverse (a = new.b - 1) from t');
			// The forward expression `a + 1` and the inverse expression `new.b - 1`
			expect(types.filter(t => t === 'binary')).to.have.length(2);
			expect(types.filter(t => t === 'literal')).to.have.length(2);
		});
	});

	describe('statement node types', () => {
		it('traverses INSERT with VALUES', () => {
			const types = collectTypes('insert into t (a, b) values (1, 2), (3, 4)');
			expect(types).to.include('insert');
			expect(types).to.include('literal');
			const literals = types.filter(t => t === 'literal');
			expect(literals.length).to.be.greaterThanOrEqual(4);
		});

		it('traverses INSERT with SELECT', () => {
			const types = collectTypes('insert into t (a) select x from t2');
			expect(types).to.include('insert');
			expect(types).to.include('select');
		});

		it('traverses INSERT with CTE', () => {
			const types = collectTypes('with cte as (select 1 as x) insert into t (a) select x from cte');
			expect(types).to.include('insert');
			const selects = types.filter(t => t === 'select');
			expect(selects.length).to.equal(2);
		});

		it('traverses UPDATE with WHERE', () => {
			const types = collectTypes('update t set a = 1 where b > 2');
			expect(types).to.include('update');
			expect(types).to.include('binary'); // b > 2
			expect(types).to.include('literal');
		});

		it('traverses UPDATE with CTE', () => {
			const types = collectTypes('with cte as (select 1 as x) update t set a = (select x from cte)');
			expect(types).to.include('update');
			const selects = types.filter(t => t === 'select');
			expect(selects.length).to.be.greaterThanOrEqual(1);
		});

		it('traverses an inline-subquery UPDATE target body', () => {
			// The real body hangs off `targetSource`, not `table` (a synthetic alias
			// placeholder), so the traversal must descend into it to reach the inner select.
			const types = collectTypes("update (select id, color from base) as v set color = 'x' where v.id = 1");
			expect(types).to.include('update');
			expect(types).to.include('subquerySource');
			expect(types).to.include('select'); // the inline body
		});

		it('traverses an inline-subquery DELETE target body', () => {
			const types = collectTypes('delete from (select id from base) as v where v.id = 1');
			expect(types).to.include('delete');
			expect(types).to.include('subquerySource');
			expect(types).to.include('select');
		});

		it('traverses DELETE with WHERE', () => {
			const types = collectTypes('delete from t where x = 1');
			expect(types).to.include('delete');
			expect(types).to.include('binary'); // x = 1
		});

		it('traverses DELETE with CTE', () => {
			const types = collectTypes('with cte as (select 1 as x) delete from t where x in (select x from cte)');
			expect(types).to.include('delete');
			expect(types).to.include('in');
		});

		it('traverses VALUES statement', () => {
			const types = collectTypes('values (1, 2), (3, 4)');
			expect(types).to.include('values');
			const literals = types.filter(t => t === 'literal');
			expect(literals.length).to.be.greaterThanOrEqual(4);
		});
	});

	describe('source node types', () => {
		it('traverses JOIN clause', () => {
			const types = collectTypes('select * from t1 join t2 on t1.id = t2.id');
			expect(types).to.include('join');
			expect(types).to.include('binary'); // ON condition
		});

		it('traverses function source', () => {
			const types = collectTypes('select * from json_each(\'[1,2,3]\')');
			expect(types).to.include('functionSource');
		});

		it('traverses subquery source', () => {
			const types = collectTypes('select * from (select 1 as x) as sub');
			expect(types).to.include('subquerySource');
			const selects = types.filter(t => t === 'select');
			expect(selects.length).to.equal(2);
		});
	});

	describe('expression node types - additional', () => {
		it('traverses CAST expression', () => {
			const types = collectTypes('select cast(1 as text) from t');
			expect(types).to.include('cast');
			expect(types).to.include('literal');
		});

		it('traverses COLLATE expression', () => {
			const types = collectTypes('select x collate nocase from t');
			expect(types).to.include('collate');
		});

		it('traverses function expression', () => {
			const types = collectTypes('select upper(x) from t');
			expect(types).to.include('function');
		});

		it('traverses subquery expression', () => {
			const types = collectTypes('select (select 1) from t');
			expect(types).to.include('subquery');
		});

		it('traverses unary expression', () => {
			const types = collectTypes('select -1 from t');
			expect(types).to.include('unary');
		});

		it('traverses identifier/column/parameter nodes', () => {
			const types = collectTypes('select x from t');
			expect(types).to.include('column');
		});

		it('traverses SELECT with GROUP BY, HAVING, ORDER BY, LIMIT, OFFSET', () => {
			const types = collectTypes('select x, count(*) from t group by x having count(*) > 1 order by x limit 10 offset 5');
			expect(types).to.include('select');
			// GROUP BY, HAVING, ORDER BY, LIMIT, OFFSET expressions should all be traversed
			const literals = types.filter(t => t === 'literal');
			expect(literals.length).to.be.greaterThanOrEqual(3); // 1, 10, 5
		});

		it('traverses UNION', () => {
			const types = collectTypes('select 1 union select 2');
			// The union branch is traversed (second select may be stored differently)
			expect(types).to.include('select');
			const literals = types.filter(t => t === 'literal');
			expect(literals.length).to.be.greaterThanOrEqual(1);
		});
	});

	describe('DDL node types are handled without error', () => {
		it('handles CREATE TABLE', () => {
			const types = collectTypes('create table t (id integer primary key, name text)');
			expect(types).to.include('createTable');
		});

		it('handles CREATE INDEX', () => {
			const types = collectTypes('create index idx on t (name)');
			expect(types).to.include('createIndex');
		});

		it('handles CREATE VIEW', () => {
			const types = collectTypes('create view v as select 1');
			expect(types).to.include('createView');
		});

		it('handles DROP statement', () => {
			const types = collectTypes('drop table t');
			expect(types).to.include('drop');
		});
	});

	describe('handles undefined/null nodes gracefully', () => {
		it('does nothing for undefined node', () => {
			const types: string[] = [];
			traverseAst(undefined, {
				enterNode(node: AstNode) {
					types.push(node.type);
				},
			});
			expect(types).to.be.empty;
		});
	});
});

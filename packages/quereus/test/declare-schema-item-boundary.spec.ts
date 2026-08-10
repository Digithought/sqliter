/**
 * Items inside `declare schema <name> { … }` need no separator, so the leading
 * keyword of one item sits exactly where the previous item's body would accept a
 * bare (no-`as`) alias. Unreserved item keywords — `materialized`, `seed` — used
 * to be absorbed there, silently turning `materialized view mv` into a plain
 * `view mv`. The parser now bars item keywords from the bare-alias slot while a
 * block item is being parsed (the alias barrier).
 *
 * These tests pin the item kinds AND the absence of a stolen alias: asserting
 * only the kinds would pass if the alias were merely relocated.
 */

import { expect } from 'chai';
import { parse } from '../src/parser/index.js';
import { astToString } from '../src/emit/ast-stringify.js';
import type {
	DeclareSchemaStmt, DeclaredView, DeclaredMaterializedView, DeclaredSeed, DeclaredTable,
	SelectStmt, TableSource, SubquerySource, FunctionSource, DeclareLensStmt,
	Expression, ColumnExpr, ExistsExpr, SubqueryExpr,
} from '../src/parser/ast.js';

function parseDeclared(sql: string): DeclareSchemaStmt {
	const stmt = parse(sql);
	expect(stmt.type).to.equal('declareSchema');
	return stmt as DeclareSchemaStmt;
}

function itemKinds(stmt: DeclareSchemaStmt): string[] {
	return stmt.items.map(item => item.type);
}

/** The SELECT body of a declared (materialized) view item. */
function viewBody(stmt: DeclareSchemaStmt, index: number): SelectStmt {
	const item = stmt.items[index] as DeclaredView | DeclaredMaterializedView;
	return item.viewStmt.select as SelectStmt;
}

/** The first result column of a SELECT, asserted to be an expression column. */
function firstColumn(select: SelectStmt): { expr: Expression; alias?: string } {
	const column = select.columns[0];
	expect(column.type).to.equal('column');
	if (column.type !== 'column') throw new Error('unreachable');
	return column;
}

/** Asserts the expression is an unqualified reference to `name`. */
function expectColumnRef(expr: Expression, name: string): void {
	expect(expr.type).to.equal('column');
	expect((expr as ColumnExpr).name).to.equal(name);
}

describe('declare schema item boundaries', () => {

	describe('materialized view after a body that ends at a bare-alias slot', () => {

		it('is not swallowed by a table source', () => {
			const stmt = parseDeclared(
				`declare schema main {
					view v1 as select id from t1
					materialized view m2 as select id from t1
				}`
			);
			expect(itemKinds(stmt)).to.deep.equal(['declaredView', 'declaredMaterializedView']);
			const source = viewBody(stmt, 0).from![0] as TableSource;
			expect(source.type).to.equal('table');
			expect(source.alias).to.be.undefined;
		});

		it('is not swallowed by an implicit column alias', () => {
			const stmt = parseDeclared(
				`declare schema main {
					view v1 as select 1
					materialized view m2 as select id from t1
				}`
			);
			expect(itemKinds(stmt)).to.deep.equal(['declaredView', 'declaredMaterializedView']);
			expect(firstColumn(viewBody(stmt, 0)).alias).to.be.undefined;
		});

		it('is not swallowed by a subquery source', () => {
			const stmt = parseDeclared(
				`declare schema main {
					view v1 as select x from (select 1 as x)
					materialized view m2 as select id from t1
				}`
			);
			expect(itemKinds(stmt)).to.deep.equal(['declaredView', 'declaredMaterializedView']);
			const source = viewBody(stmt, 0).from![0] as SubquerySource;
			expect(source.type).to.equal('subquerySource');
			// An unaliased subquery gets a generated correlation name, never `materialized`.
			expect(source.alias).to.not.equal('materialized');
		});

		it('is not swallowed by a table-function source', () => {
			const stmt = parseDeclared(
				`declare schema main {
					view v1 as select value from generate_series(1, 3)
					materialized view m2 as select id from t1
				}`
			);
			expect(itemKinds(stmt)).to.deep.equal(['declaredView', 'declaredMaterializedView']);
			const source = viewBody(stmt, 0).from![0] as FunctionSource;
			expect(source.type).to.equal('functionSource');
			expect(source.alias).to.be.undefined;
		});

		it('is not swallowed by a `maintained as` body', () => {
			const stmt = parseDeclared(
				`declare schema main {
					table t2 (id integer primary key) maintained as select id from t1
					materialized view m2 as select id from t1
				}`
			);
			expect(itemKinds(stmt)).to.deep.equal(['declaredTable', 'declaredMaterializedView']);
			const maintained = (stmt.items[0] as DeclaredTable).tableStmt.maintained;
			expect(maintained).to.not.be.undefined;
			const source = (maintained!.select as SelectStmt).from![0] as TableSource;
			expect(source.alias).to.be.undefined;
		});
	});

	describe('seed after a view body', () => {

		it('parses as a seed item, not a stolen alias', () => {
			const stmt = parseDeclared(
				`declare schema main {
					view v1 as select id from t1
					seed t1 ( (1, 'x') )
				}`
			);
			expect(itemKinds(stmt)).to.deep.equal(['declaredView', 'declaredSeed']);
			expect((viewBody(stmt, 0).from![0] as TableSource).alias).to.be.undefined;
			expect((stmt.items[1] as DeclaredSeed).tableName).to.equal('t1');
		});

		it('parses after a materialized view body', () => {
			const stmt = parseDeclared(
				`declare schema main {
					materialized view m1 as select id from t1
					seed t1 ( (1, 'x') )
				}`
			);
			expect(itemKinds(stmt)).to.deep.equal(['declaredMaterializedView', 'declaredSeed']);
		});
	});

	describe('explicitly separated items are unchanged', () => {

		it('parses the same with `;` between items', () => {
			const stmt = parseDeclared(
				`declare schema main {
					view v1 as select id from t1;
					materialized view m2 as select id from t1;
					seed t1 ( (1, 'x') );
				}`
			);
			expect(itemKinds(stmt)).to.deep.equal(['declaredView', 'declaredMaterializedView', 'declaredSeed']);
			expect((viewBody(stmt, 0).from![0] as TableSource).alias).to.be.undefined;
		});
	});

	describe('escape hatches inside a block body', () => {

		it('keeps an explicit `as materialized` alias', () => {
			const stmt = parseDeclared(
				`declare schema main {
					view v1 as select id from t1 as materialized
				}`
			);
			expect(itemKinds(stmt)).to.deep.equal(['declaredView']);
			expect((viewBody(stmt, 0).from![0] as TableSource).alias).to.equal('materialized');
		});

		it('keeps a quoted "materialized" alias', () => {
			const stmt = parseDeclared(
				`declare schema main {
					view v1 as select id from t1 "materialized"
				}`
			);
			expect(itemKinds(stmt)).to.deep.equal(['declaredView']);
			expect((viewBody(stmt, 0).from![0] as TableSource).alias).to.equal('materialized');
		});

		it('still parses a column reference named `materialized`', () => {
			const stmt = parseDeclared(
				`declare schema main {
					view v1 as select materialized from t1
				}`
			);
			expect(itemKinds(stmt)).to.deep.equal(['declaredView']);
			expectColumnRef(firstColumn(viewBody(stmt, 0)).expr, 'materialized');
		});
	});

	describe('outside a declaration block nothing changes', () => {

		it('parses `select materialized from t1`', () => {
			const stmt = parse('select materialized from t1') as SelectStmt;
			expectColumnRef(firstColumn(stmt).expr, 'materialized');
		});

		it('parses `select a from t1 materialized` as a bare table alias', () => {
			const stmt = parse('select a from t1 materialized') as SelectStmt;
			expect((stmt.from![0] as TableSource).alias).to.equal('materialized');
		});

		it('parses `select seed from t1`', () => {
			const stmt = parse('select seed from t1') as SelectStmt;
			expectColumnRef(firstColumn(stmt).expr, 'seed');
		});

		it('parses `select 1 materialized` as an implicit column alias', () => {
			const stmt = parse('select 1 materialized') as SelectStmt;
			expect(firstColumn(stmt).alias).to.equal('materialized');
		});
	});

	describe('bare aliases inside parentheses are unaffected', () => {

		it('keeps a bare table alias inside a subquery source', () => {
			const stmt = parseDeclared(
				`declare schema main {
					view v1 as select x from (select id as x from t1 materialized) s
					materialized view m2 as select id from t1
				}`
			);
			expect(itemKinds(stmt)).to.deep.equal(['declaredView', 'declaredMaterializedView']);
			const source = viewBody(stmt, 0).from![0] as SubquerySource;
			expect(source.alias).to.equal('s');
			const inner = source.subquery as SelectStmt;
			expect((inner.from![0] as TableSource).alias).to.equal('materialized');
		});

		it('keeps a bare table alias inside an EXISTS subquery', () => {
			const stmt = parseDeclared(
				`declare schema main {
					view v1 as select id from t1 where exists (select 1 from t2 materialized)
					materialized view m2 as select id from t1
				}`
			);
			expect(itemKinds(stmt)).to.deep.equal(['declaredView', 'declaredMaterializedView']);
			const where = viewBody(stmt, 0).where as ExistsExpr;
			expect(where.type).to.equal('exists');
			const inner = where.subquery as SelectStmt;
			expect((inner.from![0] as TableSource).alias).to.equal('materialized');
		});

		it('keeps a bare column alias inside a scalar subquery', () => {
			const stmt = parseDeclared(
				`declare schema main {
					view v1 as select (select 1 materialized) as z
					materialized view m2 as select id from t1
				}`
			);
			expect(itemKinds(stmt)).to.deep.equal(['declaredView', 'declaredMaterializedView']);
			const scalar = firstColumn(viewBody(stmt, 0)).expr as SubqueryExpr;
			expect(scalar.type).to.equal('subquery');
			expect(firstColumn(scalar.query as SelectStmt).alias).to.equal('materialized');
		});
	});

	describe('other item kinds at the boundary', () => {

		it('parses a materialized view after an assertion', () => {
			const stmt = parseDeclared(
				`declare schema main {
					assertion a1 check (not exists (select 1 from t1))
					materialized view m2 as select id from t1
				}`
			);
			expect(itemKinds(stmt)).to.deep.equal(['declaredAssertion', 'declaredMaterializedView']);
		});

		it('parses a materialized view after an index', () => {
			const stmt = parseDeclared(
				`declare schema main {
					table t1 { id integer primary key }
					index i1 on t1 (id)
					materialized view m2 as select id from t1
				}`
			);
			expect(itemKinds(stmt))
				.to.deep.equal(['declaredTable', 'declaredIndex', 'declaredMaterializedView']);
		});

		it('parses a materialized view after a seed', () => {
			const stmt = parseDeclared(
				`declare schema main {
					seed t1 ( (1, 'x') )
					materialized view m2 as select id from t1
				}`
			);
			expect(itemKinds(stmt)).to.deep.equal(['declaredSeed', 'declaredMaterializedView']);
		});

		it('parses a materialized view after a compound (UNION) view body', () => {
			const stmt = parseDeclared(
				`declare schema main {
					view v1 as select id from t1 union select id from t2
					materialized view m2 as select id from t1
				}`
			);
			expect(itemKinds(stmt)).to.deep.equal(['declaredView', 'declaredMaterializedView']);
		});
	});

	describe('stray separators produce no items', () => {

		it('ignores a leading `;`', () => {
			const stmt = parseDeclared(`declare schema main { ; view v1 as select 1 }`);
			expect(itemKinds(stmt)).to.deep.equal(['declaredView']);
		});

		it('ignores a doubled `;` between items', () => {
			const stmt = parseDeclared(
				`declare schema main { view v1 as select 1 ;; view v2 as select 2 }`
			);
			expect(itemKinds(stmt)).to.deep.equal(['declaredView', 'declaredView']);
		});
	});

	describe('a separator-less block survives a stringify round trip', () => {

		it('re-parses to the same item kinds', () => {
			const sql = `declare schema main {
				view v1 as select id from t1
				materialized view m2 as select id from t1
			}`;
			const emitted = astToString(parse(sql));
			expect(itemKinds(parseDeclared(emitted)))
				.to.deep.equal(['declaredView', 'declaredMaterializedView']);
		});
	});

	describe('unrecognized items', () => {

		it('does not consume the rest of the block', () => {
			const stmt = parseDeclared(
				`declare schema main {
					domain d1 as text
					table t1 { id integer primary key }
				}`
			);
			expect(itemKinds(stmt)).to.deep.equal(['declareIgnored', 'declaredTable']);
			expect((stmt.items[1] as DeclaredTable).tableStmt.table.name).to.equal('t1');
		});

		it('does not end the block on a brace nested inside the ignored item', () => {
			const stmt = parseDeclared(
				`declare schema main {
					collation c1 using x { y };
					table t1 { id integer primary key }
				}`
			);
			expect(itemKinds(stmt)).to.deep.equal(['declareIgnored', 'declaredTable']);
		});

		it('does not end the block on a parenthesized payload inside the ignored item', () => {
			const stmt = parseDeclared(
				`declare schema main {
					domain d1 as decimal(10, 2)
					table t1 { id integer primary key }
				}`
			);
			expect(itemKinds(stmt)).to.deep.equal(['declareIgnored', 'declaredTable']);
		});

		it('closes the block when the ignored item is last', () => {
			const stmt = parseDeclared(
				`declare schema main {
					table t1 { id integer primary key }
					collation c1 using x
				}`
			);
			expect(itemKinds(stmt)).to.deep.equal(['declaredTable', 'declareIgnored']);
		});
	});

	describe('lens override blocks', () => {

		it('parses successive `view` overrides', () => {
			const stmt = parse(
				`declare lens for logical over basis {
					view t1 as select id from b1
					view t2 as select id from b2
				}`
			) as DeclareLensStmt;
			expect(stmt.type).to.equal('declareLens');
			expect(stmt.overrides.map(o => o.table)).to.deep.equal(['t1', 't2']);
			expect((stmt.overrides[0].select.from![0] as TableSource).alias).to.be.undefined;
		});
	});
});

import { expect } from 'chai';
import { parse, parseAll } from '../src/parser/index.js';
import { astToString, expressionToString, quoteIdentifier } from '../src/emit/index.js';
import type { CreateViewStmt, DeleteStmt, InsertStmt, ResultColumnExpr, SelectStmt, UpdateStmt } from '../src/parser/index.js';

/** Round-trip a full statement: parse → stringify → parse → stringify, compare strings */
function roundTripStmt(sql: string): string {
	const ast1 = parse(sql);
	const str1 = astToString(ast1);
	const ast2 = parse(str1);
	const str2 = astToString(ast2);
	expect(str2, `statement round-trip mismatch for: ${sql}`).to.equal(str1);
	return str1;
}

/** Round-trip an expression via SELECT wrapper */
function roundTripExpr(exprSql: string): string {
	const stmt = parse(`select ${exprSql}`) as SelectStmt;
	const col = stmt.columns[0];
	if (col.type !== 'column') throw new Error('Expected column result');
	const str1 = expressionToString(col.expr);
	const stmt2 = parse(`select ${str1}`) as SelectStmt;
	const col2 = stmt2.columns[0];
	if (col2.type !== 'column') throw new Error('Expected column result');
	const str2 = expressionToString(col2.expr);
	expect(str2, `expression round-trip mismatch for: ${exprSql}`).to.equal(str1);
	return str1;
}

describe('Emit: statement round-trips', () => {

	describe('SELECT', () => {
		it('basic columns', () => {
			roundTripStmt('select a, b, c from t');
		});

		it('WHERE clause', () => {
			roundTripStmt('select x from t where x > 10');
		});

		it('ORDER BY', () => {
			roundTripStmt('select x from t order by x desc');
		});

		it('LIMIT and OFFSET', () => {
			roundTripStmt('select x from t limit 10 offset 5');
		});

		it('GROUP BY and HAVING', () => {
			roundTripStmt('select a, count(*) from t group by a having count(*) > 1');
		});

		it('DISTINCT', () => {
			roundTripStmt('select distinct a, b from t');
		});

		it('compound UNION ALL', () => {
			roundTripStmt('select 1 union all select 2');
		});

		it('compound UNION', () => {
			roundTripStmt('select a from t1 union select b from t2');
		});

		it('compound INTERSECT', () => {
			roundTripStmt('select a from t1 intersect select b from t2');
		});

		it('compound EXCEPT', () => {
			roundTripStmt('select a from t1 except select b from t2');
		});

		it('compound UNION with set-op membership columns', () => {
			// The `exists <branch> as <name>` membership clause sits between the operator
			// keyword and the right leg and round-trips structurally (branch always explicit).
			roundTripStmt('select id, x from a union exists left as inA, exists right as inB select id, x from b');
		});

		it('compound INTERSECT/EXCEPT with single membership column', () => {
			roundTripStmt('select id, x from a intersect exists right as inB select id, x from b');
			roundTripStmt('select id, x from a except exists left as inL select id, x from b');
		});

		it('rejects set-op membership columns on DIFF', () => {
			expect(() => parse('select id from a diff exists left as inA select id from b')).to.throw();
		});

		describe('parenthesized compound legs', () => {
			// Parens are an escape hatch for left-associative grouping. The simple
			// case carries the SAME AST as the plain compound, so stringify drops the
			// redundant parens; the grouped case carries a `select * from (…)` wrapper
			// that re-emits the parens structurally. Both are idempotent.
			it('simple parens collapse to the plain compound (redundant parens dropped)', () => {
				expect(roundTripStmt('(select 1) union (select 2)')).to.equal('select 1 union select 2');
			});

			it('regression: an unparenthesized compound is unchanged (right-leaning)', () => {
				roundTripStmt('select a from t1 union select b from t2');
			});

			it('parallel siblings round-trip stably (left wrapper carried structurally)', () => {
				roundTripStmt('(select a from t1 union select b from t2) union (select c from t3 union select d from t4)');
			});

			it('mixed-operator parenthesized chain round-trips stably', () => {
				roundTripStmt('(select 1) intersect (select 2) except (select 3)');
			});

			it('parenthesized leg as a view body round-trips', () => {
				roundTripStmt('create view v as (select 1) union (select 2)');
			});

			it('membership on the outer op of a parenthesized compound round-trips stably', () => {
				roundTripStmt('(select id, x from a union select id, x from b) union exists left as inL, exists right as inR (select id, x from a union select id, x from b)');
			});

			// A leg's OWN order by / limit binds inside the parens at parse; the
			// stringifier must re-emit the grouping parens or re-parse would rebind
			// them to the outer compound (parenthesized-compound-set-op-legs gap #1).
			it('a leg with its own order by / limit re-emits its grouping parens', () => {
				expect(roundTripStmt('select 1 union (select 2 order by 1 limit 1)'))
					.to.equal('select 1 union (select 2 order by 1 limit 1)');
			});

			// Regression: an OUTER order by / limit on a compound applies to the whole
			// compound, so it must be emitted AFTER the compound chain — not in its
			// normal (left-leg) position, which produced un-reparseable SQL.
			it('regression: an outer order by / limit emits after the compound', () => {
				expect(roundTripStmt('select val from c_left union select val from c_right order by val limit 3'))
					.to.equal('select val from c_left union select val from c_right order by val limit 3');
			});
		});

		it('subquery in FROM', () => {
			roundTripStmt('select x from (select 1 as x) as sub');
		});

		it('INNER JOIN', () => {
			roundTripStmt('select a.x, b.y from a inner join b on a.id = b.id');
		});

		it('LEFT JOIN', () => {
			roundTripStmt('select a.x from a left join b on a.id = b.id');
		});

		it('CROSS JOIN', () => {
			roundTripStmt('select a.x from a cross join b');
		});

		it('LEFT JOIN with exists existence column (side resolved)', () => {
			// `exists as f` resolves to the non-preserved (right) side; stringify emits
			// the explicit side, so the round-trip is stable from the second parse on.
			expect(roundTripStmt('select a.x, f from a left join b on a.id = b.id exists as f'))
				.to.equal('select a.x, f from a left join b on a.id = b.id exists right as f');
		});

		it('LEFT JOIN with explicit exists right', () => {
			roundTripStmt('select a.x, f from a left join b on a.id = b.id exists right as f');
		});

		it('FULL JOIN with both-side exists existence columns', () => {
			roundTripStmt('select a.x, fa, fb from a full join b on a.id = b.id exists left as fa, exists right as fb');
		});

		it('rejects exists existence on inner/cross/full-without-side', () => {
			expect(() => parse('select a.x from a inner join b on a.id = b.id exists right as f')).to.throw();
			expect(() => parse('select a.x from a join b on a.id = b.id exists left as f')).to.throw();
			expect(() => parse('select a.x from a full join b on a.id = b.id exists as f')).to.throw();
			// `exists left` on a LEFT join names the preserved side — rejected.
			expect(() => parse('select a.x from a left join b on a.id = b.id exists left as f')).to.throw();
		});

		it('does not absorb a trailing exists-predicate subquery as an existence clause', () => {
			// `exists (` is the predicate form, never the existence clause — a WHERE
			// `exists (...)` after the join must still parse as a predicate.
			roundTripStmt('select a.x from a left join b on a.id = b.id where exists (select 1 from b)');
		});

		it('WITH CTE', () => {
			roundTripStmt('with cte as (select 1 as x) select x from cte');
		});

		it('WITH RECURSIVE', () => {
			roundTripStmt('with recursive r(n) as (select 1 union all select n + 1 from r where n < 10) select n from r');
		});

		it('WITH MATERIALIZED hint', () => {
			roundTripStmt('with x as materialized (select 1) select * from x');
		});

		it('WITH NOT MATERIALIZED hint', () => {
			roundTripStmt('with x as not materialized (select 1) select * from x');
		});

		it('preserves the materialization hint structurally', () => {
			// roundTripStmt only proves idempotence — a dropped hint re-emits identically
			// and still passes it. These assertions check the hint survives the *first*
			// parse→stringify→parse against the original, which is the actual regression.
			// Covers the keyword × {column list, recursive} cross-products that the
			// `withClauseToString` emitter and `commonTableExpression` parser share.
			for (const [sql, expected] of [
				['with x as materialized (select 1) select * from x', 'materialized'],
				['with x as not materialized (select 1) select * from x', 'not_materialized'],
				['with x as (select 1) select * from x', undefined],
				// Column list before AS, hint after.
				['with x (a) as materialized (select 1) select * from x', 'materialized'],
				['with x (a) as not materialized (select 1) select * from x', 'not_materialized'],
				// Recursive CTEs route through the same emitter/parser path.
				['with recursive r(n) as materialized (select 1 union all select n + 1 from r where n < 10) select n from r', 'materialized'],
				['with recursive r(n) as not materialized (select 1 union all select n + 1 from r where n < 10) select n from r', 'not_materialized'],
			] as const) {
				const stmt = parse(sql) as SelectStmt;
				const reparsed = parse(astToString(stmt)) as SelectStmt;
				expect(reparsed.withClause?.ctes[0].materializationHint, sql).to.equal(expected);
			}
		});
	});

	describe('result-column WITH INVERSE (authored inverses)', () => {
		/** Narrow the first result column to the expression form. */
		function firstExprColumn(stmt: SelectStmt): ResultColumnExpr {
			const col = stmt.columns[0];
			if (col.type !== 'column') throw new Error('Expected expression result column');
			return col;
		}

		it('single assignment with alias', () => {
			roundTripStmt('select a + 1 as b with inverse (a = new.b - 1) from t');
		});

		it('multiple assignments', () => {
			roundTripStmt("select b || ' ' || c as full_name with inverse (b = substr(new.full_name, 1, instr(new.full_name, ' ') - 1), c = substr(new.full_name, instr(new.full_name, ' ') + 1)) from t");
		});

		it('case expression body and case inverse expression', () => {
			roundTripStmt("select case code20 when 'A1' then 'A' when 'A2' then 'A' else code20 end as code with inverse (code20 = case new.code when 'A' then 'A1' else new.code end) from t");
		});

		it('clause without an alias', () => {
			roundTripStmt('select a + 1 with inverse (a = new.x - 1) from t');
		});

		it('parses into ResultColumnExpr.inverse with new.-qualified refs', () => {
			const stmt = parse('select a + 1 as b with inverse (a = new.b - 1) from t') as SelectStmt;
			const col = firstExprColumn(stmt);
			expect(col.alias).to.equal('b');
			expect(col.inverse).to.have.length(1);
			expect(col.inverse![0].column).to.equal('a');
			const inv = col.inverse![0].expr;
			expect(inv.type).to.equal('binary');
			if (inv.type !== 'binary') throw new Error('unreachable');
			// `new.b` is an ordinary qualified column reference — no parser special-casing.
			expect(inv.left).to.deep.include({ type: 'column', name: 'b', table: 'new' });
		});

		it('comma bounds the clause — next result column parses', () => {
			const str = roundTripStmt('select a + 1 with inverse (b = x - 1), c from t');
			const stmt = parse(str) as SelectStmt;
			expect(stmt.columns).to.have.length(2);
			expect(firstExprColumn(stmt).inverse).to.have.length(1);
			const second = stmt.columns[1];
			if (second.type !== 'column') throw new Error('Expected expression result column');
			expect(second.expr).to.deep.include({ type: 'column', name: 'c' });
			expect(second.inverse).to.equal(undefined);
		});

		it('empty assignment list is a parse error', () => {
			expect(() => parse('select a with inverse () from t')).to.throw();
		});

		it('duplicate target column is a parse error', () => {
			expect(() => parse('select a with inverse (b = 1, b = 2) from t')).to.throw();
		});

		it('star result columns cannot carry the clause — diagnostic names it', () => {
			expect(() => parse('select * with inverse (a = 1) from t')).to.throw(/WITH INVERSE/);
			expect(() => parse('select t.* with inverse (a = 1) from t')).to.throw(/WITH INVERSE/);
		});

		it('star followed by a non-INVERSE trailing WITH stays with the statement', () => {
			const stmt = parse('select * with schema main') as SelectStmt;
			expect(stmt.schemaPath).to.deep.equal(['main']);
		});

		it('inverse stays usable as an identifier', () => {
			roundTripStmt('select inverse from t');
			roundTripStmt('select x as inverse from t');
			const stmt = parse('select inverse from t') as SelectStmt;
			expect(firstExprColumn(stmt).expr).to.deep.include({ type: 'column', name: 'inverse' });
		});

		// --- `with` lookahead neighbors: commit only when WITH is followed by INVERSE ---

		it('statement-trailing WITH SCHEMA on a FROM-less select stays with the statement', () => {
			const stmt = parse('select a with schema main') as SelectStmt;
			expect(stmt.schemaPath).to.deep.equal(['main']);
			expect(firstExprColumn(stmt).inverse).to.equal(undefined);
		});

		it('inverse clause coexists with statement-trailing WITH SCHEMA', () => {
			const stmt = parse('select a + 1 as b with inverse (a = new.b - 1) from t with schema main') as SelectStmt;
			expect(stmt.schemaPath).to.deep.equal(['main']);
			expect(firstExprColumn(stmt).inverse).to.have.length(1);
		});

		it("view body's trailing WITH TAGS stays with the view", () => {
			const stmt = parse("create view v as select 1 with tags (k = 'x')") as CreateViewStmt;
			expect(stmt.tags).to.deep.equal({ k: 'x' });
			const body = stmt.select;
			if (body.type !== 'select') throw new Error('Expected select body');
			expect(firstExprColumn(body).inverse).to.equal(undefined);
		});

		it("view body's trailing WITH DEFAULTS stays with the view", () => {
			const stmt = parse('create view v as select a from t with defaults (b = 1)') as CreateViewStmt;
			const body = stmt.select;
			if (body.type !== 'select') throw new Error('Expected select body');
			expect(body.defaults).to.have.length(1);
			expect(firstExprColumn(body).inverse).to.equal(undefined);
		});

		// --- the clause survives everywhere select parses ---

		it('CTE body', () => {
			roundTripStmt('with v as (select a + 1 as b with inverse (a = new.b - 1) from t) select b from v');
		});

		it('subquery in FROM', () => {
			roundTripStmt('select b from (select a + 1 as b with inverse (a = new.b - 1) from t) as s');
		});

		it('view body, alone and with trailing with defaults + tags', () => {
			roundTripStmt('create view v as select a + 1 as b with inverse (a = new.b - 1) from t');
			roundTripStmt("create view v as select a + 1 as b with inverse (a = new.b - 1) from t with defaults (c = 1) with tags (k = 'x')");
		});

		it('compound legs', () => {
			roundTripStmt('select a + 1 as b with inverse (a = new.b - 1) from t union select c + 1 as b with inverse (c = new.b - 1) from u');
		});

		it('lens-block view body', () => {
			roundTripStmt('declare lens for logical over base { view v as select a + 1 as b with inverse (a = new.b - 1) from base.t }');
		});

		it('declarative-schema view item', () => {
			roundTripStmt('declare schema main { view v as select a + 1 as b with inverse (a = new.b - 1) from t }');
		});

		it('RETURNING result column (shared columnList path)', () => {
			roundTripStmt('insert into t (a) values (1) returning a + 1 as b with inverse (a = new.b - 1)');
		});
	});

	describe('INSERT', () => {
		it('INSERT INTO ... VALUES', () => {
			roundTripStmt("insert into t values (1, 'hello', null)");
		});

		it('INSERT INTO ... SELECT', () => {
			roundTripStmt('insert into t select * from s');
		});

		it('INSERT with column list', () => {
			roundTripStmt("insert into t (a, b) values (1, 2)");
		});

		it('INSERT with RETURNING', () => {
			roundTripStmt("insert into t (a) values (1) returning *");
		});

		it('INSERT with ON CONFLICT DO NOTHING', () => {
			roundTripStmt("insert into t (a) values (1) on conflict do nothing");
		});

		it('INSERT with ON CONFLICT DO UPDATE (upsert)', () => {
			roundTripStmt("insert into t (a, b) values (1, 2) on conflict (a) do update set b = 3");
		});
	});

	describe('UPDATE', () => {
		it('basic SET', () => {
			roundTripStmt('update t set a = 1');
		});

		it('with WHERE', () => {
			roundTripStmt('update t set a = 1 where b > 0');
		});

		it('with RETURNING', () => {
			roundTripStmt('update t set a = 1 returning *');
		});
	});

	describe('DELETE', () => {
		it('basic', () => {
			roundTripStmt('delete from t');
		});

		it('with WHERE', () => {
			roundTripStmt('delete from t where id = 1');
		});

		it('with RETURNING', () => {
			roundTripStmt('delete from t where id = 1 returning *');
		});
	});

	describe('VALUES', () => {
		it('standalone VALUES clause', () => {
			roundTripStmt('values (1, 2), (3, 4)');
		});
	});

	describe('WITH SCHEMA (schema search path)', () => {
		// roundTripStmt alone only proves idempotence — a silently dropped clause
		// re-emits identically and still passes. Each case also asserts the
		// schemaPath survives the first parse → stringify → parse.
		function expectSchemaPathSurvives<T extends SelectStmt | InsertStmt | UpdateStmt | DeleteStmt>(
			sql: string, expected: string[],
		): T {
			const stmt = parse(sql) as T;
			expect(stmt.schemaPath, `parse of: ${sql}`).to.deep.equal(expected);
			const reparsed = parse(roundTripStmt(sql)) as T;
			expect(reparsed.schemaPath, sql).to.deep.equal(expected);
			return reparsed;
		}

		it('SELECT with single-schema path', () => {
			expectSchemaPathSurvives<SelectStmt>('select a from t with schema main', ['main']);
		});

		it('SELECT with multi-schema path', () => {
			expectSchemaPathSurvives<SelectStmt>('select a from t with schema s1, s2', ['s1', 's2']);
		});

		it('SELECT: emitted after HAVING', () => {
			expectSchemaPathSurvives<SelectStmt>(
				'select a, count(*) from t group by a having count(*) > 1 with schema s1', ['s1']);
		});

		it('SELECT: emitted before ORDER BY / LIMIT', () => {
			const out = roundTripStmt('select a from t with schema s1 order by a limit 10');
			expect(out).to.equal('select a from t with schema s1 order by a limit 10');
			expectSchemaPathSurvives<SelectStmt>('select a from t with schema s1 order by a limit 10', ['s1']);
		});

		it('compound SELECT: binds before the compound operator, stays on the outer statement', () => {
			const reparsed = expectSchemaPathSurvives<SelectStmt>(
				'select a from t1 with schema s1 union select b from t2', ['s1']);
			expect(reparsed.compound?.op).to.equal('union');
			expect(roundTripStmt('select a from t1 with schema s1 union select b from t2'))
				.to.equal('select a from t1 with schema s1 union select b from t2');
		});

		it('compound SELECT with outer ORDER BY: schema before the operator, order by after the chain', () => {
			expectSchemaPathSurvives<SelectStmt>(
				'select a from t1 with schema s1 union select a from t2 order by a', ['s1']);
		});

		it('INSERT with trailing schema path', () => {
			expectSchemaPathSurvives<InsertStmt>('insert into t (a) values (1) with schema s1', ['s1']);
		});

		it('INSERT with ON CONFLICT and schema path', () => {
			expectSchemaPathSurvives<InsertStmt>(
				'insert into t (a) values (1) on conflict do nothing with schema s1, s2', ['s1', 's2']);
		});

		it('INSERT with tags and schema path (tags shield a SELECT source)', () => {
			const reparsed = expectSchemaPathSurvives<InsertStmt>(
				"insert into t select a from s with tags (k = 'x') with schema s1", ['s1']);
			expect(reparsed.tags).to.deep.equal({ k: 'x' });
			if (reparsed.source.type !== 'select') throw new Error('Expected select source');
			expect(reparsed.source.schemaPath).to.equal(undefined);
		});

		it('INSERT ... SELECT: schema on the source select stays on the select', () => {
			const stmt = parse('insert into t select a from s with schema s1') as InsertStmt;
			expect(stmt.schemaPath).to.equal(undefined);
			if (stmt.source.type !== 'select') throw new Error('Expected select source');
			expect(stmt.source.schemaPath).to.deep.equal(['s1']);
			roundTripStmt('insert into t select a from s with schema s1');
		});

		it('UPDATE with trailing schema path', () => {
			expectSchemaPathSurvives<UpdateStmt>('update t set a = 1 where b > 0 with schema s1, s2', ['s1', 's2']);
		});

		it('UPDATE with schema path and RETURNING', () => {
			expectSchemaPathSurvives<UpdateStmt>('update t set a = 1 with schema s1 returning *', ['s1']);
		});

		it('DELETE with trailing schema path', () => {
			expectSchemaPathSurvives<DeleteStmt>('delete from t where id = 1 with schema s1', ['s1']);
		});

		it('DELETE with schema path and RETURNING', () => {
			expectSchemaPathSurvives<DeleteStmt>('delete from t with schema s1 returning *', ['s1']);
		});
	});

	describe('CREATE TABLE', () => {
		it('basic columns with types', () => {
			roundTripStmt('create table t (a integer, b text)');
		});

		it('table-level tags', () => {
			roundTripStmt("create table t (a integer) with tags (display_name = 'Orders', audit = true)");
		});

		it('column-level tags', () => {
			roundTripStmt("create table t (a integer with tags (display_name = 'ID'), b text)");
		});

		it('column constraint tags', () => {
			roundTripStmt("create table t (a integer check (a > 0) with tags (error_message = 'Must be positive'))");
		});

		it('table constraint tags', () => {
			roundTripStmt("create table t (a integer, b integer, constraint uq unique (a) with tags (label = 'uq'))");
		});

		it('tag value types', () => {
			roundTripStmt("create table t (a integer) with tags (s = 'hi', n = 42, f = 3.14, bt = true, bf = false, z = null, neg = -10)");
		});

		it('combined WITH TAGS and WITH CONTEXT', () => {
			roundTripStmt("create table t (a integer) with context (user_name text) with tags (audit = true)");
		});

		it('combined WITH TAGS before WITH CONTEXT', () => {
			roundTripStmt("create table t (a integer) with tags (audit = true) with context (user_name text)");
		});

		it('PRIMARY KEY constraint', () => {
			roundTripStmt('create table t (id integer primary key, name text)');
		});

		it('NOT NULL and UNIQUE', () => {
			roundTripStmt('create table t (id integer not null unique)');
		});

		it('DEFAULT value', () => {
			roundTripStmt('create table t (a integer default 0)');
		});

		it('DEFAULT reading a populated sibling via new.<column>', () => {
			// The `new.` qualifier must survive the round-trip — dropping it would
			// silently corrupt the feature under schema export / declarative apply.
			const out = roundTripStmt(
				'create table t (id integer primary key, base integer, title text, doubled integer default (new.base * 2), slug text default (lower(new.title)))'
			);
			expect(out).to.contain('new.base');
			expect(out).to.contain('new.title');
		});

		it('CHECK constraint', () => {
			roundTripStmt('create table t (a integer check (a > 0))');
		});

		it('FOREIGN KEY column constraint', () => {
			roundTripStmt('create table orders (user_id integer references users(id))');
		});

		it('IF NOT EXISTS', () => {
			roundTripStmt('create table if not exists t (a integer)');
		});

		it('table-level PRIMARY KEY', () => {
			roundTripStmt('create table t (a integer, b integer, primary key (a, b))');
		});

		it('table-level FOREIGN KEY', () => {
			roundTripStmt('create table orders (user_id integer, foreign key (user_id) references users(id))');
		});

		it('GENERATED column', () => {
			roundTripStmt('create table t (a integer, b integer generated always as (a * 2))');
		});
	});

	describe('CREATE INDEX', () => {
		it('basic', () => {
			roundTripStmt('create index idx on t (a)');
		});

		it('UNIQUE', () => {
			roundTripStmt('create unique index idx on t (a)');
		});

		it('IF NOT EXISTS', () => {
			roundTripStmt('create index if not exists idx on t (a)');
		});

		it('partial index with WHERE', () => {
			roundTripStmt('create index idx on t (a) where a > 0');
		});

		it('with tags', () => {
			roundTripStmt("create index idx on t (a) with tags (purpose = 'search')");
		});
	});

	describe('CREATE VIEW', () => {
		it('basic', () => {
			roundTripStmt('create view v as select * from t');
		});

		it('IF NOT EXISTS', () => {
			roundTripStmt('create view if not exists v as select * from t');
		});

		it('with column list', () => {
			roundTripStmt('create view v (x, y) as select a, b from t');
		});

		it('with tags', () => {
			roundTripStmt("create view v as select * from t with tags (cacheable = true)");
		});
	});

	describe('CREATE MATERIALIZED VIEW', () => {
		// Post-consolidation shape: bare `create materialized view … as select …`
		// with NO `with refresh` policy clause (every MV is row-time maintained).
		it('basic (no refresh policy)', () => {
			roundTripStmt('create materialized view mv as select id, x from t');
		});

		it('IF NOT EXISTS', () => {
			roundTripStmt('create materialized view if not exists mv as select id, x from t');
		});

		it('with column list', () => {
			roundTripStmt('create materialized view mv (a, b) as select id, x from t');
		});

		it('with a partial (WHERE) + ORDER BY body', () => {
			roundTripStmt('create materialized view mv as select x, id from t where x > 0 order by x');
		});

		it('with tags', () => {
			roundTripStmt('create materialized view mv as select id, x from t with tags (owner = \'me\')');
		});
	});

	describe('DROP', () => {
		it('DROP TABLE', () => {
			roundTripStmt('drop table t');
		});

		it('DROP INDEX', () => {
			roundTripStmt('drop index idx');
		});

		it('DROP VIEW', () => {
			roundTripStmt('drop view v');
		});

		it('DROP TABLE IF EXISTS', () => {
			roundTripStmt('drop table if exists t');
		});
	});

	describe('ALTER TABLE', () => {
		it('RENAME TO', () => {
			roundTripStmt('alter table t rename to t2');
		});

		it('RENAME COLUMN', () => {
			roundTripStmt('alter table t rename column a to b');
		});

		it('ADD COLUMN', () => {
			roundTripStmt('alter table t add column c integer');
		});

		it('DROP COLUMN', () => {
			roundTripStmt('alter table t drop column c');
		});

		it('SET TAGS (table)', () => {
			roundTripStmt("alter table t set tags (display_name = 'T', audit = true)");
		});

		it('SET TAGS () clear (table)', () => {
			roundTripStmt('alter table t set tags ()');
		});

		it('ALTER COLUMN SET TAGS', () => {
			roundTripStmt("alter table t alter column c set tags (searchable = true)");
		});

		it('ALTER COLUMN SET TAGS () clear', () => {
			roundTripStmt('alter table t alter column c set tags ()');
		});

		it('ALTER CONSTRAINT SET TAGS', () => {
			roundTripStmt("alter table t alter constraint uq set tags (msg = 'dup')");
		});
	});

	describe('Transaction', () => {
		it('BEGIN', () => {
			roundTripStmt('begin');
		});

		it('COMMIT', () => {
			roundTripStmt('commit');
		});

		it('ROLLBACK', () => {
			roundTripStmt('rollback');
		});

		it('SAVEPOINT', () => {
			roundTripStmt('savepoint sp1');
		});

		it('RELEASE', () => {
			roundTripStmt('release sp1');
		});

		it('ROLLBACK TO', () => {
			roundTripStmt('rollback to sp1');
		});

		// Reserved-word savepoint names (the `release to` regression class) are now
		// covered exhaustively — every keyword, every savepoint form — by the
		// position-by-position suite in `emit-roundtrip-positions.spec.ts`.
	});

	describe('PRAGMA', () => {
		it('bare pragma', () => {
			roundTripStmt('pragma table_info');
		});

		it('pragma = value', () => {
			roundTripStmt('pragma cache_size = 1000');
		});
	});

	describe('ANALYZE', () => {
		it('bare', () => {
			roundTripStmt('analyze');
		});

		it('with table name', () => {
			roundTripStmt('analyze users');
		});
	});
});

describe('Emit: expression round-trips', () => {

	describe('Literals', () => {
		it('integer', () => {
			roundTripExpr('42');
		});

		it('float', () => {
			roundTripExpr('3.14');
		});

		it('negative number', () => {
			roundTripExpr('-1');
		});

		it('string', () => {
			roundTripExpr("'hello'");
		});

		it('NULL', () => {
			roundTripExpr('null');
		});

		it('blob literal', () => {
			roundTripExpr("x'ABCD'");
		});
	});

	describe('Column references', () => {
		it('simple column', () => {
			roundTripExpr('a');
		});

		it('table.column', () => {
			roundTripExpr('t.a');
		});
	});

	describe('Unary operators', () => {
		it('NOT expr', () => {
			roundTripExpr('not a');
		});

		it('-expr', () => {
			roundTripExpr('-a');
		});

		it('expr IS NULL', () => {
			roundTripExpr('a is null');
		});

		it('expr IS NOT NULL', () => {
			roundTripExpr('a is not null');
		});

		it('expr IS TRUE', () => {
			roundTripExpr('a is true');
		});

		it('expr IS NOT TRUE', () => {
			roundTripExpr('a is not true');
		});

		it('expr IS FALSE', () => {
			roundTripExpr('a is false');
		});

		it('expr IS NOT FALSE', () => {
			roundTripExpr('a is not false');
		});
	});

	describe('Function calls', () => {
		it('simple function', () => {
			roundTripExpr('length(x)');
		});

		it('multi-arg function', () => {
			roundTripExpr('substr(x, 1, 3)');
		});

		it('count(*)', () => {
			roundTripExpr('count(*)');
		});

		it('count(distinct x)', () => {
			roundTripExpr('count(distinct x)');
		});
	});

	describe('CAST', () => {
		it('cast to integer', () => {
			roundTripExpr('cast(x as integer)');
		});

		it('cast to text', () => {
			roundTripExpr('cast(x as text)');
		});
	});

	describe('CASE', () => {
		it('simple CASE x WHEN', () => {
			roundTripExpr("case x when 1 then 'a' when 2 then 'b' end");
		});

		it('searched CASE WHEN', () => {
			roundTripExpr("case when x > 0 then 'pos' when x < 0 then 'neg' end");
		});

		it('CASE with ELSE', () => {
			roundTripExpr("case when x > 0 then 'pos' else 'other' end");
		});
	});

	describe('Subquery expression', () => {
		it('scalar subquery', () => {
			roundTripExpr('(select 1)');
		});
	});

	describe('EXISTS', () => {
		it('exists subquery', () => {
			roundTripExpr('exists (select 1 from t)');
		});
	});

	describe('IN', () => {
		it('in value list', () => {
			roundTripExpr('x in (1, 2, 3)');
		});

		it('in subquery', () => {
			roundTripExpr('x in (select id from t)');
		});
	});

	describe('BETWEEN', () => {
		it('x between 1 and 10', () => {
			roundTripExpr('x between 1 and 10');
		});

		it('x not between 1 and 10', () => {
			roundTripExpr('x not between 1 and 10');
		});
	});

	describe('COLLATE', () => {
		it('collate nocase', () => {
			roundTripExpr('x collate nocase');
		});
	});

	describe('Window functions', () => {
		it('row_number() over (order by x)', () => {
			roundTripExpr('row_number() over (order by x)');
		});

		it('sum with partition by', () => {
			roundTripExpr('sum(x) over (partition by y order by z)');
		});

		it('with frame spec', () => {
			roundTripExpr('sum(x) over (order by y rows between unbounded preceding and current row)');
		});
	});

	describe('Nested/compound', () => {
		it('function of arithmetic', () => {
			roundTripExpr('abs(a + b * c)');
		});

		it('CASE with IN', () => {
			roundTripExpr("case when x in (1, 2) then 'a' else 'b' end");
		});
	});
});

describe('Emit: identifier quoting', () => {
	it('normal identifier is not quoted', () => {
		expect(quoteIdentifier('users')).to.equal('users');
	});

	it('reserved keyword "select" is quoted', () => {
		expect(quoteIdentifier('select')).to.equal('"select"');
	});

	it('reserved keyword "from" is quoted', () => {
		expect(quoteIdentifier('from')).to.equal('"from"');
	});

	it('reserved keyword "table" is quoted', () => {
		expect(quoteIdentifier('table')).to.equal('"table"');
	});

	it('identifier with spaces is quoted', () => {
		expect(quoteIdentifier('my table')).to.equal('"my table"');
	});

	it('identifier starting with digit is quoted', () => {
		expect(quoteIdentifier('1abc')).to.equal('"1abc"');
	});

	it('embedded double quotes are escaped', () => {
		expect(quoteIdentifier('a"b')).to.equal('"a""b"');
	});

	it('underscore-prefixed identifier is not quoted', () => {
		expect(quoteIdentifier('_private')).to.equal('_private');
	});
});

describe('Emit: string literal escaping', () => {
	it('simple string', () => {
		const result = roundTripExpr("'hello'");
		expect(result).to.equal("'hello'");
	});

	it('string with embedded single quote', () => {
		const result = roundTripExpr("'it''s'");
		expect(result).to.equal("'it''s'");
	});

	it('empty string', () => {
		const result = roundTripExpr("''");
		expect(result).to.equal("''");
	});

	it('string with multiple quotes', () => {
		const result = roundTripExpr("'a''b''c'");
		expect(result).to.equal("'a''b''c'");
	});
});

describe('Emit: edge cases', () => {
	it('NULL literal round-trip', () => {
		roundTripStmt('select null');
	});

	it('aliased expression', () => {
		roundTripStmt('select 1 as x');
	});

	it('star expression', () => {
		roundTripStmt('select *');
	});

	it('table.star', () => {
		roundTripStmt('select t.* from t');
	});

	it('schema-qualified table in FROM', () => {
		roundTripStmt('select * from main.t');
	});

	it('multiple statements via parseAll', () => {
		const stmts = parseAll('select 1; select 2');
		expect(stmts).to.have.length(2);
		for (const stmt of stmts) {
			const str1 = astToString(stmt);
			const ast2 = parse(str1);
			const str2 = astToString(ast2);
			expect(str2).to.equal(str1);
		}
	});
});

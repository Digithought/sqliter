import { expect } from 'chai';
import { parse } from '../../src/parser/index.js';
import { astToString, createTableToString, createViewToString, expressionToIdentityString, expressionToString } from '../../src/emit/ast-stringify.js';
import type {
	CreateTableStmt,
	CreateViewStmt,
	DeclareSchemaStmt,
	DeclaredAssertion,
	DeclaredIndex,
	DeclaredSeed,
	DeclaredTable,
	DeclaredView,
	DeleteStmt,
	Expression,
	InsertStmt,
	SelectStmt,
	TableConstraint,
	UpdateStmt,
} from '../../src/parser/ast.js';
import { ConflictResolution } from '../../src/common/constants.js';

/**
 * These tests pin the AST round-trip — parse → stringify → parse — at the
 * unit level, not just string equality. The previous round-trip suite
 * (`emit-roundtrip.spec.ts`) compared stringified output to stringified
 * output, which silently passed when the stringifier dropped a field
 * symmetrically. Walking the post-reparse AST exposes those drops.
 */
describe('Emit: ast-stringify AST round-trip', () => {

	describe('CHECK operations (issue #23)', () => {
		const findCheck = (cs: readonly TableConstraint[], name: string): TableConstraint => {
			const c = cs.find(x => x.type === 'check' && x.name === name);
			if (!c) throw new Error(`Expected named CHECK constraint '${name}' in re-parsed table`);
			return c;
		};

		it('preserves table-level `check on delete (...)` operations list', () => {
			const sql = 'create table T (Id int, primary key (Id), constraint X check on delete (false))';

			const original = parse(sql) as CreateTableStmt;
			const emitted = createTableToString(original);
			expect(emitted, 'emitted SQL should contain `on delete`').to.match(/check\s+on\s+delete\s*\(/i);

			const reparsed = parse(emitted) as CreateTableStmt;
			const cons = findCheck(reparsed.constraints, 'X');
			expect(cons.operations).to.deep.equal(['delete']);
		});

		it('preserves table-level `check on update (...)` operations list', () => {
			const sql = 'create table T (Id int, Val int, primary key (Id), constraint Y check on update (new.Val >= 0))';

			const original = parse(sql) as CreateTableStmt;
			const emitted = createTableToString(original);
			expect(emitted).to.match(/check\s+on\s+update\s*\(/i);

			const reparsed = parse(emitted) as CreateTableStmt;
			expect(findCheck(reparsed.constraints, 'Y').operations).to.deep.equal(['update']);
		});

		it('preserves multi-op `check on insert, update (...)` operations list', () => {
			const sql = 'create table T (Id int, primary key (Id), constraint Z check on insert, update (Id > 0))';

			const original = parse(sql) as CreateTableStmt;
			const emitted = createTableToString(original);
			// Both ops survive in order.
			expect(emitted).to.match(/check\s+on\s+insert\s*,\s*update\s*\(/i);

			const reparsed = parse(emitted) as CreateTableStmt;
			expect(findCheck(reparsed.constraints, 'Z').operations).to.deep.equal(['insert', 'update']);
		});

		it('preserves inline-column CHECK ON operations list', () => {
			const sql = 'create table T (Id int constraint NoDel check on delete (false), primary key (Id))';

			const original = parse(sql) as CreateTableStmt;
			const emitted = createTableToString(original);
			expect(emitted).to.match(/check\s+on\s+delete\s*\(/i);

			const reparsed = parse(emitted) as CreateTableStmt;
			const colConstraints = reparsed.columns[0].constraints;
			const check = colConstraints.find(c => c.type === 'check');
			expect(check, 'inline check constraint should survive').to.exist;
			expect(check!.operations).to.deep.equal(['delete']);
		});
	});

	describe('Compound SELECT (issue #21)', () => {
		it('preserves all four legs of a UNION ALL chain through view DDL', () => {
			const sql = "create view V as select 'a' as Code union all select 'b' as Code union all select 'c' as Code union all select 'd' as Code";

			const original = parse(sql) as CreateViewStmt;
			const emitted = createViewToString(original);
			// All four literal codes survive in the emitted SQL.
			expect(emitted).to.include("'a'");
			expect(emitted).to.include("'b'");
			expect(emitted).to.include("'c'");
			expect(emitted).to.include("'d'");

			const reparsed = parse(emitted) as CreateViewStmt;
			// Walk the linked compound chain and collect each leg's literal.
			// View body / compound legs are QueryExpr (any relation); for this
			// fixture every leg is a SELECT, but we narrow defensively.
			const codes: string[] = [];
			let cursor: SelectStmt | undefined =
				reparsed.select.type === 'select' ? (reparsed.select as SelectStmt) : undefined;
			while (cursor) {
				const col = cursor.columns[0];
				if (col.type !== 'column' || col.expr.type !== 'literal') {
					throw new Error('Expected literal-string projection per leg');
				}
				codes.push(String(col.expr.value));
				const next = cursor.compound?.select;
				cursor = next && next.type === 'select' ? (next as SelectStmt) : undefined;
			}
			expect(codes).to.deep.equal(['a', 'b', 'c', 'd']);
		});

		it('preserves UNION (DISTINCT) keyword', () => {
			const sql = 'create view V as select 1 as N union select 2 as N';
			const original = parse(sql) as CreateViewStmt;
			const emitted = createViewToString(original);
			// `union all` would be wrong here.
			expect(emitted).to.match(/\bunion\b/i);
			expect(emitted).to.not.match(/\bunion\s+all\b/i);

			const reparsed = parse(emitted) as CreateViewStmt;
			const body = reparsed.select;
			if (body.type !== 'select') throw new Error('Expected SELECT view body');
			expect(body.compound?.op).to.equal('union');
		});

		it('preserves INTERSECT and EXCEPT', () => {
			for (const op of ['intersect', 'except'] as const) {
				const sql = `create view V as select 1 as N ${op} select 2 as N`;
				const reparsed = parse(createViewToString(parse(sql) as CreateViewStmt)) as CreateViewStmt;
				const body = reparsed.select;
				if (body.type !== 'select') throw new Error('Expected SELECT view body');
				expect(body.compound?.op, `op for ${op}`).to.equal(op);
			}
		});
	});

	describe('Foreign-key deferrability', () => {
		// Each case: source SQL produces a column-level and a table-level FK with
		// the given deferrability shape; both must survive parse → stringify → parse.
		const cases: Array<{
			label: string;
			clause: string;
			deferrable: boolean;
			initiallyDeferred?: boolean;
		}> = [
			{ label: 'DEFERRABLE', clause: 'deferrable', deferrable: true },
			{ label: 'DEFERRABLE INITIALLY DEFERRED', clause: 'deferrable initially deferred', deferrable: true, initiallyDeferred: true },
			{ label: 'DEFERRABLE INITIALLY IMMEDIATE', clause: 'deferrable initially immediate', deferrable: true, initiallyDeferred: false },
			{ label: 'NOT DEFERRABLE', clause: 'not deferrable', deferrable: false },
		];

		for (const tc of cases) {
			it(`preserves column-level ${tc.label}`, () => {
				const sql = `create table Child (Id int references Parent (Id) ${tc.clause}, primary key (Id))`;
				const original = parse(sql) as CreateTableStmt;
				const emitted = createTableToString(original);
				const reparsed = parse(emitted) as CreateTableStmt;
				const colFk = reparsed.columns[0].constraints.find(c => c.type === 'foreignKey');
				if (!colFk || !colFk.foreignKey) throw new Error('Expected column-level FK to survive re-parse');
				expect(colFk.foreignKey.deferrable).to.equal(tc.deferrable);
				expect(colFk.foreignKey.initiallyDeferred).to.equal(tc.initiallyDeferred);
			});

			it(`preserves table-level ${tc.label}`, () => {
				const sql = `create table Child (Id int, primary key (Id), foreign key (Id) references Parent (Id) ${tc.clause})`;
				const original = parse(sql) as CreateTableStmt;
				const emitted = createTableToString(original);
				const reparsed = parse(emitted) as CreateTableStmt;
				const tblFk = reparsed.constraints.find(c => c.type === 'foreignKey');
				if (!tblFk || !tblFk.foreignKey) throw new Error('Expected table-level FK to survive re-parse');
				expect(tblFk.foreignKey.deferrable).to.equal(tc.deferrable);
				expect(tblFk.foreignKey.initiallyDeferred).to.equal(tc.initiallyDeferred);
			});
		}
	});

	describe('Cross-schema FOREIGN KEY parent qualifier', () => {
		// The parent table may be schema-qualified (`references <schema>.<table>`);
		// the optional qualifier must survive parse → stringify → parse on both the
		// column-level and table-level FK forms, and a reserved/contextual-word
		// schema name must re-quote correctly.

		it('preserves a column-level cross-schema parent qualifier', () => {
			const sql = 'create table Child (Id int references Other.Parent (Id), primary key (Id))';
			const original = parse(sql) as CreateTableStmt;
			const emitted = createTableToString(original);
			expect(emitted, `emitted should qualify the parent\n  ${emitted}`).to.match(/references\s+Other\s*\.\s*Parent/i);

			const reparsed = parse(emitted) as CreateTableStmt;
			const colFk = reparsed.columns[0].constraints.find(c => c.type === 'foreignKey');
			if (!colFk || !colFk.foreignKey) throw new Error('Expected column-level FK to survive re-parse');
			expect(colFk.foreignKey.schema?.toLowerCase()).to.equal('other');
			expect(colFk.foreignKey.table.toLowerCase()).to.equal('parent');
		});

		it('preserves a table-level cross-schema parent qualifier', () => {
			const sql = 'create table Child (Id int, primary key (Id), foreign key (Id) references Other.Parent (Id))';
			const original = parse(sql) as CreateTableStmt;
			const emitted = createTableToString(original);
			expect(emitted).to.match(/references\s+Other\s*\.\s*Parent/i);

			const reparsed = parse(emitted) as CreateTableStmt;
			const tblFk = reparsed.constraints.find(c => c.type === 'foreignKey');
			if (!tblFk || !tblFk.foreignKey) throw new Error('Expected table-level FK to survive re-parse');
			expect(tblFk.foreignKey.schema?.toLowerCase()).to.equal('other');
			expect(tblFk.foreignKey.table.toLowerCase()).to.equal('parent');
		});

		it('omits the qualifier when the parent is unqualified', () => {
			const sql = 'create table Child (Id int references Parent (Id), primary key (Id))';
			const emitted = createTableToString(parse(sql) as CreateTableStmt);
			expect(emitted, `no qualifier expected\n  ${emitted}`).to.not.match(/references\s+\w+\s*\.\s*\w+/i);
			const reparsed = parse(emitted) as CreateTableStmt;
			const colFk = reparsed.columns[0].constraints.find(c => c.type === 'foreignKey');
			expect(colFk?.foreignKey?.schema).to.equal(undefined);
		});

		it('quotes and round-trips a reserved-word schema name', () => {
			// `"order"` is a reserved word as a bare identifier; the qualifier must be
			// quoted on emit and re-parse back to the same schema.
			const sql = 'create table Child (Id int references "order".Parent (Id), primary key (Id))';
			const original = parse(sql) as CreateTableStmt;
			const emitted = createTableToString(original);
			expect(emitted, `reserved-word schema must re-quote\n  ${emitted}`).to.include('"order".');

			const reparsed = parse(emitted) as CreateTableStmt;
			const colFk = reparsed.columns[0].constraints.find(c => c.type === 'foreignKey');
			expect(colFk?.foreignKey?.schema?.toLowerCase()).to.equal('order');
		});
	});

	describe('TEMP/TEMPORARY is rejected (not a Quereus concept)', () => {
		it('rejects `create temp table` / `create temporary table`', () => {
			expect(() => parse('create temp table T (Id int, primary key (Id))')).to.throw(/TEMP\/TEMPORARY is not supported/);
			expect(() => parse('create temporary table T (Id int, primary key (Id))')).to.throw(/TEMP\/TEMPORARY is not supported/);
		});

		it('rejects `create temp view` / `create temporary materialized view`', () => {
			expect(() => parse('create temp view V as select 1 as N')).to.throw(/TEMP\/TEMPORARY is not supported/);
			expect(() => parse('create temporary materialized view MV as select 1 as N')).to.throw(/TEMP\/TEMPORARY is not supported/);
		});

		it('round-trips a plain `create table` / `create view`', () => {
			const t = parse('create table T (Id int, primary key (Id))') as CreateTableStmt;
			expect((parse(createTableToString(t)) as CreateTableStmt).type).to.equal('createTable');
			const v = parse('create view V as select 1 as N') as CreateViewStmt;
			expect((parse(createViewToString(v)) as CreateViewStmt).type).to.equal('createView');
		});
	});

	describe('DECLARE SCHEMA items', () => {
		// The previous stringifier emitted placeholders like `table X { ... }` for every
		// declared-item kind. These cases prove each kind survives stringify→parse with
		// its real body intact.
		const declared = (sql: string): DeclareSchemaStmt => parse(sql) as DeclareSchemaStmt;

		it('preserves a declared table body (columns + PK constraint)', () => {
			const sql = "declare schema main { table T (id integer, name text, primary key (id)) }";
			const original = declared(sql);
			const reparsed = parse(astToString(original)) as DeclareSchemaStmt;
			expect(reparsed.items).to.have.lengthOf(1);
			const t = reparsed.items[0] as DeclaredTable;
			expect(t.type).to.equal('declaredTable');
			expect(t.tableStmt.columns.map(c => c.name)).to.deep.equal(['id', 'name']);
			expect(t.tableStmt.constraints).to.have.lengthOf(1);
			expect(t.tableStmt.constraints[0].type).to.equal('primaryKey');
		});

		it('preserves a declared unique index over multiple columns', () => {
			const sql = 'declare schema main { table T (a integer, b integer, primary key (a)); unique index Ix on T (a, b desc) }';
			const original = declared(sql);
			const reparsed = parse(astToString(original)) as DeclareSchemaStmt;
			const idx = reparsed.items.find(i => i.type === 'declaredIndex') as DeclaredIndex;
			expect(idx).to.exist;
			expect(idx.indexStmt.isUnique).to.equal(true);
			expect(idx.indexStmt.index.name.toLowerCase()).to.equal('ix');
			expect(idx.indexStmt.table.name.toLowerCase()).to.equal('t');
			expect(idx.indexStmt.columns).to.have.lengthOf(2);
			expect(idx.indexStmt.columns[1].direction).to.equal('desc');
		});

		it('preserves a declared view body (SELECT survives)', () => {
			const sql = "declare schema main { table T (id integer, primary key (id)); view V as select id from T where id > 0 }";
			const original = declared(sql);
			const reparsed = parse(astToString(original)) as DeclareSchemaStmt;
			const view = reparsed.items.find(i => i.type === 'declaredView') as DeclaredView;
			expect(view).to.exist;
			expect(view.viewStmt.view.name.toLowerCase()).to.equal('v');
			const viewBody = view.viewStmt.select;
			if (viewBody.type !== 'select') throw new Error('Expected SELECT view body');
			expect(viewBody.where).to.exist;
		});

		it('preserves declared seed rows with literal values', () => {
			const sql = "declare schema main { table T (id integer, name text, primary key (id)); seed T ((1, 'Alice'), (2, 'Bob')) }";
			const original = declared(sql);
			const reparsed = parse(astToString(original)) as DeclareSchemaStmt;
			const seed = reparsed.items.find(i => i.type === 'declaredSeed') as DeclaredSeed;
			expect(seed).to.exist;
			expect(seed.seedData).to.deep.equal([
				[1, 'Alice'],
				[2, 'Bob'],
			]);
		});

		it('preserves a declared assertion CHECK expression', () => {
			const sql = "declare schema main { table T (id integer, primary key (id)); assertion A check ((select count(*) from T) >= 0) }";
			const original = declared(sql);
			const reparsed = parse(astToString(original)) as DeclareSchemaStmt;
			const a = reparsed.items.find(i => i.type === 'declaredAssertion') as DeclaredAssertion;
			expect(a).to.exist;
			expect(a.assertionStmt.name.name.toLowerCase()).to.equal('a');
			expect(a.assertionStmt.check.type).to.equal('binary');
		});

		it('preserves WITH TAGS on declared table and index', () => {
			const sql = "declare schema main { table T (id integer, primary key (id)) with tags (env = 'prod'); index Ix on T (id) with tags (hot = true) }";
			const original = declared(sql);
			const reparsed = parse(astToString(original)) as DeclareSchemaStmt;
			const t = reparsed.items[0] as DeclaredTable;
			const i = reparsed.items[1] as DeclaredIndex;
			expect(t.tableStmt.tags).to.deep.equal({ env: 'prod' });
			expect(i.indexStmt.tags).to.deep.equal({ hot: true });
		});

		it('seed strings with single quotes are escaped and round-trip', () => {
			const sql = "declare schema main { table T (id integer, name text, primary key (id)); seed T ((1, 'O''Brien')) }";
			const reparsed = parse(astToString(declared(sql))) as DeclareSchemaStmt;
			const seed = reparsed.items.find(i => i.type === 'declaredSeed') as DeclaredSeed;
			expect(seed.seedData?.[0]).to.deep.equal([1, "O'Brien"]);
		});

		it('preserves declared seed with explicit column list', () => {
			const sql = "declare schema main { table T (id integer, name text, primary key (id)); seed T values (id, name) values ((1, 'Alice'), (2, 'Bob')) }";
			const original = declared(sql);
			const reparsed = parse(astToString(original)) as DeclareSchemaStmt;
			const seed = reparsed.items.find(i => i.type === 'declaredSeed') as DeclaredSeed;
			expect(seed).to.exist;
			expect(seed.columns).to.deep.equal(['id', 'name']);
			expect(seed.seedData).to.deep.equal([
				[1, 'Alice'],
				[2, 'Bob'],
			]);
		});
	});

	describe('INSERT OR <res> lead-in', () => {
		// The parser populates `onConflict` only via the `INSERT OR <res>` lead-in.
		// The retired trailing `on conflict <res>` form must not appear in emitted SQL.
		const cases: Array<{ keyword: string; res: ConflictResolution }> = [
			{ keyword: 'rollback', res: ConflictResolution.ROLLBACK },
			{ keyword: 'fail', res: ConflictResolution.FAIL },
			{ keyword: 'ignore', res: ConflictResolution.IGNORE },
			{ keyword: 'replace', res: ConflictResolution.REPLACE },
		];

		for (const tc of cases) {
			it(`preserves INSERT OR ${tc.keyword.toUpperCase()} through round-trip`, () => {
				const sql = `insert or ${tc.keyword} into T (a, b) values (1, 2)`;
				const original = parse(sql) as InsertStmt;
				expect(original.onConflict).to.equal(tc.res);

				const emitted = astToString(original);
				expect(emitted).to.match(new RegExp(`^insert\\s+or\\s+${tc.keyword}\\s+into\\b`, 'i'));

				const reparsed = parse(emitted) as InsertStmt;
				expect(reparsed.onConflict).to.equal(tc.res);
			});
		}

		it('drops the OR clause for the default ABORT resolution', () => {
			const stmt: InsertStmt = {
				type: 'insert',
				table: { type: 'identifier', name: 'T' },
				columns: ['a', 'b'],
				source: {
					type: 'values',
					values: [[
						{ type: 'literal', value: 1 },
						{ type: 'literal', value: 2 },
					]],
				},
				onConflict: ConflictResolution.ABORT,
			};

			const emitted = astToString(stmt);
			expect(emitted).to.match(/^insert\s+into\b/i);
			expect(emitted).to.not.match(/\binsert\s+or\b/i);
			expect(emitted).to.not.match(/\bon\s+conflict\b/i);
		});
	});

	describe('Inline subquery DML write target', () => {
		// `update (select …) as v set …` / `delete from (select …) as v where …` carry the
		// subquery body on `targetSource`, the alias on `alias`, and a synthetic placeholder
		// `table` (= the alias). The stringifier renders `(body) as alias[(cols)]` in place of
		// a named target and must NOT double-emit the standalone `as alias`.

		it('round-trips a subquery UPDATE target', () => {
			const sql = "update (select id, color from base) as v set color = 'x' where v.id = 1";
			const original = parse(sql) as UpdateStmt;
			expect(original.targetSource, 'targetSource should be set').to.exist;
			expect(original.targetSource!.alias).to.equal('v');
			expect(original.targetSource!.subquery.type).to.equal('select');
			expect(original.alias).to.equal('v');
			expect(original.table.name).to.equal('v'); // synthetic placeholder = alias

			const emitted = astToString(original);
			// The alias appears exactly once (folded into the targetSource render).
			expect((emitted.match(/\bas\s+(?:"v"|v)\b/gi) ?? []).length, `alias emitted once in: ${emitted}`).to.equal(1);
			expect(emitted).to.match(/^update\s+\(\s*select\b/i);

			const reparsed = parse(emitted) as UpdateStmt;
			expect(reparsed.targetSource, 'targetSource survives round-trip').to.exist;
			expect(reparsed.targetSource!.alias).to.equal('v');
			expect(reparsed.targetSource!.columns).to.be.undefined;
			expect(reparsed.alias).to.equal('v');
			expect(astToString(reparsed)).to.equal(emitted); // string-stable
		});

		it('round-trips a subquery DELETE target', () => {
			const sql = 'delete from (select id, color from base) as v where v.id = 2';
			const original = parse(sql) as DeleteStmt;
			expect(original.targetSource, 'targetSource should be set').to.exist;
			expect(original.targetSource!.alias).to.equal('v');
			expect(original.alias).to.equal('v');

			const emitted = astToString(original);
			expect((emitted.match(/\bas\s+(?:"v"|v)\b/gi) ?? []).length, `alias emitted once in: ${emitted}`).to.equal(1);
			expect(emitted).to.match(/^delete\s+from\s+\(\s*select\b/i);

			const reparsed = parse(emitted) as DeleteStmt;
			expect(reparsed.targetSource, 'targetSource survives round-trip').to.exist;
			expect(reparsed.targetSource!.alias).to.equal('v');
			expect(astToString(reparsed)).to.equal(emitted);
		});

		it('round-trips a subquery UPDATE target with an `as v(cols)` rename list', () => {
			const sql = "update (select id, color from base) as v (k, c) set c = 'z' where k = 1";
			const original = parse(sql) as UpdateStmt;
			expect(original.targetSource!.columns).to.deep.equal(['k', 'c']);

			const emitted = astToString(original);
			expect(emitted).to.match(/\(\s*"?k"?\s*,\s*"?c"?\s*\)/i); // rename list survives

			const reparsed = parse(emitted) as UpdateStmt;
			expect(reparsed.targetSource!.columns).to.deep.equal(['k', 'c']);
			expect(astToString(reparsed)).to.equal(emitted);
		});
	});

	describe('expressionToIdentityString', () => {
		// The aggregate-identity fingerprint the planner compares HAVING / ORDER BY /
		// window-spec aggregates against the SELECT list's. It must fold identifier case
		// (column resolution is case-insensitive) while leaving every literal byte-exact
		// (a quoted value's case is part of what the aggregate computes).

		const exprOf = (sqlExpr: string): Expression => {
			const stmt = parse(`select ${sqlExpr} from t`) as SelectStmt;
			const col = stmt.columns[0];
			if (col.type !== 'column') throw new Error(`expected an expression result column for: ${sqlExpr}`);
			return col.expr;
		};
		const identity = (sqlExpr: string): string => expressionToIdentityString(exprOf(sqlExpr));

		it('folds identifier case', () => {
			expect(identity('sum(B)')).to.equal(identity('sum(b)'));
		});

		it('folds qualifier case', () => {
			expect(identity('sum(W.b)')).to.equal(identity('sum(w.B)'));
		});

		it('preserves string-literal case', () => {
			expect(identity("count(nullif(b,'A'))")).to.not.equal(identity("count(nullif(b,'a'))"));
		});

		it('preserves string-literal case inside nested shapes', () => {
			// `case` / `between` / `in` recurse through their own fold arms — a literal
			// buried in any of them must survive the recursion unfolded.
			expect(identity("sum(case when b = 'A' then 1 else 0 end)"))
				.to.not.equal(identity("sum(case when b = 'a' then 1 else 0 end)"));
			expect(identity("count(nullif(b, cast('A' as text)))"))
				.to.not.equal(identity("count(nullif(b, cast('a' as text)))"));
		});

		it('ignores whitespace and redundant parens', () => {
			expect(identity('sum(  (b)  )')).to.equal(identity('sum(b)'));
		});

		it('distinguishes DISTINCT participation', () => {
			expect(identity('count(distinct b)')).to.not.equal(identity('count(b)'));
		});

		it('does not mutate the input AST', () => {
			const expr = exprOf("count(nullif(B,'A'))");
			const before = expressionToString(expr);
			expressionToIdentityString(expr);
			expect(expressionToString(expr), 'original casing survives fingerprinting').to.equal(before);
			expect(before).to.include("'A'");
			expect(before).to.match(/\bB\b/);
		});
	});
});

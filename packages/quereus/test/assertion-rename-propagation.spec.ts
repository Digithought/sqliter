/**
 * `ALTER TABLE … RENAME` propagation into dependent ASSERTION bodies — the
 * catalog-level invariants the sqllogic coverage (test/logic/95-assertions.sqllogic)
 * cannot see:
 *
 *   1. The stored body follows the rename: the CHECK-expression AST is rewritten in
 *      place and the derived `violationSql` — the text the commit-time evaluator
 *      re-parses and re-plans — is regenerated from it.
 *   2. `assertion_modified` fires for a rewritten assertion (that event is what
 *      invalidates the optimizer's assertion-hoist cache) and does NOT fire for an
 *      assertion the rename never touched.
 *   3. Matching is by resolved key, not bare name, so a non-`main` assertion tracks a
 *      rename in its own schema and is left alone by an identically-named table
 *      renamed in another schema.
 *
 * The walk itself covers every schema (an assertion in `temp` naming `main.t`
 * explicitly does follow the rename) — pinned in
 * `test/schema/rename-cross-schema.spec.ts` alongside the view and materialized-view
 * cases it shares that scope with.
 */

import { expect } from 'chai';
import { Database } from '../src/core/database.js';
import type { SchemaChangeEvent } from '../src/schema/change-events.js';
import type { IntegrityAssertionSchema } from '../src/schema/assertion.js';
import { expressionToString } from '../src/emit/ast-stringify.js';
import { computeSchemaDiff } from '../src/schema/schema-differ.js';
import { collectSchemaCatalog } from '../src/schema/catalog.js';

/** Collect every schema-change event a database fires while `fn` runs. */
async function captureEvents(db: Database, fn: () => Promise<void>): Promise<SchemaChangeEvent[]> {
	const events: SchemaChangeEvent[] = [];
	const off = db.schemaManager.getChangeNotifier().addListener(e => events.push(e));
	try {
		await fn();
	} finally {
		off();
	}
	return events;
}

function getAssertion(db: Database, schemaName: string, name: string): IntegrityAssertionSchema {
	const found = db.schemaManager.getSchema(schemaName)?.getAssertion(name);
	expect(found, `assertion '${schemaName}.${name}' exists`).to.not.equal(undefined);
	return found!;
}

/** Names of the assertions an `assertion_modified` event was raised for. */
function modifiedAssertions(events: SchemaChangeEvent[]): string[] {
	return events
		.filter(e => e.type === 'assertion_modified')
		.map(e => `${e.schemaName}.${e.objectName}`);
}

async function expectThrows(fn: () => Promise<unknown>, substr: string): Promise<void> {
	let err: unknown;
	try { await fn(); } catch (e) { err = e; }
	expect(err, `expected an error containing "${substr}"`).to.not.equal(undefined);
	expect(String((err as Error).message)).to.contain(substr);
}

describe('assertion rename propagation: stored body, derived SQL, and events', () => {
	it('TABLE rename rewrites the CHECK expression and regenerates violationSql', async () => {
		const db = new Database();
		try {
			await db.exec('create table t (x integer primary key)');
			await db.exec('create assertion a1 check (not exists (select 1 from t where x < 0))');

			const events = await captureEvents(db, () => db.exec('alter table t rename to t2'));

			const a = getAssertion(db, 'main', 'a1');
			expect(a.violationSql, 'stored violation SQL names the new table')
				.to.equal('select 1 where not (not exists (select 1 from t2 where x < 0))');
			expect(expressionToString(a.checkExpression!), 'CHECK AST rewritten in place')
				.to.contain('from t2');
			expect(modifiedAssertions(events)).to.deep.equal(['main.a1']);

			// The rule still enforces against the renamed table.
			await db.exec('insert into t2 values (7)');
			await expectThrows(
				() => db.exec('insert into t2 values (-1)'),
				'Integrity assertion failed: a1');
			expect(await rowCount(db, 't2')).to.equal(1);
		} finally {
			await db.close();
		}
	});

	it('TABLE rename re-keys the informational dependentTables entries', async () => {
		const db = new Database();
		try {
			await db.exec('create table t (x integer primary key)');
			await db.exec('create assertion a1 check (not exists (select 1 from t where x < 0))');
			const before = getAssertion(db, 'main', 'a1').dependentTables ?? [];

			await db.exec('alter table t rename to t2');

			const after = getAssertion(db, 'main', 'a1').dependentTables ?? [];
			expect(after.length, 'entry count unchanged').to.equal(before.length);
			expect(after.map(d => d.base), 'no entry still names the old base')
				.to.not.include('main.t');
			for (const dep of after) {
				expect(dep.relationKey.startsWith(`${dep.base}#`), 'relationKey keeps its <base>#<nodeId> shape')
					.to.equal(true);
			}
			// Discovery through a subquery is itself incomplete today
			// (`bug-assertion-info-dependent-tables-always-empty`), so this asserts the
			// mapping is consistent rather than that any particular entry exists.
		} finally {
			await db.close();
		}
	});

	it('COLUMN rename rewrites the CHECK expression and regenerates violationSql', async () => {
		const db = new Database();
		try {
			await db.exec('create table u (id integer primary key, x integer)');
			await db.exec('create assertion a2 check (not exists (select 1 from u where x < 0))');

			const events = await captureEvents(db, () => db.exec('alter table u rename column x to y'));

			const a = getAssertion(db, 'main', 'a2');
			expect(a.violationSql, 'stored violation SQL names the new column')
				.to.equal('select 1 where not (not exists (select 1 from u where y < 0))');
			expect(modifiedAssertions(events)).to.deep.equal(['main.a2']);

			await db.exec('insert into u values (1, 3)');
			await expectThrows(
				() => db.exec('insert into u values (2, -3)'),
				'Integrity assertion failed: a2');
			expect(await rowCount(db, 'u')).to.equal(1);
		} finally {
			await db.close();
		}
	});

	it('leaves an assertion the rename does not touch alone (no event, no rewrite)', async () => {
		const db = new Database();
		try {
			await db.exec('create table t (x integer primary key)');
			await db.exec('create table other (y integer primary key)');
			await db.exec('create assertion a1 check (not exists (select 1 from t where x < 0))');
			await db.exec('create assertion a_other check (not exists (select 1 from other where y < 0))');
			const untouchedBefore = getAssertion(db, 'main', 'a_other').violationSql;

			const events = await captureEvents(db, () => db.exec('alter table t rename to t2'));

			expect(modifiedAssertions(events), 'only the affected assertion is re-registered')
				.to.deep.equal(['main.a1']);
			expect(getAssertion(db, 'main', 'a_other').violationSql).to.equal(untouchedBefore);
		} finally {
			await db.close();
		}
	});

	it('propagates a rename inside a non-main schema', async () => {
		const db = new Database();
		try {
			await db.exec('create table temp.qt (id integer primary key, x integer not null)');
			await db.exec('create assertion temp.qa check (not exists (select 1 from temp.qt where x < 0))');

			const events = await captureEvents(db, () => db.exec('alter table temp.qt rename to qt2'));

			const a = getAssertion(db, 'temp', 'qa');
			expect(a.violationSql, 'the temp assertion follows its own schema\'s rename')
				.to.contain('qt2');
			expect(a.violationSql).to.not.contain('qt where');
			expect(modifiedAssertions(events)).to.deep.equal(['temp.qa']);

			await db.exec('insert into temp.qt2 values (1, 10)');
			await expectThrows(
				() => db.exec('insert into temp.qt2 values (2, -5)'),
				'Integrity assertion failed: temp.qa');
		} finally {
			await db.close();
		}
	});

	it('does not rewrite a temp assertion when a like-named main table is renamed', async () => {
		const db = new Database();
		try {
			await db.exec('create table main.qt (id integer primary key, x integer not null)');
			await db.exec('create table temp.qt (id integer primary key, x integer not null)');
			await db.exec('create assertion temp.qa check (not exists (select 1 from temp.qt where x < 0))');
			const before = getAssertion(db, 'temp', 'qa').violationSql;

			const events = await captureEvents(db, () => db.exec('alter table main.qt rename to qt_main'));

			expect(getAssertion(db, 'temp', 'qa').violationSql, 'the temp assertion is untouched')
				.to.equal(before);
			expect(modifiedAssertions(events)).to.deep.equal([]);
			// And it still enforces against its own (unrenamed) table.
			await expectThrows(
				() => db.exec('insert into temp.qt values (1, -5)'),
				'Integrity assertion failed: temp.qa');
		} finally {
			await db.close();
		}
	});
});

/**
 * Body shapes the rename walkers are shared with the view-body path for — a join,
 * an alias, a CTE, a correlated subquery. The shared code makes them likely to work;
 * these pin that they do, since an assertion body (unlike a view body) is walked
 * unseeded and a false capture there silently breaks every later write.
 */
describe('assertion rename propagation: body shapes', () => {
	it('rewrites only the renamed side of a two-table join', async () => {
		const db = new Database();
		try {
			await db.exec('create table ja (id integer primary key, k integer)');
			await db.exec('create table jb (id integer primary key, k integer)');
			await db.exec('create assertion j1 check (not exists (select 1 from ja join jb on ja.k = jb.k where ja.k < 0))');

			await db.exec('alter table ja rename to ja2');

			const sql = getAssertion(db, 'main', 'j1').violationSql;
			expect(sql, 'renamed side follows, in FROM and in both qualified refs')
				.to.contain('from ja2 inner join jb on ja2.k = jb.k where ja2.k < 0');
			expect(sql, 'the untouched side keeps its name').to.contain('jb');
		} finally {
			await db.close();
		}
	});

	it('follows an alias for both rename kinds', async () => {
		const db = new Database();
		try {
			await db.exec('create table al (id integer primary key, x integer)');
			await db.exec('create assertion a_al check (not exists (select 1 from al as aa where aa.x < 0))');

			await db.exec('alter table al rename column x to y');
			expect(getAssertion(db, 'main', 'a_al').violationSql, 'the alias-qualified column follows')
				.to.contain('from al as aa where aa.y < 0');

			await db.exec('alter table al rename to al2');
			expect(getAssertion(db, 'main', 'a_al').violationSql, 'the aliased source follows; the alias itself does not')
				.to.contain('from al2 as aa where aa.y < 0');
		} finally {
			await db.close();
		}
	});

	it('descends a CTE in the body for both rename kinds', async () => {
		const db = new Database();
		try {
			await db.exec('create table ce (id integer primary key, x integer)');
			await db.exec('create assertion a_ce check (not exists (with q as (select x from ce) select 1 from q where x < 0))');

			await db.exec('alter table ce rename to ce2');
			expect(getAssertion(db, 'main', 'a_ce').violationSql, 'the CTE body follows the table rename')
				.to.contain('with q as (select x from ce2)');

			await db.exec('alter table ce2 rename column x to y');
			// The CTE re-exposes `x` with no explicit column list, so the outer
			// reference follows too — the same rule the view-body path documents.
			expect(getAssertion(db, 'main', 'a_ce').violationSql, 'both the CTE projection and the outer ref follow')
				.to.contain('with q as (select y from ce2) select 1 from q where y < 0');
		} finally {
			await db.close();
		}
	});

	it('rewrites through a correlated subquery without disturbing the inner source', async () => {
		const db = new Database();
		try {
			await db.exec('create table par (id integer primary key, x integer)');
			await db.exec('create table chi (id integer primary key, pid integer)');
			await db.exec(`create assertion a_co check (not exists (
				select 1 from par where x < 0 and exists (select 1 from chi where chi.pid = par.id)))`);

			await db.exec('alter table par rename column x to z');
			expect(getAssertion(db, 'main', 'a_co').violationSql, 'the outer column follows')
				.to.contain('where z < 0');

			await db.exec('alter table par rename to par2');
			const sql = getAssertion(db, 'main', 'a_co').violationSql;
			expect(sql, 'the correlated qualifier follows').to.contain('chi.pid = par2.id');
			expect(sql, 'the inner (unrenamed) source is untouched').to.contain('from chi where');
		} finally {
			await db.close();
		}
	});

	it('enforces against the new name when the rename and the writes share one transaction', async () => {
		const db = new Database();
		try {
			await db.exec('create table tx (x integer primary key)');
			await db.exec('create assertion a_tx check (not exists (select 1 from tx where x < 0))');
			await db.exec('insert into tx values (1)');

			// The first commit compiled and cached the assertion plan against the OLD
			// body; the rename must invalidate it before this transaction's own COMMIT
			// evaluates the assertion.
			await db.exec('begin');
			await db.exec('alter table tx rename to tx2');
			await db.exec('insert into tx2 values (5)');
			await db.exec('commit');
			expect(await rowCount(db, 'tx2')).to.equal(2);

			await db.exec('begin');
			await db.exec('insert into tx2 values (-9)');
			await expectThrows(() => db.exec('commit'), 'Integrity assertion failed: a_tx');
		} finally {
			await db.close();
		}
	});
});

/**
 * The declarative half: `apply schema` renames a table via a `quereus.previous_name`
 * hint while the declared assertion body already names the new table. The rename
 * propagation is what makes the follow-up diff converge — it rewrites the live body
 * to the new name, so both sides render identically. See the NOTE on the assertion
 * loop in `schema/schema-differ.ts`.
 */
describe('assertion rename propagation: declarative round trip', () => {
	it('converges after a table rename hint and keeps enforcing', async () => {
		const db = new Database();
		try {
			await db.exec(`declare schema main {
				table orders { id INTEGER PRIMARY KEY, qty INTEGER }
				assertion qty_nonneg check (not exists (select 1 from orders where qty < 0))
			}`);
			await db.exec('apply schema main');

			await db.exec(`declare schema main {
				table sales { id INTEGER PRIMARY KEY, qty INTEGER } with tags ("quereus.previous_name" = 'orders')
				assertion qty_nonneg check (not exists (select 1 from sales where qty < 0))
			}`);
			await db.exec('apply schema main');

			expect(getAssertion(db, 'main', 'qty_nonneg').violationSql, 'live body follows the applied rename')
				.to.equal('select 1 where not (not exists (select 1 from sales where qty < 0))');

			const diff = computeSchemaDiff(
				db.declaredSchemaManager.getDeclaredSchema('main')!,
				collectSchemaCatalog(db, 'main'),
			);
			expect(diff.renames, 'no further rename').to.deep.equal([]);
			expect(diff.assertionsToCreate, 'no assertion churn on the re-diff').to.deep.equal([]);
			expect(diff.assertionsToDrop, 'no assertion churn on the re-diff').to.deep.equal([]);

			await db.exec('insert into sales values (1, 4)');
			await expectThrows(
				() => db.exec('insert into sales values (2, -4)'),
				'Integrity assertion failed: qty_nonneg');
		} finally {
			await db.close();
		}
	});

	it('converges after a column rename hint and keeps enforcing', async () => {
		const db = new Database();
		try {
			await db.exec(`declare schema main {
				table inv { id INTEGER PRIMARY KEY, qty INTEGER }
				assertion inv_nonneg check (not exists (select 1 from inv where qty < 0))
			}`);
			await db.exec('apply schema main');

			await db.exec(`declare schema main {
				table inv { id INTEGER PRIMARY KEY, amount INTEGER with tags ("quereus.previous_name" = 'qty') }
				assertion inv_nonneg check (not exists (select 1 from inv where amount < 0))
			}`);
			await db.exec('apply schema main');

			expect(getAssertion(db, 'main', 'inv_nonneg').violationSql, 'live body follows the applied column rename')
				.to.equal('select 1 where not (not exists (select 1 from inv where amount < 0))');

			const diff = computeSchemaDiff(
				db.declaredSchemaManager.getDeclaredSchema('main')!,
				collectSchemaCatalog(db, 'main'),
			);
			expect(diff.assertionsToCreate, 'no assertion churn on the re-diff').to.deep.equal([]);
			expect(diff.assertionsToDrop, 'no assertion churn on the re-diff').to.deep.equal([]);
			expect(diff.tablesToAlter, 'no table churn on the re-diff').to.deep.equal([]);

			await expectThrows(
				() => db.exec('insert into inv values (2, -4)'),
				'Integrity assertion failed: inv_nonneg');
		} finally {
			await db.close();
		}
	});
});

async function rowCount(db: Database, table: string): Promise<number> {
	for await (const r of db.eval(`select count(*) as n from ${table}`)) {
		return Number((r as { n: unknown }).n);
	}
	return -1;
}

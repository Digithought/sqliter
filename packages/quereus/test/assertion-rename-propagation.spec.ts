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
 *   3. The walk is scoped to the renamed object's own schema, so a non-`main`
 *      assertion tracks a rename in its own schema and is left alone by an
 *      identically-named table renamed in another schema.
 *
 * Cross-schema propagation (an assertion in `main` naming `temp.u` explicitly) is a
 * known gap shared with views and materialized views — see
 * `bug-rename-not-propagated-across-schemas`. It is deliberately not asserted here:
 * it is a defect, not a contract.
 */

import { expect } from 'chai';
import { Database } from '../src/core/database.js';
import type { SchemaChangeEvent } from '../src/schema/change-events.js';
import type { IntegrityAssertionSchema } from '../src/schema/assertion.js';
import { expressionToString } from '../src/emit/ast-stringify.js';

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

	it('propagates a rename inside a non-main schema (home-schema scoping)', async () => {
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

async function rowCount(db: Database, table: string): Promise<number> {
	for await (const r of db.eval(`select count(*) as n from ${table}`)) {
		return Number((r as { n: unknown }).n);
	}
	return -1;
}

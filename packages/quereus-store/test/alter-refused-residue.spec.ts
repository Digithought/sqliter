/**
 * A refused SCHEMA-ONLY `ALTER TABLE` on a store-backed table must be a clean no-op
 * (alter-table-failure-leaves-half-applied-schema).
 *
 * The four arms that touch no row data before the catalog write — ADD / DROP / RENAME
 * CONSTRAINT and RENAME COLUMN — persist through `StoreModuleIndex.adoptAndPersistSchema`,
 * which puts the connected table's cached schema back when the catalog write throws. Without
 * it the table stayed one schema ahead of both the engine and the catalog for the rest of the
 * session, and a plain UNIQUE is materially harmed by that: `StoreTableBase.updateSchema`
 * materializes the hidden `_uc_*` index that backs it, so DML starts enforcing by seek against
 * a physical store the (never-run) reconcile never built — an empty structure reports no
 * conflict, so duplicates were waved through.
 *
 * Each case asserts BOTH halves:
 *  - residue equality across the refused statement (`expectRefusedDdlLeavesNoResidue`);
 *  - behavior afterwards. Residue equality alone would catch neither UNIQUE harm — the
 *    half-applied schema lives in memory, and the ghost `_uc_*` store it leaves is created by
 *    the NEXT write, after the snapshot window closes.
 *
 * The row-rewriting arms (ADD / DROP COLUMN, ALTER PRIMARY KEY, ALTER COLUMN) deliberately do
 * NOT unwind — they have already re-encoded the data store — and are out of scope here; see
 * the accepted-tradeoff `NOTE:` in `StoreModuleAlter.alterDropColumn`.
 *
 * The failure is injected the general way: the provider's catalog `put` throws for exactly the
 * one statement under test, standing in for any durable-write IO error.
 */

import { describe, it, afterEach } from 'mocha';
import { expect } from 'chai';
import type { Database } from '@quereus/quereus';
import {
	createProvider,
	expectRefusedDdlLeavesNoResidue,
	open,
	rows,
	type TestProvider,
} from './refused-ddl-residue.js';

/** Assert `sql` is refused, and that the refusal reads as a constraint violation. */
async function expectConstraintRejected(db: Database, sql: string, why: string): Promise<void> {
	let caught: unknown;
	try {
		await db.exec(sql);
	} catch (e) {
		caught = e;
	}
	expect(caught, why).to.not.equal(undefined);
	expect(String(caught), why).to.match(/unique|constraint|check/i);
}

/** Row count of the one table every case uses. */
async function rowCount(db: Database): Promise<unknown> {
	return (await rows(db, `select count(*) as n from t`))[0].n;
}

/**
 * One arm's case: the statements that build the starting state, the ALTER made to fail, and
 * the behavior that must hold afterwards. Driving all four from one table means a fifth
 * schema-only arm gets residue coverage by adding a row here.
 */
interface RefusedAlterCase {
	title: string;
	setup: readonly string[];
	sql: string;
	after: (db: Database, p: TestProvider) => Promise<void>;
}

const CASES: readonly RefusedAlterCase[] = [
	{
		title: 'ADD CONSTRAINT UNIQUE — the constraint was never added, and a retry can still add it',
		setup: [
			`create table t (id integer primary key, email text) using store`,
			`insert into t values (1, 'a@x.com'), (2, 'b@x.com')`,
		],
		sql: `alter table t add constraint uq unique (email)`,
		after: async (db, p) => {
			// The constraint genuinely does not exist, so a duplicate is legitimately accepted.
			// The harm was accepting it while the SESSION believed the constraint was live: the
			// row then made the constraint permanently unaddable, and the write materialized a
			// `_uc_*` store (named after the constraint) the engine has no record of.
			await db.exec(`insert into t values (3, 'a@x.com')`);
			expect(await rowCount(db), 'duplicate accepted — no constraint is in force').to.equal(3);
			expect(p.stores.has('main.t_idx_uq'), 'no ghost implicit unique store built by that write')
				.to.equal(false);

			// With the duplicate gone the same statement must now succeed — under the
			// half-applied schema the retry was refused by the data the ghost let in.
			await db.exec(`delete from t where id = 3`);
			await db.exec(`alter table t add constraint uq unique (email)`);

			// And the retried constraint must be PHYSICALLY enforced, i.e. its `_uc_*` store was
			// actually built. A stale or absent store answers a seek with "no conflict".
			await expectConstraintRejected(
				db,
				`insert into t values (4, 'a@x.com')`,
				'the retried UNIQUE rejects a duplicate of a pre-existing row',
			);
			await db.exec(`insert into t values (5, 'c@x.com')`);
			expect(await rowCount(db), 'a distinct row still lands under the retried constraint').to.equal(3);
		},
	},
	{
		title: 'DROP CONSTRAINT — the UNIQUE is still there and still enforced',
		setup: [
			`create table t (id integer primary key, email text, constraint uq unique (email)) using store`,
			`insert into t values (1, 'a@x.com')`,
		],
		sql: `alter table t drop constraint uq`,
		after: async (db) => {
			// The mirror harm: the refused drop's schema swap de-materialized the `_uc_*` that was
			// doing the enforcing, so the duplicate landed — and survived a reopen as an
			// unenforceable violation of a constraint the catalog still lists.
			await expectConstraintRejected(
				db,
				`insert into t values (2, 'a@x.com')`,
				'the still-live UNIQUE rejects the duplicate after the refused drop',
			);
			await db.exec(`insert into t values (3, 'b@x.com')`);
			expect(await rowCount(db), 'a distinct row still lands').to.equal(2);

			// And the drop still works once the catalog write does.
			await db.exec(`alter table t drop constraint uq`);
			await db.exec(`insert into t values (4, 'a@x.com')`);
			expect(await rowCount(db), 'the duplicate lands once the constraint is really dropped').to.equal(3);
		},
	},
	{
		title: 'RENAME CONSTRAINT — the OLD name still addresses the constraint',
		setup: [
			`create table t (id integer primary key, email text, constraint uq unique (email)) using store`,
			`insert into t values (1, 'a@x.com')`,
		],
		sql: `alter table t rename constraint uq to uq2`,
		after: async (db) => {
			// Still enforced, and still enforced under a name the module can resolve: a
			// half-applied rename left the module's cached schema holding `uq2` while the engine
			// held `uq`, so any statement naming either one hit a schema that did not have it.
			await expectConstraintRejected(
				db,
				`insert into t values (2, 'a@x.com')`,
				'the constraint is still enforced after the refused rename',
			);
			await db.exec(`alter table t drop constraint uq`);
			await db.exec(`insert into t values (3, 'a@x.com')`);
			expect(await rowCount(db), 'the old name resolved, so the constraint really was dropped').to.equal(2);
		},
	},
	{
		title: 'RENAME COLUMN — the column keeps its old name, CHECK included, and a retry succeeds',
		setup: [
			`create table t (id integer primary key, email text, constraint ck check (email <> 'bad')) using store`,
			`insert into t values (1, 'a@x.com')`,
		],
		sql: `alter table t rename column email to mail`,
		after: async (db) => {
			// The arm rewrites the CHECK / predicate / DEFAULT ASTs IN PLACE before persisting,
			// and those `Expression` nodes are shared by reference with the engine's schema — so
			// restoring the cached schema cannot undo them. The arm's own catch reverses them,
			// nested inside the persist seam's restore.
			expect((await rows(db, `select email from t`)).map(r => r.email), 'the old column name still resolves')
				.to.deep.equal(['a@x.com']);
			await expectConstraintRejected(
				db,
				`insert into t values (2, 'bad')`,
				'the CHECK still names the un-renamed column and still fires',
			);

			// The retry was refused outright by the half-applied schema: the module looked for
			// `email` in a cached schema that already called it `mail`.
			await db.exec(`alter table t rename column email to mail`);
			expect((await rows(db, `select mail from t`)).map(r => r.mail), 'the retried rename took effect')
				.to.deep.equal(['a@x.com']);
		},
	},
];

describe('a refused schema-only ALTER TABLE leaves no residue', () => {
	let provider: TestProvider;

	afterEach(() => {
		provider?._hardClose();
	});

	for (const c of CASES) {
		it(c.title, async () => {
			provider = createProvider();
			const db = open(provider);
			for (const sql of c.setup) await db.exec(sql);

			provider.catalogFailure.fail = true;
			try {
				await expectRefusedDdlLeavesNoResidue(
					provider,
					db,
					c.sql,
					/injected catalog-store write failure/,
				);
			} finally {
				provider.catalogFailure.fail = false;
			}

			await c.after(db, provider);
		});
	}
});

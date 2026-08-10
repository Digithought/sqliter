/**
 * Coarsened backing key (ticket `mv-coarsened-backing-key-warning`): a
 * materialized-view body with no provable unique key whose source primary key
 * survives through value-preserving passthrough lineage (bare column /
 * `collate` / no-op `cast`) is keyed on the coarsened lineage key K' instead
 * of rejected — the parallel-migration-table shape (`docs/migration.md`
 * § Convergence hazards).
 *
 * This spec owns the record/backing surface (the `coarsenedKey` stamp, the
 * backing PK's output collation, the unchanged bag rejections) and the
 * coverage prover's collation gate. The behavioral flows — fill guard, LWW
 * merge, delete-one-sibling anomaly, refresh recovery — live in
 * `test/logic/51.5-materialized-views-coarsened-key.sqllogic`.
 */
import { expect } from 'chai';
import { Database } from '../src/core/database.js';
import { proveCoverage } from '../src/planner/analysis/coverage-prover.js';
import type { RelationalPlanNode } from '../src/planner/nodes/plan-node.js';
import type { TableSchema } from '../src/schema/table.js';
import type { MaintainedTableSchema } from '../src/schema/derivation.js';
import { parseSelect } from '../src/parser/index.js';

async function expectExecError(db: Database, sql: string, messagePart: string): Promise<void> {
	try {
		await db.exec(sql);
	} catch (e) {
		expect(String((e as Error).message)).to.contain(messagePart);
		return;
	}
	expect.fail(`expected '${sql}' to fail with '${messagePart}'`);
}

describe('coarsened backing key (collation-weakening migration shape)', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	it('keys the backing on the coarsened lineage key and stamps the record', async () => {
		await db.exec('create table contact_v1 (handle text primary key, email text)');
		await db.exec("insert into contact_v1 values ('Bob', 'b@x'), ('Carol', 'c@x')");
		await db.exec('create materialized view contact_v2 as select handle collate nocase as handle, email from contact_v1');

		const mv = db.schemaManager.getMaintainedTable('main', 'contact_v2');
		expect(mv, 'MV registered').to.exist;
		expect(mv!.derivation.logicalKey).to.deep.equal([{ index: 0, desc: false }]);
		expect(mv!.derivation.coarsenedKey, 'key-coarsening stamp').to.deep.equal({
			columns: ['handle'],
			weakened: [{ column: 'handle', sourceCollation: 'BINARY', outputCollation: 'NOCASE' }],
		});

		const backing = db.schemaManager.getTable('main', 'contact_v2');
		expect(backing, 'backing table').to.exist;
		expect(backing!.primaryKeyDefinition.length).to.equal(1);
		expect(backing!.primaryKeyDefinition[0].index).to.equal(0);
		expect((backing!.primaryKeyDefinition[0].collation ?? 'BINARY').toUpperCase(), 'backing PK carries the OUTPUT collation').to.equal('NOCASE');
	});

	it('a provable-key body stamps no coarsenedKey', async () => {
		await db.exec('create table t (id integer primary key, v text)');
		await db.exec('create materialized view mv as select id, v collate nocase as v from t');
		const mv = db.schemaManager.getMaintainedTable('main', 'mv');
		expect(mv).to.exist;
		// The bare `id` passthrough preserves the source key, so K' is never derived.
		expect(mv!.derivation.coarsenedKey).to.equal(undefined);
		expect(mv!.derivation.logicalKey).to.deep.equal([{ index: 0, desc: false }]);
	});

	it('a refining lineage key (NOCASE source → BINARY output) is accepted silently', async () => {
		await db.exec('create table nck (h text collate nocase primary key, v integer)');
		await db.exec("insert into nck values ('Bob', 1)");
		await db.exec('create materialized view nck_v as select h collate binary as h, v from nck');
		const mv = db.schemaManager.getMaintainedTable('main', 'nck_v');
		expect(mv).to.exist;
		// BINARY is the finest collation — the lineage key is a genuine unique key,
		// so it keys the backing with no coarsening stamp.
		expect(mv!.derivation.coarsenedKey).to.equal(undefined);
		const backing = db.schemaManager.getTable('main', 'nck_v')!;
		expect((backing.primaryKeyDefinition[0].collation ?? 'BINARY').toUpperCase()).to.equal('BINARY');
	});

	it('a multi-column passthrough body derives a composite coarsened key', async () => {
		await db.exec('create table mc (a text, b text, v integer, primary key (a, b))');
		await db.exec('create materialized view mc_v as select a collate nocase as a, b, v from mc');
		const mv = db.schemaManager.getMaintainedTable('main', 'mc_v');
		expect(mv).to.exist;
		expect(mv!.derivation.logicalKey).to.deep.equal([{ index: 0, desc: false }, { index: 1, desc: false }]);
		expect(mv!.derivation.coarsenedKey).to.deep.equal({
			columns: ['a', 'b'],
			// Only the collation-weakened column is reported; `b` carried its collation through.
			weakened: [{ column: 'a', sourceCollation: 'BINARY', outputCollation: 'NOCASE' }],
		});
	});

	it('an ORDER BY coarsened body keys the backing on the coarsened key alone (no ordering seed)', async () => {
		// The ordering-seeded physical PK (order-by columns leading the key) would
		// widen uniqueness past K' — colliding siblings would coexist silently,
		// defeating the loud fill and the LWW merge. A coarsening key suppresses
		// the seed; only the clustering optimization is lost.
		await db.exec('create table ord_src (handle text primary key, email text)');
		await db.exec("insert into ord_src values ('Bob', 'b@x'), ('bob', 'b2@x')");
		// Colliding seed data must stay LOUD even with an ORDER BY in the body.
		await expectExecError(db,
			'create materialized view ord_v as select handle collate nocase as handle, email from ord_src order by email',
			'must be a set');
		expect(db.schemaManager.getTable('main', 'ord_v')).to.equal(undefined);

		// Over clean data: creates, physical PK is exactly the coarsened key at
		// NOCASE, and a colliding insert LWW-merges (the contract the seed broke).
		await db.exec("delete from ord_src where handle = 'bob'");
		await db.exec('create materialized view ord_v as select handle collate nocase as handle, email from ord_src order by email');
		const backing = db.schemaManager.getTable('main', 'ord_v')!;
		expect(backing.primaryKeyDefinition.map(d => d.index)).to.deep.equal([0]);
		expect((backing.primaryKeyDefinition[0].collation ?? 'BINARY').toUpperCase()).to.equal('NOCASE');
		await db.exec("insert into ord_src values ('BOB', 'b3@x')");
		const rows: unknown[] = [];
		for await (const r of db.eval('select handle, email from ord_v')) rows.push(r);
		expect(rows).to.deep.equal([{ handle: 'BOB', email: 'b3@x' }]);
	});

	it('a NON-coarsening lineage key keeps the ordering seed (true key, uniqueness-preserving)', async () => {
		await db.exec('create table ord_nck (h text collate nocase primary key, v integer)');
		await db.exec("insert into ord_nck values ('Bob', 2), ('Al', 1)");
		await db.exec('create materialized view ord_nck_v as select h collate binary as h, v from ord_nck order by v');
		expect(db.schemaManager.getMaintainedTable('main', 'ord_nck_v')!.derivation.coarsenedKey).to.equal(undefined);
		const backing = db.schemaManager.getTable('main', 'ord_nck_v')!;
		// Physical PK leads with the order-by column, logical key appended — the
		// same seeding a keysOf-proved key gets.
		expect(backing.primaryKeyDefinition.map(d => d.index)).to.deep.equal([1, 0]);
	});

	it('prefers a non-coarsening covering output over a coarsening sibling of the same PK column', async () => {
		await db.exec('create table dual (h text primary key, v integer)');
		await db.exec("insert into dual values ('Bob', 1)");
		// Both outputs cover the source PK column; h2 (BINARY = the source
		// enforcement collation) is a true key, so no coarsening stamp and the
		// backing keys on h2 — not on the coarsening h1 the earlier output index
		// would have picked.
		await db.exec('create materialized view dual_v as select h collate nocase as h1, h collate binary as h2, v from dual');
		const mv = db.schemaManager.getMaintainedTable('main', 'dual_v')!;
		expect(mv.derivation.coarsenedKey).to.equal(undefined);
		expect(mv.derivation.logicalKey).to.deep.equal([{ index: 1, desc: false }]);
		const backing = db.schemaManager.getTable('main', 'dual_v')!;
		expect(backing.primaryKeyDefinition.map(d => d.index)).to.deep.equal([1]);
		expect((backing.primaryKeyDefinition[0].collation ?? 'BINARY').toUpperCase()).to.equal('BINARY');
	});

	it('a key-dropping projection keeps the bag rejection', async () => {
		await db.exec('create table t (id integer primary key, v text)');
		await db.exec("insert into t values (1, 'a')");
		// A key-dropping projection has no lineage to the source key.
		await expectExecError(db, 'create materialized view bag1 as select v from t', 'no provable unique key');
		expect(db.schemaManager.getMaintainedTable('main', 'bag1')).to.equal(undefined);
		expect(db.schemaManager.getTable('main', 'bag1')).to.equal(undefined);
	});

	it('a collated GROUP BY key registers with a real, non-coarsened key', async () => {
		await db.exec('create table t (id integer primary key, v text)');
		await db.exec("insert into t values (1, 'a'), (2, 'A')");
		// The group columns genuinely key the aggregate output, published under
		// exactly their grouping (NOCASE) collation — a real unique key, NOT a
		// coarsened lineage key. (ticket collated-groupby-key-completeness; the
		// non-coarsened complement to mv-coarsened-backing-key-warning.)
		await db.exec('create materialized view bag2 as select v collate nocase as v, count(*) as n from t group by v collate nocase');
		const mv = db.schemaManager.getMaintainedTable('main', 'bag2')!;
		expect(mv, 'MV registered').to.exist;
		expect(mv.derivation.logicalKey).to.deep.equal([{ index: 0, desc: false }]);
		expect(mv.derivation.coarsenedKey, 'genuine key, not coarsened').to.equal(undefined);

		const backing = db.schemaManager.getTable('main', 'bag2')!;
		expect(backing.primaryKeyDefinition.map(d => d.index)).to.deep.equal([0]);
		expect((backing.primaryKeyDefinition[0].collation ?? 'BINARY').toUpperCase(), 'backing PK published NOCASE').to.equal('NOCASE');

		// 'a' and 'A' collapse to one NOCASE group with n = 2.
		const rows: unknown[] = [];
		for await (const r of db.eval('select v, n from bag2')) rows.push(r);
		expect(rows.length).to.equal(1);
		expect((rows[0] as { n: number }).n).to.equal(2);
	});

	it('colliding seed data fails loudly at fill with nothing registered', async () => {
		await db.exec('create table dup_src (handle text primary key)');
		await db.exec("insert into dup_src values ('Bob'), ('bob')");
		await expectExecError(db,
			'create materialized view dup_v2 as select handle collate nocase as handle from dup_src',
			'must be a set');
		expect(db.schemaManager.getMaintainedTable('main', 'dup_v2')).to.equal(undefined);
		expect(db.schemaManager.getTable('main', 'dup_v2')).to.equal(undefined);
	});

	it('a coarsened body the inverse-projection arm declines is maintained by the floor (LWW)', async () => {
		await db.exec('create table t (h text primary key, e text)');
		await db.exec('create table allowed (e text primary key)');
		await db.exec("insert into t values ('Bob','b'), ('Carol','c')");
		await db.exec("insert into allowed values ('b'), ('c'), ('b2')");
		// The WHERE-IN subquery brings a second table ref, so no bounded-delta arm
		// fits — the full-rebuild floor maintains the coarsened body, and its
		// collation-keyed replace-all diff realizes the same LWW merge.
		await db.exec('create materialized view m as select h collate nocase as h, e from t where e in (select e from allowed)');
		expect(db.schemaManager.getMaintainedTable('main', 'm')!.derivation.coarsenedKey).to.deep.equal({
			columns: ['h'],
			weakened: [{ column: 'h', sourceCollation: 'BINARY', outputCollation: 'NOCASE' }],
		});
		await db.exec("insert into t values ('BOB','b2')"); // collides with 'Bob' under NOCASE
		const rows: unknown[] = [];
		for await (const r of db.eval('select h, e from m order by h')) rows.push(r);
		expect(rows).to.deep.equal([{ h: 'BOB', e: 'b2' }, { h: 'Carol', e: 'c' }]);
	});

	it('the coarsened key round-trips refresh (shape fast path) and survives export/import', async () => {
		await db.exec('create table src (h text primary key, v integer)');
		await db.exec("insert into src values ('A', 1)");
		await db.exec('create materialized view m as select h collate nocase as h, v from src');
		// Same derivation on refresh → the data-only fast path (backing identity kept).
		await db.exec('refresh materialized view m');
		const mv = db.schemaManager.getMaintainedTable('main', 'm')!;
		expect(mv.derivation.coarsenedKey).to.deep.equal({
			columns: ['h'],
			weakened: [{ column: 'h', sourceCollation: 'BINARY', outputCollation: 'NOCASE' }],
		});
		const backing = db.schemaManager.getTable('main', 'm')!;
		expect((backing.primaryKeyDefinition[0].collation ?? 'BINARY').toUpperCase()).to.equal('NOCASE');
	});
});

describe('coverage prover — collation gate', () => {
	it('never links across a constraint-vs-output collation mismatch', async () => {
		const db = new Database();
		try {
			await db.exec('create table t (id integer primary key, x text not null, unique (x))');
			const bodySql = 'select x, id from t order by x';
			const root = db.schemaManager.withSuppressedMaterializedViewRewrite(
				() => db.getPlan(bodySql).getRelations()[0],
			) as RelationalPlanNode;
			const table = db.schemaManager.getTable('main', 't')!;
			const mvStub = { name: 'ix', schemaName: 'main', derivation: { selectAst: parseSelect(bodySql) } } as unknown as MaintainedTableSchema;

			// Sanity: matching collations cover.
			expect(proveCoverage(root, mvStub, table.uniqueConstraints![0], table).covers).to.be.true;

			// Doctored base schema: the constrained column claims NOCASE while the
			// planned body's output column is BINARY. A real plan can't reach this
			// today (a collation-changing projection mints a fresh attribute id and
			// fails projection coverage first) — the gate is the explicit guarantee.
			const doctored: TableSchema = {
				...table,
				columns: table.columns.map(c => (c.name === 'x' ? { ...c, collation: 'NOCASE' } : c)),
			};
			const res = proveCoverage(root, mvStub, doctored.uniqueConstraints![0], doctored);
			expect(res.covers).to.be.false;
			if (!res.covers) expect(res.reason).to.equal('collation-mismatch');
		} finally {
			await db.close();
		}
	});
});

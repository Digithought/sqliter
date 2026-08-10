/**
 * Materialized-view maintenance resolves collations against the **database**, not the
 * process-global built-in registry (ticket `3.5-core-callers-collation-resolver`).
 *
 * Column DDL still refuses a collation name it has never heard of (see the
 * `feat-ddl-accepts-registered-collations` backlog ticket), so — as in
 * `test/collation-resolver.spec.ts` — these tests reach a *custom* comparator by
 * overriding the built-in `NOCASE` on one connection. The override equates any two
 * strings of the same length, which the built-in NOCASE never does; every assertion below
 * is therefore false under byte comparison and false under the real NOCASE.
 */
import { expect } from 'chai';
import { Database } from '../src/index.js';
import {
	backingPkEqual,
	residualRowMatchesKey,
	residualRowMatchesBasePrefix,
} from '../src/core/database-materialized-views-apply.js';
import type {
	BackingPkColumn,
	ForwardResidualPlan,
	PrefixDeletePlan,
} from '../src/core/database-materialized-views-plans.js';
import { uniqueEnforcementCollations } from '../src/schema/unique-enforcement.js';
import { BINARY_COLLATION, resolveCollationFunctions } from '../src/util/comparison.js';

/** A `NOCASE` that equates every pair of same-length strings. */
const lengthOnly = (a: string, b: string): number => a.length - b.length;
/** Partitions strings into the same classes as {@link lengthOnly}; hash-keyed paths need it. */
const lengthNormalizer = (s: string): string => 'x'.repeat(s.length);

async function results(db: Database, sql: string): Promise<Record<string, unknown>[]> {
	const rows: Record<string, unknown>[] = [];
	for await (const r of db.eval(sql)) rows.push(r as Record<string, unknown>);
	return rows;
}

describe('materialized-view maintenance under a database-registered collation', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
		db.registerCollation('NOCASE', lengthOnly, { normalizer: lengthNormalizer });
	});
	afterEach(async () => { await db.close(); });

	it("routes a covering-MV UNIQUE conflict under the source column's registered collation", async () => {
		await db.exec('create table t (id integer primary key, x text collate nocase not null, unique (x))');
		await db.exec('create materialized view ix as select x, id from t order by x');
		await db.exec("insert into t values (1, 'aa')");

		// 'bb' is NOCASE-equal to 'aa' under this connection's collation, so it violates
		// UNIQUE(x). Resolving NOCASE from the process-global registry would compare the
		// bytes, find no conflict, and admit the duplicate.
		let failed = false;
		try {
			await db.exec("insert into t values (2, 'bb')");
		} catch (e) {
			failed = true;
			expect(String(e)).to.match(/UNIQUE constraint failed/i);
		}
		expect(failed, 'duplicate under the registered collation must be rejected').to.equal(true);
		expect(await results(db, 'select id from t order by id')).to.deep.equal([{ id: 1 }]);
	});

	it('does not invent a conflict for values the registered collation keeps distinct', async () => {
		await db.exec('create table t (id integer primary key, x text collate nocase not null, unique (x))');
		await db.exec('create materialized view ix as select x, id from t order by x');
		await db.exec("insert into t values (1, 'aa')");
		await db.exec("insert into t values (2, 'bbb')"); // different length ⇒ distinct
		expect(await results(db, 'select id from t order by id')).to.deep.equal([{ id: 1 }, { id: 2 }]);
		expect(await results(db, 'select x, id from ix order by id')).to.deep.equal([
			{ x: 'aa', id: 1 }, { x: 'bbb', id: 2 },
		]);
	});

	it('recomputes an aggregate MV whose group key is collation-equal but byte-different', async () => {
		// The `residual-recompute` arm: the second insert binds the group key `'bb'`, the
		// key-filtered residual recomputes the group and emits `'aa'` (the representative
		// already in the backing table). `residualRowMatchesKey` must keep that row — a byte
		// comparison would drop it and leave the backing sum stale.
		await db.exec('create table src (id integer primary key, k text collate nocase not null, v integer not null)');
		await db.exec('create table agg (k text collate nocase primary key, s real null) maintained as select k, sum(v) as s from src group by k');
		await db.exec("insert into src values (1, 'aa', 10)");
		expect(await results(db, 'select k, s from agg')).to.deep.equal([{ k: 'aa', s: 10 }]);

		await db.exec("insert into src values (2, 'bb', 5)");
		expect(await results(db, 'select k, s from agg')).to.deep.equal([{ k: 'aa', s: 15 }]);

		// 'ccc' is a different length ⇒ its own group.
		await db.exec("insert into src values (3, 'ccc', 7)");
		expect(await results(db, 'select k, s from agg order by k, s'))
			.to.deep.equal([{ k: 'aa', s: 15 }, { k: 'ccc', s: 7 }]);

		// Deleting one member of the folded group leaves the other's contribution behind.
		await db.exec('delete from src where id = 1');
		expect(await results(db, 'select s from agg where k = \'bb\'')).to.deep.equal([{ s: 5 }]);
	});

	it('an UPDATE that is a no-op under the collation leaves the covering MV consistent', async () => {
		await db.exec('create table t (id integer primary key, x text collate nocase not null, unique (x))');
		await db.exec('create materialized view ix as select x, id from t order by x');
		await db.exec("insert into t values (1, 'aa')");
		// 'zz' is collation-equal to 'aa', so the row keeps its identity: the UNIQUE
		// self-conflict check must recognize the conflicting backing row as its own.
		await db.exec("update t set x = 'zz' where id = 1");
		expect(await results(db, 'select id, x from t')).to.deep.equal([{ id: 1, x: 'zz' }]);
		expect(await results(db, 'select x, id from ix')).to.deep.equal([{ x: 'zz', id: 1 }]);
	});

	it('the declared collation the covering path compares under resolves through the database', async () => {
		await db.exec('create table t (id integer primary key, x text collate nocase not null, unique (x))');
		const schema = db.schemaManager.getTable('main', 't')!;
		const uc = schema.uniqueConstraints![0];
		// `lookupCoveringConflicts` compares candidates under the *declared source column*
		// collation, never the constraint's enforcement collation — see its comment. For this
		// non-index-derived UNIQUE the two coincide, which is what lets the shared helper stand
		// in below; what the assertion pins is that the name resolves through the database
		// resolver to the connection's comparator, not the process-global registry.
		expect(uniqueEnforcementCollations(schema, uc))
			.to.deep.equal(uc.columns.map(c => schema.columns[c].collation));
		const [fn] = resolveCollationFunctions(db.getCollationResolver(), uc.columns.map(c => schema.columns[c].collation));
		expect(fn).to.equal(lengthOnly);
	});
});

describe('the maintained-table "must be a set" gate resolves collations through the database', () => {
	// `assertDerivedRowsAreSet` / `assertRefreshRowsAreSet`
	// (runtime/emit/materialized-view-helpers.ts) pair derived rows under the backing
	// primary-key collations, resolved through `db.getCollationResolver()`. Here `NOCASE`
	// is overridden to fold nothing, so 'aa' and 'AA' are distinct keys; a gate that
	// resolved `NOCASE` from a process-global registry would fold them together and reject
	// a set that is a set. Both the admitting and the rejecting branch are covered.
	const caseSensitiveNocase = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		db.registerCollation('NOCASE', caseSensitiveNocase, { normalizer: (s: string) => s });
		await db.exec('create table src (x text collate nocase primary key, id integer not null)');
	});
	afterEach(async () => { await db.close(); });

	it('admits an attach whose derived keys the registered collation keeps distinct', async () => {
		await db.exec("insert into src values ('aa', 1), ('AA', 2)");
		await db.exec('create table mt (x text collate nocase primary key, id integer not null) maintained as select x, id from src');
		expect(await results(db, 'select x, id from mt order by id')).to.deep.equal([
			{ x: 'aa', id: 1 }, { x: 'AA', id: 2 },
		]);
	});

	it('admits a constraint-bearing refresh whose recomputed keys the registered collation keeps distinct', async () => {
		await db.exec("insert into src values ('aa', 1)");
		// The CHECK routes `refresh` through the constraint-bearing branch, the only arm
		// that calls `assertRefreshRowsAreSet`.
		await db.exec(`create table mt (x text collate nocase primary key, id integer not null, check (x <> 'poison'))
			maintained as select x, id from src`);
		// Stales the view and detaches its row-time plan, so the next insert drifts the
		// source without being maintained into the backing.
		await db.exec('alter table src add column pad integer null');
		await db.exec("insert into src (x, id) values ('AA', 2)");

		await db.exec('refresh materialized view mt');
		expect(await results(db, 'select x, id from mt order by id')).to.deep.equal([
			{ x: 'aa', id: 1 }, { x: 'AA', id: 2 },
		]);
	});

	describe('the rejecting branch also decides under the database collation', () => {
		// The derived key is a NON-key source column (`src`'s primary key is `id`), so the
		// body can genuinely collide and the gate is the first check that can see it. The
		// coverage prover rejects this body as a bag too, but only *after* the attach has
		// evaluated the rows and run the gate — so which of the two errors surfaces reports
		// the gate's verdict.
		async function attachCollidingBody(database: Database): Promise<string> {
			await database.exec('create table src2 (id integer primary key, x text collate nocase not null)');
			await database.exec("insert into src2 values (1, 'aa'), (2, 'AA')");
			try {
				await database.exec('create table mt2 (x text collate nocase primary key) maintained as select x from src2');
			} catch (e) {
				return (e as Error).message;
			}
			return '';
		}

		/** The gate's own error. The coverage prover's bag error also says "must be a set". */
		const GATE_REJECTION = /produces duplicate rows for primary key/;

		it('rejects the colliding body under the built-in NOCASE', async () => {
			const builtin = new Database();
			try {
				expect(await attachCollidingBody(builtin)).to.match(GATE_REJECTION);
			} finally {
				await builtin.close();
			}
		});

		it('admits the same body when the database overrides NOCASE to fold nothing', async () => {
			// `db` already has the case-sensitive NOCASE registered. The gate must let both
			// rows through; the bag error that follows comes from the coverage prover, not
			// the gate. Against the pre-change global lookup the gate rejected here.
			const message = await attachCollidingBody(db);
			expect(message).to.match(/no provable unique key/);
			expect(message).to.not.match(GATE_REJECTION);
		});
	});
});

describe('materialized-view apply-path key comparisons use the plan-resolved collation', () => {
	// The three per-row helpers read `collationFn` off each backing-PK descriptor, which the
	// plan builder resolved against the database once. Exercised directly here, at the unit
	// level; the aggregate (`residual-recompute`) arm also has end-to-end SQL coverage above
	// — see "recomputes an aggregate MV whose group key is collation-equal but
	// byte-different". The prefix-delete arm's lateral-TVF body has no direct SQL coverage yet.
	const pkCol = (index: number, collationFn = BINARY_COLLATION): BackingPkColumn =>
		({ index, collation: 'NOCASE', collationFn });

	const custom = [pkCol(0, lengthOnly)];
	const binary = [pkCol(0)];

	it('residualRowMatchesKey keeps a residual row whose key is collation-equal', () => {
		const plan = { backingPkDefinition: custom } as unknown as ForwardResidualPlan;
		expect(residualRowMatchesKey(plan, ['aa'], ['bb'])).to.equal(true);
		expect(residualRowMatchesKey(plan, ['aa'], ['bbb'])).to.equal(false);

		const binaryPlan = { backingPkDefinition: binary } as unknown as ForwardResidualPlan;
		expect(residualRowMatchesKey(binaryPlan, ['aa'], ['bb'])).to.equal(false);
	});

	it('backingPkEqual pairs an existing backing row with its collation-equal replacement', () => {
		expect(backingPkEqual(custom, ['aa'], ['bb'])).to.equal(true);
		expect(backingPkEqual(binary, ['aa'], ['bb'])).to.equal(false);
	});

	it('residualRowMatchesBasePrefix compares the base prefix under its collation', () => {
		const plan = { backingPkDefinition: custom, basePrefixLength: 1 } as unknown as PrefixDeletePlan;
		expect(residualRowMatchesBasePrefix(plan, ['aa', 9], ['bb'])).to.equal(true);
		expect(residualRowMatchesBasePrefix(plan, ['aaa', 9], ['bb'])).to.equal(false);
	});
});

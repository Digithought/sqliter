import { expect } from 'chai';
import * as fc from 'fast-check';
import { Database } from '../../src/core/database.js';
import { QuereusError } from '../../src/common/errors.js';
import { StatusCode, type SqlValue } from '../../src/common/types.js';
import { createAggregateFunction } from '../../src/func/registration.js';
import { INTEGER_TYPE } from '../../src/types/builtin-types.js';

/**
 * Delta-aggregate fast path (feat-mv-agg-delta-arm) — the arithmetic maintenance path
 * INSIDE the `'residual-recompute'` arm. When every stored aggregate column is
 * delta-maintainable by its DECLARED algebra (merge + negate + decode, exact numeric
 * domain, a count(*) multiplicity witness), the statement flush maintains each affected
 * group by pure arithmetic on the stored backing row — zero source reads, no residual
 * re-execution. These suites pin the create-time routing (which bodies get the
 * descriptor), drive a declared-algebra UDAF through a random-mutation equivalence
 * property, prove the oracle catches a BROKEN declaration (wrong negate), exercise the
 * nullable-argument retraction fallback (the one case where the stored sum cannot prove
 * a retraction observational), and converge a two-level delta-over-delta chain.
 *
 * The oracle discipline mirrors `maintenance-equivalence.spec.ts`: read the MV backing
 * directly, re-evaluate the body LIVE with the answer-from-MV rewrite disabled, and
 * compare as multisets — after mutations, mid-transaction, and after rollback.
 */

interface DeltaPlanLike {
	readonly kind: string;
	readonly chosenStrategy: string;
	readonly delta?: {
		readonly retractionSafe: boolean;
		readonly hasTighten: boolean;
		readonly aggColumns: readonly { readonly retractionSafe: boolean; readonly deltaClass: string }[];
		readonly multiplicityIndex: number;
	};
}
interface ManagerHandle { readonly materializedViewManager: { rowTime: Map<string, DeltaPlanLike> } }

function deltaPlan(db: Database, name: string): DeltaPlanLike | undefined {
	return (db as unknown as ManagerHandle).materializedViewManager.rowTime.get(`main.${name}`.toLowerCase());
}

/** Canonical, order-stable serialization of one result row (bigint-safe). */
function canonRow(values: readonly SqlValue[]): string {
	return JSON.stringify(values, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v));
}

/** Read a query as an order-insensitive multiset of canonical rows. */
async function readMultiset(db: Database, sql: string): Promise<string[]> {
	const rows: string[] = [];
	for await (const row of db.eval(sql)) {
		rows.push(canonRow(Object.values(row) as SqlValue[]));
	}
	return rows.sort();
}

/** Assert `read(mvName) == evaluate(body)` as multisets, with the read-side
 *  answer-from-MV rewrite disabled for the live oracle read. */
async function assertEq(db: Database, mvName: string, body: string, phase: string): Promise<void> {
	const fromMv = await readMultiset(db, `select * from ${mvName}`);
	const prev = db.optimizer.tuning;
	db.optimizer.updateTuning({ ...prev, disabledRules: new Set([...(prev.disabledRules ?? []), 'materialized-view-rewrite']) });
	let fromBody: string[];
	try {
		fromBody = await readMultiset(db, body);
	} finally {
		db.optimizer.updateTuning(prev);
	}
	expect(fromMv, `${phase}: MV backing diverged from live body`).to.deep.equal(fromBody);
}

/** Execute, tolerating statement-atomic CONSTRAINT aborts (PK collisions in the random
 *  mutation streams) — any other error propagates and fails the property. */
async function execTolerant(db: Database, sql: string): Promise<void> {
	try {
		await db.exec(sql);
	} catch (e) {
		if (e instanceof QuereusError && e.code === StatusCode.CONSTRAINT) return;
		throw e;
	}
}

/** An abelian-group integer UDAF (xor is its own inverse) declaring the full
 *  delta-maintenance algebra — the function-generic path: the engine reads ONLY the
 *  declaration, never a builtin-name list. `negate` is injectable so the broken-twin
 *  test can declare a WRONG inverse. */
function xorSchema(name: string, negate: (a: number) => number) {
	return createAggregateFunction(
		{
			name, numArgs: 1, initialValue: 0,
			returnType: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true },
			algebra: {
				merge: (a: number, b: number): number => a ^ b,
				negate,
				decode: (stored: SqlValue): number => Number(stored),
				decodeExact: true,
			},
		},
		(acc: number, v: SqlValue): number => (v === null ? acc : acc ^ Number(v)),
		(acc: number): number => acc,
	);
}

/** Random source mutations over `src (id pk, a, k)` — inserts, updates (both `a` and the
 *  group key `k`), deletes. `a` values come from `aArb` so the nullable suite can mix
 *  NULLs in. Collisions are tolerated (statement-atomic abort). */
function mutationArbFor(aArb: fc.Arbitrary<number | null>): fc.Arbitrary<string> {
	const idArb = fc.integer({ min: 1, max: 6 });
	const kArb = fc.integer({ min: 1, max: 3 });
	const lit = (v: number | null): string => (v === null ? 'null' : String(v));
	return fc.oneof(
		fc.record({ id: idArb, a: aArb, k: kArb }).map(m => `insert into src (id, a, k) values (${m.id}, ${lit(m.a)}, ${m.k})`),
		fc.record({ id: idArb, a: aArb, k: kArb }).map(m => `update src set a = ${lit(m.a)}, k = ${m.k} where id = ${m.id}`),
		fc.record({ oldId: idArb, newId: idArb }).map(m => `update src set id = ${m.newId} where id = ${m.oldId}`),
		fc.record({ id: idArb }).map(m => `delete from src where id = ${m.id}`),
	);
}

/** Drive a random mutation stream and assert equivalence mid-transaction and after
 *  rollback (the shared property body of the suites below). */
function defineMutationProperty(
	getDb: () => Database,
	assertAll: (phase: string) => Promise<void>,
	aArb: fc.Arbitrary<number | null>,
	numRuns: number,
): void {
	it('read(MV) == evaluate(body) across random mutations, in-txn and after rollback', async () => {
		await fc.assert(fc.asyncProperty(
			fc.array(mutationArbFor(aArb), { minLength: 1, maxLength: 10 }),
			async (statements) => {
				const db = getDb();
				await assertAll('baseline');
				await db.exec('begin');
				try {
					for (const sql of statements) await execTolerant(db, sql);
					await assertAll('in-transaction');
				} finally {
					await db.exec('rollback');
				}
				await assertAll('post-rollback');
			},
		), { numRuns });
	});
}

const intArb: fc.Arbitrary<number | null> = fc.integer({ min: 0, max: 10 });
const intOrNullArb: fc.Arbitrary<number | null> = fc.oneof(
	fc.constant<number | null>(null),
	fc.integer({ min: 0, max: 10 }),
);

describe('Delta-aggregate fast path (arithmetic maintenance inside residual-recompute)', () => {
	describe('create-time routing pins', () => {
		let db: Database;
		beforeEach(async () => {
			db = new Database();
			await db.exec('create table src (id integer primary key, a integer, b integer, k integer)');
		});
		afterEach(async () => { await db.close(); });

		it('count(*) + integer sum routes through delta (retraction-safe: NOT NULL argument)', async () => {
			await db.exec('create materialized view mv as select k, count(*) as c, sum(a) as s from src group by k');
			const plan = deltaPlan(db, 'mv')!;
			expect(plan.kind, 'kind stays residual-recompute').to.equal('residual-recompute');
			expect(plan.chosenStrategy).to.equal('delta-aggregate');
			expect(plan.delta, 'descriptor attached').to.exist;
			expect(plan.delta!.retractionSafe, 'NOT NULL int arg is retraction-safe').to.equal(true);
		});

		it('count(*) alone (multiplicity-only body) routes through delta', async () => {
			await db.exec('create materialized view mv as select k, count(*) as c from src group by k');
			const plan = deltaPlan(db, 'mv')!;
			expect(plan.chosenStrategy).to.equal('delta-aggregate');
			expect(plan.delta!.aggColumns.length).to.equal(1);
			expect(plan.delta!.multiplicityIndex).to.equal(0);
		});

		it('min/max routes through delta via the tighten class (merge, no negate — feat-mv-agg-delta-tighten)', async () => {
			await db.exec('create materialized view mv as select k, count(*) as c, sum(a) as s, min(b) as mn, max(b) as mx from src group by k');
			const plan = deltaPlan(db, 'mv')!;
			expect(plan.kind, 'kind stays residual-recompute').to.equal('residual-recompute');
			expect(plan.chosenStrategy, 'tighten column admits the delta arm').to.equal('delta-aggregate');
			expect(plan.delta, 'descriptor attached').to.exist;
			expect(plan.delta!.hasTighten, 'min/max flagged as tighten').to.equal(true);
			// Whole descriptor is never retraction-safe with a tighten column: a retracted group
			// re-derives wholesale from the residual (mixed group+tighten row maintained one way).
			expect(plan.delta!.retractionSafe, 'a tighten column is never retraction-safe').to.equal(false);
			const classes = plan.delta!.aggColumns.map(c => c.deltaClass).sort();
			expect(classes, 'count/sum group columns + min/max tighten columns').to.deep.equal(['group', 'group', 'tighten', 'tighten']);
		});

		it('sum over a NULLABLE integer argument stays delta but NOT retraction-safe', async () => {
			await db.exec('create table srcn (id integer primary key, a integer null, k integer)');
			await db.exec('create materialized view mv as select k, count(*) as c, sum(a) as s from srcn group by k');
			const plan = deltaPlan(db, 'mv')!;
			expect(plan.chosenStrategy).to.equal('delta-aggregate');
			expect(plan.delta!.retractionSafe, 'nullable sum arg: retraction falls back to residual').to.equal(false);
		});

		it('sum over a TEXT argument fails the exact-domain gate (residual)', async () => {
			await db.exec('create table srct (id integer primary key, t text, k integer)');
			await db.exec('create materialized view mv as select k, count(*) as c, sum(t) as s from srct group by k');
			const plan = deltaPlan(db, 'mv')!;
			expect(plan.chosenStrategy).to.equal('residual-recompute');
			expect(plan.delta).to.equal(undefined);
		});

		it('a non-BINARY group-key collation fails the point-read gate (residual)', async () => {
			await db.exec('create table srcc (id integer primary key, g text collate nocase, a integer)');
			await db.exec('create materialized view mv as select g, count(*) as c, sum(a) as s from srcc group by g');
			const plan = deltaPlan(db, 'mv')!;
			expect(plan.chosenStrategy).to.equal('residual-recompute');
			expect(plan.delta).to.equal(undefined);
		});

		it('sum without a count(*) multiplicity witness stays residual', async () => {
			await db.exec('create materialized view mv as select k, sum(a) as s from src group by k');
			const plan = deltaPlan(db, 'mv')!;
			expect(plan.chosenStrategy).to.equal('residual-recompute');
			expect(plan.delta).to.equal(undefined);
		});

		it('an expression aggregate argument (sum(a*2)) stays residual', async () => {
			await db.exec('create materialized view mv as select k, count(*) as c, sum(a * 2) as s from src group by k');
			const plan = deltaPlan(db, 'mv')!;
			expect(plan.chosenStrategy).to.equal('residual-recompute');
			expect(plan.delta).to.equal(undefined);
		});
	});

	describe('declared-algebra UDAF equivalence (test_xor over random mutations)', () => {
		const body = 'select k, count(*) as c, test_xor(a) as x from src group by k';
		let db: Database;

		beforeEach(async () => {
			db = new Database();
			db.registerFunction(xorSchema('test_xor', (a: number): number => a));
			await db.exec('create table src (id integer primary key, a integer, k integer)');
			await db.exec('insert into src (id, a, k) values (1, 0, 3), (2, 3, 2), (3, 7, 1)');
			await db.exec(`create materialized view mv as ${body}`);
			expect(deltaPlan(db, 'mv')!.chosenStrategy, 'UDAF body routes through delta').to.equal('delta-aggregate');
		});
		afterEach(async () => { await db.close(); });

		defineMutationProperty(() => db, phase => assertEq(db, 'mv', body, phase), intArb, 25);
	});

	describe('broken-law negative twin: the oracle catches a wrong negate', () => {
		it('a UDAF declaring an incorrect inverse diverges the MV from the live body on delete', async () => {
			const db = new Database();
			try {
				// negate = arithmetic minus is WRONG for xor (its true inverse is itself):
				// retracting a row merges stored ^ (-x) instead of stored ^ x.
				db.registerFunction(xorSchema('test_xor_bad', (a: number): number => -a));
				await db.exec('create table src (id integer primary key, a integer, k integer)');
				const body = 'select k, count(*) as c, test_xor_bad(a) as x from src group by k';
				await db.exec(`create materialized view mv as ${body}`);
				expect(deltaPlan(db, 'mv')!.chosenStrategy, 'the engine trusts the declaration').to.equal('delta-aggregate');
				await db.exec('insert into src (id, a, k) values (1, 5, 1), (2, 3, 1)');
				await assertEq(db, 'mv', body, 'insert-only stays green');
				await db.exec('delete from src where id = 1');
				let diverged = false;
				try {
					await assertEq(db, 'mv', body, 'after delete');
				} catch {
					diverged = true;
				}
				expect(diverged, 'the equivalence oracle must catch the broken declaration').to.equal(true);
			} finally {
				await db.close();
			}
		});
	});

	describe('nullable-argument retraction fallback (witness decode cannot prove the count)', () => {
		let db: Database;
		const body = 'select k, count(*) as c, sum(a) as s from src group by k';

		beforeEach(async () => {
			db = new Database();
			await db.exec('create table src (id integer primary key, a integer null, k integer)');
			await db.exec(`create materialized view mv as ${body}`);
			expect(deltaPlan(db, 'mv')!.delta!.retractionSafe).to.equal(false);
		});
		afterEach(async () => { await db.close(); });

		it('deleting one of several non-NULL contributions keeps the surviving sum (no spurious NULL)', async () => {
			// The witness-collapse hazard: the stored sum decodes with no true count; a
			// naive retraction through the decode witness would finalize NULL though a
			// contribution survives. The fallback re-derives the group via the residual.
			await db.exec('insert into src (id, a, k) values (1, 5, 2), (2, 7, 2)');
			await db.exec('delete from src where id = 1');
			await assertEq(db, 'mv', body, 'partial retraction');
		});

		it('deleting the LAST non-NULL contribution of a surviving group yields sum NULL', async () => {
			await db.exec('insert into src (id, a, k) values (1, 5, 2), (2, null, 2)');
			await db.exec('delete from src where id = 1');
			await assertEq(db, 'mv', body, 'last non-NULL retracted, group survives on a NULL-arg row');
		});

		it('NULL arguments count toward count(*) but not sum; inserts stay on pure arithmetic', async () => {
			await db.exec('insert into src (id, a, k) values (1, null, 1), (2, null, 1), (3, 4, 1)');
			await assertEq(db, 'mv', body, 'NULL-mixed inserts');
		});

		defineMutationProperty(() => db, phase => assertEq(db, 'mv', body, phase), intOrNullArb, 25);
	});

	describe('two-level delta chain (delta MV over a delta MV)', () => {
		let db: Database;
		const mv1Body = 'select k, count(*) as c, sum(a) as s from src group by k';
		// mv2 groups mv1's count column (INTEGER, NOT NULL) — delta-eligible over the
		// producer's backing. The oracle re-derives it from src directly.
		const mv2Oracle = `select c, count(*) as n from (${mv1Body}) group by c`;

		beforeEach(async () => {
			db = new Database();
			await db.exec('create table src (id integer primary key, a integer, k integer)');
			await db.exec('insert into src (id, a, k) values (1, 1, 1), (2, 2, 1), (3, 3, 2)');
			await db.exec(`create materialized view mv1 as ${mv1Body}`);
			await db.exec('create materialized view mv2 as select c, count(*) as n from mv1 group by c');
			expect(deltaPlan(db, 'mv1')!.chosenStrategy, 'producer on delta').to.equal('delta-aggregate');
			expect(deltaPlan(db, 'mv2')!.chosenStrategy, 'consumer on delta').to.equal('delta-aggregate');
		});
		afterEach(async () => { await db.close(); });

		defineMutationProperty(
			() => db,
			async (phase) => {
				await assertEq(db, 'mv1', mv1Body, `${phase}: mv1`);
				await assertEq(db, 'mv2', mv2Oracle, `${phase}: mv2`);
			},
			intArb,
			20,
		);
	});
});

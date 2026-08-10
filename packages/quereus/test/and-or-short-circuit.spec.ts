import { expect } from 'chai';
import { Database } from '../src/index.js';
import type { SqlValue } from '../src/common/types.js';
import { programOf as dumpProgram } from './util/debug-program.js';

/**
 * AND/OR short-circuit deferral (runtime/emit/binary.ts `buildLogicalOpSpec` /
 * `emitShortCircuitLogicalOp`).
 *
 * When an AND/OR right operand contains a subquery, it is emitted as an
 * on-demand callback and evaluated only when the left operand does not already
 * decide the result. This suite pins three things:
 *
 *  1. Full three-valued-logic parity across BOTH emit paths (a pure-scalar RHS
 *     stays eager; a subquery-wrapped RHS defers) for every {true,false,null}²
 *     input — the deferred combine must be byte-identical to the eager one.
 *  2. The deferred RHS genuinely does NOT run when the left decides — proven by
 *     a counting/throwing scalar UDF wrapped in a subquery (the counter must
 *     reflect per-row lazy evaluation, distinguishing it from both
 *     eager-every-row and hoist-once).
 *  3. The gate is subquery-containment: trivial two-column operands stay on the
 *     zero-overhead eager path (asserted via the debug program note).
 */

type Tri = true | false | null;

const decode = (x: 0 | 1 | null): Tri => (x === null ? null : x === 1);

function combine(op: 'AND' | 'OR' | 'XOR', a: Tri, b: Tri): Tri {
	switch (op) {
		case 'AND':
			if (a === false || b === false) return false;
			if (a === null || b === null) return null;
			return true;
		case 'OR':
			if (a === true || b === true) return true;
			if (a === null || b === null) return null;
			return false;
		case 'XOR':
			if (a === null || b === null) return null;
			return a !== b;
	}
}

// All nine {true,false,null}² operand pairs, encoded as 1 / 0 / null integers
// (isTruthy maps 1→true, 0→false). Row id = index + 1.
const COMBOS: Array<[0 | 1 | null, 0 | 1 | null]> = [
	[1, 1], [1, 0], [1, null],
	[0, 1], [0, 0], [0, null],
	[null, 1], [null, 0], [null, null],
];

async function collect(db: Database, sql: string): Promise<Array<Record<string, SqlValue>>> {
	const rows: Array<Record<string, SqlValue>> = [];
	for await (const r of db.eval(sql)) rows.push(r);
	return rows;
}

describe('AND/OR short-circuit deferral', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	describe('three-valued-logic parity (eager vs deferred paths)', () => {
		beforeEach(async () => {
			await db.exec('create table tv (id integer primary key, a integer null, b integer null)');
			const values = COMBOS
				.map(([a, b], i) => `(${i + 1}, ${a === null ? 'null' : a}, ${b === null ? 'null' : b})`)
				.join(', ');
			await db.exec(`insert into tv values ${values}`);
		});

		for (const op of ['AND', 'OR', 'XOR'] as const) {
			it(`${op}: subquery-wrapped RHS (deferred) matches pure-scalar RHS (eager) and the reference truth table`, async () => {
				const expected = COMBOS.map(([a, b], i) => ({
					id: i + 1,
					r: combine(op, decode(a), decode(b)),
				}));

				// Pure-scalar RHS: two column reads, no subquery → eager two-param path.
				const eager = await collect(
					db,
					`select id, (a ${op.toLowerCase()} b) as r from tv order by id`,
				);

				// Subquery-wrapped RHS: a correlated scalar subquery yielding the same b
				// → AND/OR defer behind the short-circuit callback (XOR stays eager but
				// must still agree).
				const deferred = await collect(
					db,
					`select id, (a ${op.toLowerCase()} (select b from tv t2 where t2.id = tv.id)) as r from tv order by id`,
				);

				expect(eager, `${op} eager path diverged from the reference truth table`).to.deep.equal(expected);
				expect(deferred, `${op} deferred path diverged from the reference truth table`).to.deep.equal(expected);
			});
		}
	});

	describe('deferred RHS is not evaluated when the left operand decides', () => {
		let calls: number;

		beforeEach(async () => {
			calls = 0;
			// Non-deterministic by default → the engine cannot hoist/cache it, so each
			// evaluation is a distinct call. The subquery wrapper `(select sidefx())`
			// (tableless) trips the subquery gate, which is the whole reason the gate is
			// subquery-containment rather than a cost threshold.
			db.createScalarFunction('sidefx', { numArgs: 0 }, () => {
				calls++;
				return 1;
			});
			await db.exec('create table c (id integer primary key, k integer)');
			// k = 1 only for id 1; ids 2 and 3 need the RHS under OR.
			await db.exec('insert into c values (1, 1), (2, 2), (3, 3)');
		});

		// A top-level OR in WHERE stays a single disjunction (it cannot be split into
		// independent filters the way a conjunction can), so it reaches emit as one
		// OR binary op and short-circuits per row — the ticket's headline use case.
		it('OR in WHERE: RHS runs only for rows whose left operand is not already true', async () => {
			const rows = await collect(
				db,
				'select id from c where k = 1 or (select sidefx()) = 1 order by id',
			);
			// id1 short-circuits (left true); id2, id3 fall through and call sidefx.
			// 2 (not 3 = eager-every-row, not 1 = hoist-once) proves per-row deferral.
			expect(calls, 'sidefx must run once per row that reaches the RHS').to.equal(2);
			expect(rows.map(r => r.id)).to.deep.equal([1, 2, 3]);
		});

		// NB: a top-level AND in WHERE never reaches this emitter — the optimizer
		// decomposes it into separate filter nodes, and whatever survives is split into
		// conjuncts by `emitFilter`, which runs its own early exit (see
		// test/filter-conjunct-early-exit.spec.ts). The AND short-circuit here is
		// observable wherever the AND survives as a scalar binary op — a SELECT-list
		// projection, an ON clause, a CASE arm.
		it('AND (SELECT-list): RHS runs only for rows whose left operand is true', async () => {
			const rows = await collect(
				db,
				'select id, (k = 2 and (select sidefx()) = 1) as r from c order by id',
			);
			// Only id2 has k = 2, so only id2 reaches the RHS.
			expect(calls).to.equal(1);
			expect(rows).to.deep.equal([
				{ id: 1, r: false },
				{ id: 2, r: true },
				{ id: 3, r: false },
			]);
		});

		it('AND (SELECT-list): RHS never runs when the left operand is false for every row', async () => {
			const rows = await collect(
				db,
				'select id, (k = 99 and (select sidefx()) = 1) as r from c order by id',
			);
			expect(calls, 'no row has k = 99, so the RHS must be skipped entirely').to.equal(0);
			expect(rows).to.deep.equal([
				{ id: 1, r: false },
				{ id: 2, r: false },
				{ id: 3, r: false },
			]);
		});

		it('short-circuit skips a throwing RHS entirely (observable non-evaluation)', async () => {
			db.createScalarFunction('boom', { numArgs: 0 }, () => {
				throw new Error('RHS must not run');
			});
			// AND: left false for every row → boom never evaluated → no throw.
			const andRows = await collect(
				db,
				'select id, (k > 100 and (select boom()) = 1) as r from c order by id',
			);
			expect(andRows).to.deep.equal([
				{ id: 1, r: false },
				{ id: 2, r: false },
				{ id: 3, r: false },
			]);

			// OR: left true for every row → boom never evaluated → no throw.
			const orRows = await collect(
				db,
				'select id, (k >= 1 or (select boom()) = 1) as r from c order by id',
			);
			expect(orRows).to.deep.equal([
				{ id: 1, r: true },
				{ id: 2, r: true },
				{ id: 3, r: true },
			]);
		});
	});

	describe('correlated and nested composition', () => {
		beforeEach(async () => {
			await db.exec('create table o (id integer primary key, flag integer)');
			await db.exec('create table i (id integer primary key, oid integer, val integer)');
			await db.exec('insert into o values (1, 1), (2, 1), (3, 0)');
			await db.exec('insert into i values (10, 1, 100), (20, 1, 300), (30, 2, 50)');
		});

		it('correlated deferred RHS resolves its outer row when invoked lazily', async () => {
			// RHS is a correlated aggregate subquery; for flag=0 rows the AND left is
			// false and the subquery is skipped, otherwise it must see the outer o.id.
			const rows = await collect(
				db,
				'select id, (flag = 1 and (select max(val) from i where i.oid = o.id) > 150) as r from o order by id',
			);
			expect(rows).to.deep.equal([
				{ id: 1, r: true },   // flag=1, max(val)=300 > 150
				{ id: 2, r: false },  // flag=1, max(val)=50  ≤ 150
				{ id: 3, r: false },  // flag=0 → left false → AND short-circuits to false
			]);
		});

		it('nested short-circuit: a and (b or (subquery)) composes correctly', async () => {
			const rows = await collect(
				db,
				'select id, (flag = 1 and (id = 1 or (select count(*) from i where i.oid = o.id) > 5)) as r from o order by id',
			);
			// id1: flag=1 and (true or …) → true (inner OR short-circuits on id=1).
			// id2: flag=1 and (false or count(i for oid=2)=1 > 5 → false) → false.
			// id3: flag=0 → left false → false.
			expect(rows).to.deep.equal([
				{ id: 1, r: true },
				{ id: 2, r: false },
				{ id: 3, r: false },
			]);
		});
	});

	describe('emit gate: only subquery RHS defers', () => {
		beforeEach(async () => {
			db.createScalarFunction('sidefx', { numArgs: 0 }, () => 1);
			await db.exec('create table c (id integer primary key, k integer)');
			await db.exec('insert into c values (1, 1), (2, 2)');
		});

		const programOf = (sql: string): string => dumpProgram(db, sql);

		it('a trivial two-column AND stays on the eager path (no callback)', () => {
			const prog = programOf('select (c.k = 1 and c.k = 2) as r from c');
			expect(prog, 'eager logical op expected').to.contain('(logical)');
			expect(prog, 'trivial operands must not defer').to.not.contain('short-circuit');
		});

		it('an AND whose RHS contains a subquery emits the short-circuit callback', () => {
			const prog = programOf('select (c.k = 1 and (select sidefx()) = 1) as r from c');
			expect(prog, 'subquery RHS must defer').to.contain('logical short-circuit');
			expect(prog, 'deferred RHS becomes its own sub-program').to.contain('SUB-PROGRAMS');
		});

		it('XOR never defers even with a subquery operand (both operands always required)', () => {
			const prog = programOf('select (c.k = 1 xor (select sidefx()) = 1) as r from c');
			expect(prog, 'XOR stays eager').to.contain('(logical)');
			expect(prog, 'XOR must not short-circuit').to.not.contain('short-circuit');
		});
	});
});

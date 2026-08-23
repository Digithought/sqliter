import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { CountingMemoryModule } from '../vtab/_counting-memory-module.js';

/**
 * One invariant, checked across every consumer that can stop reading its source early:
 * **an early-stopping consumer pulls exactly as many rows as it needs, and not one more.**
 *
 * Each case drives a table backed by `CountingMemoryModule`, whose `rowCounts` records
 * rows actually pulled out of `query()` — the engine-to-module boundary, so nothing
 * above it can fake the number. The assertion is an exact equality, not a bound: a
 * consumer that reads one row past its last needed one is the defect this pins
 * (`bug-limit-reads-one-row-too-many`, where every `LIMIT n` read `n + 1`).
 *
 * Written against the consumers as a SET rather than against `LIMIT` alone, because the
 * property is what should keep being true — a new early-stopping operator belongs in
 * the table below.
 *
 * Deliberately absent: `OrdinalSlice`. It is unreachable from the memory backend, which
 * defers `supportsOrdinalSeek` (see the TODO in `src/vtab/memory/module.ts`), so there
 * is no honest way to drive it here. Its own early-stop shape is covered by the
 * emitter's streaming guard in `src/runtime/emit/ordinal-slice.ts`.
 */
describe('early-stop consumption', () => {
	let db: Database;
	let mod: CountingMemoryModule;

	/** `counting` holds k = 1..6 — enough rows that "stopped early" and "drained" differ. */
	const ROW_COUNT = 6;

	beforeEach(async () => {
		db = new Database();
		mod = new CountingMemoryModule();
		db.registerModule('countmem', mod);
		await db.exec('create table counting (k integer primary key) using countmem()');
		await db.exec(`insert into counting values ${Array.from({ length: ROW_COUNT }, (_, i) => `(${i + 1})`).join(', ')}`);
		// `probe` is a plain memory table so only `counting` shows up in the row counts.
		await db.exec('create table probe (id integer primary key, x integer)');
		await db.exec('insert into probe values (1, 3)');
	});

	afterEach(async () => {
		await db.close();
	});

	/** Drain `sql` and report how many rows it pulled out of `counting`. */
	async function pulled(sql: string): Promise<number> {
		mod.rowCounts.clear();
		for await (const _ of db.eval(sql)) { /* drain — the count is only complete once drained */ }
		return mod.rowCounts.get('counting') ?? 0;
	}

	/** Every row `sql` returns, so a case can prove it stopped early AND stayed correct. */
	async function rows(sql: string): Promise<Record<string, unknown>[]> {
		const out: Record<string, unknown>[] = [];
		for await (const r of db.eval(sql)) out.push(r as Record<string, unknown>);
		return out;
	}

	/**
	 * Each entry: the consumer, and the exact number of rows it may pull. Every expected
	 * count is below `ROW_COUNT`, so "drained the table" fails every one of them.
	 */
	const CASES: Array<{ what: string; sql: string; expected: number }> = [
		{ what: 'LIMIT stops on the last row it emits', sql: 'select k from counting limit 2', expected: 2 },
		{ what: 'LIMIT with OFFSET pulls offset + limit', sql: 'select k from counting limit 2 offset 1', expected: 3 },
		{ what: 'LIMIT 0 never touches the source', sql: 'select k from counting limit 0', expected: 0 },
		{ what: 'EXISTS stops on the first row', sql: 'select exists (select 1 from counting) as e', expected: 1 },
		{
			// Correlated, so the IN stays on the streaming probe rather than the
			// build-a-set path (see the contrast case below). The subquery's predicate
			// references only the outer row, so it does not restrict `counting` itself —
			// the 3 pulls are the short-circuit on the matching row, not a pushed-down filter.
			what: 'correlated IN stops on the matching row',
			sql: 'select p.id from probe p where p.x in (select k from counting where p.x > 0)',
			expected: 3,
		},
		{
			what: 'a scalar subquery with LIMIT 1 pulls one row',
			sql: 'select (select k from counting order by k limit 1) as first_k',
			expected: 1,
		},
	];

	for (const { what, sql, expected } of CASES) {
		it(`${what} — pulls exactly ${expected}`, async () => {
			expect(await pulled(sql), `wrong row count for: ${sql}`).to.equal(expected);
		});
	}

	it('an early stop does not change the answer', async () => {
		expect(await rows('select k from counting limit 2')).to.deep.equal([{ k: 1 }, { k: 2 }]);
		expect(await rows('select k from counting limit 2 offset 1')).to.deep.equal([{ k: 2 }, { k: 3 }]);
		expect(await rows('select k from counting limit 0')).to.deep.equal([]);
		expect(await rows('select exists (select 1 from counting) as e')).to.deep.equal([{ e: true }]);
		expect(await rows('select p.id from probe p where p.x in (select k from counting where p.x > 0)'))
			.to.deep.equal([{ id: 1 }]);
	});

	it('an UNCORRELATED IN drains its source once, by design — not an early-stop case', async () => {
		// The contrast that keeps the correlated case above honest. An uncorrelated,
		// read-only IN source is materialized into a lookup set once per execution
		// (`runSetProbe` in `src/runtime/emit/subquery.ts`), which necessarily reads
		// every row. That is a build, not an over-read: do not "fix" it to 3.
		expect(await pulled('select 1 as one where 3 in (select k from counting)')).to.equal(ROW_COUNT);
	});

	it('a LIMIT over a writing source keeps driving the writes after the limit', async () => {
		// The one place the invariant deliberately does NOT apply. A DML subtree under a
		// LIMIT runs to completion — same full-drain rule the scalar / IN / EXISTS paths
		// apply to a writing inner. Pinned here next to the early-stop cases so the two
		// rules are read together; the end-to-end row counts live in
		// `test/logic/01.9.1-limit-over-dml-subquery.sqllogic`.
		await db.exec('create table dst (k integer primary key)');
		const returned = await rows('select * from (insert into dst select k from counting returning k) limit 1');
		expect(returned, 'the LIMIT still caps what the query returns').to.have.lengthOf(1);
		expect(await rows('select count(*) as n from dst'), 'every row was still written')
			.to.deep.equal([{ n: ROW_COUNT }]);
	});
});

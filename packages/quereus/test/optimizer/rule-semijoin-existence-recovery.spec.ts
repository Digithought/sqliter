import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { DEFAULT_TUNING } from '../../src/planner/optimizer.js';
import type { SqlValue } from '../../src/common/types.js';

type ResultRow = Record<string, SqlValue>;

interface PlanRow {
	node_type: string;
	op: string;
	detail: string;
	properties: string | null;
	physical: string | null;
}

const JOIN_OPS = new Set([
	'JOIN',
	'HASHJOIN',
	'MERGEJOIN',
	'NESTEDLOOPJOIN',
	'BLOOMJOIN',
	'ASOFSCAN',
]);

const PHYSICAL_JOIN_OPS = new Set(['HASHJOIN', 'MERGEJOIN', 'BLOOMJOIN']);

async function planRows(db: Database, sql: string): Promise<PlanRow[]> {
	const rows: PlanRow[] = [];
	for await (const r of db.eval(
		'SELECT node_type, op, detail, properties, physical FROM query_plan(?)',
		[sql],
	)) {
		rows.push(r as unknown as PlanRow);
	}
	return rows;
}

function joinCount(rows: readonly PlanRow[]): number {
	return rows.filter(r => JOIN_OPS.has(r.op)).length;
}

function hasPhysicalJoin(rows: readonly PlanRow[]): boolean {
	return rows.some(r => PHYSICAL_JOIN_OPS.has(r.op));
}

/** Existence-flag descriptors on the (logical) JoinNode in the optimized plan. */
function joinExistence(rows: readonly PlanRow[]): string[] | undefined {
	const join = rows.find(r => r.op === 'JOIN' && r.properties);
	if (!join?.properties) return undefined;
	const props = JSON.parse(join.properties) as { existence?: string[] };
	return props.existence;
}

/** joinType of the first join op carrying properties (semi/anti/left/inner/…). */
function joinTypeOf(rows: readonly PlanRow[]): string | undefined {
	const join = rows.find(r => JOIN_OPS.has(r.op) && r.properties);
	if (!join?.properties) return undefined;
	return (JSON.parse(join.properties) as { joinType?: string }).joinType;
}

async function results(db: Database, sql: string): Promise<ResultRow[]> {
	const rows: ResultRow[] = [];
	for await (const r of db.eval(sql)) rows.push(r);
	return rows;
}

/**
 * Baseline: run `sql` with ONLY the recovery rule disabled, so the flag-bearing
 * nested-loop left join survives and `where flag` filters the appended boolean.
 * Every recovered shape must return byte-identical rows to this baseline.
 */
async function resultsNoRecovery(db: Database, sql: string): Promise<ResultRow[]> {
	const base = db.optimizer.tuning;
	db.optimizer.updateTuning({
		...base,
		disabledRules: new Set([...(base.disabledRules ?? []), 'semijoin-existence-recovery']),
	});
	try {
		return await results(db, sql);
	} finally {
		db.optimizer.updateTuning(base);
	}
}

/**
 * Stronger baseline: disable BOTH existence-recovery rules so the flag-bearing
 * nested-loop left join survives even where the inner fallback would otherwise
 * fire (a positive probe with a right column demanded, or over a fan-out R). Used
 * by those cases, where `resultsNoRecovery` (semi-only disabled) would itself be
 * inner-recovered.
 */
async function resultsNoEitherRecovery(db: Database, sql: string): Promise<ResultRow[]> {
	const base = db.optimizer.tuning;
	db.optimizer.updateTuning({
		...base,
		disabledRules: new Set([
			...(base.disabledRules ?? []),
			'semijoin-existence-recovery',
			'inner-join-existence-recovery',
		]),
	});
	try {
		return await results(db, sql);
	} finally {
		db.optimizer.updateTuning(base);
	}
}

/**
 * Strongest baseline: disable ALL THREE existence-recovery rules — both Project
 * anchors AND the new `semijoin-existence-recovery-aggregate`. Used by the
 * aggregate-anchor cases, where neither `resultsNoRecovery` nor
 * `resultsNoEitherRecovery` disables the aggregate rule, so they would themselves
 * be aggregate-recovered (a near-tautology). This yields the genuine flag-bearing
 * nested-loop left-join baseline that every recovered aggregate shape must match.
 */
async function resultsNoAnyRecovery(db: Database, sql: string): Promise<ResultRow[]> {
	const base = db.optimizer.tuning;
	db.optimizer.updateTuning({
		...base,
		disabledRules: new Set([
			...(base.disabledRules ?? []),
			'semijoin-existence-recovery',
			'inner-join-existence-recovery',
			'semijoin-existence-recovery-aggregate',
		]),
	});
	try {
		return await results(db, sql);
	} finally {
		db.optimizer.updateTuning(base);
	}
}

describe('ruleSemijoinExistenceRecovery', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	// FK→PK, NOT NULL: a recovered semi folds to L; a recovered anti folds to Empty.
	async function setupFkOrders(): Promise<void> {
		await db.exec(
			'create table customers (id integer primary key, name text, region text) using memory',
		);
		await db.exec(
			'create table orders (order_id integer primary key, customer_id integer not null references customers(id), total real) using memory',
		);
		await db.exec("insert into customers values (1, 'Acme', 'EU'), (2, 'Beta', 'US')");
		await db.exec('insert into orders values (10, 1, 99.0), (11, 2, 49.5), (12, 1, 12.0)');
	}

	// FK→PK, NULLABLE: a recovered semi folds to Filter(L, fk IS NOT NULL); a
	// recovered anti does NOT fold (NULL FK rows survive) — stays a physical anti.
	async function setupNullableFk(): Promise<void> {
		await db.exec('create table parent (pid integer primary key, pname text) using memory');
		await db.exec(
			'create table child (cid integer primary key, pref integer null references parent(pid), cval integer) using memory',
		);
		await db.exec("insert into parent values (1, 'P1'), (2, 'P2')");
		await db.exec('insert into child values (10, 1, 100), (20, null, 200), (30, 2, 300), (40, null, 400)');
	}

	// Right side NOT unique on the join column: cc=1 matches THREE fparent rows
	// (pp=1), cc=2 matches none. A plain `left join … where flag` FANS OUT (K rows
	// per matched left row), so a semi rewrite (1 row per left) would be UNSOUND.
	async function setupFanOut(): Promise<void> {
		await db.exec('create table fchild (cc integer primary key) using memory');
		await db.exec('create table fparent (id integer primary key, pp integer) using memory');
		await db.exec('insert into fchild values (1), (2)');
		await db.exec('insert into fparent values (10, 1), (11, 1), (12, 1)');
	}

	// exc→exp with NO declared FK; a known match pattern so flag values are pinned.
	//   cc=1 (pr=1) matches; cc=2 (pr=9) no match; cc=3 (pr=2) matches; cc=4 (pr=null) no match
	async function seedExisting(): Promise<void> {
		await db.exec('create table exc (cc integer primary key, pr integer null, cv integer null) using memory');
		await db.exec('create table exp (pp integer primary key, pv integer null) using memory');
		await db.exec('insert into exp values (1, 10), (2, 20)');
		await db.exec('insert into exc values (1, 1, 100), (2, 9, 200), (3, 2, 300), (4, null, 400)');
	}

	describe('semi recovery (where flag)', () => {
		it('recovers a semi join from a probe-only flag (flag gone, physical semi join)', async () => {
			await seedExisting();
			const q =
				'select c.cc as cc from exc c left join exp p on p.pp = c.pr exists right as hasP where hasP order by c.cc';

			const rows = await planRows(db, q);
			expect(joinExistence(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.equal(undefined);
			expect(hasPhysicalJoin(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.equal(true);
			expect(joinTypeOf(rows)).to.equal('semi');

			const out = await results(db, q);
			expect(out.map(r => r.cc)).to.deep.equal([1, 3]);
		});

		it('result equality vs the no-recovery baseline', async () => {
			await seedExisting();
			const q =
				'select c.cc as cc from exc c left join exp p on p.pp = c.pr exists right as hasP where hasP order by c.cc';
			expect(await results(db, q)).to.deep.equal(await resultsNoRecovery(db, q));
		});
	});

	describe('anti recovery (where not flag)', () => {
		it('recovers an anti join from a probe-only negated flag (flag gone, physical anti join)', async () => {
			await seedExisting();
			const q =
				'select c.cc as cc from exc c left join exp p on p.pp = c.pr exists right as hasP where not hasP order by c.cc';

			const rows = await planRows(db, q);
			expect(joinExistence(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.equal(undefined);
			expect(hasPhysicalJoin(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.equal(true);
			expect(joinTypeOf(rows)).to.equal('anti');

			// cc 2 (pr 9, no match) and cc 4 (pr null, no match).
			const out = await results(db, q);
			expect(out.map(r => r.cc)).to.deep.equal([2, 4]);
		});

		it('result equality vs the no-recovery baseline', async () => {
			await seedExisting();
			const q =
				'select c.cc as cc from exc c left join exp p on p.pp = c.pr exists right as hasP where not hasP order by c.cc';
			expect(await results(db, q)).to.deep.equal(await resultsNoRecovery(db, q));
		});
	});

	describe('probe normal forms', () => {
		it('`not not hasP` normalizes to a semi probe', async () => {
			await seedExisting();
			const q =
				'select c.cc as cc from exc c left join exp p on p.pp = c.pr exists right as hasP where not not hasP order by c.cc';

			const rows = await planRows(db, q);
			expect(joinExistence(rows)).to.equal(undefined);
			expect(joinTypeOf(rows)).to.equal('semi');

			const out = await results(db, q);
			expect(out.map(r => r.cc)).to.deep.equal([1, 3]);
			expect(out).to.deep.equal(await resultsNoRecovery(db, q));
		});

		it('`hasP = true` recovers a semi join', async () => {
			await seedExisting();
			const q =
				'select c.cc as cc from exc c left join exp p on p.pp = c.pr exists right as hasP where hasP = true order by c.cc';

			const rows = await planRows(db, q);
			expect(joinExistence(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.equal(undefined);
			expect(joinTypeOf(rows)).to.equal('semi');

			const out = await results(db, q);
			expect(out.map(r => r.cc)).to.deep.equal([1, 3]);
			expect(out).to.deep.equal(await resultsNoRecovery(db, q));
		});

		it('`hasP = false` recovers an anti join', async () => {
			await seedExisting();
			const q =
				'select c.cc as cc from exc c left join exp p on p.pp = c.pr exists right as hasP where hasP = false order by c.cc';

			const rows = await planRows(db, q);
			expect(joinExistence(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.equal(undefined);
			expect(joinTypeOf(rows)).to.equal('anti');

			const out = await results(db, q);
			expect(out.map(r => r.cc)).to.deep.equal([2, 4]);
			expect(out).to.deep.equal(await resultsNoRecovery(db, q));
		});

		// `IS [NOT] TRUE/FALSE` forms over the never-null flag. The `is not …`
		// collapses are exact only because the flag is provably non-null.
		const isTestForms: ReadonlyArray<{ probe: string; polarity: 'semi' | 'anti'; cc: number[] }> = [
			{ probe: 'hasP is true', polarity: 'semi', cc: [1, 3] },
			{ probe: 'hasP is not false', polarity: 'semi', cc: [1, 3] },
			{ probe: 'hasP is false', polarity: 'anti', cc: [2, 4] },
			{ probe: 'hasP is not true', polarity: 'anti', cc: [2, 4] },
		];
		for (const { probe, polarity, cc } of isTestForms) {
			it(`\`${probe}\` recovers ${polarity === 'semi' ? 'a semi' : 'an anti'} join`, async () => {
				await seedExisting();
				const q =
					`select c.cc as cc from exc c left join exp p on p.pp = c.pr exists right as hasP where ${probe} order by c.cc`;

				const rows = await planRows(db, q);
				expect(joinExistence(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.equal(undefined);
				expect(joinTypeOf(rows)).to.equal(polarity);

				const out = await results(db, q);
				expect(out.map(r => r.cc)).to.deep.equal(cc);
				expect(out).to.deep.equal(await resultsNoRecovery(db, q));
			});
		}
	});

	describe('residual AND-conjunct (split, not folded into the join)', () => {
		it('`where hasP and cv > 150` recovers a semi with the residual filter retained', async () => {
			await seedExisting();
			const q =
				'select c.cc as cc from exc c left join exp p on p.pp = c.pr exists right as hasP where hasP and c.cv > 150 order by c.cc';

			const rows = await planRows(db, q);
			expect(joinExistence(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.equal(undefined);
			expect(joinTypeOf(rows)).to.equal('semi');

			// Matched: cc 1 (cv 100) and cc 3 (cv 300). cv > 150 keeps only cc 3.
			const out = await results(db, q);
			expect(out.map(r => r.cc)).to.deep.equal([3]);
			expect(out).to.deep.equal(await resultsNoRecovery(db, q));
		});
	});

	describe('FK-covered cascade (NOT NULL FK)', () => {
		it('semi over a covering NOT-NULL FK folds to L (zero join ops)', async () => {
			await setupFkOrders();
			const q =
				'select order_id from orders left join customers on orders.customer_id = customers.id exists right as hasC where hasC order by order_id';

			const rows = await planRows(db, q);
			expect(joinCount(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.equal(0);

			const out = await results(db, q);
			expect(out.map(r => r.order_id)).to.deep.equal([10, 11, 12]);
			expect(out).to.deep.equal(await resultsNoRecovery(db, q));
		});

		it('anti over a covering NOT-NULL FK folds to Empty (zero rows)', async () => {
			await setupFkOrders();
			const q =
				'select order_id from orders left join customers on orders.customer_id = customers.id exists right as hasC where not hasC order by order_id';

			const rows = await planRows(db, q);
			expect(joinCount(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.equal(0);

			const out = await results(db, q);
			expect(out).to.deep.equal([]);
			expect(out).to.deep.equal(await resultsNoRecovery(db, q));
		});
	});

	describe('FK-covered cascade (NULLABLE FK)', () => {
		it('semi over a covering nullable FK folds to Filter(L, fk IS NOT NULL)', async () => {
			await setupNullableFk();
			const q =
				'select cid from child left join parent on parent.pid = child.pref exists right as hasP where hasP order by cid';

			const rows = await planRows(db, q);
			expect(joinCount(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.equal(0);

			const out = await results(db, q);
			expect(out.map(r => r.cid)).to.deep.equal([10, 30]);
			expect(out).to.deep.equal(await resultsNoRecovery(db, q));
		});

		it('anti over a covering nullable FK does NOT fold — survives as a physical anti join', async () => {
			await setupNullableFk();
			const q =
				'select cid from child left join parent on parent.pid = child.pref exists right as hasP where not hasP order by cid';

			const rows = await planRows(db, q);
			expect(joinExistence(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.equal(undefined);
			expect(joinTypeOf(rows)).to.equal('anti');

			const out = await results(db, q);
			expect(out.map(r => r.cid)).to.deep.equal([20, 40]);
			expect(out).to.deep.equal(await resultsNoRecovery(db, q));
		});
	});

	describe('no-fire rejections (flag retained)', () => {
		it('OR-probe: `where hasP or cv > 150` keeps the flag (truth does not partition rows)', async () => {
			await seedExisting();
			const q =
				'select c.cc as cc from exc c left join exp p on p.pp = c.pr exists right as hasP where hasP or c.cv > 150 order by c.cc';

			const rows = await planRows(db, q);
			expect(joinExistence(rows), 'flag retained on OR-probe').to.deep.equal(['exists right as hasP']);

			const out = await results(db, q);
			expect(out).to.deep.equal(await resultsNoRecovery(db, q));
		});

		it('`where hasP is not null` keeps the flag (constant true over the never-null flag, not a probe)', async () => {
			await seedExisting();
			const q =
				'select c.cc as cc from exc c left join exp p on p.pp = c.pr exists right as hasP where hasP is not null order by c.cc';

			const rows = await planRows(db, q);
			expect(joinExistence(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.deep.equal(['exists right as hasP']);
			expect(joinTypeOf(rows)).to.equal('left');

			// Flag is never null ⇒ the filter is a constant true; all left rows survive.
			const out = await results(db, q);
			expect(out.map(r => r.cc)).to.deep.equal([1, 2, 3, 4]);
			expect(out).to.deep.equal(await resultsNoRecovery(db, q));
		});

		it('`where hasP is null` keeps the flag (constant false over the never-null flag, not a probe)', async () => {
			await seedExisting();
			const q =
				'select c.cc as cc from exc c left join exp p on p.pp = c.pr exists right as hasP where hasP is null order by c.cc';

			const rows = await planRows(db, q);
			expect(joinExistence(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.deep.equal(['exists right as hasP']);
			expect(joinTypeOf(rows)).to.equal('left');

			// Flag is never null ⇒ the filter is a constant false; no rows survive.
			const out = await results(db, q);
			expect(out).to.deep.equal([]);
			expect(out).to.deep.equal(await resultsNoRecovery(db, q));
		});

		it('flag also selected: `select cc, hasP … where hasP` keeps the flag', async () => {
			await seedExisting();
			const q =
				'select c.cc as cc, hasP from exc c left join exp p on p.pp = c.pr exists right as hasP where hasP order by c.cc';

			const rows = await planRows(db, q);
			expect(joinExistence(rows), 'flag retained when selected').to.deep.equal(['exists right as hasP']);

			const out = await results(db, q);
			expect(out).to.deep.equal([
				{ cc: 1, hasP: true },
				{ cc: 3, hasP: true },
			]);
			expect(out).to.deep.equal(await resultsNoRecovery(db, q));
		});

		it('right column demanded: `select cc, p.pv … where hasP` recovers an INNER join (handed off to inner-join-existence-recovery)', async () => {
			await seedExisting();
			// A demanded right column (p.pv) is the demand-SHAPE complement the semi
			// rule abstains on; `inner-join-existence-recovery` now picks it up and
			// rewrites the flag-bearing left join to a plain inner join (flag dropped,
			// both sides kept). Rows stay byte-identical to the baseline.
			const q =
				'select c.cc as cc, p.pv as pv from exc c left join exp p on p.pp = c.pr exists right as hasP where hasP order by c.cc';

			const rows = await planRows(db, q);
			expect(joinExistence(rows), 'flag dropped — recovered as an inner join').to.equal(undefined);
			expect(joinTypeOf(rows)).to.equal('inner');

			// Genuine baseline: disable BOTH recovery rules so the flag-bearing
			// nested-loop left join survives. (`resultsNoRecovery` here disables only
			// the semi rule, leaving the inner rule live — that baseline would itself
			// be inner-recovered, a near-tautology. The strong baseline lives in
			// rule-inner-join-existence-recovery.spec.ts; this asserts it too.)
			const out = await results(db, q);
			expect(out).to.deep.equal([
				{ cc: 1, pv: 10 },
				{ cc: 3, pv: 20 },
			]);
			expect(out).to.deep.equal(await resultsNoEitherRecovery(db, q));
		});

		it('flag sorted on: `… where hasP order by hasP` keeps the flag', async () => {
			await seedExisting();
			const q =
				'select c.cc as cc from exc c left join exp p on p.pp = c.pr exists right as hasP where hasP order by hasP, c.cc';

			const rows = await planRows(db, q);
			expect(joinExistence(rows), 'flag retained when sorted on').to.deep.equal(['exists right as hasP']);

			const out = await results(db, q);
			expect(out).to.deep.equal(await resultsNoRecovery(db, q));
		});

		it('two demanded flags (one probed, one selected): no split, flags retained', async () => {
			await seedExisting();
			const q =
				'select c.cc as cc, hasB from exc c left join exp p on p.pp = c.pr ' +
				'exists right as hasA, exists right as hasB where hasA order by c.cc';

			const rows = await planRows(db, q);
			// hasB is selected (demanded) so it is not pruned; the join keeps both
			// flags and recovery abstains (existence.length !== 1).
			expect(joinExistence(rows)).to.deep.equal(['exists right as hasA', 'exists right as hasB']);

			const out = await results(db, q);
			expect(out).to.deep.equal(await resultsNoRecovery(db, q));
		});

		it('undemanded sibling flag is pruned first, THEN the sole survivor is recovered', async () => {
			await seedExisting();
			// hasA is unused → join-existence-pruning drops it, leaving a SOLE hasB,
			// which this rule then recovers to a semi join in a later applyRules pass.
			const q =
				'select c.cc as cc from exc c left join exp p on p.pp = c.pr ' +
				'exists right as hasA, exists right as hasB where hasB order by c.cc';

			const rows = await planRows(db, q);
			expect(joinExistence(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.equal(undefined);
			expect(joinTypeOf(rows)).to.equal('semi');

			const out = await results(db, q);
			expect(out.map(r => r.cc)).to.deep.equal([1, 3]);
			expect(out).to.deep.equal(await resultsNoRecovery(db, q));
		});
	});

	describe('fan-out guard (non-unique right join column)', () => {
		it('SEMI abstains under fan-out; the inner fallback recovers a fan-out-safe inner join', async () => {
			await setupFanOut();
			// cc=1 matches three fparent rows ⇒ the flag-bearing left join yields THREE
			// rows for cc=1; a semi join would (wrongly) collapse to one, so the SEMI
			// rule abstains on its fan-out guard. `inner-join-existence-recovery` then
			// recovers a plain inner join — which does NOT collapse — keeping all three
			// rows. The result is NOT a `semi` join (joinType is `inner`, flag dropped).
			const q =
				'select c.cc as cc from fchild c left join fparent p on p.pp = c.cc exists right as h where h order by c.cc';

			const rows = await planRows(db, q);
			expect(joinExistence(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.equal(undefined);
			expect(joinTypeOf(rows)).to.equal('inner');

			const out = await results(db, q);
			// All three fanned-out [cc=1] rows survive — the row count a (wrongly)
			// recovered semi join would have collapsed to one.
			expect(out.map(r => r.cc)).to.deep.equal([1, 1, 1]);
			expect(out).to.deep.equal(await resultsNoEitherRecovery(db, q));
		});

		it('SEMI via `is true` also abstains under fan-out and rides the inner fallback', async () => {
			await setupFanOut();
			// `is true` is a SEMI probe just like a bare `where flag`; it must not be
			// (wrongly) collapsed under fan-out either. The SEMI rule abstains and the
			// inner fallback recovers a fan-out-safe inner join keeping all three rows.
			const q =
				'select c.cc as cc from fchild c left join fparent p on p.pp = c.cc exists right as h where h is true order by c.cc';

			const rows = await planRows(db, q);
			expect(joinExistence(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.equal(undefined);
			expect(joinTypeOf(rows)).to.equal('inner');

			const out = await results(db, q);
			expect(out.map(r => r.cc)).to.deep.equal([1, 1, 1]);
			expect(out).to.deep.equal(await resultsNoEitherRecovery(db, q));
		});

		it('ANTI still fires under fan-out (unmatched rows never duplicate)', async () => {
			await setupFanOut();
			const q =
				'select c.cc as cc from fchild c left join fparent p on p.pp = c.cc exists right as h where not h order by c.cc';

			const rows = await planRows(db, q);
			expect(joinExistence(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.equal(undefined);
			expect(joinTypeOf(rows)).to.equal('anti');

			const out = await results(db, q);
			expect(out.map(r => r.cc)).to.deep.equal([2]);
			expect(out).to.deep.equal(await resultsNoRecovery(db, q));
		});
	});

	describe('no-op when disabled', () => {
		it('the flag-bearing nested-loop join survives when the rule is disabled', async () => {
			await seedExisting();
			db.optimizer.updateTuning({
				...DEFAULT_TUNING,
				disabledRules: new Set(['semijoin-existence-recovery']),
			});
			const q =
				'select c.cc as cc from exc c left join exp p on p.pp = c.pr exists right as hasP where hasP';

			const rows = await planRows(db, q);
			expect(hasPhysicalJoin(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.equal(false);
			expect(joinExistence(rows)).to.deep.equal(['exists right as hasP']);
		});
	});

	// The Aggregate-anchored entrypoint (`ruleSemijoinExistenceRecoveryUnderAggregate`):
	// the SAME probe-only recovery for the bare `count(*) … where flag` shape that
	// plans with no enclosing Project. Reuses the outer fixtures (seedExisting /
	// setupFanOut) and `resultsNoAnyRecovery` (the genuine flag-bearing baseline).
	describe('aggregate anchor (ruleSemijoinExistenceRecoveryUnderAggregate)', () => {
		it('`count(*) … where hasP` recovers a semi join; count equals baseline', async () => {
			await seedExisting();
			const q =
				'select count(*) as n from exc c left join exp p on p.pp = c.pr exists right as hasP where hasP';

			const rows = await planRows(db, q);
			expect(joinExistence(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.equal(undefined);
			expect(joinTypeOf(rows)).to.equal('semi');

			const out = await results(db, q);
			expect(out).to.have.lengthOf(1);
			expect(out[0].n).to.equal(2); // cc 1 and cc 3 match
			expect(out).to.deep.equal(await resultsNoAnyRecovery(db, q));
		});

		it('`count(*) … where not hasP` recovers an anti join; count equals baseline', async () => {
			await seedExisting();
			const q =
				'select count(*) as n from exc c left join exp p on p.pp = c.pr exists right as hasP where not hasP';

			const rows = await planRows(db, q);
			expect(joinExistence(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.equal(undefined);
			expect(joinTypeOf(rows)).to.equal('anti');

			const out = await results(db, q);
			expect(out[0].n).to.equal(2); // cc 2 and cc 4 do not match
			expect(out).to.deep.equal(await resultsNoAnyRecovery(db, q));
		});

		it('HAVING above the Aggregate does not block recovery (`having count(*) >= 0`)', async () => {
			await seedExisting();
			// `having count(*) >= 0` is a FilterNode ABOVE the Aggregate referencing only
			// the aggregate output — it never appears in walkChain and must not block.
			const q =
				'select count(*) as n from exc c left join exp p on p.pp = c.pr exists right as hasP where hasP having count(*) >= 0';

			const rows = await planRows(db, q);
			expect(joinExistence(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.equal(undefined);
			expect(joinTypeOf(rows)).to.equal('semi');

			const out = await results(db, q);
			expect(out[0].n).to.equal(2);
			expect(out).to.deep.equal(await resultsNoAnyRecovery(db, q));
		});

		it('flag grouped-on (`… where hasP group by hasP`) retains the flag (stays left)', async () => {
			await seedExisting();
			// The flag is seeded into `demanded` via groupBy, so `demanded.has(flagId)`
			// abstains — the flag is genuinely demanded (grouped on), not a pure probe.
			const q =
				'select hasP, count(*) as n from exc c left join exp p on p.pp = c.pr exists right as hasP where hasP group by hasP';

			const rows = await planRows(db, q);
			expect(joinExistence(rows), 'flag retained when grouped on').to.deep.equal(['exists right as hasP']);
			expect(joinTypeOf(rows)).to.equal('left');

			const out = await results(db, q);
			// where hasP keeps the matched rows (all hasP=true) → one group, count 2.
			expect(out).to.deep.equal([{ hasP: true, n: 2 }]);
			expect(out).to.deep.equal(await resultsNoAnyRecovery(db, q));
		});

		it('aggregate over a right column (`count(p.pv) … where hasP`) retains the join (stays left)', async () => {
			await seedExisting();
			// p.pv is a right-side column demanded by the aggregate, so a semi join (left
			// columns only) cannot satisfy it; there is NO aggregate inner fallback in
			// scope, so the join correctly stays a flag-bearing `left` join.
			const q =
				'select count(p.pv) as n from exc c left join exp p on p.pp = c.pr exists right as hasP where hasP';

			const rows = await planRows(db, q);
			expect(joinExistence(rows), 'flag retained when a right column is demanded').to.deep.equal(['exists right as hasP']);
			expect(joinTypeOf(rows)).to.equal('left');

			const out = await results(db, q);
			expect(out[0].n).to.equal(2); // pv 10 (cc1) and pv 20 (cc3)
			expect(out).to.deep.equal(await resultsNoAnyRecovery(db, q));
		});

		it('sibling-prune-then-recover: undemanded `hasA` pruned, sole `hasB` recovered to a semi', async () => {
			await seedExisting();
			// hasA is unused → join-existence-pruning-aggregate drops it, leaving a SOLE
			// hasB which this rule then recovers to a semi join in a later applyRules pass.
			const q =
				'select count(*) as n from exc c left join exp p on p.pp = c.pr ' +
				'exists right as hasA, exists right as hasB where hasB';

			const rows = await planRows(db, q);
			expect(joinExistence(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.equal(undefined);
			expect(joinTypeOf(rows)).to.equal('semi');

			const out = await results(db, q);
			expect(out[0].n).to.equal(2);
			expect(out).to.deep.equal(await resultsNoAnyRecovery(db, q));
		});

		it('two genuinely-demanded flags (one grouped-on, one probed): no split, flags retained', async () => {
			await seedExisting();
			// hasA is grouped on (demanded) and hasB is probed (demanded) — both kept by
			// pruning, so existence.length === 2 and the recovery abstains.
			const q =
				'select hasA, count(*) as n from exc c left join exp p on p.pp = c.pr ' +
				'exists right as hasA, exists right as hasB where hasB group by hasA';

			const rows = await planRows(db, q);
			expect(joinExistence(rows)).to.deep.equal(['exists right as hasA', 'exists right as hasB']);

			const out = await results(db, q);
			expect(out).to.deep.equal(await resultsNoAnyRecovery(db, q));
		});

		describe('fan-out (non-unique right join column)', () => {
			it('positive probe abstains (no inner fallback) — stays left; count is the fanned-out count', async () => {
				await setupFanOut();
				// cc=1 matches THREE fparent rows; a semi join would collapse K→1 (wrong
				// count), so the SEMI rule abstains on its fan-out guard. Unlike the
				// Project anchor there is NO aggregate inner fallback, so the join stays a
				// flag-bearing `left` join and count(*) reflects the fanned-out 3 rows.
				const q =
					'select count(*) as n from fchild c left join fparent p on p.pp = c.cc exists right as h where h';

				const rows = await planRows(db, q);
				expect(joinExistence(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.deep.equal(['exists right as h']);
				expect(joinTypeOf(rows)).to.equal('left');

				const out = await results(db, q);
				expect(out[0].n).to.equal(3); // the fanned-out count, NOT the collapsed 1
				expect(out).to.deep.equal(await resultsNoAnyRecovery(db, q));
			});

			it('anti probe still fires under fan-out (unmatched rows never duplicate)', async () => {
				await setupFanOut();
				const q =
					'select count(*) as n from fchild c left join fparent p on p.pp = c.cc exists right as h where not h';

				const rows = await planRows(db, q);
				expect(joinExistence(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.equal(undefined);
				expect(joinTypeOf(rows)).to.equal('anti');

				const out = await results(db, q);
				expect(out[0].n).to.equal(1); // only cc=2 is unmatched
				expect(out).to.deep.equal(await resultsNoAnyRecovery(db, q));
			});
		});

		it('residual AND-conjunct retained below the Aggregate (`where hasP and cv > 150`)', async () => {
			await seedExisting();
			// The probe is split out (semi recovered); the residual `cv > 150` is rebuilt
			// as a Filter below the Aggregate by rebuildChainStrippingProbe.
			const q =
				'select count(*) as n from exc c left join exp p on p.pp = c.pr exists right as hasP where hasP and c.cv > 150';

			const rows = await planRows(db, q);
			expect(joinExistence(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.equal(undefined);
			expect(joinTypeOf(rows)).to.equal('semi');

			const out = await results(db, q);
			expect(out[0].n).to.equal(1); // matched cc 1 (cv 100) / cc 3 (cv 300); cv > 150 keeps cc 3
			expect(out).to.deep.equal(await resultsNoAnyRecovery(db, q));
		});
	});
});

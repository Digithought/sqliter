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
 * Baseline: run `sql` with ONLY the inner-recovery rule disabled, so the
 * flag-bearing nested-loop left join survives and `where flag` filters the
 * appended boolean. Every recovered inner-join shape must return byte-identical
 * rows to this baseline.
 */
async function resultsNoRecovery(db: Database, sql: string): Promise<ResultRow[]> {
	const base = db.optimizer.tuning;
	db.optimizer.updateTuning({
		...base,
		disabledRules: new Set([...(base.disabledRules ?? []), 'inner-join-existence-recovery']),
	});
	try {
		return await results(db, sql);
	} finally {
		db.optimizer.updateTuning(base);
	}
}

/**
 * Stronger baseline: disable BOTH existence-recovery rules so the flag-bearing
 * nested-loop left join survives. Needed for the no-right-col fan-out cases —
 * disabling only the inner rule leaves the semi rule live, and although it abstains
 * on its own fan-out guard (so the default `resultsNoRecovery` would coincidentally
 * agree), disabling both states the genuine nested-loop+flag baseline explicitly
 * (mirroring the right-col inner test in the sibling semi spec).
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

describe('ruleInnerJoinExistenceRecovery', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	// exc→exp with NO declared FK; a known match pattern so flag values are pinned.
	//   cc=1 (pr=1) matches pv=10; cc=2 (pr=9) no match; cc=3 (pr=2) matches pv=20; cc=4 (pr=null) no match
	async function seedExisting(): Promise<void> {
		await db.exec('create table exc (cc integer primary key, pr integer null, cv integer null) using memory');
		await db.exec('create table exp (pp integer primary key, pv integer null) using memory');
		await db.exec('insert into exp values (1, 10), (2, 20)');
		await db.exec('insert into exc values (1, 1, 100), (2, 9, 200), (3, 2, 300), (4, null, 400)');
	}

	// Right side NOT unique on the join column: cc=1 matches THREE fparent rows
	// (pp=1), cc=2 matches none. A plain `left join … where flag` FANS OUT (K rows
	// per matched left row); a semi rewrite would (wrongly) collapse to one. An
	// INNER join keeps all K — the headline capability the semi rule cannot do.
	// Deliberately TINY (2×3): nested-loop cost stays below hash here, so physical
	// selection leaves a nested-loop inner join — this fixture isolates the
	// joinType-flip + row-equality, not the physical-join payoff.
	async function setupFanOut(): Promise<void> {
		await db.exec('create table fchild (cc integer primary key) using memory');
		await db.exec('create table fparent (id integer primary key, pp integer) using memory');
		await db.exec('insert into fchild values (1), (2)');
		await db.exec('insert into fparent values (10, 1), (11, 1), (12, 1)');
	}

	// Larger fan-out (no right column demanded): 8 left rows, each matching 3 right
	// rows (24 right rows), the right side non-unique on the join column. Sized so
	// hash cost < nested-loop cost ⇒ after the inner fallback drops the flag,
	// `join-physical-selection` picks a physical join. This is the fan-out payoff the
	// flag-bearing nested-loop left join pinned shut.
	async function setupLargeFanOut(): Promise<void> {
		await db.exec('create table gchild (cc integer primary key) using memory');
		await db.exec('create table gparent (id integer primary key, pp integer) using memory');
		await db.exec('insert into gchild values (1), (2), (3), (4), (5), (6), (7), (8)');
		// each cc in 1..8 matches three gparent rows (ids offset by 0/100/200).
		const vals: string[] = [];
		for (let cc = 1; cc <= 8; cc++) {
			vals.push(`(${cc}, ${cc})`, `(${100 + cc}, ${cc})`, `(${200 + cc}, ${cc})`);
		}
		await db.exec(`insert into gparent values ${vals.join(', ')}`);
	}

	describe('inner recovery (where flag + right column demanded)', () => {
		it('recovers an inner join from a probe-only flag with a right column demanded (flag gone, joinType inner)', async () => {
			await seedExisting();
			const q =
				'select c.cc as cc, p.pv as pv from exc c left join exp p on p.pp = c.pr exists right as hasP where hasP order by c.cc';

			const rows = await planRows(db, q);
			expect(joinExistence(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.equal(undefined);
			expect(joinTypeOf(rows)).to.equal('inner');

			const out = await results(db, q);
			expect(out).to.deep.equal([
				{ cc: 1, pv: 10 },
				{ cc: 3, pv: 20 },
			]);
			expect(out).to.deep.equal(await resultsNoRecovery(db, q));
		});

		it('re-enables physical join selection (the flag no longer pins nested-loop)', async () => {
			await seedExisting();
			const q =
				'select c.cc as cc, p.pv as pv from exc c left join exp p on p.pp = c.pr exists right as hasP where hasP order by c.cc';

			const rows = await planRows(db, q);
			expect(hasPhysicalJoin(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.equal(true);
		});

		it('result equality vs the no-recovery (nested-loop+flag) baseline', async () => {
			await seedExisting();
			const q =
				'select c.cc as cc, p.pv as pv from exc c left join exp p on p.pp = c.pr exists right as hasP where hasP order by c.cc';
			expect(await results(db, q)).to.deep.equal(await resultsNoRecovery(db, q));
		});
	});

	describe('probe normal forms (all positive ⇒ inner)', () => {
		const forms: ReadonlyArray<string> = ['hasP', 'hasP = true', 'hasP is true', 'hasP is not false', 'not not hasP'];
		for (const probe of forms) {
			it(`\`where ${probe}\` recovers an inner join`, async () => {
				await seedExisting();
				const q =
					`select c.cc as cc, p.pv as pv from exc c left join exp p on p.pp = c.pr exists right as hasP where ${probe} order by c.cc`;

				const rows = await planRows(db, q);
				expect(joinExistence(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.equal(undefined);
				expect(joinTypeOf(rows)).to.equal('inner');

				const out = await results(db, q);
				expect(out).to.deep.equal([
					{ cc: 1, pv: 10 },
					{ cc: 3, pv: 20 },
				]);
				expect(out).to.deep.equal(await resultsNoRecovery(db, q));
			});
		}
	});

	describe('fan-out + right column (the case the semi rule cannot handle)', () => {
		it('keeps all K fanned-out rows (no collapse) — inner join over a non-unique right', async () => {
			await setupFanOut();
			// cc=1 matches three fparent rows (id 10,11,12). The semi rule abstains
			// (fan-out guard AND right column demanded); the inner rule fires and keeps
			// every matched pair, byte-identical to the baseline.
			const q =
				'select c.cc as cc, p.id as pid from fchild c left join fparent p on p.pp = c.cc exists right as h where h order by c.cc, pid';

			const rows = await planRows(db, q);
			expect(joinExistence(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.equal(undefined);
			expect(joinTypeOf(rows)).to.equal('inner');

			const out = await results(db, q);
			expect(out).to.deep.equal([
				{ cc: 1, pid: 10 },
				{ cc: 1, pid: 11 },
				{ cc: 1, pid: 12 },
			]);
			expect(out).to.deep.equal(await resultsNoRecovery(db, q));
		});
	});

	describe('fan-out fallback (NO right column demanded — the leftover case the semi rule abstains on)', () => {
		it('keeps all K fanned-out rows — inner recovery even with no right column demanded', async () => {
			await setupFanOut();
			// No right column is selected (only c.cc), but cc=1 matches three fparent
			// rows. The semi rule abstains on its fan-out guard (a semi join would
			// collapse the three to one); the inner fallback fires and keeps all three.
			const q =
				'select c.cc as cc from fchild c left join fparent p on p.pp = c.cc exists right as h where h order by c.cc';

			const rows = await planRows(db, q);
			expect(joinExistence(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.equal(undefined);
			expect(joinTypeOf(rows)).to.equal('inner');

			const out = await results(db, q);
			expect(out.map(r => r.cc)).to.deep.equal([1, 1, 1]);
			expect(out).to.deep.equal(await resultsNoEitherRecovery(db, q));
		});

		it('SEMI probe via `is true` over fan-out rides the same inner fallback', async () => {
			await setupFanOut();
			const q =
				'select c.cc as cc from fchild c left join fparent p on p.pp = c.cc exists right as h where h is true order by c.cc';

			const rows = await planRows(db, q);
			expect(joinExistence(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.equal(undefined);
			expect(joinTypeOf(rows)).to.equal('inner');

			const out = await results(db, q);
			expect(out.map(r => r.cc)).to.deep.equal([1, 1, 1]);
			expect(out).to.deep.equal(await resultsNoEitherRecovery(db, q));
		});

		it('negative probe `where not h` over fan-out stays a left join (anti via the semi rule)', async () => {
			await setupFanOut();
			// Anti is fan-out-immune (unmatched rows never duplicate) and the inner
			// fallback only fires on a positive probe — so this is recovered to an ANTI
			// join by the semi rule, NOT an inner join, and the flag is dropped there.
			const q =
				'select c.cc as cc from fchild c left join fparent p on p.pp = c.cc exists right as h where not h order by c.cc';

			const rows = await planRows(db, q);
			expect(joinExistence(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.equal(undefined);
			expect(joinTypeOf(rows), 'anti recovered by the semi rule, not inner').to.equal('anti');

			const out = await results(db, q);
			expect(out.map(r => r.cc)).to.deep.equal([2]);
			expect(out).to.deep.equal(await resultsNoEitherRecovery(db, q));
		});

		it('re-enables physical join selection on a fan-out sized so hash < nested-loop (the payoff)', async () => {
			await setupLargeFanOut();
			// 8 left × 24 right, right non-unique on the join column. Dropping the flag
			// re-opens join-physical-selection, which picks a physical join (hash/merge)
			// because nested-loop cost is quadratic on these counts. This is the win the
			// flag-bearing nested-loop left join pinned shut.
			const q =
				'select c.cc as cc from gchild c left join gparent p on p.pp = c.cc exists right as h where h order by c.cc';

			const rows = await planRows(db, q);
			expect(joinExistence(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.equal(undefined);
			expect(joinTypeOf(rows)).to.equal('inner');
			expect(hasPhysicalJoin(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.equal(true);

			const out = await results(db, q);
			// 8 distinct cc, each fanning out to three rows = 24 rows, byte-identical to
			// the flag-bearing nested-loop baseline.
			expect(out.length).to.equal(24);
			expect(out).to.deep.equal(await resultsNoEitherRecovery(db, q));
		});
	});

	describe('residual AND-conjunct (split, retained above the inner join)', () => {
		it('`where hasP and cv > 150` recovers an inner join with the residual filter retained', async () => {
			await seedExisting();
			const q =
				'select c.cc as cc, p.pv as pv from exc c left join exp p on p.pp = c.pr exists right as hasP where hasP and c.cv > 150 order by c.cc';

			const rows = await planRows(db, q);
			expect(joinExistence(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.equal(undefined);
			expect(joinTypeOf(rows)).to.equal('inner');

			// Matched: cc 1 (cv 100) and cc 3 (cv 300). cv > 150 keeps only cc 3.
			const out = await results(db, q);
			expect(out).to.deep.equal([{ cc: 3, pv: 20 }]);
			expect(out).to.deep.equal(await resultsNoRecovery(db, q));
		});
	});

	describe('no-fire rejections', () => {
		it('negative probe `where not hasP` + right column ⇒ stays a left join (anti rows have a NULL right side)', async () => {
			await seedExisting();
			const q =
				'select c.cc as cc, p.pv as pv from exc c left join exp p on p.pp = c.pr exists right as hasP where not hasP order by c.cc';

			const rows = await planRows(db, q);
			expect(joinExistence(rows), 'flag retained on a negative probe').to.deep.equal(['exists right as hasP']);
			expect(joinTypeOf(rows)).to.equal('left');

			// Unmatched rows: cc 2 (pr 9) and cc 4 (pr null), both with NULL pv.
			const out = await results(db, q);
			expect(out).to.deep.equal([
				{ cc: 2, pv: null },
				{ cc: 4, pv: null },
			]);
			expect(out).to.deep.equal(await resultsNoRecovery(db, q));
		});

		it('no right column demanded + UNIQUE right ⇒ semijoin-existence-recovery wins (semi, NOT inner)', async () => {
			await seedExisting();
			// exp.pp is the PK, so R is unique on the join column (≤1 match per left
			// row). The inner fallback's gate (`!rightColDemanded && rightMatchesAtMostOne`)
			// defers to the leaner semi join here — locking the two rules' disjointness on
			// the unique-R half (the fan-out half is covered by the fan-out fallback block).
			const q =
				'select c.cc as cc from exc c left join exp p on p.pp = c.pr exists right as hasP where hasP order by c.cc';

			const rows = await planRows(db, q);
			expect(joinExistence(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.equal(undefined);
			expect(joinTypeOf(rows), 'semi rule wins the unique-R/no-right-col half').to.equal('semi');

			const out = await results(db, q);
			expect(out.map(r => r.cc)).to.deep.equal([1, 3]);
		});

		it('flag also selected: `select cc, hasP, p.pv … where hasP` keeps the flag', async () => {
			await seedExisting();
			const q =
				'select c.cc as cc, hasP, p.pv as pv from exc c left join exp p on p.pp = c.pr exists right as hasP where hasP order by c.cc';

			const rows = await planRows(db, q);
			expect(joinExistence(rows), 'flag retained when selected').to.deep.equal(['exists right as hasP']);
			expect(joinTypeOf(rows)).to.equal('left');

			const out = await results(db, q);
			expect(out).to.deep.equal([
				{ cc: 1, hasP: true, pv: 10 },
				{ cc: 3, hasP: true, pv: 20 },
			]);
			expect(out).to.deep.equal(await resultsNoRecovery(db, q));
		});

		it('OR-probe: `where hasP or cv > 150` keeps the flag (not a probe shape)', async () => {
			await seedExisting();
			const q =
				'select c.cc as cc, p.pv as pv from exc c left join exp p on p.pp = c.pr exists right as hasP where hasP or c.cv > 150 order by c.cc';

			const rows = await planRows(db, q);
			expect(joinExistence(rows), 'flag retained on OR-probe').to.deep.equal(['exists right as hasP']);
			expect(joinTypeOf(rows)).to.equal('left');

			const out = await results(db, q);
			expect(out).to.deep.equal(await resultsNoRecovery(db, q));
		});

		it('`where hasP is not null` keeps the flag (constant over the never-null flag, not a probe)', async () => {
			await seedExisting();
			const q =
				'select c.cc as cc, p.pv as pv from exc c left join exp p on p.pp = c.pr exists right as hasP where hasP is not null order by c.cc';

			const rows = await planRows(db, q);
			expect(joinExistence(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.deep.equal(['exists right as hasP']);
			expect(joinTypeOf(rows)).to.equal('left');

			const out = await results(db, q);
			expect(out).to.deep.equal(await resultsNoRecovery(db, q));
		});

		it('two demanded flags (one probed, one selected): no conversion, flags retained', async () => {
			await seedExisting();
			const q =
				'select c.cc as cc, p.pv as pv, hasB from exc c left join exp p on p.pp = c.pr ' +
				'exists right as hasA, exists right as hasB where hasA order by c.cc';

			const rows = await planRows(db, q);
			expect(joinExistence(rows)).to.deep.equal(['exists right as hasA', 'exists right as hasB']);
			expect(joinTypeOf(rows)).to.equal('left');

			const out = await results(db, q);
			expect(out).to.deep.equal(await resultsNoRecovery(db, q));
		});
	});

	describe('star expansion', () => {
		it('`select c.*, p.pv … where hasP` recovers an inner join (qualified c.* omits the appended flag, p.pv demands a right col)', async () => {
			await seedExisting();
			const q =
				'select c.*, p.pv as pv from exc c left join exp p on p.pp = c.pr exists right as hasP where hasP order by c.cc';

			const rows = await planRows(db, q);
			expect(joinExistence(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.equal(undefined);
			expect(joinTypeOf(rows)).to.equal('inner');

			const out = await results(db, q);
			expect(out).to.deep.equal([
				{ cc: 1, pr: 1, cv: 100, pv: 10 },
				{ cc: 3, pr: 2, cv: 300, pv: 20 },
			]);
			expect(out).to.deep.equal(await resultsNoRecovery(db, q));
		});

		it('unqualified `select * … where hasP` keeps the flag (`*` expands the join-appended flag, so it is demanded — and the user is selecting it)', async () => {
			await seedExisting();
			// `buildStarProjections` expands `source.getAttributes()`, which for a
			// flag-bearing join INCLUDES the appended existence flag. So `*` demands the
			// flag, `!demanded.has(flagId)` fails, and the rule correctly abstains —
			// the flag must survive because the user asked for it via `*`.
			const q =
				'select * from exc c left join exp p on p.pp = c.pr exists right as hasP where hasP order by c.cc';

			const rows = await planRows(db, q);
			expect(joinExistence(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.deep.equal(['exists right as hasP']);
			expect(joinTypeOf(rows)).to.equal('left');

			const out = await results(db, q);
			expect(out).to.deep.equal([
				{ cc: 1, pr: 1, cv: 100, pp: 1, pv: 10, hasP: true },
				{ cc: 3, pr: 2, cv: 300, pp: 2, pv: 20, hasP: true },
			]);
			expect(out).to.deep.equal(await resultsNoRecovery(db, q));
		});
	});

	describe('cascade with join-existence-pruning', () => {
		it('undemanded sibling flag is pruned first, THEN the sole survivor + right col recovers an inner join', async () => {
			await seedExisting();
			// hasA is unused → join-existence-pruning drops it, leaving a SOLE hasB,
			// which (with p.pv demanded) this rule recovers to an inner join.
			const q =
				'select c.cc as cc, p.pv as pv from exc c left join exp p on p.pp = c.pr ' +
				'exists right as hasA, exists right as hasB where hasB order by c.cc';

			const rows = await planRows(db, q);
			expect(joinExistence(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.equal(undefined);
			expect(joinTypeOf(rows)).to.equal('inner');

			const out = await results(db, q);
			expect(out).to.deep.equal([
				{ cc: 1, pv: 10 },
				{ cc: 3, pv: 20 },
			]);
			expect(out).to.deep.equal(await resultsNoRecovery(db, q));
		});
	});

	describe('no-op when disabled', () => {
		it('the flag-bearing nested-loop left join survives when the rule is disabled', async () => {
			await seedExisting();
			db.optimizer.updateTuning({
				...DEFAULT_TUNING,
				disabledRules: new Set(['inner-join-existence-recovery']),
			});
			const q =
				'select c.cc as cc, p.pv as pv from exc c left join exp p on p.pp = c.pr exists right as hasP where hasP';

			const rows = await planRows(db, q);
			expect(hasPhysicalJoin(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.equal(false);
			expect(joinExistence(rows)).to.deep.equal(['exists right as hasP']);
			expect(joinTypeOf(rows)).to.equal('left');
		});
	});
});

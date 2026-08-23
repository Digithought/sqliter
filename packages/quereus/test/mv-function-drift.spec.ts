/**
 * Maintenance-side body-function drift.
 *
 * A materialized view's backing rows are produced by a maintenance plan compiled ONCE, at
 * registration, against the function registrations live at that moment. While that one
 * plan keeps running, every backing row was produced the same way — which is what makes
 * the backing trustworthy.
 *
 * Some operations RE-register the view and so recompile that plan against whatever is
 * registered now: `alter table … rename` (of the view itself, and of a source, through
 * the rename-propagation restore pass) is the reachable one. If the application replaced
 * one of its own functions in between, maintenance would switch to the new implementation
 * while the rows already stored came from the old one — one backing table holding two
 * different functions' answers, with nothing marking which is which.
 *
 * Registration therefore compares the freshly resolved body functions against the
 * previous registration's capture (`derivation.bodyFunctions`) by object identity and
 * marks the view STALE on any difference. Stale means: the read-side rewrite declines
 * (queries recompute from the base tables), row-time maintenance is detached (the backing
 * stops changing rather than changing inconsistently), and `refresh materialized view`
 * is how the rows are re-derived under the new meaning.
 *
 * Detection is by object identity, so it holds WITHIN a session only — a reopen attaches
 * a fresh derivation with no prior capture. See `docs/materialized-views.md` § Function
 * identity.
 */

import { expect } from 'chai';
import { Database } from '../src/core/database.js';
import { createAggregateFunction, createScalarFunction } from '../src/func/registration.js';
import type { SqlValue } from '../src/common/types.js';
import type { MaintainedTableSchema } from '../src/schema/derivation.js';
import { INTEGER_TYPE } from '../src/types/builtin-types.js';
import { detectBodyFunctionDrift } from '../src/planner/analysis/mv-body-functions.js';
import type { FunctionSchema } from '../src/schema/function.js';

async function rows(db: Database, sql: string): Promise<Record<string, unknown>[]> {
	const out: Record<string, unknown>[] = [];
	for await (const r of db.eval(sql)) out.push(r as Record<string, unknown>);
	return out;
}

function getMv(db: Database, name: string): MaintainedTableSchema {
	const mv = db.schemaManager.getMaintainedTable('main', name);
	expect(mv, `materialized view '${name}' exists`).to.not.equal(undefined);
	return mv!;
}

/**
 * Register a deterministic `sum/1` that COUNTS rows instead of summing them — the
 * takeover an application performs when it replaces one of its own functions. Counting is
 * deliberately not summing, so a row produced by the built-in and a row produced by this
 * one are distinguishable by value. It declares a full merge/decode algebra so nothing
 * declines it for a missing one before the identity check is reached.
 */
function registerCountingSum(db: Database): void {
	db.registerFunction(createAggregateFunction(
		{
			name: 'sum', numArgs: 1, initialValue: 0, deterministic: true,
			returnType: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true },
			algebra: {
				merge: (a: number, b: number): number => a + b,
				decode: (stored: SqlValue): number => Number(stored ?? 0),
				decodeExact: true,
			},
		},
		(acc: number, _v: SqlValue): number => acc + 1,
		(acc: number): number => acc,
	));
}

/** A deterministic `bump/1` adding `delta`. Registering it twice with different deltas is
 *  the scalar takeover: same name, same arity, different meaning — and, unlike the
 *  aggregate one above, an unchanged declared result type, so a body over it re-derives a
 *  shape-identical backing. */
function registerBump(db: Database, delta: number): void {
	db.registerFunction(createScalarFunction(
		{ name: 'bump', numArgs: 1, deterministic: true },
		(v: SqlValue): SqlValue => Number(v) + delta,
	));
}

/** Base table + projecting MV over `bump/1`: rows 10, 20 ⇒ 11, 21 under `+1`. */
const SCALAR_DDL = [
	'create table s (id integer primary key, v integer not null)',
	'insert into s (id, v) values (1, 10), (2, 20)',
	'create materialized view ms as select id, bump(v) as b from s',
];

async function buildScalarFixture(db: Database): Promise<void> {
	registerBump(db, 1);
	for (const sql of SCALAR_DDL) await db.exec(sql);
}

/** Base table + grouped MV: groups `k=1` (rows 10, 20) and `k=2` (row 30), so the built-in
 *  sum's per-group answer (30 / 30) differs from the counting takeover's (2 / 1). */
const DDL = [
	'create table t (id integer primary key, k integer not null, x integer not null)',
	'insert into t (id, k, x) values (1, 1, 10), (2, 1, 20), (3, 2, 30)',
	'create materialized view mv as select k, sum(x) as s from t group by k',
];

async function buildFixture(db: Database): Promise<void> {
	for (const sql of DDL) await db.exec(sql);
}

describe('MV maintenance: body-function drift', () => {
	it('renaming the view after a body function was replaced marks it stale', async () => {
		const db = new Database();
		try {
			await buildFixture(db);
			expect(await rows(db, 'select k, s from mv order by k'))
				.to.deep.equal([{ k: 1, s: 30 }, { k: 2, s: 30 }]);

			registerCountingSum(db);
			await db.exec('alter table mv rename to mvr');

			expect(getMv(db, 'mvr').derivation.stale, 'sum/1 no longer resolves to the registration that produced the rows')
				.to.equal(true);
		} finally {
			await db.close();
		}
	});

	it('a query the view covers is computed from the base table, not from the stored rows', async () => {
		const db = new Database();
		try {
			await buildFixture(db);
			registerCountingSum(db);
			await db.exec('alter table mv rename to mvr');

			// The read-side rewrite declines a stale view, so this recomputes from `t` with
			// the NEW sum — per-group ROW COUNTS, not the stored per-group sums.
			expect(await rows(db, 'select k, sum(x) as s from t group by k order by k'))
				.to.deep.equal([{ k: 1, s: 2 }, { k: 2, s: 1 }]);
		} finally {
			await db.close();
		}
	});

	it('the backing does not acquire rows from two different functions', async () => {
		const db = new Database();
		try {
			await buildFixture(db);
			registerCountingSum(db);
			await db.exec('alter table mv rename to mvr');

			// Row-time maintenance is detached, so this write does not touch the backing.
			// Without the drift check the recompiled plan would re-derive group k=2 with the
			// counting sum (s=2) and leave k=1 on the built-in's s=30 — one table, two
			// functions' semantics.
			await db.exec('insert into t (id, k, x) values (4, 2, 5)');
			expect(await rows(db, 'select k, s from mvr order by k'), 'behind, but every row still the built-in sum')
				.to.deep.equal([{ k: 1, s: 30 }, { k: 2, s: 30 }]);
		} finally {
			await db.close();
		}
	});

	it('REFRESH clears the flag and re-derives every row under the new function', async () => {
		const db = new Database();
		try {
			await buildFixture(db);
			registerCountingSum(db);
			await db.exec('alter table mv rename to mvr');
			await db.exec('insert into t (id, k, x) values (4, 2, 5)');

			await db.exec('refresh materialized view mvr');
			expect(getMv(db, 'mvr').derivation.stale, 'the rebuild re-derived the rows against the live registry')
				.to.equal(false);
			// k=1 holds rows 10, 20; k=2 holds rows 30, 5 — counts of 2 and 2.
			expect(await rows(db, 'select k, s from mvr order by k'))
				.to.deep.equal([{ k: 1, s: 2 }, { k: 2, s: 2 }]);

			// Maintenance re-attached under the new meaning, and stays internally consistent.
			await db.exec('insert into t (id, k, x) values (5, 1, 99)');
			expect(await rows(db, 'select k, s from mvr order by k'))
				.to.deep.equal([{ k: 1, s: 3 }, { k: 2, s: 2 }]);
		} finally {
			await db.close();
		}
	});

	it('renaming a SOURCE table after a replacement leaves the view stale (restore pass honours drift)', async () => {
		const db = new Database();
		try {
			await buildFixture(db);
			registerCountingSum(db);

			// A source rename marks every dependent stale, rewrites their bodies, then tries
			// to restore the provably-unaffected ones live. Drift outranks that restore.
			await db.exec('alter table t rename to t2');
			expect(getMv(db, 'mv').derivation.stale, 'restored live only if the stored rows are still faithful')
				.to.equal(true);
			expect(await rows(db, 'select k, s from mv order by k'))
				.to.deep.equal([{ k: 1, s: 30 }, { k: 2, s: 30 }]);
		} finally {
			await db.close();
		}
	});

	it('a scalar body function replaced before a rename drifts too', async () => {
		const db = new Database();
		try {
			await buildScalarFixture(db);
			expect(await rows(db, 'select id, b from ms order by id'))
				.to.deep.equal([{ id: 1, b: 11 }, { id: 2, b: 21 }]);

			// Same name, same arity, different meaning.
			registerBump(db, 1000);
			await db.exec('alter table ms rename to msr');
			expect(getMv(db, 'msr').derivation.stale).to.equal(true);

			// Backing untouched by the write: no mixing of +1 and +1000 rows.
			await db.exec('insert into s (id, v) values (3, 30)');
			expect(await rows(db, 'select id, b from msr order by id'))
				.to.deep.equal([{ id: 1, b: 11 }, { id: 2, b: 21 }]);

			await db.exec('refresh materialized view msr');
			expect(await rows(db, 'select id, b from msr order by id'))
				.to.deep.equal([{ id: 1, b: 1010 }, { id: 2, b: 1020 }, { id: 3, b: 1030 }]);
		} finally {
			await db.close();
		}
	});

	it('an in-place recompile after a source schema change honours drift', async () => {
		const db = new Database();
		try {
			await buildScalarFixture(db);
			registerBump(db, 1000);

			// `add column` on a source is a change the body does not read and that leaves the
			// MV's derived shape identical, so the schema-change listener normally keeps the
			// view LIVE by recompiling its plan in place — against the new resolution, over
			// rows the old one produced. Drift outranks that keep-live. (The aggregate fixture
			// cannot probe this gate: replacing `sum/1` also shifts the backing's declared
			// column type, so the recompile declines at the earlier shape gate.)
			await db.exec('alter table s add column z integer default 0');
			expect(getMv(db, 'ms').derivation.stale, 'recompiled against a body function that changed meaning')
				.to.equal(true);

			// Maintenance detached, so the backing stays wholly on the `+1` bump.
			await db.exec('insert into s (id, v) values (3, 30)');
			expect(await rows(db, 'select id, b from ms order by id'))
				.to.deep.equal([{ id: 1, b: 11 }, { id: 2, b: 21 }]);
		} finally {
			await db.close();
		}
	});

	it('REFRESH as the FIRST re-registration after a replacement keeps the view live', async () => {
		const db = new Database();
		try {
			await buildFixture(db);
			registerCountingSum(db);

			// No rename in between: this REFRESH is the registration that first sees the new
			// resolution. It re-derived every row from the body against the live registry, so
			// the differing capture is the fix, not the hazard (`backingRecomputed`). Were it
			// treated as drift, registration would release the plan it just built and the
			// `stale = false` immediately after would leave a live-flagged view with NO
			// maintenance — writes silently no longer propagating.
			await db.exec('refresh materialized view mv');
			expect(getMv(db, 'mv').derivation.stale ?? false, 'the rows ARE the new function\'s answers')
				.to.equal(false);
			expect(await rows(db, 'select k, s from mv order by k'))
				.to.deep.equal([{ k: 1, s: 2 }, { k: 2, s: 1 }]);

			// Maintenance is live under the new meaning: k=2 gains a row.
			await db.exec('insert into t (id, k, x) values (4, 2, 5)');
			expect(await rows(db, 'select k, s from mv order by k'))
				.to.deep.equal([{ k: 1, s: 2 }, { k: 2, s: 2 }]);
		} finally {
			await db.close();
		}
	});

	/* ── Regression guards: renaming a maintained table is otherwise routine ─────── */

	it('a rename with NO function change does not mark the view stale', async () => {
		const db = new Database();
		try {
			await buildFixture(db);
			await db.exec('alter table mv rename to mvr');

			expect(getMv(db, 'mvr').derivation.stale ?? false, 'nothing about the body changed meaning')
				.to.equal(false);
			// Maintenance still live, and still on the built-in sum: k=2 goes 30 → 35.
			await db.exec('insert into t (id, k, x) values (4, 2, 5)');
			expect(await rows(db, 'select k, s from mvr order by k'))
				.to.deep.equal([{ k: 1, s: 30 }, { k: 2, s: 35 }]);
		} finally {
			await db.close();
		}
	});

	it('registering an UNRELATED function does not mark the view stale on rename', async () => {
		const db = new Database();
		try {
			await buildFixture(db);
			db.registerFunction(createScalarFunction(
				{ name: 'unrelated', numArgs: 1, deterministic: true },
				(v: SqlValue): SqlValue => v,
			));
			await db.exec('alter table mv rename to mvr');

			expect(getMv(db, 'mvr').derivation.stale ?? false).to.equal(false);
			await db.exec('insert into t (id, k, x) values (4, 2, 5)');
			expect(await rows(db, 'select k, s from mvr order by k'))
				.to.deep.equal([{ k: 1, s: 30 }, { k: 2, s: 35 }]);
		} finally {
			await db.close();
		}
	});

	it('re-registering the SAME function object is not drift', async () => {
		const db = new Database();
		try {
			await buildFixture(db);
			// The built-in `sum/1` schema, handed back to the registry verbatim: same object,
			// so the body still means what it meant when the rows were produced.
			const same = db.schemaManager.findFunction('sum', 1);
			expect(same, 'built-in sum/1 resolves').to.not.equal(undefined);
			db.registerFunction(same!);
			await db.exec('alter table mv rename to mvr');

			expect(getMv(db, 'mvr').derivation.stale ?? false).to.equal(false);
		} finally {
			await db.close();
		}
	});
});

describe('detectBodyFunctionDrift', () => {
	const a = { name: 'f' } as unknown as FunctionSchema;
	const b = { name: 'f' } as unknown as FunctionSchema;

	it('reports nothing for identical captures', () => {
		expect(detectBodyFunctionDrift(new Map([['f/1', a]]), new Map([['f/1', a]]))).to.deep.equal([]);
	});

	it('reports a key that resolves to a different registration', () => {
		expect(detectBodyFunctionDrift(new Map([['f/1', a]]), new Map([['f/1', b]]))).to.deep.equal(['f/1']);
	});

	it('reports a key that resolved before and no longer does', () => {
		expect(detectBodyFunctionDrift(new Map([['f/1', a]]), new Map())).to.deep.equal(['f/1']);
	});

	it('reports a key that resolves now and did not before', () => {
		expect(detectBodyFunctionDrift(new Map(), new Map([['f/1', a]]))).to.deep.equal(['f/1']);
	});

	it('reports every drifted key, sorted, and skips the unchanged ones', () => {
		const prior = new Map([['g/1', a], ['f/1', a], ['h/2', a]]);
		const current = new Map([['g/1', b], ['f/1', b], ['h/2', a]]);
		expect(detectBodyFunctionDrift(prior, current)).to.deep.equal(['f/1', 'g/1']);
	});
});

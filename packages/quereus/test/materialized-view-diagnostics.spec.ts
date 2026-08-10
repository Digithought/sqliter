import { expect } from 'chai';
import { Database } from '../src/index.js';
import { createTableValuedFunction } from '../src/func/registration.js';
import { INTEGER_TYPE } from '../src/types/builtin-types.js';
import type { Row, SqlValue } from '../src/common/types.js';

/**
 * The create-time gate under the cost-gated-with-floor model: maintenance is
 * **never** rejected for a body's *shape* — a shape that fits no bounded-delta arm
 * falls through to the full-rebuild floor and is maintained wholesale. Only four
 * NON-shape rejections remain: non-determinism, a bag (no provable unique key),
 * no relational output, and a full-rebuild-only body over a source past the size
 * threshold. Each still names the MV and steers to a plain `view` (live re-evaluation)
 * or `create table … as` (one-off snapshot) — NOT a refresh policy, and never leaking
 * any internal `_mv_`-style implementation naming.
 *
 * The sqllogic harness (`53-materialized-views-rowtime.sqllogic` §7) covers positive
 * substrings; it cannot express the *negative* assertions below, so this focused spec
 * locks the user-facing wording in.
 */
describe('Materialized view create-time gate diagnostic', () => {
	let db: Database;
	beforeEach(() => { db = new Database(); });
	afterEach(async () => { await db.close(); });

	async function captureError(sql: string): Promise<Error> {
		try {
			await db.exec(sql);
		} catch (e) {
			return e instanceof Error ? e : new Error(String(e));
		}
		throw new Error(`Expected an error from: ${sql}`);
	}

	it('names the MV + reason and steers to view / create-table, not the backing table or a refresh policy', async () => {
		await db.exec(`
			create table orders (id integer primary key, status text);
			insert into orders values (1, 'open'), (2, 'open'), (3, 'shipped');
		`);

		// A non-deterministic body is one of the four remaining hard rejects (DISTINCT and
		// other shapes are now accepted via the floor — see the acceptance cases below).
		const err = await captureError('create materialized view mv_status as select id, random() as r from orders;');

		// Reason-naming, user-facing wording…
		expect(err.message).to.contain('cannot be materialized');
		expect(err.message).to.contain('mv_status');
		// …steering to the right alternative…
		expect(err.message).to.contain('create view');
		expect(err.message).to.contain('create table');
		// …never a refresh policy (the knob is gone)…
		expect(err.message).to.not.contain('refresh');
		// …and never leaking any internal `_mv_`-style naming.
		expect(err.message).to.not.contain('_mv_');
	});

	it('rolls the MV table back so the MV name stays free after a failed create', async () => {
		await db.exec(`
			create table orders (id integer primary key, status text);
			insert into orders values (1, 'open'), (2, 'open'), (3, 'shipped');
		`);
		// An ineligible body (non-deterministic) fills the MV's table, then the gate
		// rejects it — so the rollback must drop the table it just created.
		await captureError('create materialized view mv_status as select id, random() as r from orders;');

		// A row-time-eligible body (projects the source PK) over the same source must
		// succeed — proving the failed create did not half-register the name or leave
		// a table behind.
		await db.exec('create materialized view mv_status as select id, status from orders;');
		const rows: Record<string, unknown>[] = [];
		for await (const row of db.eval('select id, status from mv_status order by id')) {
			rows.push(row);
		}
		expect(rows).to.deep.equal([
			{ id: 1, status: 'open' }, { id: 2, status: 'open' }, { id: 3, status: 'shipped' },
		]);
	});

	// A duplicate-producing ("bag") body fails the set contract at fill time (before
	// the row-time gate is reached). This path is separate from the gate diagnostic
	// above; it must still name the MV + set contract, never leak internal naming,
	// and steer only to the keyed remedies (`create view` / `create table`).
	it('a duplicate-producing body fails the set contract with a non-leaking diagnostic', async () => {
		await db.exec(`
			create table orders (id integer primary key, status text);
			insert into orders values (1, 'open'), (2, 'open'), (3, 'shipped');
		`);

		const err = await captureError('create materialized view mv_status as select status from orders;');
		expect(err.message).to.contain('must be a set');
		expect(err.message).to.contain('mv_status');
		// Never leaks any internal `_mv_`-style naming…
		expect(err.message).to.not.contain('_mv_');
		// …and steers to the keyed remedies (`create view` / `create table`).
		expect(err.message).to.match(/create view/);
		expect(err.message).to.match(/create table/);

		// The failed create rolled back, so the name is free for an eligible body.
		await db.exec('create materialized view mv_status as select id, status from orders;');
		expect(db.schemaManager.getMaintainedTable('main', 'mv_status'), 'MV registered after rollback').to.not.be.undefined;
	});
});

/**
 * Per-reason gate behavior under the cost-gated-with-floor model. The model flip means
 * **shape** is no longer a rejection reason: DISTINCT, set ops, LIMIT/OFFSET, scalar /
 * order-by aggregates, computed group keys, multi-source bodies, correlated subquery
 * projections, and non-1:1 / self / outer joins all now CREATE — maintained by the
 * full-rebuild floor (or a bounded-delta arm where one fits). The only bodies still
 * rejected at create are the four NON-shape reasons:
 *  - **non-determinism** (the matched arm's arm-specific diagnostic survives);
 *  - a **bag** with no provable unique key (the floor's `keysOf` reject — a body whose
 *    rows happened to be distinct at create-fill so it reached the gate; a genuinely
 *    duplicate-producing body fails the set contract at fill instead, see below);
 *  - **no relational output**;
 *  - **size** (a full-rebuild-only body over a source past the threshold — see the
 *    dedicated `size` describe block below).
 *
 * These cases lock the literal tails the engine produces (captured from it), so a reason
 * silently re-routing to a different branch — or a shape that should now be accepted
 * regressing back to a reject — is caught.
 */
describe('Materialized view gate diagnostic — per-reason tails', () => {
	let db: Database;
	beforeEach(async () => {
		db = new Database();
		await db.exec(`
			create table g (id integer primary key, k integer, v integer);
			create table g2 (id integer primary key, w integer);
			insert into g values (1, 100, 5);
		`);
	});
	afterEach(async () => { await db.close(); });

	async function captureError(sql: string): Promise<Error> {
		try {
			await db.exec(sql);
		} catch (e) {
			return e instanceof Error ? e : new Error(String(e));
		}
		throw new Error(`Expected an error from: ${sql}`);
	}

	// label → [body, distinctive tail substring] — STILL-rejected, non-shape reasons.
	const rejectCases: Array<[string, string, string]> = [
		// Non-determinism — caught by the inverse-projection arm (its arm-specific tail).
		['non-deterministic projection', 'select id, random() as r from g', "non-deterministic expression column 'r'"],
		// A projection that drops the source PK leaves a non-keyed (bag) body — the floor's
		// no-provable-unique-key reject (the single create row was distinct, so it reached
		// the gate rather than failing the set contract at fill).
		['drops the source PK (bag)', 'select v from g', 'no provable unique key'],
		// A recursive-CTE `union all` body is a bag (overlapping inputs, no provable key).
		['recursive-CTE union-all (bag)', 'with recursive r(n) as (select 1 union all select n + 1 from r where n < 3) select n from r', 'no provable unique key'],
		// A 2-leg `union all` does NOT dedup, so even over keyed legs it has no provable key —
		// a bag (the keyed-set `union` counterpart is an accept case below).
		['2-leg union all (bag — no dedup)', 'select id, v from g union all select id, w from g2', 'no provable unique key'],
		// A fanning (non-1:1) inner join on a non-unique key: g.k = g2.w can match a g
		// row to multiple g2 rows. Projecting to (g.id, g.v) drops g2's distinguishing
		// columns, so the body is a bag — g's PK FD survives the join as a determination
		// but no longer encodes uniqueness, and must NOT resurrect as an all-columns key.
		['fanning (non-1:1) inner join (bag)', 'select g.id, g.v from g join g2 on g.k = g2.w', 'no provable unique key'],
	];

	for (const [label, body, tail] of rejectCases) {
		it(`rejects ${label} with its distinctive tail`, async () => {
			const err = await captureError(`create materialized view bad as ${body};`);
			expect(err.message, label).to.contain('cannot be materialized');
			expect(err.message, `${label}: distinctive tail`).to.contain(tail);
		});
	}

	// label → body — shapes that USED to be hard-rejected for their shape and now CREATE
	// (maintained by the full-rebuild floor, or a bounded-delta arm where one fits). The
	// model flip: no body is rejected for its shape.
	const acceptCases: Array<[string, string]> = [
		['DISTINCT', 'select distinct v from g'],
		['scalar aggregate (no GROUP BY)', 'select count(*) as c, sum(v) as s from g'],
		['order by aggregate (non-group-key backing PK)', 'select k, sum(v) as s from g group by k order by sum(v)'],
		// A computed GROUP BY key now carries the propagated group-key FD (ticket
		// collated-groupby-key-completeness), so the aggregate output is a real keyed
		// set — no longer a bag reject.
		['computed GROUP BY key (real key)', 'select k + 1 as kk, count(*) as c from g group by k + 1'],
		['UNION over two tables', 'select id, v from g union select id, w from g2'],
		['WHERE subquery over another table', 'select id, v from g where v in (select w from g2)'],
		['LIMIT', 'select id, v from g limit 10'],
		['OFFSET', 'select id, v from g order by id limit 5 offset 2'],
		['correlated subquery projection', 'select id, (select g.v) as vv from g'],
		['pk=pk inner join (row-lossy, not 1:1)', 'select g.id, g.v from g join g2 on g.id = g2.id'],
		['self-join keyed on the driving PK', 'select a.id, a.v from g a join g b on a.id = b.id'],
	];

	for (const [label, body] of acceptCases) {
		it(`accepts ${label} (maintained by the floor) — no shape reject`, async () => {
			await db.exec(`create materialized view ok_shape as ${body};`);
			expect(db.schemaManager.getMaintainedTable('main', 'ok_shape'), `${label} should register`).to.not.be.undefined;
			await db.exec('drop materialized view ok_shape;');
		});
	}

	// The floor's whole-body determinism reject is the one of the four with a per-schema opt-out:
	// `pragma nondeterministic_schema` lifts it (mirroring CHECK / DEFAULT / GENERATED), so a
	// non-deterministic FLOOR body that would otherwise reject now CREATEs. (A non-det body that
	// matches a *bounded-delta* arm — e.g. `select id, random() …` → inverse-projection — keeps its
	// arm-specific hard reject regardless of the pragma, since a bounded delta can never reproduce
	// it; the pragma escape is for the floor's wholesale rebuild only. The size reject's opt-out is
	// `…rebuild_row_threshold = 0`, in the dedicated size block below; bag / no-output have none.)
	it('pragma nondeterministic_schema lifts the floor determinism reject (a non-det floor body then creates)', async () => {
		// `select distinct random()` is a DISTINCT (floor) body; without the pragma the floor's
		// whole-body determinism check rejects it.
		const err = await captureError('create materialized view nd as select distinct random() as r from g;');
		expect(err.message).to.contain('cannot be materialized');
		expect(err.message).to.contain('non-deterministic');
		expect(err.message).to.contain('nondeterministic_schema'); // names the override
		expect(db.schemaManager.getMaintainedTable('main', 'nd'), 'rejected without the pragma').to.be.undefined;

		// With the pragma the floor's gate is lifted and the body registers.
		await db.exec('pragma nondeterministic_schema = true;');
		await db.exec('create materialized view nd as select distinct random() as r from g;');
		expect(db.schemaManager.getMaintainedTable('main', 'nd'), 'accepted under the pragma').to.not.be.undefined;
	});

	// A deterministic expression projection column (arithmetic / function) over the
	// single source is now ACCEPTED and maintained as a pure per-row projection
	// (materialized-view-rowtime-expression-projections). PK stays passthrough; the
	// computed columns track source writes exactly as a plain view would.
	it('accepts a deterministic expression projection column and maintains it on source writes', async () => {
		await db.exec('create materialized view ev as select id, v + 1 as v1, abs(v) as av from g;');
		expect(db.schemaManager.getMaintainedTable('main', 'ev'), 'expression-projection MV registered').to.not.be.undefined;

		const read = async (): Promise<Record<string, unknown>[]> => {
			const rows: Record<string, unknown>[] = [];
			for await (const row of db.eval('select id, v1, av from ev order by id')) rows.push(row);
			return rows;
		};
		expect(await read()).to.deep.equal([{ id: 1, v1: 6, av: 5 }]);

		await db.exec('insert into g values (2, 200, -8);');
		await db.exec('update g set v = 100 where id = 1;');
		expect(await read()).to.deep.equal([{ id: 1, v1: 101, av: 100 }, { id: 2, v1: -7, av: 8 }]);

		await db.exec('delete from g where id = 1;');
		expect(await read()).to.deep.equal([{ id: 2, v1: -7, av: 8 }]);
	});

	// A single-source `group by` aggregate over bare columns is now ACCEPTED and
	// maintained by the residual-recompute arm: each source write recomputes the
	// affected group's backing row from live state (delete the old slice → run the
	// group-keyed residual → upsert), with an emptied group's backing row removed.
	it('accepts a single-source aggregate and maintains groups on source writes', async () => {
		await db.exec('insert into g values (2, 100, 7), (3, 200, 1);');
		await db.exec('create materialized view ga as select k, count(*) as c, sum(v) as s from g group by k;');
		expect(db.schemaManager.getMaintainedTable('main', 'ga'), 'aggregate MV registered').to.not.be.undefined;

		const read = async (): Promise<Record<string, unknown>[]> => {
			const rows: Record<string, unknown>[] = [];
			for await (const row of db.eval('select k, c, s from ga order by k')) {
				rows.push({ k: row.k, c: Number(row.c), s: Number(row.s) });
			}
			return rows;
		};
		// g: (1,100,5),(2,100,7),(3,200,1) → groups k=100 {5,7}, k=200 {1}.
		expect(await read()).to.deep.equal([{ k: 100, c: 2, s: 12 }, { k: 200, c: 1, s: 1 }]);

		// Insert into an existing group recomputes only that group.
		await db.exec('insert into g values (4, 200, 10);');
		expect(await read()).to.deep.equal([{ k: 100, c: 2, s: 12 }, { k: 200, c: 2, s: 11 }]);

		// Group-key-changing update: move id=1 from k=100 to a fresh k=300 (recomputes both).
		await db.exec('update g set k = 300 where id = 1;');
		expect(await read()).to.deep.equal([{ k: 100, c: 1, s: 7 }, { k: 200, c: 2, s: 11 }, { k: 300, c: 1, s: 5 }]);

		// Deleting the last row of group k=300 removes its backing row entirely.
		await db.exec('delete from g where id = 1;');
		expect(await read()).to.deep.equal([{ k: 100, c: 1, s: 7 }, { k: 200, c: 2, s: 11 }]);
	});

	// MV-over-MV is no longer rejected — the cascade (database-materialized-views.ts)
	// maintains a chain synchronously. Creating an MV whose body reads another MV
	// SUCCEEDS, and a later source write cascades through the inner MV's backing into
	// the outer MV with no refresh.
	it('accepts a materialized view over a materialized view and cascades source writes through it', async () => {
		await db.exec('create materialized view mv_base as select id, v from g;');
		await db.exec('create materialized view mv_over as select id, v from mv_base;');
		expect(db.schemaManager.getMaintainedTable('main', 'mv_over'), 'MV-over-MV registered').to.not.be.undefined;

		// A source insert cascades through mv_base's backing into mv_over.
		await db.exec('insert into g values (2, 200, 7);');
		const rows: Record<string, unknown>[] = [];
		for await (const row of db.eval('select id, v from mv_over order by id')) {
			rows.push(row);
		}
		expect(rows).to.deep.equal([{ id: 1, v: 5 }, { id: 2, v: 7 }]);
	});
});

/**
 * The `with refresh = …` clause is gone entirely (every MV is row-time maintained,
 * with no policy knob). The parser consumes only a trailing `with tags (...)`, so a
 * trailing `with refresh = …` is left unconsumed and fails at the statement
 * boundary — a parse error, regardless of the literal value (the clause is never
 * inspected). Supersedes any "round-trip the row-time policy" expectation.
 */
describe('Materialized view `with refresh` is a parse error', () => {
	let db: Database;
	beforeEach(async () => {
		db = new Database();
		await db.exec('create table t (id integer primary key, x integer);');
	});
	afterEach(async () => { await db.close(); });

	async function captureError(sql: string): Promise<Error> {
		try {
			await db.exec(sql);
		} catch (e) {
			return e instanceof Error ? e : new Error(String(e));
		}
		throw new Error(`Expected an error from: ${sql}`);
	}

	it('rejects `with refresh = \'row-time\'` as a parse error', async () => {
		const err = await captureError("create materialized view v1 as select id, x from t with refresh = 'row-time';");
		// The trailing clause is reparsed as a stray statement → CTE-shaped parse error.
		expect(err.message).to.contain('after CTE name');
		expect(db.schemaManager.getMaintainedTable('main', 'v1'), 'no MV registered on parse failure').to.be.undefined;
	});

	it('rejects an unknown `with refresh = \'bogus\'` literal identically (clause is never inspected)', async () => {
		const err = await captureError("create materialized view v2 as select id, x from t with refresh = 'bogus';");
		expect(err.message).to.contain('after CTE name');
		expect(db.schemaManager.getMaintainedTable('main', 'v2'), 'no MV registered on parse failure').to.be.undefined;
	});
});

/**
 * Single-source lateral-TVF fan-out bodies (`select T.pk…, f.* from T cross join lateral
 * tvf(<args over T>) f`) are maintained by the `'prefix-delete'` arm: each base row maps to
 * N backing rows keyed by the composite product key `(T.pk ∪ tvf-key)`; per source write,
 * the base row's whole fan-out slice is deleted by base-PK prefix and re-fanned from live
 * state. The deep correctness oracle is the property harness
 * (`incremental/maintenance-equivalence.spec.ts` § lateral-TVF). This spec locks the
 * acceptance/maintenance contract and the *negative* shape rejections the sqllogic harness
 * cannot express (a TVF that advertises no per-call key; a non-deterministic TVF).
 */
describe('Materialized view lateral-TVF fan-out arm (prefix-delete)', () => {
	let db: Database;
	beforeEach(async () => {
		db = new Database();
		await db.exec('create table lt (id integer primary key, x integer);');
		await db.exec('insert into lt values (1, 2), (2, 3), (3, 0);');
	});
	afterEach(async () => { await db.close(); });

	async function captureError(sql: string): Promise<Error> {
		try { await db.exec(sql); } catch (e) { return e instanceof Error ? e : new Error(String(e)); }
		throw new Error(`Expected an error from: ${sql}`);
	}

	const read = async (): Promise<Array<Record<string, unknown>>> => {
		const rows: Array<Record<string, unknown>> = [];
		for await (const row of db.eval('select id, value from lf order by id, value')) {
			rows.push({ id: Number(row.id), value: Number(row.value) });
		}
		return rows;
	};

	it('accepts a lateral generate_series fan-out and maintains the slice on source writes', async () => {
		await db.exec('create materialized view lf as select lt.id, lt.x, f.value from lt cross join lateral generate_series(1, lt.x) f;');
		expect(db.schemaManager.getMaintainedTable('main', 'lf'), 'lateral-TVF MV registered').to.not.be.undefined;

		// id=1 → value 1,2 ; id=2 → value 1,2,3 ; id=3 (x=0) → empty fan-out.
		expect(await read()).to.deep.equal([
			{ id: 1, value: 1 }, { id: 1, value: 2 },
			{ id: 2, value: 1 }, { id: 2, value: 2 }, { id: 2, value: 3 },
		]);

		// INSERT adds a new base row's whole fan-out.
		await db.exec('insert into lt values (4, 2);');
		expect(await read()).to.deep.equal([
			{ id: 1, value: 1 }, { id: 1, value: 2 },
			{ id: 2, value: 1 }, { id: 2, value: 2 }, { id: 2, value: 3 },
			{ id: 4, value: 1 }, { id: 4, value: 2 },
		]);

		// UPDATE that grows the fan-out (2 → 4 rows): old slice deleted, new fan-out upserted.
		await db.exec('update lt set x = 4 where id = 1;');
		expect(await read()).to.deep.equal([
			{ id: 1, value: 1 }, { id: 1, value: 2 }, { id: 1, value: 3 }, { id: 1, value: 4 },
			{ id: 2, value: 1 }, { id: 2, value: 2 }, { id: 2, value: 3 },
			{ id: 4, value: 1 }, { id: 4, value: 2 },
		]);

		// Base-PK-changing UPDATE moves the whole prefix (id 2 → 5).
		await db.exec('update lt set id = 5 where id = 2;');
		expect((await read()).filter(r => r.id === 2)).to.deep.equal([]);
		expect((await read()).filter(r => r.id === 5)).to.deep.equal([
			{ id: 5, value: 1 }, { id: 5, value: 2 }, { id: 5, value: 3 },
		]);

		// DELETE removes the whole fan-out slice.
		await db.exec('delete from lt where id = 1;');
		expect((await read()).filter(r => r.id === 1)).to.deep.equal([]);
	});

	it('reads-own-writes + rollback reverts the fan-out slice in lockstep', async () => {
		await db.exec('create materialized view lf as select lt.id, lt.x, f.value from lt cross join lateral generate_series(1, lt.x) f;');
		await db.exec('begin;');
		await db.exec('insert into lt values (9, 3);');
		expect((await read()).filter(r => r.id === 9), 'reads-own-writes mid-transaction').to.have.length(3);
		await db.exec('rollback;');
		expect((await read()).filter(r => r.id === 9), 'rolled back in lockstep').to.deep.equal([]);
	});

	it('rejects a lateral TVF that advertises no per-call key (falls to the floor, which rejects the bag)', async () => {
		// A deterministic TVF that fans into distinct rows 1..n but advertises NO per-call
		// key — the prefix-delete arm cannot form the composite product key, so it falls
		// through to the full-rebuild floor. The fan-out (lt × keyless TVF) has no provable
		// unique key, so the floor rejects it as a bag. (Fill succeeds because the rows
		// happen to be distinct; the floor's keysOf reject then fires at register.)
		db.registerFunction(createTableValuedFunction(
			{
				name: 'fan_nokey', numArgs: 1, deterministic: true,
				returnType: {
					typeClass: 'relation', isReadOnly: true, isSet: false,
					columns: [{ name: 'n', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true }],
					keys: [], rowConstraints: [],
				},
				relationalAdvertisement: { deterministic: true },
			},
			async function* (count: SqlValue): AsyncIterable<Row> {
				const c = typeof count === 'bigint' ? Number(count) : Number(count ?? 0);
				for (let i = 1; i <= c; i++) yield [i];
			},
		));

		const err = await captureError('create materialized view bad_nokey as select lt.id, s.n from lt cross join lateral fan_nokey(lt.x) s;');
		expect(err.message).to.contain('cannot be materialized');
		expect(err.message).to.contain('no provable unique key');
		expect(db.schemaManager.getMaintainedTable('main', 'bad_nokey'), 'no MV registered after the floor rejects the bag').to.be.undefined;
	});

	it('rejects a non-deterministic lateral TVF (the fan-out must be reproducible)', async () => {
		// Flagged non-deterministic (with a per-call key, so the determinism gate — not the
		// keyless gate — is what fires); its body yields 1..n so the create's fill still
		// produces a set before the gate rejects.
		db.registerFunction(createTableValuedFunction(
			{
				name: 'fan_rnd', numArgs: 1, deterministic: false,
				returnType: {
					typeClass: 'relation', isReadOnly: true, isSet: true,
					columns: [{ name: 'n', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true }],
					keys: [[{ index: 0 }]], rowConstraints: [],
				},
				relationalAdvertisement: { isSet: true, keys: [[{ index: 0 }]], deterministic: false },
			},
			async function* (count: SqlValue): AsyncIterable<Row> {
				const c = typeof count === 'bigint' ? Number(count) : Number(count ?? 0);
				for (let i = 1; i <= c; i++) yield [i];
			},
		));

		const err = await captureError('create materialized view bad_rnd as select lt.id, s.n from lt cross join lateral fan_rnd(lt.x) s;');
		expect(err.message).to.contain('cannot be materialized');
		expect(err.message).to.contain('non-deterministic table-valued function');
		expect(db.schemaManager.getMaintainedTable('main', 'bad_rnd'), 'no MV registered after determinism rejection').to.be.undefined;
	});
});

/**
 * The size reject (the fourth, and only NEW, create-time rejection): a body whose only
 * sound maintenance strategy is a full body rebuild — every DML write would re-scan the
 * source — is rejected when the **largest** participating source exceeds the configurable
 * `materialized_view_rebuild_row_threshold` (default 10 000). The check reads the
 * StatsProvider, so the test seeds live counts via `analyze`. `0` disables the reject.
 *
 * The pragma round-trips through the existing options framework; an invalid (negative /
 * non-numeric) value is rejected at set time (validated here via `setOption`, since the
 * `pragma` emitter re-wraps any option-set failure as a generic "Unknown pragma", keeping
 * the precise validation message only on the error's `cause`).
 */
describe('Materialized view full-rebuild size reject + threshold option', () => {
	let db: Database;
	beforeEach(() => { db = new Database(); });
	afterEach(async () => { await db.close(); });

	/** Run a statement and drain its rows (used here for `analyze`'s per-table report). */
	async function drain(sql: string): Promise<void> {
		for await (const _row of db.eval(sql)) { /* drain */ }
	}

	async function captureError(sql: string): Promise<Error> {
		try { await db.exec(sql); } catch (e) { return e instanceof Error ? e : new Error(String(e)); }
		throw new Error(`Expected an error from: ${sql}`);
	}

	it('rejects a full-rebuild-only body over a source past the threshold, and creates it once disabled', async () => {
		await db.exec('create table sz (id integer primary key, v integer);');
		await db.exec('insert into sz values (1,1),(2,2),(3,3),(4,4),(5,5);');
		await drain('analyze sz;'); // seed statistics.rowCount = 5

		// `select distinct v` is full-rebuild-only (DISTINCT → no bounded-delta arm). Threshold
		// 2 < 5 rows → the size reject fires with the threshold-naming diagnostic.
		await db.exec('pragma materialized_view_rebuild_row_threshold = 2;');
		const err = await captureError('create materialized view sz_mv as select distinct v from sz;');
		expect(err.message).to.contain('cannot be materialized');
		expect(err.message).to.contain('materialized_view_rebuild_row_threshold');
		expect(db.schemaManager.getMaintainedTable('main', 'sz_mv'), 'rejected MV not registered').to.be.undefined;

		// Disabling the reject (0) accepts the same body; the floor maintains it on writes.
		await db.exec('pragma materialized_view_rebuild_row_threshold = 0;');
		await db.exec('create materialized view sz_mv as select distinct v from sz;');
		expect(db.schemaManager.getMaintainedTable('main', 'sz_mv'), 'accepted once disabled').to.not.be.undefined;
		await db.exec('insert into sz values (6,6);');
		const rows: number[] = [];
		for await (const row of db.eval('select v from sz_mv order by v')) rows.push(Number(row.v));
		expect(rows).to.deep.equal([1, 2, 3, 4, 5, 6]);
	});

	it('gates on the LARGEST participating source for a multi-source full-rebuild body', async () => {
		await db.exec('create table tiny (id integer primary key, x integer);');
		await db.exec('create table huge (id integer primary key, x integer);');
		await db.exec('insert into tiny values (1,1),(2,2);');
		await db.exec('insert into huge values (1,1),(2,2),(3,3),(4,4),(5,5);');
		await drain('analyze tiny;');
		await drain('analyze huge;');

		// A UNION of both (full-rebuild-only). Threshold 3: tiny(2) ≤ 3 but huge(5) > 3, so
		// the largest source gates and the body is rejected.
		await db.exec('pragma materialized_view_rebuild_row_threshold = 3;');
		const err = await captureError('create materialized view ms as select id, x from tiny union select id, x from huge;');
		expect(err.message).to.contain('cannot be materialized');
		expect(err.message).to.contain('materialized_view_rebuild_row_threshold');
		// The diagnostic names the LARGEST source, not the small driving one.
		expect(err.message).to.contain('huge');
	});

	it('round-trips the threshold pragma and rejects an invalid value at set time', async () => {
		// Default is the documented 10 000.
		expect(db.getOption('materialized_view_rebuild_row_threshold')).to.equal(10000);
		await db.exec('pragma materialized_view_rebuild_row_threshold = 50000;');
		expect(db.getOption('materialized_view_rebuild_row_threshold')).to.equal(50000);

		// Negative / non-numeric values are rejected at set time (validated via setOption —
		// the pragma path re-wraps the failure as a generic "Unknown pragma").
		expect(() => db.setOption('materialized_view_rebuild_row_threshold', -5)).to.throw(/non-negative/);
		expect(() => db.setOption('materialized_view_rebuild_row_threshold', 'abc')).to.throw(/Invalid number/);
		// The rejected set rolled back — the last good value stands.
		expect(db.getOption('materialized_view_rebuild_row_threshold')).to.equal(50000);
	});
});

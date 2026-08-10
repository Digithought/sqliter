import { expect } from 'chai';
import * as fc from 'fast-check';
import { Database } from '../../src/core/database.js';
import { Parser } from '../../src/parser/parser.js';
import { QuereusError } from '../../src/common/errors.js';
import { StatusCode, type SqlValue } from '../../src/common/types.js';
import type * as AST from '../../src/parser/ast.js';
import { buildFullRebuildPlan } from '../../src/core/database-materialized-views-plan-builders.js';
import type { MaintainedTableSchema } from '../../src/schema/derivation.js';
import type { BlockNode } from '../../src/planner/nodes/block.js';
import { createAggregateFunction } from '../../src/func/registration.js';
import type { AggregateFunctionSchema } from '../../src/schema/function.js';
import { INTEGER_TYPE } from '../../src/types/builtin-types.js';

/**
 * Maintenance-equivalence property harness — the correctness oracle for row-time
 * materialized-view maintenance (`MaintenancePlan`'s `'inverse-projection'` arm).
 *
 * For a zoo of eligible covering-index body shapes, it asserts the fundamental
 * invariant after every random source mutation and after rollback:
 *
 *     read(MV backing)  ==  evaluate(body against source)        (as multisets)
 *
 * The MV is read via `select * from mv` (resolves to its synchronously-maintained
 * backing table); the oracle re-runs the MV's defining SELECT *live* against the
 * source table. Maintenance and live evaluation must agree for any mutation
 * sequence — including predicate-scope transitions and key-changing updates — and
 * must revert in lockstep when the enclosing transaction rolls back.
 *
 * This is the regression net every subsequent incremental-maintenance ticket runs
 * against; new body shapes are admitted only once they stay green here. Runs under
 * `yarn test` (Mocha + ts-node/esm), no separate config.
 *
 * Shape sets covered: covering-index (`'inverse-projection'`), single-source aggregate
 * (`'residual-recompute'`), single-source lateral-TVF fan-out (`'prefix-delete'`), 1:1
 * inner/cross join with/without a partial WHERE (`'join-residual'`), and — via real
 * `create materialized view` since the eligibility flip — the always-correct full-rebuild
 * floor over every formerly-rejected shape (DISTINCT / set-op / recursive CTE / outer /
 * >2-source join / scalar aggregate), full-rebuild→full-rebuild chains and diamonds (the
 * multi-round flush), and OR FAIL. The one shape NOT here is the fanning (non-1:1) join — a
 * *bag* reject pinned in `materialized-view-diagnostics.spec.ts`, not an equivalence case.
 */

/** An eligible covering-index body shape: its defining SELECT is both the MV body and
 *  the live oracle. Every shape projects the source PK (`id`) so it is a keyed set. */
interface BodyShape {
	readonly label: string;
	readonly body: string;
}

/** All shapes read the same source `src (id pk, a, b, k)`; only the body varies so the
 *  one mutation generator drives them all (inserts / non-key updates / key-changing
 *  updates / deletes against the shared columns). */
const SHAPES: readonly BodyShape[] = [
	// Single-column passthrough projection (PK only), no predicate.
	{ label: 'single-column passthrough (PK only), no predicate', body: 'select id from src' },
	// Multi-column passthrough with a partial WHERE — random mutations move rows in and
	// out of the `k > 5` true-region (predicate-scope transitions).
	{ label: 'multi-column passthrough + partial WHERE (predicate-scope transitions)', body: 'select id, a, b from src where k > 5' },
	// Projection that reorders source columns (a permutation, not identity) while still
	// covering the PK.
	{ label: 'column-reordering projection (permutation, not identity)', body: 'select b, a, id from src' },
	// Passthrough whose maintenance is exercised primarily by key-changing UPDATEs (the
	// generator below mutates `id` itself).
	{ label: 'passthrough exercised by key-changing UPDATEs', body: 'select id, a from src' },
	// --- Deterministic expression-projection columns (materialized-view-rowtime-
	//     expression-projections). The PK stays passthrough; the computed columns must
	//     equal the live body's value after every mutation, proving maintenance evaluates
	//     project(row) (not just permutes columns). ---
	// Arithmetic computed columns alongside the PK.
	{ label: 'arithmetic expression columns', body: 'select id, a + 1 as a1, b * 2 as b2 from src' },
	// Deterministic function + CAST computed columns (abs over a value that straddles 0).
	{ label: 'function + cast expression columns', body: 'select id, abs(a - 5) as aa, cast(b as text) as bt from src' },
	// CASE expression column.
	{ label: 'CASE expression column', body: 'select id, case when k > 5 then a else b end as cab from src' },
	// Expression column UNDER a partial WHERE — computed value must track rows moving in
	// and out of the `k > 5` scope (predicate-scope transitions) and key-changing updates.
	{ label: 'expression column + partial WHERE (predicate-scope transitions)', body: 'select id, a, a * b as ab from src where k > 5' },
];

/** One random source mutation — single-row (point) statements plus MULTI-ROW statements
 *  (multi-value insert, predicate update/delete matching several rows), so the property
 *  exercises the per-statement deferred-maintenance flush (residual key batch dedup,
 *  full-rebuild deferral) and not only the degenerate one-key statement. Key-changing
 *  updates rewrite the PK itself; collisions are tolerated (see {@link applyMutation} —
 *  a colliding MULTI-row statement additionally exercises statement-atomic revert of a
 *  partially-applied batch). */
type Mutation =
	| { readonly kind: 'insert'; readonly id: number; readonly a: number; readonly b: number; readonly k: number }
	| { readonly kind: 'update'; readonly id: number; readonly a: number; readonly b: number; readonly k: number }
	| { readonly kind: 'updateKey'; readonly oldId: number; readonly newId: number; readonly a: number; readonly b: number; readonly k: number }
	| { readonly kind: 'delete'; readonly id: number }
	| { readonly kind: 'multiInsert'; readonly rows: readonly { readonly id: number; readonly a: number; readonly b: number; readonly k: number }[] }
	| { readonly kind: 'updateWhere'; readonly a: number; readonly k: number; readonly kMatch: number }
	| { readonly kind: 'deleteWhere'; readonly kMatch: number };

// A small id space (so inserts/key-changes collide and predicate transitions recur)
// and a `k` range straddling the `k > 5` boundary.
const idArb = fc.integer({ min: 1, max: 6 });
const valArb = fc.integer({ min: 0, max: 10 });

const mutationArb: fc.Arbitrary<Mutation> = fc.oneof(
	fc.record({ kind: fc.constant('insert' as const), id: idArb, a: valArb, b: valArb, k: valArb }),
	fc.record({ kind: fc.constant('update' as const), id: idArb, a: valArb, b: valArb, k: valArb }),
	fc.record({ kind: fc.constant('updateKey' as const), oldId: idArb, newId: idArb, a: valArb, b: valArb, k: valArb }),
	fc.record({ kind: fc.constant('delete' as const), id: idArb }),
	// Multi-value insert: several rows in ONE statement (intra-statement id duplicates and
	// collisions with existing rows abort and revert the whole statement — tolerated).
	fc.record({
		kind: fc.constant('multiInsert' as const),
		rows: fc.array(fc.record({ id: idArb, a: valArb, b: valArb, k: valArb }), { minLength: 2, maxLength: 4 }),
	}),
	// Predicate (multi-row) update: rewrites `a` AND the group column `k` for every row
	// matching `k = kMatch` — several groups' keys move in one statement.
	fc.record({ kind: fc.constant('updateWhere' as const), a: valArb, k: valArb, kMatch: valArb }),
	// Predicate (multi-row) delete: removes every row of one `k` group in one statement.
	fc.record({ kind: fc.constant('deleteWhere' as const), kMatch: valArb }),
);

function sqlFor(m: Mutation): string {
	switch (m.kind) {
		case 'insert': return `insert into src (id, a, b, k) values (${m.id}, ${m.a}, ${m.b}, ${m.k})`;
		case 'update': return `update src set a = ${m.a}, b = ${m.b}, k = ${m.k} where id = ${m.id}`;
		case 'updateKey': return `update src set id = ${m.newId}, a = ${m.a}, b = ${m.b}, k = ${m.k} where id = ${m.oldId}`;
		case 'delete': return `delete from src where id = ${m.id}`;
		case 'multiInsert': return `insert into src (id, a, b, k) values ${m.rows.map(r => `(${r.id}, ${r.a}, ${r.b}, ${r.k})`).join(', ')}`;
		case 'updateWhere': return `update src set a = ${m.a}, k = ${m.k} where k = ${m.kMatch}`;
		case 'deleteWhere': return `delete from src where k = ${m.kMatch}`;
	}
}

/**
 * Apply one mutation, tolerating PK-collision constraint violations. A plain ABORT
 * constraint failure is statement-atomic — it reverts both the source write and its
 * row-time backing maintenance (53-materialized-views-rowtime.sqllogic §2), leaving
 * the transaction open and source/MV still equivalent. Any *other* error (e.g. an
 * `INTERNAL` from maintenance) propagates and fails the property — that is the bug
 * class this harness is built to catch.
 */
async function execTolerant(db: Database, sql: string): Promise<void> {
	try {
		await db.exec(sql);
	} catch (e) {
		if (e instanceof QuereusError && e.code === StatusCode.CONSTRAINT) return;
		throw e;
	}
}

async function applyMutation(db: Database, m: Mutation): Promise<void> {
	await execTolerant(db, sqlFor(m));
}

/** Canonical, order-stable serialization of a single result row's values. Rows are
 *  compared positionally (the MV's `select *` and the body share an identical column
 *  order), so a value array is a faithful row key. */
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

/** Assert `read(MV) == evaluate(body)` as multisets. */
async function assertEquivalent(db: Database, body: string, phase: string): Promise<void> {
	const fromMv = await readMultiset(db, 'select * from mv');
	// The oracle must recompute `body` LIVE from the source. The body is, by
	// construction, the MV's own defining SELECT, so the read-side query-rewrite rule
	// (`rule-materialized-view-rewrite`) would otherwise redirect it to the very
	// backing this oracle exists to check — making the comparison vacuous. Disable it
	// for the oracle read only (the `select * from mv` above resolves to the backing
	// directly, independent of the rule).
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

/**
 * Single-source aggregate body shapes (`select g…, agg(…) from src [where P] group by g…`)
 * maintained by the `'residual-recompute'` arm. The shared `mutationArb` drives the
 * cases needed: `insert` adds rows; `update`/`updateKey` rewrite `k`/`a`, so they move
 * rows across `group by k` / `group by a, k` groups (group-key-changing updates) and
 * across the `a > 3` partial-WHERE scope; `delete` (plus collisions) empties groups. The
 * oracle re-runs the same aggregate body live, so incremental maintenance and live
 * evaluation must agree — including emptied groups, where the residual returns zero rows
 * and the backing row must disappear.
 */
const AGGREGATE_SHAPES: readonly BodyShape[] = [
	{ label: 'group by k: count + sum (group-key-changing updates, emptied groups)', body: 'select k, count(*) as c, sum(a) as s from src group by k' },
	{ label: 'group by k + partial WHERE a > 3 (predicate-scope transitions)', body: 'select k, count(*) as c, sum(a) as s from src where a > 3 group by k' },
	{ label: 'group by k: count + sum + min + max', body: 'select k, count(*) as c, sum(a) as s, min(b) as mn, max(b) as mx from src group by k' },
	{ label: 'multi-column group by (a, k)', body: 'select a, k, count(*) as c, sum(b) as s from src group by a, k' },
];

/**
 * Define one equivalence suite per body shape: after every random mutation (and after
 * rollback), the synchronously-maintained MV backing must equal the live body as a
 * multiset. Shared by the covering-index (`'inverse-projection'`), single-source
 * aggregate (`'residual-recompute'`), and full-rebuild (`'full-rebuild'`) shape sets.
 *
 * `afterCreate` (optional) runs once per case immediately after the MV is created, before
 * any mutation — the full-rebuild suites use it to swap the registered bounded-delta plan
 * for a freshly-built `'full-rebuild'` plan over the same body (see {@link forceFullRebuild}),
 * so the SAME property then exercises the floor arm end-to-end.
 */
function defineEquivalenceSuite(
	suiteTitle: string,
	shapes: readonly BodyShape[],
	afterCreate?: (db: Database) => void,
): void {
	describe(suiteTitle, () => {
		for (const shape of shapes) {
			describe(shape.label, () => {
				let db: Database;

				beforeEach(async () => {
					db = new Database();
					await db.exec('create table src (id integer primary key, a integer, b integer, k integer)');
					// Committed seed straddling the `k > 5` / `a > 3` predicates, restored to
					// before every run by the always-rolled-back transaction below.
					await db.exec('insert into src (id, a, b, k) values (1, 0, 0, 6), (2, 3, 4, 2), (3, 7, 1, 9)');
					await db.exec(`create materialized view mv as ${shape.body}`);
					if (afterCreate) afterCreate(db);
				});

				afterEach(async () => { await db.close(); });

				it('read(MV) == evaluate(body) across random mutations, in-txn and after rollback', async () => {
					await fc.assert(fc.asyncProperty(
						fc.array(mutationArb, { minLength: 1, maxLength: 10 }),
						async (mutations) => {
							// Equivalent against the committed baseline.
							await assertEquivalent(db, shape.body, 'baseline');

							await db.exec('begin');
							try {
								for (const m of mutations) await applyMutation(db, m);
								// Reads-own-writes: the MV backing reflects every pending source
								// write mid-transaction, matching the live body.
								await assertEquivalent(db, shape.body, 'in-transaction');
							} finally {
								await db.exec('rollback');
							}

							// Maintenance reverted in lockstep with the rolled-back source writes.
							await assertEquivalent(db, shape.body, 'post-rollback');
						},
					), { numRuns: 40 });
				});
			});
		}
	});
}

/**
 * Single-source lateral-TVF fan-out body shapes (`select T.pk…, …, f.value from T cross
 * join lateral generate_series(1, <col>) f`) maintained by the `'prefix-delete'` arm. Each
 * base row fans out to `<col>` rows keyed by the generated `value`; the backing PK is the
 * composite product key `(id, value)`. The shared `mutationArb` drives every case: `insert`
 * adds a base row's whole fan-out; `update` rewrites `a`/`k`, growing/shrinking the fan-out
 * (and moving rows across the `k > 5` partial-WHERE scope); `updateKey` rewrites the base PK
 * `id`, moving the entire prefix (the by-prefix delete of the OLD prefix + recompute of the
 * NEW); `delete` (plus collisions) removes a slice. `generate_series(1, n)` for `n ≤ 0`
 * yields zero rows — a base row with `a`/`k` ≤ 0, or out of the WHERE scope, contributes no
 * backing rows, so the oracle and the maintained backing must agree on the empty fan-out.
 */
const LATERAL_TVF_SHAPES: readonly BodyShape[] = [
	{ label: 'lateral generate_series fan-out (PK + fan-out value)', body: 'select src.id, f.value from src cross join lateral generate_series(1, src.a) f' },
	{ label: 'lateral fan-out + passthrough columns (id, a, k, value)', body: 'select src.id, src.a, src.k, f.value from src cross join lateral generate_series(1, src.a) f' },
	{ label: 'lateral fan-out + partial WHERE k>5 (scope transitions on/off)', body: 'select src.id, f.value from src cross join lateral generate_series(1, src.a) f where src.k > 5' },
	{ label: 'lateral fan-out driven by k (column other than a)', body: 'select src.id, f.value from src cross join lateral generate_series(1, src.k) f' },
];

defineEquivalenceSuite('Materialized-view maintenance equivalence (covering-index shapes)', SHAPES);
defineEquivalenceSuite('Materialized-view maintenance equivalence (single-source aggregate shapes)', AGGREGATE_SHAPES);
defineEquivalenceSuite('Materialized-view maintenance equivalence (lateral-TVF fan-out shapes)', LATERAL_TVF_SHAPES);

/**
 * Lateral-TVF fan-out (`'prefix-delete'`) under a NON-binary (`text collate NOCASE`)
 * **base primary key** — the one collation shape the integer-PK fan-out suite above never
 * reaches. The `delete-by-prefix` primitive the arm deletes a base row's whole fan-out
 * slice with early-terminates its prefix scan on a *binary* compare (`scan-layer.ts`),
 * while the backing btree orders the base-PK prefix by the column's NOCASE collation. This
 * is reasoned sound for this arm — the backing base-PK column inherits the source PK
 * collation, and source-PK uniqueness collapses each NOCASE class to a single binary value,
 * so a base row's fan-out rows are binary-homogeneous and contiguous — and this suite is the
 * end-to-end exercise of that reasoning that the prior harness lacked.
 *
 * The id space is a small set of single letters in BOTH cases (`a`/`A`, `b`/`B`, …) so the
 * random mutations routinely:
 *   - collide under NOCASE (insert `'A'` while `'a'` exists → tolerated CONSTRAINT, the
 *     PK-uniqueness collapse);
 *   - rewrite the PK case-only (`update … set id='A' where id='a'` — the *same* PK under
 *     NOCASE, which still moves the stored byte value the backing keys on);
 *   - move the whole prefix (`'a' → 'b'`) and grow/shrink/empty the fan-out (`n` straddles 0).
 * Letters chosen so NOCASE order ≠ binary order is irrelevant to the oracle, but it ensures
 * the maintained backing exercises the NOCASE-ordered btree under the binary prefix delete.
 * The oracle re-runs the same body live; maintained backing and live body must agree as
 * multisets mid-transaction (reads-own-writes) and after rollback.
 */
describe('Materialized-view maintenance equivalence (lateral-TVF fan-out, NOCASE base PK)', () => {
	let db: Database;
	const body = 'select t.id, f.value from t cross join lateral generate_series(1, t.n) f';

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table t (id text collate NOCASE primary key, n integer)');
		// Committed seed straddling the empty-fan-out boundary (cherry n=0 → no backing rows).
		await db.exec("insert into t (id, n) values ('apple', 2), ('Banana', 3), ('cherry', 0)");
		await db.exec(`create materialized view mv as ${body}`);
	});

	afterEach(async () => { await db.close(); });

	type TextMutation =
		| { readonly kind: 'insert'; readonly id: string; readonly n: number }
		| { readonly kind: 'update'; readonly id: string; readonly n: number }
		| { readonly kind: 'updateKey'; readonly oldId: string; readonly newId: string; readonly n: number }
		| { readonly kind: 'delete'; readonly id: string };

	// Single letters in both cases — `'a'`/`'A'` are the SAME PK under NOCASE, so inserts
	// collide and key-changes are sometimes case-only rewrites, sometimes real moves.
	const idArb = fc.constantFrom('a', 'A', 'b', 'B', 'c', 'C', 'd');
	// `n` straddles 0 so a fan-out can grow, shrink, or empty (generate_series(1, n≤0) → 0 rows).
	const nArb = fc.integer({ min: -1, max: 4 });

	const textMutationArb: fc.Arbitrary<TextMutation> = fc.oneof(
		fc.record({ kind: fc.constant('insert' as const), id: idArb, n: nArb }),
		fc.record({ kind: fc.constant('update' as const), id: idArb, n: nArb }),
		fc.record({ kind: fc.constant('updateKey' as const), oldId: idArb, newId: idArb, n: nArb }),
		fc.record({ kind: fc.constant('delete' as const), id: idArb }),
	);

	const textSqlFor = (m: TextMutation): string => {
		switch (m.kind) {
			case 'insert': return `insert into t (id, n) values ('${m.id}', ${m.n})`;
			case 'update': return `update t set n = ${m.n} where id = '${m.id}'`;
			case 'updateKey': return `update t set id = '${m.newId}', n = ${m.n} where id = '${m.oldId}'`;
			case 'delete': return `delete from t where id = '${m.id}'`;
		}
	};

	it('read(MV) == evaluate(body) across random NOCASE-PK mutations, in-txn and after rollback', async () => {
		await fc.assert(fc.asyncProperty(
			fc.array(textMutationArb, { minLength: 1, maxLength: 12 }),
			async (mutations) => {
				await assertEquivalent(db, body, 'baseline');

				await db.exec('begin');
				try {
					for (const m of mutations) await execTolerant(db, textSqlFor(m));
					await assertEquivalent(db, body, 'in-transaction');
				} finally {
					await db.exec('rollback');
				}

				await assertEquivalent(db, body, 'post-rollback');
			},
		), { numRuns: 60 });
	});

	it('a case-only base-PK rewrite (same NOCASE PK) re-keys the whole fan-out slice', async () => {
		await assertEquivalent(db, body, 'baseline');
		// 'apple' → 'APPLE' is the SAME PK under NOCASE but a different stored byte value the
		// backing keys on: the old slice is deleted by prefix and the new fan-out upserted, so
		// every backing row's id must now read the new byte value 'APPLE' and none read 'apple'.
		await db.exec("update t set id = 'APPLE' where id = 'apple'");
		await assertEquivalent(db, body, 'after case-only rewrite');
		// Distinct stored id byte-values: lowercase 'apple' is gone (re-keyed), 'APPLE' present,
		// 'Banana' untouched (cherry n=0 contributes no backing rows). canonRow is byte-exact.
		const ids = await readMultiset(db, 'select distinct id from mv');
		expect(ids, 'old-case slice re-keyed to the new byte value').to.deep.equal(
			[canonRow(['APPLE']), canonRow(['Banana'])].sort(),
		);
	});
});

/**
 * 1:1 inner-join body (`select t.id, t.fk, p.name from t join p on t.fk = p.id`) maintained
 * by the `'join-residual'` arm. T's NOT-NULL FK `t.fk → p.id` makes the inner join provably
 * 1:1 on T (no row loss via enforced referential integrity, no fan-out via p's unique PK),
 * so the backing is keyed on T's PK and each T row maps to one backing row.
 *
 * Random mutations drive BOTH sources: t inserts / FK-moving updates / key-changing updates
 * / deletes exercise the forward (T-PK-keyed) residual; p inserts / name updates / deletes
 * exercise the reverse (P-PK-keyed) lookup residual (upsert-only — inner-join + RI membership
 * is determined by `t.fk`, so a p write only re-derives the joined `name`). FK violations (a
 * `t.fk` with no matching p, a p delete with referencing children, or a colliding key-change)
 * surface as tolerated CONSTRAINT errors, statement-atomic on both source and backing. The
 * oracle re-runs the same join body live; the maintained backing must equal it as a multiset,
 * mid-transaction (reads-own-writes) and after rollback.
 */
describe('Materialized-view maintenance equivalence (1:1 inner-join shape)', () => {
	let db: Database;
	const body = 'select t.id, t.fk, p.name from t join p on t.fk = p.id';

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table p (id integer primary key, name text)');
		await db.exec('create table t (id integer primary key, fk integer not null references p(id))');
		// Committed seed: p ids 1..4, t rows referencing them (two share fk=1).
		await db.exec("insert into p (id, name) values (1, 'a'), (2, 'b'), (3, 'c'), (4, 'd')");
		await db.exec('insert into t (id, fk) values (1, 1), (2, 1), (3, 2), (4, 3)');
		await db.exec(`create materialized view mv as ${body}`);
	});

	afterEach(async () => { await db.close(); });

	type JoinMutation =
		| { readonly kind: 't-insert'; readonly id: number; readonly fk: number }
		| { readonly kind: 't-updateFk'; readonly id: number; readonly fk: number }
		| { readonly kind: 't-updateKey'; readonly oldId: number; readonly newId: number; readonly fk: number }
		| { readonly kind: 't-delete'; readonly id: number }
		| { readonly kind: 'p-insert'; readonly id: number; readonly name: string }
		| { readonly kind: 'p-updateName'; readonly id: number; readonly name: string }
		| { readonly kind: 'p-delete'; readonly id: number };

	const tIdArb = fc.integer({ min: 1, max: 6 });
	// fk sometimes references a missing p (→ tolerated FK violation) and sometimes a new p.
	const fkArb = fc.integer({ min: 1, max: 8 });
	const newPArb = fc.integer({ min: 5, max: 8 });
	const nameArb = fc.constantFrom('a', 'b', 'c', 'd', 'e', 'z');

	const joinMutationArb: fc.Arbitrary<JoinMutation> = fc.oneof(
		fc.record({ kind: fc.constant('t-insert' as const), id: tIdArb, fk: fkArb }),
		fc.record({ kind: fc.constant('t-updateFk' as const), id: tIdArb, fk: fkArb }),
		fc.record({ kind: fc.constant('t-updateKey' as const), oldId: tIdArb, newId: tIdArb, fk: fkArb }),
		fc.record({ kind: fc.constant('t-delete' as const), id: tIdArb }),
		fc.record({ kind: fc.constant('p-insert' as const), id: newPArb, name: nameArb }),
		fc.record({ kind: fc.constant('p-updateName' as const), id: fc.integer({ min: 1, max: 8 }), name: nameArb }),
		fc.record({ kind: fc.constant('p-delete' as const), id: newPArb }),
	);

	const joinSqlFor = (m: JoinMutation): string => {
		switch (m.kind) {
			case 't-insert': return `insert into t (id, fk) values (${m.id}, ${m.fk})`;
			case 't-updateFk': return `update t set fk = ${m.fk} where id = ${m.id}`;
			case 't-updateKey': return `update t set id = ${m.newId}, fk = ${m.fk} where id = ${m.oldId}`;
			case 't-delete': return `delete from t where id = ${m.id}`;
			case 'p-insert': return `insert into p (id, name) values (${m.id}, '${m.name}')`;
			case 'p-updateName': return `update p set name = '${m.name}' where id = ${m.id}`;
			case 'p-delete': return `delete from p where id = ${m.id}`;
		}
	};

	it('read(MV) == evaluate(body) across random t/p mutations, in-txn and after rollback', async () => {
		await fc.assert(fc.asyncProperty(
			fc.array(joinMutationArb, { minLength: 1, maxLength: 12 }),
			async (mutations) => {
				await assertEquivalent(db, body, 'baseline');

				await db.exec('begin');
				try {
					for (const m of mutations) await execTolerant(db, joinSqlFor(m));
					await assertEquivalent(db, body, 'in-transaction');
				} finally {
					await db.exec('rollback');
				}

				await assertEquivalent(db, body, 'post-rollback');
			},
		), { numRuns: 60 });
	});

	it('a removed join row (delete of a t row) drops exactly its backing row', async () => {
		await assertEquivalent(db, body, 'baseline');
		expect((await readMultiset(db, 'select * from mv')).length, 'baseline row count').to.equal(4);
		// Delete t id=2 (fk=1). Its joined row disappears; the other fk=1 row (id=1) stays.
		await db.exec('delete from t where id = 2');
		await assertEquivalent(db, body, 'after removed join row');
		expect((await readMultiset(db, 'select * from mv')).length, 'after t-delete row count').to.equal(3);
	});

	it('a lookup-side (p) name update refreshes every joined backing row for that p', async () => {
		await db.exec("update p set name = 'A!' where id = 1");
		await assertEquivalent(db, body, 'after p name update');
		// Both t rows with fk=1 (ids 1 and 2) must now read p.name = 'A!'.
		const rows = await readMultiset(db, "select id from mv where name = 'A!'");
		expect(rows.length, "rows referencing updated p name").to.equal(2);
	});
});

/* ──────────────────── 1:1 inner-join with a partial WHERE ──────────────────── */

/**
 * 1:1 inner-join bodies with a partial `WHERE`, maintained by the `'join-residual'` arm's
 * bounded-delta WHERE handling (`mv-join-where-widening`). A `WHERE` over the driving table
 * `t` only relaxes the gate (the forward `t`-keyed residual already injects + applies it; the
 * lookup side stays upsert-only since a `t`-column predicate cannot move the membership set
 * `{ t : t.fk = p.id }`). A `WHERE` referencing the lookup `p` (or both sides) switches the
 * lookup side to a **delete-capable** reverse residual: per affected `p` key the membership
 * residual (WHERE stripped) deletes every currently-referencing `t.id` backing key, then the
 * in-scope residual re-upserts the survivors — so a `p` write that flips a row's WHERE
 * membership adds/removes its backing row.
 *
 * Both sources carry a predicate column straddling the boundary 5 (`t.amt`, `p.score`), so the
 * shared mutation generator drives every transition: a `t.amt` update moves a row across a
 * `t`-side predicate (forward scope flip); a `p.score` update moves *every* `t` row joined to
 * that `p` across a `p`-side predicate (the membership-flip add/remove the delete-capable pass
 * exists for); an FK-move changes which `p` a `t` row joins (re-evaluating a `p`-side predicate
 * against a different `p`). The oracle re-runs the same WHERE-bearing body live; the maintained
 * backing must equal it as a multiset mid-transaction (reads-own-writes) and after rollback.
 */
type JoinWhereMutation =
	| { readonly kind: 't-insert'; readonly id: number; readonly fk: number; readonly amt: number }
	| { readonly kind: 't-update'; readonly id: number; readonly fk: number; readonly amt: number }
	| { readonly kind: 't-updateKey'; readonly oldId: number; readonly newId: number; readonly fk: number; readonly amt: number }
	| { readonly kind: 't-delete'; readonly id: number }
	| { readonly kind: 'p-insert'; readonly id: number; readonly name: string; readonly score: number }
	| { readonly kind: 'p-update'; readonly id: number; readonly name: string; readonly score: number }
	| { readonly kind: 'p-delete'; readonly id: number };

const joinWhereMutationArb: fc.Arbitrary<JoinWhereMutation> = (() => {
	const tIdArb = fc.integer({ min: 1, max: 6 });
	const fkArb = fc.integer({ min: 1, max: 8 });   // sometimes a missing p → tolerated FK violation
	const newPArb = fc.integer({ min: 5, max: 8 });
	const nameArb = fc.constantFrom('a', 'b', 'c', 'd', 'e', 'z');
	const boundaryArb = fc.integer({ min: 0, max: 10 }); // straddles the `> 5` predicate boundary
	return fc.oneof(
		fc.record({ kind: fc.constant('t-insert' as const), id: tIdArb, fk: fkArb, amt: boundaryArb }),
		fc.record({ kind: fc.constant('t-update' as const), id: tIdArb, fk: fkArb, amt: boundaryArb }),
		fc.record({ kind: fc.constant('t-updateKey' as const), oldId: tIdArb, newId: tIdArb, fk: fkArb, amt: boundaryArb }),
		fc.record({ kind: fc.constant('t-delete' as const), id: tIdArb }),
		fc.record({ kind: fc.constant('p-insert' as const), id: newPArb, name: nameArb, score: boundaryArb }),
		fc.record({ kind: fc.constant('p-update' as const), id: fc.integer({ min: 1, max: 8 }), name: nameArb, score: boundaryArb }),
		fc.record({ kind: fc.constant('p-delete' as const), id: newPArb }),
	);
})();

const joinWhereSqlFor = (m: JoinWhereMutation): string => {
	switch (m.kind) {
		case 't-insert': return `insert into t (id, fk, amt) values (${m.id}, ${m.fk}, ${m.amt})`;
		case 't-update': return `update t set fk = ${m.fk}, amt = ${m.amt} where id = ${m.id}`;
		case 't-updateKey': return `update t set id = ${m.newId}, fk = ${m.fk}, amt = ${m.amt} where id = ${m.oldId}`;
		case 't-delete': return `delete from t where id = ${m.id}`;
		case 'p-insert': return `insert into p (id, name, score) values (${m.id}, '${m.name}', ${m.score})`;
		case 'p-update': return `update p set name = '${m.name}', score = ${m.score} where id = ${m.id}`;
		case 'p-delete': return `delete from p where id = ${m.id}`;
	}
};

/** One equivalence suite per partial-WHERE join body. `t (id pk, fk→p, amt)` and
 *  `p (id pk, name, score)` give both sides a predicate column straddling 5. */
function defineJoinWhereSuite(suiteTitle: string, body: string): void {
	describe(suiteTitle, () => {
		let db: Database;

		beforeEach(async () => {
			db = new Database();
			await db.exec('create table p (id integer primary key, name text, score integer)');
			await db.exec('create table t (id integer primary key, fk integer not null references p(id), amt integer)');
			// Seed straddling the `> 5` boundary on both score (p) and amt (t); two t rows share fk=1.
			await db.exec("insert into p (id, name, score) values (1, 'a', 3), (2, 'b', 7), (3, 'c', 5), (4, 'd', 9)");
			await db.exec('insert into t (id, fk, amt) values (1, 1, 2), (2, 1, 8), (3, 2, 4), (4, 3, 6)');
			await db.exec(`create materialized view mv as ${body}`);
		});

		afterEach(async () => { await db.close(); });

		it('read(MV) == evaluate(body) across random t/p mutations, in-txn and after rollback', async () => {
			await fc.assert(fc.asyncProperty(
				fc.array(joinWhereMutationArb, { minLength: 1, maxLength: 14 }),
				async (mutations) => {
					await assertEquivalent(db, body, 'baseline');

					await db.exec('begin');
					try {
						for (const m of mutations) await execTolerant(db, joinWhereSqlFor(m));
						await assertEquivalent(db, body, 'in-transaction');
					} finally {
						await db.exec('rollback');
					}

					await assertEquivalent(db, body, 'post-rollback');
				},
			), { numRuns: 80 });
		});
	});
}

defineJoinWhereSuite(
	'Materialized-view maintenance equivalence (1:1 inner-join, T-only WHERE)',
	'select t.id, t.fk, t.amt, p.name from t join p on t.fk = p.id where t.amt > 5',
);
defineJoinWhereSuite(
	'Materialized-view maintenance equivalence (1:1 inner-join, P-referencing WHERE)',
	'select t.id, t.fk, p.name, p.score from t join p on t.fk = p.id where p.score > 5',
);
defineJoinWhereSuite(
	'Materialized-view maintenance equivalence (1:1 inner-join, both-sides WHERE)',
	'select t.id, t.fk, t.amt, p.name, p.score from t join p on t.fk = p.id where t.amt > 5 and p.score > 5',
);

/**
 * Deterministic membership-flip edges of the partial-WHERE join arm — the cases the property
 * suites only reach incidentally, pinned in both directions. The body
 * `select t.id, t.fk, p.name, p.score from t join p on t.fk = p.id where p.score > 5` is
 * delete-capable (P-referencing WHERE): a `p.score` update that crosses the boundary must add
 * the newly-qualifying joined rows and remove the newly-disqualified ones.
 */
describe('Materialized-view maintenance equivalence (1:1 inner-join, P-WHERE membership flips)', () => {
	let db: Database;
	const body = 'select t.id, t.fk, p.name, p.score from t join p on t.fk = p.id where p.score > 5';

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table p (id integer primary key, name text, score integer)');
		await db.exec('create table t (id integer primary key, fk integer not null references p(id), amt integer)');
		// p1.score = 3 (out of scope), p2.score = 7 (in scope). Two t rows reference each.
		await db.exec("insert into p (id, name, score) values (1, 'a', 3), (2, 'b', 7)");
		await db.exec('insert into t (id, fk, amt) values (1, 1, 0), (2, 1, 0), (3, 2, 0), (4, 2, 0)');
		await db.exec(`create materialized view mv as ${body}`);
	});
	afterEach(async () => { await db.close(); });

	it('a p update that pushes rows OUT of WHERE scope removes their backing rows (delete pass)', async () => {
		await assertEquivalent(db, body, 'baseline');
		// p2 (score 7, in scope) has two referencing t rows (ids 3,4) in the backing.
		expect((await readMultiset(db, 'select id from mv')).length, 'baseline in-scope rows (fk=2)').to.equal(2);
		// Push p2 out of scope (7 → 1). Both joined rows must disappear — upsert-only could not.
		await db.exec('update p set score = 1 where id = 2');
		await assertEquivalent(db, body, 'after p out-of-scope');
		expect((await readMultiset(db, 'select id from mv')).length, 'all rows left scope').to.equal(0);
	});

	it('a p update that pulls rows INTO WHERE scope adds their backing rows', async () => {
		await assertEquivalent(db, body, 'baseline');
		// p1 (score 3, out of scope) has two referencing t rows (ids 1,2), absent from the backing.
		const inScope = await readMultiset(db, 'select id from mv');
		expect(inScope.length, 'baseline: only fk=2 rows in scope').to.equal(2);
		// Pull p1 into scope (3 → 9). Its two joined rows must appear.
		await db.exec('update p set score = 9 where id = 1');
		await assertEquivalent(db, body, 'after p in-scope');
		expect((await readMultiset(db, 'select id from mv')).length, 'fk=1 rows entered scope').to.equal(4);
	});

	it('a p payload update within scope refreshes the projected lookup columns (no add/remove)', async () => {
		await assertEquivalent(db, body, 'baseline');
		await db.exec("update p set name = 'B!' where id = 2");  // stays in scope (score 7)
		await assertEquivalent(db, body, 'after in-scope p payload update');
		const named = await readMultiset(db, "select id from mv where name = 'B!'");
		expect(named.length, 'both fk=2 rows refreshed, none added/removed').to.equal(2);
	});
});

/**
 * White-box check that the WHERE classification routes to the right lookup strategy (and is not
 * silently floored): a `T`-only WHERE stays upsert-only (no membership residual built); a
 * `P`-referencing or both-sides WHERE is delete-capable (membership residual present). Reaches
 * into the registered `'join-residual'` plan via the manager internals.
 */
describe('Materialized-view join-residual partial-WHERE plan selection', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table p (id integer primary key, name text, score integer)');
		await db.exec('create table t (id integer primary key, fk integer not null references p(id), amt integer)');
		await db.exec("insert into p (id, name, score) values (1, 'a', 3), (2, 'b', 7)");
		await db.exec('insert into t (id, fk, amt) values (1, 1, 2), (2, 2, 8)');
	});
	afterEach(async () => { await db.close(); });

	interface JoinPlanLike { readonly kind: string; readonly lookupMembershipResidualScheduler?: unknown }
	const planFor = (name: string): JoinPlanLike => {
		const mgr = (db as unknown as ManagerHandle).materializedViewManager as unknown as {
			rowTime: Map<string, JoinPlanLike>;
		};
		const plan = mgr.rowTime.get(`main.${name}`.toLowerCase());
		expect(plan, `${name} plan registered`).to.exist;
		return plan!;
	};

	it('a T-only WHERE selects join-residual with an upsert-only lookup (no membership residual)', async () => {
		await db.exec('create materialized view mv as select t.id, t.fk, p.name from t join p on t.fk = p.id where t.amt > 5');
		const plan = planFor('mv');
		expect(plan.kind, 'bounded-delta join arm, not floored').to.equal('join-residual');
		expect(plan.lookupMembershipResidualScheduler, 'T-only WHERE stays upsert-only').to.be.undefined;
	});

	it('a P-referencing WHERE selects join-residual with a delete-capable lookup (membership residual present)', async () => {
		await db.exec('create materialized view mv as select t.id, t.fk, p.name, p.score from t join p on t.fk = p.id where p.score > 5');
		const plan = planFor('mv');
		expect(plan.kind, 'bounded-delta join arm, not floored').to.equal('join-residual');
		expect(plan.lookupMembershipResidualScheduler, 'P-referencing WHERE is delete-capable').to.exist;
	});

	it('a both-sides WHERE is classified P-referencing (delete-capable)', async () => {
		await db.exec('create materialized view mv as select t.id, t.fk, t.amt, p.name from t join p on t.fk = p.id where t.amt > 5 and p.score > 5');
		const plan = planFor('mv');
		expect(plan.kind, 'bounded-delta join arm, not floored').to.equal('join-residual');
		expect(plan.lookupMembershipResidualScheduler, 'both-sides WHERE is delete-capable').to.exist;
	});

	it('a volatile WHERE is declined by the arm (falls to the floor → rejected without the pragma)', async () => {
		// The residuals embed the WHERE, so a volatile predicate would be irreproducible. The arm
		// declines it (returns null), so it hits the floor's pragma-gated whole-body determinism
		// reject — preserving the pre-WHERE-widening behavior rather than an unsound residual.
		let caught: unknown;
		try {
			await db.exec('create materialized view mv as select t.id, p.name from t join p on t.fk = p.id where random() > 0');
		} catch (e) { caught = e; }
		expect(caught, 'a volatile WHERE join must reject').to.be.instanceOf(QuereusError);
		expect((caught as QuereusError).code).to.equal(StatusCode.UNSUPPORTED);
		expect((caught as QuereusError).message).to.contain('non-deterministic');
	});
});

/* ─────────────────────────── full-rebuild floor ─────────────────────────── */

/** A freshly-built `'full-rebuild'` plan, as inspected by the swap helper. */
interface FullRebuildPlanLike {
	readonly kind: string;
	readonly sourceBases: string[];
}

/** White-box reach into the manager internals the swap helper drives. The map key is
 *  lowercase `schema.name` (see `mvKey` in database-materialized-views.ts). */
interface MvManagerInternals {
	releaseRowTime(key: string): void;
	readonly rowTime: Map<string, { kind: string }>;
	readonly rowTimeBySource: Map<string, Set<string>>;
}
interface ManagerHandle { readonly materializedViewManager: MvManagerInternals; }

/**
 * Build a `'full-rebuild'` plan via the extracted plan-builder. Since phase-2 decomposition
 * the builder is a free function over the manager context — the manager is constructed with
 * the {@link Database} as its context, so `db` is that context. Casts the loosely-typed
 * test inputs (`unknown` MV / analyzed plan) to the builder's parameter types.
 */
function buildFloorPlan(db: Database, mv: unknown, analyzed: unknown): FullRebuildPlanLike {
	return buildFullRebuildPlan(db, mv as MaintainedTableSchema, analyzed as BlockNode);
}

/**
 * Swap a registered MV's maintenance plan for a freshly-built `'full-rebuild'` plan over
 * the SAME body, reusing the create-time backing. This forces the floor arm onto a body the
 * cost gate would otherwise maintain by a cheaper bounded-delta arm, so the floor's
 * re-evaluate-and-`replace-all` is proven to agree with the bounded-delta arm for that body
 * (a cross-check the SQL-created floor zoo below cannot give — those bodies have no bounded
 * arm). The body must ALSO be a bounded-delta shape so `create` produced a backing table at
 * the right shape. After the swap, a source write dispatches into `applyFullRebuild` (re-run
 * the whole body → `'replace-all'`).
 *
 * NB: since `mv-eligibility-floor-fallthrough`, `buildMaintenancePlan` DOES route a
 * shape-mismatched body to the floor (`tryBuildBoundedDeltaArm` → `buildFullRebuildPlan`), so
 * genuine floor-only shapes (DISTINCT, set-op, recursive CTE, outer/>2-source join, scalar
 * aggregate) are now create-able directly — see the SQL-created floor suites below.
 *
 * It re-derives the analyzed body exactly as `buildMaintenancePlan` does, calls the
 * manager's `buildFullRebuildPlan`, then re-installs the plan under every `sourceBases`
 * entry (mirroring `registerMaterializedView`'s indexing) so a write to any of them fires
 * maintenance.
 */
function forceFullRebuild(db: Database, schemaName: string, name: string): FullRebuildPlanLike {
	const mgr = (db as unknown as ManagerHandle).materializedViewManager;
	const mv = db.schemaManager.getMaintainedTable(schemaName, name);
	expect(mv, `${schemaName}.${name} MV registered`).to.exist;
	const analyzed = db.schemaManager.withSuppressedMaterializedViewRewrite(
		() => db.optimizer.optimizeForAnalysis(db._buildPlan([mv!.derivation.selectAst as AST.Statement]).plan, db),
	);
	const plan = buildFloorPlan(db, mv, analyzed);
	const key = `${schemaName}.${name}`.toLowerCase();
	mgr.releaseRowTime(key);
	mgr.rowTime.set(key, plan as unknown as { kind: string });
	for (const base of plan.sourceBases) {
		let set = mgr.rowTimeBySource.get(base);
		if (!set) { set = new Set(); mgr.rowTimeBySource.set(base, set); }
		set.add(key);
	}
	return plan;
}

/** Build the analyzed plan for an arbitrary body (not necessarily a registered MV), the
 *  same pre-physical form `buildFullRebuildPlan` consumes. Used by the build-time reject
 *  tests to drive `buildFullRebuildPlan` directly over bag / non-deterministic bodies. */
function analyzeBody(db: Database, sql: string): unknown {
	const ast = new Parser().parseAll(sql)[0] as AST.Statement;
	return db.schemaManager.withSuppressedMaterializedViewRewrite(
		() => db.optimizer.optimizeForAnalysis(db._buildPlan([ast]).plan, db),
	);
}

/**
 * Single-source full-rebuild floor shapes. Each body is BOTH a bounded-delta shape (so
 * `create` produces a backing) AND a valid full-rebuild shape (a deterministic, keyed
 * set), so {@link forceFullRebuild} can swap the plan and the SAME equivalence property
 * proves the floor's re-evaluate-and-`replace-all` maintenance stays equal to the live
 * body — across inserts/updates/deletes (the `replace-all` keyed diff exercises
 * insert/update/delete/skip) and rollback.
 */
const FULL_REBUILD_SHAPES: readonly BodyShape[] = [
	{ label: 'keyed projection (id, a)', body: 'select id, a from src' },
	{ label: 'keyed projection + partial WHERE (k > 5)', body: 'select id, a, b from src where k > 5' },
	{ label: 'single-source aggregate (group by k)', body: 'select k, count(*) as c, sum(a) as s from src group by k' },
];

defineEquivalenceSuite(
	'Materialized-view maintenance equivalence (full-rebuild floor, single source)',
	FULL_REBUILD_SHAPES,
	db => { forceFullRebuild(db, 'main', 'mv'); },
);

/**
 * Full-rebuild floor — the **body-goes-empty** edge, asserted deterministically (the
 * property suites only reach it incidentally). When the body re-evaluates to zero rows the
 * `'replace-all' []` must empty the backing (every prior row a `delete`), and a subsequent
 * write must repopulate it from empty — exercising the empty↔non-empty transitions in both
 * directions, end-to-end through the floor arm rather than at the layer level.
 */
describe('Materialized-view maintenance equivalence (full-rebuild floor, body goes empty)', () => {
	let db: Database;
	const body = 'select id, a from src';
	beforeEach(async () => {
		db = new Database();
		await db.exec('create table src (id integer primary key, a integer, b integer, k integer)');
		await db.exec('insert into src (id, a, b, k) values (1, 0, 0, 6), (2, 3, 4, 2)');
		await db.exec(`create materialized view mv as ${body}`);
		forceFullRebuild(db, 'main', 'mv');
	});
	afterEach(async () => { await db.close(); });

	it('emptying every source row empties the backing, and a later insert repopulates it', async () => {
		await assertEquivalent(db, body, 'baseline');
		await db.exec('delete from src');
		expect((await readMultiset(db, 'select * from mv')).length, 'backing empty after all-delete').to.equal(0);
		await assertEquivalent(db, body, 'after all-delete');
		// Repopulate from empty: the next rebuild diffs against an empty before-image (all inserts).
		await db.exec('insert into src (id, a, b, k) values (7, 9, 0, 0)');
		expect((await readMultiset(db, 'select * from mv')).length, 'backing repopulated from empty').to.equal(1);
		await assertEquivalent(db, body, 'after repopulate');
	});
});

/**
 * Full-rebuild floor over a **NOCASE base-PK** body — the collation shape the integer-PK
 * floor suites above never reach (the existing NOCASE suite is the bounded-delta
 * `'prefix-delete'` arm, not the floor). The floor's `replace-all` diff pairs keys
 * collation-aware (the PK comparator: a new 'apple' pairs with a stored 'APPLE' → an
 * `update`, never a spurious insert + delete that would leak secondary-index bookkeeping)
 * but skips an unchanged paired row BYTE-faithfully (`rowsValueIdentical`): a collation-equal
 * / byte-different paired row (a case-only PK rewrite under NOCASE) re-keys the stored bytes.
 * Were the skip collation-aware (the prior `rowsEqual`), the rebuild would keep the stale
 * stored casing and `read(MV) != evaluate(body)` — the precise divergence this exercises. The
 * body is a bounded-delta keyed projection (so `create` builds a backing) swapped to
 * full-rebuild via {@link forceFullRebuild}; the oracle re-runs it live and the maintained
 * backing must equal it byte-exactly (`canonRow` is byte-faithful).
 */
describe('Materialized-view maintenance equivalence (full-rebuild floor, NOCASE PK)', () => {
	let db: Database;
	const body = 'select id, v from t';

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table t (id text collate nocase primary key, v integer)');
		// Mixed-case committed seed so a case-only rewrite changes the stored bytes.
		await db.exec("insert into t (id, v) values ('apple', 1), ('Banana', 2)");
		await db.exec(`create materialized view mv as ${body}`);
		forceFullRebuild(db, 'main', 'mv');
	});
	afterEach(async () => { await db.close(); });

	it('a case-only PK rewrite (same NOCASE key) re-keys the stored bytes via the full rebuild', async () => {
		// White-box guard: the NOCASE body really routes through the floor's `replace-all`
		// (the fixed path), not a bounded-delta arm that would re-key via delete + insert and
		// pass equivalence without exercising the byte-faithful skip under test.
		expect(registeredPlanKind(db, 'mv'), 'NOCASE body maintained by the full-rebuild floor').to.equal('full-rebuild');
		await assertEquivalent(db, body, 'baseline');
		// 'apple' → 'APPLE' is the SAME PK under NOCASE but a different stored byte value. The
		// rebuild's replace-all pairs the new 'APPLE' with the stored 'apple' (collation-aware
		// key identity → an update, not insert + delete) and, because the skip is byte-faithful,
		// re-keys the stored bytes to 'APPLE'. A collation-aware skip would (wrongly) keep 'apple'.
		await db.exec("update t set id = 'APPLE' where id = 'apple'");
		await assertEquivalent(db, body, 'after case-only rewrite');
		// Byte-exact: the stored id is now 'APPLE' (re-keyed), 'apple' is gone, 'Banana' untouched.
		const ids = await readMultiset(db, 'select distinct id from mv');
		expect(ids, 'old-case key re-keyed to the new byte value').to.deep.equal(
			[canonRow(['APPLE']), canonRow(['Banana'])].sort(),
		);
	});

	type TextMutation =
		| { readonly kind: 'insert'; readonly id: string; readonly v: number }
		| { readonly kind: 'update'; readonly id: string; readonly v: number }
		| { readonly kind: 'updateKey'; readonly oldId: string; readonly newId: string; readonly v: number }
		| { readonly kind: 'delete'; readonly id: string };

	// Single letters in both cases — `'a'`/`'A'` are the SAME PK under NOCASE, so inserts
	// collide (tolerated CONSTRAINT) and key-changes are sometimes case-only rewrites
	// (same NOCASE key, different stored bytes — the skip-fidelity case), sometimes real moves.
	const idArb = fc.constantFrom('a', 'A', 'b', 'B', 'c', 'C', 'd');
	const vArb = fc.integer({ min: 0, max: 9 });
	const textMutationArb: fc.Arbitrary<TextMutation> = fc.oneof(
		fc.record({ kind: fc.constant('insert' as const), id: idArb, v: vArb }),
		fc.record({ kind: fc.constant('update' as const), id: idArb, v: vArb }),
		fc.record({ kind: fc.constant('updateKey' as const), oldId: idArb, newId: idArb, v: vArb }),
		fc.record({ kind: fc.constant('delete' as const), id: idArb }),
	);
	const textSqlFor = (m: TextMutation): string => {
		switch (m.kind) {
			case 'insert': return `insert into t (id, v) values ('${m.id}', ${m.v})`;
			case 'update': return `update t set v = ${m.v} where id = '${m.id}'`;
			case 'updateKey': return `update t set id = '${m.newId}', v = ${m.v} where id = '${m.oldId}'`;
			case 'delete': return `delete from t where id = '${m.id}'`;
		}
	};

	it('read(MV) == evaluate(body) across random NOCASE-PK mutations incl. case-only rewrites, in-txn and after rollback', async () => {
		await fc.assert(fc.asyncProperty(
			fc.array(textMutationArb, { minLength: 1, maxLength: 12 }),
			async (mutations) => {
				await assertEquivalent(db, body, 'baseline');

				await db.exec('begin');
				try {
					for (const m of mutations) await execTolerant(db, textSqlFor(m));
					await assertEquivalent(db, body, 'in-transaction');
				} finally {
					await db.exec('rollback');
				}

				await assertEquivalent(db, body, 'post-rollback');
			},
		), { numRuns: 60 });
	});
});

/**
 * Full-rebuild floor over a **multi-source** body (a 1:1 inner join). The body reads two
 * sources, so the plan must be indexed under BOTH — a write to either `t` or `p` must
 * trigger the wholesale rebuild. (The 1:1 join is create-able via the join-residual arm, so
 * a backing exists for {@link forceFullRebuild} to reuse.) This is the end-to-end exercise
 * of `FullRebuildPlan.sourceBases` / `planSourceBases` that the single-source suite cannot
 * reach.
 */
describe('Materialized-view maintenance equivalence (full-rebuild floor, multi-source join)', () => {
	let db: Database;
	let plan: FullRebuildPlanLike;
	const body = 'select t.id, t.fk, p.name from t join p on t.fk = p.id';

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table p (id integer primary key, name text)');
		await db.exec('create table t (id integer primary key, fk integer not null references p(id))');
		await db.exec("insert into p (id, name) values (1, 'a'), (2, 'b'), (3, 'c'), (4, 'd')");
		await db.exec('insert into t (id, fk) values (1, 1), (2, 1), (3, 2), (4, 3)');
		await db.exec(`create materialized view mv as ${body}`);
		plan = forceFullRebuild(db, 'main', 'mv');
	});

	afterEach(async () => { await db.close(); });

	it('indexes the full-rebuild plan under every source the body reads', () => {
		expect(plan.kind).to.equal('full-rebuild');
		expect([...plan.sourceBases].sort()).to.deep.equal(['main.p', 'main.t']);
	});

	it('a lookup-side (p) write triggers a full rebuild that stays equal to the live body', async () => {
		await assertEquivalent(db, body, 'baseline');
		await db.exec("update p set name = 'A!' where id = 1");
		await assertEquivalent(db, body, 'after p name update');
		// Both t rows with fk=1 (ids 1, 2) re-read p.name = 'A!' — proving the p write fired maintenance.
		const rows = await readMultiset(db, "select id from mv where name = 'A!'");
		expect(rows.length, 'rows referencing updated p name').to.equal(2);
	});

	it('a driving-side (t) write triggers a full rebuild that stays equal to the live body', async () => {
		await assertEquivalent(db, body, 'baseline');
		await db.exec('delete from t where id = 2');
		await assertEquivalent(db, body, 'after t delete');
		expect((await readMultiset(db, 'select * from mv')).length, 'after t-delete row count').to.equal(3);
	});

	it('read(MV) == evaluate(body) across random t/p mutations, in-txn and after rollback', async () => {
		type JoinMut =
			| { readonly kind: 't-insert'; readonly id: number; readonly fk: number }
			| { readonly kind: 't-updateFk'; readonly id: number; readonly fk: number }
			| { readonly kind: 't-delete'; readonly id: number }
			| { readonly kind: 'p-updateName'; readonly id: number; readonly name: string };
		const joinMutArb: fc.Arbitrary<JoinMut> = fc.oneof(
			fc.record({ kind: fc.constant('t-insert' as const), id: fc.integer({ min: 1, max: 6 }), fk: fc.integer({ min: 1, max: 5 }) }),
			fc.record({ kind: fc.constant('t-updateFk' as const), id: fc.integer({ min: 1, max: 6 }), fk: fc.integer({ min: 1, max: 5 }) }),
			fc.record({ kind: fc.constant('t-delete' as const), id: fc.integer({ min: 1, max: 6 }) }),
			fc.record({ kind: fc.constant('p-updateName' as const), id: fc.integer({ min: 1, max: 4 }), name: fc.constantFrom('a', 'b', 'z') }),
		);
		const joinSql = (m: JoinMut): string => {
			switch (m.kind) {
				case 't-insert': return `insert into t (id, fk) values (${m.id}, ${m.fk})`;
				case 't-updateFk': return `update t set fk = ${m.fk} where id = ${m.id}`;
				case 't-delete': return `delete from t where id = ${m.id}`;
				case 'p-updateName': return `update p set name = '${m.name}' where id = ${m.id}`;
			}
		};
		await fc.assert(fc.asyncProperty(
			fc.array(joinMutArb, { minLength: 1, maxLength: 10 }),
			async (mutations) => {
				await assertEquivalent(db, body, 'baseline');
				await db.exec('begin');
				try {
					for (const m of mutations) await execTolerant(db, joinSql(m));
					await assertEquivalent(db, body, 'in-transaction');
				} finally {
					await db.exec('rollback');
				}
				await assertEquivalent(db, body, 'post-rollback');
			},
		), { numRuns: 40 });
	});
});

/**
 * Full-rebuild floor as an **MV-over-MV producer**: a full-rebuild producer's wholesale
 * `'replace-all'` still emits the minimal effective `BackingRowChange[]`, so the existing
 * cascade drives a consumer MV reading the producer's backing — exactly as the bounded-delta
 * arms do. Here the producer `mv_base` is swapped to full-rebuild and `mv_over` reads it; a
 * source write to `g` rebuilds `mv_base` and the realized delta must propagate into `mv_over`.
 */
describe('Materialized-view maintenance equivalence (full-rebuild floor, MV-over-MV cascade)', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table g (id integer primary key, v integer)');
		await db.exec('insert into g values (1, 5)');
		await db.exec('create materialized view mv_base as select id, v from g');
		await db.exec('create materialized view mv_over as select id, v from mv_base');
		// Maintain the PRODUCER by full-rebuild; the consumer stays inverse-projection.
		forceFullRebuild(db, 'main', 'mv_base');
	});
	afterEach(async () => { await db.close(); });

	const readOver = async (): Promise<Array<Record<string, number>>> => {
		const rows: Array<Record<string, number>> = [];
		for await (const r of db.eval('select id, v from mv_over order by id')) rows.push({ id: Number(r.id), v: Number(r.v) });
		return rows;
	};

	it("a full-rebuild producer's replace-all delta cascades into a consumer MV", async () => {
		expect(await readOver()).to.deep.equal([{ id: 1, v: 5 }]);
		// INSERT: producer rebuild emits an insert delta → consumer inserts.
		await db.exec('insert into g values (2, 7)');
		expect(await readOver()).to.deep.equal([{ id: 1, v: 5 }, { id: 2, v: 7 }]);
		// UPDATE: producer rebuild emits an update delta → consumer updates.
		await db.exec('update g set v = 50 where id = 1');
		expect(await readOver()).to.deep.equal([{ id: 1, v: 50 }, { id: 2, v: 7 }]);
		// DELETE: producer rebuild emits a delete delta → consumer deletes.
		await db.exec('delete from g where id = 2');
		expect(await readOver()).to.deep.equal([{ id: 1, v: 50 }]);
	});
});

/**
 * Build-time rejects of the full-rebuild floor (`buildFullRebuildPlan`), driven directly
 * (the builder is not yet reached from `create`). The floor accepts general bodies — its
 * only rejects are relational/determinism, NOT shape:
 *  - a **bag** body with no provable unique key (`keysOf` empty) — including the all-columns
 *    pseudo-key case, which `keysOf` already gates on `isSet`;
 *  - a **non-deterministic** body, unless `pragma nondeterministic_schema` lifts the gate.
 */
describe('Materialized-view full-rebuild floor — build-time rejects', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table src (id integer primary key, a integer, b integer, k integer)');
		await db.exec('insert into src (id, a, b, k) values (1, 0, 0, 6), (2, 3, 4, 2)');
		// A real keyed-set MV so a backing (the maintained table `okmv` itself, PK id) exists
		// for the cases that pass the relational/determinism gates and reach the backing lookup.
		await db.exec('create materialized view okmv as select id, a from src');
	});
	afterEach(async () => { await db.close(); });

	const okMv = (): unknown => db.schemaManager.getMaintainedTable('main', 'okmv');

	it('rejects a bag body (no provable unique key — a key-dropping projection) as not-a-set', () => {
		// The builder reads only name/schemaName before the bag gate throws (the maintained
		// table IS the backing now, so no separate backingTableName exists).
		const fakeMv = { name: 'bag', schemaName: 'main' };
		let caught: unknown;
		try { buildFloorPlan(db, fakeMv, analyzeBody(db, 'select a from src')); }
		catch (e) { caught = e; }
		expect(caught, 'a bag body must reject').to.be.instanceOf(QuereusError);
		expect((caught as QuereusError).code).to.equal(StatusCode.UNSUPPORTED);
		expect((caught as QuereusError).message).to.contain('no provable unique key');
		expect((caught as QuereusError).message).to.contain('must be a set');
		expect((caught as QuereusError).message).to.contain('bag');
	});

	it('a key-dropping projection that is a *set* via DISTINCT is accepted (all-columns key)', () => {
		// `select distinct a, k` drops the PK but DISTINCT makes it a provable set, so `keysOf`
		// returns the all-columns key (a, k) — NOT a bag. It reaches the backing lookup; the
		// okmv backing (PK id) does not match its shape, so it fails at the backing-PK derivation
		// rather than the bag gate. The point pinned here: it is NOT rejected as a bag.
		let caught: unknown;
		try { buildFloorPlan(db, okMv(), analyzeBody(db, 'select distinct a, k from src')); }
		catch (e) { caught = e; }
		// Either it builds (no throw) or it fails past the bag gate — never the bag diagnostic.
		if (caught !== undefined) {
			expect((caught as QuereusError).message, 'a DISTINCT set must not be rejected as a bag')
				.to.not.contain('no provable unique key');
		}
	});

	it('rejects a non-deterministic body unless pragma nondeterministic_schema is set', () => {
		// Keyed (id is the source PK) so the determinism gate — not the bag gate — fires.
		let caught: unknown;
		try { buildFloorPlan(db, okMv(), analyzeBody(db, 'select id, random() as r from src')); }
		catch (e) { caught = e; }
		expect(caught, 'a non-deterministic body must reject').to.be.instanceOf(QuereusError);
		expect((caught as QuereusError).code).to.equal(StatusCode.UNSUPPORTED);
		expect((caught as QuereusError).message).to.contain('non-deterministic');
	});

	it('accepts a non-deterministic body when pragma nondeterministic_schema is set', async () => {
		await db.exec('pragma nondeterministic_schema = true');
		// keysOf(id) is a key; determinism gate lifted; the okmv backing (PK id) matches the
		// (id, r) body's leading key column — so a plan is built (no throw).
		const plan = buildFloorPlan(db, okMv(), analyzeBody(db, 'select id, random() as r from src'));
		expect(plan.kind).to.equal('full-rebuild');
		expect(plan.sourceBases).to.deep.equal(['main.src']);
	});
});

/* ─────────────────── full-rebuild floor — per-statement flush deferral ─────────────────── */

/**
 * Count how many times the floor arm actually re-evaluates a body. Patches the manager's
 * `applyFullRebuild` instance method (shadowing the prototype), so every rebuild — the only
 * caller is the end-of-statement {@link MaterializedViewManager.flushDeferredRebuilds} drain,
 * since the DML boundary always defers — increments the counter. Install AFTER
 * {@link forceFullRebuild}. The deferral guarantee under test: N source rows touching one
 * full-rebuild MV in ONE statement ⇒ exactly ONE rebuild, not N.
 */
function instrumentRebuilds(db: Database): { count: () => number } {
	const mgr = (db as unknown as ManagerHandle).materializedViewManager as unknown as {
		applyFullRebuild: (...args: unknown[]) => Promise<unknown>;
	};
	let n = 0;
	const orig = mgr.applyFullRebuild;
	mgr.applyFullRebuild = function (this: unknown, ...args: unknown[]) {
		n++;
		return orig.apply(this, args);
	};
	return { count: () => n };
}

/**
 * The deferral the ticket adds: a full-rebuild MV is marked dirty per source row during the
 * DML row loop and rebuilt EXACTLY ONCE at the end-of-statement flush (inside the statement-
 * atomicity savepoint). These assert the observable consequences — one rebuild per bulk
 * statement, atomic rollback of a failed statement that dirtied an MV, autocommit flush+commit,
 * and a mixed (bounded-delta + full-rebuild) source staying consistent — that the per-row floor
 * could not give affordably.
 */
describe('Materialized-view maintenance equivalence (full-rebuild floor, per-statement flush)', () => {
	let db: Database;
	const body = 'select id, a from src';

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table src (id integer primary key, a integer, b integer, k integer)');
		await db.exec('insert into src (id, a, b, k) values (1, 0, 0, 6), (2, 3, 4, 2)');
		await db.exec(`create materialized view mv as ${body}`);
		forceFullRebuild(db, 'main', 'mv');
	});
	afterEach(async () => { await db.close(); });

	it('a bulk INSERT touching one full-rebuild MV rebuilds it EXACTLY ONCE (not per row)', async () => {
		const rebuilds = instrumentRebuilds(db);
		await db.exec('insert into src (id, a, b, k) values (10,1,1,1),(11,2,2,2),(12,3,3,3),(13,4,4,4),(14,5,5,5)');
		expect(rebuilds.count(), 'one rebuild for a 5-row bulk insert (deferred to the flush)').to.equal(1);
		// …and the single rebuild reflects every row of the bulk statement.
		await assertEquivalent(db, body, 'after bulk insert');
		expect((await readMultiset(db, 'select * from mv')).length, 'all rows present').to.equal(7);
	});

	it('a bulk UPDATE / DELETE each rebuild the MV exactly once', async () => {
		await db.exec('insert into src (id, a, b, k) values (10,1,1,1),(11,2,2,2),(12,3,3,3)');
		const rebuilds = instrumentRebuilds(db);
		await db.exec('update src set a = a + 100');
		expect(rebuilds.count(), 'one rebuild for the bulk update').to.equal(1);
		await assertEquivalent(db, body, 'after bulk update');
		await db.exec('delete from src where id >= 10');
		expect(rebuilds.count(), 'one more rebuild for the bulk delete').to.equal(2);
		await assertEquivalent(db, body, 'after bulk delete');
	});

	it('a multi-row statement that FAILS after dirtying the MV leaves the backing unchanged', async () => {
		const before = await readMultiset(db, 'select * from mv');
		const rebuilds = instrumentRebuilds(db);
		// Row 1 (id=10) writes the source and dirties the MV; row 2 (id=1) collides on the
		// source PK and aborts the whole statement. The flush never runs (the loop throws
		// first), and the statement savepoint reverts row 1's source write — so neither the
		// source nor the MV backing retains anything.
		await execTolerant(db, 'insert into src (id, a, b, k) values (10, 9, 9, 9), (1, 9, 9, 9), (11, 9, 9, 9)');
		expect(rebuilds.count(), 'a flush never ran for the aborted statement').to.equal(0);
		expect(await readMultiset(db, 'select * from mv'), 'MV backing unchanged after the abort').to.deep.equal(before);
		expect((await readMultiset(db, 'select id from src')).sort(), 'source unchanged after the abort')
			.to.deep.equal([canonRow([1]), canonRow([2])].sort());
		// And maintenance still works afterwards (the aborted statement left no orphaned dirty state).
		await db.exec('insert into src (id, a, b, k) values (12, 7, 7, 7)');
		await assertEquivalent(db, body, 'after a clean write following the abort');
	});

	it('an explicit-transaction ROLLBACK reverts a deferred rebuild in lockstep', async () => {
		await assertEquivalent(db, body, 'baseline');
		await db.exec('begin');
		await db.exec('insert into src (id, a, b, k) values (20, 1, 1, 1), (21, 2, 2, 2)');
		// The rebuild ran at the (in-transaction) statement flush — visible mid-transaction.
		await assertEquivalent(db, body, 'in-transaction');
		expect((await readMultiset(db, 'select * from mv')).length, 'rebuilt rows visible pre-commit').to.equal(4);
		await db.exec('rollback');
		// The rebuild rode the source write's transaction layer, so rollback discards it.
		await assertEquivalent(db, body, 'post-rollback');
		expect((await readMultiset(db, 'select * from mv')).length, 'reverted to baseline').to.equal(2);
	});

	it('a bare autocommit INSERT flushes and commits the rebuild together with the source write', async () => {
		// No BEGIN: the statement savepoint wraps the row loop + flush, then autocommit commits
		// both the source write and the rebuilt backing. Two consecutive autocommit writes must
		// both land — proving the first committed cleanly with no orphaned pending backing layer.
		await db.exec('insert into src (id, a, b, k) values (30, 1, 1, 1)');
		await assertEquivalent(db, body, 'after autocommit insert 1');
		await db.exec('insert into src (id, a, b, k) values (31, 2, 2, 2)');
		await assertEquivalent(db, body, 'after autocommit insert 2');
		expect((await readMultiset(db, 'select * from mv')).length, 'both autocommit writes persisted').to.equal(4);
	});
});

/**
 * A single source feeding BOTH a bounded-delta (inverse-projection) MV and a full-rebuild MV.
 * One write must maintain the incremental MV per-row during the loop AND the full-rebuild MV
 * once at the flush; both end consistent with their live bodies. Proves the deferral does not
 * disturb the per-row arms sharing the source.
 */
describe('Materialized-view maintenance equivalence (full-rebuild floor, mixed-arm same source)', () => {
	let db: Database;
	const incBody = 'select id, a from src';
	const fullBody = 'select id, b from src';

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table src (id integer primary key, a integer, b integer, k integer)');
		await db.exec('insert into src (id, a, b, k) values (1, 10, 100, 6), (2, 20, 200, 2)');
		await db.exec(`create materialized view mv_inc as ${incBody}`);
		await db.exec(`create materialized view mv_full as ${fullBody}`);
		// Only mv_full is the floor; mv_inc stays inverse-projection (per-row immediate).
		forceFullRebuild(db, 'main', 'mv_full');
	});
	afterEach(async () => { await db.close(); });

	const assertBoth = async (phase: string): Promise<void> => {
		const incFrom = await readMultiset(db, 'select * from mv_inc');
		const fullFrom = await readMultiset(db, 'select * from mv_full');
		const prev = db.optimizer.tuning;
		db.optimizer.updateTuning({ ...prev, disabledRules: new Set([...(prev.disabledRules ?? []), 'materialized-view-rewrite']) });
		let incBodyRows: string[]; let fullBodyRows: string[];
		try {
			incBodyRows = await readMultiset(db, incBody);
			fullBodyRows = await readMultiset(db, fullBody);
		} finally {
			db.optimizer.updateTuning(prev);
		}
		expect(incFrom, `${phase}: incremental MV diverged`).to.deep.equal(incBodyRows);
		expect(fullFrom, `${phase}: full-rebuild MV diverged`).to.deep.equal(fullBodyRows);
	};

	it('a single write keeps both the incremental and full-rebuild MV consistent (one rebuild)', async () => {
		const rebuilds = instrumentRebuilds(db);
		await db.exec('insert into src (id, a, b, k) values (3, 30, 300, 9), (4, 40, 400, 1)');
		expect(rebuilds.count(), 'the full-rebuild MV rebuilt once for the bulk insert').to.equal(1);
		await assertBoth('after mixed-arm bulk insert');
		await db.exec('update src set a = a + 1, b = b + 1 where id <= 2');
		expect(rebuilds.count(), 'one more rebuild for the bulk update').to.equal(2);
		await assertBoth('after mixed-arm bulk update');
		await db.exec('delete from src where id = 1');
		await assertBoth('after mixed-arm delete');
	});
});

/**
 * MV-over-MV with a **full-rebuild consumer over an incremental producer** — the converse of
 * the "full-rebuild producer → incremental consumer" suite above. A source write maintains the
 * incremental producer's backing inline during the loop; the consumer reads that backing, so it
 * is dirtied via the cascade and rebuilt at the flush, AFTER the producer's inline write has
 * landed (reads-own-writes at flush). The full rebuild must see the producer's just-updated
 * backing and stay equal to the live 2-level body.
 */
describe('Materialized-view maintenance equivalence (full-rebuild floor, full-rebuild consumer over incremental producer)', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table g (id integer primary key, v integer)');
		await db.exec('insert into g values (1, 5)');
		await db.exec('create materialized view mv_base as select id, v from g');
		await db.exec('create materialized view mv_over as select id, v from mv_base');
		// Maintain the CONSUMER by full-rebuild; the producer stays inverse-projection.
		forceFullRebuild(db, 'main', 'mv_over');
	});
	afterEach(async () => { await db.close(); });

	const readOver = async (): Promise<Array<Record<string, number>>> => {
		const rows: Array<Record<string, number>> = [];
		for await (const r of db.eval('select id, v from mv_over order by id')) rows.push({ id: Number(r.id), v: Number(r.v) });
		return rows;
	};

	it("an incremental producer's inline write drives the consumer's deferred full rebuild", async () => {
		const rebuilds = instrumentRebuilds(db);
		expect(await readOver()).to.deep.equal([{ id: 1, v: 5 }]);
		// INSERT: producer applies inline → cascade dirties the consumer → one rebuild at flush.
		await db.exec('insert into g values (2, 7), (3, 9)');
		expect(rebuilds.count(), 'one consumer rebuild for the bulk insert').to.equal(1);
		expect(await readOver()).to.deep.equal([{ id: 1, v: 5 }, { id: 2, v: 7 }, { id: 3, v: 9 }]);
		// UPDATE of a projected column: producer re-keys inline → consumer rebuild sees it.
		await db.exec('update g set v = 50 where id = 1');
		expect(await readOver()).to.deep.equal([{ id: 1, v: 50 }, { id: 2, v: 7 }, { id: 3, v: 9 }]);
		// DELETE: producer removes inline → consumer rebuild drops the row.
		await db.exec('delete from g where id = 2');
		expect(await readOver()).to.deep.equal([{ id: 1, v: 50 }, { id: 3, v: 9 }]);
	});
});

/* ════════════════ Comprehensive coverage net (mv-comprehensive-coverage-net) ════════════════
 *
 * The eligibility flip (`mv-eligibility-floor-fallthrough`) made a floor body SQL-reachable:
 * `buildMaintenancePlan` now routes any body no bounded-delta arm fits to `buildFullRebuildPlan`.
 * So the formerly-rejected shapes below are exercised END-TO-END through real `create
 * materialized view` + SQL writes (not the `forceFullRebuild` swap above), the same path a user
 * hits. Each suite proves `read(MV) == evaluate(body)` over random source mutation batches and
 * after rollback — the proof that no shape is a coverage gap. The fanning (non-1:1) join is the
 * one shape NOT here: it is a *bag* reject (`join-fanning-isset-overclaim`), pinned in
 * `materialized-view-diagnostics.spec.ts`, not an equivalence-zoo case.
 */

/** White-box: the registered maintenance plan kind for `main.<name>` (proves a shape really
 *  routes to the floor rather than being silently absorbed by a bounded-delta arm). */
function registeredPlanKind(db: Database, name: string): string | undefined {
	const mgr = (db as unknown as ManagerHandle).materializedViewManager as unknown as { rowTime: Map<string, { kind: string }> };
	return mgr.rowTime.get(`main.${name}`.toLowerCase())?.kind;
}

/** Read a query as a multiset with the answer-from-MV rewrite disabled — the live ground-truth
 *  oracle (re-evaluates against the sources, never re-pointed at a backing). Mirrors the
 *  rewrite-disable in {@link assertEquivalent} for queries that name something other than `mv`. */
async function readGroundTruth(db: Database, sql: string): Promise<string[]> {
	const prev = db.optimizer.tuning;
	db.optimizer.updateTuning({ ...prev, disabledRules: new Set([...(prev.disabledRules ?? []), 'materialized-view-rewrite']) });
	try { return await readMultiset(db, sql); } finally { db.optimizer.updateTuning(prev); }
}

/** Shadow the manager's private `assertFlushRounds` to capture the MAX deferred-rebuild
 *  flush-round count reached. A single-level flush converges in round 1; a full-rebuild→
 *  full-rebuild chain drives it to round 2+, exercising the multi-round worklist convergence
 *  (and the `assertFlushRounds` bound) that single-round drains never reach. */
function instrumentFlushRounds(db: Database): { max: () => number } {
	const mgr = (db as unknown as ManagerHandle).materializedViewManager as unknown as { assertFlushRounds: (n: number) => void };
	let max = 0;
	const orig = mgr.assertFlushRounds;
	mgr.assertFlushRounds = function (this: unknown, n: number) { if (n > max) max = n; return orig.call(this, n); };
	return { max: () => max };
}

/* ─────────── SQL-created single-source full-rebuild zoo (the same `src` generator) ─────────── */

/**
 * Single-source bodies that fit NO bounded-delta arm and so route to the full-rebuild floor —
 * created directly via SQL (not swapped). The shared `mutationArb` (insert / non-key update /
 * key-changing update / delete over `src`) drives them; the floor re-evaluates the whole body
 * at the end-of-statement flush and `replace-all`s the backing, so each must stay equal to the
 * live body — including the empty-source edge a `delete` reaches (a scalar aggregate still
 * yields its one global row; a DISTINCT / UNION yields none).
 */
const FULL_REBUILD_SQL_SHAPES: readonly BodyShape[] = [
	{ label: 'DISTINCT projection (a, b) — a set, keyed all-columns', body: 'select distinct a, b from src' },
	{ label: 'scalar aggregate (no GROUP BY) — one global row', body: 'select count(*) as c, sum(a) as s, min(b) as mn, max(b) as mx from src' },
	{ label: 'single-source UNION over disjoint WHERE legs (a set)', body: 'select id, a from src where k > 5 union select id, a from src where k <= 5' },
	{ label: 'order-by aggregate (non-group-key backing order → floor)', body: 'select k, sum(a) as s from src group by k order by sum(a)' },
];

defineEquivalenceSuite(
	'Materialized-view maintenance equivalence (full-rebuild floor, SQL-created single-source)',
	FULL_REBUILD_SQL_SHAPES,
);

/** White-box guard: each SQL-created floor shape must actually register a `'full-rebuild'`
 *  plan. If a future change let one fall into a bounded-delta arm, the equivalence suite above
 *  would still pass (the arm is also correct) but would no longer be testing the *floor* — this
 *  pins that it is. */
describe('Materialized-view full-rebuild floor — SQL-created shapes route to the floor (not a bounded arm)', () => {
	let db: Database;
	beforeEach(async () => {
		db = new Database();
		await db.exec('create table src (id integer primary key, a integer, b integer, k integer)');
		await db.exec('insert into src (id, a, b, k) values (1, 0, 0, 6), (2, 3, 4, 2), (3, 7, 1, 9)');
	});
	afterEach(async () => { await db.close(); });

	for (const shape of FULL_REBUILD_SQL_SHAPES) {
		it(`${shape.label} → chosenStrategy 'full-rebuild'`, async () => {
			await db.exec(`create materialized view mv as ${shape.body}`);
			expect(registeredPlanKind(db, 'mv'), shape.label).to.equal('full-rebuild');
		});
	}
});

/* ─────────── full-rebuild floor — outer (left) 1:1 join ─────────── */

/**
 * A LEFT (outer) join of the same `T.fk → P.id` shape the `'join-residual'` arm handles for an
 * inner join — but an outer join FALLS to the floor (its null-extended rows make the lookup-side
 * reverse residual unsound: filtering `P` would drop them). `t.fk` is nullable and carries NO FK
 * constraint, so a `t` row may reference a missing (or null) `p` and be **null-extended** — the
 * row preservation an inner join never produces. Random mutations drive both sources; the floor
 * re-evaluates the whole left join, so the maintained backing must equal the live body — null
 * rows and all — mid-transaction (reads-own-writes) and after rollback.
 */
describe('Materialized-view maintenance equivalence (full-rebuild floor, outer/left join)', () => {
	let db: Database;
	const body = 'select t.id, t.fk, p.name from t left join p on t.fk = p.id';

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table p (id integer primary key, name text)');
		await db.exec('create table t (id integer primary key, fk integer)'); // nullable, no FK constraint
		await db.exec("insert into p (id, name) values (1, 'a'), (2, 'b'), (3, 'c')");
		await db.exec('insert into t (id, fk) values (1, 1), (2, 9), (3, 2)'); // fk=9 has no matching p → null-extended
		await db.exec(`create materialized view mv as ${body}`);
	});
	afterEach(async () => { await db.close(); });

	it('routes to the full-rebuild floor (an outer join is not a bounded-delta arm)', () => {
		expect(registeredPlanKind(db, 'mv')).to.equal('full-rebuild');
	});

	type OuterMutation =
		| { readonly kind: 't-insert'; readonly id: number; readonly fk: number | null }
		| { readonly kind: 't-update'; readonly id: number; readonly fk: number | null }
		| { readonly kind: 't-updateKey'; readonly oldId: number; readonly newId: number; readonly fk: number | null }
		| { readonly kind: 't-delete'; readonly id: number }
		| { readonly kind: 'p-insert'; readonly id: number; readonly name: string }
		| { readonly kind: 'p-update'; readonly id: number; readonly name: string }
		| { readonly kind: 'p-delete'; readonly id: number };

	const idArb6 = fc.integer({ min: 1, max: 6 });
	// fk straddles matched (1..3), a fresh p key (4..5), an unmatched value (9), and NULL.
	const fkArb = fc.oneof(fc.integer({ min: 1, max: 5 }), fc.constant(9), fc.constant(null));
	const nameArb = fc.constantFrom('a', 'b', 'c', 'd', 'z');

	const outerArb: fc.Arbitrary<OuterMutation> = fc.oneof(
		fc.record({ kind: fc.constant('t-insert' as const), id: idArb6, fk: fkArb }),
		fc.record({ kind: fc.constant('t-update' as const), id: idArb6, fk: fkArb }),
		fc.record({ kind: fc.constant('t-updateKey' as const), oldId: idArb6, newId: idArb6, fk: fkArb }),
		fc.record({ kind: fc.constant('t-delete' as const), id: idArb6 }),
		fc.record({ kind: fc.constant('p-insert' as const), id: fc.integer({ min: 4, max: 5 }), name: nameArb }),
		fc.record({ kind: fc.constant('p-update' as const), id: fc.integer({ min: 1, max: 5 }), name: nameArb }),
		fc.record({ kind: fc.constant('p-delete' as const), id: fc.integer({ min: 1, max: 5 }) }),
	);

	const outerSql = (m: OuterMutation): string => {
		const fkLit = (v: number | null) => (v === null ? 'null' : `${v}`);
		switch (m.kind) {
			case 't-insert': return `insert into t (id, fk) values (${m.id}, ${fkLit(m.fk)})`;
			case 't-update': return `update t set fk = ${fkLit(m.fk)} where id = ${m.id}`;
			case 't-updateKey': return `update t set id = ${m.newId}, fk = ${fkLit(m.fk)} where id = ${m.oldId}`;
			case 't-delete': return `delete from t where id = ${m.id}`;
			case 'p-insert': return `insert into p (id, name) values (${m.id}, '${m.name}')`;
			case 'p-update': return `update p set name = '${m.name}' where id = ${m.id}`;
			case 'p-delete': return `delete from p where id = ${m.id}`;
		}
	};

	it('read(MV) == evaluate(body) across random t/p mutations (incl. null-extended), in-txn and after rollback', async () => {
		await fc.assert(fc.asyncProperty(
			fc.array(outerArb, { minLength: 1, maxLength: 12 }),
			async (mutations) => {
				await assertEquivalent(db, body, 'baseline');
				await db.exec('begin');
				try {
					for (const m of mutations) await execTolerant(db, outerSql(m));
					await assertEquivalent(db, body, 'in-transaction');
				} finally {
					await db.exec('rollback');
				}
				await assertEquivalent(db, body, 'post-rollback');
			},
		), { numRuns: 50 });
	});

	it('a t row referencing a missing p is preserved (null-extended) in the backing', async () => {
		await assertEquivalent(db, body, 'baseline');
		// id=2 (fk=9, no matching p) is kept by the LEFT join with a NULL lookup column. Read it
		// via the NATURAL `name is null` predicate: the backing's lookup column is now correctly
		// stamped nullable, so a pushed-down `name is null` null-checks at runtime rather than
		// folding to FALSE against a bogus NOT-NULL backing type (mv-outer-join-nullable-backing-isnull).
		expect(await readMultiset(db, 'select id from mv where name is null'), 'unmatched t row null-extended')
			.to.deep.equal([canonRow([2])]);
		// Deleting the only matching p (id=1) null-extends t id=1 too (no FK constraint blocks it).
		await db.exec('delete from p where id = 1');
		await assertEquivalent(db, body, 'after p delete null-extends its referencing t rows');
		// Now both id=1 (newly unmatched) and id=2 read `name is null`; id=3 (fk=2 → p exists) does not.
		expect(await readMultiset(db, 'select id from mv where name is null'), 'newly-unmatched t row null-extended')
			.to.deep.equal([canonRow([1]), canonRow([2])]);
		expect(await readMultiset(db, 'select id from mv where name is not null'), 'still-matched t row')
			.to.deep.equal([canonRow([3])]);
	});

	it('is null / is not null reads over the MV agree with the live body (MV-indistinguishable-from-view)', async () => {
		// The bug this pins: the backing's null-extended lookup column used to be stamped NOT NULL,
		// so `where name is null` folded to FALSE against the backing (empty) while the live left-join
		// body returned the null-extended rows — a read-side divergence the full `select *` equivalence
		// never exercises. With the column stamped nullable, the predicate reads must match the live body.
		// `assertEquivalent` already disables the read-side rewrite for the live oracle; mirror that here
		// so the wrapped live body re-evaluates from the source rather than the backing it defines.
		const assertPredEquiv = async (pred: string, phase: string): Promise<void> => {
			const fromMv = await readMultiset(db, `select id from mv where ${pred}`);
			const prev = db.optimizer.tuning;
			db.optimizer.updateTuning({ ...prev, disabledRules: new Set([...(prev.disabledRules ?? []), 'materialized-view-rewrite']) });
			let fromBody: string[];
			try {
				fromBody = await readMultiset(db, `select id from (${body}) where ${pred}`);
			} finally {
				db.optimizer.updateTuning(prev);
			}
			expect(fromMv, `${phase}: MV \`${pred}\` diverged from live body`).to.deep.equal(fromBody);
		};

		await assertPredEquiv('name is null', 'baseline is null');
		await assertPredEquiv('name is not null', 'baseline is not null');

		// Mutations that move rows across the matched/unmatched boundary: a new unmatched t row
		// (null-extended), and a p insert that suddenly matches the previously-unmatched fk=9 row.
		await db.exec('begin');
		try {
			await db.exec('insert into t (id, fk) values (5, 99)');     // fk=99: unmatched → null
			await db.exec("insert into p (id, name) values (9, 'x')");  // now t.id=2 (fk=9) matches
			await assertPredEquiv('name is null', 'in-txn is null');
			await assertPredEquiv('name is not null', 'in-txn is not null');
		} finally {
			await db.exec('rollback');
		}
		await assertPredEquiv('name is null', 'post-rollback is null');
		await assertPredEquiv('name is not null', 'post-rollback is not null');
	});
});

/* ─────────── full-rebuild floor — >2-source (3-way) join ─────────── */

/**
 * A 3-way join `a ⋈ b ⋈ c` over a NOT-NULL FK chain (`a.bid → b.id`, `b.cid → c.id`). The
 * `'join-residual'` arm handles only the **two**-table 1:1 join, so a third source routes the
 * body to the full-rebuild floor (which indexes the plan under all three bases — a write to any
 * of a/b/c rebuilds). Random mutations on every source (FK violations + RI-restricted deletes
 * tolerated as statement-atomic CONSTRAINT errors) keep the maintained backing equal to the live
 * 3-way join after every batch and after rollback.
 */
describe('Materialized-view maintenance equivalence (full-rebuild floor, >2-source join)', () => {
	let db: Database;
	const body = 'select a.id, b.id as bid, c.v from a join b on a.bid = b.id join c on b.cid = c.id';

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table c (id integer primary key, v integer)');
		await db.exec('create table b (id integer primary key, cid integer not null references c(id))');
		await db.exec('create table a (id integer primary key, bid integer not null references b(id))');
		await db.exec('insert into c (id, v) values (1, 10), (2, 20), (3, 30)');
		await db.exec('insert into b (id, cid) values (1, 1), (2, 2), (3, 1)');
		await db.exec('insert into a (id, bid) values (1, 1), (2, 2), (3, 3)');
		await db.exec(`create materialized view mv as ${body}`);
	});
	afterEach(async () => { await db.close(); });

	it('routes to the full-rebuild floor and indexes under all three sources', () => {
		const mgr = (db as unknown as ManagerHandle).materializedViewManager;
		const plan = mgr.rowTime.get('main.mv') as unknown as FullRebuildPlanLike;
		expect(plan.kind).to.equal('full-rebuild');
		expect([...plan.sourceBases].sort()).to.deep.equal(['main.a', 'main.b', 'main.c']);
	});

	type ThreeWay =
		| { readonly kind: 'a-insert'; readonly id: number; readonly bid: number }
		| { readonly kind: 'a-update'; readonly id: number; readonly bid: number }
		| { readonly kind: 'a-delete'; readonly id: number }
		| { readonly kind: 'b-insert'; readonly id: number; readonly cid: number }
		| { readonly kind: 'b-update'; readonly id: number; readonly cid: number }
		| { readonly kind: 'b-delete'; readonly id: number }
		| { readonly kind: 'c-insert'; readonly id: number; readonly v: number }
		| { readonly kind: 'c-update'; readonly id: number; readonly v: number }
		| { readonly kind: 'c-delete'; readonly id: number };

	const key4 = fc.integer({ min: 1, max: 4 });   // small spaces so FK references hit/miss
	const valArb2 = fc.integer({ min: 0, max: 99 });
	const threeArb: fc.Arbitrary<ThreeWay> = fc.oneof(
		fc.record({ kind: fc.constant('a-insert' as const), id: key4, bid: key4 }),
		fc.record({ kind: fc.constant('a-update' as const), id: key4, bid: key4 }),
		fc.record({ kind: fc.constant('a-delete' as const), id: key4 }),
		fc.record({ kind: fc.constant('b-insert' as const), id: key4, cid: key4 }),
		fc.record({ kind: fc.constant('b-update' as const), id: key4, cid: key4 }),
		fc.record({ kind: fc.constant('b-delete' as const), id: key4 }),
		fc.record({ kind: fc.constant('c-insert' as const), id: key4, v: valArb2 }),
		fc.record({ kind: fc.constant('c-update' as const), id: key4, v: valArb2 }),
		fc.record({ kind: fc.constant('c-delete' as const), id: key4 }),
	);
	const threeSql = (m: ThreeWay): string => {
		switch (m.kind) {
			case 'a-insert': return `insert into a (id, bid) values (${m.id}, ${m.bid})`;
			case 'a-update': return `update a set bid = ${m.bid} where id = ${m.id}`;
			case 'a-delete': return `delete from a where id = ${m.id}`;
			case 'b-insert': return `insert into b (id, cid) values (${m.id}, ${m.cid})`;
			case 'b-update': return `update b set cid = ${m.cid} where id = ${m.id}`;
			case 'b-delete': return `delete from b where id = ${m.id}`;
			case 'c-insert': return `insert into c (id, v) values (${m.id}, ${m.v})`;
			case 'c-update': return `update c set v = ${m.v} where id = ${m.id}`;
			case 'c-delete': return `delete from c where id = ${m.id}`;
		}
	};

	it('read(MV) == evaluate(body) across random a/b/c mutations, in-txn and after rollback', async () => {
		await fc.assert(fc.asyncProperty(
			fc.array(threeArb, { minLength: 1, maxLength: 14 }),
			async (mutations) => {
				await assertEquivalent(db, body, 'baseline');
				await db.exec('begin');
				try {
					for (const m of mutations) await execTolerant(db, threeSql(m));
					await assertEquivalent(db, body, 'in-transaction');
				} finally {
					await db.exec('rollback');
				}
				await assertEquivalent(db, body, 'post-rollback');
			},
		), { numRuns: 50 });
	});
});

/* ─────────── full-rebuild floor — recursive CTE (transitive closure) ─────────── */

/**
 * A recursive-CTE transitive-closure body over an `edge(src, dst)` graph — a set (the `union`
 * fixpoint dedupes), keyed all-columns `(a, b)`. Recursion fits no bounded-delta arm, so it routes
 * to the floor and is rebuilt wholesale per writing statement. Random edge inserts/deletes over a
 * small node space (so cycles and overlapping paths recur) keep the maintained closure equal to the
 * live recursive body after every batch and after rollback. (A recursive body reading NO source
 * table is a separate 'no source' reject — this one reads `edge`, so the floor maintains it.)
 */
describe('Materialized-view maintenance equivalence (full-rebuild floor, recursive CTE closure)', () => {
	let db: Database;
	const body = 'with recursive tc(a, b) as (select src, dst from edge union select t.a, e.dst from tc t join edge e on t.b = e.src) select a, b from tc';

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table edge (src integer, dst integer, primary key (src, dst))');
		await db.exec('insert into edge (src, dst) values (1, 2), (2, 3), (3, 4)');
		await db.exec(`create materialized view mv as ${body}`);
	});
	afterEach(async () => { await db.close(); });

	it('routes to the full-rebuild floor', () => {
		expect(registeredPlanKind(db, 'mv')).to.equal('full-rebuild');
	});

	type EdgeMutation =
		| { readonly kind: 'insert'; readonly src: number; readonly dst: number }
		| { readonly kind: 'delete'; readonly src: number; readonly dst: number };
	const node = fc.integer({ min: 1, max: 4 });
	const edgeArb: fc.Arbitrary<EdgeMutation> = fc.oneof(
		fc.record({ kind: fc.constant('insert' as const), src: node, dst: node }),
		fc.record({ kind: fc.constant('delete' as const), src: node, dst: node }),
	);
	const edgeSql = (m: EdgeMutation): string =>
		m.kind === 'insert'
			? `insert into edge (src, dst) values (${m.src}, ${m.dst})`
			: `delete from edge where src = ${m.src} and dst = ${m.dst}`;

	it('read(MV) == evaluate(closure) across random edge churn, in-txn and after rollback', async () => {
		await fc.assert(fc.asyncProperty(
			fc.array(edgeArb, { minLength: 1, maxLength: 10 }),
			async (mutations) => {
				await assertEquivalent(db, body, 'baseline');
				await db.exec('begin');
				try {
					for (const m of mutations) await execTolerant(db, edgeSql(m)); // tolerate PK-collision inserts
					await assertEquivalent(db, body, 'in-transaction');
				} finally {
					await db.exec('rollback');
				}
				await assertEquivalent(db, body, 'post-rollback');
			},
		), { numRuns: 30 });
	});

	it('adding a closing edge grows the closure (multi-hop reachability)', async () => {
		// Baseline 1→2→3→4 ⇒ closure {(1,2),(1,3),(1,4),(2,3),(2,4),(3,4)}.
		expect((await readMultiset(db, 'select a, b from mv')).length, 'baseline closure size').to.equal(6);
		// Add 4→1: now every node reaches every node (a 4-cycle) ⇒ 16 pairs.
		await db.exec('insert into edge (src, dst) values (4, 1)');
		await assertEquivalent(db, body, 'after closing the cycle');
		expect((await readMultiset(db, 'select a, b from mv')).length, 'full 4×4 reachability').to.equal(16);
	});
});

/* ─────────── full-rebuild → full-rebuild chain + diamond (multi-round flush) ─────────── */

/**
 * The shape that drives `flushDeferredRebuilds` PAST round 1: a full-rebuild producer feeding a
 * full-rebuild consumer. A source write dirties only the producer (round 1); the producer's
 * rebuild emits a delta that re-dirties the full-rebuild consumer, rebuilt in round 2. Until the
 * eligibility flip made the floor SQL-reachable, no test could build two chained floor MVs, so the
 * multi-round worklist convergence (and the `assertFlushRounds` bound) were unexercised. These
 * assert convergence AT EVERY LEVEL plus the observed round count.
 */
describe('Materialized-view maintenance equivalence (full-rebuild → full-rebuild chain, multi-round flush)', () => {
	let db: Database;
	// mv_p keyed (a, b); mv_c distinct-a over mv_p (a is NOT unique in mv_p, so DISTINCT really
	// dedupes → genuinely full-rebuild, not collapsed to a passthrough).
	beforeEach(async () => {
		db = new Database();
		await db.exec('create table src (id integer primary key, a integer, b integer)');
		await db.exec('insert into src (id, a, b) values (1, 10, 100), (2, 10, 200), (3, 20, 100)');
		await db.exec('create materialized view mv_p as select distinct a, b from src');
		await db.exec('create materialized view mv_c as select distinct a from mv_p');
	});
	afterEach(async () => { await db.close(); });

	const assertLevels = async (phase: string): Promise<void> => {
		expect(await readMultiset(db, 'select a, b from mv_p'), `${phase}: mv_p`)
			.to.deep.equal(await readGroundTruth(db, 'select distinct a, b from src'));
		// distinct-a of distinct-(a,b) of src == distinct-a of src.
		expect(await readMultiset(db, 'select a from mv_c'), `${phase}: mv_c`)
			.to.deep.equal(await readGroundTruth(db, 'select distinct a from src'));
	};

	it('both levels are full-rebuild', () => {
		expect(registeredPlanKind(db, 'mv_p'), 'producer').to.equal('full-rebuild');
		expect(registeredPlanKind(db, 'mv_c'), 'consumer').to.equal('full-rebuild');
	});

	it('a write that propagates drives the flush to round 2 (both levels converge)', async () => {
		await assertLevels('baseline');
		const rounds = instrumentFlushRounds(db);
		// Insert a brand-new `a` value → producer's distinct set changes → its rebuild re-dirties
		// the consumer, forcing a second flush round.
		await db.exec('insert into src (id, a, b) values (4, 30, 100)');
		expect(rounds.max(), 'producer rebuild re-dirties the consumer → round 2').to.equal(2);
		await assertLevels('after propagating insert');
		expect(await readMultiset(db, 'select a from mv_c')).to.deep.equal([canonRow([10]), canonRow([20]), canonRow([30])].sort());
	});

	it('read(both MVs) == evaluate(bodies) across random mutations, in-txn and after rollback', async () => {
		await fc.assert(fc.asyncProperty(
			fc.array(fc.record({
				kind: fc.constantFrom('insert', 'update', 'delete'),
				id: fc.integer({ min: 1, max: 6 }),
				a: fc.integer({ min: 10, max: 40 }),
				b: fc.integer({ min: 100, max: 400 }),
			}), { minLength: 1, maxLength: 8 }),
			async (muts) => {
				await assertLevels('baseline');
				await db.exec('begin');
				try {
					for (const m of muts) {
						const sql = m.kind === 'insert' ? `insert into src (id, a, b) values (${m.id}, ${m.a}, ${m.b})`
							: m.kind === 'update' ? `update src set a = ${m.a}, b = ${m.b} where id = ${m.id}`
								: `delete from src where id = ${m.id}`;
						await execTolerant(db, sql);
					}
					await assertLevels('in-transaction');
				} finally {
					await db.exec('rollback');
				}
				await assertLevels('post-rollback');
			},
		), { numRuns: 30 });
	});
});

/**
 * A full-rebuild DIAMOND: two full-rebuild producers (`mv_p1`, `mv_p2`) over one source feeding a
 * single full-rebuild consumer (`mv_c`, a `union` of both backings). One source write dirties both
 * producers (round 1); each re-dirties the shared consumer, which is deduped in the dirty set and
 * rebuilt ONCE in round 2 — the worklist's diamond-reconvergence.
 */
describe('Materialized-view maintenance equivalence (full-rebuild diamond, multi-round flush)', () => {
	let db: Database;
	beforeEach(async () => {
		db = new Database();
		await db.exec('create table src (id integer primary key, a integer, b integer)');
		await db.exec('insert into src (id, a, b) values (1, 10, 100), (2, 20, 200)');
		await db.exec('create materialized view mv_p1 as select distinct a from src');
		await db.exec('create materialized view mv_p2 as select distinct b from src');
		await db.exec('create materialized view mv_c as select a as x from mv_p1 union select b as x from mv_p2');
	});
	afterEach(async () => { await db.close(); });

	const groundTruthC = 'select a as x from src union select b as x from src';
	const assertDiamond = async (phase: string): Promise<void> => {
		expect(await readMultiset(db, 'select x from mv_c'), `${phase}: mv_c`)
			.to.deep.equal(await readGroundTruth(db, groundTruthC));
	};

	it('all three MVs are full-rebuild', () => {
		expect(registeredPlanKind(db, 'mv_p1')).to.equal('full-rebuild');
		expect(registeredPlanKind(db, 'mv_p2')).to.equal('full-rebuild');
		expect(registeredPlanKind(db, 'mv_c')).to.equal('full-rebuild');
	});

	it('a write through both producers reconverges the consumer in round 2', async () => {
		await assertDiamond('baseline');
		const rounds = instrumentFlushRounds(db);
		await db.exec('insert into src (id, a, b) values (3, 30, 300)');
		expect(rounds.max(), 'both producers (round 1) re-dirty the consumer → round 2').to.equal(2);
		await assertDiamond('after insert');
		expect((await readMultiset(db, 'select x from mv_c')).length, 'a-set ∪ b-set').to.equal(6);
	});

	it('read(consumer) == evaluate(union body) across random mutations, in-txn and after rollback', async () => {
		await fc.assert(fc.asyncProperty(
			fc.array(fc.record({
				kind: fc.constantFrom('insert', 'update', 'delete'),
				id: fc.integer({ min: 1, max: 6 }),
				a: fc.integer({ min: 10, max: 40 }),
				b: fc.integer({ min: 100, max: 400 }),
			}), { minLength: 1, maxLength: 8 }),
			async (muts) => {
				await assertDiamond('baseline');
				await db.exec('begin');
				try {
					for (const m of muts) {
						const sql = m.kind === 'insert' ? `insert into src (id, a, b) values (${m.id}, ${m.a}, ${m.b})`
							: m.kind === 'update' ? `update src set a = ${m.a}, b = ${m.b} where id = ${m.id}`
								: `delete from src where id = ${m.id}`;
						await execTolerant(db, sql);
					}
					await assertDiamond('in-transaction');
				} finally {
					await db.exec('rollback');
				}
				await assertDiamond('post-rollback');
			},
		), { numRuns: 25 });
	});
});

/* ─────────── full-rebuild floor — FAIL-mode (or fail) bulk statement ─────────── */

/**
 * `INSERT OR FAIL` keeps the rows that already succeeded (it runs with NO statement-scope
 * savepoint), so a mid-statement abort leaves the surviving source rows in place. The deferred
 * full-rebuild flush therefore must still run on the abort path — otherwise the floor backing
 * would lag the surviving rows mid-transaction. These pin that end-to-end: after a FAIL abort the
 * full-rebuild MV equals the live body over exactly the surviving rows, and a rollback reverts
 * the whole transaction (surviving rows + backing) in lockstep.
 */
describe('Materialized-view maintenance equivalence (full-rebuild floor, OR FAIL mid-statement abort)', () => {
	let db: Database;
	const body = 'select distinct v from g';

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table g (id integer primary key, v integer)');
		await db.exec('insert into g (id, v) values (1, 5)');
		await db.exec(`create materialized view mv as ${body}`);
	});
	afterEach(async () => { await db.close(); });

	it('an OR FAIL abort keeps prior rows AND flushes their full-rebuild MV (mv == live body)', async () => {
		expect(registeredPlanKind(db, 'mv')).to.equal('full-rebuild');
		await db.exec('begin');
		// Row (10,9) inserts and dirties the floor MV; (1,9) collides on the PK → FAIL stops the
		// statement but KEEPS (10,9); (11,11) never runs.
		let threw = false;
		try { await db.exec('insert or fail into g (id, v) values (10, 9), (1, 9), (11, 11)'); }
		catch { threw = true; }
		expect(threw, 'OR FAIL surfaces the conflict error').to.be.true;
		// The surviving row is present in the source…
		expect((await readMultiset(db, 'select id, v from g')).sort(), 'prior row kept')
			.to.deep.equal([canonRow([1, 5]), canonRow([10, 9])].sort());
		// …and the deferred flush ran on the abort path, so the floor MV reflects it.
		await assertEquivalent(db, body, 'after OR FAIL abort');
		expect(await readMultiset(db, 'select v from mv'), 'backing reflects the surviving rows')
			.to.deep.equal([canonRow([5]), canonRow([9])].sort());
		// A clean follow-on write still maintains correctly (no orphaned dirty state).
		await db.exec('insert into g (id, v) values (12, 13)');
		await assertEquivalent(db, body, 'after a clean follow-on write');
		await db.exec('rollback');
		// The whole transaction reverts — source and backing in lockstep.
		expect(await readMultiset(db, 'select v from mv'), 'reverted to the committed baseline')
			.to.deep.equal([canonRow([5])]);
		await assertEquivalent(db, body, 'post-rollback');
	});

	it('OR FAIL over a source feeding BOTH a floor and an inverse-projection MV keeps both consistent', async () => {
		await db.exec('create materialized view mv_inc as select id, v from g'); // bounded-delta, per-row immediate
		expect(registeredPlanKind(db, 'mv_inc')).to.equal('inverse-projection');
		await db.exec('begin');
		try { await db.exec('insert or fail into g (id, v) values (20, 21), (1, 99), (22, 23)'); } catch { /* expected */ }
		// mv_inc (per-row immediate): the failing row's per-row savepoint reverted its own write,
		// the surviving row (20,21) landed. mv (floor): flushed on the abort path.
		await assertEquivalent(db, body, 'floor MV after OR FAIL');
		const incFrom = await readMultiset(db, 'select * from mv_inc');
		expect(incFrom.sort(), 'inverse-projection MV reflects the surviving rows')
			.to.deep.equal([canonRow([1, 5]), canonRow([20, 21])].sort());
		await db.exec('rollback');
	});
});

/* ───────────────── no-op maintenance write suppression (per arm) ───────────────── */

/**
 * Value-identical (no-op) maintenance write suppression (`mv-noop-upsert-suppression`):
 * a source write whose recomputed backing image is value-identical to the existing
 * effective backing row produces **zero effective `BackingRowChange`s** — no backing op,
 * no cascade — in every bounded-delta arm. Instrumented by wrapping the manager's two
 * apply seams: the per-row `applyMaintenancePlan` dispatch (the inverse-projection arm,
 * still per-row-immediate) and the end-of-statement `applyResidualBatch` flush (the
 * residual arms, whose accumulated statement keys recompute once at flush). Either
 * seam's return value is exactly what drives the MV-over-MV cascade, so these
 * assertions pin what a consumer MV would observe.
 * Regression cases pin that real changes, key-changing updates, emptied groups/fan-outs,
 * and predicate-scope transitions still report — the suppression never skips a real
 * change (the equivalence property suites above are the exhaustive oracle for that).
 */
describe('Materialized-view maintenance no-op write suppression', () => {
	interface AppliedRecord { mv: string; kind: string; changes: Array<{ op: string }> }
	interface DispatchingManager {
		applyMaintenancePlan(plan: { kind: string; mv: { name: string } }, ...rest: unknown[]): Promise<Array<{ op: string }>>;
		applyResidualBatch(plan: { kind: string; mv: { name: string } }, ...rest: unknown[]): Promise<Array<{ op: string }>>;
	}

	/** Record every apply-seam invocation (per-row dispatch + residual statement flush):
	 *  plan kind, MV name, effective changes. */
	function instrument(db: Database): AppliedRecord[] {
		const records: AppliedRecord[] = [];
		const mgr = (db as unknown as ManagerHandle).materializedViewManager as unknown as DispatchingManager;
		for (const seam of ['applyMaintenancePlan', 'applyResidualBatch'] as const) {
			const orig = mgr[seam].bind(mgr);
			mgr[seam] = async (plan, ...rest) => {
				const changes = await orig(plan, ...rest);
				records.push({ mv: plan.mv.name, kind: plan.kind, changes });
				return changes;
			};
		}
		return records;
	}

	const allOps = (records: AppliedRecord[]): string[] => records.flatMap(r => r.changes.map(c => c.op));
	const totalChanges = (records: AppliedRecord[]): number => allOps(records).length;

	describe('inverse-projection arm', () => {
		let db: Database;
		let records: AppliedRecord[];
		const body = 'select id, a from src';

		beforeEach(async () => {
			db = new Database();
			await db.exec('create table src (id integer primary key, a integer, b integer)');
			await db.exec('insert into src values (1, 10, 100), (2, 20, 200)');
			await db.exec(`create materialized view mv as ${body}`);
			records = instrument(db);
		});
		afterEach(async () => { await db.close(); });

		it('an update to an unprojected column reports zero effective changes', async () => {
			await db.exec('update src set b = 999 where id = 1');
			expect(records.length, 'maintenance was dispatched').to.be.greaterThan(0);
			expect(totalChanges(records), 'no effective backing change').to.equal(0);
			await assertEquivalent(db, body, 'after unprojected-column update');
		});

		it('rewriting a projected column to its current value reports zero effective changes', async () => {
			await db.exec('update src set a = 10 where id = 1');
			expect(totalChanges(records)).to.equal(0);
			await assertEquivalent(db, body, 'after same-value rewrite');
		});

		it('a real same-key change reports a single update (upsert-only, no delete-first)', async () => {
			await db.exec('update src set a = 11 where id = 1');
			expect(allOps(records)).to.deep.equal(['update']);
			await assertEquivalent(db, body, 'after real change');
		});

		it('regression: a key-changing update still reports both keys', async () => {
			await db.exec('update src set id = 5 where id = 1');
			expect(allOps(records).sort()).to.deep.equal(['delete', 'insert']);
			await assertEquivalent(db, body, 'after key change');
		});
	});

	describe('inverse-projection arm + partial WHERE', () => {
		let db: Database;
		let records: AppliedRecord[];
		const body = 'select id, a from src where a > 5';

		beforeEach(async () => {
			db = new Database();
			await db.exec('create table src (id integer primary key, a integer, b integer)');
			await db.exec('insert into src values (1, 10, 100), (2, 2, 200)'); // id 1 in scope, id 2 out
			await db.exec(`create materialized view mv as ${body}`);
			records = instrument(db);
		});
		afterEach(async () => { await db.close(); });

		it('an unprojected-column update on an in-scope row reports zero effective changes', async () => {
			await db.exec('update src set b = 999 where id = 1');
			expect(totalChanges(records)).to.equal(0);
			await assertEquivalent(db, body, 'after in-scope unprojected update');
		});

		it('regression: a scope exit still reports its delete', async () => {
			await db.exec('update src set a = 1 where id = 1');
			expect(allOps(records)).to.deep.equal(['delete']);
			await assertEquivalent(db, body, 'after scope exit');
		});

		it('regression: a scope entry still reports its insert', async () => {
			await db.exec('update src set a = 9 where id = 2');
			expect(allOps(records)).to.deep.equal(['insert']);
			await assertEquivalent(db, body, 'after scope entry');
		});
	});

	describe('inverse-projection arm + NOCASE backing key', () => {
		let db: Database;
		let records: AppliedRecord[];
		const body = 'select id, v from t';

		beforeEach(async () => {
			db = new Database();
			await db.exec('create table t (id text collate nocase primary key, v integer)');
			await db.exec("insert into t (id, v) values ('apple', 1), ('Banana', 2)");
			await db.exec(`create materialized view mv as ${body}`);
			records = instrument(db);
		});
		afterEach(async () => { await db.close(); });

		it('a case-only key rewrite (collation-equal, byte-different) reports a single update and re-keys', async () => {
			// White-box guard: this NOCASE projection really is the bounded-delta
			// covering-index arm (not the floor), so the single-update path under test
			// is the inverse-projection upsert-only branch.
			expect(registeredPlanKind(db, 'mv'), 'NOCASE projection maintained by inverse-projection').to.equal('inverse-projection');
			// 'apple' → 'APPLE' is the SAME backing key under NOCASE (collation-equal key
			// identity) but a different stored byte value: one upsert, host reports one
			// `update` — no delete-first pairing.
			await db.exec("update t set id = 'APPLE' where id = 'apple'");
			expect(allOps(records)).to.deep.equal(['update']);
			// The upsert re-keyed the stored bytes at the unchanged key identity.
			const ids = await readMultiset(db, 'select id from mv');
			expect(ids.sort(), 'stored bytes re-keyed to the new casing').to.deep.equal(
				[canonRow(['APPLE']), canonRow(['Banana'])].sort(),
			);
			await assertEquivalent(db, body, 'after case-only key rewrite');
		});
	});

	describe('residual-recompute (aggregate) arm', () => {
		let db: Database;
		let records: AppliedRecord[];
		const body = 'select k, count(*) as c, sum(a) as s from src group by k';

		beforeEach(async () => {
			db = new Database();
			await db.exec('create table src (id integer primary key, a integer, b integer, k integer)');
			await db.exec('insert into src values (1, 1, 5, 1), (2, 2, 6, 1), (3, 3, 7, 2)');
			await db.exec(`create materialized view mv as ${body}`);
			records = instrument(db);
		});
		afterEach(async () => { await db.close(); });

		it('an update outside the group key and aggregated columns reports zero effective changes', async () => {
			await db.exec('update src set b = 99 where id = 1');
			expect(records.length, 'maintenance was dispatched').to.be.greaterThan(0);
			expect(totalChanges(records)).to.equal(0);
			await assertEquivalent(db, body, 'after unaggregated-column update');
		});

		it('a same-value rewrite of an aggregated column reports zero effective changes', async () => {
			await db.exec('update src set a = 1 where id = 1');
			expect(totalChanges(records)).to.equal(0);
			await assertEquivalent(db, body, 'after same-value rewrite');
		});

		it('regression: a real aggregate change reports a single update (no delete+insert churn)', async () => {
			await db.exec('update src set a = 5 where id = 1');
			expect(allOps(records)).to.deep.equal(['update']);
			await assertEquivalent(db, body, 'after real aggregate change');
		});

		it('regression: an emptied group still reports its delete', async () => {
			await db.exec('delete from src where k = 2'); // id 3 is the lone k=2 row
			expect(allOps(records)).to.deep.equal(['delete']);
			await assertEquivalent(db, body, 'after emptied group');
		});

		it('regression: a group-key move still reports both groups', async () => {
			await db.exec('update src set k = 2 where id = 1');
			expect(totalChanges(records), 'both groups recomputed and reported').to.be.greaterThan(0);
			await assertEquivalent(db, body, 'after group move');
		});
	});

	describe('prefix-delete (lateral TVF fan-out) arm', () => {
		let db: Database;
		let records: AppliedRecord[];
		const body = 'select src.id, f.value from src cross join lateral generate_series(1, src.a) f';

		beforeEach(async () => {
			db = new Database();
			await db.exec('create table src (id integer primary key, a integer, b integer)');
			await db.exec('insert into src values (1, 3, 0), (2, 2, 0)');
			await db.exec(`create materialized view mv as ${body}`);
			records = instrument(db);
		});
		afterEach(async () => { await db.close(); });

		it('an update outside the projection and fan-out driver reports zero effective changes', async () => {
			await db.exec('update src set b = 42 where id = 1');
			expect(records.length, 'maintenance was dispatched').to.be.greaterThan(0);
			expect(totalChanges(records)).to.equal(0);
			await assertEquivalent(db, body, 'after unprojected-column update');
		});

		it('a same-value rewrite of the fan-out driver reports zero effective changes', async () => {
			await db.exec('update src set a = 3 where id = 1');
			expect(totalChanges(records)).to.equal(0);
			await assertEquivalent(db, body, 'after same-value rewrite');
		});

		it('regression: a shrunk fan-out reports exactly the disappeared row (minimal diff)', async () => {
			await db.exec('update src set a = 2 where id = 1'); // 3 → 2: only (1,3) disappears
			expect(allOps(records)).to.deep.equal(['delete']);
			await assertEquivalent(db, body, 'after shrink');
		});

		it('regression: a grown fan-out reports exactly the appeared row', async () => {
			await db.exec('update src set a = 4 where id = 1'); // 3 → 4: only (1,4) appears
			expect(allOps(records)).to.deep.equal(['insert']);
			await assertEquivalent(db, body, 'after growth');
		});

		it('regression: an emptied fan-out still reports every delete', async () => {
			await db.exec('update src set a = 0 where id = 1'); // whole 3-row slice disappears
			expect(allOps(records)).to.deep.equal(['delete', 'delete', 'delete']);
			await assertEquivalent(db, body, 'after emptied fan-out');
		});
	});

	describe('join-residual arm (forward and upsert-only lookup sides)', () => {
		let db: Database;
		let records: AppliedRecord[];
		const body = 'select t.id, t.fk, p.name from t join p on t.fk = p.id';

		beforeEach(async () => {
			db = new Database();
			await db.exec('create table p (id integer primary key, name text, pad integer)');
			await db.exec('create table t (id integer primary key, fk integer not null references p(id), pad integer)');
			await db.exec("insert into p values (1, 'a', 0), (2, 'b', 0)");
			await db.exec('insert into t values (1, 1, 0), (2, 1, 0), (3, 2, 0)');
			await db.exec(`create materialized view mv as ${body}`);
			records = instrument(db);
		});
		afterEach(async () => { await db.close(); });

		it('a driving-side (t) update to an unprojected column reports zero effective changes', async () => {
			await db.exec('update t set pad = 7 where id = 1');
			expect(records.length, 'maintenance was dispatched').to.be.greaterThan(0);
			expect(totalChanges(records)).to.equal(0);
			await assertEquivalent(db, body, 'after t unprojected update');
		});

		it('a lookup-side (p) update to an unprojected column reports zero effective changes', async () => {
			await db.exec('update p set pad = 7 where id = 1'); // two referencing t rows recompute identically
			expect(records.length, 'maintenance was dispatched').to.be.greaterThan(0);
			expect(totalChanges(records)).to.equal(0);
			await assertEquivalent(db, body, 'after p unprojected update');
		});

		it('regression: a lookup-side projected change reports one update per referencing row', async () => {
			await db.exec("update p set name = 'X' where id = 1");
			expect(allOps(records)).to.deep.equal(['update', 'update']);
			await assertEquivalent(db, body, 'after p projected change');
		});
	});

	describe('join-residual arm (delete-capable P-referencing WHERE)', () => {
		let db: Database;
		let records: AppliedRecord[];
		const body = 'select t.id, t.fk, p.name, p.score from t join p on t.fk = p.id where p.score > 5';

		beforeEach(async () => {
			db = new Database();
			await db.exec('create table p (id integer primary key, name text, score integer, pad integer)');
			await db.exec('create table t (id integer primary key, fk integer not null references p(id))');
			// p1 out of scope (score 3), p2 in scope (score 7); two t rows reference each.
			await db.exec("insert into p values (1, 'a', 3, 0), (2, 'b', 7, 0)");
			await db.exec('insert into t values (1, 1), (2, 1), (3, 2), (4, 2)');
			await db.exec(`create materialized view mv as ${body}`);
			records = instrument(db);
		});
		afterEach(async () => { await db.close(); });

		it('an in-scope p update to an unprojected column reports zero effective changes (no member churn)', async () => {
			// Formerly: every member deleted then re-upserted (delete+insert per referencing
			// row). The keyed diff + host skip-identical upsert reduce it to nothing.
			await db.exec('update p set pad = 1 where id = 2');
			expect(records.length, 'maintenance was dispatched').to.be.greaterThan(0);
			expect(totalChanges(records)).to.equal(0);
			await assertEquivalent(db, body, 'after in-scope unprojected p update');
		});

		it('regression: a scope exit still deletes every member', async () => {
			await db.exec('update p set score = 1 where id = 2');
			expect(allOps(records).sort()).to.deep.equal(['delete', 'delete']);
			await assertEquivalent(db, body, 'after scope exit');
		});

		it('regression: a scope entry still inserts every member', async () => {
			await db.exec('update p set score = 9 where id = 1');
			expect(allOps(records).sort()).to.deep.equal(['insert', 'insert']);
			await assertEquivalent(db, body, 'after scope entry');
		});
	});

	describe('MV-over-MV cascade suppression', () => {
		let db: Database;
		let records: AppliedRecord[];

		beforeEach(async () => {
			db = new Database();
			await db.exec('create table src (id integer primary key, a integer, b integer)');
			await db.exec('insert into src values (1, 10, 100)');
			await db.exec('create materialized view mv1 as select id, a from src');
			await db.exec('create materialized view mv2 as select id, a from mv1');
			records = instrument(db);
		});
		afterEach(async () => { await db.close(); });

		it('a suppressed producer write fires no consumer maintenance at all', async () => {
			await db.exec('update src set b = 9 where id = 1'); // unprojected by mv1
			const producer = records.filter(r => r.mv === 'mv1');
			expect(producer.length, 'producer maintenance dispatched').to.be.greaterThan(0);
			expect(totalChanges(producer), 'producer reported nothing').to.equal(0);
			expect(records.filter(r => r.mv === 'mv2'), 'consumer never dispatched').to.deep.equal([]);
		});

		it('regression: a real producer change still cascades into the consumer', async () => {
			await db.exec('update src set a = 11 where id = 1');
			expect(records.some(r => r.mv === 'mv2' && r.changes.length > 0), 'consumer maintained').to.equal(true);
			// Cascade cost (the ticket's headline motivation): a same-key producer change
			// reports one `update`, so the consumer is dispatched for one update — not the
			// twice-dispatched delete+insert pair the pre-unification arm produced.
			expect(allOps(records.filter(r => r.mv === 'mv2')), 'consumer sees a single update, not delete+insert')
				.to.deep.equal(['update']);
			expect(await readMultiset(db, 'select * from mv2')).to.deep.equal([canonRow([1, 11])]);
		});
	});
});

/* ─────────── negative self-test (the net must not silently degenerate) ─────────── */

/**
 * The whole net rests on {@link assertEquivalent} actually FAILING when the backing diverges from
 * the body. If a refactor accidentally made it vacuous (e.g. comparing the backing to itself), every
 * suite above would pass green while testing nothing. This deliberately feeds a WRONG oracle body
 * and asserts the comparison reddens — so a degenerate harness is caught.
 */
describe('Materialized-view maintenance equivalence — negative self-test (a wrong oracle must red)', () => {
	let db: Database;
	beforeEach(async () => {
		db = new Database();
		await db.exec('create table src (id integer primary key, a integer, b integer, k integer)');
		await db.exec('insert into src (id, a, b, k) values (1, 0, 0, 6), (2, 3, 4, 2)');
		await db.exec('create materialized view mv as select id, a from src'); // backing = {(1,0),(2,3)}
	});
	afterEach(async () => { await db.close(); });

	it('assertEquivalent throws when the oracle body does not match the backing', async () => {
		// Correct body passes.
		await assertEquivalent(db, 'select id, a from src', 'control (correct oracle)');
		// A deliberately wrong oracle (projects `b`, not `a`) must make the comparison fail.
		let caught: unknown;
		try { await assertEquivalent(db, 'select id, b from src', 'sabotage'); }
		catch (e) { caught = e; }
		expect(caught, 'the equivalence check must red on a mismatched oracle').to.not.be.undefined;
	});
});

/* ─────────────── residual arms — per-statement key batching + flush ─────────────── */

/**
 * The statement batching this ticket adds for the residual arms
 * (`'residual-recompute'` / `'prefix-delete'` / `'join-residual'`): affected binding keys
 * accumulate (deduped) across the statement's row loop and each distinct key's residual
 * runs ONCE at the end-of-statement flush (`applyResidualBatch`), instead of once per
 * touching source row. These pin the observable consequences — one flush per statement
 * with statement-wide key dedup, no per-row dispatch for residual arms, unchanged
 * between-statement visibility inside a transaction, the per-statement
 * degrade-to-rebuild demotion (and its stateless revert), the OR FAIL error-path drain,
 * and a mixed-arm MV-over-MV chain converging in one statement flush. The equivalence
 * property suites above (now with multi-row mutation statements) are the exhaustive
 * correctness oracle; these are the mechanism pins.
 */
describe('Materialized-view maintenance statement batching (residual arms)', () => {
	interface ResidualEntryLike { forward: Map<string, unknown>; lookup: Map<string, unknown>; prefix: Map<string, unknown> }
	interface SeamRecord { seam: string; mv: string; kind: string; distinctKeys: number; changes: Array<{ op: string }> }
	interface BatchSeamManager {
		applyMaintenancePlan(plan: { kind: string; mv: { name: string } }, ...rest: unknown[]): Promise<Array<{ op: string }>>;
		applyResidualBatch(plan: { kind: string; mv: { name: string } }, entry: ResidualEntryLike, ...rest: unknown[]): Promise<Array<{ op: string }>>;
		applyReplaceAll(plan: { kind: string; mv: { name: string } }, ...rest: unknown[]): Promise<Array<{ op: string }>>;
		rowTime: Map<string, { kind: string; sourceStats: { tableRows: number; forwardBodyCost: number; fallbackRatio?: number } }>;
	}

	function seamManager(db: Database): BatchSeamManager {
		return (db as unknown as ManagerHandle).materializedViewManager as unknown as BatchSeamManager;
	}

	/** Record every apply-seam invocation with the MV, plan kind, and (for the residual
	 *  flush) the batch's distinct-key count. */
	function instrumentSeams(db: Database): SeamRecord[] {
		const records: SeamRecord[] = [];
		const mgr = seamManager(db);
		const origDispatch = mgr.applyMaintenancePlan.bind(mgr);
		mgr.applyMaintenancePlan = async (plan, ...rest) => {
			const changes = await origDispatch(plan, ...rest);
			records.push({ seam: 'dispatch', mv: plan.mv.name, kind: plan.kind, distinctKeys: 1, changes });
			return changes;
		};
		const origBatch = mgr.applyResidualBatch.bind(mgr);
		mgr.applyResidualBatch = async (plan, entry, ...rest) => {
			const distinctKeys = entry.forward.size + entry.lookup.size + entry.prefix.size;
			const changes = await origBatch(plan, entry, ...rest);
			records.push({ seam: 'residual-flush', mv: plan.mv.name, kind: plan.kind, distinctKeys, changes });
			return changes;
		};
		const origReplace = mgr.applyReplaceAll.bind(mgr);
		mgr.applyReplaceAll = async (plan, ...rest) => {
			const changes = await origReplace(plan, ...rest);
			records.push({ seam: 'replace-all', mv: plan.mv.name, kind: plan.kind, distinctKeys: 0, changes });
			return changes;
		};
		return records;
	}

	/** Read a body LIVE (read-side MV rewrite disabled), as an order-insensitive multiset —
	 *  the multi-MV analogue of {@link assertEquivalent}'s oracle read. */
	async function readOracle(db: Database, body: string): Promise<string[]> {
		const prev = db.optimizer.tuning;
		db.optimizer.updateTuning({ ...prev, disabledRules: new Set([...(prev.disabledRules ?? []), 'materialized-view-rewrite']) });
		try {
			return await readMultiset(db, body);
		} finally {
			db.optimizer.updateTuning(prev);
		}
	}

	describe('aggregate (residual-recompute) arm', () => {
		let db: Database;
		const body = 'select k, count(*) as c, sum(a) as s from src group by k';

		beforeEach(async () => {
			db = new Database();
			await db.exec('create table src (id integer primary key, a integer, b integer, k integer)');
			await db.exec('insert into src (id, a, b, k) values (1, 1, 0, 1), (2, 2, 0, 2)');
			await db.exec(`create materialized view mv as ${body}`);
			expect(registeredPlanKind(db, 'mv')).to.equal('residual-recompute');
		});
		afterEach(async () => { await db.close(); });

		it('a multi-row statement flushes ONCE with statement-wide key dedup (no per-row dispatch)', async () => {
			const records = instrumentSeams(db);
			// 6 rows, 2 distinct groups (k=1, k=2), one statement.
			await db.exec('insert into src (id, a, b, k) values (10, 1, 0, 1), (11, 2, 0, 1), (12, 3, 0, 1), (13, 4, 0, 2), (14, 5, 0, 2), (15, 6, 0, 2)');
			const flushes = records.filter(r => r.mv === 'mv' && r.seam === 'residual-flush');
			expect(flushes.length, 'exactly one residual flush for the statement').to.equal(1);
			expect(flushes[0].distinctKeys, '6 touching rows dedup to 2 distinct group keys').to.equal(2);
			expect(records.filter(r => r.mv === 'mv' && r.seam === 'dispatch'), 'no per-row dispatch for a residual arm').to.deep.equal([]);
			await assertEquivalent(db, body, 'after batched multi-row insert');
		});

		it('between-statement reads inside a transaction see maintained state; rollback reverts', async () => {
			await db.exec('begin');
			try {
				await db.exec('insert into src (id, a, b, k) values (10, 5, 0, 1), (11, 7, 0, 3)');
				// The statement flush already ran — a same-transaction read between
				// statements must see the maintained state (the MV is contractually
				// indistinguishable from the plain view).
				await assertEquivalent(db, body, 'between statements, same transaction');
				await db.exec('delete from src where k = 1');
				await assertEquivalent(db, body, 'after second statement, same transaction');
			} finally {
				await db.exec('rollback');
			}
			await assertEquivalent(db, body, 'post-rollback');
		});

		it('OR FAIL: the error-path drain still flushes the surviving rows into the backing', async () => {
			let caught: unknown;
			try {
				// Row (20) succeeds, row (1) collides with the seeded PK — OR FAIL keeps
				// the surviving row and aborts the statement.
				await db.exec('insert or fail into src (id, a, b, k) values (20, 9, 0, 7), (1, 1, 0, 1)');
			} catch (e) { caught = e; }
			expect(caught, 'the duplicate PK must abort the statement').to.not.be.undefined;
			// The k=7 group from the surviving row must be maintained (flushed on the
			// throw path), or read(MV) would lag evaluate(body) mid-transaction.
			await assertEquivalent(db, body, 'after OR FAIL abort with surviving rows');
		});

		it('OR IGNORE / OR REPLACE multi-row statements stay equivalent', async () => {
			await db.exec('insert or ignore into src (id, a, b, k) values (30, 1, 0, 4), (1, 9, 9, 9), (31, 2, 0, 4)');
			await assertEquivalent(db, body, 'after OR IGNORE with an intra-statement collision');
			await db.exec('insert or replace into src (id, a, b, k) values (1, 8, 0, 5), (32, 3, 0, 5)');
			await assertEquivalent(db, body, 'after OR REPLACE moving a row across groups');
		});
	});

	describe('per-statement degrade-to-rebuild demotion', () => {
		let db: Database;
		// `group_concat(b)` declares NO algebra at all (no merge/negate/decode/decompose),
		// so the whole body stays OFF the delta-aggregate fast path on a plain residual and
		// the demotion crossover under test remains reachable — a delta-eligible body bypasses
		// it by design (see the bypass pin below). (min/max are no longer a valid "forces
		// residual" proxy here: since feat-mv-agg-delta-tighten they are delta-maintained by
		// the tighten arm.) Every insert below writes b=0, so group_concat is order-independent.
		const body = 'select k, count(*) as c, sum(a) as s, group_concat(b) as g from src group by k';

		beforeEach(async () => {
			db = new Database();
			await db.exec('create table src (id integer primary key, a integer, b integer, k integer)');
			await db.exec('insert into src (id, a, b, k) values (1, 1, 0, 1), (2, 2, 0, 2)');
			await db.exec(`create materialized view mv as ${body}`);
			// Pin the demotion crossover deterministically (independent of the stats
			// provider's heuristics): no distinct-groups estimate ⇒ the no-stats path
			// costs each residual run at forwardBodyCost × fallbackRatio = 0.5, so a
			// statement with k ≥ 3 distinct keys (cost > 1 = forwardBodyCost) demotes
			// to one whole-body rebuild and k ≤ 2 stays on per-key residuals.
			const plan = seamManager(db).rowTime.get('main.mv');
			expect(plan, 'registered plan').to.exist;
			plan!.sourceStats = { tableRows: 10, forwardBodyCost: 1, fallbackRatio: 0.5 };
		});
		afterEach(async () => { await db.close(); });

		it('a statement over the crossover runs one replace-all rebuild; a later small statement reverts', async () => {
			const records = instrumentSeams(db);
			// 2 distinct keys — under the crossover: per-key residuals, no replace-all.
			await db.exec('insert into src (id, a, b, k) values (10, 1, 0, 1), (11, 1, 0, 2)');
			expect(records.filter(r => r.seam === 'replace-all'), 'k=2 stays on per-key residuals').to.deep.equal([]);
			await assertEquivalent(db, body, 'under the crossover');

			// 4 distinct keys — over the crossover: the flush demotes to ONE whole-body
			// replace-all diff for this statement.
			await db.exec('insert into src (id, a, b, k) values (20, 1, 0, 3), (21, 1, 0, 4), (22, 1, 0, 5), (23, 1, 0, 6)');
			const replaceAll = records.filter(r => r.seam === 'replace-all' && r.mv === 'mv');
			expect(replaceAll.length, 'k=4 demotes to exactly one rebuild').to.equal(1);
			await assertEquivalent(db, body, 'after degraded (replace-all) statement');

			// Stateless: the NEXT low-cardinality statement is back on per-key residuals.
			await db.exec('insert into src (id, a, b, k) values (30, 1, 0, 1)');
			expect(records.filter(r => r.seam === 'replace-all' && r.mv === 'mv').length, 'no further rebuilds').to.equal(1);
			await assertEquivalent(db, body, 'after post-degrade single-row statement');
		});

		it('a delta-aggregate body BYPASSES the demotion — no replace-all even over the crossover', async () => {
			// Same crossover-pinned stats, but a delta-eligible body (count + integer
			// sum, no min): the flush maintains each group by arithmetic RMW, which is
			// already O(affected groups) with no residual runs, so the residual↔rebuild
			// crossover never applies.
			const deltaBody = 'select k, count(*) as c, sum(a) as s from src group by k';
			await db.exec(`create materialized view mv_delta as ${deltaBody}`);
			const plan = seamManager(db).rowTime.get('main.mv_delta');
			expect(plan, 'registered delta plan').to.exist;
			expect((plan as { chosenStrategy?: string }).chosenStrategy, 'cost gate chose the delta strategy').to.equal('delta-aggregate');
			plan!.sourceStats = { tableRows: 10, forwardBodyCost: 1, fallbackRatio: 0.5 };
			const records = instrumentSeams(db);
			await db.exec('insert into src (id, a, b, k) values (20, 1, 0, 3), (21, 1, 0, 4), (22, 1, 0, 5), (23, 1, 0, 6)');
			expect(records.filter(r => r.seam === 'replace-all' && r.mv === 'mv_delta'), 'no demotion on the delta path').to.deep.equal([]);
			// assertEquivalent reads the fixed name `mv`; compare mv_delta inline.
			expect(await readMultiset(db, 'select * from mv_delta'), 'delta path over the crossover')
				.to.deep.equal(await readGroundTruth(db, deltaBody));
		});
	});

	describe('mixed-arm MV-over-MV chain in one statement', () => {
		let db: Database;
		const mv1Body = 'select k, count(*) as c, sum(a) as s from src group by k';
		// Oracles are expressed over src directly, so the read-side rewrite disable in
		// readOracle keeps them independent of every backing under test.
		const mv2Oracle = `select k, c from (${mv1Body})`;
		const mv3Oracle = `select c, count(*) as n from (${mv1Body}) group by c`;

		beforeEach(async () => {
			db = new Database();
			await db.exec('create table src (id integer primary key, a integer, b integer, k integer)');
			await db.exec('insert into src (id, a, b, k) values (1, 1, 0, 1), (2, 2, 0, 1), (3, 3, 0, 2)');
			await db.exec(`create materialized view mv1 as ${mv1Body}`);
			await db.exec('create materialized view mv2 as select k, c from mv1');
			await db.exec('create materialized view mv3 as select c, count(*) as n from mv1 group by c');
			expect(registeredPlanKind(db, 'mv1'), 'producer is residual').to.equal('residual-recompute');
			expect(registeredPlanKind(db, 'mv2'), 'consumer mv2 is inverse-projection').to.equal('inverse-projection');
			expect(registeredPlanKind(db, 'mv3'), 'consumer mv3 is residual (residual-over-residual)').to.equal('residual-recompute');
		});
		afterEach(async () => { await db.close(); });

		it('one multi-row statement converges the whole chain at the flush', async () => {
			const records = instrumentSeams(db);
			await db.exec('insert into src (id, a, b, k) values (10, 4, 0, 1), (11, 5, 0, 2), (12, 6, 0, 3)');
			// Producer and residual consumer each flushed exactly once (worklist rounds).
			expect(records.filter(r => r.mv === 'mv1' && r.seam === 'residual-flush').length, 'mv1 flushed once').to.equal(1);
			expect(records.filter(r => r.mv === 'mv3' && r.seam === 'residual-flush').length, 'mv3 flushed once').to.equal(1);
			expect(await readMultiset(db, 'select * from mv1')).to.deep.equal(await readOracle(db, mv1Body));
			expect(await readMultiset(db, 'select * from mv2')).to.deep.equal(await readOracle(db, mv2Oracle));
			expect(await readMultiset(db, 'select * from mv3')).to.deep.equal(await readOracle(db, mv3Oracle));
		});

		it('a multi-row DELETE emptying groups converges the chain (emptied-key deletes cascade)', async () => {
			await db.exec('delete from src where k = 1');
			expect(await readMultiset(db, 'select * from mv1')).to.deep.equal(await readOracle(db, mv1Body));
			expect(await readMultiset(db, 'select * from mv2')).to.deep.equal(await readOracle(db, mv2Oracle));
			expect(await readMultiset(db, 'select * from mv3')).to.deep.equal(await readOracle(db, mv3Oracle));
		});
	});

	// The 1:1 inner-join arm accumulates forward (`T`-PK) and lookup (`P`-PK) keys under
	// separate batch maps; the property suite drives it a key-at-a-time, so these pin the
	// genuinely-multi-key batch — several distinct keys of ONE variant accumulated in a
	// single multi-row statement flushing exactly once.
	describe('join-residual arm — multi-key statement batch', () => {
		let db: Database;
		const body = 'select t.id, t.fk, p.name from t join p on t.fk = p.id';

		beforeEach(async () => {
			db = new Database();
			await db.exec('create table p (id integer primary key, name text)');
			await db.exec('create table t (id integer primary key, fk integer not null references p(id))');
			await db.exec("insert into p (id, name) values (1, 'a'), (2, 'b'), (3, 'c'), (4, 'd')");
			// Two t rows per p so a per-p recompute touches >1 backing row.
			await db.exec('insert into t (id, fk) values (1, 1), (2, 1), (3, 2), (4, 2), (5, 3), (6, 3)');
			await db.exec(`create materialized view mv as ${body}`);
			expect(registeredPlanKind(db, 'mv'), 'join arm').to.equal('join-residual');
		});
		afterEach(async () => { await db.close(); });

		it('a multi-row lookup-side (p) update flushes ONCE over several distinct P keys', async () => {
			const records = instrumentSeams(db);
			// One statement rewriting three distinct p rows → three distinct lookup keys.
			await db.exec("update p set name = name || '!' where id <= 3");
			const flushes = records.filter(r => r.mv === 'mv' && r.seam === 'residual-flush');
			expect(flushes.length, 'exactly one flush for the statement').to.equal(1);
			expect(flushes[0].distinctKeys, 'three distinct P keys deduped in one batch').to.equal(3);
			expect(records.filter(r => r.mv === 'mv' && r.seam === 'dispatch'), 'no per-row dispatch').to.deep.equal([]);
			await assertEquivalent(db, body, 'after multi-key lookup-side batch');
		});

		it('a multi-row forward-side (t) FK-move flushes ONCE over several distinct T keys', async () => {
			const records = instrumentSeams(db);
			// One statement moving both fk=1 rows (ids 1,2) to fk=4 → two forward keys.
			await db.exec('update t set fk = 4 where fk = 1');
			const flushes = records.filter(r => r.mv === 'mv' && r.seam === 'residual-flush');
			expect(flushes.length, 'exactly one flush for the statement').to.equal(1);
			expect(flushes[0].distinctKeys, 'two distinct T keys deduped in one batch').to.equal(2);
			await assertEquivalent(db, body, 'after multi-key forward-side batch');
		});
	});
});

/* ══════════ decomposition-maintained aggregate class (avg + a UDAF) — feat-mv-agg-delta-decompose ══════════
 *
 * A stored aggregate column whose value is a scalar formula over sibling partial aggregates
 * (`AggregateAlgebra.decompose`) — `avg(x) ≡ sum(x)/count(x)`, and any UDAF declaring
 * `decompose` — is delta-maintained by delta-maintaining its partials and re-evaluating
 * `combine` per group at flush, but ONLY when every partial is ALSO stored as a sibling
 * column of the same MV body and is itself delta-maintainable. `avg` is the first client of
 * this class, not a special case. The equivalence oracle re-runs the same body live (avg /
 * the UDAF included), so incremental maintenance and live evaluation must agree byte-exactly
 * mid-transaction and after rollback; white-box checks pin that the delta strategy (not the
 * residual) is actually chosen and that a decompose column was recorded.
 */

/** The registered row-time plan for `main.<name>`, loosely typed to inspect the delta
 *  descriptor (`chosenStrategy`, the decompose-column list the decompose class populates,
 *  and `hasTighten` — set when the body carries a min/max-shaped tighten column). */
interface DeltaPlanLike {
	readonly kind: string;
	readonly chosenStrategy?: string;
	readonly delta?: {
		readonly decomposeColumns: readonly unknown[];
		readonly aggColumns: readonly { readonly deltaClass: string }[];
		readonly hasTighten: boolean;
	};
}
function registeredDeltaPlan(db: Database, name: string): DeltaPlanLike {
	const mgr = (db as unknown as ManagerHandle).materializedViewManager as unknown as { rowTime: Map<string, DeltaPlanLike> };
	const plan = mgr.rowTime.get(`main.${name}`.toLowerCase());
	expect(plan, `${name} plan registered`).to.exist;
	return plan!;
}

/** A non-avg `decompose` UDAF proving the class is function-generic: `wsum(x) ≡ sum(x) +
 *  count(x)`, composed from the same `sum` / `count` partials avg names. Deliberately an
 *  INTEGER-exact linear combination (not a true geometric mean) so the incremental
 *  reconstruction stays byte-identical to a fresh live fold — a float geomean over `sum(log x)`
 *  drifts under re-association and would spuriously red the byte-exact oracle (see the
 *  handoff). Declares `merge` + `negate` + `decompose` but NO `decode` — exactly avg's shape:
 *  it is maintained through its partials, never accumulated directly. */
function makeWsumAggregate(): AggregateFunctionSchema {
	type Acc = { sum: number; count: number } | null;
	return createAggregateFunction(
		{
			name: 'wsum', numArgs: 1, initialValue: null,
			returnType: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: true, isReadOnly: true },
			algebra: {
				merge: (x: Acc, y: Acc): Acc =>
					x === null ? y : y === null ? x : { sum: x.sum + y.sum, count: x.count + y.count },
				negate: (x: Acc): Acc => x === null ? null : { sum: -x.sum, count: -x.count },
				decompose: {
					partials: [{ func: 'sum', arg: 'same-arg' }, { func: 'count', arg: 'same-arg' }],
					// sum(x) + count(x); empty / all-NULL group (count 0) ⇒ NULL — reproduces finalize.
					combine: (vals: readonly SqlValue[]): SqlValue => {
						const [sumV, countV] = vals;
						if (countV === null || countV === undefined || Number(countV) === 0) return null;
						return Number(sumV) + Number(countV);
					},
				},
			},
		},
		(acc: Acc, value: SqlValue): Acc => {
			if (value === null) return acc;
			const n = Number(value);
			if (Number.isNaN(n)) return acc;
			return { sum: (acc?.sum ?? 0) + n, count: (acc?.count ?? 0) + 1 };
		},
		(acc: Acc): SqlValue => (acc === null || acc.count === 0) ? null : acc.sum + acc.count,
	);
}

/* Shared mutation generator over `t (id pk, k, a NOT NULL)` — inserts / non-key updates /
 * group-key + arg updates / key-changing updates / deletes, plus multi-row statements
 * (multi-insert, predicate update/delete) so the per-statement flush and its statement-wide
 * dedup are exercised. Reused by the avg-NOT-NULL and UDAF suites (both retraction-safe:
 * a NOT-NULL integer arg + the count(*) witness keep deletes on the arithmetic path). */
type DecMutation =
	| { readonly kind: 'insert'; readonly id: number; readonly k: number; readonly a: number }
	| { readonly kind: 'update'; readonly id: number; readonly k: number; readonly a: number }
	| { readonly kind: 'updateKey'; readonly oldId: number; readonly newId: number; readonly k: number; readonly a: number }
	| { readonly kind: 'delete'; readonly id: number }
	| { readonly kind: 'multiInsert'; readonly rows: readonly { readonly id: number; readonly k: number; readonly a: number }[] }
	| { readonly kind: 'updateWhere'; readonly a: number; readonly k: number; readonly kMatch: number }
	| { readonly kind: 'deleteWhere'; readonly kMatch: number };

const decIdArb = fc.integer({ min: 1, max: 6 });
const decKArb = fc.integer({ min: 1, max: 4 });
const decAArb = fc.integer({ min: 0, max: 9 });
const decMutationArb: fc.Arbitrary<DecMutation> = fc.oneof(
	fc.record({ kind: fc.constant('insert' as const), id: decIdArb, k: decKArb, a: decAArb }),
	fc.record({ kind: fc.constant('update' as const), id: decIdArb, k: decKArb, a: decAArb }),
	fc.record({ kind: fc.constant('updateKey' as const), oldId: decIdArb, newId: decIdArb, k: decKArb, a: decAArb }),
	fc.record({ kind: fc.constant('delete' as const), id: decIdArb }),
	fc.record({ kind: fc.constant('multiInsert' as const), rows: fc.array(fc.record({ id: decIdArb, k: decKArb, a: decAArb }), { minLength: 2, maxLength: 4 }) }),
	fc.record({ kind: fc.constant('updateWhere' as const), a: decAArb, k: decKArb, kMatch: decKArb }),
	fc.record({ kind: fc.constant('deleteWhere' as const), kMatch: decKArb }),
);
const decSqlFor = (m: DecMutation): string => {
	switch (m.kind) {
		case 'insert': return `insert into t (id, k, a) values (${m.id}, ${m.k}, ${m.a})`;
		case 'update': return `update t set k = ${m.k}, a = ${m.a} where id = ${m.id}`;
		case 'updateKey': return `update t set id = ${m.newId}, k = ${m.k}, a = ${m.a} where id = ${m.oldId}`;
		case 'delete': return `delete from t where id = ${m.id}`;
		case 'multiInsert': return `insert into t (id, k, a) values ${m.rows.map(r => `(${r.id}, ${r.k}, ${r.a})`).join(', ')}`;
		case 'updateWhere': return `update t set a = ${m.a}, k = ${m.k} where k = ${m.kMatch}`;
		case 'deleteWhere': return `delete from t where k = ${m.kMatch}`;
	}
};

/** avg delta-maintained via its stored `sum(a)` + `count(*)` partials. `a` is NOT NULL, so
 *  `count(*)` qualifies as avg's `count(x)` divisor (the write-side mirror of the read-side
 *  `feat-mv-agg-rollup-retarget` relaxation), and integer so `sum(a)` passes the exact-domain
 *  gate and stays retraction-safe — deletes maintain avg by arithmetic, not the residual. */
describe('Materialized-view maintenance equivalence (decompose class: avg via stored sum + count)', () => {
	let db: Database;
	const body = 'select k, count(*) as c, sum(a) as s, avg(a) as av from t group by k';

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table t (id integer primary key, k integer, a integer not null)');
		await db.exec('insert into t (id, k, a) values (1, 1, 4), (2, 1, 6), (3, 2, 5)');
		await db.exec(`create materialized view mv as ${body}`);
	});
	afterEach(async () => { await db.close(); });

	it('is delta-maintained (chosenStrategy delta-aggregate; avg recorded as one decompose column)', () => {
		const plan = registeredDeltaPlan(db, 'mv');
		expect(plan.kind, 'aggregate residual arm').to.equal('residual-recompute');
		expect(plan.chosenStrategy, 'delta strategy chosen (partials stored)').to.equal('delta-aggregate');
		expect(plan.delta, 'delta descriptor present').to.exist;
		expect(plan.delta!.decomposeColumns.length, 'avg is the one decompose column').to.equal(1);
	});

	it('read(MV) == evaluate(body) across random mutations, in-txn and after rollback', async () => {
		await fc.assert(fc.asyncProperty(
			fc.array(decMutationArb, { minLength: 1, maxLength: 10 }),
			async (mutations) => {
				await assertEquivalent(db, body, 'baseline');
				await db.exec('begin');
				try {
					for (const m of mutations) await execTolerant(db, decSqlFor(m));
					await assertEquivalent(db, body, 'in-transaction');
				} finally {
					await db.exec('rollback');
				}
				await assertEquivalent(db, body, 'post-rollback');
			},
		), { numRuns: 50 });
	});

	it('a real avg change reports the decompose column re-derived in place', async () => {
		await db.exec('update t set a = 10 where id = 1'); // k=1 group avg (4+6)/2=5 → (10+6)/2=8
		await assertEquivalent(db, body, 'after avg change');
		expect(await readMultiset(db, 'select av from mv where k = 1'), 'avg((10+6)/2) = 8').to.deep.equal([canonRow([8])]);
	});

	// Guards the two-pass partial binding: the decompose column may project BEFORE the
	// partials it names, so resolution cannot happen inline in the first column pass. A
	// single-pass regression would fail to bind avg here and drop the whole MV to residual.
	// Reuses the `mv` name so the hardwired `assertEquivalent` oracle reads this view.
	it('avg projected BEFORE its stored partials is still delta-maintained and equivalent', async () => {
		await db.exec('drop materialized view mv');
		const preBody = 'select k, avg(a) as av, sum(a) as s, count(*) as c from t group by k';
		await db.exec(`create materialized view mv as ${preBody}`);
		const plan = registeredDeltaPlan(db, 'mv');
		expect(plan.chosenStrategy, 'partial-before ordering still resolves').to.equal('delta-aggregate');
		expect(plan.delta!.decomposeColumns.length, 'avg bound despite projecting first').to.equal(1);
		await db.exec('insert into t (id, k, a) values (20, 1, 8)'); // k=1 avg (4+6+8)/3 = 6
		await assertEquivalent(db, preBody, 'avg-first after insert');
		expect(await readMultiset(db, 'select av from mv where k = 1'), 'avg = 6').to.deep.equal([canonRow([6])]);
	});
});

/** avg over a NULLABLE arg with `count(a)` stored explicitly (the NULL-excluding divisor, not
 *  the count(*) fallback). `sum(a)` over a nullable column is NOT retraction-safe, so a delete
 *  against a stored group falls back to the residual — still exact, exercised here. Pins the
 *  two load-bearing edges the ticket calls out: an emptied group (deleted via the multiplicity
 *  witness) and a non-empty all-NULL-arg group (count(*)>0, count(x)=0, avg = NULL). */
describe('Materialized-view maintenance equivalence (decompose class: avg over nullable arg, count(x) stored)', () => {
	let db: Database;
	const body = 'select k, count(*) as c, count(a) as ca, sum(a) as s, avg(a) as av from t group by k';

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table t (id integer primary key, k integer, a integer null)');
		await db.exec('insert into t (id, k, a) values (1, 1, 4), (2, 1, 6)');
		await db.exec(`create materialized view mv as ${body}`);
	});
	afterEach(async () => { await db.close(); });

	it('is delta-maintained with count(x) as the avg divisor', () => {
		const plan = registeredDeltaPlan(db, 'mv');
		expect(plan.chosenStrategy).to.equal('delta-aggregate');
		expect(plan.delta!.decomposeColumns.length).to.equal(1);
	});

	it('a group of only NULL-arg rows finalizes avg NULL (count(*)>0, count(x)=0)', async () => {
		// New group k=3, both rows NULL `a`: multiplicity count(*) = 2 (>0, not emptied), but
		// count(a) = 0, so avg combine([sum=NULL, count=0]) yields NULL — native avg semantics.
		await db.exec('insert into t (id, k, a) values (10, 3, null), (11, 3, null)');
		await assertEquivalent(db, body, 'all-NULL group avg NULL');
		expect(await readMultiset(db, 'select c, ca, av from mv where k = 3'), 'count(*)=2, count(a)=0, avg NULL')
			.to.deep.equal([canonRow([2, 0, null])]);
	});

	it('emptying a group to zero rows deletes its backing row', async () => {
		await db.exec('delete from t where k = 1'); // removes ids 1,2 — the only k=1 rows
		await assertEquivalent(db, body, 'emptied group');
		expect((await readMultiset(db, 'select k from mv where k = 1')).length, 'k=1 group gone').to.equal(0);
	});

	it('read(MV) == evaluate(body) across random mutations incl. NULL args, in-txn and after rollback', async () => {
		const aOrNull = fc.option(fc.integer({ min: 0, max: 9 }), { nil: null });
		const aLit = (v: number | null): string => v === null ? 'null' : `${v}`;
		type NMut =
			| { readonly kind: 'insert'; readonly id: number; readonly k: number; readonly a: number | null }
			| { readonly kind: 'update'; readonly id: number; readonly k: number; readonly a: number | null }
			| { readonly kind: 'delete'; readonly id: number }
			| { readonly kind: 'deleteWhere'; readonly kMatch: number };
		const nArb: fc.Arbitrary<NMut> = fc.oneof(
			fc.record({ kind: fc.constant('insert' as const), id: decIdArb, k: decKArb, a: aOrNull }),
			fc.record({ kind: fc.constant('update' as const), id: decIdArb, k: decKArb, a: aOrNull }),
			fc.record({ kind: fc.constant('delete' as const), id: decIdArb }),
			fc.record({ kind: fc.constant('deleteWhere' as const), kMatch: decKArb }),
		);
		const nSql = (m: NMut): string => {
			switch (m.kind) {
				case 'insert': return `insert into t (id, k, a) values (${m.id}, ${m.k}, ${aLit(m.a)})`;
				case 'update': return `update t set k = ${m.k}, a = ${aLit(m.a)} where id = ${m.id}`;
				case 'delete': return `delete from t where id = ${m.id}`;
				case 'deleteWhere': return `delete from t where k = ${m.kMatch}`;
			}
		};
		await fc.assert(fc.asyncProperty(
			fc.array(nArb, { minLength: 1, maxLength: 12 }),
			async (mutations) => {
				await assertEquivalent(db, body, 'baseline');
				await db.exec('begin');
				try {
					for (const m of mutations) await execTolerant(db, nSql(m));
					await assertEquivalent(db, body, 'in-transaction');
				} finally {
					await db.exec('rollback');
				}
				await assertEquivalent(db, body, 'post-rollback');
			},
		), { numRuns: 60 });
	});
});

/** The two "not delta-maintainable → residual" edges: a body WITHOUT the partials avg names,
 *  and avg over a REAL column (its `sum` partial fails the integer-domain gate). Both must stay
 *  correct via the residual — the equivalence oracle covers them — just not incrementally. */
describe('Materialized-view maintenance (decompose class: not delta-maintainable falls to residual)', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table t (id integer primary key, k integer, a integer not null, r real not null)');
		await db.exec('insert into t (id, k, a, r) values (1, 1, 4, 1.5), (2, 1, 6, 2.5), (3, 2, 5, 3.5)');
	});
	afterEach(async () => { await db.close(); });

	it('avg WITHOUT its stored partials stays on the residual (equivalent, not delta)', async () => {
		const body = 'select k, avg(a) as av from t group by k';
		await db.exec(`create materialized view mv as ${body}`);
		const plan = registeredDeltaPlan(db, 'mv');
		expect(plan.kind, 'aggregate residual arm').to.equal('residual-recompute');
		expect(plan.chosenStrategy, 'no delta: no stored partials and no count(*) witness').to.not.equal('delta-aggregate');
		expect(plan.delta, 'delta descriptor absent').to.equal(undefined);
		await assertEquivalent(db, body, 'avg-only baseline');
		await db.exec('begin');
		try {
			await db.exec('insert into t (id, k, a, r) values (10, 1, 8, 9.0), (11, 3, 2, 1.0)');
			await db.exec('delete from t where id = 3');
			await assertEquivalent(db, body, 'avg-only in-txn');
		} finally {
			await db.exec('rollback');
		}
		await assertEquivalent(db, body, 'avg-only post-rollback');
	});

	it('avg over a REAL column falls to residual (its sum partial fails the integer-domain gate)', async () => {
		const body = 'select k, count(*) as c, sum(r) as s, avg(r) as av from t group by k';
		await db.exec(`create materialized view mv as ${body}`);
		const plan = registeredDeltaPlan(db, 'mv');
		expect(plan.kind, 'aggregate residual arm').to.equal('residual-recompute');
		expect(plan.chosenStrategy, 'REAL sum fails the exact-domain gate → whole MV residual').to.not.equal('delta-aggregate');
		await assertEquivalent(db, body, 'avg-over-real baseline');
		await db.exec('insert into t (id, k, a, r) values (10, 1, 1, 4.25)');
		await assertEquivalent(db, body, 'avg-over-real after insert');
	});
});

/** A non-avg `decompose` UDAF (`wsum(x) ≡ sum(x) + count(x)`) delta-maintained from its stored
 *  `sum(a)` + `count(*)` partials — proving the decompose class is function-generic (avg is
 *  merely its first client). The UDAF's `combine` and its own `finalize` agree, and both are
 *  INTEGER-exact so incremental maintenance stays byte-identical to the live fold. */
describe('Materialized-view maintenance equivalence (decompose class: a UDAF decomposition)', () => {
	let db: Database;
	const body = 'select k, count(*) as c, sum(a) as s, wsum(a) as w from t group by k';

	beforeEach(async () => {
		db = new Database();
		db.registerFunction(makeWsumAggregate());
		await db.exec('create table t (id integer primary key, k integer, a integer not null)');
		await db.exec('insert into t (id, k, a) values (1, 1, 4), (2, 1, 6), (3, 2, 5)');
		await db.exec(`create materialized view mv as ${body}`);
	});
	afterEach(async () => { await db.close(); });

	it('a non-avg UDAF decomposition is delta-maintained from its stored partials', () => {
		const plan = registeredDeltaPlan(db, 'mv');
		expect(plan.chosenStrategy, 'delta strategy chosen for the UDAF decomposition').to.equal('delta-aggregate');
		expect(plan.delta!.decomposeColumns.length, 'wsum is the one decompose column').to.equal(1);
	});

	it('read(MV) == evaluate(body) across random mutations, in-txn and after rollback', async () => {
		await fc.assert(fc.asyncProperty(
			fc.array(decMutationArb, { minLength: 1, maxLength: 10 }),
			async (mutations) => {
				await assertEquivalent(db, body, 'baseline');
				await db.exec('begin');
				try {
					for (const m of mutations) await execTolerant(db, decSqlFor(m));
					await assertEquivalent(db, body, 'in-transaction');
				} finally {
					await db.exec('rollback');
				}
				await assertEquivalent(db, body, 'post-rollback');
			},
		), { numRuns: 50 });
	});
});

/* ══════════ tighten-only (join-semilattice) aggregate class — min/max + a UDAF — feat-mv-agg-delta-tighten ══════════
 *
 * A stored aggregate column declaring `merge` + `decode` but NO `negate` (a join-semilattice,
 * not an abelian group — `min`/`max`, and any UDAF like `bit_or`/`bool_or`) is delta-maintained
 * for INSERTS by `merge`ing the new contribution in (min/max tighten toward the new extreme),
 * but a RETRACTION cannot be undone arithmetically — `merge` cannot recover the next-best after
 * the current extreme is removed. So a group that accumulates ANY retraction re-derives WHOLESALE
 * from the key-filtered residual (`DeltaAggregateDescriptor.hasTighten`), whether or not a row is
 * stored. The count/sum columns of that same recomputed row come from the residual too — one
 * path per group, never double-maintained. Detection is structural (`merge` present, `negate`
 * absent), never an aggregate-name list. The equivalence oracle re-runs the same body live, so
 * maintenance and live evaluation must agree byte-exactly across every mutation and after
 * rollback; white-box checks pin that the delta strategy is chosen and `hasTighten` is set.
 */

/** A `bit_or(x)` UDAF proving the tighten class is function-generic (min/max are merely its
 *  builtins): a bitwise-OR join-semilattice — `merge` is idempotent OR, `decode` reconstructs
 *  the accumulator from the stored integer, and there is deliberately NO `negate` (a set bit
 *  cannot be un-set by removing one contributor). INTEGER-exact, so incremental maintenance is
 *  byte-identical to a fresh live fold; a retraction re-derives its group via the residual. */
function makeBitOrAggregate(): AggregateFunctionSchema {
	type Acc = { bits: number } | null;
	return createAggregateFunction(
		{
			name: 'bit_or', numArgs: 1, initialValue: null,
			returnType: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: true, isReadOnly: true },
			algebra: {
				// Idempotent, commutative, associative OR; identity is the empty (null) accumulator.
				merge: (a: Acc, b: Acc): Acc =>
					a === null ? b : b === null ? a : { bits: a.bits | b.bits },
				// Stored NULL (empty / all-NULL-arg group) decodes to the empty accumulator.
				decode: (stored: SqlValue): Acc => stored === null ? null : { bits: Number(stored) },
				// NO negate: OR has no inverse — a retraction falls back to the residual.
			},
		},
		(acc: Acc, value: SqlValue): Acc => {
			if (value === null) return acc; // OR ignores NULLs (native bit_or semantics)
			return { bits: (acc?.bits ?? 0) | Number(value) };
		},
		(acc: Acc): SqlValue => acc === null ? null : acc.bits,
	);
}

/** min/max delta-maintained by the tighten arm. Inserts tighten the stored extreme via `merge`;
 *  a delete/update of the (possibly) extreme value re-derives the whole group from the residual.
 *  `a` is nullable so min/max NULL-skipping is exercised; the count(*) witness governs emptiness. */
describe('Materialized-view maintenance equivalence (tighten class: min/max)', () => {
	let db: Database;
	const body = 'select k, count(*) as c, min(a) as mn, max(a) as mx from t group by k';

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table t (id integer primary key, k integer, a integer)');
		// k=1 group with three distinct values (3,5,7) so an extreme can be deleted and the
		// residual must recover the next-best; k=2 is a singleton (delete → emptied group).
		await db.exec('insert into t (id, k, a) values (1, 1, 3), (2, 1, 5), (3, 1, 7), (4, 2, 2)');
		await db.exec(`create materialized view mv as ${body}`);
	});
	afterEach(async () => { await db.close(); });

	it('is delta-maintained with a tighten column (chosenStrategy delta-aggregate; hasTighten set)', () => {
		const plan = registeredDeltaPlan(db, 'mv');
		expect(plan.kind, 'aggregate residual arm').to.equal('residual-recompute');
		expect(plan.chosenStrategy, 'tighten body still prefers the delta arm (insert-dominated cost)').to.equal('delta-aggregate');
		expect(plan.delta, 'delta descriptor present').to.exist;
		expect(plan.delta!.hasTighten, 'min/max flagged as tighten').to.equal(true);
		expect(plan.delta!.aggColumns.some(c => c.deltaClass === 'tighten'), 'a tighten-class column recorded').to.equal(true);
	});

	it('an insert that beats the extreme tightens min/max arithmetically', async () => {
		await db.exec('insert into t (id, k, a) values (10, 1, 9)'); // 9 > max 7, > min 3 (no change to min)
		await assertEquivalent(db, body, 'insert beats max');
		expect(await readMultiset(db, 'select mn, mx from mv where k = 1'), 'min 3, max tightens to 9')
			.to.deep.equal([canonRow([3, 9])]);
	});

	it('an insert that does NOT beat the extreme is a no-op (stored extreme unchanged)', async () => {
		await db.exec('insert into t (id, k, a) values (10, 1, 5)'); // 3 ≤ 5 ≤ 7 — inside the range
		await assertEquivalent(db, body, 'insert inside range');
		expect(await readMultiset(db, 'select mn, mx from mv where k = 1'), 'extremes unchanged (min 3, max 7)')
			.to.deep.equal([canonRow([3, 7])]);
	});

	it('deleting the current extreme re-derives the next-best via the residual', async () => {
		await db.exec('delete from t where id = 3'); // removes a=7, the k=1 max
		await assertEquivalent(db, body, 'delete of the max');
		expect(await readMultiset(db, 'select mn, mx from mv where k = 1'), 'max relaxes 7 → 5, min still 3')
			.to.deep.equal([canonRow([3, 5])]);
	});

	it('deleting a non-extreme value leaves the extremes intact (conservative fallback, still exact)', async () => {
		await db.exec('delete from t where id = 2'); // removes a=5, neither min nor max
		await assertEquivalent(db, body, 'delete of a middle value');
		expect(await readMultiset(db, 'select mn, mx from mv where k = 1'), 'extremes unchanged (min 3, max 7)')
			.to.deep.equal([canonRow([3, 7])]);
	});

	it('emptying a group deletes its backing row (multiplicity governs emptiness on the fallback branch)', async () => {
		await db.exec('delete from t where k = 2'); // the only k=2 row
		await assertEquivalent(db, body, 'emptied group');
		expect((await readMultiset(db, 'select k from mv where k = 2')).length, 'k=2 group gone').to.equal(0);
	});

	it('read(MV) == evaluate(body) across random mutations (incl. extreme-relaxing deletes), in-txn and after rollback', async () => {
		await fc.assert(fc.asyncProperty(
			fc.array(decMutationArb, { minLength: 1, maxLength: 12 }),
			async (mutations) => {
				await assertEquivalent(db, body, 'baseline');
				await db.exec('begin');
				try {
					for (const m of mutations) await execTolerant(db, decSqlFor(m));
					await assertEquivalent(db, body, 'in-transaction');
				} finally {
					await db.exec('rollback');
				}
				await assertEquivalent(db, body, 'post-rollback');
			},
		), { numRuns: 60 });
	});
});

/** min/max over NON-integer argument domains (TEXT, REAL). The tighten branch has NO
 *  exact-value-domain gate (`merge` is idempotent selection, not accumulating arithmetic, so no
 *  drift), so these ARE delta-eligible — an interaction the integer-only suites above never touch.
 *  Correctness rests on maintenance and the live oracle using the SAME comparison: the min/max
 *  builtins compare with `BINARY_COLLATION` in both `step` and `merge`, and the oracle re-runs the
 *  same builtin, so the two agree byte-for-byte regardless of the column's declared collation
 *  (min/max's fixed-BINARY compare vs a declared column collation is a pre-existing builtin
 *  question — see docs/mv-maintenance.md § Tighten-only columns — not introduced by this path). */
describe('Materialized-view maintenance equivalence (tighten class: min/max over TEXT / REAL)', () => {
	let db: Database;

	afterEach(async () => { await db.close(); });

	it('TEXT min/max: inserts tighten, delete of the BINARY extreme re-derives the next-best', async () => {
		db = new Database();
		await db.exec('create table t (id integer primary key, k integer, a text)');
		await db.exec(`create materialized view mv as select k, count(*) as c, min(a) as mn, max(a) as mx from t group by k`);
		const body = 'select k, count(*) as c, min(a) as mn, max(a) as mx from t group by k';
		const plan = registeredDeltaPlan(db, 'mv');
		expect(plan.chosenStrategy, 'TEXT min/max is delta-eligible (no exact-domain gate)').to.equal('delta-aggregate');
		expect(plan.delta!.hasTighten, 'flagged tighten').to.equal(true);
		// BINARY order: 'Apple' < 'Cherry' < 'apple' (uppercase precedes lowercase in code-point order).
		await db.exec(`insert into t (id, k, a) values (1, 1, 'Cherry'), (2, 1, 'apple'), (3, 1, 'Apple')`);
		await assertEquivalent(db, body, 'after inserts');
		expect(await readMultiset(db, 'select mn, mx from mv where k = 1'), 'min Apple, max apple')
			.to.deep.equal([canonRow(['Apple', 'apple'])]);
		await db.exec(`delete from t where id = 2`); // removes 'apple', the BINARY max
		await assertEquivalent(db, body, 'delete of the max re-derives next-best');
		expect(await readMultiset(db, 'select mn, mx from mv where k = 1'), 'max relaxes to Cherry')
			.to.deep.equal([canonRow(['Apple', 'Cherry'])]);
	});

	it('TEXT min/max under a NOCASE-declared column: maintenance still equals the live oracle', async () => {
		db = new Database();
		// Column declares `collate nocase`, but min/max compare BINARY in both maintenance and the
		// live oracle, so the MV and a fresh evaluation still agree — the equivalence this path must
		// preserve. (Whether min() SHOULD honor the column collation is orthogonal and pre-existing.)
		await db.exec('create table t (id integer primary key, k integer, a text collate nocase)');
		const body = 'select k, min(a) as mn, max(a) as mx, count(*) as c from t group by k';
		await db.exec(`create materialized view mv as ${body}`);
		await db.exec(`insert into t (id, k, a) values (1, 1, 'banana'), (2, 1, 'Apple'), (3, 1, 'cherry')`);
		await assertEquivalent(db, body, 'nocase column, binary min/max');
		await db.exec(`delete from t where id = 2`); // deletes the BINARY min 'Apple'
		await assertEquivalent(db, body, 'nocase column after extreme delete');
	});

	it('REAL min/max: byte-exact selection under inserts and an extreme delete', async () => {
		db = new Database();
		await db.exec('create table t (id integer primary key, k integer, a real)');
		const body = 'select k, count(*) as c, min(a) as mn, max(a) as mx from t group by k';
		await db.exec(`create materialized view mv as ${body}`);
		expect(registeredDeltaPlan(db, 'mv').chosenStrategy, 'REAL min/max delta-eligible').to.equal('delta-aggregate');
		await db.exec(`insert into t (id, k, a) values (1, 1, 3.5), (2, 1, 1.25), (3, 1, 7.75)`);
		await assertEquivalent(db, body, 'REAL inserts');
		expect(await readMultiset(db, 'select mn, mx from mv where k = 1'), 'min 1.25, max 7.75')
			.to.deep.equal([canonRow([1.25, 7.75])]);
		await db.exec(`delete from t where id = 3`); // removes 7.75, the max
		await assertEquivalent(db, body, 'REAL delete of the max');
		expect(await readMultiset(db, 'select mn, mx from mv where k = 1'), 'max relaxes to 3.5')
			.to.deep.equal([canonRow([1.25, 3.5])]);
	});
});

/** A UDAF join-semilattice (`bit_or(a)` — `merge`, `decode`, no `negate`) delta-maintained by
 *  the SAME tighten arm min/max use — proving the class is declaration-driven, not a builtin
 *  allow-list. Inserts OR the new bits into the stored value; a retraction re-derives the group
 *  from the residual (OR has no inverse). Mixed with a plain `sum(a)` (abelian group column) so
 *  the mixed group+tighten row is exercised — the residual recomputes both on a retraction. */
describe('Materialized-view maintenance equivalence (tighten class: a UDAF semilattice bit_or)', () => {
	let db: Database;
	const body = 'select k, count(*) as c, sum(a) as s, bit_or(a) as bor from t group by k';

	beforeEach(async () => {
		db = new Database();
		db.registerFunction(makeBitOrAggregate());
		await db.exec('create table t (id integer primary key, k integer, a integer not null)');
		await db.exec('insert into t (id, k, a) values (1, 1, 1), (2, 1, 2), (3, 1, 4), (4, 2, 5)');
		await db.exec(`create materialized view mv as ${body}`);
	});
	afterEach(async () => { await db.close(); });

	it('a UDAF semilattice is delta-maintained by the tighten arm (delta-aggregate; hasTighten set)', () => {
		const plan = registeredDeltaPlan(db, 'mv');
		expect(plan.chosenStrategy, 'tighten body prefers the delta arm').to.equal('delta-aggregate');
		expect(plan.delta!.hasTighten, 'bit_or flagged as tighten (merge, no negate)').to.equal(true);
	});

	it('an insert ORs new bits into the stored value arithmetically', async () => {
		await db.exec('insert into t (id, k, a) values (10, 1, 8)'); // k=1 bit_or 1|2|4=7 → 7|8=15
		await assertEquivalent(db, body, 'insert ORs bits');
		expect(await readMultiset(db, 'select bor from mv where k = 1'), 'bit_or = 15').to.deep.equal([canonRow([15])]);
	});

	it('a retraction re-derives bit_or (and its sibling sum) from the residual', async () => {
		await db.exec('delete from t where id = 3'); // drops a=4 from k=1: bit_or 1|2=3, sum 1+2=3
		await assertEquivalent(db, body, 'retraction re-derives via residual');
		expect(await readMultiset(db, 'select s, bor from mv where k = 1'), 'sum 3, bit_or 3').to.deep.equal([canonRow([3, 3])]);
	});

	it('read(MV) == evaluate(body) across random mutations, in-txn and after rollback', async () => {
		await fc.assert(fc.asyncProperty(
			fc.array(decMutationArb, { minLength: 1, maxLength: 12 }),
			async (mutations) => {
				await assertEquivalent(db, body, 'baseline');
				await db.exec('begin');
				try {
					for (const m of mutations) await execTolerant(db, decSqlFor(m));
					await assertEquivalent(db, body, 'in-transaction');
				} finally {
					await db.exec('rollback');
				}
				await assertEquivalent(db, body, 'post-rollback');
			},
		), { numRuns: 60 });
	});
});

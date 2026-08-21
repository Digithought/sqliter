/**
 * Plan-time protocol for an `IN` constraint whose member values only exist once the
 * query runs (`where col in (select …)`): `PredicateConstraint.runtimeSet`.
 *
 * Nothing in the planner emits a `runtimeSet` yet — `feat-key-set-semi-join` supplies
 * the engine half — so these tests drive `getBestAccessPlan` directly rather than
 * through SQL. The invariant they pin down is that a module sees a runtime set as an
 * ordinary multi-value `IN` of at most `maxCount` keys: it may claim it as a multi-seek,
 * it must never claim ordering over it, and a module that has never heard of
 * `runtimeSet` declines it instead of seeking on `undefined`.
 */

import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { MemoryTableModule } from '../../src/vtab/memory/module.js';
import {
	equalitySeekKeyCount,
	isMultiValueEquality,
	validateAccessPlan,
} from '../../src/vtab/best-access-plan.js';
import type {
	BestAccessPlanRequest,
	BestAccessPlanResult,
	ColumnMeta,
	PredicateConstraint,
} from '../../src/vtab/best-access-plan.js';
import type { TableSchema } from '../../src/schema/table.js';

/** `ColumnMeta[]` exactly as `rule-select-access-path` builds it from a table schema. */
function columnsOf(table: TableSchema): ColumnMeta[] {
	return table.columns.map((col, index) => ({
		index,
		name: col.name,
		type: col.logicalType,
		isPrimaryKey: col.primaryKey || false,
		isUnique: col.primaryKey || false,
	}));
}

/** An `IN` whose members arrive at execution time. */
function runtimeSetFilter(columnIndex: number, maxCount: number, estimatedCount?: number): PredicateConstraint {
	return {
		columnIndex,
		op: 'IN',
		usable: true,
		runtimeSet: estimatedCount === undefined ? { maxCount } : { maxCount, estimatedCount },
	};
}

/** A literal `IN` with `count` placeholder members — the plan-time twin of the above. */
function literalInFilter(columnIndex: number, count: number): PredicateConstraint {
	return {
		columnIndex,
		op: 'IN',
		usable: true,
		value: Array.from({ length: count }, (_, i) => i) as unknown as PredicateConstraint['value'],
	};
}

describe('runtime-valued IN sets (feat-runtime-key-set-protocol)', () => {
	describe('equalitySeekKeyCount / isMultiValueEquality', () => {
		it('counts `=` as one seek key and not multi-valued', () => {
			const f: PredicateConstraint = { columnIndex: 0, op: '=', usable: true, value: 7 };
			expect(equalitySeekKeyCount(f)).to.equal(1);
			expect(isMultiValueEquality(f)).to.be.false;
		});

		it('counts a literal IN by list LENGTH, even with undefined members', () => {
			const f: PredicateConstraint = {
				columnIndex: 0,
				op: 'IN',
				usable: true,
				value: [undefined, undefined, undefined] as unknown as PredicateConstraint['value'],
			};
			expect(equalitySeekKeyCount(f)).to.equal(3);
			expect(isMultiValueEquality(f)).to.be.true;
		});

		it('counts a runtime set by its maxCount ceiling', () => {
			expect(equalitySeekKeyCount(runtimeSetFilter(0, 50))).to.equal(50);
			expect(isMultiValueEquality(runtimeSetFilter(0, 50))).to.be.true;
		});

		it('treats a maxCount=1 runtime set as multi-valued anyway (count unknown at plan time)', () => {
			// The one place the two helpers deliberately disagree: the delivered count is
			// not knowable, and mistaking a multi-seek for a scan constant would elide a Sort.
			expect(equalitySeekKeyCount(runtimeSetFilter(0, 1))).to.equal(1);
			expect(isMultiValueEquality(runtimeSetFilter(0, 1))).to.be.true;
		});

		it('rejects a malformed or non-equality filter', () => {
			expect(equalitySeekKeyCount({ columnIndex: 0, op: 'IN', usable: true, value: [] as unknown as PredicateConstraint['value'] })).to.be.null;
			expect(equalitySeekKeyCount({ columnIndex: 0, op: 'IN', usable: true })).to.be.null;
			expect(equalitySeekKeyCount({ columnIndex: 0, op: '>', usable: true, value: 3 })).to.be.null;
			expect(isMultiValueEquality({ columnIndex: 0, op: '>', usable: true, value: 3 })).to.be.false;
		});

		it('rejects a runtime set whose maxCount is not a positive integer', () => {
			// Holds even where `validateAccessPlanRequest` never ran, so a bad request
			// degrades to a scan rather than to a zero-key seek.
			for (const bad of [0, -3, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
				expect(equalitySeekKeyCount(runtimeSetFilter(0, bad)), `maxCount = ${bad}`).to.be.null;
				expect(isMultiValueEquality(runtimeSetFilter(0, bad)), `maxCount = ${bad}`).to.be.false;
			}
		});
	});

	describe('request validation', () => {
		const request = (filter: PredicateConstraint): BestAccessPlanRequest => ({
			columns: [{ index: 0, name: 'a', type: 'INTEGER' as never, isPrimaryKey: true, isUnique: true }],
			filters: [filter],
		});
		const scanResult: BestAccessPlanResult = { handledFilters: [false], cost: 100, rows: 100 };

		it('accepts a well-formed runtime set', () => {
			expect(() => validateAccessPlan(request(runtimeSetFilter(0, 10)), scanResult)).not.to.throw();
		});

		it('accepts a well-formed runtime set carrying an advisory estimatedCount', () => {
			expect(() => validateAccessPlan(request(runtimeSetFilter(0, 10, 3)), scanResult)).not.to.throw();
		});

		it('rejects runtimeSet on a non-IN operator', () => {
			const f = { columnIndex: 0, op: '=' as const, usable: true, runtimeSet: { maxCount: 4 } };
			expect(() => validateAccessPlan(request(f), scanResult)).to.throw(/only valid on an 'IN' constraint/i);
		});

		it('rejects runtimeSet alongside a plan-time value', () => {
			const f = {
				columnIndex: 0,
				op: 'IN' as const,
				usable: true,
				value: [1, 2] as unknown as PredicateConstraint['value'],
				runtimeSet: { maxCount: 4 },
			};
			expect(() => validateAccessPlan(request(f), scanResult)).to.throw(/mutually exclusive/i);
		});

		it('rejects a maxCount below 1', () => {
			expect(() => validateAccessPlan(request(runtimeSetFilter(0, 0)), scanResult)).to.throw(/maxCount must be an integer/i);
		});

		it('rejects a non-integer maxCount', () => {
			expect(() => validateAccessPlan(request(runtimeSetFilter(0, 2.5)), scanResult)).to.throw(/maxCount must be an integer/i);
			expect(() => validateAccessPlan(request(runtimeSetFilter(0, Number.NaN)), scanResult)).to.throw(/maxCount must be an integer/i);
		});

		it('accepts an estimatedCount of 0 ("probably empty")', () => {
			expect(() => validateAccessPlan(request(runtimeSetFilter(0, 10, 0)), scanResult)).not.to.throw();
		});

		it('rejects an estimatedCount outside 0..maxCount or not an integer', () => {
			// An estimate above the ceiling describes a set the engine promised never to
			// deliver — an engine bug, not a pessimistic guess.
			for (const bad of [11, -1, 2.5, Number.NaN]) {
				expect(() => validateAccessPlan(request(runtimeSetFilter(0, 10, bad)), scanResult), `estimatedCount = ${bad}`)
					.to.throw(/estimatedCount must be an integer in 0\.\.10/i);
			}
		});
	});

	// A third-party module written before `runtimeSet` existed: its only IN
	// well-formedness test is the pre-existing literal-array shape, which a runtime set
	// fails. It must decline — never seek on an absent `value` — and the request itself
	// must not throw at it.
	describe('a module that has never heard of runtimeSet', () => {
		function legacyPlan(request: BestAccessPlanRequest): BestAccessPlanResult {
			const handledFilters = request.filters.map(f =>
				f.op === '=' || (f.op === 'IN' && Array.isArray(f.value) && (f.value as unknown[]).length > 0));
			const plan: BestAccessPlanResult = {
				handledFilters,
				cost: 100,
				rows: 100,
				explains: 'legacy module',
			};
			validateAccessPlan(request, plan);
			return plan;
		}

		it('declines a runtime set without throwing', () => {
			const request: BestAccessPlanRequest = {
				columns: [{ index: 0, name: 'a', type: 'INTEGER' as never, isPrimaryKey: true, isUnique: true }],
				filters: [runtimeSetFilter(0, 8)],
			};
			expect(() => legacyPlan(request)).not.to.throw();
			expect(legacyPlan(request).handledFilters).to.deep.equal([false]);
		});
	});

	describe('memory module', () => {
		let db: Database;
		let module: MemoryTableModule;

		/** The plan the memory module returns for `filters` over `table`. */
		function plan(
			tableName: string,
			filters: PredicateConstraint[],
			extra: Partial<BestAccessPlanRequest> = {},
		): BestAccessPlanResult {
			const table = db.schemaManager.getTable('main', tableName);
			expect(table, `table ${tableName} should exist`).to.exist;
			return module.getBestAccessPlan(db, table!, {
				columns: columnsOf(table!),
				filters,
				estimatedRows: 1000,
				...extra,
			});
		}

		beforeEach(async () => {
			db = new Database();
			module = new MemoryTableModule();
			await db.exec('create table t (id integer primary key, v integer, w integer, d timespan) using memory');
			await db.exec('create index by_v on t(v)');
			await db.exec('create index by_d on t(d)');
			await db.exec('create table ct (id integer primary key, a integer, b integer) using memory');
			await db.exec('create index by_ab on ct(a, b)');
		});

		afterEach(async () => {
			await db.close();
		});

		it('claims a runtime set on an indexed column as a multi-seek', () => {
			const result = plan('t', [runtimeSetFilter(1, 25)]);
			expect(result.handledFilters).to.deep.equal([true]);
			expect(result.indexName).to.equal('by_v');
			expect(result.seekColumnIndexes).to.deep.equal([1]);
			expect(result.isSet, 'a multi-seek is not a set').to.be.false;
		});

		it('declines a runtime set on an unindexed column', () => {
			const result = plan('t', [runtimeSetFilter(2, 25)]);
			expect(result.handledFilters).to.deep.equal([false]);
			expect(result.seekColumnIndexes).to.be.undefined;
		});

		it('plans a runtime set exactly like a literal IN of the same length', () => {
			// The whole point of the protocol: `maxCount` is the only fact the module gets,
			// and it stands in for the list length. Everything but the free-text explanation
			// must match.
			for (const n of [2, 25, 1000, 1001]) {
				const fromRuntimeSet = plan('t', [runtimeSetFilter(1, n)]);
				const fromLiteral = plan('t', [literalInFilter(1, n)]);
				expect({ ...fromRuntimeSet, explains: '' }, `n = ${n}`)
					.to.deep.equal({ ...fromLiteral, explains: '' });
			}
		});

		it('has no seek-key cap of its own (the engine enforces maxCount)', () => {
			// Unlike the store module, the memory module declines nothing on size — it is the
			// engine that promises never to deliver more than `maxCount` keys.
			expect(plan('t', [runtimeSetFilter(1, 1001)]).handledFilters).to.deep.equal([true]);
		});

		it('ignores estimatedCount: present and absent plan identically', () => {
			const withEstimate = plan('t', [runtimeSetFilter(1, 25, 3)]);
			const without = plan('t', [runtimeSetFilter(1, 25)]);
			expect(withEstimate).to.deep.equal(without);
		});

		it('does NOT claim ordering over a runtime-set seek column', () => {
			// A multi-seek visits the index in seek-key order, not column order, so a plan
			// that PUSHES the set must never also claim `providesOrdering` — that would let
			// the planner elide a Sort it needs. Asserted as the invariant rather than
			// against one plan shape: which of the two candidate plans wins is a cost
			// question, but a seeking plan claiming ordering is wrong at any cost.
			const ordering = { requiredOrdering: [{ columnIndex: 1, desc: false }] };

			// A key count small enough that seek-then-sort still wins, so the invariant is
			// asserted against a plan that ACTUALLY pushes the set. Without this case the
			// check below is vacuous — the 25-key plan does not seek at all (see the next
			// paragraph), and no other test pins the ordering claim under a required
			// ordering.
			const seeking = plan('t', [runtimeSetFilter(1, 5)], ordering);
			expect(seeking.seekColumnIndexes, 'five keys still price as a seek').to.deep.equal([1]);
			expect(seeking.providesOrdering, 'a seeking plan must leave the Sort to the planner').to.be.undefined;

			const result = plan('t', [runtimeSetFilter(1, 25)], ordering);
			if (result.seekColumnIndexes && result.seekColumnIndexes.length > 0) {
				expect(result.providesOrdering, 'a seeking plan must leave the Sort to the planner').to.be.undefined;
			}

			// The shape actually chosen today: 25 unknown keys against an un-analyzed
			// 1000-row table saturate the module's equality estimate (`min(N, 25 × 0.1N)`
			// is the whole table), so seek-then-sort-1000-rows prices above one ordered
			// index walk with the set left residual. That walk claims ordering legitimately
			// — it pushes nothing and emits in `v` order. The store module saturates the
			// same way from ten seek keys, by its own documented reasoning.
			//
			// `by_v` names no seek columns here, so `rule-key-set-seek` reads the answer as
			// a decline and skips its rewrite: correct rows, one lost speed-up, and only for
			// an un-analyzed table with an ORDER BY on the seek column. `ANALYZE` resolves
			// it — real per-column statistics stop the estimate saturating. The seek is
			// still taken without a required ordering ("claims a runtime set on an indexed
			// column as a multi-seek", above).
			expect(result.handledFilters, 'the set is left residual above the ordered walk').to.deep.equal([false]);
			expect(result.orderingIndexName).to.equal('by_v');

			// And it must match what a literal multi-value IN yields. This parity is the
			// protocol's whole promise — nothing may distinguish a runtime-derived set from
			// a hand-written list — so it holds whichever plan wins.
			const literal = plan('t', [literalInFilter(1, 25)], ordering);
			expect({ ...result, explains: '' }).to.deep.equal({ ...literal, explains: '' });
		});

		it('does not advertise monotonicOn over a runtime-set multi-seek', () => {
			expect(plan('t', [runtimeSetFilter(1, 25)]).monotonicOn).to.be.undefined;
		});

		it('is not treated as an equality-bound scan constant even at maxCount 1', () => {
			// `collectEqualityBoundColumns` folds a single-valued `IN (x)` into the "constant
			// for this scan" set, which lets index `(a, b)` satisfy an `order by b`. A runtime
			// set must never join that set — its member count is unknown, so `b` is not
			// ordered within it. Columns of `ct`: id = 0, a = 1, b = 2.
			const orderByB = { requiredOrdering: [{ columnIndex: 2, desc: false }] };
			const literal = plan('ct', [literalInFilter(1, 1)], orderByB);
			expect(literal.providesOrdering, 'a single-valued literal IN pins a and leaves b ordered')
				.to.deep.equal([{ columnIndex: 2, desc: false }]);

			const runtime = plan('ct', [runtimeSetFilter(1, 1)], orderByB);
			expect(runtime.providesOrdering, 'a maxCount=1 runtime set does not pin a').to.be.undefined;
		});

		it('reports a maxCount=1 runtime set as a multi-seek, not a unique-row seek', () => {
			// A literal `IN (x)` is one seek key and yields a set; a runtime set is delivered
			// as a `plan=5` multi-seek whatever its ceiling, so `isSet` must not be claimed.
			// This is the same divergence the store module's `isMultiSeek` flag encodes.
			const runtime = plan('t', [runtimeSetFilter(1, 1)]);
			expect(runtime.handledFilters).to.deep.equal([true]);
			expect(runtime.isSet, 'a multi-seek is not a set').to.be.false;
			expect(runtime.explains).to.match(/multi-seek/i);

			expect(plan('t', [literalInFilter(1, 1)]).isSet, 'a single-valued literal IN still is').to.be.true;
		});

		it('claims the FIRST role-filling filter when a runtime set and a literal IN share a column', () => {
			// Order-dependence must be deliberate, not accidental: whichever comes first in
			// `request.filters` is the one seeked, and the other stays residual.
			const runtimeFirst = plan('t', [runtimeSetFilter(1, 4), literalInFilter(1, 2)]);
			expect(runtimeFirst.handledFilters).to.deep.equal([true, false]);

			const literalFirst = plan('t', [literalInFilter(1, 2), runtimeSetFilter(1, 4)]);
			expect(literalFirst.handledFilters).to.deep.equal([true, false]);
		});

		it('treats a runtime set on a semantic-ordering column like a literal IN', () => {
			// The memory module's index comparators are typed (`createTypedComparator`), so a
			// TIMESPAN multi-seek compares by elapsed time and needs no decline — unlike the
			// store, whose byte-equality windows would under-fetch. Pin the parity so the two
			// modules' differing answers stay a deliberate difference.
			const runtime = plan('t', [runtimeSetFilter(3, 4)]);
			const literal = plan('t', [literalInFilter(3, 4)]);
			expect({ ...runtime, explains: '' }).to.deep.equal({ ...literal, explains: '' });
		});

		it('does not seek a composite index from a leading-column runtime set alone', () => {
			// Pre-existing memory-module behaviour: `findEqualityMatches` demands equality on
			// EVERY index column for the seek arm, so a leading-only prefix (literal or
			// runtime) falls back to a scan. The store module does claim that prefix.
			const runtime = plan('ct', [runtimeSetFilter(1, 4)]);
			const literal = plan('ct', [literalInFilter(1, 4)]);
			expect(runtime.handledFilters).to.deep.equal([false]);
			expect({ ...runtime, explains: '' }).to.deep.equal({ ...literal, explains: '' });
		});

		it('does not claim a runtime set marked unusable', () => {
			const unusable: PredicateConstraint = { ...runtimeSetFilter(1, 25), usable: false };
			expect(plan('t', [unusable]).handledFilters).to.deep.equal([false]);
		});

		it('rejects a malformed runtime set at the request boundary', () => {
			expect(() => plan('t', [{ columnIndex: 1, op: 'IN', usable: true, runtimeSet: { maxCount: 0 } }]))
				.to.throw(/maxCount must be an integer/i);
		});
	});
});

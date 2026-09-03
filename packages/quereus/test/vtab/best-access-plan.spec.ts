import { expect } from 'chai';
import { AccessPlanBuilder, validateAccessPlan, validateAccessPlanRequest } from '../../src/vtab/best-access-plan.js';
import type { BestAccessPlanRequest, BestAccessPlanResult, ColumnMeta } from '../../src/vtab/best-access-plan.js';
import { INTEGER_TYPE, TEXT_TYPE } from '../../src/types/index.js';

describe('AccessPlanBuilder', () => {
	const testColumns: ColumnMeta[] = [
		{ index: 0, name: 'id', type: INTEGER_TYPE, isPrimaryKey: true, isUnique: true },
		{ index: 1, name: 'name', type: TEXT_TYPE, isPrimaryKey: false, isUnique: false },
		{ index: 2, name: 'age', type: INTEGER_TYPE, isPrimaryKey: false, isUnique: false },
	];

	describe('static factories', () => {
		it('should create a full scan plan', () => {
			const plan = AccessPlanBuilder.fullScan(100).build();
			expect(plan.cost).to.equal(100);
			expect(plan.rows).to.equal(100);
			expect(plan.explains).to.equal('Full table scan');
			expect(plan.handledFilters).to.deep.equal([]);
		});

		it('should create a full scan with zero rows', () => {
			const plan = AccessPlanBuilder.fullScan(0).build();
			expect(plan.cost).to.equal(0);
			expect(plan.rows).to.equal(0);
		});

		it('should create an equality match plan', () => {
			const plan = AccessPlanBuilder.eqMatch(1).build();
			expect(plan.cost).to.equal(0.5 + 1 * 0.3);
			expect(plan.rows).to.equal(1);
			expect(plan.isSet).to.be.true; // single row → set
			expect(plan.explains).to.equal('Index equality seek');
		});

		it('should create an eqMatch with multiple rows (not a set)', () => {
			const plan = AccessPlanBuilder.eqMatch(5).build();
			expect(plan.rows).to.equal(5);
			expect(plan.isSet).to.be.false;
		});

		it('should create an eqMatch with custom index cost', () => {
			const plan = AccessPlanBuilder.eqMatch(10, 1.0).build();
			expect(plan.cost).to.equal(1.0 + 10 * 0.3);
		});

		it('should create a range scan plan', () => {
			const plan = AccessPlanBuilder.rangeScan(50).build();
			expect(plan.cost).to.equal(0.3 + 50 * 0.5);
			expect(plan.rows).to.equal(50);
			expect(plan.explains).to.equal('Index range scan');
		});

		it('empty() builds the whole proven-empty answer', () => {
			const plan = AccessPlanBuilder.empty([true, false]).build();
			expect(plan.cost).to.equal(0);
			expect(plan.rows).to.equal(0);
			expect(plan.provablyEmpty).to.be.true;
			expect(plan.handledFilters).to.deep.equal([true, false]);
		});

		it('empty() refuses a proof that claims no filter', () => {
			// A module cannot prove a predicate unsatisfiable without claiming the predicate.
			expect(() => AccessPlanBuilder.empty([false, false])).to.throw(/at least one handled filter/i);
			expect(() => AccessPlanBuilder.empty([])).to.throw(/at least one handled filter/i);
		});

		it('should create a range scan with custom index cost', () => {
			const plan = AccessPlanBuilder.rangeScan(20, 1.5).build();
			expect(plan.cost).to.equal(1.5 + 20 * 0.5);
		});
	});

	describe('builder methods', () => {
		it('should chain setters fluently', () => {
			const plan = new AccessPlanBuilder()
				.setCost(42)
				.setRows(10)
				.setHandledFilters([true, false])
				.setOrdering([{ columnIndex: 0, desc: false }])
				.setIsSet(true)
				.setExplanation('custom plan')
				.setIndexName('idx_test')
				.setSeekColumns([0])
				.build();

			expect(plan.cost).to.equal(42);
			expect(plan.rows).to.equal(10);
			expect(plan.handledFilters).to.deep.equal([true, false]);
			expect(plan.providesOrdering).to.deep.equal([{ columnIndex: 0, desc: false }]);
			expect(plan.isSet).to.be.true;
			expect(plan.explains).to.equal('custom plan');
			expect(plan.indexName).to.equal('idx_test');
			expect(plan.seekColumnIndexes).to.deep.equal([0]);
		});

		it('should set residual filter', () => {
			const filterFn = (_row: unknown[]) => true;
			const plan = new AccessPlanBuilder()
				.setCost(1)
				.setResidualFilter(filterFn)
				.build();

			expect(plan.residualFilter).to.equal(filterFn);
		});

		it('should throw when cost is not set', () => {
			expect(() => new AccessPlanBuilder().build()).to.throw();
		});

		it('addCost adds to a shape factory\'s cost without restating its formula', () => {
			const plan = AccessPlanBuilder.eqMatch(10, 0.3).addCost(10 * 1.0).build();
			expect(plan.cost).to.be.closeTo(0.3 + 10 * 0.3 + 10, 1e-9);
			expect(plan.rows, 'and leaves the shape otherwise untouched').to.equal(10);
		});

		it('addCost accumulates and follows setCost', () => {
			const plan = new AccessPlanBuilder().setCost(5).addCost(2).addCost(3).build();
			expect(plan.cost).to.equal(10);
		});

		it('addCost throws when no cost has been set yet', () => {
			expect(() => new AccessPlanBuilder().addCost(1)).to.throw(/cost/);
		});

		it('should default handledFilters to empty array', () => {
			const plan = new AccessPlanBuilder().setCost(1).build();
			expect(plan.handledFilters).to.deep.equal([]);
		});

		it('should allow rows to be undefined', () => {
			const plan = new AccessPlanBuilder().setCost(1).setRows(undefined).build();
			expect(plan.rows).to.be.undefined;
		});
	});

	describe('validateAccessPlan', () => {
		function makeRequest(filters: number = 0): BestAccessPlanRequest {
			return {
				columns: testColumns,
				filters: Array.from({ length: filters }, (_, i) => ({
					columnIndex: i % testColumns.length,
					op: '=' as const,
					usable: true,
				})),
			};
		}

		it('should pass for a valid plan with matching filters', () => {
			const request = makeRequest(2);
			const result: BestAccessPlanResult = {
				handledFilters: [true, false],
				cost: 10,
				rows: 5,
			};
			expect(() => validateAccessPlan(request, result)).not.to.throw();
		});

		it('should pass for zero-filter plan', () => {
			const request = makeRequest(0);
			const result: BestAccessPlanResult = {
				handledFilters: [],
				cost: 100,
				rows: 100,
			};
			expect(() => validateAccessPlan(request, result)).not.to.throw();
		});

		it('should throw when handledFilters length mismatches', () => {
			const request = makeRequest(3);
			const result: BestAccessPlanResult = {
				handledFilters: [true],
				cost: 10,
				rows: 5,
			};
			expect(() => validateAccessPlan(request, result)).to.throw(/handledFilters length/);
		});

		it('should throw for negative cost', () => {
			const request = makeRequest(0);
			const result: BestAccessPlanResult = {
				handledFilters: [],
				cost: -1,
				rows: 5,
			};
			expect(() => validateAccessPlan(request, result)).to.throw(/negative/);
		});

		it('should throw for negative rows', () => {
			const request = makeRequest(0);
			const result: BestAccessPlanResult = {
				handledFilters: [],
				cost: 10,
				rows: -5,
			};
			expect(() => validateAccessPlan(request, result)).to.throw(/negative/);
		});

		it('should allow undefined rows', () => {
			const request = makeRequest(0);
			const result: BestAccessPlanResult = {
				handledFilters: [],
				cost: 10,
				rows: undefined,
			};
			expect(() => validateAccessPlan(request, result)).not.to.throw();
		});

		it('should throw for out-of-range ordering column index', () => {
			const request = makeRequest(0);
			const result: BestAccessPlanResult = {
				handledFilters: [],
				cost: 10,
				rows: 5,
				providesOrdering: [{ columnIndex: 99, desc: false }],
				orderingIndexName: 'ix_test',
			};
			expect(() => validateAccessPlan(request, result)).to.throw(/ordering column index/i);
		});

		it('should throw for negative ordering column index', () => {
			const request = makeRequest(0);
			const result: BestAccessPlanResult = {
				handledFilters: [],
				cost: 10,
				rows: 5,
				providesOrdering: [{ columnIndex: -1, desc: false }],
				orderingIndexName: 'ix_test',
			};
			expect(() => validateAccessPlan(request, result)).to.throw(/ordering column index/i);
		});

		it('should pass for valid ordering column indexes', () => {
			const request = makeRequest(0);
			const result: BestAccessPlanResult = {
				handledFilters: [],
				cost: 10,
				rows: 5,
				providesOrdering: [{ columnIndex: 0, desc: false }, { columnIndex: 2, desc: true }],
				orderingIndexName: 'ix_test',
			};
			expect(() => validateAccessPlan(request, result)).not.to.throw();
		});

		it('should throw when providesOrdering is set without orderingIndexName', () => {
			const request = makeRequest(0);
			const result: BestAccessPlanResult = {
				handledFilters: [],
				cost: 10,
				rows: 5,
				providesOrdering: [{ columnIndex: 0, desc: false }],
			};
			expect(() => validateAccessPlan(request, result)).to.throw(/providesOrdering requires orderingIndexName/i);
		});

		it('should throw when indexName mismatches orderingIndexName', () => {
			const request = makeRequest(0);
			const result: BestAccessPlanResult = {
				handledFilters: [],
				cost: 10,
				rows: 5,
				providesOrdering: [{ columnIndex: 0, desc: false }],
				orderingIndexName: 'ix_alpha',
				indexName: 'ix_beta',
			};
			expect(() => validateAccessPlan(request, result)).to.throw(/ordering can only be claimed from the same index/i);
		});

		it('should pass when indexName matches orderingIndexName', () => {
			const request = makeRequest(0);
			const result: BestAccessPlanResult = {
				handledFilters: [],
				cost: 10,
				rows: 5,
				providesOrdering: [{ columnIndex: 0, desc: false }],
				orderingIndexName: 'ix_test',
				indexName: 'ix_test',
			};
			expect(() => validateAccessPlan(request, result)).not.to.throw();
		});

		it('should throw for out-of-range seek column index', () => {
			const request = makeRequest(0);
			const result: BestAccessPlanResult = {
				handledFilters: [],
				cost: 10,
				rows: 5,
				seekColumnIndexes: [0, 99],
			};
			expect(() => validateAccessPlan(request, result)).to.throw(/seek column index/i);
		});

		it('should throw for negative seek column index', () => {
			const request = makeRequest(0);
			const result: BestAccessPlanResult = {
				handledFilters: [],
				cost: 10,
				rows: 5,
				seekColumnIndexes: [-1],
			};
			expect(() => validateAccessPlan(request, result)).to.throw(/seek column index/i);
		});

		it('should skip ordering validation when not provided', () => {
			const request = makeRequest(0);
			const result: BestAccessPlanResult = {
				handledFilters: [],
				cost: 10,
				rows: 5,
			};
			expect(() => validateAccessPlan(request, result)).not.to.throw();
		});

		it('should pass when monotonicOn references a valid column', () => {
			const request = makeRequest(0);
			const result: BestAccessPlanResult = {
				handledFilters: [],
				cost: 10,
				rows: 5,
				monotonicOn: { columnIndex: 0, direction: 'asc', strict: true },
			};
			expect(() => validateAccessPlan(request, result)).not.to.throw();
		});

		it('should throw for out-of-range monotonicOn column index', () => {
			const request = makeRequest(0);
			const result: BestAccessPlanResult = {
				handledFilters: [],
				cost: 10,
				rows: 5,
				monotonicOn: { columnIndex: 99, direction: 'asc', strict: true },
			};
			expect(() => validateAccessPlan(request, result)).to.throw(/monotonicOn column index/i);
		});

		it('should throw for negative monotonicOn column index', () => {
			const request = makeRequest(0);
			const result: BestAccessPlanResult = {
				handledFilters: [],
				cost: 10,
				rows: 5,
				monotonicOn: { columnIndex: -1, direction: 'asc', strict: false },
			};
			expect(() => validateAccessPlan(request, result)).to.throw(/monotonicOn column index/i);
		});

		it('accepts a well-formed provablyEmpty plan', () => {
			const request = makeRequest(2);
			const result: BestAccessPlanResult = {
				handledFilters: [true, false],
				cost: 0,
				rows: 0,
				provablyEmpty: true,
			};
			expect(() => validateAccessPlan(request, result)).not.to.throw();
		});

		it('should throw when provablyEmpty claims no filter', () => {
			const request = makeRequest(2);
			const result: BestAccessPlanResult = {
				handledFilters: [false, false],
				cost: 0,
				rows: 0,
				provablyEmpty: true,
			};
			expect(() => validateAccessPlan(request, result, 'testmod')).to.throw(/provablyEmpty but claims no filter/i);
			// The message names the offending module when the caller supplied its name.
			expect(() => validateAccessPlan(request, result, 'testmod')).to.throw(/testmod/);
		});

		it('should throw when provablyEmpty accompanies a non-zero row count', () => {
			const request = makeRequest(1);
			const nonZero: BestAccessPlanResult = {
				handledFilters: [true],
				cost: 0,
				rows: 5,
				provablyEmpty: true,
			};
			expect(() => validateAccessPlan(request, nonZero)).to.throw(/provablyEmpty but reports rows: 5/i);

			// `undefined` is "no estimate", which contradicts a proof just as much.
			const unknown: BestAccessPlanResult = { ...nonZero, rows: undefined };
			expect(() => validateAccessPlan(request, unknown)).to.throw(/provablyEmpty but reports rows/i);
		});

		it('leaves a plain rows: 0 estimate alone', () => {
			// The old overload: every filter claimed, zero rows, no proof. Legal now, and the
			// planner reads it as an estimate.
			const request = makeRequest(1);
			const result: BestAccessPlanResult = {
				handledFilters: [true],
				cost: 0,
				rows: 0,
			};
			expect(() => validateAccessPlan(request, result)).not.to.throw();
		});

		it('should throw when supportsOrdinalSeek is set without monotonicOn', () => {
			const request = makeRequest(0);
			const result: BestAccessPlanResult = {
				handledFilters: [],
				cost: 10,
				rows: 5,
				supportsOrdinalSeek: true,
			};
			expect(() => validateAccessPlan(request, result)).to.throw(/supportsOrdinalSeek requires monotonicOn/i);
		});

		it('should throw when supportsAsofRight is set without monotonicOn', () => {
			const request = makeRequest(0);
			const result: BestAccessPlanResult = {
				handledFilters: [],
				cost: 10,
				rows: 5,
				supportsAsofRight: true,
			};
			expect(() => validateAccessPlan(request, result)).to.throw(/supportsAsofRight requires monotonicOn/i);
		});

		it('should pass when capability flags accompany monotonicOn', () => {
			const request = makeRequest(0);
			const result: BestAccessPlanResult = {
				handledFilters: [],
				cost: 10,
				rows: 5,
				monotonicOn: { columnIndex: 0, direction: 'asc', strict: true },
				supportsOrdinalSeek: true,
				supportsAsofRight: true,
			};
			expect(() => validateAccessPlan(request, result)).not.to.throw();
		});
	});
	describe('validateAccessPlanRequest — estimatedRows', () => {
		/**
		 * Three spellings, all distinct and all legal on the way in: `undefined` (nobody
		 * measured the table — what every planner site now sends for a never-analyzed one),
		 * `0` (measured, and empty — a module is entitled to price against it), and a
		 * positive integer (measured). Anything else is a caller bug.
		 */
		const requestWith = (estimatedRows?: number): BestAccessPlanRequest => ({
			columns: testColumns,
			filters: [],
			estimatedRows,
		});

		it('accepts undefined — the spelling for "nobody measured this table"', () => {
			expect(() => validateAccessPlanRequest(requestWith(undefined))).not.to.throw();
		});

		it('accepts a measured 0, which is not the same thing as unknown', () => {
			expect(() => validateAccessPlanRequest(requestWith(0))).not.to.throw();
		});

		it('accepts a measured positive count', () => {
			expect(() => validateAccessPlanRequest(requestWith(1_000_000))).not.to.throw();
		});

		it('rejects a negative count', () => {
			expect(() => validateAccessPlanRequest(requestWith(-1))).to.throw(/estimatedRows/);
		});

		it('rejects a non-integer count', () => {
			expect(() => validateAccessPlanRequest(requestWith(12.5))).to.throw(/estimatedRows/);
			expect(() => validateAccessPlanRequest(requestWith(Number.NaN))).to.throw(/estimatedRows/);
		});
	});
});

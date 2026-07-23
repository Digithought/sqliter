import { expect } from 'chai';
import * as fc from 'fast-check';
import { Database } from '../src/core/database.js';
import type { SqlValue } from '../src/common/types.js';


// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

interface ColSpec { name: string; type: 'INTEGER' | 'REAL' | 'TEXT' }
interface TableSpec { name: string; columns: ColSpec[] }

// ---------------------------------------------------------------------------
// Shared arbitraries
// ---------------------------------------------------------------------------

const colTypeArb = fc.constantFrom<'INTEGER' | 'REAL' | 'TEXT'>('INTEGER', 'REAL', 'TEXT');

function tableSpecArb(tableName: string, extraCols: { min: number; max: number }): fc.Arbitrary<TableSpec> {
	const extraColNames = ['a', 'b', 'c', 'd'];
	return fc.tuple(
		fc.integer({ min: extraCols.min, max: extraCols.max }),
		fc.array(colTypeArb, { minLength: extraCols.max, maxLength: extraCols.max })
	).map(([count, types]) => ({
		name: tableName,
		columns: [
			{ name: 'id', type: 'INTEGER' as const },
			...types.slice(0, count).map((t, i) => ({ name: extraColNames[i], type: t }))
		]
	}));
}

function rowArb(spec: TableSpec): fc.Arbitrary<SqlValue[]> {
	return fc.tuple(
		...spec.columns.map(col => {
			// The first column (id) will be assigned separately, but generate a placeholder
			if (col.name === 'id') return fc.constant(0 as SqlValue);
			return valueArbForType(col.type);
		})
	);
}

function valueArbForType(type: 'INTEGER' | 'REAL' | 'TEXT'): fc.Arbitrary<SqlValue> {
	switch (type) {
		case 'INTEGER':
			return fc.oneof(
				fc.integer({ min: -100, max: 100 }),
				fc.constant(null as SqlValue)
			);
		case 'REAL':
			return fc.oneof(
				fc.float({ min: -100, max: 100, noNaN: true, noDefaultInfinity: true }),
				fc.constant(null as SqlValue)
			);
		case 'TEXT':
			return fc.constantFrom<SqlValue>('alpha', 'beta', 'gamma', 'delta', '', null);
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function setupSchema(db: Database, specs: TableSpec[], rows: Map<string, SqlValue[][]>): Promise<void> {
	for (const spec of specs) {
		const colDefs = spec.columns
			.map(c => c.name === 'id' ? `${c.name} ${c.type} PRIMARY KEY` : `${c.name} ${c.type} null`)
			.join(', ');
		await db.exec(`CREATE TABLE ${spec.name} (${colDefs}) USING memory`);

		const tableRows = rows.get(spec.name);
		if (!tableRows || tableRows.length === 0) continue;

		const colNames = spec.columns.map(c => c.name).join(', ');
		const placeholders = spec.columns.map(() => '?').join(', ');
		const sql = `INSERT INTO ${spec.name} (${colNames}) VALUES (${placeholders})`;
		for (let i = 0; i < tableRows.length; i++) {
			const row = [...tableRows[i]];
			row[0] = i + 1; // assign id
			// Fresh statement per row to avoid parameter type mismatch across rows
			const stmt = db.prepare(sql);
			try { await stmt.run(row); } finally { await stmt.finalize(); }
		}
	}
}

async function collectResultSet(db: Database, sql: string): Promise<Record<string, SqlValue>[]> {
	const results: Record<string, SqlValue>[] = [];
	for await (const row of db.eval(sql)) {
		results.push(row as Record<string, SqlValue>);
	}
	return results;
}

function assertSameResultSet(a: Record<string, SqlValue>[], b: Record<string, SqlValue>[]): void {
	const serialize = (rows: Record<string, SqlValue>[]) =>
		rows.map(r => JSON.stringify(r, Object.keys(r).sort())).sort();
	const sa = serialize(a);
	const sb = serialize(b);
	expect(sa).to.deep.equal(sb);
}

async function collectPlan(db: Database, sql: string): Promise<Record<string, SqlValue>[]> {
	const results: Record<string, SqlValue>[] = [];
	for await (const row of db.eval(`SELECT op, node_type FROM query_plan(?) ORDER BY id`, [sql])) {
		results.push(row as Record<string, SqlValue>);
	}
	return results;
}

function withDisabledRule(db: Database, ruleId: string, fn: () => Promise<void>): Promise<void> {
	const baseTuning = db.optimizer.tuning;
	db.optimizer.updateTuning({ ...baseTuning, disabledRules: new Set([ruleId]) });
	return fn().finally(() => {
		db.optimizer.updateTuning(baseTuning);
	});
}

function skewedDataArb(spec: TableSpec, count: number): fc.Arbitrary<SqlValue[][]> {
	return fc.constantFrom<'high-cardinality' | 'clustered-nulls' | 'monotonic'>('high-cardinality', 'clustered-nulls', 'monotonic').chain(skewType => {
		return fc.tuple(
			fc.array(rowArb(spec), { minLength: count, maxLength: count }),
			fc.array(fc.integer({ min: 0, max: 99 }), { minLength: count, maxLength: count })
		).map(([baseRows, randoms]) => {
			return baseRows.map((row, i) => {
				const newRow = [...row];
				// Column index 1 is the first non-id column
				if (spec.columns.length > 1) {
					switch (skewType) {
						case 'high-cardinality':
							// 80% of rows get the same value
							if (randoms[i] < 80) {
								newRow[1] = spec.columns[1].type === 'TEXT' ? 'skewed' : 42;
							}
							break;
						case 'clustered-nulls':
							// 90% null in first non-id column
							if (randoms[i] < 90) {
								newRow[1] = null;
							}
							break;
						case 'monotonic':
							// Monotonically increasing values
							newRow[1] = spec.columns[1].type === 'TEXT' ? `val_${String(i).padStart(4, '0')}` : i + 1;
							break;
					}
				}
				return newRow;
			});
		});
	});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Property-Based Planner/Optimizer Tests', function () {

	// These are fast-check-heavy suites: each `it` drives dozens of property
	// runs that each spin up a Database, load rows, and plan/run queries. In
	// isolation individual cases run well under a second, but under the default
	// 2000ms mocha timeout they can slip past the budget when the host is under
	// CPU contention (e.g. the full-monorepo test run). Give the whole suite a
	// generous per-test budget; the stress sub-suite below overrides it higher.
	this.timeout(30_000);

	// -----------------------------------------------------------------------
	// Property 1: Semantic equivalence under optimizer rules
	// -----------------------------------------------------------------------
	describe('Semantic equivalence under optimizer rules', () => {

		const singleTableSpec = tableSpecArb('t1', { min: 2, max: 4 });
		const twoTableSpecs = fc.tuple(
			tableSpecArb('t1', { min: 2, max: 4 }),
			tableSpecArb('t2', { min: 2, max: 4 })
		);

		function singleTableDataArb(spec: TableSpec): fc.Arbitrary<SqlValue[][]> {
			return fc.array(rowArb(spec), { minLength: 20, maxLength: 100 });
		}

		interface RuleDef {
			id: string;
			specArb: fc.Arbitrary<TableSpec[]>;
			queryFn: (specs: TableSpec[]) => string;
			dataArb: (specs: TableSpec[]) => fc.Arbitrary<Map<string, SqlValue[][]>>;
			/**
			 * Optional extra DDL run after the tables are created and loaded, before
			 * the query is planned — e.g. a CREATE VIEW the query references. Used by
			 * projection-pruning, whose Project-on-Project firing shape only forms
			 * through view expansion (a FROM-subquery interposes an AliasNode that
			 * blocks the rule).
			 */
			setup?: (db: Database, specs: TableSpec[]) => Promise<void>;
		}

		const singleTableRules: RuleDef[] = [
			{
				id: 'predicate-pushdown',
				specArb: singleTableSpec.map(s => [s]),
				// Interpose a Distinct the rule must visibly move the Filter across.
				// A bare `WHERE ... AND id > 0` on t1 lands in the Retrieve pipeline
				// during building (grow-retrieve), so enabled/disabled plans match and
				// the rule never fires. The inner DISTINCT survives to the rule's pass;
				// enabled pushes the Filter below it, disabled keeps it above → plans differ.
				queryFn: () => `SELECT * FROM (SELECT DISTINCT a, b FROM t1) sub WHERE a IS NOT NULL`,
				dataArb: (specs) => singleTableDataArb(specs[0]).map(rows => new Map([['t1', rows]]))
			},
			{
				id: 'filter-merge',
				specArb: singleTableSpec.map(s => [s]),
				queryFn: (specs) => {
					const cols = specs[0].columns.filter(c => c.name !== 'id');
					const c1 = cols[0]?.name ?? 'a';
					return `SELECT * FROM (SELECT * FROM t1 WHERE ${c1} IS NOT NULL) sub WHERE id > 0`;
				},
				dataArb: (specs) => singleTableDataArb(specs[0]).map(rows => new Map([['t1', rows]]))
			},
			{
				id: 'distinct-elimination',
				specArb: singleTableSpec.map(s => [s]),
				queryFn: () => `SELECT DISTINCT id FROM t1`,
				dataArb: (specs) => singleTableDataArb(specs[0]).map(rows => new Map([['t1', rows]]))
			},
			{
				id: 'projection-pruning',
				specArb: singleTableSpec.map(s => [s]),
				// The rule fires only when a ProjectNode's source is also a ProjectNode
				// and the outer references a strict subset of the inner's outputs. Two
				// obstacles: (1) a pass-through `SELECT a, b` inner projection gets
				// absorbed into the Retrieve during building, leaving no inner
				// ProjectNode — defeated by a *computed* column (`id + 1`), which cannot
				// be absorbed into a scan; (2) a FROM-subquery interposes an AliasNode
				// between the two projections (Project→Alias→Project), which the rule
				// does not look through — defeated by using a VIEW, whose expansion
				// yields Project→Project directly. So: view v = {a, e=id+1}; the outer
				// selects only `a`, so the computed `e` is pruned from the inner Project.
				// Use `id` (always INTEGER) so the computed column never depends on a
				// randomly-typed extra column.
				setup: async (db) => { await db.exec(`CREATE VIEW v AS SELECT a, id + 1 AS e FROM t1`); },
				queryFn: () => `SELECT a FROM v`,
				dataArb: (specs) => singleTableDataArb(specs[0]).map(rows => new Map([['t1', rows]]))
			},
			{
				id: 'scalar-cse',
				specArb: singleTableSpec.map(s => [s]),
				queryFn: (specs) => {
					const cols = specs[0].columns.filter(c => c.type === 'INTEGER' || c.type === 'REAL');
					if (cols.length >= 2) {
						return `SELECT ${cols[0].name} + ${cols[1].name} AS s1, ${cols[0].name} + ${cols[1].name} + 1 AS s2 FROM t1`;
					}
					// Fallback: just use id
					return `SELECT id + id AS s1, id + id + 1 AS s2 FROM t1`;
				},
				dataArb: (specs) => singleTableDataArb(specs[0]).map(rows => new Map([['t1', rows]]))
			}
		];

		// Two rules are deliberately absent from this fire-coverage set: a swap /
		// diagnostic pass they perform is invisible to the plan-diff signal (op +
		// node_type, ORDER BY id), so enabling vs. disabling them yields an identical
		// op/node_type stream. ruleFireCount can never exceed 0 for them, so the
		// assertion below would fail no matter the generated shape:
		//
		//   - 'join-key-inference' is diagnostic-only: it `return null`s
		//     unconditionally and only logs FK->PK detection. Its real effect flows
		//     through computePhysical / CatalogStatsProvider.joinSelectivity (cost +
		//     key propagation), not the plan tree. Covered by
		//     test/optimizer/keys-propagation.spec.ts.
		//
		//   - 'join-greedy-commute' swaps an inner join's two children when the right
		//     is the smaller nested-loop driver. Both join inputs here are a bare
		//     IndexScan -> TableReference, so swapping them leaves the op/node_type
		//     sequence unchanged — the swap is not plan-observable through this diff
		//     (and PostOptimization physical-join selection re-canonicalizes
		//     build/probe order regardless). Its correctness — inner-join
		//     commutativity — is covered by the 'Join commutativity' suite below.
		//     (Verified by dumping enabled/disabled query_plan for the asymmetric-data
		//     shape: the op/node_type streams were byte-identical.)
		//
		// NOTE: neither removed rule has a "disabling it leaves the result set
		// unchanged" check here. If that specific coverage is ever wanted, a plan
		// diff can't provide it (see above) — assert on a cost / among-plans signal
		// or on child order exposed some other way, not on op/node_type.
		const twoTableRules: RuleDef[] = [
			{
				id: 'subquery-decorrelation',
				specArb: twoTableSpecs.map(([s1, s2]) => [s1, s2]),
				// A *correlated* EXISTS: the rule anchors on a FilterNode whose
				// predicate has a correlated EXISTS/IN and rewrites it into a
				// semi-join. The old `a IN (SELECT b FROM t2)` was uncorrelated, so
				// isCorrelatedSubquery was false and the rule bailed. `t2.a = t1.a`
				// correlates it; both tables always have `a` (extra-col min is 2).
				queryFn: () => `SELECT * FROM t1 WHERE EXISTS (SELECT 1 FROM t2 WHERE t2.a = t1.a)`,
				dataArb: (specs) => fc.tuple(
					singleTableDataArb(specs[0]),
					singleTableDataArb(specs[1])
				).map(([r1, r2]) => new Map([['t1', r1], ['t2', r2]]))
			}
		];

		for (const ruleDef of [...singleTableRules, ...twoTableRules]) {
			it(`result set unchanged when '${ruleDef.id}' is disabled`, async () => {
				let ruleFireCount = 0;
				const numRuns = 30;

				await fc.assert(fc.asyncProperty(
					ruleDef.specArb.chain(specs => {
						return ruleDef.dataArb(specs).map(data => ({ specs, data }));
					}),
					async ({ specs, data }) => {
						const db = new Database();
						try {
							await setupSchema(db, specs, data);
							if (ruleDef.setup) await ruleDef.setup(db, specs);
							const query = ruleDef.queryFn(specs);

							// Run with all rules enabled
							const resultEnabled = await collectResultSet(db, query);
							const planEnabled = await collectPlan(db, query);

							// Run with this rule disabled
							let resultDisabled: Record<string, SqlValue>[];
							let planDisabled: Record<string, SqlValue>[];
							await withDisabledRule(db, ruleDef.id, async () => {
								resultDisabled = await collectResultSet(db, query);
								planDisabled = await collectPlan(db, query);
							});

							assertSameResultSet(resultEnabled, resultDisabled!);

							// Track whether the rule actually fired (plans differ)
							const planEnabledStr = JSON.stringify(planEnabled);
							const planDisabledStr = JSON.stringify(planDisabled!);
							if (planEnabledStr !== planDisabledStr) {
								ruleFireCount++;
							}
						} finally {
							await db.close();
						}
					}
				), { numRuns });

				// Hard-fail if the rule never fired across all runs: a rule whose
				// enabled/disabled plans are always identical gets no coverage from the
				// equivalence assertion above (it passes vacuously). Every rule left in
				// the two rule arrays is plan-observable, so this is uniform — no
				// per-rule special-casing. The two rules whose effect is invisible to
				// the op/node_type plan diff (join-key-inference, join-greedy-commute)
				// are *removed* (see the note on twoTableRules), not merely un-asserted
				// here.
				expect(ruleFireCount,
					`Rule '${ruleDef.id}' never fired across ${numRuns} runs — ` +
					`the disabled-rule equivalence check is vacuous for it`
				).to.be.greaterThan(0);
			});
		}
	});

	// -----------------------------------------------------------------------
	// Property 1b: Semantic equivalence with skewed data
	// -----------------------------------------------------------------------
	describe('Semantic equivalence with skewed data', () => {
		const skewedRules: Array<{ id: string; specArb: fc.Arbitrary<TableSpec[]>; queryFn: (specs: TableSpec[]) => string }> = [
			{
				id: 'predicate-pushdown',
				specArb: tableSpecArb('t1', { min: 2, max: 4 }).map(s => [s]),
				queryFn: (specs) => {
					const cols = specs[0].columns.filter(c => c.name !== 'id');
					const c1 = cols[0]?.name ?? 'a';
					return `SELECT * FROM t1 WHERE ${c1} IS NOT NULL AND id > 0`;
				},
			},
			{
				id: 'distinct-elimination',
				specArb: tableSpecArb('t1', { min: 2, max: 4 }).map(s => [s]),
				queryFn: () => `SELECT DISTINCT id FROM t1`,
			},
		];

		for (const ruleDef of skewedRules) {
			it(`result set unchanged when '${ruleDef.id}' is disabled (skewed data)`, async () => {
				await fc.assert(fc.asyncProperty(
					ruleDef.specArb.chain(specs => {
						return skewedDataArb(specs[0], 50).map(rows => ({
							specs,
							data: new Map([['t1', rows]])
						}));
					}),
					async ({ specs, data }) => {
						const db = new Database();
						try {
							await setupSchema(db, specs, data);
							const query = ruleDef.queryFn(specs);
							const resultEnabled = await collectResultSet(db, query);
							let resultDisabled: Record<string, SqlValue>[];
							await withDisabledRule(db, ruleDef.id, async () => {
								resultDisabled = await collectResultSet(db, query);
							});
							assertSameResultSet(resultEnabled, resultDisabled!);
						} finally {
							await db.close();
						}
					}
				), { numRuns: 20 });
			});
		}
	});

	// -----------------------------------------------------------------------
	// Property 2: Optimizer determinism
	// -----------------------------------------------------------------------
	describe('Optimizer determinism', () => {
		const schemaArb = tableSpecArb('t1', { min: 2, max: 4 });

		it('same query produces identical plan on repeated prepare', async () => {
			await fc.assert(fc.asyncProperty(
				schemaArb.chain(spec => {
					return fc.array(rowArb(spec), { minLength: 1, maxLength: 15 })
						.map(rows => ({ spec, rows }));
				}),
				async ({ spec, rows }) => {
					const db = new Database();
					try {
						await setupSchema(db, [spec], new Map([['t1', rows]]));

						const cols = spec.columns.filter(c => c.name !== 'id');
						const c1 = cols[0]?.name ?? 'a';
						const query = `SELECT * FROM t1 WHERE ${c1} IS NOT NULL ORDER BY id`;

						const plan1 = await collectPlan(db, query);
						const plan2 = await collectPlan(db, query);
						expect(plan1).to.deep.equal(plan2);
					} finally {
						await db.close();
					}
				}
			), { numRuns: 30 });
		});
	});

	// -----------------------------------------------------------------------
	// Property 3: Join commutativity
	// -----------------------------------------------------------------------
	describe('Join commutativity', () => {
		const twoTables = fc.tuple(
			tableSpecArb('t1', { min: 1, max: 3 }),
			tableSpecArb('t2', { min: 1, max: 3 })
		);

		it('A JOIN B produces same result set as B JOIN A', async () => {
			await fc.assert(fc.asyncProperty(
				twoTables.chain(([s1, s2]) => {
					return fc.tuple(
						fc.array(rowArb(s1), { minLength: 1, maxLength: 15 }),
						fc.array(rowArb(s2), { minLength: 1, maxLength: 15 })
					).map(([r1, r2]) => ({ specs: [s1, s2], rows: new Map([['t1', r1], ['t2', r2]]) }));
				}),
				async ({ specs, rows }) => {
					const db = new Database();
					try {
						await setupSchema(db, specs, rows);

						// Use the first non-id column from t2 as join column
						const cols2 = specs[1].columns.filter(c => c.name !== 'id');
						const joinCol = cols2[0]?.name ?? 'a';

						// Build explicit column lists with aliases to avoid name collisions
						const t1Cols = specs[0].columns.map(c => `t1.${c.name} AS t1_${c.name}`).join(', ');
						const t2Cols = specs[1].columns.map(c => `t2.${c.name} AS t2_${c.name}`).join(', ');
						const selectCols = `${t1Cols}, ${t2Cols}`;

						const queryAB = `SELECT ${selectCols} FROM t1 JOIN t2 ON t1.id = t2.${joinCol}`;
						const queryBA = `SELECT ${selectCols} FROM t2 JOIN t1 ON t2.${joinCol} = t1.id`;

						const resultAB = await collectResultSet(db, queryAB);
						const resultBA = await collectResultSet(db, queryBA);

						assertSameResultSet(resultAB, resultBA);
					} finally {
						await db.close();
					}
				}
			), { numRuns: 30 });
		});

		it('A JOIN B JOIN C preserves results under reordering', async () => {
			const threeTables = fc.tuple(
				tableSpecArb('t1', { min: 1, max: 3 }),
				tableSpecArb('t2', { min: 1, max: 3 }),
				tableSpecArb('t3', { min: 1, max: 3 })
			);

			await fc.assert(fc.asyncProperty(
				threeTables.chain(([s1, s2, s3]) => {
					return fc.tuple(
						fc.array(rowArb(s1), { minLength: 5, maxLength: 30 }),
						fc.array(rowArb(s2), { minLength: 5, maxLength: 30 }),
						fc.array(rowArb(s3), { minLength: 5, maxLength: 30 })
					).map(([r1, r2, r3]) => ({
						specs: [s1, s2, s3],
						rows: new Map([['t1', r1], ['t2', r2], ['t3', r3]])
					}));
				}),
				async ({ specs, rows }) => {
					const db = new Database();
					try {
						await setupSchema(db, specs, rows);

						const cols2 = specs[1].columns.filter(c => c.name !== 'id');
						const cols3 = specs[2].columns.filter(c => c.name !== 'id');
						const joinCol2 = cols2[0]?.name ?? 'a';
						const joinCol3 = cols3[0]?.name ?? 'a';

						// Build explicit column lists with aliases
						const t1Cols = specs[0].columns.map(c => `t1.${c.name} AS t1_${c.name}`).join(', ');
						const t2Cols = specs[1].columns.map(c => `t2.${c.name} AS t2_${c.name}`).join(', ');
						const t3Cols = specs[2].columns.map(c => `t3.${c.name} AS t3_${c.name}`).join(', ');
						const selectCols = `${t1Cols}, ${t2Cols}, ${t3Cols}`;

						const queryABC = `SELECT ${selectCols} FROM t1 JOIN t2 ON t1.id = t2.${joinCol2} JOIN t3 ON t2.id = t3.${joinCol3}`;
						const queryCBA = `SELECT ${selectCols} FROM t3 JOIN t2 ON t3.${joinCol3} = t2.id JOIN t1 ON t2.${joinCol2} = t1.id`;

						const resultABC = await collectResultSet(db, queryABC);
						const resultCBA = await collectResultSet(db, queryCBA);

						assertSameResultSet(resultABC, resultCBA);
					} finally {
						await db.close();
					}
				}
			), { numRuns: 20 });
		});

		it('multi-column join conditions preserve results', async () => {
			const twoTables = fc.tuple(
				tableSpecArb('t1', { min: 2, max: 4 }),
				tableSpecArb('t2', { min: 2, max: 4 })
			);

			await fc.assert(fc.asyncProperty(
				twoTables.chain(([s1, s2]) => {
					return fc.tuple(
						fc.array(rowArb(s1), { minLength: 5, maxLength: 30 }),
						fc.array(rowArb(s2), { minLength: 5, maxLength: 30 })
					).map(([r1, r2]) => ({ specs: [s1, s2], rows: new Map([['t1', r1], ['t2', r2]]) }));
				}),
				async ({ specs, rows }) => {
					const db = new Database();
					try {
						await setupSchema(db, specs, rows);

						const cols1 = specs[0].columns.filter(c => c.name !== 'id');
						const cols2 = specs[1].columns.filter(c => c.name !== 'id');
						if (cols1.length < 2 || cols2.length < 2) return; // need at least 2 non-id cols

						const c1a = cols1[0].name;
						const c1b = cols1[1].name;
						const c2a = cols2[0].name;
						const c2b = cols2[1].name;

						const t1Cols = specs[0].columns.map(c => `t1.${c.name} AS t1_${c.name}`).join(', ');
						const t2Cols = specs[1].columns.map(c => `t2.${c.name} AS t2_${c.name}`).join(', ');
						const selectCols = `${t1Cols}, ${t2Cols}`;

						const queryAB = `SELECT ${selectCols} FROM t1 JOIN t2 ON t1.${c1a} = t2.${c2a} AND t1.${c1b} = t2.${c2b}`;
						const queryBA = `SELECT ${selectCols} FROM t2 JOIN t1 ON t2.${c2a} = t1.${c1a} AND t2.${c2b} = t1.${c1b}`;

						const resultAB = await collectResultSet(db, queryAB);
						const resultBA = await collectResultSet(db, queryBA);

						assertSameResultSet(resultAB, resultBA);
					} finally {
						await db.close();
					}
				}
			), { numRuns: 20 });
		});
	});

	// -----------------------------------------------------------------------
	// Property 4: Monotonicity of WHERE
	// -----------------------------------------------------------------------
	describe('Monotonicity of WHERE', () => {
		const schemaArb = tableSpecArb('t1', { min: 2, max: 4 });

		it('filtered count <= unfiltered count', async () => {
			await fc.assert(fc.asyncProperty(
				schemaArb.chain(spec => {
					return fc.tuple(
						fc.constant(spec),
						fc.array(rowArb(spec), { minLength: 1, maxLength: 20 }),
						fc.constantFrom(...spec.columns.filter(c => c.name !== 'id').map(c => c.name))
					);
				}),
				async ([spec, rows, filterCol]) => {
					const db = new Database();
					try {
						await setupSchema(db, [spec], new Map([['t1', rows]]));

						const totalResult = await collectResultSet(db, `SELECT count(*) AS cnt FROM t1`);
						const total = totalResult[0].cnt as number;

						const filteredResult = await collectResultSet(db, `SELECT count(*) AS cnt FROM t1 WHERE ${filterCol} IS NOT NULL`);
						const filtered = filteredResult[0].cnt as number;

						expect(filtered).to.be.at.most(total);
					} finally {
						await db.close();
					}
				}
			), { numRuns: 50 });
		});
	});

	// -----------------------------------------------------------------------
	// Property 5: NULL algebra
	// -----------------------------------------------------------------------
	describe('NULL algebra', () => {
		let db: Database;

		beforeEach(() => { db = new Database(); });
		afterEach(async () => { await db.close(); });

		it('NULL = NULL is not true', async () => {
			const rows = await collectResultSet(db, `SELECT (null = null) AS result`);
			expect(rows[0].result).to.not.equal(1);
		});

		it('NULL IN (..., NULL, ...) yields NULL', async () => {
			await fc.assert(fc.asyncProperty(
				fc.array(fc.integer({ min: -100, max: 100 }), { minLength: 1, maxLength: 5 }),
				fc.integer({ min: 0, max: 5 }),  // position to insert null
				async (values, nullPos) => {
					const items = [...values.map(v => String(v))];
					const insertAt = Math.min(nullPos, items.length);
					items.splice(insertAt, 0, 'null');
					const rows = await collectResultSet(db, `SELECT (null IN (${items.join(', ')})) AS result`);
					expect(rows[0].result).to.be.null;
				}
			), { numRuns: 30 });
		});

		it('COALESCE(NULL, v) = v for any non-null v', async () => {
			await fc.assert(fc.asyncProperty(
				fc.oneof(
					fc.integer({ min: -1000, max: 1000 }),
					fc.float({ min: -100, max: 100, noNaN: true, noDefaultInfinity: true }),
					fc.constantFrom('alpha', 'beta', 'gamma', 'delta', '')
				),
				async (v) => {
					const results: Record<string, SqlValue>[] = [];
					for await (const row of db.eval(`SELECT coalesce(null, ?) AS result`, [v as SqlValue])) {
						results.push(row as Record<string, SqlValue>);
					}
					expect(results[0].result).to.equal(v);
				}
			), { numRuns: 50 });
		});

		it('IS NULL / IS NOT NULL are complementary', async () => {
			await fc.assert(fc.asyncProperty(
				fc.oneof(
					fc.constant(null as SqlValue),
					fc.integer({ min: -100, max: 100 }) as fc.Arbitrary<SqlValue>,
					fc.float({ min: -100, max: 100, noNaN: true, noDefaultInfinity: true }) as fc.Arbitrary<SqlValue>,
					fc.constantFrom<SqlValue>('alpha', 'beta', '', 'gamma')
				),
				async (v) => {
					await db.exec(`CREATE TABLE IF NOT EXISTS null_test (id INTEGER PRIMARY KEY, v ANY null) USING memory`);
					await db.exec(`DELETE FROM null_test`);
					const stmt = db.prepare(`INSERT INTO null_test (id, v) VALUES (1, ?)`);
					try {
						await stmt.run([v]);
					} finally {
						await stmt.finalize();
					}

					const isNullResult = await collectResultSet(db, `SELECT (v IS NULL) AS r FROM null_test`);
					const isNotNullResult = await collectResultSet(db, `SELECT (v IS NOT NULL) AS r FROM null_test`);

					const isNull = isNullResult[0].r;
					const isNotNull = isNotNullResult[0].r;

					// Exactly one should be true (1)
					expect((isNull as number) + (isNotNull as number)).to.equal(1);
				}
			), { numRuns: 50 });
		});

		it('count(col) with NULLs <= count(*)', async () => {
			await db.exec(`CREATE TABLE null_agg (id INTEGER PRIMARY KEY, v INTEGER null) USING memory`);
			const rows: [number, SqlValue][] = [[1, 10], [2, null], [3, 20], [4, null], [5, 30]];
			for (const [id, v] of rows) {
				const stmt = db.prepare(`INSERT INTO null_agg (id, v) VALUES (?, ?)`);
				try { await stmt.run([id, v]); } finally { await stmt.finalize(); }
			}

			const countStar = await collectResultSet(db, `SELECT count(*) AS cnt FROM null_agg`);
			const countCol = await collectResultSet(db, `SELECT count(v) AS cnt FROM null_agg`);
			expect(countCol[0].cnt as number).to.be.lessThan(countStar[0].cnt as number);
		});
	});

	// -----------------------------------------------------------------------
	// Property 6: Aggregate invariants
	// -----------------------------------------------------------------------
	describe('Aggregate invariants', () => {

		it('count(*) >= count(col)', async () => {
			const schemaArb = tableSpecArb('t1', { min: 1, max: 2 });

			await fc.assert(fc.asyncProperty(
				schemaArb.chain(spec => {
					return fc.array(rowArb(spec), { minLength: 1, maxLength: 20 })
						.map(rows => ({ spec, rows }));
				}),
				async ({ spec, rows }) => {
					const db = new Database();
					try {
						await setupSchema(db, [spec], new Map([['t1', rows]]));

						const col = spec.columns.find(c => c.name !== 'id')?.name ?? 'a';
						const countStar = await collectResultSet(db, `SELECT count(*) AS cnt FROM t1`);
						const countCol = await collectResultSet(db, `SELECT count(${col}) AS cnt FROM t1`);

						expect(countCol[0].cnt as number).to.be.at.most(countStar[0].cnt as number);
					} finally {
						await db.close();
					}
				}
			), { numRuns: 50 });
		});

		it('min(col) <= max(col) when both non-NULL', async () => {
			const schemaArb = tableSpecArb('t1', { min: 1, max: 2 });

			await fc.assert(fc.asyncProperty(
				schemaArb.chain(spec => {
					return fc.array(rowArb(spec), { minLength: 1, maxLength: 20 })
						.map(rows => ({ spec, rows }));
				}),
				async ({ spec, rows }) => {
					const db = new Database();
					try {
						await setupSchema(db, [spec], new Map([['t1', rows]]));

						const col = spec.columns.find(c => c.name !== 'id')?.name ?? 'a';
						const result = await collectResultSet(db, `SELECT min(${col}) AS mn, max(${col}) AS mx FROM t1`);
						const mn = result[0].mn;
						const mx = result[0].mx;

						if (mn !== null && mx !== null) {
							expect(mn <= mx).to.be.true;
						}
					} finally {
						await db.close();
					}
				}
			), { numRuns: 50 });
		});

		it('single-row table: sum(col) equals the value', async () => {
			const db = new Database();
			try {
				await fc.assert(fc.asyncProperty(
					fc.oneof(
						fc.integer({ min: -100, max: 100 }),
						fc.float({ min: -100, max: 100, noNaN: true, noDefaultInfinity: true })
					),
					async (val) => {
						await db.exec(`DROP TABLE IF EXISTS single_t`);
						await db.exec(`CREATE TABLE single_t (id INTEGER PRIMARY KEY, v REAL null) USING memory`);
						const stmt = db.prepare(`INSERT INTO single_t (id, v) VALUES (1, ?)`);
						try {
							await stmt.run([val]);
						} finally {
							await stmt.finalize();
						}

						const result = await collectResultSet(db, `SELECT sum(v) AS s FROM single_t`);
						const sum = result[0].s as number;
						// Allow for floating point imprecision
						expect(Math.abs(sum - val)).to.be.lessThan(0.001);
					}
				), { numRuns: 50 });
			} finally {
				await db.close();
			}
		});

		it('avg(col) between min(col) and max(col) when non-NULL', async () => {
			const schemaArb = tableSpecArb('t1', { min: 1, max: 2 });

			await fc.assert(fc.asyncProperty(
				schemaArb.chain(spec => {
					return fc.array(rowArb(spec), { minLength: 2, maxLength: 20 })
						.map(rows => ({ spec, rows }));
				}),
				async ({ spec, rows }) => {
					const db = new Database();
					try {
						await setupSchema(db, [spec], new Map([['t1', rows]]));

						// Use id column for predictable numeric behavior
						const result = await collectResultSet(db,
							`SELECT avg(id) AS av, min(id) AS mn, max(id) AS mx FROM t1`
						);
						const av = result[0].av as number;
						const mn = result[0].mn as number;
						const mx = result[0].mx as number;

						if (av !== null && mn !== null && mx !== null) {
							expect(av).to.be.at.least(mn);
							expect(av).to.be.at.most(mx);
						}
					} finally {
						await db.close();
					}
				}
			), { numRuns: 50 });
		});
	});

	// -----------------------------------------------------------------------
	// Property 7: Large-scale stress tests
	// -----------------------------------------------------------------------
	describe('Large-scale stress tests', function () {
		this.timeout(120_000);

		function largeDataArb(spec: TableSpec): fc.Arbitrary<SqlValue[][]> {
			return fc.array(rowArb(spec), { minLength: 500, maxLength: 1000 });
		}

		it('join commutativity holds at scale', async () => {
			const twoTables = fc.tuple(
				tableSpecArb('t1', { min: 1, max: 3 }),
				tableSpecArb('t2', { min: 1, max: 3 })
			);

			await fc.assert(fc.asyncProperty(
				twoTables.chain(([s1, s2]) => {
					return fc.tuple(
						largeDataArb(s1),
						largeDataArb(s2)
					).map(([r1, r2]) => ({ specs: [s1, s2], rows: new Map([['t1', r1], ['t2', r2]]) }));
				}),
				async ({ specs, rows }) => {
					const db = new Database();
					try {
						await setupSchema(db, specs, rows);

						const cols2 = specs[1].columns.filter(c => c.name !== 'id');
						const joinCol = cols2[0]?.name ?? 'a';

						const t1Cols = specs[0].columns.map(c => `t1.${c.name} AS t1_${c.name}`).join(', ');
						const t2Cols = specs[1].columns.map(c => `t2.${c.name} AS t2_${c.name}`).join(', ');
						const selectCols = `${t1Cols}, ${t2Cols}`;

						const queryAB = `SELECT ${selectCols} FROM t1 JOIN t2 ON t1.id = t2.${joinCol}`;
						const queryBA = `SELECT ${selectCols} FROM t2 JOIN t1 ON t2.${joinCol} = t1.id`;

						const resultAB = await collectResultSet(db, queryAB);
						const resultBA = await collectResultSet(db, queryBA);

						assertSameResultSet(resultAB, resultBA);
					} finally {
						await db.close();
					}
				}
			), { numRuns: 5 });
		});

		it('aggregate invariants hold at scale', async () => {
			const schemaArb = tableSpecArb('t1', { min: 2, max: 4 });

			await fc.assert(fc.asyncProperty(
				schemaArb.chain(spec => {
					return largeDataArb(spec).map(rows => ({ spec, rows }));
				}),
				async ({ spec, rows }) => {
					const db = new Database();
					try {
						await setupSchema(db, [spec], new Map([['t1', rows]]));

						const countStar = await collectResultSet(db, `SELECT count(*) AS cnt FROM t1`);
						const total = countStar[0].cnt as number;
						expect(total).to.be.at.least(500);

						const col = spec.columns.find(c => c.name !== 'id')?.name ?? 'a';
						const countCol = await collectResultSet(db, `SELECT count(${col}) AS cnt FROM t1`);
						expect(countCol[0].cnt as number).to.be.at.most(total);

						const result = await collectResultSet(db,
							`SELECT avg(id) AS av, min(id) AS mn, max(id) AS mx FROM t1`
						);
						const av = result[0].av as number;
						const mn = result[0].mn as number;
						const mx = result[0].mx as number;
						expect(av).to.be.at.least(mn);
						expect(av).to.be.at.most(mx);
					} finally {
						await db.close();
					}
				}
			), { numRuns: 5 });
		});

		it('semantic equivalence holds at scale', async () => {
			const schemaArb = tableSpecArb('t1', { min: 2, max: 4 });

			await fc.assert(fc.asyncProperty(
				schemaArb.chain(spec => {
					return largeDataArb(spec).map(rows => ({ spec, rows }));
				}),
				async ({ spec, rows }) => {
					const db = new Database();
					try {
						await setupSchema(db, [spec], new Map([['t1', rows]]));

						const cols = spec.columns.filter(c => c.name !== 'id');
						const c1 = cols[0]?.name ?? 'a';
						const query = `SELECT * FROM t1 WHERE ${c1} IS NOT NULL AND id > 0`;

						const resultEnabled = await collectResultSet(db, query);

						let resultDisabled: Record<string, SqlValue>[];
						await withDisabledRule(db, 'predicate-pushdown', async () => {
							resultDisabled = await collectResultSet(db, query);
						});

						assertSameResultSet(resultEnabled, resultDisabled!);
					} finally {
						await db.close();
					}
				}
			), { numRuns: 5 });
		});
	});
});

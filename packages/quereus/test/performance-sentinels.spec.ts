/**
 * Performance sentinel tests.
 *
 * These are NOT micro-benchmarks; they are regression sentinels that assert
 * "this workload completes in well under N ms on CI-class hardware".
 * Thresholds are intentionally generous (10–50× headroom) so they only trip
 * when something regresses catastrophically.
 *
 * Run: yarn test --grep "Performance sentinels"
 */

import { expect } from 'chai';
import { Database } from '../src/index.js';
import { Parser } from '../src/parser/parser.js';
import { MemoryIndex } from '../src/vtab/memory/index.js';
import { createPrimaryKeyFunctions } from '../src/vtab/memory/utils/primary-key.js';
import { testBuiltinCollationResolver } from './util/builtin-collation-resolver.js';
import { createDefaultColumnSchema } from '../src/schema/column.js';
import { INTEGER_TYPE } from '../src/types/builtin-types.js';
import type { TableSchema } from '../src/schema/table.js';
import type * as AST from '../src/parser/ast.js';
import type { PlanNode, RelationalPlanNode } from '../src/planner/nodes/plan-node.js';
import { PlanNodeType } from '../src/planner/nodes/plan-node-type.js';
import type { JoinNode } from '../src/planner/nodes/join-node.js';
import { isCorrelatedSubquery, readsColumnsOf } from '../src/planner/cache/correlation-detector.js';

/** Collect an async iterable into an array. */
async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const item of iter) out.push(item);
	return out;
}

/** Time an async function in milliseconds. */
async function timeMs(fn: () => Promise<void>): Promise<number> {
	const start = performance.now();
	await fn();
	return performance.now() - start;
}

describe('Performance sentinels', function () {
	// Allow generous timeouts for CI
	this.timeout(30_000);

	// ------------------------------------------------------------------ Parser
	describe('Parser', () => {
		it('parses a simple SELECT under 5 ms', () => {
			const sql = 'select id, name, email from users where active = 1 order by name';
			const parser = new Parser();
			const start = performance.now();
			for (let i = 0; i < 100; i++) {
				parser.parseAll(sql);
			}
			const elapsed = performance.now() - start;
			// 100 parses should be well under 500 ms even on slow hardware
			expect(elapsed).to.be.below(500, `100 simple parses took ${elapsed.toFixed(1)} ms`);
		});

		it('parses a wide SELECT (50 columns) under 10 ms', () => {
			const cols = Array.from({ length: 50 }, (_, i) => `col_${i}`).join(', ');
			const sql = `select ${cols} from big_table where col_0 > 10`;
			const parser = new Parser();
			const start = performance.now();
			for (let i = 0; i < 100; i++) {
				parser.parseAll(sql);
			}
			const elapsed = performance.now() - start;
			expect(elapsed).to.be.below(1000, `100 wide-SELECT parses took ${elapsed.toFixed(1)} ms`);
		});

		it('parses a deeply nested expression under 20 ms', () => {
			// Build: ((((1 + 2) + 3) + 4) ... + 30)
			let expr = '1';
			for (let i = 2; i <= 30; i++) expr = `(${expr} + ${i})`;
			const sql = `select ${expr} as result`;
			const parser = new Parser();
			const start = performance.now();
			for (let i = 0; i < 100; i++) {
				parser.parseAll(sql);
			}
			const elapsed = performance.now() - start;
			expect(elapsed).to.be.below(1500, `100 nested-expression parses took ${elapsed.toFixed(1)} ms`);
		});
	});

	// --------------------------------------------------------- Planning time
	describe('Planning time', () => {
		it('plans a 50-column SELECT with non-contradicting WHERE under budget', async () => {
			const db = new Database();
			try {
				// 50 conjuncts × 50 columns. The left-associative AND tree is
				// depth 49; the per-pass depth budget now scales with the input
				// plan's measured depth (see `planInputDepth` in pass.ts) so this
				// plans cleanly without tripping the depth guard.
				// Each column carries a CHECK domain and a non-contradicting WHERE
				// conjunct so the sat-checker walks every one and concludes 'sat'.
				const cols = Array.from({ length: 50 }, (_, i) => `c${i} INTEGER CHECK (c${i} >= 0)`).join(', ');
				await db.exec(`CREATE TABLE wide (id INTEGER PRIMARY KEY, ${cols}) USING memory`);
				const whereClauses = Array.from({ length: 50 }, (_, i) => `c${i} < 1000`).join(' AND ');
				const sql = `SELECT * FROM wide WHERE ${whereClauses}`;

				const elapsed = await timeMs(async () => {
					for (let i = 0; i < 50; i++) {
						const stmt = db.prepare(sql);
						// `db.prepare` only parses; planning is deferred until first
						// step / compile. Force compilation here so the sat-checker
						// actually runs on every iteration.
						stmt.compile();
						await stmt.finalize();
					}
				});
				// O(conjuncts × columns_mentioned) — 50 × 1 column each = trivial.
				// Generous budget for CI headroom.
				expect(elapsed).to.be.below(10000, `50 plans of 50-col WHERE took ${elapsed.toFixed(1)} ms`);
			} finally {
				await db.close();
			}
		});
	});

	// ------------------------------- Correlation walk over a deep join spine
	// Regression sentinel for planner-correlation-walk-doubles-per-join-level. The
	// three walkers in `planner/cache/correlation-detector.ts` descend BOTH
	// `getChildren()` and `getRelations()`, which for a join name the same two
	// inputs. Undeduped, that visits every node twice per level — 2^depth down a
	// join spine — and the join physical-selection rules call `readsColumnsOf` per
	// join per optimizer pass, so the whole plan build inherits it.
	//
	// The spine is built LOGICALLY (`_buildPlan`, no optimizer) precisely so this
	// test measures the walkers alone: nothing in the logical builder calls them,
	// only optimizer rules and `runtime/emit/subquery` do.
	//
	// Measured on this machine by disabling the dedup: depth 24 took 267_725 ms
	// undeduped versus 47 ms deduped. Depth is 20 rather than 24 only so a
	// regression goes red in ~17 s instead of ~4.5 min — that still leaves the
	// deduped walk ~25× under the 1 s budget and the undeduped one ~17× over it.
	describe('Correlation detection over a deep join spine', function () {
		this.timeout(60_000);

		it('walks a 20-deep join spine in linear, not exponential, time', async () => {
			const SPINE_DEPTH = 20;
			const db = new Database();
			try {
				await db.exec('create table spine_t (id integer primary key, v integer) using memory');

				// `spine_t a0 join spine_t a1 on a1.id = a0.id join ...` — a left-deep
				// spine of SPINE_DEPTH JoinNodes, each correlating to its own left input.
				const joins = Array.from({ length: SPINE_DEPTH }, (_, i) =>
					`join spine_t a${i + 1} on a${i + 1}.id = a${i}.id`).join(' ');
				const sql = `select a0.v from spine_t a0 ${joins}`;

				const ast = new Parser().parse(sql) as AST.Statement;
				const { plan } = db._buildPlan([ast]);

				// Topmost JoinNode in a pre-order walk = the spine root.
				const joinNodes: JoinNode[] = [];
				plan.visit((node: PlanNode) => {
					if (node.nodeType === PlanNodeType.Join) joinNodes.push(node as JoinNode);
				});
				expect(joinNodes.length, 'the logical plan is a full join spine').to.equal(SPINE_DEPTH);
				const root = joinNodes[0];

				const start = performance.now();
				// Both shapes the join rules ask on every pass.
				isCorrelatedSubquery(root as RelationalPlanNode);
				readsColumnsOf(root.right, root.left);
				readsColumnsOf(root.left, root.right);
				const elapsed = performance.now() - start;

				expect(elapsed).to.be.below(1000,
					`correlation walks over a ${SPINE_DEPTH}-deep join spine took ${elapsed.toFixed(1)} ms`);
			} finally {
				await db.close();
			}
		});
	});

	// --------------------------------------------------------- End-to-end query
	describe('End-to-end query execution', () => {
		let db: Database;

		beforeEach(async () => {
			db = new Database();
			// Create a table with 1000 rows
			await db.exec('create table perf_t (id integer primary key, val integer, label text)');
			const batches: string[] = [];
			for (let i = 0; i < 10; i++) {
				const values = Array.from({ length: 100 }, (_, j) => {
					const id = i * 100 + j + 1;
					return `(${id}, ${id * 7 % 100}, 'label_${id % 20}')`;
				}).join(', ');
				batches.push(`insert into perf_t values ${values}`);
			}
			for (const batch of batches) {
				await batch; // force sequential
				await db.exec(batch);
			}
		});

		afterEach(async () => {
			await db.close();
		});

		it('full table scan (1000 rows) under 200 ms', async () => {
			const elapsed = await timeMs(async () => {
				const rows = await collect(db.eval('select * from perf_t'));
				expect(rows).to.have.length(1000);
			});
			expect(elapsed).to.be.below(200, `scan took ${elapsed.toFixed(1)} ms`);
		});

		it('filtered scan (1000 rows, ~10 matches) under 200 ms', async () => {
			const elapsed = await timeMs(async () => {
				const rows = await collect(db.eval('select * from perf_t where val = 42'));
				expect(rows.length).to.be.greaterThan(0);
			});
			expect(elapsed).to.be.below(200, `filtered scan took ${elapsed.toFixed(1)} ms`);
		});

		it('aggregate GROUP BY under 200 ms', async () => {
			const elapsed = await timeMs(async () => {
				const rows = await collect(
					db.eval('select label, count(*) as cnt, sum(val) as total from perf_t group by label')
				);
				expect(rows.length).to.be.greaterThan(0);
			});
			expect(elapsed).to.be.below(200, `group by took ${elapsed.toFixed(1)} ms`);
		});

		it('ORDER BY under 200 ms', async () => {
			const elapsed = await timeMs(async () => {
				const rows = await collect(
					db.eval('select * from perf_t order by val desc, id asc')
				);
				expect(rows).to.have.length(1000);
			});
			expect(elapsed).to.be.below(200, `order by took ${elapsed.toFixed(1)} ms`);
		});

		it('self-join under 500 ms (bloom/hash join)', async () => {
			// Bloom join: build hash map on right side, probe with left.
			// Typical: ~30-60 ms. Threshold generous for CI headroom.
			const elapsed = await timeMs(async () => {
				const rows = await collect(
					db.eval(`
						select a.id, b.id as b_id
						from perf_t a join perf_t b on a.val = b.val
						where a.id <= 50
					`)
				);
				expect(rows.length).to.be.greaterThan(0);
			});
			expect(elapsed).to.be.below(500, `self-join took ${elapsed.toFixed(1)} ms`);
		});

		it('correlated subquery under 500 ms', async () => {
			const elapsed = await timeMs(async () => {
				const rows = await collect(
					db.eval(`
						select id, val,
							(select count(*) from perf_t b where b.val = a.val) as peer_count
						from perf_t a
						where a.id <= 50
					`)
				);
				expect(rows).to.have.length(50);
			});
			expect(elapsed).to.be.below(500, `correlated subquery took ${elapsed.toFixed(1)} ms`);
		});
	});

	// --------------------------------------------------------- Bulk mutations
	describe('Bulk mutations', () => {
		let db: Database;

		beforeEach(() => {
			db = new Database();
		});

		afterEach(async () => {
			await db.close();
		});

		it('bulk insert 1000 rows under 500 ms', async () => {
			await db.exec('create table bulk_t (id integer primary key, val integer)');

			const elapsed = await timeMs(async () => {
				for (let i = 0; i < 10; i++) {
					const values = Array.from({ length: 100 }, (_, j) => {
						const id = i * 100 + j + 1;
						return `(${id}, ${id * 3})`;
					}).join(', ');
					await db.exec(`insert into bulk_t values ${values}`);
				}
			});
			expect(elapsed).to.be.below(500, `bulk insert took ${elapsed.toFixed(1)} ms`);

			// Verify
			const rows = await collect(db.eval('select count(*) as cnt from bulk_t'));
			expect(rows[0].cnt).to.equal(1000);
		});

		it('index lookup after bulk insert under 100 ms', async () => {
			await db.exec(`
				create table idx_t (id integer primary key, category integer, name text);
				create index idx_t_category on idx_t (category);
			`);

			// Insert 500 rows
			const values = Array.from({ length: 500 }, (_, i) =>
				`(${i + 1}, ${i % 10}, 'name_${i}')`
			).join(', ');
			await db.exec(`insert into idx_t values ${values}`);

			const elapsed = await timeMs(async () => {
				// 50 point lookups by primary key
				for (let i = 1; i <= 50; i++) {
					const row = await db.get(`select * from idx_t where id = ?`, [i]);
					expect(row).to.exist;
				}
			});
			expect(elapsed).to.be.below(500, `50 PK lookups took ${elapsed.toFixed(1)} ms`);
		});
	});

	// ------------------------------------ Aggregate accumulator (O(n) not O(n²))
	describe('Aggregate accumulator spread', () => {
		let db: Database;

		beforeEach(async () => {
			db = new Database();
			await db.exec('create table agg_t (id integer primary key, grp integer, val text)');
			const values = Array.from({ length: 1000 }, (_, i) =>
				`(${i + 1}, ${i % 5}, 'v${i}')`
			).join(', ');
			await db.exec(`insert into agg_t values ${values}`);
		});

		afterEach(async () => {
			await db.close();
		});

		it('group_concat over 1000 rows under 500 ms', async () => {
			const elapsed = await timeMs(async () => {
				const rows = await collect(
					db.eval("select group_concat(val, ',') from agg_t")
				);
				expect(rows).to.have.length(1);
			});
			expect(elapsed).to.be.below(500, `group_concat took ${elapsed.toFixed(1)} ms`);
		});

		it('json_group_array over 1000 rows under 500 ms', async () => {
			const elapsed = await timeMs(async () => {
				const rows = await collect(
					db.eval('select json_group_array(val) from agg_t')
				);
				expect(rows).to.have.length(1);
			});
			expect(elapsed).to.be.below(500, `json_group_array took ${elapsed.toFixed(1)} ms`);
		});

		it('json_group_object over 1000 rows under 500 ms', async () => {
			const elapsed = await timeMs(async () => {
				const rows = await collect(
					db.eval("select json_group_object(val, id) from agg_t")
				);
				expect(rows).to.have.length(1);
			});
			expect(elapsed).to.be.below(500, `json_group_object took ${elapsed.toFixed(1)} ms`);
		});
	});

	// ------------------------------------------------- Repeated prepare/execute
	describe('Statement reuse', () => {
		let db: Database;

		beforeEach(async () => {
			db = new Database();
			await db.exec('create table reuse_t (id integer primary key, v integer)');
			const values = Array.from({ length: 100 }, (_, i) => `(${i + 1}, ${i * 2})`).join(', ');
			await db.exec(`insert into reuse_t values ${values}`);
		});

		afterEach(async () => {
			await db.close();
		});

		it('50 prepare+execute cycles under 500 ms', async () => {
			const elapsed = await timeMs(async () => {
				for (let i = 1; i <= 50; i++) {
					const rows = await collect(db.eval('select * from reuse_t where id = ?', [i]));
					expect(rows).to.have.length(1);
				}
			});
			expect(elapsed).to.be.below(500, `50 prepare+execute cycles took ${elapsed.toFixed(1)} ms`);
		});
	});

	// ----------------------------- Secondary index per-entry PK container (O(1) owned add)
	// Container-level descending-add: every PK lands in ONE low-cardinality bucket in
	// reverse order. The old sorted-array container splices at the front each time
	// (O(M²) to build, ~4.4 s at 250k); the Map's set is O(1) so the build is O(N).
	describe('Secondary index per-entry PK container', function () {
		this.timeout(120_000);

		it('builds a single-key bucket of 250k out-of-order PKs under 2 s', () => {
			const columns = [
				{ ...createDefaultColumnSchema('status'), logicalType: INTEGER_TYPE },
				{ ...createDefaultColumnSchema('id'), logicalType: INTEGER_TYPE },
			];
			const schema: TableSchema = {
				name: 'orders',
				schemaName: 'main',
				columns,
				columnIndexMap: new Map(columns.map((c, i) => [c.name.toLowerCase(), i])),
				primaryKeyDefinition: [{ index: 1 }],
				checkConstraints: [],
				vtabModuleName: 'memory',
				isView: false,
			};
			const pk = createPrimaryKeyFunctions(schema, testBuiltinCollationResolver);
			const index = new MemoryIndex(
				{ name: 'ix_status', columns: [{ index: 0 }] },
				columns,
				testBuiltinCollationResolver,
				pk.compare,
				pk.encode,
				schema.name,
			);

			const N = 250_000;
			const start = performance.now();
			for (let i = N; i >= 1; i--) index.addEntry(0, i); // descending => array-front splice worst case
			const elapsed = performance.now() - start;

			expect(index.getPrimaryKeys(0)).to.have.length(N);
			expect(elapsed).to.be.below(2000, `250k out-of-order PK adds took ${elapsed.toFixed(1)} ms`);
		});
	});

	// ------------------------------------ Materialized-view maintenance batching
	// Regression sentinel for the per-statement residual key batch
	// (mv-maintenance-statement-batching): before it, aggregate-view maintenance ran a
	// fresh key-filtered residual per SOURCE ROW per MV, making this workload ~25× a
	// plain bulk insert (~2 s here); with statement batching it sits ~3×. The RATIO
	// bound (not absolute time) keeps the sentinel stable across CI hardware; 12× gives
	// ~4× headroom over the batched cost while still tripping well below the per-row
	// regression class.
	describe('Materialized-view bulk-insert maintenance (statement batching)', function () {
		this.timeout(120_000);

		it('bulk insert with two aggregate MVs stays within 12× a plain bulk insert', async () => {
			const N = 1000, ACCOUNTS = 40, PERIODS = 24, BATCH = 100;
			const mkRows = (offset: number) => Array.from({ length: BATCH }, (_, j) => {
				const i = offset + j;
				return `(${i}, ${i % ACCOUNTS}, ${i % PERIODS}, ${(i * 7) % 100})`;
			}).join(', ');

			async function run(withMvs: boolean): Promise<number> {
				const db = new Database();
				await db.exec('create table entries (id integer primary key, account integer, period integer, amount integer)');
				if (withMvs) {
					await db.exec('create materialized view acct_totals as select account, count(*) as n, sum(amount) as total from entries group by account');
					await db.exec('create materialized view bucket_totals as select account, period, sum(amount) as total from entries group by account, period');
				}
				const elapsed = await timeMs(async () => {
					await db.exec('begin');
					for (let i = 0; i < N; i += BATCH) {
						await db.exec(`insert into entries (id, account, period, amount) values ${mkRows(i)}`);
					}
					await db.exec('commit');
				});
				// Sanity: the maintained aggregates actually reflect the load.
				if (withMvs) {
					for await (const row of db.eval('select sum(n) as loaded from acct_totals')) {
						expect(Number((row as { loaded: unknown }).loaded)).to.equal(N);
					}
				}
				await db.close();
				return elapsed;
			}

			const plain = await run(false);
			const withMvs = await run(true);
			expect(withMvs).to.be.below(Math.max(plain, 10) * 12,
				`bulk insert with 2 aggregate MVs took ${withMvs.toFixed(1)} ms vs ${plain.toFixed(1)} ms plain (ratio ${(withMvs / plain).toFixed(1)}×)`);
		});
	});

	// -------------------------------- Batched parent-side RESTRICT enforcement
	describe('Batched FK RESTRICT bulk parent delete', function () {
		this.timeout(60_000);

		it('deletes 1000 referenced-but-unmatched parents with 4000 UNINDEXED children well under budget', async () => {
			// Pre-batching this was O(N_parents × K_children): one full child scan
			// per deleted parent per probe (~6 s on this shape). The batched path
			// runs ⌈1000/500⌉ = 2 chunked probes total, so the whole delete is a
			// couple of child scans — bound is generous CI headroom over ~100 ms.
			const db = new Database();
			try {
				await db.exec(`
					pragma foreign_keys = true;
					create table parent (id integer primary key, name text);
					create table child (id integer primary key, parent_id integer null,
						foreign key (parent_id) references parent(id) on delete restrict);
				`);
				const BATCH = 250;
				for (let i = 0; i < 1000; i += BATCH) {
					const values = Array.from({ length: BATCH }, (_, j) => `(${i + j + 1}, 'p${i + j + 1}')`).join(', ');
					await db.exec(`insert into parent values ${values}`);
				}
				// 4000 children, all referencing NULL (match nothing) — the RESTRICT
				// probe must still consult the (unindexed) child FK column.
				for (let i = 0; i < 4000; i += BATCH) {
					const values = Array.from({ length: BATCH }, (_, j) => `(${i + j + 1}, null)`).join(', ');
					await db.exec(`insert into child values ${values}`);
				}

				const elapsed = await timeMs(async () => {
					await db.exec('delete from parent');
				});
				const rows = await collect(db.eval('select count(*) as cnt from parent'));
				expect(rows[0].cnt).to.equal(0);
				expect(elapsed).to.be.below(2500,
					`bulk parent delete with unindexed RESTRICT child took ${elapsed.toFixed(1)} ms (pre-batching ~6000 ms)`);
			} finally {
				await db.close();
			}
		});
	});

	// ------------------------------- FK cascade bulk parent delete (stmt cache)
	describe('FK cascade bulk parent delete', function () {
		this.timeout(60_000);

		it('cascade-deletes 500 parents each with a child, reusing cached statements', async () => {
			// Every deleted parent row fires two per-row internal statements — the
			// transitive pre-walk `select * from child where parent_id = ?` and the
			// cascade `delete from child where parent_id = ?`. Without the internal
			// statement cache each is a fresh parse + plan + emit per parent row
			// (~1000 compiles for 500 parents); the cache compiles each shape once
			// and rebinds. The hit-ratio assertion is the real sentinel here (a cache
			// bypass makes misses scale with row count); the timing bound is generous
			// CI headroom that only trips on a catastrophic regression.
			const db = new Database();
			try {
				await db.exec(`
					pragma foreign_keys = true;
					create table cparent (id integer primary key, name text);
					create table cchild (id integer primary key, parent_id integer,
						foreign key (parent_id) references cparent(id) on delete cascade);
				`);
				const N = 500;
				const BATCH = 250;
				for (let i = 0; i < N; i += BATCH) {
					const parents = Array.from({ length: BATCH }, (_, j) => `(${i + j + 1}, 'p${i + j + 1}')`).join(', ');
					await db.exec(`insert into cparent values ${parents}`);
					// One child per parent, referencing it — each parent delete cascades.
					const children = Array.from({ length: BATCH }, (_, j) => `(${i + j + 1}, ${i + j + 1})`).join(', ');
					await db.exec(`insert into cchild values ${children}`);
				}

				const before = db._internalStatementCache.stats;
				const elapsed = await timeMs(async () => {
					await db.exec('delete from cparent');
				});
				const after = db._internalStatementCache.stats;

				const parentRows = await collect(db.eval('select count(*) as cnt from cparent'));
				const childRows = await collect(db.eval('select count(*) as cnt from cchild'));
				expect(parentRows[0].cnt).to.equal(0);
				expect(childRows[0].cnt, 'every child cascaded away').to.equal(0);

				// Each per-row shape compiled ONCE and was then reused across all rows:
				// the miss delta is a small constant (a couple of shapes), not O(N).
				const missDelta = after.misses - before.misses;
				const hitDelta = after.hits - before.hits;
				expect(missDelta, `only a couple of shapes compiled (saw ${missDelta} misses)`).to.be.below(10);
				expect(hitDelta, 'the vast majority of per-row executions were cache hits').to.be.greaterThan(N);
				expect(elapsed).to.be.below(5000,
					`cascade delete of ${N} parent+child pairs took ${elapsed.toFixed(1)} ms`);
			} finally {
				await db.close();
			}
		});
	});

	// ----------------------------- Uncorrelated IN-subquery set probe (O(K + N·log K))
	// Regression sentinel for quereus-in-subquery-set-probe. A DELETE/SELECT filtered
	// by `col IN (SELECT ...)` must materialize the subquery once into a lookup set and
	// probe it per outer row, NOT re-drive the subquery per candidate row. The old path
	// degraded to O(N×K) once the inner result crossed the cache threshold (reporter saw
	// 22 s at outer=4000 / inner=2000). Here outer≈10000 / inner≈5000 (2500 in-set):
	// quadratic would take many seconds; the set probe is well under the generous bound.
	describe('IN-subquery set probe', function () {
		this.timeout(30_000);

		let db: Database;

		beforeEach(async () => {
			db = new Database();
			await db.exec('create table in_inner (id integer primary key, entity text)');
			await db.exec('create table in_outer (id integer primary key, txn_id integer)');
			const BATCH = 500;
			// 5000 inner rows; half carry entity 'e1' (the in-set half → 2500 keys).
			for (let i = 0; i < 5000; i += BATCH) {
				const rows = Array.from({ length: BATCH }, (_, j) => {
					const id = i + j + 1;
					return `(${id}, '${id % 2 === 0 ? 'e1' : 'e2'}')`;
				}).join(', ');
				await db.exec(`insert into in_inner values ${rows}`);
			}
			// 10000 outer rows referencing inner ids (cycled), so ~half match the set.
			for (let i = 0; i < 10000; i += BATCH) {
				const rows = Array.from({ length: BATCH }, (_, j) => {
					const id = i + j + 1;
					return `(${id}, ${(id % 5000) + 1})`;
				}).join(', ');
				await db.exec(`insert into in_outer values ${rows}`);
			}
		});

		afterEach(async () => {
			await db.close();
		});

		it('SELECT ... WHERE col IN (subquery) over 10k×5k under 3 s', async () => {
			const elapsed = await timeMs(async () => {
				const rows = await collect(db.eval(
					"select count(*) as c from in_outer where txn_id in (select id from in_inner where entity = 'e1')"
				));
				expect(rows).to.have.length(1);
			});
			expect(elapsed).to.be.below(3000, `IN-subquery select took ${elapsed.toFixed(1)} ms`);
		});

		it('DELETE ... WHERE col IN (subquery) over 10k×5k under 3 s', async () => {
			const elapsed = await timeMs(async () => {
				await db.exec("delete from in_outer where txn_id in (select id from in_inner where entity = 'e1')");
			});
			expect(elapsed).to.be.below(3000, `IN-subquery delete took ${elapsed.toFixed(1)} ms`);
		});
	});
});


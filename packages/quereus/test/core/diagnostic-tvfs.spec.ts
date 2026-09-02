import { expect } from 'chai';
import { Database } from '../../src/index.js';
import { CollectingInstructionTracer, type InstructionTraceEvent } from '../../src/runtime/types.js';

/**
 * All five SQL-taking diagnostic table-valued functions (query_plan,
 * scheduler_program, stack_trace, execution_trace, row_trace) run a nested
 * SQL string. A TVF body executes inside the calling statement, under the
 * same exec mutex the outer statement holds — a body that reaches for
 * `db.eval`/`db.exec` instead of the mutex-free `db.getPlan`/`db.prepare`
 * path deadlocks silently rather than throwing (see
 * `createIntegratedTableValuedFunction`'s NOTE in func/registration.ts).
 * This suite exercises each end-to-end through `db.eval`, with a per-case
 * timeout short enough that a regression fails loudly instead of hanging.
 */
describe('diagnostic table-valued functions', function () {
	const DIAGNOSTIC_TVFS = ['query_plan', 'scheduler_program', 'stack_trace', 'execution_trace', 'row_trace'];

	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table t (id integer primary key, n integer)');
		await db.exec('insert into t values (1, 5), (2, 10)');
	});

	afterEach(async () => {
		await db.close();
	});

	/**
	 * Every one of these TVFs answers a failure by yielding a row rather than
	 * throwing, so "returned rows" alone would pass on a fully broken function.
	 * These markers are the ones each error/degraded path emits.
	 */
	const FAILURE_MARKERS = ['Failed to', 'NO_TRACE_DATA', 'NO_ROW_DATA'];

	for (const tvf of DIAGNOSTIC_TVFS) {
		it(`${tvf}() completes and returns real rows`, async function () {
			this.timeout(5_000);
			const rows: Array<Record<string, unknown>> = [];
			for await (const row of db.eval(`select * from ${tvf}('select n + 1 from t where n > 2')`)) {
				rows.push(row);
			}
			expect(rows.length, `${tvf}() row count`).to.be.greaterThan(0);

			const failures = rows.filter(row =>
				Object.values(row).some(value =>
					typeof value === 'string' && FAILURE_MARKERS.some(marker => value.includes(marker))));
			expect(failures, `${tvf}() failure rows: ${JSON.stringify(failures)}`).to.have.lengthOf(0);
		});

		it(`${tvf}() reports unplannable SQL instead of throwing or hanging`, async function () {
			this.timeout(5_000);
			const rows: Array<Record<string, unknown>> = [];
			for await (const row of db.eval(`select * from ${tvf}('select missing_column from no_such_table')`)) {
				rows.push(row);
			}
			// These are diagnostics: a query that cannot be planned is reported as a
			// row describing the failure, not as an exception out of the TVF.
			expect(rows.length, `${tvf}() error row count`).to.be.greaterThan(0);
		});
	}
});

/**
 * Instructions live in a *tree* of schedulers — the main program plus one nested
 * scheduler per callback sub-program — and each scheduler used to number its own
 * instructions from zero. `execution_trace()` joins its trace events against the
 * `scheduler_program()` listing, so two instructions sharing a number meant a row
 * whose name came from one instruction and whose timings came from another.
 *
 * These checks are deliberately generic rather than assertions about one query:
 * the defect is a class, and the same invariants should keep holding as emitters
 * change. For each query shape, the compiled listing and a raw instruction trace
 * of the same statement must agree on one address space.
 */
describe('instruction addressing (scheduler_program / execution_trace join)', function () {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table t (id integer primary key, n integer)');
		await db.exec('insert into t values (1, 5), (2, 10)');
		await db.exec('create table u (id integer primary key, m integer)');
		await db.exec('insert into u values (1, 7), (2, 3)');
	});

	afterEach(async () => {
		await db.close();
	});

	const QUERY_SHAPES: Array<{ label: string; sql: string }> = [
		{ label: 'scalar arithmetic + comparison (two sibling sub-programs)', sql: 'select n + 1 from t where n > 2' },
		{ label: 'aggregate', sql: 'select count(*), sum(n) from t' },
		{ label: 'join', sql: 'select t.n, u.m from t join u on t.id = u.id' },
		{ label: 'correlated scalar subquery (program nested inside a program)', sql: 'select n from t where n > (select max(m) from u where u.id = t.id)' },
	];

	interface ListingRow { addr: number; description: string; dependencies: number[]; isSubprogram: boolean }

	async function readListing(sql: string): Promise<ListingRow[]> {
		const rows: ListingRow[] = [];
		for await (const row of db.eval(`select * from scheduler_program(?)`, [sql])) {
			rows.push({
				addr: row.addr as number,
				description: row.description as string,
				dependencies: JSON.parse((row.dependencies as string) ?? '[]') as number[],
				isSubprogram: (row.is_subprogram as number) === 1,
			});
		}
		return rows;
	}

	async function collectTrace(sql: string): Promise<InstructionTraceEvent[]> {
		const tracer = new CollectingInstructionTracer();
		const stmt = db.prepare(sql);
		try {
			// Trace the UNFUSED graph, exactly as execution_trace() does — fusion would
			// dissolve the very sub-programs these checks are about.
			stmt._emitUnfused = true;
			for await (const _row of stmt.iterateRowsWithTrace(undefined, tracer)) {
				// Results are irrelevant here; the trace events are the subject.
			}
		} finally {
			await stmt.finalize();
		}
		return tracer.getTraceEvents();
	}

	for (const shape of QUERY_SHAPES) {
		it(`assigns one address per instruction: ${shape.label}`, async function () {
			this.timeout(10_000);

			const listing = await readListing(shape.sql);
			expect(listing.length, `${shape.sql}: listing rows`).to.be.greaterThan(0);

			// Every listed address is unique.
			const byAddr = new Map<number, ListingRow>();
			for (const row of listing) {
				expect(byAddr.has(row.addr), `${shape.sql}: duplicate addr ${row.addr} (${row.description} vs ${byAddr.get(row.addr)?.description})`).to.equal(false);
				byAddr.set(row.addr, row);
			}

			// Every dependency address names a listed instruction.
			for (const row of listing) {
				for (const dep of row.dependencies) {
					expect(byAddr.has(dep), `${shape.sql}: addr ${row.addr} (${row.description}) depends on unlisted addr ${dep}`).to.equal(true);
				}
			}

			const events = await collectTrace(shape.sql);
			expect(events.length, `${shape.sql}: trace events`).to.be.greaterThan(0);

			// Each traced address describes exactly one instruction, and it is the one
			// the listing names at that address.
			const notesByAddress = new Map<number, Set<string>>();
			for (const event of events) {
				if (event.note === undefined) continue;
				let notes = notesByAddress.get(event.instructionIndex);
				if (!notes) {
					notes = new Set<string>();
					notesByAddress.set(event.instructionIndex, notes);
				}
				notes.add(event.note);
			}
			for (const [address, notes] of notesByAddress) {
				expect([...notes], `${shape.sql}: address ${address} traced under multiple instructions`).to.have.lengthOf(1);
				const listed = byAddr.get(address);
				expect(listed, `${shape.sql}: traced address ${address} (${[...notes][0]}) is absent from the listing`).to.not.equal(undefined);
				expect(listed!.description, `${shape.sql}: address ${address} named differently by listing and trace`).to.equal([...notes][0]);
			}

			// Nested instructions are reachable at all: at least one sub-program
			// instruction shows up in the trace under its listed address.
			const subProgramAddrs = new Set(listing.filter(row => row.isSubprogram).map(row => row.addr));
			expect(subProgramAddrs.size, `${shape.sql}: listing has no sub-program instructions to check`).to.be.greaterThan(0);
			const tracedSubProgram = [...notesByAddress.keys()].filter(addr => subProgramAddrs.has(addr));
			expect(tracedSubProgram.length, `${shape.sql}: no sub-program instruction appears in the trace`).to.be.greaterThan(0);
		});
	}

	/**
	 * The checks above read the tracer directly. These go through the two TVFs a
	 * user actually calls, so the addresses they *publish* — not just the ones the
	 * scheduler computes — have to resolve against the same listing.
	 */
	for (const shape of QUERY_SHAPES) {
		it(`publishes resolvable addresses through the TVFs: ${shape.label}`, async function () {
			this.timeout(10_000);

			const listed = new Set((await readListing(shape.sql)).map(row => row.addr));
			let tracedRows = 0;
			let subProgramInstructions = 0;

			for await (const row of db.eval(`select * from execution_trace(?)`, [shape.sql])) {
				tracedRows++;
				const addr = row.instruction_index as number;
				expect(row.operation, `${shape.sql}: execution_trace() captured no events`).to.not.equal('NO_TRACE_DATA');
				expect(listed.has(addr), `${shape.sql}: execution_trace() addr ${addr} (${row.operation}) is absent from the listing`).to.equal(true);

				// Every dependency, and every sub-program address the row advertises,
				// must name a listed row too — that blob is the path into the nested
				// program, so a dangling address there is the original defect.
				for (const dep of JSON.parse((row.dependencies as string) ?? '[]') as number[]) {
					expect(listed.has(dep), `${shape.sql}: addr ${addr} depends on unlisted addr ${dep}`).to.equal(true);
				}
				const subPrograms = JSON.parse((row.sub_programs as string) ?? 'null') as
					Array<{ programIndex: number; instructions?: Array<{ address: number; dependencies: number[] }> }> | null;
				for (const sub of subPrograms ?? []) {
					expect(listed.has(sub.programIndex), `${shape.sql}: sub-program base ${sub.programIndex} is absent from the listing`).to.equal(true);
					for (const instr of sub.instructions ?? []) {
						subProgramInstructions++;
						expect(listed.has(instr.address), `${shape.sql}: sub-program instruction ${instr.address} is absent from the listing`).to.equal(true);
						for (const dep of instr.dependencies) {
							expect(listed.has(dep), `${shape.sql}: sub-program instruction ${instr.address} depends on unlisted addr ${dep}`).to.equal(true);
						}
					}
				}
			}

			expect(tracedRows, `${shape.sql}: execution_trace() produced no rows`).to.be.greaterThan(0);
			expect(subProgramInstructions, `${shape.sql}: execution_trace() advertised no sub-program instructions`).to.be.greaterThan(0);

			// row_trace() reports the same addresses (it traces the unfused graph too).
			let sawRow = false;
			for await (const row of db.eval(`select * from row_trace(?)`, [shape.sql])) {
				expect(row.operation, `${shape.sql}: row_trace() failed or captured nothing`).to.not.be.oneOf(['NO_ROW_DATA', 'ROW_TRACE_SETUP']);
				sawRow = true;
				const addr = row.instruction_index as number;
				expect(listed.has(addr), `${shape.sql}: row_trace() addr ${addr} (${row.operation}) is absent from the listing`).to.equal(true);
			}
			expect(sawRow, `${shape.sql}: row_trace() produced no row events`).to.equal(true);
		});
	}
});

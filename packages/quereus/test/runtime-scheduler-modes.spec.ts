import { expect } from 'chai';
import { Database } from '../src/index.js';
import { CollectingInstructionTracer } from '../src/runtime/types.js';

async function collectRows<T>(rows: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const row of rows) out.push(row);
	return out;
}

describe('Runtime scheduler modes', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	it('is behaviorally equivalent across optimized/tracing/metrics modes', async () => {
		await db.exec('create table t (id integer primary key, v integer);');
		await db.exec('insert into t values (1, 10), (2, 20), (3, 30), (4, 40), (5, 50);');

		let tickCalls = 0;
		db.createScalarFunction(
			'tick',
			{ numArgs: 0, deterministic: false },
			() => {
				tickCalls++;
				return 1;
			}
		);

		const sql = 'select sum(tick()) as s from t';

		const runOptimized = async () => {
			tickCalls = 0;
			db.setOption('runtime_metrics', false);
			db.setInstructionTracer(undefined);

			const stmt = db.prepare(sql);
			const rows = await collectRows(stmt.iterateRows());
			await stmt.finalize();
			return { rows, tickCalls };
		};

		const runTracing = async () => {
			tickCalls = 0;
			db.setOption('runtime_metrics', false);
			db.setInstructionTracer(undefined);

			const tracer = new CollectingInstructionTracer();
			const stmt = db.prepare(sql);
			const rows = await collectRows(stmt.iterateRowsWithTrace(undefined, tracer));
			await stmt.finalize();

			const events = tracer.getTraceEvents();
			void expect(events.length).to.be.greaterThan(0);
			return { rows, tickCalls, events };
		};

		const runMetrics = async () => {
			tickCalls = 0;
			db.setInstructionTracer(undefined);
			db.setOption('runtime_metrics', true);

			try {
				const stmt = db.prepare(sql);
				const rows = await collectRows(stmt.iterateRows());
				await stmt.finalize();
				return { rows, tickCalls };
			} finally {
				db.setOption('runtime_metrics', false);
			}
		};

		const optimized = await runOptimized();
		const tracing = await runTracing();
		const metrics = await runMetrics();

		void expect(optimized.rows).to.deep.equal([[5]]);
		void expect(tracing.rows).to.deep.equal(optimized.rows);
		void expect(metrics.rows).to.deep.equal(optimized.rows);

		void expect(optimized.tickCalls).to.equal(5);
		void expect(tracing.tickCalls).to.equal(5);
		void expect(metrics.tickCalls).to.equal(5);

		// Guard the two-loop collapse's tracing contract: after the six dispatch
		// loops became one sync + one async loop, tracing still emits exactly one
		// `output` per `input` (an instruction's input is paired with its output),
		// with no stray `error` events on the happy path. The implementer verified
		// this by hand with a scratch spec; assert it durably so a future change to
		// the shared async loop can't silently break trace pairing.
		const inputs = tracing.events.filter(e => e.type === 'input');
		const outputs = tracing.events.filter(e => e.type === 'output');
		const errors = tracing.events.filter(e => e.type === 'error');
		void expect(errors.length).to.equal(0, 'no error events on the happy path');
		void expect(inputs.length).to.be.greaterThan(0);
		void expect(outputs.length).to.equal(inputs.length, 'every traced input must have exactly one matching output');
		const inputIndexes = inputs.map(e => e.instructionIndex).sort((a, b) => a - b);
		const outputIndexes = outputs.map(e => e.instructionIndex).sort((a, b) => a - b);
		void expect(outputIndexes).to.deep.equal(inputIndexes, 'input and output events must cover the same instruction indexes');
	});
});


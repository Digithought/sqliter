import { expect } from 'chai';
import { Scheduler } from '../src/runtime/scheduler.js';
import { asRun, CollectingInstructionTracer } from '../src/runtime/types.js';
import type { Instruction, RuntimeContext } from '../src/runtime/types.js';
import { RowContextMap } from '../src/runtime/context-helpers.js';
import type { RuntimeValue } from '../src/common/types.js';

/**
 * Regression coverage for the abandoned-promise leak in the runtime scheduler's
 * async dispatch loop.
 *
 * The scheduler linearizes a plan tree, then feeds each instruction's output into
 * the destination instruction that consumes it by parking the output in
 * `instrArgs[destination]` until the destination runs. While a query runs
 * asynchronously, some parked args are still-pending promises. If an instruction
 * throws *before* the destination that would await a parked promise runs, that
 * promise was previously abandoned — never awaited, never handled — which under
 * Node's default strict unhandled-rejection policy escalates an ordinary query
 * error into a process-fatal crash.
 *
 * A parent `P(params: [L, R])` linearizes as `[L, R, P]` with both leaves feeding
 * `P`. When `L` returns a promise (parked at `P`) and its sibling `R` throws
 * synchronously, `P` never runs, so `L`'s promise is left dangling.
 */

/** Minimal runtime context; the synthetic instructions below never touch `db`. */
function makeRuntimeContext(overrides: Partial<RuntimeContext> = {}): RuntimeContext {
	return {
		db: undefined as unknown as RuntimeContext['db'],
		stmt: undefined,
		params: {},
		context: new RowContextMap(),
		tableContexts: new Map(),
		enableMetrics: false,
		...overrides,
	};
}

/**
 * Build a `Scheduler` over the abandoned-promise repro tree:
 *  - `L`  — leaf whose output is a promise that rejects on a later macrotask.
 *  - `R`  — leaf that throws synchronously.
 *  - `P`  — parent consuming `[L, R]`; must never run because `R` throws first.
 */
function makeReproScheduler(): { scheduler: Scheduler; pRan: () => boolean } {
	let pRanFlag = false;

	const L: Instruction = {
		params: [],
		// Rejects on a macrotask so the rejection is only observed if nothing
		// attaches a handler — i.e. the promise was truly abandoned.
		run: asRun(() => new Promise<RuntimeValue>((_resolve, reject) => {
			setTimeout(() => reject(new Error('L-rejected')), 0);
		})),
		note: 'L (async, rejects)',
	};

	const R: Instruction = {
		params: [],
		run: asRun(() => { throw new Error('R-threw'); }),
		note: 'R (throws)',
	};

	const P: Instruction = {
		params: [L, R],
		run: asRun(() => { pRanFlag = true; return 'P-ran'; }),
		note: 'P (parent)',
	};

	return { scheduler: new Scheduler(P), pRan: () => pRanFlag };
}

/**
 * Run the repro scheduler under the given context, collecting any unhandled
 * rejection whose reason mentions our leaked promise. Returns the surfaced error
 * and the leaked-rejection count.
 */
async function runRepro(ctx: RuntimeContext): Promise<{ error: unknown; leaks: number }> {
	const leaks: unknown[] = [];
	const handler = (reason: unknown) => {
		if (reason instanceof Error && reason.message === 'L-rejected') {
			leaks.push(reason);
		}
	};
	process.on('unhandledRejection', handler);
	try {
		const { scheduler } = makeReproScheduler();
		let error: unknown;
		try {
			await scheduler.run(ctx);
		} catch (e) {
			error = e;
		}
		// Give the macrotask that rejects `L` time to fire and (on the buggy code)
		// be flagged as unhandled.
		await new Promise<void>(resolve => setTimeout(resolve, 50));
		return { error, leaks: leaks.length };
	} finally {
		process.off('unhandledRejection', handler);
	}
}

describe('Runtime scheduler error cleanup', () => {
	it('optimized: surfaces the sync throw and does not abandon the sibling promise', async () => {
		const { error, leaks } = await runRepro(makeRuntimeContext());

		expect(error).to.be.instanceOf(Error);
		expect((error as Error).message).to.equal('R-threw');
		expect(leaks).to.equal(0, 'abandoned promise from sibling L must be drained, not left unhandled');
	});

	it('metrics: surfaces the sync throw and does not abandon the transition promise', async () => {
		const { error, leaks } = await runRepro(makeRuntimeContext({ enableMetrics: true }));

		expect(error).to.be.instanceOf(Error);
		expect((error as Error).message).to.equal('R-threw');
		expect(leaks).to.equal(0, 'metrics async loop must drain the parked transition promise on throw');
	});

	it('tracing: eagerly awaits the transition output, so nothing is abandoned', async () => {
		// The tracing async loop awaits each promise output before tracing it, so the
		// transition promise (L) is awaited at the top of the loop. It therefore
		// surfaces L's rejection rather than R's, and can never abandon a promise.
		// This case guards that the sweep-on-throw does not break that behavior.
		const tracer = new CollectingInstructionTracer();
		const { error, leaks } = await runRepro(makeRuntimeContext({ tracer }));

		expect(error).to.be.instanceOf(Error);
		expect((error as Error).message).to.equal('L-rejected');
		expect(leaks).to.equal(0, 'tracing awaits the transition promise, so it is never unhandled');
	});
});

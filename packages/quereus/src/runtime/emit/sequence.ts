import type { SequenceNode } from '../../planner/nodes/sequence-node.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { asRun } from '../types.js';
import type { RuntimeValue, Row, SubProgram } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { emitCallFromPlan } from '../emitters.js';
import { isAsyncIterable } from '../utils.js';

/**
 * Emit a {@link SequenceNode}: drive each side-effect child to completion, in
 * list order, then delegate to the main child.
 *
 * Effects and main are emitted as **callbacks** (`emitCallFromPlan` wraps each in
 * its own sub-program), not bare params — the scheduler kicks off sibling params
 * concurrently (see `emitViewMutation`'s header for why bare params cannot carry
 * ordering), and an effect's write interleaving with the main statement's own
 * write breaks statement-savepoint pairing. The main child's result is returned
 * un-drained, so a streaming relational main still streams; its rows are pulled
 * only after every effect has completed.
 */
export function emitSequence(plan: SequenceNode, ctx: EmissionContext): Instruction {
	const effectInstructions = plan.effects.map(e => emitCallFromPlan(e, ctx));
	const mainInstruction = emitCallFromPlan(plan.main, ctx);

	async function run(rctx: RuntimeContext, ...args: RuntimeValue[]): Promise<RuntimeValue> {
		const effectCbs = args.slice(0, effectInstructions.length) as SubProgram[];
		const mainCb = args[effectInstructions.length] as SubProgram;

		for (const cb of effectCbs) {
			const result = cb(rctx);
			const resolved = result instanceof Promise ? await result : result;
			// A Sink-topped effect resolves to its row count; defensively drain a
			// relational result so its writes fire before the next effect.
			if (isAsyncIterable(resolved)) {
				for await (const _row of resolved as AsyncIterable<Row>) { /* drain side effects */ }
			}
		}

		const mainResult = mainCb(rctx);
		return mainResult instanceof Promise ? await mainResult : mainResult;
	}

	return {
		params: [...effectInstructions, mainInstruction],
		run: asRun(run),
		note: `sequence(${effectInstructions.length} effect${effectInstructions.length === 1 ? '' : 's'})`,
	};
}

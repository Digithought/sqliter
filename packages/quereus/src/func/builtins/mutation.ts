import { createScalarFunction } from '../registration.js';
import type { ScalarFunctionCallNode } from '../../planner/nodes/function.js';
import type { EmissionContext } from '../../runtime/emission-context.js';
import type { Instruction, RuntimeContext } from '../../runtime/types.js';
import { asRun } from '../../runtime/types.js';
import { INTEGER_RETURN_NOT_NULL } from './return-types.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode, type OutputValue, type SqlValue } from '../../common/types.js';

/**
 * `mutation_ordinal()` — the 1-based ordinal of the row being produced within the
 * current INSERT / mutation-context evaluation.
 *
 * It is the column-`default`-position analogue of `row_number()`: a deterministic
 * per-row primitive that reaches where a window function cannot (a column default),
 * so a basis author can compose a high-water-mark surrogate allocator entirely in
 * SQL — e.g. `default (coalesce((select max(rid) from anchor_tbl), 0) + mutation_ordinal())`
 * — which reconstructs the old zero-config `integer-auto` surrogate as ordinary
 * declared-default SQL (docs/vu-mutation-context.md § Mutation Context,
 * docs/architecture.md § Sequential ID Generation).
 *
 * **Deterministic** (it depends only on the captured per-row ordinal, not on a
 * non-deterministic clock / RNG), so a default that uses only it plus deterministic
 * state passes the schema-determinism gate with no `nondeterministic_schema` opt-out.
 *
 * Its value lives on {@link RuntimeContext.mutationOrdinal}, set per row by the INSERT
 * DML executor and the shared-surrogate envelope. It must be emitted via the custom
 * emitter below (it reads the runtime context, which the default scalar-function path
 * does not expose), and it errors when evaluated outside a mutation-context scope.
 *
 * Nullary + deterministic does **not** make it constant-foldable: the constant-folding
 * pass folds a functional node only when it has ≥ 1 child and every child is constant
 * (`planner/analysis/const-pass.ts` `classifyNode`), so a zero-operand call is left
 * intact and resolves at runtime.
 */
function emitMutationOrdinal(
	_plan: ScalarFunctionCallNode,
	_ctx: EmissionContext,
	_defaultEmit: (plan: ScalarFunctionCallNode, ctx: EmissionContext) => Instruction,
): Instruction {
	function run(rctx: RuntimeContext): OutputValue {
		const ordinal = rctx.mutationOrdinal;
		if (ordinal === undefined) {
			throw new QuereusError(
				`mutation_ordinal() is only valid during INSERT default / mutation-context evaluation`,
				StatusCode.ERROR,
			);
		}
		return ordinal as SqlValue;
	}
	return { params: [], run: asRun(run), note: 'mutation_ordinal()' };
}

export const mutationOrdinalFunc = createScalarFunction(
	{
		name: 'mutation_ordinal',
		numArgs: 0,
		deterministic: true,
		returnType: INTEGER_RETURN_NOT_NULL,
	},
	// The custom emitter handles every call; this direct implementation is only a
	// guard for an unexpected non-emitted invocation.
	() => {
		throw new QuereusError(
			`mutation_ordinal() must be emitted via its custom emitter (it reads the runtime mutation context)`,
			StatusCode.INTERNAL,
		);
	},
);

mutationOrdinalFunc.customEmitter = emitMutationOrdinal;

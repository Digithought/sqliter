import type { CastNode } from '../../planner/nodes/scalar.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { asRun } from '../types.js';
import { emitPlanNode } from '../emitters.js';
import { type SqlValue } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { inferType } from '../../types/registry.js';
import type { LogicalType } from '../../types/logical-type.js';

export function emitCast(plan: CastNode, ctx: EmissionContext): Instruction {
	const logicalType = inferType(plan.expression.targetType);

	function run(
		_runtimeCtx: RuntimeContext,
		operandValue: SqlValue
	): SqlValue {
		if (operandValue === null) return null;

		if (logicalType.parse) {
			try {
				return logicalType.parse(operandValue);
			} catch {
				// CAST failures in SQL return 0 for numeric targets, '' for text, etc.
				// This matches SQLite's lenient CAST behavior.
				return castFallback(operandValue, logicalType);
			}
		}

		// NOTE: a type with no `parse` defines no conversion, so the operand passes
		// through while the cast still advertises the target type — the very shape
		// castFallback exists to prevent. Unreachable today: NULL is the only builtin
		// without `parse`, and the parser rejects it as a CAST target. If a plugin
		// ever registers a parse-less type, validate here too.
		return operandValue;
	}

	return {
		params: [emitPlanNode(plan.operand, ctx)],
		run: asRun(run),
		note: `cast(${plan.expression.targetType})`
	};
}

/**
 * Fallback for when LogicalType.parse throws on invalid input.
 *
 * CAST stays lenient and never throws, but every arm must yield a value that
 * actually inhabits the target type — otherwise the cast advertises a logical
 * type it does not produce and 'junk' ends up stored in a DATE column.
 *
 * The SQLite-compatible arms below (0 / 0.0 / String(v) / UTF-8 bytes) each
 * satisfy their own type's `validate`. Everything else falls to the default,
 * where the type itself is asked. `parse` reads its input as *source text*, so
 * it can reject a value that already IS a valid member of the target type — a
 * bare JS string is a legitimate JSON string scalar even though
 * `JSON_TYPE.parse('hello')` throws on it as invalid JSON syntax. Keeping the
 * operand only when `validate` vouches for it preserves that case (and with it
 * `json_col = 'not json'` evaluating to false rather than erroring), while a
 * value that inhabits no part of the target type yields NULL — the cast has no
 * result.
 *
 * NOTE: `validate` is optional on LogicalType, so a custom registered type that
 * omits it makes every parse failure NULL. Every built-in defines one; if a
 * plugin type ever needs the operand preserved, give it a `validate` rather than
 * loosening this to "no validate ⇒ keep".
 */
function castFallback(value: SqlValue, type: LogicalType): SqlValue {
	switch (type.name) {
		case 'INTEGER':
			return 0;
		case 'REAL':
			return 0.0;
		case 'NUMERIC':
			return 0;
		case 'TEXT':
			return String(value);
		case 'BLOB':
			return new TextEncoder().encode(String(value));
		default:
			return type.validate?.(value) === true ? value : null;
	}
}

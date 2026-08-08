import { StatusCode } from "../../common/types.js";
import { quereusError } from "../../common/errors.js";
import type { SqlValue } from "../../common/types.js";
import type { Instruction, RuntimeContext } from "../types.js";
import { asRun } from "../types.js";
import type { UnaryOpNode } from "../../planner/nodes/scalar.js";
import { emitPlanNode } from "../emitters.js";
import type { EmissionContext } from "../emission-context.js";
import { isTruthy } from "../../util/comparison.js";
import { Temporal } from 'temporal-polyfill';
import { TIMESPAN_TYPE } from "../../types/temporal-types.js";

export function emitUnaryOp(plan: UnaryOpNode, ctx: EmissionContext): Instruction {
	// Select the operation function at emit time
	let run: (ctx: RuntimeContext, operand: SqlValue) => SqlValue;
	let note: string;

	// Normalize operator to uppercase for case-insensitive matching
	const operator = plan.expression.operator.toUpperCase();

	switch (operator) {
		case 'NOT':
			run = (_ctx: RuntimeContext, operand: SqlValue) => {
				// SQL NOT: NULL -> NULL, false -> true, true -> false
				if (operand === null) return null;
				return !isTruthy(operand);
			};
			note = 'NOT';
			break;

		case 'IS NULL':
			run = (_ctx: RuntimeContext, operand: SqlValue) => {
				return operand === null;
			};
			note = 'IS NULL';
			break;

		case 'IS NOT NULL':
			run = (_ctx: RuntimeContext, operand: SqlValue) => {
				return operand !== null;
			};
			note = 'IS NOT NULL';
			break;

		case 'IS TRUE':
			run = (_ctx: RuntimeContext, operand: SqlValue) => {
				// Total predicate: NULL operand is not true; otherwise SQL truthiness.
				return operand === null ? false : isTruthy(operand);
			};
			note = 'IS TRUE';
			break;

		case 'IS NOT TRUE':
			run = (_ctx: RuntimeContext, operand: SqlValue) => {
				// ≡ NOT (x IS TRUE): the NULL row flips into the true bucket.
				return operand === null ? true : !isTruthy(operand);
			};
			note = 'IS NOT TRUE';
			break;

		case 'IS FALSE':
			run = (_ctx: RuntimeContext, operand: SqlValue) => {
				// Total predicate: NULL operand is not false; otherwise not-truthy.
				return operand === null ? false : !isTruthy(operand);
			};
			note = 'IS FALSE';
			break;

		case 'IS NOT FALSE':
			run = (_ctx: RuntimeContext, operand: SqlValue) => {
				// ≡ NOT (x IS FALSE): the NULL row flips into the true bucket.
				return operand === null ? true : isTruthy(operand);
			};
			note = 'IS NOT FALSE';
			break;

		case '-': {
			// Use plan-time type info to select a specialized run function, mirroring
			// the binary arithmetic emitter's numeric-fast / temporal split.
			const operandLogical = plan.operand.getType().logicalType;
			if (operandLogical.isNumeric) {
				run = (_ctx: RuntimeContext, operand: SqlValue) => {
					if (operand === null) return null;
					return typeof operand === 'bigint' ? -operand : -(operand as number);
				};
				note = '-(numeric-fast)';
			} else if (operandLogical === TIMESPAN_TYPE) {
				run = (_ctx: RuntimeContext, operand: SqlValue) => {
					if (operand === null) return null;
					return Temporal.Duration.from(operand as string).negated().toString();
				};
				note = '-(timespan)';
			} else {
				run = (_ctx: RuntimeContext, operand: SqlValue) => {
					if (operand === null) return null;

					// Check if it's a timespan (ISO 8601 duration string)
					if (typeof operand === 'string' && (operand.startsWith('P') || operand.startsWith('-P'))) {
						try {
							const duration = Temporal.Duration.from(operand);
							return duration.negated().toString();
						} catch {
							// Not a valid duration, fall through to numeric handling
						}
					}

					// Numeric negation
					if (typeof operand === 'number') return -operand;
					if (typeof operand === 'bigint') return -operand;
					// Try to convert to number
					const num = Number(operand);
					return isNaN(num) ? null : -num;
				};
				note = 'unary -';
			}
			break;
		}

		case '+': {
			const operandLogical = plan.operand.getType().logicalType;
			if (operandLogical.isNumeric) {
				// Already number/bigint — unary plus is the identity.
				run = (_ctx: RuntimeContext, operand: SqlValue) => operand;
				note = '+(numeric-fast)';
			} else {
				run = (_ctx: RuntimeContext, operand: SqlValue) => {
					// Unary plus - convert to number if possible
					if (operand === null) return null;
					if (typeof operand === 'number' || typeof operand === 'bigint') return operand;
					const plusNum = Number(operand);
					return isNaN(plusNum) ? null : plusNum;
				};
				note = 'unary +';
			}
			break;
		}

		case '~': {
			const operandLogical = plan.operand.getType().logicalType;
			if (operandLogical.isNumeric) {
				// Already number/bigint — skip the Number() conversion attempt.
				run = (_ctx: RuntimeContext, operand: SqlValue) => {
					if (operand === null) return null;
					return typeof operand === 'bigint' ? ~operand : ~Math.trunc(operand as number);
				};
				note = '~(numeric-fast)';
			} else {
				run = (_ctx: RuntimeContext, operand: SqlValue) => {
					if (operand === null) return null;
					if (typeof operand === 'bigint') return ~operand;
					// Convert to integer and apply bitwise NOT
					const num = Number(operand);
					if (isNaN(num)) return null;
					return ~Math.trunc(num);
				};
				note = 'bitwise ~';
			}
			break;
		}

		default:
			quereusError(`Unsupported unary operator: ${plan.expression.operator}`, StatusCode.UNSUPPORTED, undefined, plan.expression);
	}

	const operandExpr = emitPlanNode(plan.operand, ctx);

	return {
		params: [operandExpr],
		run: asRun(run),
		note
	};
}

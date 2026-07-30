import type { InNode, ExistsNode, ScalarSubqueryNode } from '../../planner/nodes/subquery.js';
import type { Instruction, InstructionRun, RuntimeContext } from '../types.js';
import { asRun } from '../types.js';
import { emitPlanNode } from '../emitters.js';
import type { SqlValue, Row } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import { compareSqlValuesFast, hasSemanticOrdering, semanticKeyTransform } from '../../util/comparison.js';
import { createValueSet } from '../../util/value-set.js';
import { ConstantNode } from '../../planner/nodes/plan-node.js';
import { PlanNodeCharacteristics } from '../../planner/framework/characteristics.js';
import { effectiveInCollation, inRhsTypes } from '../../planner/analysis/comparison-collation.js';
import { isCorrelatedSubquery } from '../../planner/cache/correlation-detector.js';
import { PhysicalType, type LogicalType } from '../../types/logical-type.js';
import { NULL_TYPE, NUMERIC_TYPE } from '../../types/builtin-types.js';
import { lenientCast } from '../../types/cast-semantics.js';

/**
 * Once-per-execution memo for impure (DML-bearing) subquery inners. The cell
 * lives on the {@link RuntimeContext} — rebuilt for every statement execution —
 * keyed by a symbol minted per emit site. This is what makes the "run-once per
 * execution" contract hold when the instruction tree is cached and reused across
 * prepared-statement runs: the emit-time closure persists, but the memo does not.
 */
function readExecutionMemo(rctx: RuntimeContext, key: symbol): { value: SqlValue } | undefined {
	return rctx.executionMemo?.get(key);
}

function writeExecutionMemo(rctx: RuntimeContext, key: symbol, value: SqlValue): void {
	(rctx.executionMemo ??= new Map<symbol, { value: SqlValue }>()).set(key, { value });
}

export function emitScalarSubquery(plan: ScalarSubqueryNode, ctx: EmissionContext): Instruction {
	const isImpure = PlanNodeCharacteristics.subtreeHasSideEffects(plan.subquery);

	if (isImpure) {
		// Impure inner (DML w/ RETURNING in scalar position):
		// - Fully drain the iterator so every write happens, not just the first.
		// - Memoize across re-evaluations (correlated outer, per-row scan) so
		//   the DML fires exactly once per statement execution. The memo lives on
		//   the RuntimeContext (rebuilt each execution), so it resets between
		//   prepared-statement runs even though this instruction tree is cached.
		const memoKey = Symbol('SCALAR_SUBQUERY(impure)');

		async function runImpure(rctx: RuntimeContext, input: AsyncIterable<Row>): Promise<SqlValue> {
			const memoized = readExecutionMemo(rctx, memoKey);
			if (memoized) return memoized.value;

			let result: SqlValue = null;
			let seen = false;

			for await (const row of input) {
				if (!seen) {
					if (row.length > 1) {
						throw new QuereusError('Subquery should return at most one column', StatusCode.ERROR);
					}
					result = row.length === 0 ? null : row[0];
					seen = true;
				}
				// Continue iterating to drive every write, even past the first row.
			}

			writeExecutionMemo(rctx, memoKey, result);
			return result;
		}

		const innerInstruction = emitPlanNode(plan.subquery, ctx);

		return {
			params: [innerInstruction],
			run: asRun(runImpure),
			note: 'SCALAR_SUBQUERY(impure)'
		};
	}

	async function run(_rctx: RuntimeContext, input: AsyncIterable<Row>): Promise<SqlValue> {
		let result: SqlValue = null;
		let seen = false;

		for await (const row of input) {
			if (seen) {
				throw new QuereusError('Scalar subquery returned more than one row', StatusCode.ERROR, undefined, plan.expression.loc?.start.line, plan.expression.loc?.start.column);
			}
			if (row.length > 1) {
				throw new QuereusError('Subquery should return at most one column', StatusCode.ERROR);
			}
			result = row.length === 0 ? null : row[0];
			seen = true;
		}

		return result;
	}

	const innerInstruction = emitPlanNode(plan.subquery, ctx);

	return {
		params: [innerInstruction],
		run: asRun(run),
		note: 'SCALAR_SUBQUERY'
	};
}

const IDENTITY_KEY = (value: SqlValue): SqlValue => value;

/**
 * The two membership key transforms of one `condition IN (...)` site: one applied to the
 * probe (the `condition` value), one applied to every right-hand member value. They are
 * the same function for the symmetric semantic-normalization arm and deliberately
 * asymmetric for the object-physical arm — see {@link inMembershipKeys}.
 */
interface InMembershipKeys {
	/** Applied to the probe (the `condition` value). */
	readonly probe: (value: SqlValue) => SqlValue;
	/** Applied to every right-hand member value. */
	readonly member: (value: SqlValue) => SqlValue;
	/** EXPLAIN note suffix describing the transform; '' when both sides are identity. */
	readonly note: string;
}

const IDENTITY_KEYS: InMembershipKeys = { probe: IDENTITY_KEY, member: IDENTITY_KEY, note: '' };

const isObjectPhysical = (type: LogicalType): boolean => type.physicalType === PhysicalType.OBJECT;

/**
 * Membership key transforms for `condition IN (...)`. IN is an identity test, so it must
 * not disagree with the equality it desugars to. Two arms, resolved in this order:
 *
 * 1. **Object-physical vs anything else.** JSON is the engine's only logical type whose
 *    runtime values are native JS objects, a storage class `compareSqlValuesFast` never
 *    calls equal to a string. Every other comparison site reconciles this at PLAN time by
 *    wrapping the non-object side in `cast(… as json)`
 *    ({@link import('../../planner/building/coercion.js').coerceObjectPhysicalSet}); the IN
 *    *subquery* form has no fixed operand list to wrap, so the same conversion happens
 *    here, per row, via {@link lenientCast}.
 *
 *    The asymmetry is load-bearing, not tidiness: only the NON-object side converts,
 *    exactly as the plan-time helper does. Running the object side back through
 *    `JSON_TYPE.parse` would re-parse JSON **string scalars** — a JSON column holding the
 *    document `"[1,2]"` is stored as the plain JS string `[1,2]`, and re-parsing would turn
 *    it into the JSON *array* `[1,2]`, colliding two distinct documents.
 *
 *    The gate is `physicalType === OBJECT`, **not** `semanticOrdering`. A NULL-typed side
 *    is left alone — the membership test is UNKNOWN anyway.
 *
 * 1b. **Numeric vs textual.** The same pairing `=` reconciles by casting the textual side
 *    to the numeric side's type, for the same reason: a number and a string are different
 *    storage classes, so `int_col in (select text_col …)` could never match. Applied here
 *    only when the RHS is UNIFORM — every non-NULL member type numeric, or every one
 *    textual. A subquery RHS always is (one column, one type); a value list has been
 *    reconciled at plan time, EXCEPT the one shape `coerceComparisonSet` deliberately
 *    leaves alone (a textual probe against a list mixing numeric and textual values). The
 *    uniformity gate is what keeps that shape out of here, so the two paths cannot
 *    disagree about it.
 *
 * 2. **Semantic normalization (symmetric).** When an operand declares a semantic-ordering
 *    logical type (see {@link hasSemanticOrdering}) the probe AND every RHS value are
 *    normalized through that type's canonical group key before comparing. Without it,
 *    `d IN ('PT120M')` on a TIMESPAN column compares raw duration text and misses, while
 *    `d = 'PT120M'` matches on elapsed time.
 *
 *    Normalizing (rather than routing the type's `compare` straight into the comparator,
 *    as `emitComparisonOp`/BETWEEN do) is what keeps the BTree paths sound: the keys are
 *    ranked by plain storage-class + collation order, which is total even when a list
 *    literal is not a valid value of the type — `TIMESPAN.compare` mixes elapsed-time and
 *    text ordering in that case and is not.
 *
 *    A mixed pair (typed column vs plain text literal) still normalizes, matching
 *    `emitComparisonOp`'s generic path, whose runtime temporal check compares
 *    duration-vs-text semantically. TIMESPAN is the only type with a `groupKey` hook, so
 *    this arm is identity for everything else — including JSON, whose canonical text is
 *    already identity-faithful once arm 1 has put both sides in the object storage class
 *    (`compareSqlValuesFast`'s OBJECT branch compares canonical JSON text, so
 *    reorder-equal documents land on ONE BTree key). Membership tests whose operands
 *    declare two different semantic types also take no transform.
 */
function inMembershipKeys(plan: InNode): InMembershipKeys {
	const conditionType = plan.condition.getType().logicalType;
	const rhsTypes: LogicalType[] = inRhsTypes(plan).map(t => t.logicalType);

	// Arm 1: exactly one side object-physical. For a subquery RHS there is a single
	// member type; a value list has already been reconciled at plan time, so a mixed
	// list cannot reach here (every non-NULL element carries the object type too).
	const objectRhs = rhsTypes.find(isObjectPhysical);
	if (isObjectPhysical(conditionType) && !objectRhs && rhsTypes.some(t => t !== NULL_TYPE)) {
		return {
			probe: IDENTITY_KEY,
			member: (value: SqlValue) => lenientCast(value, conditionType),
			note: ` member as ${conditionType.name}`,
		};
	}
	if (objectRhs && !isObjectPhysical(conditionType) && conditionType !== NULL_TYPE) {
		return {
			probe: (value: SqlValue) => lenientCast(value, objectRhs),
			member: IDENTITY_KEY,
			note: ` probe as ${objectRhs.name}`,
		};
	}

	// Arm 1b: numeric vs textual, over a uniform RHS.
	const rhsNonNull = rhsTypes.filter(type => type !== NULL_TYPE);
	if (rhsNonNull.length > 0 && conditionType !== NULL_TYPE) {
		if (conditionType.isNumeric && rhsNonNull.every(type => type.isTextual)) {
			return {
				probe: IDENTITY_KEY,
				member: (value: SqlValue) => lenientCast(value, conditionType),
				note: ` member as ${conditionType.name}`,
			};
		}
		if (conditionType.isTextual && rhsNonNull.every(type => type.isNumeric)) {
			// One key space, so a mixed INTEGER/REAL member list widens to NUMERIC —
			// the same choice `coerceComparisonSet` makes for a hoisted probe cast.
			const first = rhsNonNull[0];
			const target = rhsNonNull.every(type => type === first) ? first : NUMERIC_TYPE;
			return {
				probe: (value: SqlValue) => lenientCast(value, target),
				member: IDENTITY_KEY,
				note: ` probe as ${target.name}`,
			};
		}
	}

	// Arm 2: symmetric semantic normalization.
	const semantic = new Set([conditionType, ...rhsTypes].filter(hasSemanticOrdering));
	if (semantic.size !== 1) return IDENTITY_KEYS;
	const transform = semanticKeyTransform(semantic.values().next().value);
	return transform ? { probe: transform, member: transform, note: ' semantic' } : IDENTITY_KEYS;
}

export function emitIn(plan: InNode, ctx: EmissionContext): Instruction {
	// ONE collation for the whole membership test (condition vs every RHS
	// value), resolved through the shared provenance lattice — the BTree build
	// below keys under it. Throws only as a backstop; InNode.generateType
	// already rejected conflicts at plan time.
	const collationName = effectiveInCollation(plan);
	const collation = ctx.resolveCollation(collationName);

	// Canonical identity keys — `probeKey` for the condition, `memberKey` for every
	// right-hand value. Asymmetric for the object-physical arm; see inMembershipKeys.
	const { probe: probeKey, member: memberKey, note: keyNote } = inMembershipKeys(plan);

	if (plan.source) {
		const isImpure = PlanNodeCharacteristics.subtreeHasSideEffects(plan.source);

		if (isImpure) {
			// Impure inner: fully drain (no short-circuit on match) so every
			// write fires, and memoize (once per execution, on the RuntimeContext)
			// so re-evaluation does not re-drive the DML.
			const memoKey = Symbol('IN(impure)');

			async function runImpure(rctx: RuntimeContext, input: AsyncIterable<Row>, condition: SqlValue): Promise<SqlValue> {
				const memoized = readExecutionMemo(rctx, memoKey);
				if (memoized) return memoized.value;

				let matched = false;
				let hasNull = false;
				// Keyed FIRST, then null-checked: an object-arm coercion can yield NULL
				// (a blob is a JSON value under no reading), which is UNKNOWN, not false.
				const conditionKey = condition === null ? null : probeKey(condition);
				const shouldCompare = conditionKey !== null;

				for await (const row of input) {
					if (row.length > 0) {
						const rowValue = row[0];
						const rowKey = rowValue === null ? null : memberKey(rowValue);
						if (rowKey === null) {
							hasNull = true;
						} else if (shouldCompare && !matched && compareSqlValuesFast(conditionKey, rowKey, collation) === 0) {
							matched = true;
						}
					}
					// Continue iterating to drive every write past the first match.
				}

				let result: SqlValue;
				if (!shouldCompare) {
					result = null;
				} else if (matched) {
					result = true;
				} else {
					result = hasNull ? null : false;
				}

				writeExecutionMemo(rctx, memoKey, result);
				return result;
			}

			const sourceInstruction = emitPlanNode(plan.source, ctx);
			const conditionExpr = emitPlanNode(plan.condition, ctx);

			return {
				params: [sourceInstruction, conditionExpr],
				run: asRun(runImpure),
				note: `IN(impure)${keyNote}`
			};
		}

		// Uncorrelated + functional (deterministic, read-only) source: materialize
		// the subquery result once per execution into a lookup set and probe it per
		// outer row — O(K + N·log K). This replaces re-driving the subquery for every
		// candidate row, the O(N×K) cliff that a per-row streaming scan degrades to at
		// scale (see quereus-in-subquery-set-probe). The gate matches the retired
		// `rule-in-subquery-cache`: a correlated source must re-evaluate per outer row,
		// and a non-deterministic source must keep its per-row semantics — both route
		// to the streaming path below. Parameter references inside the subquery are NOT
		// correlation (they are ParameterReference, not ColumnReference), so a
		// parameterized-but-uncorrelated subquery takes this path and rebuilds per
		// execution as the bound value changes.
		if (!isCorrelatedSubquery(plan.source) && PlanNodeCharacteristics.isFunctional(plan.source)) {
			// Per-execution memo: the set lives on the RuntimeContext (rebuilt each
			// execution), keyed by a symbol minted here at emit time. The emit-time
			// closure persists across prepared-statement runs but holds only the
			// symbol — never the tree — so the set resets between executions and a
			// re-run re-drains the source with current data. Same rule as the
			// impure-IN memo and emitCache.
			const probeSlot = Symbol('IN(set-probe)');

			// NOTE: the set holds deduplicated scalar values — strictly less memory
			// than the row cache it replaces, and the literal `IN (a, b, …)` path is
			// already uncapped, so no size cap here. If enormous inner results ever
			// need bounding, add a threshold that spills to the streaming path.
			async function runSetProbe(rctx: RuntimeContext, input: AsyncIterable<Row>, condition: SqlValue): Promise<SqlValue> {
				// Condition NULL → NULL, and do NOT force the build (short-circuit).
				// A condition that COERCES to NULL under the object arm is UNKNOWN too,
				// and must not force the build either — so key before the build, not after.
				if (condition === null) {
					return null;
				}
				const conditionKey = probeKey(condition);
				if (conditionKey === null) {
					return null;
				}

				let probe = rctx.inSetProbes?.get(probeSlot);
				if (!probe) {
					// First evaluation that needs the set: drain the source once into a
					// BTree keyed under the membership collation, tracking inner NULLs.
					const tree = createValueSet<SqlValue>(
						(a: SqlValue, b: SqlValue) => compareSqlValuesFast(a, b, collation)
					);
					let hasNull = false;
					for await (const row of input) {
						if (row.length > 0) {
							const rowValue = row[0];
							// A member that coerces to NULL is not a member — it makes the
							// miss case UNKNOWN, exactly as a literal inner NULL does.
							const rowKey = rowValue === null ? null : memberKey(rowValue);
							if (rowKey === null) {
								hasNull = true;
							} else {
								// Duplicate keys are a no-op insert — the set only tracks membership.
								tree.insert(rowKey);
							}
						}
					}
					probe = { tree, hasNull };
					(rctx.inSetProbes ??= new Map()).set(probeSlot, probe);
				}

				// Three-valued membership, identical to the streaming and value-list paths:
				// hit → true; miss → NULL if the inner had a NULL, else false.
				if (probe.tree.find(conditionKey).on) {
					return true;
				}
				return probe.hasNull ? null : false;
			}

			const sourceInstruction = emitPlanNode(plan.source, ctx);
			const conditionExpr = emitPlanNode(plan.condition, ctx);

			return {
				params: [sourceInstruction, conditionExpr],
				run: asRun(runSetProbe),
				note: `IN (subquery set-probe)${keyNote}`
			};
		}

		// Correlated or non-deterministic source: streaming + early exit on match,
		// re-evaluated per outer row.
		async function runSubqueryStreaming(_rctx: RuntimeContext, input: AsyncIterable<Row>, condition: SqlValue): Promise<SqlValue> {
			// If condition is NULL, result is NULL
			if (condition === null) {
				return null;
			}

			const conditionKey = probeKey(condition);
			// A condition that coerces to NULL is UNKNOWN, like a NULL condition.
			if (conditionKey === null) {
				return null;
			}

			let hasNull = false;
			for await (const row of input) {
				if (row.length > 0) {
					const rowValue = row[0];
					const rowKey = rowValue === null ? null : memberKey(rowValue);
					if (rowKey === null) {
						hasNull = true;
						continue;
					}
					// Check for match immediately - no need to materialize
					if (compareSqlValuesFast(conditionKey, rowKey, collation) === 0) {
						return true; // Found a match
					}
				}
			}

			// No match found - if any value was NULL, result is NULL
			return hasNull ? null : false;
		}

		const sourceInstruction = emitPlanNode(plan.source, ctx);
		const conditionExpr = emitPlanNode(plan.condition, ctx);

		return {
			params: [sourceInstruction, conditionExpr],
			run: asRun(runSubqueryStreaming),
			note: `IN (subquery)${keyNote}`
		};
	} else if (plan.values) {
		// IN value list: expr IN (value1, value2, ...)

		// Check if all values are truly constant (can be evaluated at emit time)
		const allConstant = plan.values.every(val => val.physical.constant);

		if (allConstant) {
			// Pre-build BTree at emit time for constant values
			const tree = createValueSet<SqlValue>(
				(a: SqlValue, b: SqlValue) => compareSqlValuesFast(a, b, collation)
			);
			let hasNull = false;

			function innerConstantRun(_rctx: RuntimeContext, condition: SqlValue): SqlValue {
				// If condition is NULL — or coerces to NULL — the result is NULL
				const conditionKey = condition === null ? null : probeKey(condition);
				if (conditionKey === null) {
					return null;
				}

				// Check if condition exists in pre-built tree
				const path = tree.find(conditionKey);
				if (path.on) {
					return true; // Found a match
				}

				// No match found - if any value was NULL, result is NULL
				return hasNull ? null : false;
			}

			const values = plan.values.map(val => (val as unknown as ConstantNode).getValue());

			let runFunc: InstructionRun;

			if (values.some(val => val instanceof Promise)) {
				// Must resolve promises at runtime
				runFunc = asRun(async (rctx: RuntimeContext, condition: SqlValue): Promise<SqlValue> => {
					const resolved = await Promise.all(values);

					for (const value of resolved) {
						const valueKey = value === null ? null : memberKey(value as SqlValue);
						if (valueKey === null) {
							hasNull = true;
							continue;
						}
						tree.insert(valueKey);
					}

					return innerConstantRun(rctx, condition);
				});
			} else {
				for (const value of values) {
					const valueKey = value === null ? null : memberKey(value as SqlValue);
					if (valueKey === null) {
						hasNull = true;
						continue;
					}
					tree.insert(valueKey);
				}
				runFunc = asRun(innerConstantRun);
			}

			const conditionExpr = emitPlanNode(plan.condition, ctx);

			return {
				params: [conditionExpr],
				run: runFunc,
				note: `IN (${plan.values.length} constant values)${keyNote}`
			};
		} else {
			// Some values are expressions - build tree at runtime
			function runDynamicValues(_rctx: RuntimeContext, condition: SqlValue, ...values: SqlValue[]): SqlValue {
				// If condition is NULL — or coerces to NULL — the result is NULL
				const conditionKey = condition === null ? null : probeKey(condition);
				if (conditionKey === null) {
					return null;
				}

				// Linear scan is optimal since we're only doing one lookup per execution
				let hasNull = false;
				for (const value of values) {
					const valueKey = value === null ? null : memberKey(value);
					if (valueKey === null) {
						hasNull = true;
						continue;
					}
					if (compareSqlValuesFast(conditionKey, valueKey, collation) === 0) {
						return true; // Found a match
					}
				}

				// No match found - if any value was NULL, result is NULL
				return hasNull ? null : false;
			}

			const conditionExpr = emitPlanNode(plan.condition, ctx);
			const valueExprs = plan.values.map(val => emitPlanNode(val, ctx));

			return {
				params: [conditionExpr, ...valueExprs],
				run: asRun(runDynamicValues),
				note: `IN (${plan.values.length} dynamic values)${keyNote}`
			};
		}
	} else {
		throw new QuereusError('IN node must have either source or values', StatusCode.INTERNAL);
	}
}

export function emitExists(plan: ExistsNode, ctx: EmissionContext): Instruction {
	const isImpure = PlanNodeCharacteristics.subtreeHasSideEffects(plan.subquery);

	if (isImpure) {
		// Impure inner: fully drain (no short-circuit) so every write fires,
		// and memoize (once per execution, on the RuntimeContext) so re-evaluation
		// does not re-drive the DML.
		const memoKey = Symbol('EXISTS(impure)');

		async function runImpure(rctx: RuntimeContext, input: AsyncIterable<Row>): Promise<SqlValue> {
			const memoized = readExecutionMemo(rctx, memoKey);
			if (memoized) return memoized.value;

			let any = false;
			for await (const _row of input) {
				any = true;
				// Continue iterating to drive every write past the first row.
			}

			const result: SqlValue = any;
			writeExecutionMemo(rctx, memoKey, result);
			return result;
		}

		const innerInstruction = emitPlanNode(plan.subquery, ctx);

		return {
			params: [innerInstruction],
			run: asRun(runImpure),
			note: 'EXISTS(impure)'
		};
	}

	async function run(_rctx: RuntimeContext, input: AsyncIterable<Row>): Promise<SqlValue> {
		for await (const _row of input) {
			return true; // First row => TRUE
		}
		return false; // Empty => FALSE
	}

	const innerInstruction = emitPlanNode(plan.subquery, ctx);

	return {
		params: [innerInstruction],
		run: asRun(run),
		note: 'EXISTS'
	};
}

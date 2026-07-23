import type { InNode, ExistsNode, ScalarSubqueryNode } from '../../planner/nodes/subquery.js';
import type { Instruction, InstructionRun, RuntimeContext } from '../types.js';
import { asRun } from '../types.js';
import { emitPlanNode } from '../emitters.js';
import type { SqlValue, Row } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import { BTree } from 'inheritree';
import { compareSqlValuesFast } from '../../util/comparison.js';
import { ConstantNode } from '../../planner/nodes/plan-node.js';
import { PlanNodeCharacteristics } from '../../planner/framework/characteristics.js';
import { effectiveInCollation } from '../../planner/analysis/comparison-collation.js';
import { isCorrelatedSubquery } from '../../planner/cache/correlation-detector.js';

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

export function emitIn(plan: InNode, ctx: EmissionContext): Instruction {
	// ONE collation for the whole membership test (condition vs every RHS
	// value), resolved through the shared provenance lattice — the BTree build
	// below keys under it. Throws only as a backstop; InNode.generateType
	// already rejected conflicts at plan time.
	const collationName = effectiveInCollation(plan);
	const collation = ctx.resolveCollation(collationName);

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
				const shouldCompare = condition !== null;

				for await (const row of input) {
					if (row.length > 0) {
						const rowValue = row[0];
						if (rowValue === null) {
							hasNull = true;
						} else if (shouldCompare && !matched && compareSqlValuesFast(condition, rowValue, collation) === 0) {
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
				note: 'IN(impure)'
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
			const probeKey = Symbol('IN(set-probe)');

			// NOTE: the set holds deduplicated scalar values — strictly less memory
			// than the row cache it replaces, and the literal `IN (a, b, …)` path is
			// already uncapped, so no size cap here. If enormous inner results ever
			// need bounding, add a threshold that spills to the streaming path.
			async function runSetProbe(rctx: RuntimeContext, input: AsyncIterable<Row>, condition: SqlValue): Promise<SqlValue> {
				// Condition NULL → NULL, and do NOT force the build (short-circuit).
				if (condition === null) {
					return null;
				}

				let probe = rctx.inSetProbes?.get(probeKey);
				if (!probe) {
					// First evaluation that needs the set: drain the source once into a
					// BTree keyed under the membership collation, tracking inner NULLs.
					const tree = new BTree<SqlValue, SqlValue>(
						(val: SqlValue) => val,
						(a: SqlValue, b: SqlValue) => compareSqlValuesFast(a, b, collation)
					);
					let hasNull = false;
					for await (const row of input) {
						if (row.length > 0) {
							const rowValue = row[0];
							if (rowValue === null) {
								hasNull = true;
							} else {
								// Duplicate keys are a no-op insert — the set only tracks membership.
								tree.insert(rowValue);
							}
						}
					}
					probe = { tree, hasNull };
					(rctx.inSetProbes ??= new Map()).set(probeKey, probe);
				}

				// Three-valued membership, identical to the streaming and value-list paths:
				// hit → true; miss → NULL if the inner had a NULL, else false.
				if (probe.tree.find(condition).on) {
					return true;
				}
				return probe.hasNull ? null : false;
			}

			const sourceInstruction = emitPlanNode(plan.source, ctx);
			const conditionExpr = emitPlanNode(plan.condition, ctx);

			return {
				params: [sourceInstruction, conditionExpr],
				run: asRun(runSetProbe),
				note: 'IN (subquery set-probe)'
			};
		}

		// Correlated or non-deterministic source: streaming + early exit on match,
		// re-evaluated per outer row.
		async function runSubqueryStreaming(_rctx: RuntimeContext, input: AsyncIterable<Row>, condition: SqlValue): Promise<SqlValue> {
			// If condition is NULL, result is NULL
			if (condition === null) {
				return null;
			}

			let hasNull = false;
			for await (const row of input) {
				if (row.length > 0) {
					const rowValue = row[0];
					if (rowValue === null) {
						hasNull = true;
						continue;
					}
					// Check for match immediately - no need to materialize
					if (compareSqlValuesFast(condition, rowValue, collation) === 0) {
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
			note: `IN (subquery)`
		};
	} else if (plan.values) {
		// IN value list: expr IN (value1, value2, ...)

		// Check if all values are truly constant (can be evaluated at emit time)
		const allConstant = plan.values.every(val => val.physical.constant);

		if (allConstant) {
			// Pre-build BTree at emit time for constant values
			const tree = new BTree<SqlValue, SqlValue>(
				(val: SqlValue) => val,
				(a: SqlValue, b: SqlValue) => compareSqlValuesFast(a, b, collation)
			);
			let hasNull = false;

			function innerConstantRun(_rctx: RuntimeContext, condition: SqlValue): SqlValue {
				// If condition is NULL, result is NULL
				if (condition === null) {
					return null;
				}

				// Check if condition exists in pre-built tree
				const path = tree.find(condition);
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
						if (value === null) {
							hasNull = true;
							continue;
						}
						tree.insert(value as SqlValue);
					}

					return innerConstantRun(rctx, condition);
				});
			} else {
				for (const value of values) {
					if (value === null) {
						hasNull = true;
						continue;
					}
					tree.insert(value as SqlValue);
				}
				runFunc = asRun(innerConstantRun);
			}

			const conditionExpr = emitPlanNode(plan.condition, ctx);

			return {
				params: [conditionExpr],
				run: runFunc,
				note: `IN (${plan.values.length} constant values)`
			};
		} else {
			// Some values are expressions - build tree at runtime
			function runDynamicValues(_rctx: RuntimeContext, condition: SqlValue, ...values: SqlValue[]): SqlValue {
				// If condition is NULL, result is NULL
				if (condition === null) {
					return null;
				}

				// Linear scan is optimal since we're only doing one lookup per execution
				let hasNull = false;
				for (const value of values) {
					if (value === null) {
						hasNull = true;
						continue;
					}
					if (compareSqlValuesFast(condition, value, collation) === 0) {
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
				note: `IN (${plan.values.length} dynamic values)`
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

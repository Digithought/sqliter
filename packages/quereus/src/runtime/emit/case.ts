import type { CaseExprNode } from '../../planner/nodes/scalar.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { asRun } from '../types.js';
import { emitPlanNode, emitCallFromPlan } from '../emitters.js';
import { type SqlValue, type MaybePromise } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { isTruthy } from '../../util/comparison.js';
import { effectiveComparisonCollation } from '../../planner/analysis/comparison-collation.js';
import { formatOperandCollationNote, makeOperandComparator, type OperandComparator } from './operand-comparator.js';

/** On-demand branch callback — evaluates its sub-expression only when invoked. */
type BranchFn = (ctx: RuntimeContext) => MaybePromise<SqlValue>;

export function emitCaseExpr(plan: CaseExprNode, ctx: EmissionContext): Instruction {
	// CASE must ALWAYS short-circuit: SQL evaluates WHEN clauses left-to-right,
	// stops at the first match, and evaluates ONLY the selected result. An
	// unmatched THEN/ELSE (or a later WHEN after an earlier one matched) must
	// never run — otherwise a branch that would throw/divide-by-zero/run a
	// subquery raises an error it was never supposed to. So every WHEN/THEN/ELSE
	// is emitted as an on-demand callback (emitCallFromPlan) and invoked lazily.
	// Unlike AND/OR (binary.ts), there is no cost/subquery gate: correctness, not
	// perf, forces the deferral, so it is unconditional. The base expr of a simple
	// CASE stays an eager param — it is always needed and evaluated exactly once.
	//
	// The run stays SYNCHRONOUS whenever every invoked branch callback resolves
	// synchronously (the common case, and the one the materialized-view row-time
	// gate in database-materialized-views-analysis.ts requires): a Promise is
	// only produced when a selected/consulted branch is genuinely async (e.g. a
	// scalar subquery). This mirrors the AND/OR short-circuit's sync fast path —
	// declaring the run `async` would force every CASE result into a Promise and
	// break that gate.
	const clauseCount = plan.whenThenClauses.length;

	// Simple CASE decides `base WHEN v` exactly as `base = v` does, resolved
	// INDEPENDENTLY per clause (mirroring how BETWEEN resolves its two bounds):
	// the collation comes from the shared provenance lattice (explicit COLLATE >
	// declared column collation > defaults > BINARY), and the routing between the
	// declared type's own compare / storage-class compare / runtime temporal check
	// is the one shared with BETWEEN and `=` (see operand-comparator.ts). Without
	// this, `case n when 'BOB'` compared raw bytes and disagreed with `n = 'BOB'`
	// on a NOCASE column and on semantic-ordering types like TIMESPAN.
	//
	// A genuine collation conflict (explicit COLLATE on the base AND a different
	// explicit COLLATE on a WHEN operand) throws here, exactly as `=` throws for
	// the same operand pair.
	const whenCollationNames = plan.baseExpr
		? plan.whenThenClauses.map(clause => effectiveComparisonCollation(plan.baseExpr!, clause.when))
		: [];
	const whenComparators: OperandComparator[] = plan.baseExpr
		? plan.whenThenClauses.map((clause, i) => makeOperandComparator(
			plan.baseExpr!.getType().logicalType,
			clause.when.getType().logicalType,
			ctx.resolveCollation(whenCollationNames[i]),
		))
		: [];

	// Searched CASE: CASE WHEN c1 THEN r1 ... ELSE e END
	// args layout: [when0, then0, when1, then1, ..., else?]
	function runSearchedCase(
		runtimeCtx: RuntimeContext,
		...args: BranchFn[]
	): MaybePromise<SqlValue> {
		const noMatch = (): MaybePromise<SqlValue> =>
			plan.elseExpr ? args[clauseCount * 2](runtimeCtx) : null;

		const step = (i: number): MaybePromise<SqlValue> => {
			if (i >= clauseCount) return noMatch();
			const whenFn = args[i * 2];
			const thenFn = args[i * 2 + 1];
			const w = whenFn(runtimeCtx);
			// Evaluate ONLY this THEN on a match; otherwise recurse to the next clause.
			// Later clauses are never touched once one matches.
			if (w instanceof Promise) {
				return w.then(wv => (isTruthy(wv) ? thenFn(runtimeCtx) : step(i + 1)));
			}
			return isTruthy(w) ? thenFn(runtimeCtx) : step(i + 1);
		};

		return step(0);
	}

	// Simple CASE: CASE base WHEN v1 THEN r1 ... ELSE e END
	// args layout: [base, when0, then0, when1, then1, ..., else?]
	function runSimpleCase(
		runtimeCtx: RuntimeContext,
		...args: [SqlValue, ...BranchFn[]]
	): MaybePromise<SqlValue> {
		const baseValue = args[0] as SqlValue;
		const branch = (idx: number): BranchFn => args[idx] as BranchFn;

		// NULL base never matches any WHEN — falls through to ELSE/NULL. Each clause
		// compares under its OWN pre-resolved comparator (collation + type routing).
		const matches = (i: number, whenValue: SqlValue): boolean =>
			baseValue !== null && whenValue !== null &&
			whenComparators[i](baseValue, whenValue) === 0;

		const noMatch = (): MaybePromise<SqlValue> =>
			plan.elseExpr ? branch(1 + clauseCount * 2)(runtimeCtx) : null;

		const step = (i: number): MaybePromise<SqlValue> => {
			if (i >= clauseCount) return noMatch();
			const whenFn = branch(1 + i * 2);
			const thenFn = branch(1 + i * 2 + 1);
			const w = whenFn(runtimeCtx);
			if (w instanceof Promise) {
				return w.then(wv => (matches(i, wv) ? thenFn(runtimeCtx) : step(i + 1)));
			}
			return matches(i, w) ? thenFn(runtimeCtx) : step(i + 1);
		};

		return step(0);
	}

	// Emit instructions for all sub-expressions. Base stays eager; every
	// WHEN/THEN/ELSE becomes an on-demand callback so unmatched branches never run.
	const paramInstructions: Instruction[] = [];

	if (plan.baseExpr) {
		paramInstructions.push(emitPlanNode(plan.baseExpr, ctx));
	}

	for (const clause of plan.whenThenClauses) {
		paramInstructions.push(emitCallFromPlan(clause.when, ctx));
		paramInstructions.push(emitCallFromPlan(clause.then, ctx));
	}

	if (plan.elseExpr) {
		paramInstructions.push(emitCallFromPlan(plan.elseExpr, ctx));
	}

	// asRun each branch independently — their arg tuples differ (simple CASE
	// leads with an eager base value), so a union would not infer cleanly.
	return {
		params: paramInstructions,
		run: plan.baseExpr ? asRun(runSimpleCase) : asRun(runSearchedCase),
		note: `case(short-circuit, ${clauseCount} when clauses${plan.elseExpr ? ', else' : ''})`
			+ formatOperandCollationNote(whenCollationNames)
	};
}

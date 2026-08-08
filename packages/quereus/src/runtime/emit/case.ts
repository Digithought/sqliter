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

/**
 * Per-clause match test of a simple CASE, resolved once at emit time: collation +
 * type routing per WHEN operand, and the rule that a NULL base matches nothing.
 * Shared by the instruction emitter and the fusion compiler so a fused CASE and an
 * instruction CASE can never disagree about which branch fires.
 */
export interface CaseMatcher {
	readonly collationNames: readonly string[];
	readonly matches: (clauseIndex: number, baseValue: SqlValue, whenValue: SqlValue) => boolean;
}

/**
 * Resolve how each WHEN clause of a simple CASE decides its match: `case base when v`
 * decides exactly as `base = v` does. The collation comes from the shared provenance
 * lattice (explicit COLLATE > declared column collation > defaults > BINARY), and the
 * routing between the declared type's own compare / storage-class compare / runtime
 * temporal check is the one shared with BETWEEN and `=` (see operand-comparator.ts).
 * Without this, `case n when 'BOB'` compared raw bytes and disagreed with `n = 'BOB'`
 * on a NOCASE column and on semantic-ordering types like TIMESPAN.
 *
 * Resolution is INDEPENDENT per clause (mirroring BETWEEN's two bounds, not IN's single
 * merged collation), so two differently-collated WHEN operands are not a conflict with
 * each other. A genuine conflict — explicit COLLATE on the base AND a different explicit
 * COLLATE on a WHEN operand — throws, exactly as `=` throws for the same operand pair.
 *
 * A searched CASE (no `baseExpr`) yields an empty `collationNames` and a `matches` that
 * is never called.
 *
 * NOTE: that throw happens at emit time, where `=` validates in `BinaryOpNode.generateType`.
 * Both surface inside `db.prepare` today (even a fully-constant CASE is emitted so the
 * folder can evaluate it). If a rule ever rewrites a `CaseExprNode` away without emitting
 * it, move this resolution into `CaseExprNode.generateType` and read the cached result here.
 */
export function buildCaseMatcher(plan: CaseExprNode, ctx: EmissionContext): CaseMatcher {
	const base = plan.baseExpr;
	if (!base) return { collationNames: [], matches: neverMatches };

	const baseLogical = base.getType().logicalType;
	const collationNames = plan.whenThenClauses.map(
		clause => effectiveComparisonCollation(base, clause.when, plan.expression));
	const comparators: OperandComparator[] = plan.whenThenClauses.map((clause, i) => makeOperandComparator(
		baseLogical,
		clause.when.getType().logicalType,
		ctx.resolveCollation(collationNames[i]),
	));

	// NULL base never matches any WHEN — falls through to ELSE/NULL. Each clause
	// compares under its OWN pre-resolved comparator (collation + type routing).
	const matches = (clauseIndex: number, baseValue: SqlValue, whenValue: SqlValue): boolean =>
		baseValue !== null && whenValue !== null &&
		comparators[clauseIndex](baseValue, whenValue) === 0;

	return { collationNames, matches };
}

/** Placeholder match test of a searched CASE, which compares nothing. */
function neverMatches(): boolean {
	return false;
}

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

	// A simple CASE compares its base against each WHEN under a per-clause
	// collation + type routing (searched CASE compares nothing here).
	const matcher = buildCaseMatcher(plan, ctx);

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

		const noMatch = (): MaybePromise<SqlValue> =>
			plan.elseExpr ? branch(1 + clauseCount * 2)(runtimeCtx) : null;

		const step = (i: number): MaybePromise<SqlValue> => {
			if (i >= clauseCount) return noMatch();
			const whenFn = branch(1 + i * 2);
			const thenFn = branch(1 + i * 2 + 1);
			const w = whenFn(runtimeCtx);
			if (w instanceof Promise) {
				return w.then(wv => (matcher.matches(i, baseValue, wv) ? thenFn(runtimeCtx) : step(i + 1)));
			}
			return matcher.matches(i, baseValue, w) ? thenFn(runtimeCtx) : step(i + 1);
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
			+ formatOperandCollationNote(matcher.collationNames)
	};
}

/**
 * Per-column constraint-satisfiability checker.
 *
 * Folds the conjunction of (predicate conjuncts ∧ source domain constraints ∧
 * literal constant bindings) into per-column accumulators, then asks:
 * "is there any value of every mentioned column that satisfies every fact?"
 *
 * The fragment is intentionally narrow:
 *   - Single-column comparisons against literals (= / == / != / < / <= / > / >=).
 *   - Single-column BETWEEN literal AND literal (positive form).
 *   - Single-column IN (lit, lit, ...) and intersection across IN-lists.
 *     The empty form `x IN ()` is also recognized as trivially `unsat`.
 *   - Range from `DomainConstraint { kind: 'range' }`.
 *   - Enum from `DomainConstraint { kind: 'enum' }`.
 *   - Literal `ConstantBinding`.
 *
 * Everything else (LIKE, function calls, cross-column comparisons, OR-trees,
 * CASE, IS NULL, NOT IN with non-literal RHS, …) marks the touched columns as
 * `sawUnknown`. The checker only ever returns `unsat` when an in-scope subset
 * proves a contradiction — false positives are never emitted.
 *
 * Used by `rule-filter-contradiction` to recognize `Filter(child, false)` cases
 * that const-folding can then collapse to `EmptyRelationNode`.
 */

import type {
	ScalarPlanNode,
	DomainConstraint,
	ConstantBinding,
} from '../nodes/plan-node.js';
import type { SqlValue } from '../../common/types.js';
import { ColumnReferenceNode } from '../nodes/reference.js';
import {
	BetweenNode,
	BinaryOpNode,
	CastNode,
	LiteralNode,
	UnaryOpNode,
} from '../nodes/scalar.js';
import { InNode } from '../nodes/subquery.js';
import {
	BINARY_COLLATION,
	builtinCollationResolver,
	compareSqlValuesFast,
	createTypedComparator,
	hasSemanticOrdering,
	normalizeCollationName,
} from '../../util/comparison.js';
import type { CollationFunction, CollationResolver, LogicalType } from '../../types/logical-type.js';
import { isNoOpCast } from './scalar-invertibility.js';
import { flipComparison } from './predicate-shape.js';
import { createLogger } from '../../common/logger.js';

const warnLog = createLogger('planner:analysis:sat-checker').extend('warn');

export type SatResult = 'sat' | 'unsat' | 'unknown';

/**
 * Per-column fact bag built as we walk the conjuncts/domains/bindings.
 *
 * The range half is the same shape used by `DomainConstraint { range }` —
 * unbounded sides leave `minValue` / `maxValue` undefined and ignore the
 * corresponding inclusive flag.
 */
interface ColumnAccumulator {
	minValue?: SqlValue;
	minInclusive: boolean;
	maxValue?: SqlValue;
	maxInclusive: boolean;
	/** `undefined` ⇒ no membership constraint observed; `[]` ⇒ already collapsed. */
	allowedValues?: SqlValue[];
	excluded: SqlValue[];
	sawUnknown: boolean;
}

/** Cap on the number of conjuncts we attempt to absorb. Mirrors `MAX_FDS_PER_NODE`. */
const MAX_CONJUNCTS = 64;
/** Cap on |allowedValues| / |excluded| before we collapse to `sawUnknown`. */
const MAX_VALUES_PER_COL = 64;

/**
 * Returns `'unsat'` iff the conjunction is provably contradictory within the
 * supported fragment; `'sat'` when no contradiction is found and every
 * mentioned clause was in scope; `'unknown'` otherwise. Never returns false
 * `'unsat'`.
 *
 * `attrIndex(attrId)` maps an attribute id visible to the predicate's
 * `ColumnReferenceNode`s back to the physical column index used by
 * `domains` / `bindings`. Pass an identity-style mapper if the caller has
 * already aligned them.
 *
 * `getCollation(col)` is optional; when supplied, equality / range comparisons
 * for that column use the named collation (TEXT only — numeric comparisons are
 * collation-independent). Defaults to BINARY.
 *
 * `collationResolver` maps a collation name to its function against the owning
 * `Database`, so a collation registered with `db.registerCollation(...)` is honored.
 * Without one, only the built-in names resolve and any other name forces
 * `'unknown'` — assuming BINARY for a collation we cannot see would let a
 * satisfiable predicate be proved `'unsat'`, and the caller would delete rows.
 */
export function checkSatisfiability(
	conjuncts: ReadonlyArray<ScalarPlanNode>,
	domains: ReadonlyArray<DomainConstraint>,
	bindings: ReadonlyArray<ConstantBinding>,
	attrIndex: (attrId: number) => number | undefined,
	getCollation?: (col: number) => string | undefined,
	collationResolver?: CollationResolver,
): SatResult {
	if (conjuncts.length > MAX_CONJUNCTS) return 'unknown';

	const collations = resolveColumnCollations(conjuncts, domains, bindings, attrIndex, getCollation, collationResolver);
	if (collations === undefined) return 'unknown'; // a collation we cannot resolve ⇒ prove nothing

	// Columns declared with a semantic-ordering logical type (TIMESPAN, JSON) must be
	// reasoned about under the type's compare, not text order — otherwise a satisfiable
	// range like `d BETWEEN 'PT30M' AND 'PT100M'` reads as empty ('PT30M' > 'PT100M'
	// textually) and mints a false `unsat` that deletes rows. Types are discovered from
	// the conjuncts' column references; a semantic-ordering column reachable only via
	// domains/bindings (no reference in any conjunct) keeps the collation compare, which
	// is the pre-existing conservative behavior for facts the checker cannot see.
	const semanticTypes = collectSemanticColumnTypes(conjuncts, attrIndex);
	const typedComparators = new Map<number, (a: SqlValue, b: SqlValue) => number>();
	for (const [col, type] of semanticTypes) {
		typedComparators.set(col, createTypedComparator(type, collations.get(col) ?? BINARY_COLLATION));
	}

	const accs = new Map<number, ColumnAccumulator>();
	const cmp = (a: SqlValue, b: SqlValue, col: number): number => {
		const typed = typedComparators.get(col);
		if (typed) return typed(a, b);
		return compareSqlValuesFast(a, b, collations.get(col) ?? BINARY_COLLATION);
	};

	// 1) Seed accumulators from declared domains.
	for (const d of domains) {
		const acc = getOrCreate(accs, d.column);
		if (d.kind === 'range') {
			if (d.min !== undefined && d.min !== null) {
				tightenLower(acc, d.min, d.minInclusive, d.column, cmp);
			}
			if (d.max !== undefined && d.max !== null) {
				tightenUpper(acc, d.max, d.maxInclusive, d.column, cmp);
			}
		} else {
			intersectAllowed(acc, d.values, d.column, cmp);
		}
	}

	// 2) Seed accumulators from literal constant bindings. Parameter bindings
	// carry no compile-time value, so they cannot prove a contradiction.
	for (const b of bindings) {
		if (b.value.kind !== 'literal') continue;
		const v = b.value.value;
		if (v === null) continue;
		for (const col of b.attrs) {
			const acc = getOrCreate(accs, col);
			tightenLower(acc, v, true, col, cmp);
			tightenUpper(acc, v, true, col, cmp);
			intersectAllowed(acc, [v], col, cmp);
		}
	}

	// 3) Absorb each conjunct.
	for (const conj of conjuncts) {
		absorb(conj, accs, attrIndex, cmp);
	}

	// 4) Decide per-column.
	let anyUnknown = false;
	for (const [col, acc] of accs) {
		// Collapse allowedValues with the range.
		if (acc.allowedValues !== undefined) {
			const filtered: SqlValue[] = [];
			for (const v of acc.allowedValues) {
				if (!withinRange(acc, v, col, cmp)) continue;
				if (containsValue(acc.excluded, v, col, cmp)) continue;
				filtered.push(v);
			}
			if (filtered.length === 0) return 'unsat';
			acc.allowedValues = filtered;
		}

		// Range emptiness.
		if (acc.minValue !== undefined && acc.maxValue !== undefined) {
			const c = cmp(acc.minValue, acc.maxValue, col);
			if (c > 0) return 'unsat';
			if (c === 0 && (!acc.minInclusive || !acc.maxInclusive)) return 'unsat';
			// Point range pinched by an exclusion.
			if (c === 0 && acc.minInclusive && acc.maxInclusive && containsValue(acc.excluded, acc.minValue, col, cmp)) {
				return 'unsat';
			}
		}

		// Singleton allowed value excluded.
		if (acc.allowedValues && acc.allowedValues.length === 1) {
			if (containsValue(acc.excluded, acc.allowedValues[0], col, cmp)) return 'unsat';
		}

		if (acc.sawUnknown) anyUnknown = true;
	}

	return anyUnknown ? 'unknown' : 'sat';
}

/**
 * Resolve every mentioned column's declared collation to a comparison function, once,
 * before any conjunct is absorbed. Returns `undefined` when some column declares a
 * collation neither the supplied resolver nor the built-in set can produce — the
 * caller must then answer `'unknown'` rather than silently comparing under BINARY.
 *
 * A column absent from the returned map declared no collation and compares under BINARY.
 * The bail is deliberately not carved out for numeric-only columns: an unresolvable
 * collation is rare, and conservatively refusing to prove anything is cheap.
 */
function resolveColumnCollations(
	conjuncts: ReadonlyArray<ScalarPlanNode>,
	domains: ReadonlyArray<DomainConstraint>,
	bindings: ReadonlyArray<ConstantBinding>,
	attrIndex: (attrId: number) => number | undefined,
	getCollation: ((col: number) => string | undefined) | undefined,
	collationResolver: CollationResolver | undefined,
): Map<number, CollationFunction> | undefined {
	const resolved = new Map<number, CollationFunction>();
	if (!getCollation) return resolved; // every column compares under BINARY

	const columns = new Set<number>();
	for (const d of domains) columns.add(d.column);
	for (const b of bindings) for (const col of b.attrs) columns.add(col);
	for (const conj of conjuncts) collectColumns(conj, attrIndex, columns);

	for (const col of columns) {
		const name = getCollation(col);
		if (name === undefined) continue;
		if (normalizeCollationName(name) === 'BINARY') continue;
		const func = collationResolver ? tryResolve(collationResolver, name) : builtinCollationResolver(name);
		if (!func) return undefined;
		resolved.set(col, func);
	}
	return resolved;
}

/**
 * A {@link CollationResolver} throws on an unregistered name. That is the right
 * contract for a comparator the engine is about to *use*, but here it is only a
 * question — "can I reason about this column?" — whose honest answer is `'unknown'`.
 *
 * NOTE: since `feat-ddl-accepts-registered-collations` landed, column DDL validates
 * an explicit COLLATE against the connection's registry for EVERY type (not just the
 * ones with a supported list), so an unregistered name like `k integer collate
 * frobnicate` is now rejected at CREATE and no longer reaches the planner. This
 * defensive catch is therefore cheap insurance rather than a currently-reachable
 * path: it keeps an optimizer rule from throwing should a column ever carry a
 * collation that resolves at DDL time but not here, or a future path reintroduce an
 * unvalidated one. Answering `'unknown'` is always safe — the checker only ever
 * proves `unsat` from resolvable comparisons. A CHECK on a (registered) custom
 * collation still publishes a `DomainConstraint` naming its column, which
 * `resolveColumnCollations` resolves cleanly:
 *   db.registerCollation('MYCOLL', cmp);
 *   create table t (id integer primary key, k integer collate MYCOLL check (k > 0));
 *   select id from t where id = 1;   -- plans without a false contradiction
 */
function tryResolve(resolver: CollationResolver, name: string): CollationFunction | undefined {
	try {
		return resolver(name);
	} catch (e) {
		warnLog('Cannot reason about collation %s (%s); satisfiability check yields unknown', name, e);
		return undefined;
	}
}

/**
 * Map each conjunct-referenced column to its declared logical type when that type
 * carries semantic ordering (see {@link hasSemanticOrdering}); other columns are
 * omitted and compare under storage-class + collation.
 */
function collectSemanticColumnTypes(
	conjuncts: ReadonlyArray<ScalarPlanNode>,
	attrIndex: (attrId: number) => number | undefined,
): Map<number, LogicalType> {
	const out = new Map<number, LogicalType>();
	forEachColumnReference(conjuncts, attrIndex, (col, ref) => {
		const logical = ref.getType().logicalType;
		if (hasSemanticOrdering(logical)) out.set(col, logical);
	});
	return out;
}

/** Collect the physical column index of every `ColumnReferenceNode` reachable from `n`. */
function collectColumns(
	n: ScalarPlanNode,
	attrIndex: (attrId: number) => number | undefined,
	out: Set<number>,
): void {
	forEachColumnReference([n], attrIndex, col => out.add(col));
}

/**
 * Walk the scalar subtrees of `roots`, invoking `visit` for every reachable
 * `ColumnReferenceNode` whose attribute maps to a physical column index. Relational
 * children are not descended into — a subquery's columns are not this predicate's.
 */
function forEachColumnReference(
	roots: ReadonlyArray<ScalarPlanNode>,
	attrIndex: (attrId: number) => number | undefined,
	visit: (col: number, ref: ColumnReferenceNode) => void,
): void {
	const stack: ScalarPlanNode[] = [...roots];
	while (stack.length > 0) {
		const cur = stack.pop()!;
		if (cur instanceof ColumnReferenceNode) {
			const idx = attrIndex(cur.attributeId);
			if (idx !== undefined) visit(idx, cur);
			continue;
		}
		for (const child of cur.getChildren()) {
			if ('expression' in child) stack.push(child as ScalarPlanNode);
		}
	}
}

function getOrCreate(accs: Map<number, ColumnAccumulator>, col: number): ColumnAccumulator {
	let acc = accs.get(col);
	if (!acc) {
		acc = {
			minInclusive: false,
			maxInclusive: false,
			excluded: [],
			sawUnknown: false,
		};
		accs.set(col, acc);
	}
	return acc;
}

function tightenLower(
	acc: ColumnAccumulator,
	value: SqlValue,
	inclusive: boolean,
	col: number,
	cmp: (a: SqlValue, b: SqlValue, col: number) => number,
): void {
	if (acc.minValue === undefined) {
		acc.minValue = value;
		acc.minInclusive = inclusive;
		return;
	}
	const c = cmp(value, acc.minValue, col);
	if (c > 0) {
		acc.minValue = value;
		acc.minInclusive = inclusive;
	} else if (c === 0 && acc.minInclusive && !inclusive) {
		acc.minInclusive = false;
	}
}

function tightenUpper(
	acc: ColumnAccumulator,
	value: SqlValue,
	inclusive: boolean,
	col: number,
	cmp: (a: SqlValue, b: SqlValue, col: number) => number,
): void {
	if (acc.maxValue === undefined) {
		acc.maxValue = value;
		acc.maxInclusive = inclusive;
		return;
	}
	const c = cmp(value, acc.maxValue, col);
	if (c < 0) {
		acc.maxValue = value;
		acc.maxInclusive = inclusive;
	} else if (c === 0 && acc.maxInclusive && !inclusive) {
		acc.maxInclusive = false;
	}
}

function intersectAllowed(
	acc: ColumnAccumulator,
	values: ReadonlyArray<SqlValue>,
	col: number,
	cmp: (a: SqlValue, b: SqlValue, col: number) => number,
): void {
	const nonNull: SqlValue[] = [];
	for (const v of values) if (v !== null) nonNull.push(v);
	if (nonNull.length > MAX_VALUES_PER_COL) {
		acc.sawUnknown = true;
		return;
	}
	if (acc.allowedValues === undefined) {
		acc.allowedValues = nonNull.slice();
		return;
	}
	const intersected: SqlValue[] = [];
	for (const v of acc.allowedValues) {
		if (containsValue(nonNull, v, col, cmp)) intersected.push(v);
	}
	acc.allowedValues = intersected;
}

function containsValue(
	arr: ReadonlyArray<SqlValue>,
	value: SqlValue,
	col: number,
	cmp: (a: SqlValue, b: SqlValue, col: number) => number,
): boolean {
	for (const v of arr) {
		if (cmp(v, value, col) === 0) return true;
	}
	return false;
}

function withinRange(
	acc: ColumnAccumulator,
	value: SqlValue,
	col: number,
	cmp: (a: SqlValue, b: SqlValue, col: number) => number,
): boolean {
	if (acc.minValue !== undefined) {
		const c = cmp(value, acc.minValue, col);
		if (c < 0) return false;
		if (c === 0 && !acc.minInclusive) return false;
	}
	if (acc.maxValue !== undefined) {
		const c = cmp(value, acc.maxValue, col);
		if (c > 0) return false;
		if (c === 0 && !acc.maxInclusive) return false;
	}
	return true;
}

/**
 * Strip value-preserving wrappers to expose the underlying literal / column
 * reference for shape matching.
 *
 * Only a no-op `CAST` (target logical type equal to the operand's) qualifies. A
 * converting cast changes the compared value — `x = '1' and cast(x as integer) = 1`
 * is satisfiable, but stripping the cast reads it as `x = '1' and x = 1`, a
 * cross-storage-class contradiction. A `COLLATE` wrapper changes the comparison's
 * effective collation — `x collate nocase = 'a' and x collate nocase = 'A'` is
 * satisfiable on a BINARY column, but stripping the wrapper compares under BINARY
 * and proves `'unsat'`. Either erasure mints a false `'unsat'` and the optimizer
 * deletes rows, so neither is stripped. The wrapped operand falls out of the
 * recognized shape and marks its columns `sawUnknown`, which is exactly the
 * intended "cannot prove unsatisfiable".
 *
 * (`constraint-extractor.ts`'s `unwrapCast` carries the same reasoning for COLLATE.)
 */
function unwrap(n: ScalarPlanNode): ScalarPlanNode {
	let cur = n;
	while (cur instanceof CastNode && isNoOpCast(cur)) cur = cur.operand;
	return cur;
}

function literalOf(n: ScalarPlanNode): SqlValue | undefined {
	const u = unwrap(n);
	if (!(u instanceof LiteralNode)) return undefined;
	const v = u.expression.value;
	if (v instanceof Promise) return undefined;
	return v;
}

function columnOf(
	n: ScalarPlanNode,
	attrIndex: (attrId: number) => number | undefined,
): number | undefined {
	const u = unwrap(n);
	if (!(u instanceof ColumnReferenceNode)) return undefined;
	return attrIndex(u.attributeId);
}

/**
 * Walk every column reference inside `n` and mark its accumulator `sawUnknown`.
 * Used when a sub-expression doesn't fit the recognized shape — we still flag
 * "we saw something about this column" so callers don't claim a clean `sat`.
 */
function markUnknownForColumns(
	n: ScalarPlanNode,
	accs: Map<number, ColumnAccumulator>,
	attrIndex: (attrId: number) => number | undefined,
): void {
	const columns = new Set<number>();
	collectColumns(n, attrIndex, columns);
	for (const col of columns) getOrCreate(accs, col).sawUnknown = true;
}

function absorb(
	conj: ScalarPlanNode,
	accs: Map<number, ColumnAccumulator>,
	attrIndex: (attrId: number) => number | undefined,
	cmp: (a: SqlValue, b: SqlValue, col: number) => number,
): void {
	if (conj instanceof BinaryOpNode) {
		const op = conj.expression.operator;
		switch (op) {
			case '=':
			case '==':
			case '!=':
			case '<>':
			case '<':
			case '<=':
			case '>':
			case '>=': {
				absorbBinary(conj, op, accs, attrIndex, cmp);
				return;
			}
			default: {
				markUnknownForColumns(conj, accs, attrIndex);
				return;
			}
		}
	}
	if (conj instanceof BetweenNode) {
		if (conj.expression.not === true) {
			markUnknownForColumns(conj, accs, attrIndex);
			return;
		}
		const col = columnOf(conj.expr, attrIndex);
		const lo = literalOf(conj.lower);
		const hi = literalOf(conj.upper);
		if (col === undefined || lo === undefined || hi === undefined || lo === null || hi === null) {
			markUnknownForColumns(conj, accs, attrIndex);
			return;
		}
		const acc = getOrCreate(accs, col);
		tightenLower(acc, lo, true, col, cmp);
		tightenUpper(acc, hi, true, col, cmp);
		return;
	}
	if (conj instanceof InNode) {
		// Only literal-only IN-lists with a column-reference condition can
		// contribute to the enum/intersection reasoning.
		if (conj.source !== undefined) {
			markUnknownForColumns(conj, accs, attrIndex);
			return;
		}
		const col = columnOf(conj.condition, attrIndex);
		if (col === undefined) {
			// Non-column LHS (e.g. `(a + b) IN (...)`) — out of scope.
			markUnknownForColumns(conj, accs, attrIndex);
			return;
		}
		if (!conj.values || conj.values.length === 0) {
			// `x IN ()` is always false → empty allowedValues forces the decision
			// loop's `filtered.length === 0` step to return `unsat`.
			intersectAllowed(getOrCreate(accs, col), [], col, cmp);
			return;
		}
		const values: SqlValue[] = [];
		for (const v of conj.values) {
			const lit = literalOf(v);
			if (lit === undefined) {
				markUnknownForColumns(conj, accs, attrIndex);
				return;
			}
			values.push(lit);
		}
		intersectAllowed(getOrCreate(accs, col), values, col, cmp);
		return;
	}
	if (conj instanceof UnaryOpNode) {
		// `IS NULL` / `IS NOT NULL` / `NOT (...)` — out of scope for v1.
		markUnknownForColumns(conj, accs, attrIndex);
		return;
	}
	// Anything else: literal-bool / CASE / function call / etc.
	markUnknownForColumns(conj, accs, attrIndex);
}

function absorbBinary(
	conj: BinaryOpNode,
	op: string,
	accs: Map<number, ColumnAccumulator>,
	attrIndex: (attrId: number) => number | undefined,
	cmp: (a: SqlValue, b: SqlValue, col: number) => number,
): void {
	// Normalize `lit op col` → `col flipped lit`.
	let col = columnOf(conj.left, attrIndex);
	let lit = literalOf(conj.right);
	let normOp = op;
	if (col === undefined) {
		col = columnOf(conj.right, attrIndex);
		lit = literalOf(conj.left);
		normOp = flipComparison(op);
	}
	if (col === undefined || lit === undefined) {
		markUnknownForColumns(conj, accs, attrIndex);
		return;
	}
	// NULL literal in a comparison → result is NULL/UNKNOWN; treat as
	// out-of-scope. Domain reasoning here would over-conclude unsat.
	if (lit === null) {
		markUnknownForColumns(conj, accs, attrIndex);
		return;
	}
	const acc = getOrCreate(accs, col);
	switch (normOp) {
		case '=':
		case '==':
			tightenLower(acc, lit, true, col, cmp);
			tightenUpper(acc, lit, true, col, cmp);
			intersectAllowed(acc, [lit], col, cmp);
			return;
		case '!=':
		case '<>':
			if (acc.excluded.length < MAX_VALUES_PER_COL) {
				if (!containsValue(acc.excluded, lit, col, cmp)) acc.excluded.push(lit);
			} else {
				acc.sawUnknown = true;
			}
			return;
		case '<':
			tightenUpper(acc, lit, false, col, cmp);
			return;
		case '<=':
			tightenUpper(acc, lit, true, col, cmp);
			return;
		case '>':
			tightenLower(acc, lit, false, col, cmp);
			return;
		case '>=':
			tightenLower(acc, lit, true, col, cmp);
			return;
		default:
			markUnknownForColumns(conj, accs, attrIndex);
			return;
	}
}

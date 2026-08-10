/**
 * Extract FDs, equivalence classes, constant bindings, and column-domain bounds
 * from declared CHECK constraints. The recognized AST shapes are syntactic and
 * decompose across `AND` conjunctions; disjunctions, NOT, subqueries, and any
 * call to a function the supplied `isDeterministic` predicate rejects are
 * conservatively skipped.
 *
 * See ticket `1-optimizer-check-derived-fds-and-domains` for the recognized
 * shape table; consumers wire the result into a TableReferenceNode's physical
 * properties via `fd-utils` helpers.
 */

import type { ConstantBinding, DomainConstraint, FunctionalDependency, GuardClause, GuardPredicate } from '../nodes/plan-node.js';
import type { RowConstraintSchema, TableSchema } from '../../schema/table.js';
import { RowOpFlag } from '../../schema/table.js';
import type { CapabilityProvider } from '../../vtab/capabilities.js';
import type * as AST from '../../parser/ast.js';
import type { SqlValue } from '../../common/types.js';
import { columnIndexFromExpr, literalValue, collectColumnNames, flattenDisjunction, flipComparison, walkAstNodes } from './predicate-shape.js';
import { isValueDiscriminatingAstComparison, type DeclaredColumnInfo } from './comparison-collation.js';
import { semanticOrderingsAgree } from '../../util/comparison.js';

export interface CheckExtraction {
	readonly fds: ReadonlyArray<FunctionalDependency>;
	readonly equivPairs: ReadonlyArray<readonly [number, number]>;
	readonly constantBindings: ReadonlyArray<ConstantBinding>;
	readonly domainConstraints: ReadonlyArray<DomainConstraint>;
}

/**
 * Walk each CHECK constraint and emit FD/EC/binding/domain contributions.
 * `columnIndexMap` is the table's name → index map (lowercase keys).
 * `isDeterministic` returns true when the named function with `argc` arguments
 * is registered as deterministic. Constraints invoking any non-deterministic
 * function are skipped wholesale.
 */
/**
 * Cached schema-keyed view: schema validation already rejects non-deterministic
 * functions in CHECK expressions, so we use `() => true` here. Replaced when
 * the schema manager swaps the schema instance (ALTER TABLE), since the cache
 * is keyed by reference.
 */
const cache = new WeakMap<TableSchema, CheckExtraction>();

const allDeterministic = (): boolean => true;

/**
 * Raw (capability-blind) CHECK extraction. **Module-internal**: every external
 * consumer must go through {@link getTrustedCheckExtraction} so the
 * `permitsGrandfatheredCheckViolators` gate cannot be forgotten. Not exported.
 */
function getCheckExtraction(tableSchema: TableSchema): CheckExtraction {
	let cached = cache.get(tableSchema);
	if (!cached) {
		cached = extractCheckConstraints(
			tableSchema.checkConstraints,
			tableSchema.columnIndexMap,
			allDeterministic,
			tableSchema.columns,
		);
		cache.set(tableSchema, cached);
	}
	return cached;
}

/** Shared empty {@link CheckExtraction} returned when the capability gate in
 *  {@link getTrustedCheckExtraction} suppresses the CHECK contribution lift. */
export const EMPTY_CHECK_EXTRACTION: CheckExtraction = {
	fds: [],
	equivPairs: [],
	constantBindings: [],
	domainConstraints: [],
};

/**
 * Capability-gated accessor over {@link getCheckExtraction}: returns
 * {@link EMPTY_CHECK_EXTRACTION} when the table's owning vtab module declares
 * `permitsGrandfatheredCheckViolators` (see `vtab/capabilities.ts`). Under that
 * contract `ALTER TABLE … ADD CHECK` against non-conforming rows succeeds and
 * grandfathers the violators, so a declared CHECK is not a universal invariant
 * over the current row set — any consumer that treats the extraction as a
 * row-set fact (physical-property lift, lens-prover domain enumeration) must
 * go through this accessor rather than `getCheckExtraction` directly.
 *
 * `vtabModule` defaults to the schema's own module reference. Logical tables
 * (lens-slot specs) carry no module and are never gated. Pass the module
 * explicitly at sites that resolve it independently of the schema (e.g.
 * `TableReferenceNode`, which is constructed with its module).
 */
export function getTrustedCheckExtraction(
	tableSchema: TableSchema,
	vtabModule: CapabilityProvider | undefined = tableSchema.vtabModule,
): CheckExtraction {
	const permitsViolators = vtabModule?.getCapabilities?.().permitsGrandfatheredCheckViolators === true;
	return permitsViolators ? EMPTY_CHECK_EXTRACTION : getCheckExtraction(tableSchema);
}

/**
 * `columns` carries each column's declared collation + logical type (indexed
 * by column position; `ColumnSchema` is assignable) for the value-discrimination
 * gate: a value-level fact (FD / EC / binding / domain) is minted only when
 * the enforcement comparison it derives from is value-discriminating
 * ({@link isValueDiscriminatingAstComparison}) — non-BINARY collations over
 * textual operands pass value-different rows, so their facts would over-claim.
 */
export function extractCheckConstraints(
	checks: ReadonlyArray<RowConstraintSchema>,
	columnIndexMap: ReadonlyMap<string, number>,
	isDeterministic: (fnName: string, argc: number) => boolean,
	columns: ReadonlyArray<DeclaredColumnInfo>,
): CheckExtraction {
	const fds: FunctionalDependency[] = [];
	const equivPairs: Array<readonly [number, number]> = [];
	const constantBindings: ConstantBinding[] = [];
	const domainConstraints: DomainConstraint[] = [];

	for (const check of checks) {
		if (!check.expr) continue;
		if (!isRowInvariantCheck(check)) continue;
		if (containsNonDeterministicCall(check.expr, isDeterministic)) continue;
		walkConjunction(check.expr, columnIndexMap, columns, fds, equivPairs, constantBindings, domainConstraints);
	}

	return { fds, equivPairs, constantBindings, domainConstraints };
}

/**
 * Row-invariant gate: a CHECK only contributes value facts when every stored
 * row image is guaranteed to satisfy it — i.e. it is enforced on every path a
 * row can enter the table. Two check-level legs, both required (they describe
 * when the whole check runs):
 *
 * 1. The operation mask covers both INSERT and UPDATE. Enforcement filters by
 *    `shouldCheckConstraint(constraint, operation)` (constraint-builder.ts),
 *    so e.g. a `check on insert (...)` never runs on UPDATE and an UPDATE can
 *    legally store a violating row. DELETE membership is irrelevant — a
 *    delete adds no row image. ALTER ADD CHECK backfill validation plus the
 *    `permitsGrandfatheredCheckViolators` consumer gate cover the
 *    pre-existing-rows path for qualifying checks.
 *
 * 2. Not deferred. A deferred check is enforced at commit, so
 *    same-transaction reads can observe violating rows. No SQL today can set
 *    these flags on a stored table CHECK (the parser rejects DEFERRABLE on
 *    CHECK constraints); this leg is defensive against hand-built or future
 *    schemas.
 *
 * The third leg — no `old.<col>` row-image reference — is screened
 * per-AND-conjunct inside {@link walkConjunction} rather than here:
 * `old.a = b` is a transition constraint over the previous row image, not a
 * predicate on stored rows — and OLD is registered nullable / NULL on the
 * INSERT path, so even a default-mask `check (old.a = b)` admits rows
 * violating the same-row reading. But under SQL ternary logic `C1 AND C2` is
 * FALSE whenever C2 is FALSE regardless of C1, so each `old.`-free conjunct
 * independently holds over stored rows and may extract normally even when a
 * sibling conjunct references OLD. The per-conjunct argument does NOT extend
 * through OR — an `old.` ref anywhere inside a non-AND conjunct (e.g. one
 * disjunct of an implication form) kills that whole conjunct.
 * `new.<col>` stays allowed: NEW is the stored row image, so NEW-qualified
 * references are same-row (see `columnIndexFromExpr`, whose bare-name
 * resolution deliberately tolerates the qualifier).
 */
function isRowInvariantCheck(check: RowConstraintSchema): boolean {
	const requiredOps = RowOpFlag.INSERT | RowOpFlag.UPDATE;
	if ((check.operations & requiredOps) !== requiredOps) return false;
	return !(check.deferrable || check.initiallyDeferred);
}

/**
 * True when any node in `expr`'s subtree is a column reference qualified with
 * the `old` row-image marker (`old.a` parses as
 * `ColumnExpr { name: 'a', table: 'old' }`). `walkAstNodes` discovers children
 * reflectively, so guard disjuncts, compound operands, between bounds, and
 * in-lists are all covered — so an `old.` ref inside any non-AND structure
 * (OR disjunct, BETWEEN bound, IN list, compound operand) screens out the
 * entire conjunct it appears in. Conservative edge: a table literally named
 * `old` using self-qualified `old.col` refs also matches — sound, since the
 * enforcement scope keys `old.<col>` to the OLD image there too.
 */
function containsOldRowImageRef(expr: AST.Expression): boolean {
	for (const node of walkAstNodes(expr)) {
		if (node.type === 'column' && (node as AST.ColumnExpr).table?.toLowerCase() === 'old') {
			return true;
		}
	}
	return false;
}

function walkConjunction(
	expr: AST.Expression,
	columnIndexMap: ReadonlyMap<string, number>,
	columns: ReadonlyArray<DeclaredColumnInfo>,
	fds: FunctionalDependency[],
	equivPairs: Array<readonly [number, number]>,
	constantBindings: ConstantBinding[],
	domainConstraints: DomainConstraint[],
): void {
	const stack: AST.Expression[] = [expr];
	while (stack.length > 0) {
		const cur = stack.pop()!;
		if (cur.type === 'binary' && (cur as AST.BinaryExpr).operator === 'AND') {
			const b = cur as AST.BinaryExpr;
			stack.push(b.left, b.right);
			continue;
		}
		// Per-conjunct `old.`-screen: a conjunct referencing the OLD row image is
		// a transition constraint, not a stored-row invariant — skip it while
		// letting sibling conjuncts extract (see isRowInvariantCheck doc).
		if (containsOldRowImageRef(cur)) continue;
		recognize(cur, columnIndexMap, columns, fds, equivPairs, constantBindings, domainConstraints);
	}
}

function recognize(
	expr: AST.Expression,
	columnIndexMap: ReadonlyMap<string, number>,
	columns: ReadonlyArray<DeclaredColumnInfo>,
	fds: FunctionalDependency[],
	equivPairs: Array<readonly [number, number]>,
	constantBindings: ConstantBinding[],
	domainConstraints: DomainConstraint[],
): void {
	if (expr.type === 'binary') {
		const b = expr as AST.BinaryExpr;
		switch (b.operator) {
			case '=':
			case '==': {
				handleEquality(b.left, b.right, columnIndexMap, columns, fds, equivPairs, constantBindings);
				return;
			}
			case '<':
			case '<=':
			case '>':
			case '>=': {
				handleInequality(b, columnIndexMap, columns, domainConstraints);
				return;
			}
			case 'OR': {
				handleImplication(b, columnIndexMap, columns, fds);
				return;
			}
			default:
				return;
		}
	}
	if (expr.type === 'between') {
		const bt = expr as AST.BetweenExpr;
		if (bt.not) return;
		const colIdx = columnIndexFromExpr(bt.expr, columnIndexMap);
		if (colIdx === undefined) return;
		const lo = literalValue(bt.lower);
		const hi = literalValue(bt.upper);
		if (lo === undefined || hi === undefined) return;
		// Per-bound gate, mirroring emitBetween's per-bound collation resolution.
		if (!isValueDiscriminatingAstComparison(bt.expr, bt.lower, columnIndexMap, columns)
			|| !isValueDiscriminatingAstComparison(bt.expr, bt.upper, columnIndexMap, columns)) return;
		domainConstraints.push({
			kind: 'range',
			column: colIdx,
			min: lo,
			max: hi,
			minInclusive: true,
			maxInclusive: true,
		});
		return;
	}
	if (expr.type === 'in') {
		const inExpr = expr as AST.InExpr;
		if (!inExpr.values || inExpr.subquery) return;
		const colIdx = columnIndexFromExpr(inExpr.expr, columnIndexMap);
		if (colIdx === undefined) return;
		const values: SqlValue[] = [];
		for (const v of inExpr.values) {
			const lit = literalValue(v);
			if (lit === undefined) return;
			// Per-value gate (conservative: emitIn resolves the condition operand's
			// collation, but textuality of each listed value participates in the
			// non-textual escape).
			if (!isValueDiscriminatingAstComparison(inExpr.expr, v, columnIndexMap, columns)) return;
			values.push(lit);
		}
		if (values.length === 0) return;
		domainConstraints.push({ kind: 'enum', column: colIdx, values });
		return;
	}
}

/**
 * Semantic-ordering gate for a **cross-column** CHECK-derived fact (invariant
 * OPT-051): a mixed pair such as `d timespan` / `s text` shares no notion of
 * "same value" — `check (d = s)` accepts a row holding 'PT1H' and 'PT60M', so
 * mirror FDs, an equivalence pair, or a one-way determination between them are
 * all false. Admits only "neither side semantic" or "both the SAME semantic
 * type". An absent `logicalType` counts as non-semantic. Reasoning:
 * `docs/optimizer-fd.md` § "Semantic-ordering gate on cross-column facts".
 *
 * Deliberately local rather than shared with the three plan-node call sites of
 * {@link semanticOrderingsAgree} — those work on `ScalarPlanNode`, this one on
 * declared column metadata, the same split the collation gate carries
 * (`isValueDiscriminatingEquality` / `isValueDiscriminatingAstComparison`).
 */
function columnPairSemanticsAgree(
	a: number,
	b: number,
	columns: ReadonlyArray<DeclaredColumnInfo>,
): boolean {
	return semanticOrderingsAgree(columns[a]?.logicalType, columns[b]?.logicalType);
}

function handleEquality(
	left: AST.Expression,
	right: AST.Expression,
	columnIndexMap: ReadonlyMap<string, number>,
	columns: ReadonlyArray<DeclaredColumnInfo>,
	fds: FunctionalDependency[],
	equivPairs: Array<readonly [number, number]>,
	constantBindings: ConstantBinding[],
): void {
	// Value-discrimination gate: all three recognized shapes (col=col mirror
	// FDs + EC pair, col=lit pin + binding, single-column col=expr one-way FD)
	// are value-level claims over the enforcement comparison.
	if (!isValueDiscriminatingAstComparison(left, right, columnIndexMap, columns)) return;

	const lIdx = columnIndexFromExpr(left, columnIndexMap);
	const rIdx = columnIndexFromExpr(right, columnIndexMap);

	// All CHECK-derived FDs are `kind: 'determination'` — a CHECK constrains
	// values, never row counts, so it can never witness row-uniqueness.
	if (lIdx !== undefined && rIdx !== undefined) {
		if (lIdx === rIdx) return;
		// Cross-column fact — gated on semantic ordering (OPT-051).
		if (!columnPairSemanticsAgree(lIdx, rIdx, columns)) return;
		fds.push({ determinants: [lIdx], dependents: [rIdx], kind: 'determination' });
		fds.push({ determinants: [rIdx], dependents: [lIdx], kind: 'determination' });
		equivPairs.push([lIdx, rIdx]);
		return;
	}

	if (lIdx !== undefined) {
		const lit = literalValue(right);
		if (lit !== undefined) {
			// Constant pin — deliberately UNGATED: it claims only that the column
			// compares equal to the literal under its own comparison (OPT-051).
			fds.push({ determinants: [], dependents: [lIdx], kind: 'determination' });
			constantBindings.push({ attrs: [lIdx], value: { kind: 'literal', value: lit } });
			return;
		}
		const cols = collectColumnNames(right, columnIndexMap);
		if (cols.size === 1) {
			const [singleCol] = cols;
			// Cross-column determination — same gate (OPT-051).
			if (singleCol !== lIdx && columnPairSemanticsAgree(singleCol, lIdx, columns)) {
				fds.push({ determinants: [singleCol], dependents: [lIdx], kind: 'determination' });
			}
		}
		return;
	}

	if (rIdx !== undefined) {
		const lit = literalValue(left);
		if (lit !== undefined) {
			fds.push({ determinants: [], dependents: [rIdx], kind: 'determination' });
			constantBindings.push({ attrs: [rIdx], value: { kind: 'literal', value: lit } });
			return;
		}
		const cols = collectColumnNames(left, columnIndexMap);
		if (cols.size === 1) {
			const [singleCol] = cols;
			if (singleCol !== rIdx && columnPairSemanticsAgree(singleCol, rIdx, columns)) {
				fds.push({ determinants: [singleCol], dependents: [rIdx], kind: 'determination' });
			}
		}
	}
}

function handleInequality(
	b: AST.BinaryExpr,
	columnIndexMap: ReadonlyMap<string, number>,
	columns: ReadonlyArray<DeclaredColumnInfo>,
	domainConstraints: DomainConstraint[],
): void {
	// A text-typed range under a non-BINARY enforcement collation over-claims
	// (consumers compare domain bounds under BINARY) — same gate as equalities.
	if (!isValueDiscriminatingAstComparison(b.left, b.right, columnIndexMap, columns)) return;

	// Normalize so the column is on the left.
	const lIdx = columnIndexFromExpr(b.left, columnIndexMap);
	const rIdx = columnIndexFromExpr(b.right, columnIndexMap);

	let colIdx: number | undefined;
	let lit: SqlValue | undefined;
	let op: string;

	if (lIdx !== undefined) {
		lit = literalValue(b.right);
		colIdx = lIdx;
		op = b.operator;
	} else if (rIdx !== undefined) {
		lit = literalValue(b.left);
		colIdx = rIdx;
		op = flipComparison(b.operator);
	} else {
		return;
	}

	if (lit === undefined || colIdx === undefined) return;

	switch (op) {
		case '>=':
			domainConstraints.push({ kind: 'range', column: colIdx, min: lit, minInclusive: true, maxInclusive: false });
			return;
		case '>':
			domainConstraints.push({ kind: 'range', column: colIdx, min: lit, minInclusive: false, maxInclusive: false });
			return;
		case '<=':
			domainConstraints.push({ kind: 'range', column: colIdx, max: lit, minInclusive: false, maxInclusive: true });
			return;
		case '<':
			domainConstraints.push({ kind: 'range', column: colIdx, max: lit, minInclusive: false, maxInclusive: false });
			return;
	}
}

/**
 * Recognize an implication-form CHECK: `(¬g_1) OR (¬g_2) OR ... OR (body)`.
 *
 * All but the last disjunct must parse as a negated equality / is-null clause
 * (e.g. `status <> 'active'`, `a is not null`); the last is the implied body,
 * recognized as a guarded equality only. Bails out (skipping the whole CHECK)
 * if any preceding disjunct is not a recognized guard-negation shape.
 *
 * Domain contributions are NOT lifted from implication-form CHECKs — a range
 * or enum that holds only under a guard isn't safely consumable until the
 * guard activation path also threads through domains.
 */
function handleImplication(
	root: AST.BinaryExpr,
	columnIndexMap: ReadonlyMap<string, number>,
	columns: ReadonlyArray<DeclaredColumnInfo>,
	fds: FunctionalDependency[],
): void {
	const disjuncts = flattenDisjunction(root);
	if (disjuncts.length < 2) return;

	const guardClauses: GuardClause[] = [];
	for (let i = 0; i < disjuncts.length - 1; i++) {
		const clause = recognizeNegatedGuard(disjuncts[i], columnIndexMap);
		if (!clause) return;
		guardClauses.push(clause);
	}
	if (guardClauses.length === 0) return;

	const body = disjuncts[disjuncts.length - 1];
	const guard: GuardPredicate = { clauses: guardClauses };
	recognizeGuardedBody(body, guard, columnIndexMap, columns, fds);
}

/**
 * Recognize one disjunct as the negation of an equality, is-null, or range
 * shape and return the corresponding guard clause. Returns undefined for any
 * other shape.
 *
 * Patterns recognized:
 *   col <> literal       ⇒ eq-literal {col, literal}
 *   col1 <> col2         ⇒ eq-column {col1, col2}
 *   col IS NOT NULL      ⇒ is-null {col, negated: false}
 *   col IS NULL          ⇒ is-null {col, negated: true}
 *   col <  literal       ⇒ range {col, min: lit, minInc: true,  maxInc: false} (i.e. col >= lit)
 *   col <= literal       ⇒ range {col, min: lit, minInc: false, maxInc: false} (i.e. col >  lit)
 *   col >  literal       ⇒ range {col, max: lit, maxInc: true,  minInc: false} (i.e. col <= lit)
 *   col >= literal       ⇒ range {col, max: lit, maxInc: false, minInc: false} (i.e. col <  lit)
 *
 * `lit op col` shapes are flipped via `flipComparison` so the column ends up
 * on the left before the negation table above is applied. NULL literal
 * bounds are rejected (NULL is not a meaningful comparison anchor).
 */
function recognizeNegatedGuard(
	expr: AST.Expression,
	columnIndexMap: ReadonlyMap<string, number>,
): GuardClause | undefined {
	if (expr.type === 'unary') {
		const u = expr as AST.UnaryExpr;
		if (u.operator === 'IS NULL' || u.operator === 'IS NOT NULL') {
			const col = columnIndexFromExpr(u.expr, columnIndexMap);
			if (col === undefined) return undefined;
			// `col is not null` disjunct ⇒ guard is `col is null` (negated of "is null" is false).
			// Negating `c is not null` gives `c is null`, so the implied guard is `c is null`.
			// In our scheme: { kind: 'is-null', column: c, negated: false } means "guard: c is null".
			return u.operator === 'IS NOT NULL'
				? { kind: 'is-null', column: col, negated: false }
				: { kind: 'is-null', column: col, negated: true };
		}
		return undefined;
	}
	if (expr.type !== 'binary') return undefined;
	const b = expr as AST.BinaryExpr;
	const op = b.operator;
	if (op === '<>' || op === '!=') {
		const lIdx = columnIndexFromExpr(b.left, columnIndexMap);
		const rIdx = columnIndexFromExpr(b.right, columnIndexMap);
		if (lIdx !== undefined && rIdx !== undefined) {
			if (lIdx === rIdx) return undefined;
			return { kind: 'eq-column', left: lIdx, right: rIdx };
		}
		if (lIdx !== undefined) {
			const lit = literalValue(b.right);
			if (lit === undefined) return undefined;
			return { kind: 'eq-literal', column: lIdx, value: lit };
		}
		if (rIdx !== undefined) {
			const lit = literalValue(b.left);
			if (lit === undefined) return undefined;
			return { kind: 'eq-literal', column: rIdx, value: lit };
		}
		return undefined;
	}
	if (op === '<' || op === '<=' || op === '>' || op === '>=') {
		// Normalize so the column is on the left.
		const lIdx = columnIndexFromExpr(b.left, columnIndexMap);
		const rIdx = columnIndexFromExpr(b.right, columnIndexMap);
		let colIdx: number | undefined;
		let lit: SqlValue | undefined;
		let normOp: string;
		if (lIdx !== undefined) {
			lit = literalValue(b.right);
			colIdx = lIdx;
			normOp = op;
		} else if (rIdx !== undefined) {
			lit = literalValue(b.left);
			colIdx = rIdx;
			normOp = flipComparison(op);
		} else {
			return undefined;
		}
		if (lit === undefined || lit === null || colIdx === undefined) return undefined;
		switch (normOp) {
			case '<':
				return { kind: 'range', column: colIdx, min: lit, minInclusive: true, maxInclusive: false };
			case '<=':
				return { kind: 'range', column: colIdx, min: lit, minInclusive: false, maxInclusive: false };
			case '>':
				return { kind: 'range', column: colIdx, max: lit, maxInclusive: true, minInclusive: false };
			case '>=':
				return { kind: 'range', column: colIdx, max: lit, maxInclusive: false, minInclusive: false };
		}
		return undefined;
	}
	return undefined;
}

/**
 * Recognize the body of an implication-form CHECK as a guarded equality. We
 * accept the equality shapes that `handleEquality` accepts, but emit the
 * resulting FDs with the supplied `guard` attached and do NOT contribute
 * equivalence pairs or constant bindings — equivalences/bindings are
 * unconditional facts.
 */
function recognizeGuardedBody(
	body: AST.Expression,
	guard: GuardPredicate,
	columnIndexMap: ReadonlyMap<string, number>,
	columns: ReadonlyArray<DeclaredColumnInfo>,
	fds: FunctionalDependency[],
): void {
	if (body.type !== 'binary') return;
	const b = body as AST.BinaryExpr;
	if (b.operator !== '=' && b.operator !== '==') return;

	// Same value-discrimination gate as unconditional equalities — especially
	// load-bearing for the `valueEquality: true` mirror tags, which the Filter
	// guard-activation path lifts into ECs. Guard *scopes* (recognizeNegatedGuard)
	// are deliberately ungated: enforcement evaluates them under declared
	// collations (Part A of ticket check-extraction-collation-blind-fds), and
	// the discharge gate in `buildPredicateFacts` keeps filter rows within the
	// declared-collation guard scope.
	if (!isValueDiscriminatingAstComparison(b.left, b.right, columnIndexMap, columns)) return;

	const lIdx = columnIndexFromExpr(b.left, columnIndexMap);
	const rIdx = columnIndexFromExpr(b.right, columnIndexMap);

	// Guarded CHECK-derived FDs are `kind: 'determination'` like their
	// unconditional twins — an implication-form CHECK still constrains values
	// only, never row counts.
	if (lIdx !== undefined && rIdx !== undefined) {
		if (lIdx === rIdx) return;
		// Cross-column fact — gated on semantic ordering (OPT-051). Load-bearing
		// for the `valueEquality` tag below: `FilterNode.computePhysical` lifts a
		// tagged mirror pair into an equivalence class once the guard discharges,
		// and re-closes constant bindings over it, so a mixed pair would pin the
		// text column to a spelling no row stores.
		if (!columnPairSemanticsAgree(lIdx, rIdx, columns)) return;
		// Tag the mirror pair as a genuine column value-equality so a downstream
		// guard-activation (FilterNode) can soundly lift it as an EC — a one-way
		// `col = expr` body (below) or an index-derived guarded mirror is NOT
		// tagged and is never lifted (ticket fd-guarded-activation-key-bag-overclaim).
		fds.push({ determinants: [lIdx], dependents: [rIdx], guard, valueEquality: true, kind: 'determination' });
		fds.push({ determinants: [rIdx], dependents: [lIdx], guard, valueEquality: true, kind: 'determination' });
		return;
	}

	if (lIdx !== undefined) {
		const lit = literalValue(b.right);
		if (lit !== undefined) {
			// Guarded constant pin — ungated, same reason as its unconditional twin.
			fds.push({ determinants: [], dependents: [lIdx], guard, kind: 'determination' });
			return;
		}
		const cols = collectColumnNames(b.right, columnIndexMap);
		if (cols.size === 1) {
			const [singleCol] = cols;
			// Cross-column determination — same gate (OPT-051).
			if (singleCol !== lIdx && columnPairSemanticsAgree(singleCol, lIdx, columns)) {
				fds.push({ determinants: [singleCol], dependents: [lIdx], guard, kind: 'determination' });
			}
		}
		return;
	}

	if (rIdx !== undefined) {
		const lit = literalValue(b.left);
		if (lit !== undefined) {
			fds.push({ determinants: [], dependents: [rIdx], guard, kind: 'determination' });
			return;
		}
		const cols = collectColumnNames(b.left, columnIndexMap);
		if (cols.size === 1) {
			const [singleCol] = cols;
			if (singleCol !== rIdx && columnPairSemanticsAgree(singleCol, rIdx, columns)) {
				fds.push({ determinants: [singleCol], dependents: [rIdx], guard, kind: 'determination' });
			}
		}
	}
}

/**
 * True when `expr` calls any function for which `isDeterministic(name, argc)`
 * returns false, or contains a subquery. Used to skip whole CHECK expressions
 * that we cannot reason about safely.
 */
export function containsNonDeterministicCall(
	expr: AST.Expression,
	isDeterministic: (fnName: string, argc: number) => boolean,
): boolean {
	for (const node of walkAstNodes(expr)) {
		if (node.type === 'subquery' || node.type === 'exists') return true;
		if (node.type === 'function') {
			const fn = node as AST.FunctionExpr;
			const argc = fn.args?.length ?? 0;
			if (!isDeterministic(fn.name, argc)) return true;
		}
	}
	return false;
}

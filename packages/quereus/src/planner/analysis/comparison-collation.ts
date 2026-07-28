/**
 * THE shared resolution of a comparison's *effective collation*. Both the
 * plan-time mirrors (access-path collation-cover analysis, FD/EC gates in
 * `fd-utils.ts`, the predicate normalizer's eq↔IN gate, the constraint
 * extractor's collation gates) and the runtime emitters (`emitComparisonOp`,
 * `emitIn`, `emitBetween`, the USING-join comparator) call through this module,
 * so plan-time facts and runtime behavior cannot drift.
 *
 * ## The resolution lattice
 *
 * Each operand contributes at most one `(collation, rank)`, derived from the
 * provenance of its `ScalarType.collationName` ({@link CollationSource}):
 *
 * | rank | source                                            | BINARY contributes? |
 * |------|---------------------------------------------------|---------------------|
 * | 3    | `explicit` — a COLLATE expression                 | yes (`collate binary` is a real demand) |
 * | 2    | `declared` — column with an explicit COLLATE      | yes (`c text collate binary` is a real preference) |
 * | 1    | `default` — defaulted column collation            | **no** — a defaulted BINARY is the engine floor |
 * | —    | no `collationName` (literals, most expressions)   | n/a |
 *
 * Resolution of `left <op> right` is **symmetric** (`a = b` ≡ `b = a`):
 * 1. The highest rank present among the two contributions wins.
 * 2. If both operands contribute at that rank with *different* normalized
 *    names: rank 3 or 2 → plan-time error ({@link collationConflictError});
 *    rank 1 → BINARY, silently (defaults are preferences, not declarations).
 * 3. Otherwise the winning (single, or name-identical) contribution's name;
 *    no contributions at all → BINARY.
 *
 * This deliberately diverges from SQLite's left-operand precedence: the engine
 * follows explicit-over-implicit semantics and keeps comparisons commutative.
 * See `docs/types.md` § Comparison collation resolution.
 */

import type { ScalarPlanNode } from '../nodes/plan-node.js';
import type { InNode } from '../nodes/subquery.js';
import type * as AST from '../../parser/ast.js';
import type { ScalarType, CollationSource } from '../../common/datatype.js';
import type { LogicalType } from '../../types/logical-type.js';
import { normalizeCollationName } from '../../util/comparison.js';
import { PhysicalType } from '../../types/logical-type.js';
import { collectCollateNames, collectColumnNames, columnIndexFromExpr } from './predicate-shape.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';

export type { CollationSource } from '../../common/datatype.js';

/** The `(normalized name, rank)` one operand contributes to a comparison. */
export interface CollationContribution {
	readonly name: string;
	readonly rank: 3 | 2 | 1;
}

const RANK_BY_SOURCE: Record<CollationSource, 3 | 2 | 1> = { explicit: 3, declared: 2, default: 1 };
const SOURCE_BY_RANK: Record<3 | 2 | 1, CollationSource> = { 3: 'explicit', 2: 'declared', 1: 'default' };

/**
 * The contribution one operand's type makes to a comparison, or `undefined`
 * when it makes none (no `collationName`, or a defaulted BINARY — the engine
 * floor is not a preference). An absent `collationSource` with a present
 * `collationName` is treated as `'default'` (the safe floor for any
 * construction site the provenance sweep missed).
 */
export function collationContribution(t: ScalarType): CollationContribution | undefined {
	if (t.collationName === undefined) return undefined;
	const rank = RANK_BY_SOURCE[t.collationSource ?? 'default'];
	const name = normalizeCollationName(t.collationName);
	if (rank === 1 && name === 'BINARY') return undefined;
	return { name, rank };
}

/** Outcome of resolving two contributions: a single collation, or a same-rank conflict. */
export type CollationResolution =
	| { kind: 'resolved'; name: string }
	| { kind: 'conflict'; level: 'explicit' | 'declared'; left: string; right: string };

const RESOLVED_BINARY: CollationResolution = { kind: 'resolved', name: 'BINARY' };

function resolveContributions(
	l: CollationContribution | undefined,
	r: CollationContribution | undefined,
): CollationResolution {
	if (!l && !r) return RESOLVED_BINARY;
	if (!l) return { kind: 'resolved', name: r!.name };
	if (!r) return { kind: 'resolved', name: l.name };
	if (l.rank !== r.rank) return { kind: 'resolved', name: (l.rank > r.rank ? l : r).name };
	if (l.name === r.name) return { kind: 'resolved', name: l.name };
	// Same-rank, different names. Defaults resolve to the floor silently;
	// explicit/declared conflicts are user errors.
	if (l.rank === 1) return RESOLVED_BINARY;
	return { kind: 'conflict', level: l.rank === 3 ? 'explicit' : 'declared', left: l.name, right: r.name };
}

/**
 * Effective collation of a binary comparison `left <op> right` under the
 * lattice. Pure — never throws; conflicts are returned for the caller to
 * surface (plan-time validation) or gate on (the predicate normalizer).
 */
export function resolveComparisonCollation(left: ScalarType, right: ScalarType): CollationResolution {
	return resolveContributions(collationContribution(left), collationContribution(right));
}

/** Build the plan-time error for a same-rank explicit/declared conflict. */
export function collationConflictError(
	conflict: Extract<CollationResolution, { kind: 'conflict' }>,
	expr?: AST.Expression,
): QuereusError {
	const message = conflict.level === 'explicit'
		? `conflicting COLLATE clauses in comparison: ${conflict.left} vs ${conflict.right}`
		: `ambiguous collation for comparison: column collations ${conflict.left} vs ${conflict.right} differ; apply an explicit COLLATE`;
	return new QuereusError(message, StatusCode.ERROR, undefined, expr?.loc?.start.line, expr?.loc?.start.column);
}

function resolvedOrThrow(res: CollationResolution, expr?: AST.Expression): string {
	if (res.kind === 'conflict') throw collationConflictError(res, expr);
	return res.name;
}

/**
 * Throwing form of {@link resolveComparisonCollation} over bare types, for
 * sites that hold types rather than plan nodes (the USING-join emitter). The
 * throw is a backstop — plan-time validation rejects user-written conflicts.
 */
export function effectiveCollationOfTypes(left: ScalarType, right: ScalarType, expr?: AST.Expression): string {
	return resolvedOrThrow(resolveComparisonCollation(left, right), expr);
}

/**
 * Effective collation of a binary comparison `left <op> right`. Symmetric —
 * operand order never changes the result. Throws `QuereusError` on a
 * same-rank explicit/declared conflict (normally unreachable past plan-time
 * validation in `BinaryOpNode.generateType`).
 */
export function effectiveComparisonCollation(
	left: ScalarPlanNode,
	right: ScalarPlanNode,
	expr?: AST.Expression,
): string {
	return effectiveCollationOfTypes(left.getType(), right.getType(), expr);
}

/**
 * Effective collation of one BETWEEN bound comparison. BETWEEN desugars to
 * `expr >= lower AND expr <= upper`; each bound resolves independently through
 * the same lattice (two independent comparisons — differing bound collations
 * are NOT a conflict with each other, only with the tested expression).
 */
export function effectiveBetweenBoundCollation(expr: ScalarPlanNode, bound: ScalarPlanNode): string {
	return effectiveCollationOfTypes(expr.getType(), bound.getType());
}

/**
 * Order-independent merge of many contributions (IN right-hand sides, CASE
 * branches, concat operands): the highest rank present wins; distinct names at
 * that rank are a conflict (resolved per-call-site: error for IN at rank ≥ 2,
 * no-contribution otherwise).
 */
type ContributionMerge =
	| { kind: 'contribution'; contribution: CollationContribution | undefined }
	| { kind: 'conflict'; level: 'explicit' | 'declared'; left: string; right: string };

function mergeContributions(contribs: ReadonlyArray<CollationContribution | undefined>): ContributionMerge {
	let best: CollationContribution | undefined;
	let conflictingName: string | undefined;
	for (const c of contribs) {
		if (!c) continue;
		if (!best || c.rank > best.rank) {
			best = c;
			conflictingName = undefined;
			continue;
		}
		if (c.rank === best.rank && c.name !== best.name && conflictingName === undefined) {
			conflictingName = c.name;
		}
	}
	if (best && conflictingName !== undefined) {
		if (best.rank === 1) return { kind: 'contribution', contribution: undefined };
		return { kind: 'conflict', level: best.rank === 3 ? 'explicit' : 'declared', left: best.name, right: conflictingName };
	}
	return { kind: 'contribution', contribution: best };
}

/**
 * Pure IN resolution: merge the right-hand-side contributions first (list
 * elements under the lattice — a rank-3/2 name conflict among elements is the
 * same plan-time error; rank-1 conflicts merge to no-contribution; a subquery
 * RHS contributes its single output column's contribution), then resolve
 * condition-vs-RHS. Literal-only lists contribute nothing, preserving
 * condition-driven behavior for the dominant case.
 */
export function resolveInCollation(condition: ScalarType, rhs: ReadonlyArray<ScalarType>): CollationResolution {
	const merged = mergeContributions(rhs.map(collationContribution));
	if (merged.kind === 'conflict') {
		return { kind: 'conflict', level: merged.level, left: merged.left, right: merged.right };
	}
	return resolveContributions(collationContribution(condition), merged.contribution);
}

/**
 * Pure N-ary resolution for a group of operands that are all compared against
 * one another (a variadic comparison builtin like `greatest`/`least` ranks
 * every argument): one symmetric merge of every contribution under the lattice —
 * highest rank wins; distinct names at rank ≥ 2 are a single conflict reported
 * with the winning pair; rank-1 disagreement resolves to the BINARY floor
 * silently. For two operands this is exactly
 * {@link resolveComparisonCollation}.
 */
export function resolveGroupCollation(types: ReadonlyArray<ScalarType>): CollationResolution {
	const merged = mergeContributions(types.map(collationContribution));
	if (merged.kind === 'conflict') {
		return { kind: 'conflict', level: merged.level, left: merged.left, right: merged.right };
	}
	return merged.contribution ? { kind: 'resolved', name: merged.contribution.name } : RESOLVED_BINARY;
}

/** Throwing form of {@link resolveGroupCollation}, for emit-time sites. */
export function effectiveGroupCollation(types: ReadonlyArray<ScalarType>, expr?: AST.Expression): string {
	return resolvedOrThrow(resolveGroupCollation(types), expr);
}

/** RHS contribution sources of an InNode: list element types, or the subquery's single output column. */
export function inRhsTypes(node: InNode): ReadonlyArray<ScalarType> {
	if (node.values) return node.values.map(v => v.getType());
	if (node.source) {
		const rel = node.source.getType();
		const col = rel.columns[0];
		return col ? [col.type] : [];
	}
	return [];
}

/** Pure form of {@link effectiveInCollation} — conflicts returned, not thrown. */
export function resolveInCollationForNode(node: InNode): CollationResolution {
	return resolveInCollation(node.condition.getType(), inRhsTypes(node));
}

/**
 * Effective collation of `condition IN (...)`. `emitIn` pre-resolves this ONE
 * collation for the whole membership test (the BTree build keys under it).
 * Throws on conflict (backstop past `InNode.generateType` validation).
 */
export function effectiveInCollation(node: InNode): string {
	return resolvedOrThrow(resolveInCollationForNode(node), node.expression);
}

/**
 * Collation propagated through a non-comparison combiner (`||` concat, CASE
 * branch merge): the highest-ranked contribution wins; equal-rank
 * contributions with the same name keep it; equal-rank contributions with
 * different names propagate **no** collation — the conflict is not an error
 * here (these nodes do not compare), but it must not silently coin-flip; a
 * later comparison over the result then falls back to BINARY. Set-based over
 * the winning rank, so operand/branch order cannot change the result.
 */
export function mergePropagatedCollation(
	types: ReadonlyArray<ScalarType>,
): { collationName?: string; collationSource?: CollationSource } {
	const merged = mergeContributions(types.map(collationContribution));
	if (merged.kind === 'conflict' || merged.contribution === undefined) return {};
	return { collationName: merged.contribution.name, collationSource: SOURCE_BY_RANK[merged.contribution.rank] };
}

/**
 * Per-output-column collation of a set operation (UNION/INTERSECT/EXCEPT/DIFF),
 * merged symmetrically from the two inputs' corresponding column types through
 * the comparison lattice. Mirrors a comparison: a same-rank explicit/declared
 * name conflict is returned for the caller to surface as a plan-time error
 * (DISTINCT operators) or swallow (UNION ALL does no dedup, like `||` / CASE);
 * rank-1 default conflicts resolve to the BINARY floor (no contribution). The
 * winning rank propagates as `collationSource` so the output column carries
 * forward correctly into nested set-ops / outer comparisons.
 */
export type SetOpColumnCollation =
	| { kind: 'resolved'; collationName?: string; collationSource?: CollationSource }
	| { kind: 'conflict'; level: 'explicit' | 'declared'; left: string; right: string };

/**
 * Resolve one set-operation output column's dedup/compare collation across both
 * inputs. Pure — never throws; a conflict is returned for the caller to handle
 * per operator (throw for `union`/`intersect`/`except`; treat as no-collation
 * for `union all`). Semantically `resolveContributions(left, right)` except it
 * keeps the winning contribution's *rank* (as `collationSource`) instead of
 * collapsing to a bare name, so a nested set-op re-resolves at the correct rank.
 */
export function resolveSetOpColumnCollation(left: ScalarType, right: ScalarType): SetOpColumnCollation {
	const merged = mergeContributions([collationContribution(left), collationContribution(right)]);
	if (merged.kind === 'conflict') return { kind: 'conflict', level: merged.level, left: merged.left, right: merged.right };
	const c = merged.contribution;
	return c
		? { kind: 'resolved', collationName: c.name, collationSource: SOURCE_BY_RANK[c.rank] }
		: { kind: 'resolved' };  // BINARY floor — no collationName/collationSource
}

/**
 * Binary operators that compare their operands under a collation, and so must
 * validate the lattice in `generateType`. The parser currently produces only
 * unary `IS [NOT] NULL/TRUE/FALSE` forms — binary `IS`/`IS NOT` are listed so
 * validation comes for free if it ever grows them.
 */
const COMPARISON_OPERATORS = new Set(['=', '==', '!=', '<>', '<', '<=', '>', '>=', 'IS', 'IS NOT']);

export function isComparisonOperator(op: string): boolean {
	return COMPARISON_OPERATORS.has(op.toUpperCase());
}

/**
 * The collation a single operand contributes to a comparison, normalized.
 * `'BINARY'` when the operand's type carries none. Provenance-blind by design:
 * gates that compare an operand's own collation against an effective collation
 * (covered-key detection, equi-pair extraction) care about the *name* the
 * operand resolves under, not its rank.
 */
export function operandCollation(node: ScalarPlanNode): string {
	return normalizeCollationName(node.getType().collationName ?? 'BINARY');
}

/**
 * True when a logical type can never produce a text value at runtime. Exactly
 * the negation of {@link logicalTypeCanHoldText}'s physical-representation
 * allow-list, so `JSON` (physical `OBJECT`), `ANY` and `NULL` (both physical
 * `NULL`) are all potentially textual rather than exempt. An absent type is
 * unknown — potentially textual.
 */
function isNonTextualLogicalType(lt: LogicalType | undefined): boolean {
	return !logicalTypeCanHoldText(lt);
}

/**
 * True when the operand's static type can never produce a text value at
 * runtime.
 */
function isStaticallyNonTextual(node: ScalarPlanNode): boolean {
	return isNonTextualLogicalType(node.getType().logicalType);
}

/**
 * Physical representations that provably never hold a JS string. `OBJECT` is absent on
 * purpose: `JSON_TYPE.parse` passes a JSON scalar string straight through, so a `JSON`
 * value can be the ordinary string `Bob`. So is `NULL` (`ANY`'s representation).
 */
const NEVER_TEXT_PHYSICAL_TYPES: ReadonlySet<PhysicalType> = new Set([
	PhysicalType.INTEGER,
	PhysicalType.REAL,
	PhysicalType.BLOB,
	PhysicalType.BOOLEAN,
]);

/**
 * True when a value of this logical type could be a text string at runtime. Absent
 * type ⇒ unknown ⇒ yes.
 *
 * The gate for "does this key need a key normalizer": key serialization applies a
 * normalizer only to a string value, so a key that can never hold text never consults
 * the collation. Callers outside the planner (the isolation overlay's modified-PK set)
 * hold a `ColumnSchema` rather than a `ScalarType`, hence the split from
 * {@link hashKeyCollationName}.
 */
export function logicalTypeCanHoldText(logicalType: LogicalType | undefined): boolean {
	if (!logicalType) return true;
	if (logicalType.isTextual === true) return true;
	return !NEVER_TEXT_PHYSICAL_TYPES.has(logicalType.physicalType);
}

/**
 * The collation a PK-EQUALITY key normalizer must resolve under for one primary-key
 * column, or `undefined` when the column can never hold text (a key normalizer only
 * ever touches string values, so collation is moot there).
 *
 * A text-capable-but-not-`isTextual` column — `any`, `json`, the temporal types — gets
 * hard-coded `'BINARY'` regardless of its declared collation: PK equality compares
 * through `logicalType.compare` (`createTypedComparator`), which ignores the collation
 * it is handed for every one of those types (ANY and the temporals compare under
 * BINARY_COLLATION; JSON structurally). Keying such a column under its declared
 * collation — say `k any collate nocase` — would bucket `'A'` and `'a'` together even
 * though the comparator that actually orders/equates primary keys treats them as
 * distinct, silently merging two rows into one.
 *
 * Only `isTextual` columns (`text`) apply their own declared collation, since
 * `TEXT_TYPE.compare` is the one comparator that honors it.
 *
 * Mirrors {@link resolvePkKeyCollations} in `quereus-store`, which makes the identical
 * decision for the store's on-disk PK key encoding; the isolation overlay's modified-PK
 * set (`quereus-isolation`) is the other caller, keying overlay rows the same way.
 */
export function pkKeyCollationName(
	column: { logicalType: LogicalType; collation?: string } | undefined
): string | undefined {
	if (!column || !logicalTypeCanHoldText(column.logicalType)) return undefined;
	return column.logicalType.isTextual ? column.collation : 'BINARY';
}

/** True when a value of this type could be a text string at runtime. Absent type ⇒ unknown ⇒ yes. */
function typeCanHoldText(t: ScalarType): boolean {
	return logicalTypeCanHoldText(t.logicalType);
}

/**
 * The collation that actually governs a hash key built from `operandTypes`, or
 * `undefined` when none does — the input for `EmissionContext.resolveKeyNormalizer`.
 *
 * Key serialization applies a normalizer only to a *string* value (`util/key-serializer.ts`
 * tags numerics, blobs, and JSON objects without consulting it), so a key no operand of
 * which can ever hold text never reaches the collation. Demanding a normalizer for such a
 * key would reject a valid query: `group by n` over `n integer collate nocase` buckets by
 * number under any collation, including a comparator-only one. Any operand that *could*
 * hold text keeps the name — dropping it there would silently group by bytes, which is the
 * bug `bug-key-normalizer-ignores-database-collations` fixed.
 *
 * Every operand is checked, not just one, because a join's build and probe sides share a
 * single normalizer array: text on either side must normalize.
 */
export function hashKeyCollationName(
	collationName: string | undefined,
	operandTypes: readonly ScalarType[],
): string | undefined {
	if (!collationName || operandTypes.length === 0) return collationName;
	return operandTypes.some(typeCanHoldText) ? collationName : undefined;
}

/**
 * True iff an equality `left = right` is **value-discriminating**: rows it
 * passes are genuinely value-equal on the compared operands, so the conjunct
 * may mint value-level facts (constant pins `∅ → col`, `col1 = col2` mirror
 * FDs, equivalence classes, constant bindings, join equi-pairs).
 *
 * Rule (the soundness gate from ticket
 * `collation-blind-equality-fact-extraction`):
 *   - non-textual operands: always — collation does not apply to non-text
 *     comparisons (`compareSqlValuesFast` only consults the collation function
 *     for text/text; cross-class comparisons order by storage class);
 *   - textual (or statically unknown) operands: every collation either
 *     operand could contribute must be BINARY. A NOCASE/RTRIM comparison
 *     passes value-DIFFERENT rows ('Bob' = 'bob' NOCASE), so any value-level
 *     fact minted from it over-claims.
 *
 * Both sides are checked (not just `effectiveComparisonCollation`'s lattice
 * winner) so the gate stays robust to per-algorithm resolution-order
 * differences among runtime comparison sites (the merge/bloom join emitters
 * resolve per-key from one side's attribute type). Note this deliberately
 * blocks on a *defaulted* non-BINARY contribution too (session
 * `default_collation`), which the lattice would also resolve to.
 */
export function isValueDiscriminatingEquality(left: ScalarPlanNode, right: ScalarPlanNode): boolean {
	if (operandCollation(left) === 'BINARY' && operandCollation(right) === 'BINARY') return true;
	// A non-BINARY collation is in play; it is inert only when text values can
	// never meet at runtime.
	return isStaticallyNonTextual(left) && isStaticallyNonTextual(right);
}

/**
 * Per-column declared metadata consumed by the schema-level (AST) variant of
 * the value-discrimination gate. `ColumnSchema` is structurally assignable;
 * unit tests construct minimal literals. Absent collation means BINARY; absent
 * logical type means textuality unknown (treated as textual).
 */
export interface DeclaredColumnInfo {
	readonly collation?: string;
	readonly logicalType?: LogicalType;
}

/**
 * The collation(s) and textuality one AST comparison operand contributes,
 * resolved against declared column metadata.
 */
interface AstOperandContribution {
	/** Every collation this operand could contribute to the comparison is BINARY. */
	readonly binary: boolean;
	/** The operand's static type can never produce a text value at runtime. */
	readonly nonTextual: boolean;
}

function astOperandContribution(
	expr: AST.Expression,
	columnIndexMap: ReadonlyMap<string, number>,
	columns: ReadonlyArray<DeclaredColumnInfo>,
): AstOperandContribution {
	const colIdx = columnIndexFromExpr(expr, columnIndexMap);
	if (colIdx !== undefined) {
		const meta = columns[colIdx];
		return {
			binary: normalizeCollationName(meta?.collation ?? 'BINARY') === 'BINARY',
			nonTextual: isNonTextualLogicalType(meta?.logicalType),
		};
	}
	if (expr.type === 'literal') {
		// A bare literal carries no collation. Deferred (Promise) literal values
		// have unknown textuality.
		const v = (expr as AST.LiteralExpr).value;
		return { binary: true, nonTextual: !(v instanceof Promise) && typeof v !== 'string' };
	}
	// Any other expression contributes BINARY only when nothing in its subtree
	// could inject a non-BINARY collation: no non-BINARY COLLATE wrapper, and
	// every column referenced inside is BINARY-declared or non-textual (robust
	// to however collation propagates through planner node types). Textuality
	// of the result is unknown — treat as textual.
	for (const name of collectCollateNames(expr)) {
		if (normalizeCollationName(name) !== 'BINARY') {
			return { binary: false, nonTextual: false };
		}
	}
	for (const idx of collectColumnNames(expr, columnIndexMap)) {
		const meta = columns[idx];
		if (normalizeCollationName(meta?.collation ?? 'BINARY') !== 'BINARY'
			&& !isNonTextualLogicalType(meta?.logicalType)) {
			return { binary: false, nonTextual: false };
		}
	}
	return { binary: true, nonTextual: false };
}

/**
 * Schema-level (AST + declared column metadata) variant of
 * {@link isValueDiscriminatingEquality}, for fact producers that run on raw
 * AST before any plan nodes exist (`check-extraction.ts`, assertion hoist).
 *
 * Mirrors **enforcement** semantics: write-time CHECK / assertion evaluation
 * resolves declared column collations (constraint-builder threads
 * `collationName` into the CHECK scope types) plus explicit COLLATE wrappers —
 * so the comparison a declared constraint actually enforces is
 * value-discriminating exactly when every collation either operand could
 * contribute is BINARY, or both operands are statically non-textual.
 *
 * Used for ALL value-level CHECK contributions — equality facts (FDs, EC
 * pairs, constant pins/bindings) AND domain facts (ranges, BETWEEN, IN enums):
 * a text-typed domain extracted from a non-BINARY enforcement comparison
 * over-claims just like an equality fact (`check (c in ('a','b'))` under
 * NOCASE admits 'A'). Guard *scopes* are not gated here — discharge soundness
 * lives in `buildPredicateFacts`' per-conjunct gate, which assumes guard
 * scopes are evaluated under declared collations (true of enforcement).
 */
export function isValueDiscriminatingAstComparison(
	left: AST.Expression,
	right: AST.Expression,
	columnIndexMap: ReadonlyMap<string, number>,
	columns: ReadonlyArray<DeclaredColumnInfo>,
): boolean {
	const l = astOperandContribution(left, columnIndexMap, columns);
	const r = astOperandContribution(right, columnIndexMap, columns);
	if (l.binary && r.binary) return true;
	return l.nonTextual && r.nonTextual;
}

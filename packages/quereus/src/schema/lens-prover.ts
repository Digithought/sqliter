import type { Database } from '../core/database.js';
import type { SchemaManager } from './manager.js';
import type { TableSchema, UniqueConstraintSchema, DeclaredKeyMatch } from './table.js';
import { resolvePkDefaultConflict, findDeclaredKey, findGoverningBasisKeys } from './table.js';
import type { LensSlot, LogicalConstraint } from './lens.js';
import type * as AST from '../parser/ast.js';
import type { DomainConstraint, FunctionalDependency, GuardClause, GuardPredicate, PlanNode, RelationalPlanNode } from '../planner/nodes/plan-node.js';
import { addFd, superkeyToFd } from '../planner/util/fd-utils.js';
import { proveEffectiveKeyUnique } from '../planner/analysis/coverage-prover.js';
import { resolveBaseSite, type ResolvedBaseSite } from '../planner/analysis/update-lineage.js';
import { viewComplement } from '../planner/analysis/view-complement.js';
import { getTrustedCheckExtraction, containsNonDeterministicCall, type CheckExtraction } from '../planner/analysis/check-extraction.js';
import { createRuntimeExpressionEvaluator } from '../planner/analysis/const-evaluator.js';
import { classifyViewBody } from '../planner/mutation/propagate.js';
import { substituteNewRefs, transformExpr } from '../planner/mutation/scope-transform.js';
import { ProjectNode } from '../planner/nodes/project-node.js';
import { PlanNodeType } from '../planner/nodes/plan-node-type.js';
import { astToString, expressionToString } from '../emit/ast-stringify.js';
import { PhysicalType } from '../types/logical-type.js';
import { getReservedTagByTemplate, LENS_WRITABLE_INTENT_TAG } from './reserved-tags.js';
import type { AcknowledgedAdvisory } from './lens-ack.js';
import { createLogger } from '../common/logger.js';
import { ConflictResolution, FunctionFlags } from '../common/constants.js';
import { compareSqlValues } from '../util/comparison.js';
import type { SqlValue } from '../common/types.js';

const log = createLogger('schema:lens-prover');

/**
 * Lens prover — proves each logical table's compiled body realizes its logical
 * spec, and classifies how every logical constraint becomes real at the lens
 * boundary. It is the second half of "validate, generate, attach": the foundation
 * generated the effective body; this proves it sound and decides the obligation
 * for each constraint.
 *
 * The prover is a **consumer** of the shipped inference surface — it applies
 * `proveEffectiveKeyUnique` (`planner/analysis/coverage-prover.ts`) and the
 * derived FD/key facts read off the optimized body; it derives no new inference.
 * What it cannot prove, it reports — it never silently assumes coverage.
 *
 * Two outputs per slot ({@link LensProveResult}):
 *  - **diagnostics** — the deploy-blocking errors (any one blocks the deploy)
 *    plus the warning-severity diagnostics that flow to the deploy report: the
 *    pure advisories (no-backing-index / no-answering-structure /
 *    partial-override / getput-lossy) plus the read-only verdict
 *    (`pk-not-reconstructible`). See `docs/lens.md` § Coverage checklist.
 *  - **obligations + readOnly** — per-constraint enforcement classification and
 *    the writable-or-read-only verdict, recorded on the {@link LensSlot}. The
 *    *live* per-write enforcement wiring (`lens-constraint-enforcement-wiring`)
 *    consumes these: the row-local check pipeline, the child-side FK existence
 *    check, and the set-level commit-time uniqueness scan are shipped
 *    (`planner/mutation/lens-enforcement.ts` — the `enforced-fk` obligation is a
 *    deferred basis-term `EXISTS` against the logical parent gated by the
 *    `foreign_keys` pragma; the `enforced-set-level` `commit-time` obligation is a
 *    deferred `(select count(*) … ) <= 1` count-subquery CHECK over the logical key,
 *    detection-only — `or replace`/`or ignore` against such a key is rejected). The
 *    `enforced-set-level` `row-time` write path (covering structure, conflict-
 *    resolution-capable) is **delivered** with no dedicated lens code: by this
 *    classifier's own precondition a row-time key is backed by a matching basis
 *    `UNIQUE` + non-stale covering MV, and the single-source re-plan reaches that
 *    basis UC, whose physical enforcement-through-covering-MV path does the
 *    O(log n) lookup and honors `ABORT`/`IGNORE`/`REPLACE` for free. This module
 *    proves, classifies, and blocks/advises.
 *
 * Soundness over completeness: a false error blocks a sound deploy, so every
 * check is conservative — when a fact cannot be established (e.g. the body fails
 * to plan, a multi-source covering lookup), the prover degrades to the
 * *safe* verdict (no spurious error; default a set-level constraint to the
 * commit-time scan and warn) rather than guessing.
 */

/**
 * Error-severity diagnostic codes — already hard errors that block the deploy
 * before ack/escalation governance runs, so they are *not* valid escalation
 * policy targets (see `docs/lens.md` § Coverage checklist). One code is
 * dual-severity: `lens.nullability-mismatch` is a hard error by default but is
 * demoted to a governable advisory when every basis module the body reads
 * declares `permitsGrandfatheredNotNullViolators` (see
 * {@link basisPermitsGrandfatheredNotNull}), so it also appears in
 * {@link ADVISORY_CODE_LIST}.
 */
export type LensErrorCode =
	| 'lens.uncovered-column'
	| 'lens.type-mismatch'
	| 'lens.nullability-mismatch'
	| 'lens.unrealizable-constraint'
	| 'lens.unenforceable-conflict-action'
	| 'lens.non-invertible'
	| 'lens.putget-violation'
	| 'lens.unknown-policy-code';

/**
 * The warning-severity advisory codes that flow through ack/escalation
 * governance (`lens-ack.ts`). This is the single authoritative source of the
 * governable vocabulary: a policy (`error-on` / `require-ack`) may legitimately
 * name any of these, and only these. Keeping the list here means it cannot drift
 * from what the prover actually emits.
 */
const ADVISORY_CODE_LIST = [
	'lens.pk-not-reconstructible',
	'lens.no-backing-index',
	'lens.no-answering-structure',
	'lens.partial-override',
	'lens.getput-lossy',
	'lens.over-restrictive-basis-key',
	// Dual-severity: a hard error by default, an advisory only over a basis
	// module declaring `permitsGrandfatheredNotNullViolators` — listed here so
	// the demoted form is ack/escalation-governable like any other advisory.
	'lens.nullability-mismatch',
] as const;

/** An advisory (warning-severity) code — see {@link ADVISORY_CODE_LIST}. */
export type LensAdvisoryCode = typeof ADVISORY_CODE_LIST[number];

/** The advisory codes a policy may escalate, as a runtime set (drift-locked by a unit test). */
export const ACKNOWLEDGEABLE_ADVISORY_CODES: ReadonlySet<LensAdvisoryCode> =
	new Set(ADVISORY_CODE_LIST);

/** Stable diagnostic codes (see `docs/lens.md` § Coverage checklist). */
export type LensCheckCode = LensErrorCode | LensAdvisoryCode;

/** The logical site a diagnostic concerns (table / constraint / column). */
export interface LensDiagnosticSite {
	readonly table: string;
	readonly constraint?: string;
	readonly column?: string;
}

/**
 * The coarse facts behind a warning, recorded so the sibling acknowledgment
 * ticket (`lens-advisory-acknowledgment`) can fingerprint an advisory without
 * re-deriving it. This ticket *defines and populates* the shape; the sibling
 * computes the hash and persists it when an ack is written, and re-surfaces the
 * advisory when the fingerprint no longer matches. Deliberately coarse — a
 * cardinality *band* rather than a row count — so an ack survives ordinary churn.
 */
export interface FingerprintInputs {
	/** The logical constraint's columns (names, declaration order). */
	readonly constraintColumns?: readonly string[];
	/** Whether a basis covering structure answers the constraint at deploy time. */
	readonly hasCoveringStructure?: boolean;
	/** Coarse cardinality band of the basis anchor: empty | small | medium | large | unknown. */
	readonly cardinalityBand?: string;
	/** The basis relation backing the constraint (lowercased `schema.table`), when resolvable. */
	readonly basisRelation?: string;
	/**
	 * The enumerable CHECK `in (...)` domain behind a round-trip advisory
	 * (`lens.getput-lossy`), rendered + sorted — a domain change (the list gains
	 * or loses a value) is a material fact that re-surfaces an acknowledgment.
	 * Serialized into the fingerprint only when present, so advisories without a
	 * domain keep their existing hashes.
	 */
	readonly domainValues?: readonly string[];
	/**
	 * The governing basis key's basis-column names behind an over-restriction
	 * advisory (`lens.over-restrictive-basis-key`), rendered + sorted — if the basis
	 * key changes (tightened to match the logical key, or loosened) the advisory's
	 * truth changes, so a prior acknowledgment should re-surface. Serialized into the
	 * fingerprint only when present (mirroring {@link domainValues}), so advisories
	 * without a basis key keep their existing hashes.
	 */
	readonly basisKeyColumns?: readonly string[];
}

/** A sited, coded diagnostic. Errors block the deploy; warnings flow to the report. */
export interface LensDiagnostic {
	readonly code: LensCheckCode;
	readonly severity: 'error' | 'warning';
	readonly site: LensDiagnosticSite;
	readonly message: string;
	readonly fingerprintInputs?: FingerprintInputs;
	/**
	 * Set by the acknowledgment governance (`lens-ack.ts`) when a previously
	 * acknowledged advisory re-surfaced because its recorded fingerprint no longer
	 * matches the freshly computed one. The message is annotated accordingly.
	 */
	readonly resurfaced?: boolean;
}

/** A reference to the basis covering structure routing a set-level constraint. */
export interface CoveringStructureRef {
	readonly kind: 'memory-index' | 'materialized-view';
	readonly name: string;
}

/**
 * How one logical constraint becomes real at the lens boundary:
 *  - `proved` — the body intrinsically guarantees it (FD/key); zero runtime cost.
 *  - `enforced-row-local` — evaluable on the projected row being written (a
 *    scalar `check` over non-computed columns); the common, free case.
 *  - `enforced-set-level` — an existence lookup. `row-time` when a covering
 *    structure answers it (O(log n), conflict-resolution-capable); `commit-time`
 *    otherwise (O(n) `DeltaExecutor` scan, detection-only).
 *  - `enforced-fk` — cross-relation existence, realized at the lens boundary as a
 *    deferred synthesized `EXISTS` against the logical parent (gated by the
 *    `foreign_keys` pragma, auto-deferred to commit; `planner/mutation/lens-enforcement.ts`).
 *  - `vacuous` — body + predicate make it trivially satisfied.
 */
export type ConstraintObligation = { readonly constraint: LogicalConstraint } & (
	| { readonly kind: 'proved' }
	| { readonly kind: 'enforced-row-local' }
	| { readonly kind: 'enforced-set-level'; readonly mode: 'row-time' | 'commit-time'; readonly structure?: CoveringStructureRef }
	| { readonly kind: 'enforced-fk' }
	| { readonly kind: 'vacuous' }
);

/**
 * The aggregated result of proving every logical table in one `apply schema X`.
 * `deployLogicalSchema` returns this; `emitApplySchema` surfaces the warnings as
 * advisory rows. Errors are thrown atomically (before any catalog mutation), so a
 * returned report always has `errors: []` — the field is kept for symmetry and so
 * an in-process caller that wants to inspect-without-throwing can.
 */
export interface LensDeployReport {
	readonly errors: LensDiagnostic[];
	/**
	 * Advisories shown by default — un-acknowledged ones plus any that re-surfaced
	 * (`resurfaced: true`) plus empty-rationale meta-warnings. Acknowledged
	 * advisories are removed (and tallied in {@link acknowledged}).
	 */
	readonly warnings: LensDiagnostic[];
	/**
	 * Advisories an in-source `quereus.lens.ack.<code>` tag suppressed from the
	 * default report. The deploy summary tallies `acknowledged: N` (=
	 * `acknowledged.length`) and the `quereus_lens_advisories` TVF expands them on
	 * demand (`docs/lens.md` § Acknowledging advisories). Produced by `lens-ack.ts`.
	 */
	readonly acknowledged: AcknowledgedAdvisory[];
	/** Lowercased logical table name → its constraint obligations. */
	readonly obligationsByTable: ReadonlyMap<string, ReadonlyArray<ConstraintObligation>>;
}

/** The prover's verdict for one lens slot. */
export interface LensProveResult {
	/** Any non-empty ⇒ deploy blocks. */
	readonly errors: LensDiagnostic[];
	/** Advisory; never blocks. Surfaced in the deploy report. */
	readonly warnings: LensDiagnostic[];
	/** Per-constraint enforcement classification. */
	readonly obligations: ConstraintObligation[];
	/** Key not reconstructible ⇒ the table is read-only; mutations error at the lens. */
	readonly readOnly: boolean;
}

/**
 * Proves one lens slot and classifies its constraints. Pure analysis — does not
 * mutate the slot or the catalog; the caller (`lens-compiler.ts`) records the
 * `obligations` / `readOnly` on the slot and aggregates the diagnostics into the
 * deploy report.
 */
export function proveLens(slot: LensSlot, db: Database): LensProveResult {
	const ctx = buildProveContext(slot, db);
	const errors: LensDiagnostic[] = [];
	const warnings: LensDiagnostic[] = [];

	checkColumnCoverage(ctx, errors);
	checkTypeAndNullability(ctx, errors, warnings);

	// Run the round-trip enumeration ONCE, up front: it produces both the
	// proven-bijection verdict per authored column (the same `{proved, injective}`
	// that suppresses `lens.getput-lossy`) and the cached enumeration the
	// round-trip diagnostics consume. Hoisting it ahead of key reconstructibility
	// is what lets a bijective authored PK column count as reconstructible
	// (writable) instead of read-only — a bijection maps a written logical key to
	// exactly one basis key and back. {@link emitRoundTrip} consumes the cache; it
	// never re-runs the enumeration.
	const rt = analyzeRoundTrip(ctx);
	const bijectiveAuthored = bijectiveAuthoredColumns(rt);

	const readOnly = checkKeyReconstructibility(ctx, bijectiveAuthored, warnings);
	emitRoundTrip(ctx, rt, readOnly, errors, warnings);

	const obligations = classifyObligations(ctx, readOnly, bijectiveAuthored, errors, warnings);

	checkAnsweringStructures(ctx, warnings);
	checkPartialOverride(ctx, warnings);

	return { errors, warnings, obligations, readOnly };
}

// ---------------------------------------------------------------------------
// Prove context — the per-slot facts every check reads.
// ---------------------------------------------------------------------------

interface ProveContext {
	readonly slot: LensSlot;
	readonly db: Database;
	readonly table: TableSchema;
	/** Lowercased logical column name → its index in `logicalTable.columns`. */
	readonly logicalColIndex: ReadonlyMap<string, number>;
	/** Logical column names, in body-output order. */
	readonly outputColumns: readonly string[];
	/** Logical column name (lower) → body-output column index. */
	readonly outputIndex: ReadonlyMap<string, number>;
	/**
	 * The optimized body relation (`getRelations()[0]`), or undefined when the
	 * body failed to plan (graceful degradation — plan-derived checks are skipped).
	 */
	readonly root?: RelationalPlanNode;
	/** The single basis source table of the body, when single-source; else undefined. */
	readonly basisSource?: TableSchema;
	readonly basisSchemaName: string;
}

function buildProveContext(slot: LensSlot, db: Database): ProveContext {
	const table = slot.logicalTable;
	const logicalColIndex = new Map<string, number>();
	table.columns.forEach((c, i) => logicalColIndex.set(c.name.toLowerCase(), i));

	const { outputIndex, outputColumns } = buildOutputIndex(slot);

	const basisSchemaName = slot.defaultBasis.schemaName;
	return {
		slot,
		db,
		table,
		logicalColIndex,
		outputColumns,
		outputIndex,
		root: planBody(db, slot.compiledBody),
		basisSource: resolveSingleBasisSource(db.schemaManager, slot.compiledBody),
		basisSchemaName,
	};
}

/**
 * The output-index map for a lens slot: logical column name (lower) →
 * body-output column index, plus the columns in declaration order. The single
 * source of truth for the body's output-column-index space — shared by
 * {@link buildProveContext} and {@link computeLensAssertedKeyFds} so the two can
 * never drift (the FD-contribution columns must land in exactly the space the
 * prover proved its keys in).
 */
function buildOutputIndex(slot: LensSlot): { outputIndex: Map<string, number>; outputColumns: string[] } {
	const outputColumns: string[] = [];
	const outputIndex = new Map<string, number>();
	for (const p of slot.columnProvenance) {
		outputIndex.set(p.logicalColumn.toLowerCase(), outputColumns.length);
		outputColumns.push(p.logicalColumn);
	}
	return { outputIndex, outputColumns };
}

/**
 * Plans + optimizes the compiled body so `physical.fds` and output column types
 * are available. Returns undefined (graceful) if planning throws — the body the
 * compiler produced should plan, but a prover that itself crashes the deploy is
 * worse than one that skips plan-derived checks.
 */
function planBody(db: Database, body: AST.SelectStmt): RelationalPlanNode | undefined {
	try {
		return db.getPlan(astToString(body)).getRelations()[0];
	} catch (e) {
		log('lens-prover: body failed to plan, skipping plan-derived checks: %O', e);
		return undefined;
	}
}

/**
 * The single basis `table` source of a **compiled** body, or undefined for a
 * multi-source / opaque FROM.
 *
 * Reads the schema qualifier the body carries rather than defaulting a bare name
 * to the basis: every compiled body is fully basis-qualified by construction
 * (`lens-compiler.ts` § `qualifyBasisSources`; the synthesized default and
 * decomposition bodies emit qualified sources directly), so a bare name surviving
 * in one is a CTE reference shadowing a same-named basis relation — resolving it
 * as that relation would attribute the CTE's rows to a table the body never reads.
 */
function resolveSingleBasisSource(schemaManager: SchemaManager, body: AST.SelectStmt): TableSchema | undefined {
	const from = body.from;
	if (!from || from.length !== 1) return undefined;
	const node = from[0];
	if (node.type !== 'table' || node.table.schema === undefined) return undefined;
	return schemaManager.getSchema(node.table.schema)?.getTable(node.table.name);
}

/**
 * The single basis `table` source of a lens slot's compiled body, or undefined for
 * a multi-source / opaque FROM — the exported slot-level entry point. Reused by the
 * lens FK-redundancy detector (`planner/mutation/lens-enforcement.ts`) so it walks
 * the same single-source `from` the prover does. Reads only the catalog, so it is
 * safe over a lightweight (un-planned) caller.
 */
export function resolveSlotBasisSource(slot: LensSlot, schemaManager: SchemaManager): TableSchema | undefined {
	return resolveSingleBasisSource(schemaManager, slot.compiledBody);
}

// ---------------------------------------------------------------------------
// Error: column coverage (lens.uncovered-column)
// ---------------------------------------------------------------------------

/**
 * Every logical column resolves to a basis expression. The compiler's gap-fill
 * path already errors on an uncovered column before the prover runs, so this is
 * the formal restatement / backstop: a provenance entry must exist for every
 * column and must be `override` or `default`.
 */
function checkColumnCoverage(ctx: ProveContext, errors: LensDiagnostic[]): void {
	const provByName = new Map(ctx.slot.columnProvenance.map(p => [p.logicalColumn.toLowerCase(), p]));
	for (const col of ctx.table.columns) {
		const p = provByName.get(col.name.toLowerCase());
		if (!p) {
			errors.push({
				code: 'lens.uncovered-column',
				severity: 'error',
				site: { table: ctx.table.name, column: col.name },
				message: `lens: logical column '${ctx.table.schemaName}.${ctx.table.name}.${col.name}' is not covered by the compiled body (no override mapping and no default gap-fill)`,
			});
		}
	}
}

// ---------------------------------------------------------------------------
// Error: type / nullability conformance
// ---------------------------------------------------------------------------

/** Coarse affinity family used for type-conformance (kept lenient to avoid false blocks). */
type AffinityFamily = 'numeric' | 'text' | 'blob' | 'boolean' | 'other';

function physicalFamily(pt: PhysicalType): AffinityFamily {
	switch (pt) {
		case PhysicalType.INTEGER:
		case PhysicalType.REAL: return 'numeric';
		case PhysicalType.TEXT: return 'text';
		case PhysicalType.BLOB: return 'blob';
		case PhysicalType.BOOLEAN: return 'boolean';
		default: return 'other'; // NULL / OBJECT — permissive
	}
}

/**
 * Conservative cross-family compatibility. `other` (NULL/OBJECT) is compatible
 * with anything; numeric and boolean are mutually compatible (SQLite stores
 * booleans as integers). Only a clear cross-family mismatch (numeric↔text,
 * text↔blob, …) is reported, so a faithfully-aligned basis never false-errors.
 */
function familiesCompatible(a: AffinityFamily, b: AffinityFamily): boolean {
	if (a === b) return true;
	if (a === 'other' || b === 'other') return true;
	const numericish = (f: AffinityFamily): boolean => f === 'numeric' || f === 'boolean';
	return numericish(a) && numericish(b);
}

/**
 * Whether EVERY basis table the compiled body's FROM reads belongs to a module
 * declaring `permitsGrandfatheredNotNullViolators` (and at least one resolved).
 * Such a declarant may legitimately hold rows lacking a value for a declared
 * NOT NULL column — grandfathered by a structurally-total schema change, or
 * replicated from a peer at an older schema epoch — so a nullable basis-derived
 * expression under a `not null` logical column is the EXPECTED seam shape
 * there, not a contradiction. Conservative on anything unclear: an opaque FROM
 * node (subquery/function), an unqualified table name (a CTE shadow — see
 * {@link resolveSingleBasisSource}), an unresolvable table, or any one
 * non-declaring module keeps the strict error.
 */
function basisPermitsGrandfatheredNotNull(ctx: ProveContext): boolean {
	let sawAny = false;
	const walk = (node: AST.FromClause): boolean => {
		if (node.type === 'join') return walk(node.left) && walk(node.right);
		if (node.type !== 'table' || node.table.schema === undefined) return false;
		const table = ctx.db.schemaManager.getSchema(node.table.schema)?.getTable(node.table.name);
		if (table?.vtabModule?.getCapabilities?.().permitsGrandfatheredNotNullViolators !== true) return false;
		sawAny = true;
		return true;
	};
	const from = ctx.slot.compiledBody.from;
	if (!from || from.length === 0) return false;
	return from.every(walk) && sawAny;
}

/**
 * Each mapped column's basis-derived type & nullability satisfy the logical
 * declaration. A nullable basis expression under a `not null` logical column
 * errors unless the logical column supplies a total default — except over a
 * basis whose module declares `permitsGrandfatheredNotNullViolators`
 * ({@link basisPermitsGrandfatheredNotNull}), where the same diagnostic is
 * demoted to a warning-severity advisory (governable, non-blocking): the
 * declarant has told us grandfathered/older-epoch rows may lack the value, so
 * a read may yield NULL there by design. Read off the optimized body's output
 * relation; skipped when the body did not plan.
 */
function checkTypeAndNullability(ctx: ProveContext, errors: LensDiagnostic[], warnings: LensDiagnostic[]): void {
	if (!ctx.root) return;
	const grandfatheredNotNull = basisPermitsGrandfatheredNotNull(ctx);
	const outCols = ctx.root.getType().columns;
	for (const col of ctx.table.columns) {
		const oi = ctx.outputIndex.get(col.name.toLowerCase());
		if (oi === undefined) continue; // defensive: column absent from the body output
		const outCol = outCols[oi];
		if (!outCol) continue;
		const outType = outCol.type;
		if (outType.typeClass !== 'scalar') continue;

		const declared = physicalFamily(col.logicalType.physicalType);
		const basis = physicalFamily(outType.logicalType.physicalType);
		if (!familiesCompatible(declared, basis)) {
			errors.push({
				code: 'lens.type-mismatch',
				severity: 'error',
				site: { table: ctx.table.name, column: col.name },
				message: `lens: logical column '${ctx.table.name}.${col.name}' declares type '${col.logicalType.name}' but its basis-derived expression has type '${outType.logicalType.name}' (incompatible storage affinities)`,
			});
			continue;
		}

		// Nullability: not-null logical column over a nullable basis expression with
		// no total default is unsound (a NULL could be read into a not-null column) —
		// unless the basis module declared it may grandfather NOT NULL violators,
		// where the read-side NULL is the declared, expected shape: advisory only.
		if (col.notNull && outType.nullable === true && col.defaultValue === null) {
			if (grandfatheredNotNull) {
				warnings.push({
					code: 'lens.nullability-mismatch',
					severity: 'warning',
					site: { table: ctx.table.name, column: col.name },
					message: `lens: logical column '${ctx.table.name}.${col.name}' is declared NOT NULL but its basis-derived expression is nullable (the basis module permits grandfathered NOT NULL violators — rows predating the declaration, or replicated from an older schema epoch, may read NULL here). Forward writes through the lens still enforce the declared NOT NULL; only already-stored rows read NULL.`,
				});
			} else {
				errors.push({
					code: 'lens.nullability-mismatch',
					severity: 'error',
					site: { table: ctx.table.name, column: col.name },
					message: `lens: logical column '${ctx.table.name}.${col.name}' is declared NOT NULL but its basis-derived expression is nullable and no default supplies a value`,
				});
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Error→read-only: key reconstructibility (lens.pk-not-reconstructible)
// ---------------------------------------------------------------------------

/**
 * For a writable logical table the logical PK must be reconstructible at the lens
 * boundary — each PK column either maps to a plain (invertible) basis column
 * projection ({@link isReconstructibleColumn}) **or** is an authored
 * (`with inverse`) column whose forward/inverse pair the round-trip enumeration
 * proved a **bijection** (`bijectiveAuthored`). A bijective key is fully
 * reconstructible: a written logical key maps to exactly one basis key and back.
 * When a PK column is neither (a computed / aggregated / non-injective authored
 * column), the table is **read-only**: reads still work, but any mutation errors
 * at the lens (`planner/mutation/single-source.ts` `analyzeView` raises). This is
 * not a deploy-blocking error — the table deploys read-only — so it surfaces as a
 * warning, and `readOnly` is set on the slot. The empty (singleton) PK is
 * vacuously reconstructible.
 *
 * @returns whether the table is read-only.
 */
function checkKeyReconstructibility(ctx: ProveContext, bijectiveAuthored: ReadonlySet<string>, warnings: LensDiagnostic[]): boolean {
	const pk = ctx.table.primaryKeyDefinition;
	if (pk.length === 0) return false; // singleton — 0-or-1 row, vacuously reconstructible

	const unreconstructible: string[] = [];
	for (const pkCol of pk) {
		const name = ctx.table.columns[pkCol.index]?.name;
		if (name === undefined || !(isReconstructibleColumn(ctx, name) || bijectiveAuthored.has(name.toLowerCase()))) {
			unreconstructible.push(name ?? `#${pkCol.index}`);
		}
	}
	if (unreconstructible.length === 0) return false;

	warnings.push({
		code: 'lens.pk-not-reconstructible',
		severity: 'warning',
		site: { table: ctx.table.name },
		message: `lens: logical table '${ctx.table.name}' is read-only — its primary key is not reconstructible at the lens boundary (column(s) ${unreconstructible.map(c => `'${c}'`).join(', ')} have no invertible basis write path); mutations against it will error`,
	});
	return true;
}

/**
 * A logical column is **bare-reconstructible** iff its body-output projection term
 * is a plain column reference (so a written value maps straight back to a basis
 * column). A computed (non-column) projection has no bare write path — but an
 * authored (`with inverse`) computed column may still be key-reconstructible by a
 * proven bijection; that case is handled by the `bijectiveAuthored` set, not here.
 */
function isReconstructibleColumn(ctx: ProveContext, columnName: string): boolean {
	const oi = ctx.outputIndex.get(columnName.toLowerCase());
	if (oi === undefined) return false; // not in the body output — not writable through the lens
	const rc = ctx.slot.compiledBody.columns[oi];
	return rc?.type === 'column' && rc.expr.type === 'column';
}

// ---------------------------------------------------------------------------
// Error: round-trip / lens laws (lens.non-invertible) — computed deploy-time form
// ---------------------------------------------------------------------------

/**
 * The hoisted round-trip analysis: the per-column verdicts plus, for each authored
 * column, its cached PutGet enumeration. Produced ONCE by {@link analyzeRoundTrip}
 * and consumed by both {@link bijectiveAuthoredColumns} (the proven-bijection set
 * that gates key reconstructibility) and {@link emitRoundTrip} (the diagnostics).
 * `verdicts` is undefined when the body degrades to safe (out of fragment / failed
 * to plan); `authoredEnum` is then empty.
 */
interface RoundTripAnalysis {
	/** Per-output-column round-trip verdicts, in attribute order; undefined ⇒ degrade-to-safe. */
	readonly verdicts?: readonly ColumnRoundTrip[];
	/** Authored logical column (lowercased) → its cached PutGet enumeration. */
	readonly authoredEnum: ReadonlyMap<string, PutGetEnumeration>;
}

/**
 * Round-trip (GetPut / PutGet) over the writable fragment, **computed at deploy**
 * from the predicate-honest complement ({@link viewComplement}). Because Quereus
 * resolves the Bancilhon–Spyratos ambiguity by predicate-honest fan-out, the
 * complement is *determined, not chosen*, which makes the two laws decidable over
 * the single-source projection-and-filter fragment with no theorem prover:
 *
 *  - **GetPut** ("read a row, write the same values back ⇒ base unchanged") holds
 *    iff `put` leaves the complement **fixed**: no writable column's backward
 *    write path targets a base column the complement lists as *hidden*.
 *  - **PutGet** ("write a value through the view, read it back ⇒ get the written
 *    value") holds iff, for every column the lens presents as **writable**, the
 *    composed `get ∘ put` is the identity on the writable value, and any `domain`
 *    restriction the column's inverse carries is **entailed** by the residual
 *    predicate.
 *
 * This is the *analysis* half, split from the diagnostic emission
 * ({@link emitRoundTrip}) so the per-authored-column enumeration runs **exactly
 * once**: each authored verdict's {@link provePutGetByEnumeration} result is cached
 * keyed by the logical column (lowercased), and both the bijection-set consumer and
 * the emitter read the cache. The split is a pure refactor — the cached enumeration
 * is byte-identical to what the formerly-inline authored-inverse check computed.
 *
 * Degrade-to-safe: yields no verdicts (and an empty enum map) whenever the
 * complement cannot characterize the body (out of the single-source projection-and-
 * filter fragment, lineage not threaded, or a non-negation-free residual) — today's
 * behaviour, the mutation-time and key-reconstructibility nets still govern. The
 * body is planned **logically** ({@link planLogicalBody}, not `ctx.root`) so the
 * Project/Filter/TableReference operator tree threading `updateLineage` survives.
 * See `docs/lens.md` § Round-trip and `docs/vu-roundtrip.md`
 * § The predicate-honest complement.
 */
function analyzeRoundTrip(ctx: ProveContext): RoundTripAnalysis {
	const authoredEnum = new Map<string, PutGetEnumeration>();
	const root = planLogicalBody(ctx);
	if (!root) return { authoredEnum }; // body failed to plan logically → safe verdict
	const verdicts = computeRoundTrip(root);
	if (!verdicts) return { authoredEnum }; // out of fragment / indeterminate complement → safe verdict

	verdicts.forEach((v, i) => {
		if (!v.authored) return;
		// Site at the *logical* column (the contract spelling), positionally aligned
		// with the body output — the same space {@link emitRoundTrip} re-derives it in.
		const column = ctx.outputColumns[i] ?? v.name;
		authoredEnum.set(column.toLowerCase(), provePutGetByEnumeration(ctx, column, v.authored, v.forward));
	});
	return { verdicts, authoredEnum };
}

/**
 * The authored logical columns (lowercased) the round-trip enumeration proved a
 * **bijection** (`{kind:'proved', injective:true}`) — the same verdict that
 * suppresses `lens.getput-lossy`. A bijective authored column is key-reconstructible
 * (a written logical key maps to exactly one basis key and back) and its logical key
 * is intrinsically unique, so this set gates both {@link checkKeyReconstructibility}
 * and the bijection-transport `proved` classification in {@link classifyKeyConstraint}.
 * A column outside the set (non-injective, indeterminate, or a violation) confers no
 * reconstructibility.
 */
function bijectiveAuthoredColumns(rt: RoundTripAnalysis): ReadonlySet<string> {
	const set = new Set<string>();
	for (const [column, enumResult] of rt.authoredEnum) {
		if (enumResult.kind === 'proved' && enumResult.injective) set.add(column);
	}
	return set;
}

/**
 * Emits the round-trip diagnostics from the cached {@link RoundTripAnalysis} — the
 * *diagnostic* half, split from {@link analyzeRoundTrip} (which already ran the
 * enumeration). The firing rule has three branches:
 *  1. a column the lens presents as writable (a `base` {@link ResolvedBaseSite})
 *     whose round-trip the analysis cannot prove faithful (`v.writable &&
 *     !v.faithful`) — the original rule, unchanged.
 *  2. a `computed`/opaque output column (`!v.writable`) the author *declared*
 *     writable via the `quereus.lens.writable = true` intent tag
 *     ({@link intentWritable}): the round-trip law's stronger reading makes this
 *     an authoring error, not a derived column.
 *  3. an **authored** (`with inverse`) column ({@link emitAuthoredInverseDiagnostics}):
 *     writable by construction (it satisfies the writable intent exactly as an
 *     inferred inverse does — branch 2 never fires for it). PutGet is checked by
 *     *composition* (the cached enumeration): a value that fails to reproduce is the
 *     hard `lens.putget-violation` error; GetPut is surrendered by design for a
 *     non-injective forward and surfaces as the acknowledgeable `lens.getput-lossy`
 *     advisory — suppressed only when the enumeration also proves the forward
 *     bijective over the basis domain.
 *
 * An opaque column carrying no intent tag (or `= false`) is *not* a deploy error
 * — it is an intentional read-only/derived column (its write reds `no-inverse` at
 * mutation time, as today), per the prover's soundness-over-completeness principle
 * and the no-over-block requirement (`docs/lens.md` § Computed and Generated
 * Columns). The intent is a deploy-policy input, not a property of the body's
 * complement, so it lives here in the diagnostic wrapper — `computeRoundTrip` and
 * `roundTripObstruction` are untouched. The branch keys off the round-trip
 * verdict's `v.writable` (which admits an invertible *composed* expression like
 * `(speed + 1) - 2`), NOT `isReconstructibleColumn` (the bare-column test, which
 * would false-fire on such a chain).
 *
 * Degrade-to-safe: emits nothing when {@link analyzeRoundTrip} produced no verdicts —
 * so an out-of-fragment opaque column tagged writable does not deploy-block; it still
 * reds `no-inverse` at mutation time. This completeness gap is intentional.
 */
function emitRoundTrip(ctx: ProveContext, rt: RoundTripAnalysis, readOnly: boolean, errors: LensDiagnostic[], warnings: LensDiagnostic[]): void {
	if (!rt.verdicts) return; // degrade-to-safe: no per-column verdicts to emit

	rt.verdicts.forEach((v, i) => {
		// Site at the *logical* column (the contract spelling), positionally aligned
		// with the body output — the same space {@link analyzeRoundTrip} cached it in.
		const column = ctx.outputColumns[i] ?? v.name;

		// (3) An authored (`with inverse`) column: writable by construction (the
		// intent branch below never fires), PutGet checked by composition, GetPut
		// surrendered into the `lens.getput-lossy` advisory. Consumes the cached
		// enumeration (always present for an authored verdict — same iteration).
		if (v.authored) {
			const enumResult = rt.authoredEnum.get(column.toLowerCase());
			if (enumResult) emitAuthoredInverseDiagnostics(ctx, column, enumResult, readOnly, errors, warnings);
			return;
		}

		// (1) A column the lens presents as writable whose round-trip cannot be
		// proved faithful — the original firing rule, unchanged.
		if (v.writable && !v.faithful) {
			errors.push({
				code: 'lens.non-invertible',
				severity: 'error',
				site: { table: ctx.table.name, column },
				message: `lens: writable column '${ctx.table.name}.${column}' is not faithfully invertible at the lens boundary (${v.obstruction}); its GetPut/PutGet round-trip cannot be proved, so the declared write path is unsound`,
			});
			return;
		}

		// (2) An opaque / read-only column the author declared writable via the
		// `quereus.lens.writable = true` intent tag. Today it would be silently
		// admitted read-only; the asserted intent turns that into an authoring error.
		if (!v.writable && intentWritable(ctx, column)) {
			errors.push({
				code: 'lens.non-invertible',
				severity: 'error',
				site: { table: ctx.table.name, column },
				message: `lens: column '${ctx.table.name}.${column}' is declared writable ('${LENS_WRITABLE_INTENT_TAG}' = true) but its lens body is computed/opaque with no invertible write path; the round-trip law cannot be satisfied, so the declared writable intent is unsound (map it to an invertible basis expression, or drop the tag to deploy it read-only)`,
			});
		}
	});
}

/**
 * Whether the logical column named `column` carries the writable-intent signal
 * (`quereus.lens.writable = true`). Resolves the logical column case-insensitively
 * via the same `logicalColIndex` the rest of the prover uses, then reads the tag
 * as a real boolean (`=== true`): `validateReservedTags` has already rejected a
 * non-boolean value at deploy, so a surviving non-`true` value is `false`/absent.
 */
function intentWritable(ctx: ProveContext, column: string): boolean {
	const li = ctx.logicalColIndex.get(column.toLowerCase());
	if (li === undefined) return false;
	return ctx.table.columns[li]?.tags?.[LENS_WRITABLE_INTENT_TAG] === true;
}

/**
 * Plan the lens body **logically** (the `view_info`/`column_info` and mutation
 * substrate path via `_buildPlan`, *not* the optimized `ctx.root`), so the clean
 * Project/Filter/TableReference operator tree — and the `updateLineage` it threads
 * — survives (the optimizer degrades a structure-rewriting node's lineage to
 * `computed`; `docs/view-updateability.md` § surface authority). Guarded with the
 * same graceful-degradation `try/catch` as {@link planBody}.
 */
function planLogicalBody(ctx: ProveContext): RelationalPlanNode | undefined {
	try {
		const { plan } = ctx.db._buildPlan([ctx.slot.compiledBody as AST.Statement]);
		return plan.getRelations()[0];
	} catch (e) {
		log('lens-prover: round-trip body failed to plan logically, degrading to safe: %O', e);
		return undefined;
	}
}

/** The per-output-column round-trip verdict over a planned single-source body. */
export interface ColumnRoundTrip {
	readonly attrId: number;
	/** Body-output column name (the lens spells these as the logical columns). */
	readonly name: string;
	/** The lens presents this column as writable (a `base` {@link ResolvedBaseSite}). */
	readonly writable: boolean;
	/** A *writable* column whose GetPut/PutGet round-trip is proved faithful. */
	readonly faithful: boolean;
	/** Names the obstruction for a writable-but-unfaithful column (else undefined). */
	readonly obstruction?: string;
	/**
	 * The authored (`with inverse`) put payload, when the column's write path is
	 * authored. Such a column is writable+faithful *structurally*; its law
	 * treatment is the prover's authored branch ({@link emitAuthoredInverseDiagnostics}) —
	 * PutGet by enumeration, GetPut surrendered into the lossy advisory.
	 */
	readonly authored?: AuthoredSite;
	/** The forward `get` expression off the topmost projection (carried for the authored branch's composition). */
	readonly forward?: AST.Expression;
}

/**
 * The computed per-column GetPut/PutGet verdict over a planned **logical** body —
 * the deploy-time predicate {@link analyzeRoundTrip} / {@link emitRoundTrip} consume,
 * exported so the operational round-trip harness (`test/property.spec.ts` § View
 * Round-Trip Laws) can assert it agrees with the operational law per column.
 *
 * Returns `undefined` (the degrade-to-safe signal) for any body the complement
 * does not characterize: not single-source projection-and-filter (multi-source /
 * join / aggregate / set-op / VALUES / recursive-CTE / LIMIT / OFFSET / DISTINCT),
 * `updateLineage` not threaded, or a residual predicate that is not negation-free.
 * Otherwise one verdict per output column, in attribute order.
 *
 * Each writable site is read through {@link resolveBaseSite} — the same n-way
 * reader the single-source, join, and decomposition put paths share — so the
 * GetPut hidden-column and PutGet inverse-domain checks already generalize past
 * single-source when the complement is later defined on the join/decomposition
 * fragment (`view-write-through-shape-gaps`); only the fragment gate here is
 * single-source-only.
 */
export function computeRoundTrip(root: RelationalPlanNode): ColumnRoundTrip[] | undefined {
	if (!isSingleSourceProjectionFilter(root)) return undefined;
	const lineage = root.physical.updateLineage;
	if (!lineage) return undefined; // lineage not threaded ⇒ complement cannot be characterized

	const complement = viewComplement(root);
	if (complement.residualPredicate && !isNegationFree(complement.residualPredicate)) {
		return undefined; // a non-negation-free residual signals the complement is not honestly determined
	}

	const hidden = new Set(complement.hiddenColumns.map(h => h.column.toLowerCase()));
	const forwardByAttr = collectForwardExprs(root);

	return root.getAttributes().map((attr): ColumnRoundTrip => {
		const site = resolveBaseSite(lineage.get(attr.id));
		if (!site.writable) {
			return { attrId: attr.id, name: attr.name, writable: false, faithful: false };
		}
		// An authored (`with inverse`) put: the structural obstructions below are
		// inapplicable (no single verbatim base column, no registry inverse) — the
		// verdict is writable+faithful with the authored payload attached for the
		// prover's dedicated law treatment (enumeration + lossy advisory).
		if (site.authored) {
			return { attrId: attr.id, name: attr.name, writable: true, faithful: true, authored: site.authored, forward: forwardByAttr.get(attr.id) };
		}
		const obstruction = roundTripObstruction(site, hidden, forwardByAttr.get(attr.id), complement.residualPredicate);
		return { attrId: attr.id, name: attr.name, writable: true, faithful: obstruction === undefined, obstruction };
	});
}

/**
 * The GetPut / PutGet obstruction for a writable column, or `undefined` when its
 * round-trip is proved faithful:
 *  - **GetPut** — `put` leaves the complement fixed: the writable base column is
 *    not one the complement lists as hidden (holds structurally over the single-
 *    source fragment — a guard that reds the day a shape violates it).
 *  - **PutGet** — `get ∘ put` reproduces the written value ({@link getPutComposesToIdentity},
 *    over the closed registry vocabulary), and any inverse `domain` is entailed by
 *    the residual. The shipped registry is faithful with unrestricted domains, so
 *    this returns `undefined` for it — the seam stays correct as the registry
 *    grows a domain-restricted or composed profile.
 */
function roundTripObstruction(
	site: ResolvedBaseSite,
	hidden: ReadonlySet<string>,
	forward: AST.Expression | undefined,
	residual: AST.Expression | undefined,
): string | undefined {
	if (site.baseColumn !== undefined && hidden.has(site.baseColumn.toLowerCase())) {
		return `GetPut: the write-back targets base column '${site.baseColumn}', which the view-complement holds fixed`;
	}
	// `get ∘ put = id` is verifiable only with the forward `get` expression; if it is
	// unavailable (no Project node found) degrade to safe — the shipped registry is
	// faithful by construction, so a missing forward never masks a real violation.
	if (site.inverse !== undefined && forward !== undefined && !getPutComposesToIdentity(forward, site.inverse)) {
		return `PutGet: the 'put' inverse does not reproduce the written value back through 'get'`;
	}
	if (site.domain !== undefined && !domainEntailedBy(site.domain, residual)) {
		return `PutGet: the inverse's domain restriction is not entailed by the view predicate`;
	}
	return undefined;
}

/**
 * The single-source projection-and-filter fragment gate. Reuses {@link classifyViewBody}
 * (the substrate's shape classifier) to reject multi-source / join / aggregate /
 * set-op / VALUES / recursive-CTE bodies, then additionally rejects LIMIT / OFFSET /
 * DISTINCT — which that classifier tolerates as pass-through (so its walk can reach
 * the base table) but the complement does not characterize.
 */
function isSingleSourceProjectionFilter(root: RelationalPlanNode): boolean {
	if (classifyViewBody(root).kind !== 'single-source') return false;
	let windowed = false;
	const visit = (n: PlanNode): void => {
		if (n.nodeType === PlanNodeType.LimitOffset || n.nodeType === PlanNodeType.Distinct) windowed = true;
		for (const child of n.getRelations()) visit(child);
	};
	visit(root);
	return !windowed;
}

/**
 * The forward `get` expression per output attribute, read off the topmost
 * {@link ProjectNode}'s projection list (which the planner aligns 1:1 with output
 * attributes, expanding `select *`). The `get` half of the round-trip; the `put`
 * half is the site's `inverse`.
 */
function collectForwardExprs(root: RelationalPlanNode): Map<number, AST.Expression> {
	const map = new Map<number, AST.Expression>();
	const project = findProjectNode(root);
	if (project) {
		for (const p of project.getProjections()) map.set(p.attributeId, p.node.expression);
	}
	return map;
}

/** The topmost {@link ProjectNode} in a planned body's relational spine, or undefined. */
function findProjectNode(node: PlanNode): ProjectNode | undefined {
	if (node instanceof ProjectNode) return node;
	for (const child of node.getRelations()) {
		const found = findProjectNode(child);
		if (found) return found;
	}
	return undefined;
}

/** Numeric probes for the `get ∘ put = id` check — distinct points pin any affine map. */
const ROUND_TRIP_PROBES: readonly number[] = [7, 13, -5];

/**
 * PutGet identity probe: is the composed `get ∘ put` the identity on the writable
 * value? For each probe `w`, lowers it through the `put` inverse to a base value
 * and re-applies the forward `get`, requiring `get(put(w)) === w`. Sound because a
 * writable column's `get` and the inverse's `put` are built **only** from the
 * law-gated invertibility registry's closed vocabulary (column ref, `± k`, no-op
 * cast, collate), which {@link evalClosed} evaluates exactly; an expression outside
 * it yields `undefined` and reds (the analysis cannot prove faithfulness).
 *
 * Exported as the pure core the operational harness's injected-violation self-test
 * drives (an unfaithful forward/inverse pair must red), mirroring the harness's
 * `injected-widening` / `injected-getput` cores.
 */
export function getPutComposesToIdentity(
	forward: AST.Expression,
	inverse: (written: AST.Expression) => AST.Expression,
): boolean {
	for (const w of ROUND_TRIP_PROBES) {
		const baseVal = evalClosed(inverse({ type: 'literal', value: w }), undefined); // put: written → base
		if (baseVal === undefined) return false;
		const got = evalClosed(forward, baseVal); // get: base → written
		if (got === undefined || got !== w) return false;
	}
	return true;
}

/**
 * Synchronous evaluator over the **closed** invertibility-registry vocabulary —
 * literal (int/real), the bound column (`columnValue`), `+`/`-`/`*` binary, unary
 * `±`, and the value-preserving `cast`/`collate` wrappers. Returns `undefined` for
 * anything outside that set (the signal that the expression is not a registry
 * round-trip term). Total and side-effect-free — NOT a general expression
 * interpreter; the writable fragment never contains anything else.
 */
function evalClosed(expr: AST.Expression, columnValue: number | undefined): number | undefined {
	switch (expr.type) {
		case 'literal': {
			const v = (expr as AST.LiteralExpr).value;
			if (typeof v === 'number') return v;
			if (typeof v === 'bigint') return Number(v);
			return undefined;
		}
		case 'column':
			return columnValue;
		case 'cast':
			return evalClosed((expr as AST.CastExpr).expr, columnValue);
		case 'collate':
			return evalClosed((expr as AST.CollateExpr).expr, columnValue);
		case 'unary': {
			const u = expr as AST.UnaryExpr;
			const o = evalClosed(u.expr, columnValue);
			if (o === undefined) return undefined;
			if (u.operator === '-') return -o;
			if (u.operator === '+') return o;
			return undefined;
		}
		case 'binary': {
			const b = expr as AST.BinaryExpr;
			const l = evalClosed(b.left, columnValue);
			const r = evalClosed(b.right, columnValue);
			if (l === undefined || r === undefined) return undefined;
			switch (b.operator) {
				case '+': return l + r;
				case '-': return l - r;
				case '*': return l * r;
				default: return undefined;
			}
		}
		default:
			return undefined;
	}
}

/**
 * Whether a residual predicate is negation-free — `viewComplement` carries the σ
 * conjuncts verbatim, so the presence of `not` / `is not null` / `!=` (`<>`) /
 * `not between` means the complement is **not** honestly determined and the
 * round-trip check must degrade to the safe verdict. A reflective walk mirroring
 * {@link collectColumnRefNames}.
 */
function isNegationFree(expr: AST.Expression): boolean {
	const stack: AST.AstNode[] = [expr as AST.AstNode];
	while (stack.length > 0) {
		const node = stack.pop()!;
		if (node.type === 'unary') {
			const op = (node as AST.UnaryExpr).operator;
			if (op === 'NOT' || op === 'IS NOT NULL') return false;
		}
		if (node.type === 'binary' && ((node as AST.BinaryExpr).operator === '!=' || (node as AST.BinaryExpr).operator === '<>')) {
			return false;
		}
		if (node.type === 'between' && (node as AST.BetweenExpr).not === true) return false;
		for (const key of Object.keys(node)) {
			const value = (node as unknown as Record<string, unknown>)[key];
			if (!value) continue;
			if (Array.isArray(value)) {
				for (const item of value) {
					if (item && typeof item === 'object' && 'type' in item) stack.push(item as AST.AstNode);
				}
			} else if (typeof value === 'object' && 'type' in (value as object)) {
				stack.push(value as AST.AstNode);
			}
		}
	}
	return true;
}

/**
 * Best-effort structural entailment of an inverse's `domain` by the residual
 * predicate — the residual's AND-conjuncts include the domain verbatim. Unreachable
 * today (the shipped registry's profiles carry no `domain`); the conservative seam
 * for a future domain-restricted profile (an un-entailed domain ⇒ a value the view
 * admits could be stored that `get` cannot reproduce ⇒ red).
 */
function domainEntailedBy(domain: AST.Expression, residual: AST.Expression | undefined): boolean {
	if (residual === undefined) return false;
	const conjuncts: AST.Expression[] = [];
	const split = (e: AST.Expression): void => {
		if (e.type === 'binary' && (e as AST.BinaryExpr).operator === 'AND') {
			split((e as AST.BinaryExpr).left);
			split((e as AST.BinaryExpr).right);
		} else {
			conjuncts.push(e);
		}
	};
	split(residual);
	const target = expressionToString(domain);
	return conjuncts.some(c => expressionToString(c) === target);
}

// ---------------------------------------------------------------------------
// Authored inverses (`with inverse`) — PutGet by enumeration, GetPut advisory.
// See docs/lens.md § Computed and Generated Columns (authored inverses) and
// docs/vu-inverses.md § Authored inverses (law treatment).
// ---------------------------------------------------------------------------

/** The authored put payload off a resolved {@link ResolvedBaseSite}. */
type AuthoredSite = NonNullable<ResolvedBaseSite['authored']>;

/** Enumeration cap — a CHECK `in (...)` domain larger than this degrades to safe. */
const ENUM_DOMAIN_CAP = 64;

/** The outcome of the PutGet composition enumeration over one authored column. */
type PutGetEnumeration =
	| { readonly kind: 'proved'; readonly injective: boolean; readonly domain: readonly SqlValue[] }
	| { readonly kind: 'violation'; readonly value: SqlValue; readonly got: SqlValue; readonly domain: readonly SqlValue[] }
	| { readonly kind: 'indeterminate'; readonly domain?: readonly SqlValue[] };

/**
 * Emits the law-treatment diagnostics for one authored-inverse column (firing-rule
 * branch 3) from its **cached** {@link PutGetEnumeration} (computed once in
 * {@link analyzeRoundTrip}, never re-run here):
 *
 *  - **PutGet** (`forward(inverse(v)) ≡ v`) — proved by composition over the
 *    logical column's enumerable CHECK `in (...)` domain
 *    ({@link provePutGetByEnumeration}). A value that fails to reproduce is the
 *    hard `lens.putget-violation` error (a put that loses the written value is
 *    never acceptable), sited at the column and naming the offending value. No
 *    enumerable domain / non-const-foldable composition → degrade to safe
 *    (admit; mutation-time behavior governs — the prover's usual posture, no
 *    advisory for the unverified case).
 *  - **GetPut** — surrendered by design for a non-injective forward (a
 *    write-through normalizes the base value to the inverse's representative):
 *    the acknowledgeable `lens.getput-lossy` advisory, suppressed only when the
 *    enumeration also proves the forward bijective
 *    ({@link proveForwardInjective}). Suppressed wholesale on a read-only table
 *    (mutations never run the put — same gate as `lens.no-backing-index`); the
 *    PutGet error is NOT read-only-gated, mirroring branch (1)'s posture that a
 *    provably unsound declared write path is an authoring error regardless.
 *
 * The advisory's fingerprint carries the rendered domain values, so a CHECK
 * list change (the domain gains a value) re-surfaces an acknowledgment.
 */
function emitAuthoredInverseDiagnostics(
	ctx: ProveContext,
	column: string,
	result: PutGetEnumeration,
	readOnly: boolean,
	errors: LensDiagnostic[],
	warnings: LensDiagnostic[],
): void {
	if (result.kind === 'violation') {
		errors.push({
			code: 'lens.putget-violation',
			severity: 'error',
			site: { table: ctx.table.name, column },
			message: `lens: authored inverse on '${ctx.table.name}.${column}' violates PutGet — writing ${renderSqlValue(result.value)} stores a basis image that reads back as ${renderSqlValue(result.got)}; forward(inverse(v)) must reproduce every value of the column's CHECK domain (fix the 'with inverse' expression or the forward mapping)`,
		});
		return;
	}
	if (result.kind === 'proved' && result.injective) return; // bijective over the enumerated domains ⇒ GetPut holds too
	if (readOnly) return; // the put never runs on a read-only table — the lossy advisory is moot

	warnings.push({
		code: 'lens.getput-lossy',
		severity: 'warning',
		site: { table: ctx.table.name, column },
		message: `lens: column '${ctx.table.name}.${column}' writes through an authored inverse whose forward mapping is not proven injective — GetPut is surrendered (a write-through normalizes the stored basis value to the inverse's representative). Acknowledge with 'quereus.lens.ack.getput-lossy:${column.toLowerCase()}' if intentional, or make the forward bijective over enumerable CHECK domains.`,
		fingerprintInputs: {
			...buildFingerprint(ctx, [column], false),
			...(result.domain ? { domainValues: result.domain.map(renderSqlValue).sort() } : {}),
		},
	});
}

/**
 * PutGet by composition: per logical-domain value `v`, lower `v` through every
 * authored put (substituting the `new.<col>` refs with the literal), then re-read
 * it through the forward `get` with each referenced base column bound to its put
 * image — requiring `forward(inverse(v)) ≡ v` under SQL value equality.
 *
 * Preconditions (any miss ⇒ `indeterminate`, the degrade-to-safe signal):
 * a forward expression resolved off the projection; a single basis source (the
 * forward's column refs name-match against put targets — ambiguous past
 * single-source); an inverse that is a function of the written column alone
 * (every `new.*` ref resolves to this column); a deterministic, subquery-free
 * forward + puts ({@link constEvaluable} — the composition is evaluated with the
 * const evaluator only, never a vtab read); and every forward column ref covered
 * by a put target. A definite per-value violation wins over another value's
 * evaluation failure (it is a proven law break either way).
 */
function provePutGetByEnumeration(
	ctx: ProveContext,
	column: string,
	authored: AuthoredSite,
	forward: AST.Expression | undefined,
): PutGetEnumeration {
	const li = ctx.logicalColIndex.get(column.toLowerCase());
	// Trusted accessor: a module declaring `permitsGrandfatheredCheckViolators`
	// yields no enumerable domain (a logical table carries no module, so this is
	// a no-op gate here today — but the accessor keeps every prover read of CHECK
	// facts behind the capability gate).
	const domain = li !== undefined ? enumerableDomain(getTrustedCheckExtraction(ctx.table), li) : undefined;
	if (!domain) return { kind: 'indeterminate' };

	const oi = ctx.outputIndex.get(column.toLowerCase());
	if (forward === undefined || ctx.basisSource === undefined || oi === undefined) return { kind: 'indeterminate', domain };
	for (const refIdx of authored.newRefIndex.values()) {
		if (refIdx !== oi) return { kind: 'indeterminate', domain };
	}
	if (!constEvaluable(ctx.db, forward) || authored.puts.some(p => !constEvaluable(ctx.db, p.expr))) {
		return { kind: 'indeterminate', domain };
	}
	const putTargets = new Set(authored.puts.map(p => p.baseColumn.toLowerCase()));
	if (collectColumnRefNames(forward).some(n => !putTargets.has(n.toLowerCase()))) {
		return { kind: 'indeterminate', domain }; // the forward reads a base column the inverse does not determine
	}

	// `forward(inverse(v))` plus the inverse's basis image, or undefined when any
	// step is not const-evaluable.
	const composition = (v: SqlValue): { got: SqlValue; base: ReadonlyMap<string, SqlValue> } | undefined => {
		const base = new Map<string, SqlValue>();
		for (const p of authored.puts) {
			const bv = evalDeployConstant(ctx.db, substituteNewRefs(p.expr, () => ({ type: 'literal', value: v })));
			if (bv === undefined) return undefined;
			base.set(p.baseColumn.toLowerCase(), bv);
		}
		const got = evalDeployConstant(ctx.db, substituteBaseRefs(forward, base));
		return got === undefined ? undefined : { got, base };
	};

	let indeterminate = false;
	const putImages: ReadonlyMap<string, SqlValue>[] = [];
	for (const v of domain) {
		const r = composition(v);
		if (r === undefined) { indeterminate = true; continue; }
		if (!sqlValueEquals(r.got, v)) return { kind: 'violation', value: v, got: r.got, domain };
		putImages.push(r.base);
	}
	if (indeterminate) return { kind: 'indeterminate', domain };
	return { kind: 'proved', injective: proveForwardInjective(ctx, authored, forward, domain, putImages), domain };
}

/**
 * Forward injectivity over the basis column's own enumerable CHECK domain. With
 * PutGet proved over the logical domain, an injective forward whose image stays
 * *inside* that logical domain — **and** an inverse whose images stay inside the
 * basis domain (`putImages`, recorded by the PutGet enumeration) — makes the
 * pair bijective between the two enumerated domains, so GetPut holds
 * (`put(get(b)) = b` for every basis value) and the lossy advisory is
 * suppressed. The put-image membership check is load-bearing: PutGet forces the
 * inverse injective into the basis domain (|logical| ≤ |basis|), forward
 * injectivity forces |basis| ≤ |logical|, so both are bijections and the
 * inverse is exactly forward⁻¹ — without it, an inverse image *outside* the
 * basis domain (which PutGet can still pass through the forward's catch-all
 * arm) breaks the counting and GetPut fails for a real stored value.
 * Conservative: requires a single put target backed by a NOT NULL basis column
 * (a nullable basis admits a value outside the enumeration) and a
 * const-evaluable, never-NULL forward image at every basis value. The forward's
 * refs ⊆ put targets was already established by the caller, so the single
 * binding covers every ref.
 */
function proveForwardInjective(
	ctx: ProveContext,
	authored: AuthoredSite,
	forward: AST.Expression,
	logicalDomain: readonly SqlValue[],
	putImages: ReadonlyArray<ReadonlyMap<string, SqlValue>>,
): boolean {
	const basis = ctx.basisSource;
	if (!basis || authored.puts.length !== 1) return false;
	const put = authored.puts[0];
	const bi = basis.columnIndexMap.get(put.baseColumn.toLowerCase());
	if (bi === undefined || !basis.columns[bi]?.notNull) return false;
	// Trusted accessor: when the basis module declares
	// `permitsGrandfatheredCheckViolators`, stored basis rows may violate the
	// declared CHECK, so its enum domain cannot witness the bijection — the
	// extraction is empty and the injectivity proof conservatively fails
	// (matching the gate on `TableReferenceNode.computePhysical`).
	const basisDomain = enumerableDomain(getTrustedCheckExtraction(basis), bi);
	if (!basisDomain) return false;

	for (const image of putImages) {
		const bv = image.get(put.baseColumn.toLowerCase());
		if (bv === undefined || !basisDomain.some(b => sqlValueEquals(b, bv))) {
			return false; // the inverse writes outside the basis domain — not a bijection witness
		}
	}

	const seen: SqlValue[] = [];
	for (const b of basisDomain) {
		const got = evalDeployConstant(ctx.db, substituteBaseRefs(forward, new Map([[put.baseColumn.toLowerCase(), b]])));
		if (got === undefined || got === null) return false;
		if (!logicalDomain.some(v => sqlValueEquals(v, got))) return false; // image escapes the PutGet-proved domain
		if (seen.some(s => sqlValueEquals(s, got))) return false;           // two basis values collapse — not injective
		seen.push(got);
	}
	return true;
}

/**
 * The enumerable CHECK domain of one column: the literal `in (...)` value list,
 * intersected across multiple enum CHECKs and filtered through any recognized
 * range CHECK on the same column — the enumeration must never include a value
 * the declared CHECK surface already excludes, since a false
 * `lens.putget-violation` would block a sound deploy. NULLs are dropped (an
 * `in` list never admits one). Undefined when no enum constraint exists, the
 * filtered domain is empty, or it exceeds {@link ENUM_DOMAIN_CAP}.
 */
function enumerableDomain(extraction: CheckExtraction, columnIndex: number): SqlValue[] | undefined {
	let values: SqlValue[] | undefined;
	for (const dc of extraction.domainConstraints) {
		if (dc.column !== columnIndex || dc.kind !== 'enum') continue;
		const list = dc.values.filter(v => v !== null);
		values = values === undefined ? list : values.filter(v => list.some(w => sqlValueEquals(v, w)));
	}
	if (values === undefined) return undefined;
	for (const dc of extraction.domainConstraints) {
		if (dc.column !== columnIndex || dc.kind !== 'range') continue;
		values = values.filter(v => withinRange(v, dc));
	}
	if (values.length === 0 || values.length > ENUM_DOMAIN_CAP) return undefined;
	return values;
}

/** Whether `v` satisfies a recognized range domain constraint. */
function withinRange(v: SqlValue, r: Extract<DomainConstraint, { kind: 'range' }>): boolean {
	if (r.min !== undefined) {
		const c = compareSqlValues(v, r.min);
		if (r.minInclusive ? c < 0 : c <= 0) return false;
	}
	if (r.max !== undefined) {
		const c = compareSqlValues(v, r.max);
		if (r.maxInclusive ? c > 0 : c >= 0) return false;
	}
	return true;
}

/**
 * Whether an expression is sound to fold at deploy with the const evaluator:
 * deterministic functions only and no subquery —
 * {@link containsNonDeterministicCall} flags both (a vtab read can never be a
 * deploy-time constant). An unregistered function is treated deterministic; its
 * evaluation failing falls through {@link evalDeployConstant}'s degrade anyway.
 */
function constEvaluable(db: Database, expr: AST.Expression): boolean {
	const isDeterministic = (name: string, argc: number): boolean => {
		const fn = db.schemaManager.findFunction(name, argc) ?? db.schemaManager.findFunction(name, -1);
		return fn ? (fn.flags & FunctionFlags.DETERMINISTIC) !== 0 : true;
	};
	return !containsNonDeterministicCall(expr, isDeterministic);
}

/** Replace each (qualifier-agnostic) base-column reference with its literal image. */
function substituteBaseRefs(expr: AST.Expression, baseImage: ReadonlyMap<string, SqlValue>): AST.Expression {
	return transformExpr(expr, col => {
		const v = baseImage.get(col.name.toLowerCase());
		return v === undefined ? undefined : { type: 'literal', value: v };
	});
}

/**
 * Evaluate a column-free scalar expression at deploy via the engine's own const
 * evaluator (`createRuntimeExpressionEvaluator`) — never a vtab read; the
 * expression is planned as a bare one-column SELECT so it builds in an empty
 * scope. Returns undefined (the degrade-to-safe signal) when the expression
 * fails to build, evaluates asynchronously (not a deploy-time constant), or
 * throws.
 */
function evalDeployConstant(db: Database, expr: AST.Expression): SqlValue | undefined {
	try {
		const stmt: AST.SelectStmt = { type: 'select', columns: [{ type: 'column', expr }] };
		const { plan } = db._buildPlan([stmt as AST.Statement]);
		const root = plan.getRelations()[0];
		const node = root === undefined ? undefined : findProjectNode(root)?.getProjections()[0]?.node;
		if (!node) return undefined;
		const value = createRuntimeExpressionEvaluator(db)(node);
		if (value instanceof Promise) {
			void value.catch(() => undefined); // async ⇒ not a deploy-time constant; never crash the deploy on it
			return undefined;
		}
		return value as SqlValue;
	} catch (e) {
		log('lens-prover: authored-inverse composition failed to const-evaluate, degrading to safe: %O', e);
		return undefined;
	}
}

/**
 * Maps each authored-inverse logical column (lowercased) to its **forward** `get`
 * expression (basis terms), when that forward is row-local-enforceable — a
 * subquery-free scalar over basis column refs of a **single-source** body. This
 * is the agreement predicate between the prover's CHECK realizability classifier
 * ({@link classifyCheckConstraint}: a CHECK referencing an authored column is
 * row-local exactly when this map has the column) and the write-time
 * logical→basis rewrite (`planner/mutation/lens-enforcement.ts`), which
 * substitutes the forward — `NEW.`-qualified — for the column ref so the CHECK
 * evaluates over the basis write row's logical image. The two must accept the
 * same set, or a deploy-admitted CHECK would crash at write plan time.
 *
 * The single-source condition is load-bearing: on a multi-source body the
 * forward may read a column of a *different member* than the one the put
 * writes, and the substituted `NEW.<col>` on that member's write row does not
 * carry the value — the CHECK would pass vacuously (3VL unknown) instead of
 * enforcing. The clause's put targets are bare column names, so the slot AST
 * alone cannot prove every forward ref lives on the put member; single-source
 * is the decidable conservative gate (the same posture as the prover's PutGet
 * enumeration). A multi-source CHECK over an authored column therefore reds
 * `lens.unrealizable-constraint` at deploy rather than deploying un-enforced.
 */
export function authoredForwardMap(slot: LensSlot): Map<string, AST.Expression> {
	const map = new Map<string, AST.Expression>();
	const from = slot.compiledBody.from;
	if (!from || from.length !== 1 || from[0].type !== 'table') return map;
	slot.columnProvenance.forEach((p, i) => {
		const rc = slot.compiledBody.columns[i];
		if (rc && rc.type === 'column' && rc.inverse && rc.inverse.length > 0 && !containsRelationalOperand(rc.expr)) {
			map.set(p.logicalColumn.toLowerCase(), rc.expr);
		}
	});
	return map;
}

/** Reflective walk: does the expression contain a relational operand (subquery / exists / in-subquery)? */
function containsRelationalOperand(expr: AST.Expression): boolean {
	const stack: AST.AstNode[] = [expr as AST.AstNode];
	while (stack.length > 0) {
		const node = stack.pop()!;
		if (node.type === 'subquery' || node.type === 'exists') return true;
		if (node.type === 'in' && (node as AST.InExpr).subquery) return true;
		for (const key of Object.keys(node)) {
			const value = (node as unknown as Record<string, unknown>)[key];
			if (!value) continue;
			if (Array.isArray(value)) {
				for (const item of value) {
					if (item && typeof item === 'object' && 'type' in item) stack.push(item as AST.AstNode);
				}
			} else if (typeof value === 'object' && 'type' in (value as object)) {
				stack.push(value as AST.AstNode);
			}
		}
	}
	return false;
}

/** SQL value equality for the enumeration (NULL equals only NULL — identity, not three-valued `=`). */
function sqlValueEquals(a: SqlValue, b: SqlValue): boolean {
	if (a === null || b === null) return a === null && b === null;
	return compareSqlValues(a, b) === 0;
}

/** Render a domain value for a sited message / fingerprint (text quoted, so '1' ≠ 1). */
function renderSqlValue(v: SqlValue): string {
	if (v === null) return 'NULL';
	return typeof v === 'string' ? `'${v}'` : String(v);
}

// ---------------------------------------------------------------------------
// Constraint realizability + obligation classification
// ---------------------------------------------------------------------------

/**
 * Classifies every attached logical constraint into a {@link ConstraintObligation}
 * and, in the process, performs the *constraint realizability* error check
 * (`lens.unrealizable-constraint`): a constraint referencing a column with no
 * write path (computed lineage) is neither provable nor attachable.
 * Set-level constraints with no covering structure emit `lens.no-backing-index`.
 */
function classifyObligations(ctx: ProveContext, readOnly: boolean, bijectiveAuthored: ReadonlySet<string>, errors: LensDiagnostic[], warnings: LensDiagnostic[]): ConstraintObligation[] {
	const obligations: ConstraintObligation[] = [];
	for (const c of ctx.slot.attachedConstraints) {
		obligations.push(classifyConstraint(ctx, c, readOnly, bijectiveAuthored, errors, warnings));
	}
	return obligations;
}

function classifyConstraint(
	ctx: ProveContext,
	constraint: LogicalConstraint,
	readOnly: boolean,
	bijectiveAuthored: ReadonlySet<string>,
	errors: LensDiagnostic[],
	warnings: LensDiagnostic[],
): ConstraintObligation {
	switch (constraint.kind) {
		case 'primaryKey':
			return classifyKeyConstraint(ctx, constraint, constraint.columns.map(c => c.index), 'primary key', true, readOnly, bijectiveAuthored, errors, warnings);
		case 'unique':
			return classifyKeyConstraint(ctx, constraint, constraint.constraint.columns, constraintLabel(constraint), false, readOnly, bijectiveAuthored, errors, warnings);
		case 'check':
			return classifyCheckConstraint(ctx, constraint, errors);
		case 'foreignKey':
			return { constraint, kind: 'enforced-fk' };
		case 'notNull':
			return classifyNotNullConstraint(ctx, constraint, errors);
	}
}

/** A short human label for a constraint, for sited messages. */
function constraintLabel(constraint: LogicalConstraint): string {
	switch (constraint.kind) {
		case 'primaryKey': return 'primary key';
		case 'check': return constraint.constraint.name ? `check '${constraint.constraint.name}'` : 'check';
		case 'unique': return constraint.constraint.name ? `unique '${constraint.constraint.name}'` : 'unique';
		case 'foreignKey': return constraint.constraint.name ? `foreign key '${constraint.constraint.name}'` : 'foreign key';
		case 'notNull': return `not null on '${constraint.columnName}'`;
	}
}

/**
 * The effective constraint-level default conflict action a duplicate key would
 * resolve to absent a statement-level OR clause. A key declaring REPLACE / IGNORE
 * here is rejected at deploy when the realizing path cannot honor it: the
 * commit-time set-level scan can only ABORT (see {@link classifyKeyConstraint}),
 * and the row-time path honors the *basis* UC's action, not the logical key's
 * (see {@link rejectRowTimeConflictAction}) — both raise `lens.unenforceable-conflict-action`.
 *
 *  - `unique` → the constraint's own `defaultConflict`.
 *  - `primaryKey` → {@link resolvePkDefaultConflict}: table-level
 *    `PRIMARY KEY (...) ON CONFLICT <action>` (`TableSchema.primaryKeyDefaultConflict`),
 *    else the column-level `ColumnSchema.defaultConflict` on **any** PK column —
 *    the precedence the runtime resolvers actually use, so the deploy-time check
 *    agrees with what a duplicate would resolve to. A non-first PK column's
 *    `not null on conflict replace` counts (it sets `defaultConflict` too); the
 *    PK's action is NOT on the `LogicalConstraint` node, so it must come from `ctx.table`.
 *
 * Returns undefined when no action is declared (⇒ ABORT, which the scan honors).
 */
function effectiveKeyDefaultConflict(ctx: ProveContext, constraint: LogicalConstraint): ConflictResolution | undefined {
	switch (constraint.kind) {
		case 'unique':
			return constraint.constraint.defaultConflict;
		case 'primaryKey':
			return resolvePkDefaultConflict(ctx.table);
		default:
			return undefined;
	}
}

/** Render a conflict action for a sited message; an absent action resolves to ABORT. */
function conflictActionName(action: ConflictResolution | undefined): string {
	return ConflictResolution[action ?? ConflictResolution.ABORT].toLowerCase();
}

/**
 * Classifies a key constraint (primary key / unique). Empty key ⇒ vacuous
 * (singleton).
 *
 * A column with no write path (computed lineage) is handled by class:
 *  - a **unique** over such a column is `lens.unrealizable-constraint` (you
 *    declared uniqueness on a value with no write path — it can be neither proved
 *    nor enforced), *unless* the column is authored-**bijective**
 *    (`bijectiveAuthored`): the proven bijection transports uniqueness to/from its
 *    put target, so it has a sound write path and is admitted to the key (proved
 *    via transport when the put target is a basis key, else the commit-time scan
 *    over the forward image enforces it) — the same realizability a bijective PK
 *    column enjoys;
 *  - a **primary key** over such a column makes the whole table *read-only*
 *    (owned by {@link checkKeyReconstructibility}, surfaced as the
 *    `lens.pk-not-reconstructible` warning) — NOT a blocking error, because the
 *    table still deploys for reads.
 *
 * Otherwise: proved by the body's effective key (`proveEffectiveKeyUnique`) **or**
 * by **bijection transport** ({@link proveKeyByBijectionTransport} — every key column
 * bare-reconstructible or authored-bijective, mapping to a declared basis key over
 * the put targets) ⇒ `proved`; else `enforced-set-level`, row-time when a basis
 * covering structure answers it, commit-time (+ `lens.no-backing-index` warning) when
 * none does. The warning is suppressed for a read-only table — its set-level
 * enforcement is moot.
 *
 * Whenever the key classifies `proved`, a **governing** basis key (if any) resolves a
 * write-through duplicate, not the logical key — so a logical `on conflict
 * replace`/`ignore` the governing key does not itself carry would be silently dropped.
 * That check ({@link rejectBasisGovernedConflictActionForProvedKey}) is **decoupled**
 * from the transport proof's exact-match/single-source gate: it identifies the governing
 * basis keys by a SUBSET search over the mapped basis columns
 * ({@link findGoverningBasisKeys}) — so a logical key that is a strict superkey of a
 * smaller basis key (body-proved, transport-undefined) is covered, not just an exact
 * transport match — and rejects conservatively when governance cannot be pinned (a
 * multi-source body, where the 1:1 column mapping and the superkey soundness argument do
 * not transfer). A genuinely basis-keyless body proof (a GROUP BY aggregate over plain
 * columns with no basis UC over the key, an FD-closure key, etc.) subsumes no declared
 * basis key, so its `on conflict` is vacuous and deploys clean. Mirrors the row-time and
 * commit-time arms.
 *
 * A strict superkey of a NOT-NULL basis key is *over*-enforced — distinct from the
 * conflict-action mismatch above. The logical `unique(a, b)` permits two rows differing
 * only in `b`, but the basis NOT-NULL `unique(a)` that body-proved it rejects them: the
 * basis enforces uniqueness on a *subset* of the logical key's columns, so it is stricter
 * than the logical declaration advertises. That is sound (every logical invariant still
 * holds) but surprising, so it surfaces as the acknowledgeable warning
 * `lens.over-restrictive-basis-key` ({@link warnOverRestrictiveBasisKey}), emitted from this
 * `proved` branch beside the conflict-action check (the only branch a `proved` logical key
 * can sit over a strict-subset NOT-NULL basis key — a nullable basis sub-key yields only a
 * guarded FD and never classifies `proved`). It is a warning, not an error: the schema is
 * sound, just enforced more tightly than declared.
 */
function classifyKeyConstraint(
	ctx: ProveContext,
	constraint: LogicalConstraint,
	logicalColumns: readonly number[],
	label: string,
	isPrimaryKey: boolean,
	readOnly: boolean,
	bijectiveAuthored: ReadonlySet<string>,
	errors: LensDiagnostic[],
	warnings: LensDiagnostic[],
): ConstraintObligation {
	if (logicalColumns.length === 0) {
		return { constraint, kind: 'vacuous' };
	}

	const columnNames = logicalColumns.map(i => ctx.table.columns[i]?.name ?? `#${i}`);
	const outCols: number[] = [];
	for (const li of logicalColumns) {
		const name = ctx.table.columns[li]?.name;
		const oi = name !== undefined ? ctx.outputIndex.get(name.toLowerCase()) : undefined;
		const reachable = oi !== undefined && isReconstructibleColumn(ctx, name!);
		// An authored-bijective column is not bare-reconstructible, but the proven
		// bijection transports uniqueness to/from its put target — so it has a sound
		// write path and is admitted to the key just like a bijective PK column (the
		// bijection-transport proof below maps it to its basis column, and absent a
		// basis key the commit-time scan over the forward image enforces it). A
		// non-bijective authored column (or a computed/opaque column) still has no
		// proven write path: uniqueness over it is neither provable nor enforceable.
		const authoredBijective = name !== undefined && bijectiveAuthored.has(name.toLowerCase());
		if (!reachable && !isPrimaryKey && !authoredBijective) {
			errors.push({
				code: 'lens.unrealizable-constraint',
				severity: 'error',
				site: { table: ctx.table.name, constraint: label, column: name },
				message: `lens: ${label} on '${ctx.table.name}' references column '${name ?? `#${li}`}', which has no write path at the lens boundary (computed lineage); the constraint can be neither proved nor enforced`,
			});
			return { constraint, kind: 'enforced-set-level', mode: 'commit-time' };
		}
		// A PK over an unreachable column (read-only, warned elsewhere) or an
		// authored-bijective key column: fall through to classify the obligation
		// without a blocking error.
		if (oi !== undefined) outCols.push(oi);
	}

	// A bijection-transport proof classifies the key `proved` via an authored bijection
	// onto an *exact* declared basis key (a strict superset does not prove the smaller
	// key's uniqueness, so exact-match is correct for the proof). It is NOT the gate for
	// the conflict-action check below — governance is identified independently by subset
	// (see {@link rejectBasisGovernedConflictActionForProvedKey}).
	const transport = proveKeyByBijectionTransport(ctx, logicalColumns, bijectiveAuthored);

	// Body proves it? (e.g. unique(x,y) over `group by x,y`, or a faithful projection
	// of a basis key.) Only when every column resolved to the output.
	const bodyProvesKey = ctx.root != null
		&& outCols.length === logicalColumns.length
		&& proveEffectiveKeyUnique(ctx.root, outCols).proved;

	// Proved by BODY or by BIJECTION TRANSPORT (every key column bare-reconstructible
	// or authored-bijective, mapping to a declared basis key). Both are `proved` —
	// zero runtime enforcement, a governing basis key forbids the colliding tuple.
	// Transport subsumes both the basis-PK and basis-UNIQUE cases, so an authored key
	// never needs the row-time/covering path.
	if (bodyProvesKey || transport) {
		// A governing basis key (a declared basis key whose columns ⊆ the logical key's
		// mapped basis columns) resolves a write-through duplicate, not the logical key —
		// so a logical `on conflict replace`/`ignore` it does not itself carry is silently
		// dropped. Reject the mismatch regardless of which arm proved the key (a populated
		// `errors` blocks the deploy regardless of the obligation kind, exactly as the
		// row-time arm does). A genuinely basis-keyless proof governs no basis key, so its
		// `on conflict` is vacuous and left untouched.
		rejectBasisGovernedConflictActionForProvedKey(ctx, constraint, logicalColumns, bijectiveAuthored, label, columnNames, readOnly, errors);
		// Diagnostic-only: a logical key proved over a strict-subset NOT-NULL basis key is
		// sound but over-enforced (the basis rejects writes the logical schema permits).
		// Surface the surprise as a warning; this does not alter the proved classification.
		warnOverRestrictiveBasisKey(ctx, logicalColumns, bijectiveAuthored, label, columnNames, readOnly, warnings);
		return { constraint, kind: 'proved' };
	}

	// Not proved → enforced set-level. Row-time iff a basis row-time covering
	// structure answers it (a non-stale covering MV); commit-time otherwise.
	const covering = findBasisCovering(ctx, logicalColumns);
	if (covering) {
		rejectRowTimeConflictAction(ctx, constraint, covering, label, columnNames, readOnly, errors);
		return { constraint, kind: 'enforced-set-level', mode: 'row-time', structure: covering.ref };
	}

	if (!readOnly) {
		warnings.push({
			code: 'lens.no-backing-index',
			severity: 'warning',
			site: { table: ctx.table.name, constraint: label },
			message: `lens: ${label} on '${ctx.table.name}' (${columnNames.map(c => `'${c}'`).join(', ')}) has no basis covering structure — it enforces via an O(n) commit-time scan. Add an explicit basis covering materialized view (order by the constraint columns) to upgrade to row-time enforcement; row-time conflict resolution (insert or replace / or ignore) requires that structure and is otherwise rejected.`,
			fingerprintInputs: buildFingerprint(ctx, columnNames, false),
		});

		// A commit-time scan can only ABORT. A constraint-level `on conflict
		// replace`/`ignore` (the PK's via `ctx.table`, a UNIQUE's via its own
		// `defaultConflict`) is an action the scan can never honor — an unsound
		// schema. Block it at deploy here rather than silently over-ABORTing per
		// write: the statement-level gate (`rejectLensSetLevelConflictResolution`)
		// only inspects `req.stmt.onConflict`, so the constraint-level channel never
		// reaches it. ABORT / FAIL / ROLLBACK (and no declared action) are fine.
		const effectiveConflict = effectiveKeyDefaultConflict(ctx, constraint);
		if (effectiveConflict === ConflictResolution.REPLACE || effectiveConflict === ConflictResolution.IGNORE) {
			errors.push({
				code: 'lens.unenforceable-conflict-action',
				severity: 'error',
				site: { table: ctx.table.name, constraint: label },
				message: `lens: ${label} on '${ctx.table.name}' (${columnNames.map(c => `'${c}'`).join(', ')}) declares 'on conflict replace/ignore' but has no basis covering structure, so the action cannot be honored (a commit-time scan can only ABORT). Add a basis covering materialized view (order by the key columns) to upgrade to row-time enforcement, or drop the conflict action.`,
			});
		}

		// Defensive (close-before-reachable): the commit-time count synthesis
		// (`synthesizeUniqueCountExpr`) counts ALL logical rows matching the key — it
		// does not scope by a partial-UNIQUE predicate, so a partial logical UNIQUE
		// would over-count and falsely ABORT an out-of-scope duplicate. A logical
		// declaration never sets `predicate` today (only `CREATE UNIQUE INDEX … WHERE`
		// does, a path the declaration surface never takes), so this guards an
		// invariant rather than a reachable case — reject loudly if it ever opens.
		if (constraint.kind === 'unique' && constraint.constraint.predicate !== undefined) {
			errors.push({
				code: 'lens.unrealizable-constraint',
				severity: 'error',
				site: { table: ctx.table.name, constraint: label },
				message: `lens: ${label} on '${ctx.table.name}' (${columnNames.map(c => `'${c}'`).join(', ')}) is a partial UNIQUE (declares a predicate), which is unsupported for commit-time set-level enforcement (the O(n) count scan cannot scope by the partial predicate). Add a basis covering materialized view to upgrade to row-time enforcement, or remove the partial predicate.`,
			});
		}
	}
	return { constraint, kind: 'enforced-set-level', mode: 'commit-time' };
}

/**
 * Shared core for the two basis-governed set-level conflict-action rejecters
 * (row-time covering UC, proved-transport basis key). A basis-governed key is
 * enforced by the **basis** key, whose conflict action resolves a duplicate as
 * `statement-OR ?? basis-key.defaultConflict ?? ABORT` — the *logical* key's own
 * `defaultConflict` is never consulted. So a logical `on conflict replace`/`ignore`
 * the basis key does NOT itself carry is silently dropped to ABORT at write time
 * (with no statement-level OR), violating the declared action. Reject it at deploy.
 *
 * Fires only when the logical effective action is REPLACE / IGNORE *and* differs
 * from the basis key's own action: when they match, the basis key already resolves
 * the declared action for free (the documented remediation), so there is nothing to
 * reject. ABORT / FAIL / ROLLBACK (and no declared action) never reject. Gated on
 * `!readOnly`: a read-only table never writes, so the action is moot. The two
 * callers differ only in `basis` — where the governing action and its label come
 * from — so both funnel into this one diagnostic.
 */
function rejectBasisGovernedConflictAction(
	ctx: ProveContext,
	constraint: LogicalConstraint,
	label: string,
	columnNames: readonly string[],
	readOnly: boolean,
	errors: LensDiagnostic[],
	basis: { conflict: ConflictResolution | undefined; label: string },
): void {
	if (readOnly) return;
	const eff = effectiveKeyDefaultConflict(ctx, constraint);
	if (eff !== ConflictResolution.REPLACE && eff !== ConflictResolution.IGNORE) return;
	if (eff === basis.conflict) return; // basis key honors it for free — the documented remediation

	errors.push({
		code: 'lens.unenforceable-conflict-action',
		severity: 'error',
		site: { table: ctx.table.name, constraint: label },
		message: `lens: ${label} on '${ctx.table.name}' (${columnNames.map(c => `'${c}'`).join(', ')}) declares 'on conflict ${conflictActionName(eff)}', but its backing ${basis.label} resolves a duplicate to '${conflictActionName(basis.conflict)}' — the write path honors the basis key's action, not the logical key's, so the declared action would be silently dropped. Declare the matching 'on conflict ${conflictActionName(eff)}' on the basis key, or drop the logical conflict action.`,
	});
}

/**
 * Row-time sibling of the commit-time `lens.unenforceable-conflict-action` block.
 * A row-time key is enforced by re-planning the lens write against the basis UC,
 * whose conflict action resolves as `statement-OR ?? basis-uc.defaultConflict ??
 * ABORT` (the memory / isolation / store resolvers all agree) — the *logical*
 * key's own `defaultConflict` is never consulted in that re-plan. So a logical
 * `on conflict replace`/`ignore` the backing basis UC does NOT itself carry is
 * silently dropped to ABORT at write time (with no statement-level OR), violating
 * the declared action. Delegates to {@link rejectBasisGovernedConflictAction} with
 * the covering structure's basis UC as the governing key.
 */
function rejectRowTimeConflictAction(
	ctx: ProveContext,
	constraint: LogicalConstraint,
	covering: BasisCovering,
	label: string,
	columnNames: readonly string[],
	readOnly: boolean,
	errors: LensDiagnostic[],
): void {
	rejectBasisGovernedConflictAction(ctx, constraint, label, columnNames, readOnly, errors, {
		conflict: covering.uc.defaultConflict,
		label: `covering structure '${covering.ref.name}'`,
	});
}

/**
 * The `proved`-key sibling of the row-time/commit-time `lens.unenforceable-conflict-action`
 * blocks, **decoupled** from the bijection-transport exact-match/single-source gate. A
 * `proved` key (by the body or by transport) is enforced for free by whatever declared
 * basis key stands behind the proof — never the logical key — so a logical `on conflict
 * replace`/`ignore` that governing key does not itself carry is silently dropped.
 *
 * Single-source: the governing basis keys are every declared basis key whose column set
 * is a **subset** of the logical key's mapped basis columns ({@link findGoverningBasisKeys}).
 * Soundness: the logical key ⊇ any such basis key K (as column sets, after the 1:1 mapping),
 * so two rows equal on the full logical key are equal on K — K fires on *every* logical-key
 * write-through duplicate. So:
 *  - **no governing key** ⇒ genuinely basis-keyless (a GROUP BY aggregate, an FD-closure
 *    key, …) ⇒ vacuous `on conflict`, deploy clean;
 *  - **any governing key carries a different action** ⇒ that key fires first and drops the
 *    declared action ⇒ reject. When several subset keys disagree, the basis enforcement
 *    order that decides which fires first is not soundly pinnable at deploy, so reject the
 *    moment the *first* mismatch surfaces (the ticket blesses this conservatism);
 *  - **all governing keys carry the matching action** ⇒ honored for free ⇒ deploy clean.
 * The `notNull` gate that {@link proveKeyByBijectionTransport} carries is deliberately NOT
 * applied to the mapping here: that gate is a `proved`-classification concern (a nullable
 * basis key is NULL-skipping, so it cannot back an *unconditional* proved FD); governance
 * asks only which basis key fires on a *non-null* write-through duplicate, which a nullable
 * subset basis key still governs.
 *
 * Multi-source (the mapping is undefined — no single `basisSource`): the 1:1 logical→basis
 * column mapping the subset search needs does not exist, and the superkey soundness argument
 * does not transfer across a decomposition (the logical columns come from different basis
 * rows). Governance cannot be pinned soundly, so reject conservatively. A genuinely
 * basis-keyless multi-source REPLACE shape is over-rejected by this; it is niche (and
 * conflict resolution over a decomposition write is itself not clearly supported), so the
 * over-rejection is acceptable — the escape hatch is to drop the conflict action or declare
 * it on the basis key.
 *
 * Funnels every mismatch through {@link rejectBasisGovernedConflictAction} (the single
 * diagnostic emitter), passing the first mismatched governing key as `basis`.
 */
function rejectBasisGovernedConflictActionForProvedKey(
	ctx: ProveContext,
	constraint: LogicalConstraint,
	logicalColumns: readonly number[],
	bijectiveAuthored: ReadonlySet<string>,
	label: string,
	columnNames: readonly string[],
	readOnly: boolean,
	errors: LensDiagnostic[],
): void {
	if (readOnly) return;
	const eff = effectiveKeyDefaultConflict(ctx, constraint);
	if (eff !== ConflictResolution.REPLACE && eff !== ConflictResolution.IGNORE) return;

	const basis = ctx.basisSource;
	const basisCols = basis ? mapLogicalKeyToBasisColumns(ctx, logicalColumns, bijectiveAuthored) : undefined;
	if (!basis || basisCols === undefined) {
		// Multi-source / unmappable: governance cannot be pinned — reject conservatively.
		errors.push({
			code: 'lens.unenforceable-conflict-action',
			severity: 'error',
			site: { table: ctx.table.name, constraint: label },
			message: `lens: ${label} on '${ctx.table.name}' (${columnNames.map(c => `'${c}'`).join(', ')}) declares 'on conflict ${conflictActionName(eff)}', but its body has no single-source basis-column mapping (multi-source / decomposition), so the governing basis key whose action a write-through duplicate actually resolves to cannot be pinned at deploy. Declare the matching 'on conflict ${conflictActionName(eff)}' on the basis key, or drop the logical conflict action.`,
		});
		return;
	}

	// Reject the first governing basis key whose action differs from the declared one;
	// `rejectBasisGovernedConflictAction`'s `eff === basis.conflict` early-return makes
	// the all-match (and no-governing-key) cases deploy clean.
	const mismatched = findGoverningBasisKeys(basis, basisCols)
		.find(m => basisKeyDefaultConflict(basis, m) !== eff);
	if (!mismatched) return;
	rejectBasisGovernedConflictAction(ctx, constraint, label, columnNames, readOnly, errors, {
		conflict: basisKeyDefaultConflict(basis, mismatched),
		label: basisKeyLabel(basis, mismatched),
	});
}

/**
 * Warns when a `proved` logical key is a strict **superkey** of a NOT-NULL basis key —
 * the over-enforcement sibling of {@link rejectBasisGovernedConflictActionForProvedKey},
 * emitted from the same `proved` branch. A logical `unique(a, b)` whose body proof rests on
 * a basis NOT-NULL `unique(a)` (or basis PK `(a)`) is intrinsically unique — but the basis
 * enforces uniqueness on a *subset* of the logical key's columns, so it rejects two rows
 * differing only in `b` that the logical schema advertises as valid. The schema is sound
 * (every logical invariant still holds), just stricter than declared — so this is the
 * acknowledgeable warning `lens.over-restrictive-basis-key`, never an error.
 *
 * Fires when, after mapping the logical key 1:1 to basis columns
 * ({@link mapLogicalKeyToBasisColumns}), a governing basis key
 * ({@link findGoverningBasisKeys}) is a **strict** subset of the mapped columns
 * (`governingKey.length < mappedBasisCols.length`). The strict filter excludes an
 * exact-match basis key, which enforces exactly the logical key and is fully realizable —
 * it must not warn. One warning per logical key; when several strict-subset basis keys
 * exist, the first in {@link findGoverningBasisKeys} enumeration order (the basis PK if it
 * governs, else the first declared UNIQUE) names the message — not the smallest by arity.
 *
 * Scoped to single-source `proved` keys:
 *  - `readOnly` ⇒ early return (a read-only table never writes, so the over-enforcement
 *    never materializes — the same gate as `lens.no-backing-index`);
 *  - multi-source / unmappable ⇒ {@link mapLogicalKeyToBasisColumns} is undefined ⇒ no
 *    advisory (the 1:1 logical→basis mapping the subset search needs does not exist, and
 *    the superkey argument does not transfer across a decomposition — a documented gap);
 *  - a nullable basis sub-key contributes only a guarded FD, so the logical key never
 *    classifies `proved` and this check never sees it (a documented gap).
 *
 * Diagnostic-only: it does not alter the proved classification or the returned obligation.
 */
function warnOverRestrictiveBasisKey(
	ctx: ProveContext,
	logicalColumns: readonly number[],
	bijectiveAuthored: ReadonlySet<string>,
	label: string,
	columnNames: readonly string[],
	readOnly: boolean,
	warnings: LensDiagnostic[],
): void {
	if (readOnly) return;
	const basis = ctx.basisSource;
	const basisCols = basis ? mapLogicalKeyToBasisColumns(ctx, logicalColumns, bijectiveAuthored) : undefined;
	if (!basis || basisCols === undefined) return; // multi-source / unmappable: no sound subset relation to report

	// Strict-subset governing keys only — an exact-match basis key enforces exactly the
	// logical key (fully realizable) and must not warn.
	const strictSubset = findGoverningBasisKeys(basis, basisCols)
		.filter(m => basisKeyColumnIndices(basis, m).length < basisCols.length);
	if (strictSubset.length === 0) return;

	const governing = strictSubset[0];
	const basisKeyColumns = basisKeyColumnIndices(basis, governing)
		.map(c => basis.columns[c]?.name ?? `#${c}`)
		.sort((a, b) => a.localeCompare(b));

	warnings.push({
		code: 'lens.over-restrictive-basis-key',
		severity: 'warning',
		site: { table: ctx.table.name, constraint: label },
		message: `lens: ${label} on '${ctx.table.name}' (${columnNames.map(c => `'${c}'`).join(', ')}) is a strict superkey of ${basisKeyLabel(basis, governing)} — the basis enforces uniqueness on a subset of the logical key's columns, so it will reject writes the logical schema permits (two rows differing only outside the basis key's columns cannot coexist). This is sound but stricter than the logical declaration advertises; widen the basis key to match, or narrow the logical key, to make the logical contract faithful.`,
		fingerprintInputs: {
			constraintColumns: [...columnNames],
			basisRelation: `${basis.schemaName.toLowerCase()}.${basis.name.toLowerCase()}`,
			basisKeyColumns,
		},
	});
}

/** The basis-column indices a matched basis key covers — the PK definition or the UNIQUE's columns. */
function basisKeyColumnIndices(basis: TableSchema, match: DeclaredKeyMatch): readonly number[] {
	return match.kind === 'primaryKey'
		? basis.primaryKeyDefinition.map(p => p.index)
		: match.constraint.columns;
}

/**
 * Classifies a `check` constraint. A check referencing a column with no write
 * path (computed lineage) is unrealizable (error). Otherwise it is row-local —
 * evaluable on the projected row at the write boundary. (Vacuous-by-body-predicate
 * detection is deferred; a row-local check is always sound, just possibly redundant.)
 *
 * An **authored-inverse** column ({@link authoredForwardMap}) has a write path —
 * the put expressions — and its CHECK stays row-local: the write-time rewrite
 * substitutes the column's forward `get` (`NEW.`-qualified basis terms) for the
 * ref, so the CHECK evaluates over the written basis row's logical image. The
 * map already excludes a forward the rewrite cannot substitute (subquery-
 * bearing), keeping deploy acceptance and write-time enforceability in lockstep.
 */
function classifyCheckConstraint(
	ctx: ProveContext,
	constraint: LogicalConstraint & { kind: 'check' },
	errors: LensDiagnostic[],
): ConstraintObligation {
	const label = constraintLabel(constraint);
	const authoredForwards = authoredForwardMap(ctx.slot);
	for (const ref of collectColumnRefNames(constraint.constraint.expr)) {
		const li = ctx.logicalColIndex.get(ref.toLowerCase());
		if (li === undefined) continue; // not a logical column of this table — leave to body resolution
		if (!isReconstructibleColumn(ctx, ref) && !authoredForwards.has(ref.toLowerCase())) {
			errors.push({
				code: 'lens.unrealizable-constraint',
				severity: 'error',
				site: { table: ctx.table.name, constraint: label, column: ref },
				message: `lens: ${label} on '${ctx.table.name}' references column '${ref}', which has computed lineage (no write path); a check over it cannot be enforced at the lens boundary`,
			});
			return { constraint, kind: 'enforced-row-local' };
		}
	}
	return { constraint, kind: 'enforced-row-local' };
}

/**
 * Classifies a logical column's NOT NULL declaration ({@link buildLogicalConstraints}
 * collects one per undefaulted `not null` column). Three outcomes:
 *
 *  - `proved` — the body's derived output for the column is non-nullable, so no
 *    read can yield NULL and a NULL write already fails the basis write's own
 *    NOT NULL. Every native-basis lens lands here; those writes pay nothing new.
 *  - `enforced-row-local` — the derived output is nullable (the grandfathered-
 *    basis shape, or an unplanned body): the lens write boundary must reject a
 *    NULL written to the column. Realized on the same seams as a row-local CHECK
 *    (`planner/mutation/lens-enforcement.ts` synthesizes `<col> is not null`)
 *    but reported as a NOT NULL violation naming the logical column. Forward
 *    writes only — the seams see rows being written, never stored rows, so
 *    read-side grandfathering (`permitsGrandfatheredNotNullViolators`) is
 *    untouched.
 *  - `lens.unrealizable-constraint` — computed lineage with no authored forward:
 *    the write seam never sees the column's value, so the declaration cannot be
 *    enforced — the same posture {@link classifyCheckConstraint} takes. (A
 *    column absent from the body output is left to `checkColumnCoverage`.)
 */
function classifyNotNullConstraint(
	ctx: ProveContext,
	constraint: LogicalConstraint & { kind: 'notNull' },
	errors: LensDiagnostic[],
): ConstraintObligation {
	const lc = constraint.columnName.toLowerCase();
	const oi = ctx.outputIndex.get(lc);
	if (oi === undefined) return { constraint, kind: 'enforced-row-local' }; // uncovered — checkColumnCoverage owns the diagnostic
	const outType = ctx.root?.getType().columns[oi]?.type;
	if (outType && outType.typeClass === 'scalar' && outType.nullable !== true) {
		return { constraint, kind: 'proved' };
	}
	if (!isReconstructibleColumn(ctx, constraint.columnName) && !authoredForwardMap(ctx.slot).has(lc)) {
		errors.push({
			code: 'lens.unrealizable-constraint',
			severity: 'error',
			site: { table: ctx.table.name, constraint: constraintLabel(constraint), column: constraint.columnName },
			message: `lens: not null on '${ctx.table.name}.${constraint.columnName}' cannot be enforced: the column has computed lineage (no write path), so the write boundary never sees its value; declare the column nullable, supply a default, or give the column an inverse`,
		});
	}
	return { constraint, kind: 'enforced-row-local' };
}

// ---------------------------------------------------------------------------
// Basis covering-structure resolution (row-time vs commit-time)
// ---------------------------------------------------------------------------

/** The matching basis UC and the row-time covering structure that answers it. */
interface BasisCovering {
	readonly ref: CoveringStructureRef;
	readonly uc: UniqueConstraintSchema;
}

/**
 * Resolves the basis covering structure AND the basis UNIQUE constraint backing a
 * logical key: maps each logical column → its basis column (via the single-source
 * body projection), finds a matching basis UNIQUE constraint, and returns a
 * row-time covering MV reference (`coveringStructureName` /
 * `_findRowTimeCoveringStructure`) together with that basis UC. Returning the UC
 * lets two callers inspect it: {@link classifyKeyConstraint}'s row-time
 * conflict-action check (via {@link rejectRowTimeConflictAction} — the basis UC's
 * `defaultConflict` is the action the write path actually honors) and the
 * plan-time FD re-validation ({@link computeLensAssertedKeyFds}, which re-confirms
 * currency and the basis UC's partial predicate against the *current* catalog).
 *
 * Conservative: a multi-source body, an unmapped column, or a missing basis
 * UC/structure all yield `undefined` (⇒ commit-time scan). The retired auto-index
 * is deliberately NOT consulted for a logical schema — the explicit covering MV is
 * the sole row-time structure (`docs/lens.md` § Constraint Attachment). Reads no
 * `ctx.root`, so it is safe over a lightweight (un-planned) context.
 */
function findBasisCovering(ctx: ProveContext, logicalColumns: readonly number[]): BasisCovering | undefined {
	const basis = ctx.basisSource;
	if (!basis) return undefined;

	const basisCols: number[] = [];
	for (const li of logicalColumns) {
		const name = ctx.table.columns[li]?.name;
		const bc = name !== undefined ? mappedBasisColumn(ctx, name, basis) : undefined;
		if (bc === undefined) return undefined;
		basisCols.push(bc);
	}

	const basisColSet = new Set(basisCols);
	const matching = (basis.uniqueConstraints ?? []).find(uc =>
		uc.columns.length === basisCols.length && uc.columns.every(c => basisColSet.has(c)),
	);
	if (!matching) return undefined;

	// Row-time iff a non-stale row-time covering MV answers the basis UC. A
	// merely *linked* (`coveringStructureName`) but stale / not-row-time-maintained
	// MV does NOT qualify — claiming row-time there would be unsound, so we fall
	// through to the commit-time scan.
	const rowTime = ctx.db._findRowTimeCoveringStructure(basis.schemaName, basis.name, matching);
	return rowTime ? { ref: { kind: 'materialized-view', name: rowTime.name }, uc: matching } : undefined;
}

/** The basis column index a logical column maps to under a single-source body, or undefined. */
function mappedBasisColumn(ctx: ProveContext, logicalColumn: string, basis: TableSchema): number | undefined {
	const oi = ctx.outputIndex.get(logicalColumn.toLowerCase());
	if (oi === undefined) return undefined;
	const rc = ctx.slot.compiledBody.columns[oi];
	if (rc?.type !== 'column' || rc.expr.type !== 'column') return undefined;
	return basis.columnIndexMap.get((rc.expr as AST.ColumnExpr).name.toLowerCase());
}

// ---------------------------------------------------------------------------
// Bijection-transport key proof (authored-bijective key → proved)
// ---------------------------------------------------------------------------

/**
 * The matched basis key behind a transport-proved logical key — the basis table
 * plus *which* declared key (PK or a specific UNIQUE) the transported columns form.
 * Returned by {@link proveKeyByBijectionTransport} so the caller can derive the
 * basis key's governing conflict action ({@link basisKeyDefaultConflict}), the way
 * the row-time path reads `BasisCovering.uc`.
 */
interface TransportProof {
	readonly basis: TableSchema;
	readonly match: DeclaredKeyMatch;
}

/**
 * Proves a logical key `proved` by **transporting** it onto a declared basis key
 * through a bijection. Every key column must be either bare-reconstructible (maps
 * to its basis column via {@link mappedBasisColumn}) or authored-bijective (in
 * `bijectiveAuthored`, maps to its single put-target basis column via
 * {@link authoredPutTargetBasisColumn}); the resulting basis columns must exactly
 * form a declared basis key ({@link findDeclaredKey} — the basis PK or a non-partial
 * basis UNIQUE). Returns the matched basis key ({@link TransportProof}) on success,
 * or `undefined`.
 *
 * Soundness: a bijection is injective, so distinct logical keys map to distinct
 * basis keys; the basis key forbids two rows sharing that tuple, so the logical key
 * is intrinsically unique with zero runtime enforcement. This subsumes both the
 * basis-PK and basis-UNIQUE cases (a basis UNIQUE alone entails it via the
 * bijection — no covering MV required). Absent a declared basis key over the put
 * targets it returns `undefined` and the caller falls to the commit-time fallback
 * (the honest O(n) scan over the forward image), never an unsound `proved`.
 *
 * Every key column must additionally be declared **NOT NULL**: a basis key is
 * NULL-skipping (SQL UNIQUE permits multiple all-NULL rows), so a nullable key is
 * only *conditionally* unique — the existing row-time path classifies that with a
 * guarded FD (`key → others [guard: key IS NOT NULL]`), which the unconditional
 * `proved` FD would unsoundly override. A PK column is always NOT NULL; an
 * authored-bijective column whose logical column is NOT NULL has a non-null,
 * unconditionally-unique key. A nullable key column therefore defers to
 * row-time/commit-time rather than taking the transport shortcut.
 *
 * Conservative: a multi-source body (no `basisSource`), a key column that is
 * neither bare nor authored-bijective, a nullable key column, an authored column
 * with more than one put target / a put target that is not a single bare basis
 * column, or any unmapped column all yield `undefined`.
 */
function proveKeyByBijectionTransport(ctx: ProveContext, logicalColumns: readonly number[], bijectiveAuthored: ReadonlySet<string>): TransportProof | undefined {
	const basis = ctx.basisSource;
	if (!basis) return undefined;

	// A nullable key is only conditionally unique over a NULL-skipping basis key; the
	// unconditional `proved` FD would be unsound. Defer to row-time/commit-time. This is
	// the proof's gate, NOT the governance mapper's ({@link mapLogicalKeyToBasisColumns}
	// omits it — a nullable subset basis key still governs a non-null duplicate).
	for (const li of logicalColumns) {
		if (!ctx.table.columns[li]?.notNull) return undefined;
	}
	const basisCols = mapLogicalKeyToBasisColumns(ctx, logicalColumns, bijectiveAuthored);
	if (basisCols === undefined) return undefined;
	const match = findDeclaredKey(basis, basisCols);
	return match ? { basis, match } : undefined;
}

/**
 * Maps a logical key's columns to their basis column indices under a single-source
 * body — each key column either bare-reconstructible (maps to its basis column via
 * {@link mappedBasisColumn}) or authored-bijective (maps to its single put-target basis
 * column via {@link authoredPutTargetBasisColumn}). The shared mapping loop behind both
 * the `proved` classification ({@link proveKeyByBijectionTransport}, which adds the
 * `notNull`/`findDeclaredKey` exact-match gates) and the conflict-action governance check
 * ({@link rejectBasisGovernedConflictActionForProvedKey}, which subset-searches the result).
 *
 * Deliberately carries NO `notNull` gate: that gate is a `proved`-classification concern
 * (a nullable basis key is NULL-skipping, so it cannot back an *unconditional* proved FD),
 * whereas governance asks only which basis key fires on a *non-null* write-through
 * duplicate — which a nullable subset basis key still governs.
 *
 * Returns `undefined` (the conservative signal) for a multi-source body (no `basisSource`),
 * a key column that is neither bare-reconstructible nor authored-bijective, an authored
 * column with more than one put target / a non-bare put target, or any unmapped column.
 */
function mapLogicalKeyToBasisColumns(ctx: ProveContext, logicalColumns: readonly number[], bijectiveAuthored: ReadonlySet<string>): number[] | undefined {
	const basis = ctx.basisSource;
	if (!basis) return undefined;

	const basisCols: number[] = [];
	for (const li of logicalColumns) {
		const col = ctx.table.columns[li];
		if (!col) return undefined;
		const name = col.name;
		let bc: number | undefined;
		if (isReconstructibleColumn(ctx, name)) {
			bc = mappedBasisColumn(ctx, name, basis);
		} else if (bijectiveAuthored.has(name.toLowerCase())) {
			bc = authoredPutTargetBasisColumn(ctx, name, basis);
		} else {
			return undefined; // neither bare-reconstructible nor authored-bijective
		}
		if (bc === undefined) return undefined;
		basisCols.push(bc);
	}
	return basisCols;
}

/**
 * The governing conflict action of a matched basis key — the action a duplicate
 * actually resolves to. Mirrors {@link effectiveKeyDefaultConflict}'s two arms exactly:
 * a PK uses {@link resolvePkDefaultConflict} (which also folds in any column-level
 * `defaultConflict`); a UNIQUE uses its own `defaultConflict`. Takes `(basis, match)` —
 * the pair a {@link TransportProof} carries, but also any subset-matched governing key —
 * so the transport and governance callers share it.
 */
function basisKeyDefaultConflict(basis: TableSchema, match: DeclaredKeyMatch): ConflictResolution | undefined {
	return match.kind === 'primaryKey'
		? resolvePkDefaultConflict(basis)
		: match.constraint.defaultConflict;
}

/**
 * A human-readable label for a matched basis key, for the conflict-action diagnostic.
 * There is no MV here (the proof/governance needs none), so name the basis key itself —
 * the PK / UNIQUE on the basis table, falling back to the column list when a UNIQUE is
 * unnamed (e.g. `basis unique (code)`).
 */
function basisKeyLabel(basis: TableSchema, match: DeclaredKeyMatch): string {
	if (match.kind === 'primaryKey') return `basis primary key on '${basis.name}'`;
	const uc = match.constraint;
	const ucName = uc.name !== undefined
		? `'${uc.name}'`
		: `(${uc.columns.map(c => basis.columns[c]?.name ?? `#${c}`).join(', ')})`;
	return `basis unique ${ucName}`;
}

/**
 * The basis column an authored (`with inverse`) logical column writes to, when its
 * put is a **single** assignment to one bare basis column — the put-target the
 * bijection transports onto a basis key. Reads the compiled body's authored
 * `inverse` clause directly (the same `ResultColumnInverse[]` the lineage threads).
 * Returns undefined for an authored put with more than one target (a multi-column
 * fan-out cannot land on a single basis key column) or a target name that does not
 * resolve to a basis column.
 */
function authoredPutTargetBasisColumn(ctx: ProveContext, logicalColumn: string, basis: TableSchema): number | undefined {
	const oi = ctx.outputIndex.get(logicalColumn.toLowerCase());
	if (oi === undefined) return undefined;
	const rc = ctx.slot.compiledBody.columns[oi];
	if (rc?.type !== 'column' || !rc.inverse || rc.inverse.length !== 1) return undefined;
	return basis.columnIndexMap.get(rc.inverse[0].column.toLowerCase());
}

// ---------------------------------------------------------------------------
// Read-side: declared-key FD contribution to the optimizer (the inlined-view
// boundary). See docs/lens.md § Constraint Attachment and docs/optimizer-fd.md.
// ---------------------------------------------------------------------------

/**
 * The declared logical keys a lens *proves* or *actively enforces*, encoded as
 * physical functional dependencies in the body's **output**-column-index space,
 * for the optimizer to consume at the inlined-view boundary
 * (`planner/nodes/asserted-keys-node.ts`, wired in `planner/building/select.ts`).
 *
 * Soundness is gated by the prover's per-constraint {@link ConstraintObligation}
 * kind — a false key FD is a *correctness* defect (it can make
 * DISTINCT/join-elimination/order-by-pruning drop real rows), so the gate
 * under-claims exactly like every other FD-propagation rule:
 *
 *  - `proved`   — the body intrinsically guarantees the key (the same FD surface
 *    the optimizer derives locally); contribute the **unconditional** key FD.
 *    Redundant-but-harmless when local propagation already surfaces it (`addFd`
 *    subsumes), load-bearing when the inlining context loses it.
 *  - `vacuous`  — the empty (singleton) key; contribute `∅ → all_cols` (≤1-row).
 *  - `enforced-set-level` `row-time` — a covering structure enforces uniqueness
 *    per row-write, but only over the **non-null** tuples a plain (NULL-skipping)
 *    UNIQUE governs — SQL UNIQUE permits multiple all-/any-NULL rows, so the key
 *    is conditionally unique. Contribute a **guarded** FD `key → others
 *    [guard: key IS NOT NULL]` (the same shape a partial UNIQUE emits), and only
 *    when the covering structure re-validates against the *current* catalog (it
 *    can be dropped / go stale out-of-band between deploys) and the backing basis
 *    UC is non-partial (so NULL-skip is the *entire* uniqueness scope).
 *  - `enforced-set-level` `commit-time` — **excluded**. Detection-only at commit;
 *    a duplicate can transiently exist mid-statement (read-own-writes / Halloween),
 *    so assuming the FD mid-statement is unsound.
 *  - `enforced-row-local` / `enforced-fk` — not uniqueness facts; excluded.
 *
 * Returns the (deduped) FD list, or `[]` when nothing is contributable — the
 * wiring site inlines no node for an empty list (plain views / MVs / unenforced
 * keys produce none).
 */
export function computeLensAssertedKeyFds(slot: LensSlot, db: Database): FunctionalDependency[] {
	if (!slot.obligations || slot.obligations.length === 0) return [];

	const { outputIndex, outputColumns } = buildOutputIndex(slot);
	const outColCount = outputColumns.length;
	if (outColCount === 0) return [];

	let fds: FunctionalDependency[] = [];
	for (const ob of slot.obligations) {
		const fd = assertedFdForObligation(ob, slot, db, outputIndex, outColCount);
		if (fd) fds = addFd(fds, fd);
	}
	return fds;
}

/** The asserted key FD for one obligation, or undefined when it contributes none. */
function assertedFdForObligation(
	ob: ConstraintObligation,
	slot: LensSlot,
	db: Database,
	outputIndex: ReadonlyMap<string, number>,
	outColCount: number,
): FunctionalDependency | undefined {
	const c = ob.constraint;
	if (c.kind !== 'primaryKey' && c.kind !== 'unique') return undefined; // not a key fact

	switch (ob.kind) {
		case 'vacuous':
			// The empty (singleton) key ⇒ `∅ → all_cols` (≤1-row). superkeyToFd([], n)
			// is the canonical encoding.
			return superkeyToFd([], outColCount);
		case 'proved':
			// The body unconditionally guarantees the key. Contribute it unconditionally.
			return encodeKeyFd(logicalKeyColumns(c), slot.logicalTable, outputIndex, outColCount, undefined);
		case 'enforced-set-level': {
			if (ob.mode !== 'row-time') return undefined; // commit-time gated out (unsound mid-statement)
			const logicalCols = logicalKeyColumns(c);
			// Re-validate the covering structure against the current catalog (currency)
			// and require a non-partial basis UC (so IS-NOT-NULL is the full scope).
			if (!revalidateRowTime(slot, db, logicalCols)) return undefined;
			const guard = buildNotNullGuard(logicalCols, slot.logicalTable, outputIndex);
			if (!guard) return undefined; // no nullable key column ⇒ would be `proved`, not row-time; skip
			return encodeKeyFd(logicalCols, slot.logicalTable, outputIndex, outColCount, guard);
		}
		default:
			return undefined; // enforced-row-local / enforced-fk
	}
}

/** The logical column indices forming a primary-key / unique constraint. */
function logicalKeyColumns(c: Extract<LogicalConstraint, { kind: 'primaryKey' | 'unique' }>): readonly number[] {
	return c.kind === 'primaryKey' ? c.columns.map(col => col.index) : c.constraint.columns;
}

/**
 * Encode `key → others` over the body's output columns. Maps each logical key
 * column → its output index; a key column with no output index
 * (not emitted) makes the key inexpressible (⇒ undefined). The
 * all-columns key has no non-trivial FD encoding (`superkeyToFd` ⇒ undefined) and
 * is skipped (v1). When `guard` is supplied the FD activates only under a
 * surrounding predicate that entails it (the nullable / partial-UNIQUE case).
 */
function encodeKeyFd(
	logicalColumns: readonly number[],
	table: TableSchema,
	outputIndex: ReadonlyMap<string, number>,
	outColCount: number,
	guard: GuardPredicate | undefined,
): FunctionalDependency | undefined {
	const outCols: number[] = [];
	for (const li of logicalColumns) {
		const name = table.columns[li]?.name;
		const oi = name !== undefined ? outputIndex.get(name.toLowerCase()) : undefined;
		if (oi === undefined) return undefined; // not emitted ⇒ not in the readable relation
		outCols.push(oi);
	}
	const fd = superkeyToFd(outCols, outColCount);
	if (!fd) return undefined;
	return guard ? { ...fd, guard } : fd;
}

/**
 * The `key IS NOT NULL` guard for a conditionally-unique (NULL-skipping) key — one
 * `is-null negated:true` clause per **nullable** key column (a NOT-NULL column
 * needs none; the guard checker discharges it from type info). Returns undefined
 * when every key column is already NOT NULL — that key is unconditional and would
 * have classified `proved`, so a row-time obligation over it is skipped defensively.
 */
function buildNotNullGuard(
	logicalColumns: readonly number[],
	table: TableSchema,
	outputIndex: ReadonlyMap<string, number>,
): GuardPredicate | undefined {
	const clauses: GuardClause[] = [];
	for (const li of logicalColumns) {
		const col = table.columns[li];
		if (!col) return undefined;
		if (col.notNull) continue;
		const oi = outputIndex.get(col.name.toLowerCase());
		if (oi === undefined) return undefined;
		clauses.push({ kind: 'is-null', column: oi, negated: true });
	}
	return clauses.length > 0 ? { clauses } : undefined;
}

/**
 * Re-confirm at plan time that a row-time obligation's covering structure is
 * still valid: a covering MV can be dropped or go stale out-of-band between
 * deploys (the basis is a physical schema whose DDL does not re-run the prover),
 * so the deploy-time snapshot must be re-validated. Also requires the backing
 * basis UC to be **non-partial** — a partial UNIQUE (`… where P`) makes the
 * uniqueness scope `P`, not merely NULL-skip, which the IS-NOT-NULL guard would
 * not capture. Cheap: re-resolves the covering structure against the current
 * catalog without re-planning the body.
 */
function revalidateRowTime(slot: LensSlot, db: Database, logicalColumns: readonly number[]): boolean {
	const ctx = buildLiteProveContext(slot, db);
	const covering = findBasisCovering(ctx, logicalColumns);
	return covering !== undefined && covering.uc.predicate === undefined;
}

/**
 * A lightweight prove context for plan-time covering re-resolution — every field
 * {@link findBasisCovering} reads, with `root` left undefined (the body is NOT
 * re-planned; the covering resolver is plan-independent). Keeps the per-read cost
 * to a couple of map builds + a catalog lookup.
 */
function buildLiteProveContext(slot: LensSlot, db: Database): ProveContext {
	const table = slot.logicalTable;
	const logicalColIndex = new Map<string, number>();
	table.columns.forEach((c, i) => logicalColIndex.set(c.name.toLowerCase(), i));
	const { outputIndex, outputColumns } = buildOutputIndex(slot);
	const basisSchemaName = slot.defaultBasis.schemaName;
	return {
		slot,
		db,
		table,
		logicalColIndex,
		outputColumns,
		outputIndex,
		root: undefined,
		basisSource: resolveSingleBasisSource(db.schemaManager, slot.compiledBody),
		basisSchemaName,
	};
}

// ---------------------------------------------------------------------------
// Warning: no answering structure for a declared access pattern
// ---------------------------------------------------------------------------

/**
 * `quereus.lens.access.<col>` declares an expected lookup/ordering. The advisory
 * fires when no basis ordering/index serves it. v1 best-effort: a single-source
 * body's basis table must carry an index whose leading column is the access
 * column (or have that column as the leading PK column); otherwise reads scan.
 */
function checkAnsweringStructures(ctx: ProveContext, warnings: LensDiagnostic[]): void {
	const accessTags = getReservedTagByTemplate(ctx.table.tags, 'quereus.lens.access.<col>');
	if (accessTags.length === 0) return;
	const basis = ctx.basisSource;

	for (const tag of accessTags) {
		const col = tag.segment;
		if (basisServesAccess(ctx, basis, col)) continue;
		warnings.push({
			code: 'lens.no-answering-structure',
			severity: 'warning',
			site: { table: ctx.table.name, column: col },
			message: `lens: declared access pattern 'quereus.lens.access.${col}' on '${ctx.table.name}' has no answering basis ordering or index — reads on '${col}' will scan. Add a basis index/covering materialized view ordered by '${col}'.`,
			fingerprintInputs: buildFingerprint(ctx, [col], false),
		});
	}
}

/** True iff the basis single source has an index / PK whose leading column is `accessCol`. */
function basisServesAccess(ctx: ProveContext, basis: TableSchema | undefined, accessCol: string): boolean {
	if (!basis) return false;
	const basisCol = mappedBasisColumn(ctx, accessCol, basis);
	if (basisCol === undefined) return false;
	if (basis.primaryKeyDefinition[0]?.index === basisCol) return true;
	for (const idx of basis.indexes ?? []) {
		if (idx.columns[0]?.index === basisCol) return true;
	}
	return false;
}

// ---------------------------------------------------------------------------
// Warning: partial override (informational)
// ---------------------------------------------------------------------------

/**
 * When an override covers only some columns and the remainder took the default
 * alignment, list which columns were override-authored vs gap-filled, read
 * straight off the slot's `columnProvenance`.
 */
function checkPartialOverride(ctx: ProveContext, warnings: LensDiagnostic[]): void {
	const authored = ctx.slot.columnProvenance.filter(p => p.source === 'override').map(p => p.logicalColumn);
	const gapFilled = ctx.slot.columnProvenance.filter(p => p.source === 'default').map(p => p.logicalColumn);
	if (authored.length === 0 || gapFilled.length === 0) return; // pure override or pure default — not partial

	warnings.push({
		code: 'lens.partial-override',
		severity: 'warning',
		site: { table: ctx.table.name },
		message: `lens: '${ctx.table.name}' is a partial override — override-authored column(s): ${authored.map(c => `'${c}'`).join(', ')}; default gap-filled column(s): ${gapFilled.map(c => `'${c}'`).join(', ')}`,
	});
}

// ---------------------------------------------------------------------------
// Fingerprint inputs (consumed by the sibling acknowledgment ticket)
// ---------------------------------------------------------------------------

function buildFingerprint(ctx: ProveContext, columnNames: readonly string[], hasCoveringStructure: boolean): FingerprintInputs {
	const basis = ctx.basisSource;
	return {
		constraintColumns: [...columnNames].sort((a, b) => a.localeCompare(b)),
		hasCoveringStructure,
		cardinalityBand: cardinalityBand(basis?.estimatedRows),
		basisRelation: basis ? `${basis.schemaName.toLowerCase()}.${basis.name.toLowerCase()}` : undefined,
	};
}

/** Coarse cardinality band so an acknowledgment survives ordinary row-count churn. */
function cardinalityBand(rows: number | undefined): string {
	if (rows === undefined) return 'unknown';
	if (rows === 0) return 'empty';
	if (rows < 1_000) return 'small';
	if (rows < 1_000_000) return 'medium';
	return 'large';
}

// ---------------------------------------------------------------------------
// Shared utility
// ---------------------------------------------------------------------------

/**
 * Collects every `column` reference name in an expression (best-effort reflective walk,
 * qualifier-stripped — returns each `column` node's `.name`). Shared with the lens write
 * side (`planner/mutation/lens-enforcement.ts`), which maps these refs through the slot's
 * logical→basis projection to derive a row-local CHECK's `referencedWriteRowColumns`
 * metadata — keeping the gate's notion of "write-row column" consistent with the prover's
 * notion of "row-local" (both use this walk + logical-column membership; see
 * {@link classifyCheckConstraint}).
 */
export function collectColumnRefNames(expr: AST.Expression): string[] {
	const names: string[] = [];
	const stack: AST.AstNode[] = [expr as AST.AstNode];
	while (stack.length > 0) {
		const node = stack.pop()!;
		if (node.type === 'column' && typeof (node as AST.ColumnExpr).name === 'string') {
			names.push((node as AST.ColumnExpr).name);
		}
		for (const key of Object.keys(node)) {
			const value = (node as unknown as Record<string, unknown>)[key];
			if (!value) continue;
			if (Array.isArray(value)) {
				for (const item of value) {
					if (item && typeof item === 'object' && 'type' in item) stack.push(item as AST.AstNode);
				}
			} else if (typeof value === 'object' && 'type' in (value as object)) {
				stack.push(value as AST.AstNode);
			}
		}
	}
	return names;
}

import type * as AST from '../../parser/ast.js';
import type { LensSlot, LogicalConstraint } from '../../schema/lens.js';
import type { RowConstraintSchema, ForeignKeyConstraintSchema, TableSchema, ReferencedWriteRowRelation } from '../../schema/table.js';
import { RowOpFlag, writeRowRelationCorrelation } from '../../schema/table.js';
import type { SchemaManager } from '../../schema/manager.js';
import type { BasisRelationRef } from '../../vtab/mapping-advertisement.js';
import { resolveSlotBasisSource, collectColumnRefNames, authoredForwardMap } from '../../schema/lens-prover.js';
import {
	logicalToBasisColumnMap,
	resolveLogicalReferencedColumns,
	mappedFkBasisPairs,
	matchingBasisFks,
	findLogicalParentFkRefs,
} from '../../schema/lens-fk-discovery.js';
import { transformScopedExpr, transformExpr, type ScopeContext } from './scope-transform.js';
import { raiseMutationDiagnostic } from './mutation-diagnostic.js';
import type { PlanningContext } from '../planning-context.js';
import { synthesizeFKExistsExpr, synthesizeFKNotExistsExpr } from '../building/foreign-key-builder.js';
import { createLogger } from '../../common/logger.js';

const log = createLogger('planner:lens-enforcement');

/**
 * Lens row-local constraint enforcement (the write side of the lens prover's
 * `enforced-row-local` obligation class — `docs/lens.md` § Constraint Attachment).
 *
 * The prover (`schema/lens-prover.ts`) classifies every logical constraint into a
 * {@link import('../../schema/lens-prover.js').ConstraintObligation} on
 * `LensSlot.obligations`. A scalar `check` over non-computed (reconstructible)
 * columns is `enforced-row-local`: it is evaluable on the projected row being
 * written, so a non-materialized lens enforces it for free at the write boundary.
 *
 * The view-mutation substrate re-plans a lens write against the **basis table by
 * name** (`mutation/single-source.ts`), which drops the logical context. This
 * module re-attaches it: it rewrites each row-local logical CHECK from
 * logical-column terms into basis-column terms (using the slot's reconstructible
 * projection — the same logical→basis mapping the prover proves over) and hands
 * the result to the base-table builder, which merges them into the per-row
 * `ConstraintCheckNode` exactly as if the basis table had declared them. The
 * effect: a logical CHECK fires at the lens write even when the basis carries no
 * such check.
 *
 * The `enforced-fk` obligation is also handled here (see
 * {@link collectLensForeignKeyConstraints}): each logical FK becomes a deferred,
 * basis-term `EXISTS` existence check against the schema-qualified logical parent,
 * routed through the same constraint pipeline. Because the synthesized check
 * contains an `EXISTS`, the pipeline auto-defers it to commit — matching physical
 * child-side FK timing.
 *
 * The `enforced-set-level` obligation with `mode: 'commit-time'` (a logical
 * `unique` / primary key with no basis covering structure) is the third class
 * handled here (see {@link collectLensSetLevelConstraints}): each becomes a
 * deferred `(select count(*) from <logicalView> as _u where _u.lk = NEW.bk …) <= 1`
 * CHECK over the logical key columns (logical names inside the subquery, basis
 * names on the `NEW.*` side). Because it contains a scalar subquery the pipeline
 * auto-defers it to commit, where the logical view reflects the post-mutation
 * basis: a unique key sees count `1` (itself) and a duplicate count `≥ 2` ⇒ ABORT.
 * Detection-only (no covering structure ⇒ O(n) per changed row). The row-time
 * variant (`enforced-set-level` `mode: 'row-time'`, which unlocks conflict
 * resolution) is **delivered without any code here**: by the prover's own
 * precondition a row-time obligation is backed by a matching **basis `UNIQUE` +
 * non-stale row-time covering MV**, and the single-source spine re-plans the lens
 * write to that basis table (in basis terms), so the basis UC's physical
 * enforcement-through-covering-MV path (`vtab/memory/layer/manager.ts`
 * `checkUniqueViaMaterializedView`) fires for free — an O(log n) existence lookup
 * that honors `ABORT` / `IGNORE` / `REPLACE`. That is why this collector emits
 * nothing for row-time. `proved` / `vacuous` need no enforcement.
 */

/** Marker tag stamped on a routed basis-term constraint so its lens origin is visible. */
export const LENS_BOUNDARY_ATTACHED_TAG = 'quereus.lens.boundary.attached';

/**
 * Resolves, per logical column of a slot, the **basis relation that owns it** — the
 * member relation under a decomposition advertisement, or the slot's single basis
 * source for a non-decomposition lens. The per-op decomposition gate
 * (`constraintsForOp` in `view-mutation-builder`) needs this to route a
 * lens-synthesized constraint onto the exact member op that owns each referenced
 * write-row column, instead of any sibling member op that merely shares the basis
 * column NAME (the bug this metadata fixes: two members both spelling their value
 * column `val`).
 *
 * Sourced from `slot.advertisement.storage.members` (each member's `relation` +
 * the `logicalColumn`s it backs) when a decomposition backs the table; else from
 * {@link resolveSlotBasisSource} (the single basis relation answers for every
 * column). Returns `undefined` for a column it cannot attribute (an EAV-pivot
 * logical column, an opaque slot) — the caller then omits the relation metadata for
 * that constraint, so the gate falls back to its bare-name path.
 */
function makeOwningRelationResolver(
	slot: LensSlot,
	schemaManager: SchemaManager | undefined,
): (logicalColumn: string) => BasisRelationRef | undefined {
	const members = slot.advertisement?.storage?.members;
	if (members && members.length > 0) {
		const byLogical = new Map<string, BasisRelationRef>();
		for (const m of members) {
			for (const cm of m.columns) byLogical.set(cm.logicalColumn.toLowerCase(), m.relation);
		}
		return (logicalColumn) => byLogical.get(logicalColumn.toLowerCase());
	}
	const basis = schemaManager ? resolveSlotBasisSource(slot, schemaManager) : undefined;
	if (basis) {
		const ref: BasisRelationRef = { schema: basis.schemaName, table: basis.name };
		return () => ref;
	}
	return () => undefined;
}

/**
 * Builds one relation-qualified write-row entry per `(owning relation, basis column)`
 * pair, given the referenced logical column it derives from. Returns `undefined`
 * (signalling "omit the relation metadata, fall back to the bare-name gate") if any
 * logical column's owning relation cannot be resolved — so an incomplete attribution
 * is never silently treated as a complete one. The returned list is deduped by
 * `(schema, table, column)`.
 */
function buildWriteRowRelations(
	owningRelation: (logicalColumn: string) => BasisRelationRef | undefined,
	entries: ReadonlyArray<{ logicalColumn: string; basisColumns: readonly string[] }>,
): ReferencedWriteRowRelation[] | undefined {
	const out: ReferencedWriteRowRelation[] = [];
	const seen = new Set<string>();
	for (const { logicalColumn, basisColumns } of entries) {
		const rel = owningRelation(logicalColumn);
		if (!rel) return undefined;
		for (const basisColumn of basisColumns) {
			const column = basisColumn.toLowerCase();
			const key = `${rel.schema.toLowerCase()}.${rel.table.toLowerCase()}.${column}`;
			if (seen.has(key)) continue;
			seen.add(key);
			out.push({ schema: rel.schema, table: rel.table, column });
		}
	}
	return out;
}

/**
 * The {@link ScopeContext} for the logical→basis row-local CHECK rewrite — the
 * scope-aware dual of the single-source view-column descent ({@link import('./single-source.js').makeViewScope}).
 * It rewrites a **correlated write-row** logical column to its bare basis spelling
 * while leaving a **subquery-local** ref (one a nested FROM introduces) untouched, so
 * a CHECK whose subquery correlates a write-row column with a logical≠basis name spells
 * that ref in basis terms at the constraint-build boundary instead of crashing on a
 * column the basis write row does not carry (`docs/lens.md` § Constraint Attachment).
 * The descent itself owns shadow accumulation / taint propagation; this object decides
 * per column:
 *
 * - **Qualified by the logical table name** and mapped ⇒ a qualified write-row ref ⇒
 *   replace with the basis column qualified `<corr>.<basis>` (the write-row correlation name).
 *   Any other qualifier (`Allowed.name`, a subquery FROM source) ⇒ left untouched — it
 *   resolves against the subquery FROM. This is the negative-case guard against
 *   over-rewriting a foreign ref whose name happens to equal a logical column.
 * - **Bare**, shadowed by a (this-or-enclosing) subquery FROM ⇒ left untouched
 *   (subquery-local); else, name maps ⇒ replace with `<corr>.<basis>` (a correlated
 *   write-row ref); else ⇒ left untouched.
 *
 * `<corr>` is `NEW` for a single-source lens and the per-relation
 * {@link import('../../schema/table.js').writeRowRelationCorrelation} on a multi-member
 * decomposition (`relationQualify`): two members that back distinct logical columns with the
 * SAME basis-column name (`id`,`name` → `val` on `w_id`,`w_name`) then rewrite to *distinct*
 * terms instead of collapsing to one `NEW.val`. The qualifier (rather than a bare ref) is
 * load-bearing so a ref emitted inside a correlated subquery cannot be captured by a
 * same-named column the subquery's own FROM introduces (the lens analogue of the single-source
 * descent's {@link import('./single-source.js').makeBaseQualifier}); see
 * {@link makeLensRewriteScope}'s `resolve`. At the top level it resolves to the write row
 * identically to a bare ref.
 *
 * The old top-level behavior — strip the qualifier of an *unmapped* qualified column — is
 * intentionally dropped: the prover errors at deploy on a CHECK over a non-reconstructible
 * column, so every referenced logical column maps cleanly, and a top-level CHECK qualifier
 * can only name the logical table (a CHECK reaches other tables only via a subquery).
 *
 * `unresolvableScope: 'taint'` (mirroring the view-column descent): when a subquery's FROM
 * columns are not statically resolvable (`select *` / TVF / CTE), a bare logical-column-named
 * ref inside it cannot be proven correlated — reject it from the tainted scope with a clear
 * diagnostic rather than mis-rewrite or fall through to a cryptic build crash. A foreign /
 * qualified ref in a tainted scope is still left untouched (its name is not a logical column).
 */
function makeLensRewriteScope(
	map: ReadonlyMap<string, string>,
	forwards: ReadonlyMap<string, AST.Expression>,
	logicalTableName: string,
	owningRelation: (logicalColumn: string) => BasisRelationRef | undefined,
	relationQualify: boolean,
): ScopeContext {
	const lcTable = logicalTableName.toLowerCase();
	// The write-row correlation name for a mapped logical column: on a **multi-member
	// decomposition** (`relationQualify`), the per-relation synthetic correlation keyed by
	// the column's owning member (so two members spelling their value column the same NAME
	// stay distinct — `id`'s `val` on `w_id` vs `name`'s `val` on `w_name`), else bare `NEW`.
	// Falls back to `NEW` when the owning relation cannot be attributed (an EAV-pivot / opaque
	// column) — mirroring `buildWriteRowRelations` returning `undefined` (gate falls back to
	// the bare-name path), so the rewrite and the gate metadata agree on those columns.
	const writeRowCorrelation = (name: string): string => {
		if (!relationQualify) return 'NEW';
		const rel = owningRelation(name);
		return rel ? writeRowRelationCorrelation(rel.schema, rel.table) : 'NEW';
	};
	// A rewritten write-row ref is qualified `<corr>.<basis>` — the write-row correlation
	// name the constraint scope registers (`building/constraint-builder.ts` registers
	// `new.<col>` AND `<writeRowRelationCorrelation(opSchema,opTable)>.<col>` for every
	// basis column on an INSERT/UPDATE check; row-local lens checks are INSERT|UPDATE only).
	// On a **single-source** lens `<corr>` is `NEW`; on a **multi-member decomposition** it
	// is the per-relation correlation (above) so two members whose value columns share a
	// NAME do not collapse to the same term (the `id`/`name` → `val` collision). The
	// qualifier is load-bearing for a ref emitted INSIDE a correlated subquery: a *bare*
	// basis column there would re-bind to a same-named column the subquery's own FROM
	// introduces (innermost SQL scoping) instead of the write row — silently changing the
	// CHECK's meaning when a renamed logical column's basis spelling collides with a
	// subquery-source column. This is the lens analogue of the single-source descent's
	// `makeBaseQualifier` (which qualifies with the lowered target's alias for the same
	// reason); the decomposition correlation is capture-safe for the SAME reason `NEW`
	// is — neither is a reserved keyword, but `__lens_new__…` (like `NEW`) is vanishingly
	// implausible as a user-written subquery-FROM alias, so it is not shadow-captured in
	// practice (using the bare basis table name WOULD reintroduce the capture bug `NEW` was
	// added to fix — a subquery's FROM routinely names the basis table). At the top level
	// `<corr>.<basis>` resolves to
	// the write row identically to the prior bare form, so behavior is unchanged except in
	// the collision corner. Mirrors the FK / set-level synthesizers, which likewise qualify
	// their write-row side `NEW.*`.
	//
	// An **authored-inverse** column has no single basis spelling — substitute its
	// forward `get` expression instead, every base ref `NEW.`-qualified for the same
	// capture-safety reason, so the CHECK evaluates over the written basis row's
	// logical image. `authoredForwardMap` admits only subquery-free forwards (whose
	// refs are all basis columns of the single-source FROM), so the blanket
	// re-qualification is total; the prover's CHECK realizability classifier accepts
	// exactly that same set, keeping deploy and write-time in lockstep.
	const resolve = (name: string): AST.Expression | undefined => {
		const basisColumn = map.get(name);
		if (basisColumn !== undefined) return { type: 'column', name: basisColumn, table: writeRowCorrelation(name) };
		const forward = forwards.get(name);
		if (forward !== undefined) {
			// Authored-inverse forward: `authoredForwardMap` admits only subquery-free
			// single-source forwards, so it is never decomposition-ambiguous — its base refs
			// stay on `NEW`.
			return transformExpr(forward, col => ({ type: 'column', name: col.name, table: 'NEW' }));
		}
		return undefined;
	};
	return {
		makeSubstitute: (shadowed, tainted) => (col) => {
			const name = col.name.toLowerCase();
			if (col.table) {
				// Only a ref qualified by the logical table is a (qualified) write-row ref;
				// any other qualifier resolves against the subquery FROM.
				return col.table.toLowerCase() === lcTable ? resolve(name) : undefined;
			}
			if (shadowed.has(name)) return undefined;
			if (!map.has(name) && !forwards.has(name)) return undefined;
			if (tainted) {
				raiseMutationDiagnostic({
					reason: 'unsupported-subquery-correlation',
					table: logicalTableName,
					column: col.name,
					message: `cannot enforce the logical CHECK on '${logicalTableName}': the reference '${col.name}' inside a subquery cannot be proven correlated to the write row because the subquery's source columns are not statically resolvable (a 'select *' / table-valued function / unresolved source); qualify the reference with the logical table, or restructure the CHECK`,
				});
			}
			return resolve(name);
		},
		unresolvableScope: 'taint',
		rejectDmlSubquery: () => raiseMutationDiagnostic({
			reason: 'unsupported-subquery-correlation',
			table: logicalTableName,
			message: `cannot enforce the logical CHECK on '${logicalTableName}': a data-modifying subquery (INSERT/UPDATE/DELETE) within it cannot be analysed for write-row correlation`,
		}),
	};
}

/**
 * Rewrites a logical-column CHECK expression into basis-column terms, scope-aware:
 * a top-level (or correlated) write-row logical column maps to its `NEW.<basis>` column,
 * while a subquery-local column the nested FROM introduces is left untouched. Rides the
 * shared {@link transformScopedExpr} descent over {@link makeLensRewriteScope}, entered at
 * the outermost scope — so a top-level logical column still maps to the write row exactly as
 * the prior top-level-only rewrite did, and a correlated write-row ref inside a subquery
 * (e.g. `exists (select 1 from Allowed where Allowed.name = docKey)`, `docKey`→`doc_key`) is
 * now also rewritten (to `NEW.doc_key`) rather than passing through verbatim and crashing at
 * constraint build.
 */
function rewriteToBasisTerms(
	ctx: PlanningContext,
	expr: AST.Expression,
	map: ReadonlyMap<string, string>,
	forwards: ReadonlyMap<string, AST.Expression>,
	logicalTableName: string,
	owningRelation: (logicalColumn: string) => BasisRelationRef | undefined,
	relationQualify: boolean,
): AST.Expression {
	return transformScopedExpr(ctx, makeLensRewriteScope(map, forwards, logicalTableName, owningRelation, relationQualify), expr);
}

/**
 * The lowercased **basis**-column names a row-local logical CHECK depends on — the
 * prover-supplied metadata the per-op decomposition gate (`constraintsForOp` in
 * `view-mutation-builder`) prefers over its own AST walk. Mirrors the prover's
 * {@link import('../../schema/lens-prover.js').classifyCheckConstraint}: enumerate every
 * `column` ref in the source CHECK (qualifier-stripped, via {@link collectColumnRefNames})
 * and keep only those that map to a basis column — i.e. that are logical columns of *this*
 * table. Two consequences make this exactly the right set:
 *
 *  - a **correlated bare write-row ref** (`somecol`) that appears only *inside* a subquery
 *    IS a logical column ⇒ mapped ⇒ included. This is the ref the AST walker under-collects
 *    (it assumes a bare subquery-internal ref resolves against the subquery's own FROM), and
 *    the hardening this metadata exists to deliver;
 *  - a **foreign ref** (`peer.k`, whose name is not a logical column of this table) maps to
 *    nothing ⇒ excluded — correct, it resolves against the subquery FROM, not the write row.
 *
 * Over-collection is the safe direction: a subquery ref qualified to another table whose
 * name happens to equal a logical column (`peer.title`) is qualifier-stripped here and
 * falsely mapped, adding an extra basis name. That only ever makes the gate *defer* a
 * constraint it might have threaded — conservative, the same bias the gate already carries.
 * Deduped because a CHECK may reference a column more than once.
 *
 * An authored-inverse column contributes its forward `get` expression's basis
 * refs (the columns the substituted CHECK actually reads on the write row).
 *
 * Returned per-referenced-logical-column (`{ logicalColumn, basisColumns }`) so the
 * caller can both flatten it to the bare {@link RowConstraintSchema.referencedWriteRowColumns}
 * list AND attribute each basis column to its owning relation for the relation-qualified
 * gate metadata. A logical column referenced more than once contributes a single entry
 * (deduped by lowercased logical name).
 */
function rowLocalReferencedWriteRow(
	expr: AST.Expression,
	map: ReadonlyMap<string, string>,
	forwards: ReadonlyMap<string, AST.Expression>,
): Array<{ logicalColumn: string; basisColumns: string[] }> {
	const entries: Array<{ logicalColumn: string; basisColumns: string[] }> = [];
	const seen = new Set<string>();
	for (const name of collectColumnRefNames(expr)) {
		const lc = name.toLowerCase();
		if (seen.has(lc)) continue;
		const basis = map.get(lc);
		if (basis !== undefined) {
			seen.add(lc);
			entries.push({ logicalColumn: name, basisColumns: [basis.toLowerCase()] });
			continue;
		}
		const forward = forwards.get(lc);
		if (forward !== undefined) {
			seen.add(lc);
			entries.push({ logicalColumn: name, basisColumns: collectColumnRefNames(forward).map(f => f.toLowerCase()) });
		}
	}
	return entries;
}

/**
 * Builds the basis-term row-local CHECK constraints a lens write must enforce.
 * Reads the slot's `enforced-row-local` obligations, rewrites each to basis terms,
 * and tags it with {@link LENS_BOUNDARY_ATTACHED_TAG}. The result is merged into
 * the basis INSERT/UPDATE's constraint-check pipeline by the base-table builder.
 *
 * Each constraint also carries its {@link rowLocalReferencedWriteRow} dependency set as
 * `referencedWriteRowColumns` (bare basis names) **and** `referencedWriteRowRelations`
 * (each basis column qualified by its owning member relation) — prover-supplied metadata
 * the per-op decomposition gate uses instead of an AST walk, so a subquery-bearing
 * row-local CHECK (which the prover still classifies `enforced-row-local`) gates onto the
 * member op that owns its correlated write-row column — by relation identity, not bare
 * name — rather than crashing on a member that cannot resolve it (or mis-routing onto a
 * sibling member that merely shares the basis-column name).
 *
 * Returns `[]` when the slot is un-proved (`obligations` undefined) or carries no
 * row-local checks — the common case, so a non-lens / check-free write pays nothing.
 */
export function collectLensRowLocalConstraints(ctx: PlanningContext, slot: LensSlot): RowConstraintSchema[] {
	if (!slot.obligations || slot.obligations.length === 0) return [];
	const map = logicalToBasisColumnMap(slot);
	const forwards = authoredForwardMap(slot);
	const owningRelation = makeOwningRelationResolver(slot, ctx.schemaManager);
	// Relation-qualify the rewrite ONLY on a multi-member decomposition, where the same
	// basis-column NAME can denote different physical columns on different members. A
	// single-source lens (or a degenerate single-member decomposition) has no such ambiguity,
	// so it keeps the `NEW` write-row correlation — no rewrite/behavior change there.
	const members = slot.advertisement?.storage?.members;
	const relationQualify = !!members && members.length > 1;
	const logicalTableName = slot.logicalTable.name;
	const constraints: RowConstraintSchema[] = [];
	for (const obligation of slot.obligations) {
		if (obligation.kind !== 'enforced-row-local') continue;
		if (obligation.constraint.kind !== 'check') continue;
		const source = obligation.constraint.constraint;
		const writeRow = rowLocalReferencedWriteRow(source.expr, map, forwards);
		constraints.push({
			name: source.name ? `lens:${source.name}` : 'lens:check',
			expr: rewriteToBasisTerms(ctx, source.expr, map, forwards, logicalTableName, owningRelation, relationQualify),
			// A logical CHECK guards the row being written: insert and update only.
			operations: RowOpFlag.INSERT | RowOpFlag.UPDATE,
			// Prover-supplied write-row dependency set for the per-op decomposition gate
			// (bare names for introspection; relation-qualified for the gate itself).
			referencedWriteRowColumns: [...new Set(writeRow.flatMap(e => e.basisColumns))],
			referencedWriteRowRelations: buildWriteRowRelations(owningRelation, writeRow),
			tags: { [LENS_BOUNDARY_ATTACHED_TAG]: true },
		});
	}
	return constraints;
}

/**
 * Whether the lens body is a faithful, **non-row-reducing** projection of its
 * single basis source — every basis row maps 1:1 to a logical row, so the logical
 * relation's row set equals the basis relation's on any projected column. True iff
 * none of the row-reducing clauses are present. `orderBy` is row-preserving (it
 * reorders, never drops) and is ignored; `from` single-sourcedness is established
 * separately by {@link resolveSlotBasisSource} returning the basis table.
 */
function isNonRowReducingProjection(body: AST.SelectStmt): boolean {
	return body.where === undefined
		&& (body.groupBy === undefined || body.groupBy.length === 0)
		&& body.having === undefined
		&& !body.distinct
		&& body.limit === undefined
		&& body.offset === undefined
		&& body.union === undefined
		&& body.compound === undefined
		&& body.withClause === undefined;
}

/**
 * The structural core shared by both FK redundancy directions (child-side
 * {@link lensForeignKeyRedundant} and parent-side {@link lensParentSideForeignKeyRedundant})
 * — **structural match only, no action reasoning**. Returns every basis FK that
 * subsumes the lens-level check (`[]` ⇒ none, default to enforce). Three structural
 * conditions, read from the parent→child direction:
 *
 *  1. **Single-source, value-preserving child mapping** + parent half of (2) — every
 *     logical FK child column maps with no transform to a plain `basisChild` column and
 *     every logical referenced column to a plain `basisParent` column ({@link mappedFkBasisPairs}).
 *  2. **Equivalent basis FK** — `basisChild` carries an FK whose unordered index
 *     pair-set equals the mapped one, referencing `basisParent` ({@link matchingBasisFks}).
 *  3. **Faithful non-row-reducing projection** of the slot the subsuming check scans —
 *     `projectionToCheck` selects which: `'parent'` for the child-side check (it scans
 *     the parent), `'child'` for the parent-side check (it scans the child).
 *
 * Any gap returns `[]` ⇒ enforce — a false match silently drops enforcement (a
 * soundness hole), so the bias is hard-coded toward double-enforce.
 */
function basisFksSubsuming(
	childSlot: LensSlot,
	fk: ForeignKeyConstraintSchema,
	parentSlot: LensSlot,
	logicalParentColumns: readonly string[],
	basisChild: TableSchema,
	basisParent: TableSchema,
	projectionToCheck: 'parent' | 'child',
): ForeignKeyConstraintSchema[] {
	const mappedPairs = mappedFkBasisPairs(childSlot, fk, parentSlot, logicalParentColumns, basisChild, basisParent);
	if (!mappedPairs) return [];
	const projSlot = projectionToCheck === 'parent' ? parentSlot : childSlot;
	if (!isNonRowReducingProjection(projSlot.compiledBody)) return [];
	return matchingBasisFks(basisChild, basisParent, mappedPairs);
}

/**
 * Whether the lens-level child-side FK check for `fk` is **provably** redundant
 * with an equivalent FK the basis child write already enforces via
 * `buildChildSideFKChecks` — so the lens-level `EXISTS` is pure double-enforcement
 * cost (`docs/lens.md` § Constraint Attachment). All three conditions must hold;
 * **any** gap (multi-source child, non-plain mapping, missing/permuted basis FK, no
 * parent lens slot, a parent body that might filter rows) returns `false`, defaulting
 * to enforce — a false `true` would silently drop enforcement (a soundness hole).
 *
 *  1. **Single-source, value-preserving child mapping** — the child slot resolves to
 *     one basis child table and every logical FK child column maps with no transform
 *     to a plain basis child column.
 *  2. **Equivalent basis FK** — `basisChild` carries an FK whose unordered
 *     `(basisChildCol → basisParentCol)` pair-set equals the mapped one, referencing
 *     the basis parent (this also requires every referenced column to map plainly).
 *  3. **Row-set equivalence of the referenced relation** — the logical parent's lens
 *     slot resolves and its compiled body is a faithful, non-row-reducing projection
 *     of the basis parent, so the logical parent's row set ⊇ the basis parent's on the
 *     referenced columns (the basis check therefore implies the lens check).
 *
 * Returns the subsuming basis FK (for the elision log) or `undefined` to enforce.
 */
function lensForeignKeyRedundant(
	slot: LensSlot,
	fk: ForeignKeyConstraintSchema,
	referencedSchema: string,
	logicalParentColumns: readonly string[],
	schemaManager: SchemaManager,
): ForeignKeyConstraintSchema | undefined {
	// (1) single-source child basis table.
	const basisChild = resolveSlotBasisSource(slot, schemaManager);
	if (!basisChild) return undefined;

	// (3) parent lens slot + its single basis source must resolve.
	const parentSlot = schemaManager.getSchema(referencedSchema)?.getLensSlot(fk.referencedTable);
	if (!parentSlot) return undefined;
	const basisParent = resolveSlotBasisSource(parentSlot, schemaManager);
	if (!basisParent) return undefined;

	// Conditions (1)+(2)+(3) via the shared core: the child-side check scans the
	// *parent*, so the parent projection must be non-row-reducing (`'parent'`).
	// Child-side FK enforcement is action-agnostic, so the first match suffices.
	return basisFksSubsuming(slot, fk, parentSlot, logicalParentColumns, basisChild, basisParent, 'parent')[0];
}

/**
 * Whether the lens-level **parent-side** FK check for `fk` (the synthesized `NOT
 * EXISTS` over the logical child) is **provably** redundant with the equivalent
 * parent-side check the re-planned basis parent write already enforces via
 * `buildParentSideFKChecks` — the parent-side dual of {@link lensForeignKeyRedundant},
 * reusing the same structural core ({@link basisFksSubsuming}). Two things differ from
 * the child side:
 *
 *  - **Projection slot.** The parent-side subquery scans the *child*, so condition (3)
 *    (non-row-reducing) applies to the **child** projection (`'child'`). This is a
 *    conservative parity gate: by condition (1) a single-source child already gives
 *    `L ⊆ B` on the FK columns, so the basis check (scanning the superset `B`) would
 *    reject a superset of cases even with a filtered child — but keeping the gate
 *    mirrors the child-side detector exactly and can only *reduce* elision, and
 *    default-to-double-enforce is always sound.
 *  - **Action match (parent-side only).** `buildParentSideFKChecks` emits a check
 *    **only** for a `restrict` basis FK — cascade / set-null / set-default mutate the
 *    children instead of rejecting, so they synthesize no parent-side check. The basis
 *    write therefore subsumes the lens RESTRICT only when the matched basis FK's
 *    op-appropriate action is `restrict`. Because {@link basisFksSubsuming} may return
 *    *several* matching basis FKs, the gate scans **all** of them: if **any** is
 *    non-`restrict` for the op, the basis write would cascade / null rather than reject
 *    ⇒ NOT redundant. (A divergent-action second FK on identical columns referencing
 *    the same parent is pathological, but "any uncertainty defaults to enforce" demands
 *    the defensive scan.) `ForeignKeyAction` has no distinct `'no action'` — NO ACTION
 *    normalizes to the `restrict` default at schema-build time — so "at least as strict
 *    as the lens RESTRICT" reduces to the exact `=== 'restrict'` test, matching the
 *    physical gate verbatim.
 *
 * Every gap returns `undefined` ⇒ enforce; a false "redundant" verdict silently drops
 * a RESTRICT rejection (a soundness hole), so the bias is hard-coded toward
 * double-enforce. Returns the subsuming basis FK (for the elision log) or `undefined`.
 */
function lensParentSideForeignKeyRedundant(
	childSlot: LensSlot,
	fk: ForeignKeyConstraintSchema,
	parentSlot: LensSlot,
	basisParent: TableSchema,
	logicalParentColumns: readonly string[],
	operation: RowOpFlag.DELETE | RowOpFlag.UPDATE,
	schemaManager: SchemaManager,
): ForeignKeyConstraintSchema | undefined {
	const basisChild = resolveSlotBasisSource(childSlot, schemaManager);
	if (!basisChild) return undefined;
	const matches = basisFksSubsuming(childSlot, fk, parentSlot, logicalParentColumns, basisChild, basisParent, 'child');
	if (matches.length === 0) return undefined;
	// Action match: the basis parent-side check fires only for a `restrict` basis FK.
	// If ANY matching basis FK would cascade / null instead of reject, the basis write
	// does not subsume the lens RESTRICT — keep enforcing.
	const actionOf = (m: ForeignKeyConstraintSchema) => operation === RowOpFlag.DELETE ? m.onDelete : m.onUpdate;
	if (!matches.every(m => actionOf(m) === 'restrict')) return undefined;
	return matches[0];
}

/**
 * Builds the basis-term child-side FK existence constraints a lens write must
 * enforce (the write side of the prover's `enforced-fk` obligation). For each FK
 * obligation it synthesizes a MATCH SIMPLE-guarded `EXISTS` against the
 * schema-qualified logical parent relation, with the child (NEW) columns rewritten
 * from logical to basis terms via the slot's reconstructible projection; the parent
 * side stays in logical terms (it resolves against the logical view). The result is
 * tagged with {@link LENS_BOUNDARY_ATTACHED_TAG} and routed through the basis
 * write's constraint pipeline, where the contained `EXISTS` auto-defers it to commit
 * — matching physical child-side FK gating + timing.
 *
 * v1 **double-enforces by design**: the lens check is emitted even when the basis
 * carries the equivalent FK (always sound). The bounded optimization here elides the
 * lens-level check **only when it is provably redundant** with a basis FK the
 * re-planned basis write already enforces (see {@link lensForeignKeyRedundant}) —
 * every uncertain case still double-enforces. Redundancy is decided against the
 * *current* basis FK set (read here, not stored on the obligation) so the elision is
 * exactly as sound as the physical `buildChildSideFKChecks`, which also reads the
 * basis FKs at plan time.
 *
 * Gated by the caller on the `foreign_keys` pragma. Returns `[]` when the slot is
 * un-proved (`obligations` undefined) or carries no FK obligation — the common case.
 */
export function collectLensForeignKeyConstraints(slot: LensSlot, schemaManager: SchemaManager): RowConstraintSchema[] {
	if (!slot.obligations || slot.obligations.length === 0) return [];
	const map = logicalToBasisColumnMap(slot);
	const owningRelation = makeOwningRelationResolver(slot, schemaManager);
	const logicalSchemaName = slot.logicalTable.schemaName;
	const constraints: RowConstraintSchema[] = [];
	for (const obligation of slot.obligations) {
		if (obligation.kind !== 'enforced-fk') continue;
		if (obligation.constraint.kind !== 'foreignKey') continue;
		const fk = obligation.constraint.constraint;
		const referencedSchema = fk.referencedSchema ?? logicalSchemaName;
		const parentColumns = resolveLogicalReferencedColumns(fk, referencedSchema, schemaManager);
		// Parity with the physical child-side builder's count-mismatch guard: if the
		// parent columns cannot be resolved to the same arity as the child columns
		// (an unresolvable parent ⇒ `[]`, or a malformed FK the prover did not catch),
		// skip rather than synthesize an `EXISTS` with `undefined` parent column names.
		if (parentColumns.length !== fk.columns.length) {
			log('lens FK %s: parent column count (%d) != child column count (%d); skipping',
				fk.name ?? '<anon>', parentColumns.length, fk.columns.length);
			continue;
		}
		// Elide the lens-level check when the basis child write provably already
		// enforces an equivalent FK (every uncertain case still double-enforces).
		const subsuming = lensForeignKeyRedundant(slot, fk, referencedSchema, parentColumns, schemaManager);
		if (subsuming) {
			log('lens FK %s on %s: elided — provably subsumed by basis FK %s referencing %s (the re-planned basis write enforces it)',
				fk.name ?? '<anon>', slot.logicalTable.name,
				subsuming.name ?? '<anon>', subsuming.referencedTable);
			continue;
		}
		// Rewrite each FK child column index → logical name → basis column. A column
		// the prover proved reconstructible maps; otherwise it falls back to the logical
		// name (the prover would have errored on a non-reconstructible FK child column).
		// The child (NEW) columns are the constraint's write-row refs; attribute each to
		// the member relation that owns it for the per-op decomposition gate.
		const writeRow = fk.columns.map(childIdx => {
			const logicalName = slot.logicalTable.columns[childIdx]?.name ?? `#${childIdx}`;
			return { logicalColumn: logicalName, basisColumns: [map.get(logicalName.toLowerCase()) ?? logicalName] };
		});
		const childColumns = writeRow.map(e => e.basisColumns[0]);
		const expr = synthesizeFKExistsExpr(fk.referencedTable, parentColumns, childColumns, 'NEW', referencedSchema);
		constraints.push({
			name: fk.name ? `lens:fk:${fk.name}` : 'lens:fk',
			expr,
			// Child-side FK guards the row being written: insert and update only.
			operations: RowOpFlag.INSERT | RowOpFlag.UPDATE,
			referencedWriteRowRelations: buildWriteRowRelations(owningRelation, writeRow),
			tags: { [LENS_BOUNDARY_ATTACHED_TAG]: true },
		});
	}
	return constraints;
}

/**
 * The null-safe per-column "referenced key unchanged" predicate — equivalent to
 * `OLD.p is not distinct from NEW.p`:
 *
 *   ( OLD.p is null and NEW.p is null )
 *     or ( OLD.p is not null and NEW.p is not null and OLD.p = NEW.p )
 *
 * Built from only existing AST node kinds (`=`, `is null`, `is not null`, `and`,
 * `or`) — Quereus has no general `is not distinct from` operator surface to
 * synthesize into a constraint AST. Crucially this evaluates to a definite **false**
 * (never NULL) when exactly one side is NULL: the naive `(OLD = NEW) or (OLD is null
 * and NEW is null)` instead yields `NULL or false = NULL` there, which the
 * constraint check (NULL passes; only a non-NULL non-truthy value fails, per the
 * shared `isTruthy` rule) does not treat as a
 * failure — so it would wrongly admit an orphaning value→NULL update.
 *
 * Null-safety matters for a **nullable** referenced parent key: a value→NULL update
 * *changes* the key (orphaning a child), so the guard must be false ⇒ fall through to
 * the `NOT EXISTS` ⇒ reject, matching physical RESTRICT. Only a genuine NULL→NULL
 * no-op (first arm) short-circuits true. For a NOT-NULL referenced key the first arm
 * and the `is not null` conjuncts are dead and the predicate collapses to the plain
 * `OLD.p = NEW.p` — exact parity with the physical path.
 */
function buildNullSafeEquality(col: string): AST.Expression {
	const old = { type: 'column', name: col, table: 'OLD' } as AST.ColumnExpr;
	const neo = { type: 'column', name: col, table: 'NEW' } as AST.ColumnExpr;
	const isNull = (e: AST.ColumnExpr) => ({ type: 'unary', operator: 'IS NULL', expr: e } as AST.UnaryExpr);
	const isNotNull = (e: AST.ColumnExpr) => ({ type: 'unary', operator: 'IS NOT NULL', expr: e } as AST.UnaryExpr);
	const and = (l: AST.Expression, r: AST.Expression) => ({ type: 'binary', operator: 'AND', left: l, right: r } as AST.BinaryExpr);
	const bothNull = and(isNull(old), isNull(neo));
	const eq = { type: 'binary', operator: '=', left: old, right: neo } as AST.BinaryExpr;
	const bothPresentEqual = and(and(isNotNull(old), isNotNull(neo)), eq);
	return { type: 'binary', operator: 'OR', left: bothNull, right: bothPresentEqual } as AST.BinaryExpr;
}

/**
 * The parent-side UPDATE short-circuit guard:
 *
 *   ( (OLD.p1 ≡ NEW.p1 and … and OLD.pn ≡ NEW.pn) or <NOT EXISTS over OLD> )
 *
 * where `≡` is the null-safe {@link buildNullSafeEquality}. Reproduces the physical
 * parent-side UPDATE short-circuit (`runtime/row-constraints.ts` skips the `NOT EXISTS`
 * when no referenced parent column changed) — a **correctness** requirement, not just
 * perf: a plain `NOT EXISTS` over OLD values would reject a benign update that does not
 * touch the referenced columns but whose key a child still references. The per-column
 * comparison is null-safe so a value→NULL update on a **nullable** referenced key (which
 * *does* change the key, orphaning the child) falls through to the `NOT EXISTS` and is
 * rejected, while a NULL→NULL no-op still short-circuits true. DELETE never gets this
 * guard — there NEW is all-NULL, so on a NULL OLD key `OLD ≡ NEW` would now be true and
 * wrongly short-circuit; op-specific synthesis keeps DELETE on the plain `NOT EXISTS`.
 */
function buildParentSideUpdateGuard(parentBasisColumns: readonly string[], notExists: AST.Expression): AST.Expression {
	const equalities: AST.Expression[] = parentBasisColumns.map(buildNullSafeEquality);
	const guard = equalities.reduce((acc, eq) => ({
		type: 'binary',
		operator: 'AND',
		left: acc,
		right: eq,
	} as AST.BinaryExpr));
	return { type: 'binary', operator: 'OR', left: guard, right: notExists } as AST.BinaryExpr;
}

/**
 * Builds the parent-side FK non-existence constraints a lens write through a logical
 * **parent** must enforce — the cross-slot dual of {@link collectLensForeignKeyConstraints}
 * and the lens analogue of `buildParentSideFKChecks`. The physical parent-side builder
 * discovers FKs by scanning declared `TableSchema.foreignKeys` on basis tables; a logical
 * FK lives only on the **child** slot's `enforced-fk` obligation (on no basis table), so
 * this collector walks every schema's lens slots and, for each child slot whose FK
 * references `parentSlot`'s logical table (name + resolved schema, case-insensitive),
 * synthesizes one `NOT EXISTS(SELECT 1 FROM <childLogical> WHERE <child>.<childCol> =
 * OLD.<parentBasisCol> …)` against the schema-qualified logical child relation.
 *
 * The child columns stay **logical** (they resolve against the registered logical child
 * view named in the FROM). The parent's referenced columns are rewritten **logical→basis**
 * via the parent slot's reconstructible projection, because the `OLD.*` / `NEW.*` side is
 * the parent's basis write row. For DELETE the expression is the plain `NOT EXISTS`; for
 * UPDATE it is wrapped in the {@link buildParentSideUpdateGuard} short-circuit. The result
 * is tagged {@link LENS_BOUNDARY_ATTACHED_TAG}, masked to the requested op, and routed
 * through the basis write's constraint pipeline, where the contained `EXISTS` auto-defers
 * it to commit (the accepted v1 timing — identical ABORT outcome, symmetric with the
 * already-shipped child-side).
 *
 * Action gate: only `restrict` (on the op-appropriate `onDelete` / `onUpdate`) emits —
 * **matching `buildParentSideFKChecks` exactly**. CASCADE / SET NULL / SET DEFAULT are
 * **propagated** (not detected here) by the runtime cascade walker
 * `executeLensForeignKeyActions` (`runtime/foreign-key-actions.ts`), the logical dual of
 * `executeForeignKeyActions`. The lens-level RESTRICT check **double-enforces** by default
 * (sound: both the lens-level check and any equivalent basis parent-side check reject the
 * same condition), but is now **elided when provably redundant** with the basis parent
 * write's own `buildParentSideFKChecks` (see {@link lensParentSideForeignKeyRedundant}):
 * a single-source value-preserving child mapping, an equivalent basis FK referencing the
 * basis parent, a faithful non-row-reducing logical-child projection, **and** — the
 * parent-side-only addition the child side does not need — every matching basis FK being
 * `restrict` for the op (a cascade / null basis FK would not reject, so it never subsumes
 * a lens RESTRICT). Any uncertainty defaults to double-enforce.
 *
 * Gated by the caller on the `foreign_keys` pragma (mirroring the child-side). Returns
 * `[]` for a multi-source / decomposition parent (its `OLD.*` is not one basis row — a
 * documented single-source-spine boundary, decided here via {@link resolveSlotBasisSource}),
 * for a non-referenced parent, and for an un-proved slot.
 */
export function collectLensParentSideForeignKeyConstraints(
	parentSlot: LensSlot,
	schemaManager: SchemaManager,
	operation: RowOpFlag.DELETE | RowOpFlag.UPDATE,
): RowConstraintSchema[] {
	// Single-source spine: the parent-side constraint rides the parent's basis base op,
	// so OLD.* / NEW.* must be exactly one basis row. A multi-source / decomposition
	// parent (an opaque or multi-table FROM) routes nothing extra (documented boundary).
	// `basisParent` is also the table the redundancy detector matches basis FKs against.
	const basisParent = resolveSlotBasisSource(parentSlot, schemaManager);
	if (!basisParent) return [];

	const parentMap = logicalToBasisColumnMap(parentSlot);

	const constraints: RowConstraintSchema[] = [];
	// Cross-slot discovery (the shared `findLogicalParentFkRefs`): every logical FK on
	// any slot that references this parent's logical table, with the child / parent
	// column names + the count-mismatch guard already resolved.
	for (const { childSlot, fk, childLogicalColumns, parentLogicalColumns } of findLogicalParentFkRefs(parentSlot, schemaManager)) {
		// Action gate — mirror buildParentSideFKChecks exactly: only RESTRICT
		// synthesizes a parent-side check (cascades are propagated by the runtime
		// cascade walker — `executeLensForeignKeyActions` — not here).
		const action = operation === RowOpFlag.DELETE ? fk.onDelete : fk.onUpdate;
		if (action !== 'restrict') continue;
		// Elide the lens-level parent-side check when the re-planned basis parent
		// write provably already enforces an equivalent (RESTRICT) parent-side FK
		// (every uncertain case — including any non-restrict matching basis FK —
		// still double-enforces).
		const subsuming = lensParentSideForeignKeyRedundant(
			childSlot, fk, parentSlot, basisParent, parentLogicalColumns, operation, schemaManager);
		if (subsuming) {
			log('lens parent-side FK %s on %s: elided — provably subsumed by basis FK %s referencing %s (action restrict; the re-planned basis parent write enforces it)',
				fk.name ?? '<anon>', parentSlot.logicalTable.name,
				subsuming.name ?? '<anon>', subsuming.referencedTable);
			continue;
		}
		// Parent referenced columns rewritten logical→basis through the parent slot's
		// projection for the OLD/NEW correlation side.
		const parentBasisColumns = parentLogicalColumns.map(name => parentMap.get(name.toLowerCase()) ?? name);
		// Child FK columns stay logical — they resolve against the schema-qualified
		// logical child view named in the NOT EXISTS FROM.
		const notExists = synthesizeFKNotExistsExpr(
			childSlot.logicalTable.name,
			childLogicalColumns,
			parentBasisColumns,
			'OLD',
			childSlot.logicalTable.schemaName,
		);
		const expr = operation === RowOpFlag.DELETE
			? notExists
			: buildParentSideUpdateGuard(parentBasisColumns, notExists);
		constraints.push({
			name: fk.name ? `lens:fk:parent:${fk.name}` : 'lens:fk:parent',
			expr,
			operations: operation,
			// The OLD/NEW referenced columns are this constraint's write-row refs; they ride
			// the parent's basis write row, which is exactly `basisParent` (this collector
			// only runs for a single-source parent — it early-returned otherwise). The child
			// columns inside the NOT EXISTS stay logical (subquery-FROM resolved) and are not
			// write-row refs, so they are not attributed.
			referencedWriteRowRelations: parentBasisColumns.map(column => ({
				schema: basisParent.schemaName,
				table: basisParent.name,
				column: column.toLowerCase(),
			})),
			tags: { [LENS_BOUNDARY_ATTACHED_TAG]: true },
		});
	}
	return constraints;
}

/** The logical key column indices forming a primary-key / unique constraint. */
function setLevelKeyColumns(c: Extract<LogicalConstraint, { kind: 'primaryKey' | 'unique' }>): readonly number[] {
	return c.kind === 'primaryKey' ? c.columns.map(col => col.index) : c.constraint.columns;
}

/** The routed-constraint name for a set-level key (mirrors the FK `lens:fk:<name>` convention). */
function setLevelConstraintName(c: Extract<LogicalConstraint, { kind: 'primaryKey' | 'unique' }>): string {
	if (c.kind === 'primaryKey') return 'lens:pk';
	return c.constraint.name ? `lens:unique:${c.constraint.name}` : 'lens:unique';
}

/**
 * Builds the deferred count-subquery uniqueness predicate for one logical key:
 *
 *   (select count(*) from <logicalSchema>.<logicalTable> as _u
 *      where _u.lk1 = NEW.bk1 and … and _u.lkn = NEW.bkn) <= 1
 *
 * The subquery FROM is the **logical view** (schema-qualified + aliased `_u`), so
 * `_u.<logicalCol>` resolves against the registered logical relation while each key
 * column's `newSide` expression (a correlated reference resolved from the
 * surrounding constraint scope, exactly as the FK `EXISTS` resolves `NEW.*`)
 * reconstructs that column's **logical key value** from the basis write row: a bare
 * `NEW.<basisCol>` for a reconstructible (rename / passthrough) column, and the
 * authored column's NEW-qualified **forward `get`** image (e.g. `NEW.code + 10`) for
 * a proven-bijective `with inverse` column — so a logical-domain value is compared
 * to a logical-domain value, not a basis-domain one. The `count(*)` is a `count`
 * with empty args — `astToString` renders it `count(*)` and the planner treats it as
 * the row-count aggregate. The contained scalar subquery makes the constraint
 * pipeline auto-defer the check to commit. NULL key columns fall out for free:
 * `_u.lk = <newSide>` is `NULL` (never true) when either side is NULL, so a NULL-key
 * row is never counted — SQL UNIQUE's NULL-distinct rule.
 */
function synthesizeUniqueCountExpr(
	logicalSchema: string,
	logicalTable: string,
	keyColumns: ReadonlyArray<{ logicalColumn: string; newSide: AST.Expression }>,
): AST.Expression {
	const alias = '_u';
	const conditions: AST.Expression[] = keyColumns.map(({ logicalColumn, newSide }) => ({
		type: 'binary',
		operator: '=',
		left: { type: 'column', name: logicalColumn, table: alias } as AST.ColumnExpr,
		right: newSide,
	} as AST.BinaryExpr));

	const whereExpr = conditions.reduce((acc, cond) => ({
		type: 'binary',
		operator: 'AND',
		left: acc,
		right: cond,
	} as AST.BinaryExpr));

	const subquery: AST.SelectStmt = {
		type: 'select',
		columns: [{ type: 'column', expr: { type: 'function', name: 'count', args: [] } as AST.FunctionExpr }],
		from: [{
			type: 'table',
			table: { type: 'identifier', name: logicalTable, schema: logicalSchema },
			alias,
		} as AST.TableSource],
		where: whereExpr,
	};

	return {
		type: 'binary',
		operator: '<=',
		left: { type: 'subquery', query: subquery } as AST.SubqueryExpr,
		right: { type: 'literal', value: 1 } as AST.LiteralExpr,
	} as AST.BinaryExpr;
}

/**
 * Builds the deferred set-level uniqueness CHECK constraints a lens write must
 * enforce (the write side of the prover's `enforced-set-level` `commit-time`
 * obligation). For each commit-time set-level key (no basis covering structure) it
 * synthesizes the count-subquery `<= 1` predicate via {@link synthesizeUniqueCountExpr},
 * with the logical key columns mapped to their basis columns on the `NEW.*` side
 * (via the slot's reconstructible projection) and kept logical inside the subquery
 * (they resolve against the registered logical view). The result is tagged with
 * {@link LENS_BOUNDARY_ATTACHED_TAG} and routed through the basis write's constraint
 * pipeline, where the contained scalar subquery auto-defers it to commit.
 *
 * Only the `commit-time` mode is emitted: a `row-time` key is already enforced by
 * the basis `UNIQUE` it is (by the classifier's precondition) backed by — the
 * single-source re-plan reaches that basis UC, whose covering-MV enforcement path
 * does the O(log n) lookup and honors the conflict action, so no constraint is
 * synthesized here. `proved` / `vacuous` keys need no enforcement. Returns `[]`
 * when the slot is un-proved (`obligations` undefined) or
 * carries no commit-time set-level key — the common case, so a non-lens / plain
 * view / proved-key write pays nothing. DELETE never introduces a duplicate, so the
 * caller restricts this to insert/update.
 */
export function collectLensSetLevelConstraints(slot: LensSlot, schemaManager?: SchemaManager): RowConstraintSchema[] {
	if (!slot.obligations || slot.obligations.length === 0) return [];
	const map = logicalToBasisColumnMap(slot);
	const forwards = authoredForwardMap(slot);
	const owningRelation = makeOwningRelationResolver(slot, schemaManager);
	const logicalSchemaName = slot.logicalTable.schemaName;
	const logicalTableName = slot.logicalTable.name;
	const constraints: RowConstraintSchema[] = [];
	for (const obligation of slot.obligations) {
		if (obligation.kind !== 'enforced-set-level' || obligation.mode !== 'commit-time') continue;
		const c = obligation.constraint;
		if (c.kind !== 'primaryKey' && c.kind !== 'unique') continue;
		const logicalColumns = setLevelKeyColumns(c);
		// The empty (singleton) key classifies `vacuous`, never commit-time set-level;
		// guard defensively so an empty WHERE is never synthesized.
		if (logicalColumns.length === 0) continue;
		// Each logical key column → the NEW.* expression reconstructing its logical key
		// value from the basis write row: a bare `NEW.<basis>` for a reconstructible
		// (rename / passthrough) column, or the authored column's NEW-qualified forward
		// `get` image for a proven-bijective `with inverse` column (so the count compares
		// logical value to logical value). A non-reconstructible, non-authored key would
		// have made the table read-only — no write reaches here — but the bare-name
		// fallback keeps the synthesis total. `writeRow` accumulates, per key column, the
		// basis columns its NEW side references — the per-op decomposition gate's write-row
		// dependency set, attributed below to each column's owning member relation.
		const writeRow: Array<{ logicalColumn: string; basisColumns: string[] }> = [];
		const keyColumns = logicalColumns.map(li => {
			const logicalColumn = slot.logicalTable.columns[li]?.name ?? `#${li}`;
			const lc = logicalColumn.toLowerCase();
			const basisColumn = map.get(lc);
			if (basisColumn !== undefined) {
				writeRow.push({ logicalColumn, basisColumns: [basisColumn.toLowerCase()] });
				return { logicalColumn, newSide: { type: 'column', name: basisColumn, table: 'NEW' } as AST.ColumnExpr };
			}
			const forward = forwards.get(lc);
			if (forward !== undefined) {
				writeRow.push({ logicalColumn, basisColumns: collectColumnRefNames(forward).map(f => f.toLowerCase()) });
				return { logicalColumn, newSide: transformExpr(forward, col => ({ type: 'column', name: col.name, table: 'NEW' })) };
			}
			writeRow.push({ logicalColumn, basisColumns: [logicalColumn.toLowerCase()] });
			return { logicalColumn, newSide: { type: 'column', name: logicalColumn, table: 'NEW' } as AST.ColumnExpr };
		});
		constraints.push({
			name: setLevelConstraintName(c),
			expr: synthesizeUniqueCountExpr(logicalSchemaName, logicalTableName, keyColumns),
			// A duplicate is only introduced by an insert or a key-changing update;
			// a delete cannot create one (and is excluded by the caller anyway).
			operations: RowOpFlag.INSERT | RowOpFlag.UPDATE,
			referencedWriteRowRelations: buildWriteRowRelations(owningRelation, writeRow),
			tags: { [LENS_BOUNDARY_ATTACHED_TAG]: true },
		});
	}
	return constraints;
}

/**
 * Whether the slot carries any `enforced-set-level` `commit-time` obligation — the
 * detection-only set-level class. The view-mutation builder consults this to reject
 * `or replace` / `or ignore` (and matching upserts), which the commit-time scan
 * cannot honor (row-time conflict resolution needs a covering structure). Returns
 * `false` for a non-lens / plain view / proved- or row-time-keyed slot.
 */
export function hasCommitTimeSetLevelObligation(slot: LensSlot): boolean {
	return (slot.obligations ?? []).some(o => o.kind === 'enforced-set-level' && o.mode === 'commit-time');
}

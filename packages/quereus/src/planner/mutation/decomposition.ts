import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import type { TableReferenceNode } from '../nodes/reference.js';
import type { RelationalPlanNode } from '../nodes/plan-node.js';
import type { Scope } from '../scopes/scope.js';
import { FilterNode } from '../nodes/filter.js';
import { ProjectNode, type Projection } from '../nodes/project-node.js';
import { buildTableReference } from '../building/table.js';
import type { StorageShape, DecompositionMember } from '../../vtab/mapping-advertisement.js';
import type { ScalarType } from '../../common/datatype.js';
import type { TableSchema } from '../../schema/table.js';
import type { ColumnSchema } from '../../schema/column.js';
import type { SqlValue } from '../../common/types.js';
import type { BaseOp, MutableViewLike, MutationRequest } from './propagate.js';
import { combineAnd } from './single-source.js';
import { transformExpr, cloneExpr } from './scope-transform.js';
import { buildExpression } from '../building/expression.js';
import { columnSchemaToScalarType } from '../type-utils.js';
import { createRuntimeExpressionEvaluator } from '../analysis/const-evaluator.js';
import { containsNonDeterministicCall } from '../analysis/check-extraction.js';
import { FunctionFlags } from '../../common/constants.js';
import { analyzeBodyLineage, type BackwardColumn } from './backward-body.js';
import { keyColumnName, capturedValueSubquery, type MultiSourceKeyCapture } from './multi-source.js';
import type { KeyColumnInfo } from './capture-correlation.js';
import { raiseMutationDiagnostic, type MutationDiagnostic } from './mutation-diagnostic.js';

/**
 * Advertisement-driven **put** fan-out for a logical table backed by an n-way
 * decomposition (columnar split / column-family / EAV), the write dual of the
 * `get` join `schema/lens-compiler.ts` synthesizes (`compileDecompositionBody`).
 * See `docs/lens.md` § The Default Mapper and `docs/view-updateability.md`
 * § Decomposition put fan-out.
 *
 * A decomposition lens is registered as an ordinary view whose `selectAst` is the
 * synthesized `anchor ⋈ members` join, so writing it would otherwise route to the
 * generic two-table-inner-join `multi-source.ts` path — which has the **wrong**
 * semantics for a decomposition (it picks a single delete side, rejects > 2
 * members, and rejects the outer joins optional members ride). `propagate()`
 * intercepts a decomposition body (the slot carries a `primary-storage`
 * advertisement and no override) and routes it here instead.
 *
 * **Scope shipped here (DELETE / UPDATE in this module; INSERT off the envelope
 * built in `building/view-mutation-builder.ts`):**
 *
 * - **DELETE** fans out to *every* member (mandatory, optional, and EAV pivot) so
 *   the logical row ceases to exist across the whole decomposition. Members are
 *   ordered **anchor-last**; each non-anchor member's identifying set is read from
 *   the **anchor alone** (never the full join), so an earlier member's delete can
 *   never shrink a later member's identifying set. This is what keeps the fan-out
 *   sound without the snapshot-consistent multi-member execution substrate.
 * - **UPDATE** routes each assignment to the member that backs it, keyed off the
 *   anchor the same anchor-last way. A **mandatory, non-EAV** member takes one base
 *   UPDATE. An **optional columnar** member's write is a per-row materialization
 *   transition realized as plain AST base ops over the anchor, routed by the assigned
 *   **value shape** ({@link lowerMaterializedValue}): a **constant** value takes the
 *   matched base UPDATE + an absent null-extended INSERT (anchor-keyed insert-select
 *   `… on conflict (<memberKey>) do nothing`, which cedes the matched rows to the
 *   UPDATE without the insert source scanning its own target), or — when every value
 *   column is assigned null — a base DELETE instead; an **anchor-resolvable** value
 *   (`set c = a + 1`, every leaf lowers to an anchor base column) collapses both
 *   branches into a single `… on conflict (<memberKey>) do update set c = excluded.c`
 *   upsert (the value computed once over the anchor scan, matched rows reading it via
 *   `excluded.<col>`); a **member self-reference** (`set c = c + 1`, `set c = coalesce(c, 0)
 *   + 1`) keeps the matched UPDATE for present rows **and** adds a materialize INSERT for absent
 *   rows that projects the self-expression with the owner's own columns substituted to NULL,
 *   gated by a runtime non-empty filter (so a null-propagating expression materializes nothing
 *   while a null→non-null one does) and `on conflict (<memberKey>) do nothing` to cede matched
 *   rows — the two ops stay distinct because the matched and materialize values are computed over
 *   different scans. An **arbitrary** columnar value — one that embeds a subquery, reads a
 *   *different* member's column, or mixes anchor + self leaves (`set c = b + 1`, `set c = c + a`,
 *   `set c = (select …)`) — now rides a **single-identity (anchor-key) per-row capture** instead
 *   of rejecting: every affected row's value is materialized ONCE over the planned get body (which
 *   null-extends an absent optional member, so the captured value already encodes per-row presence)
 *   into the multi-source `__vmupd_keys` substrate, and the matched UPDATE reads it back keyed by
 *   the member key while a filtered materialize INSERT reads it keyed by the anchor key, gated on a
 *   **runtime** non-null (the value is data-dependent, so the plan-time `foldsConstantFalse` of the
 *   `self` fast-lane cannot decide it). Capturing the value pre-mutation is what makes a both-sides
 *   write (`set c = b + 1, b = b + 100`) read `c` from the *pre-mutation* `b`
 *   ({@link emitCapturedMemberUpdate} / {@link buildCapturedMaterializeInsert}; the capture relation
 *   is {@link buildDecompositionKeyCapture}). A mixed anchor+self group rides this path too — it
 *   subsumes the retired same-statement reject. An
 *   **EAV pivot** member's write is the triple analogue, per attribute: a null deletes
 *   the triple, an anchor-resolvable value upserts it via `do update`, a constant value
 *   upserts it via matched UPDATE + `do nothing` materialize INSERT, and an **arbitrary EAV**
 *   value (a subquery, a cross-member column, an anchor+self mix, or any EAV self-reference —
 *   which an EAV value column lowers to a subquery for) rides the **same single-identity capture**
 *   as the columnar arbitrary case: the captured value substitutes the get-body projection over the
 *   anchor scan, the matched UPDATE reads it back by the entity column, and a non-null-filtered
 *   materialize INSERT reads it back by the anchor key (`on conflict (entity, attr) do nothing`).
 * - **INSERT** fans out to one insert per member, **anchor first** (FK-order root).
 *   It rides the shared-surrogate mutation envelope `view-mutation-shared-surrogate-insert`
 *   ships (`ViewMutationNode.envelope` + `EnvelopeScanNode`): the user source is
 *   materialized once, the surrogate value is sourced from the **anchor key column's
 *   declared `default`** — evaluated once per row at the envelope (with
 *   `mutation_ordinal()` in scope), so the basis author chooses the ID policy and the
 *   engine invents nothing — and threaded into every member's key column(s) via the
 *   equivalence class, with each member reading the identical rows back.
 *   `logical-tuple` keys thread the supplied logical PK; no default. Optional members are inserted only for rows that
 *   supply ≥1 of their columns (a per-row presence filter — the outer-join
 *   semantics the read preserves); EAV pivot members emit one triple insert per
 *   supplied attribute, gated on a non-null value. The plan-agnostic decomposition
 *   is {@link analyzeDecompositionInsert} here; the plan-node build (envelope +
 *   per-member projections) is `buildDecompositionInsert` in the builder, mirroring
 *   the multi-source insert split.
 *
 * **Deferred (raised here with a precise diagnostic), because each rides a
 * substrate that is not yet present:**
 *
 * - A DELETE/UPDATE **WHERE that references a non-anchor member** (an EAV pivot, or an
 *   embedded subquery) — needs the snapshot-consistent multi-member base-op execution
 *   the predicate-honest multi-side fan-out is deferred onto (see `multi-source.ts`
 *   § delete + the `view-mutation-lenient-multiside-delete-fanout` backlog ticket). A
 *   WHERE that is **anchor-resolvable** — an anchor identity column **or** a computed
 *   mapping whose basis lives on the anchor (`bumped = a + 1`, `combined = a || b`) —
 *   is *supported*: it substitutes into a predicate over the anchor's own base columns,
 *   which the anchor subquery already evaluates, so it does not defer.
 * - **UPDATE of a shared-key column** — a key write is an identity change, not a
 *   value write. (Optional-member and EAV value writes — including arbitrary captured
 *   values — are **supported**, see the UPDATE bullet above; only a key/identity write
 *   stays rejected.)
 * - **composite shared keys** — v1 threads a single-column key (mirrors the
 *   single-column-PK boundary in `multi-source.ts`).
 */

/**
 * Resolved view of one decomposition for the put fan-out. Its backward decisions
 * are derived from the **threaded plan-node `updateLineage`** read through the
 * shared backward-walk consumer (`analyzeBodyLineage`) — the same n-way reader the
 * multi-source join walk consumes — rather than a parallel AST scan of the
 * synthesized body's projection list (docs/vu-roundtrip.md § Round-Trip Laws
 * and the Derived Backward Walk, docs/lens.md § The Default Mapper).
 */
export interface DecompShape {
	readonly storage: StorageShape;
	readonly anchor: DecompositionMember;
	/** logical-column-name (lowercased) → its backing expression in the get body (from the shared consumer). */
	readonly viewColToBaseRef: ReadonlyMap<string, AST.Expression>;
	/** Per logical column, its backward lineage off the planned body (shared with multi-source). */
	readonly columns: readonly BackwardColumn[];
	/** Planned-body `TableReferenceNode` id → the decomposition member it realizes (join members only). */
	readonly memberByTableId: ReadonlyMap<number, DecompositionMember>;
	/**
	 * The planned get body's relational source (the `anchor ⋈ members` join for a columnar
	 * body) + its combined column scope — the source/scope {@link buildDecompositionKeyCapture}
	 * builds the single-identity value capture over, resolving the member-relationId-qualified
	 * base columns the lowered captured values carry (the decomposition dual of
	 * `analyzeJoinView`'s `joinNode` / `joinScope`). Threaded from the shared body lineage.
	 */
	readonly bodySource: RelationalPlanNode;
	readonly bodyScope: Scope | undefined;
}

/**
 * Plan the synthesized get body **once** and read its threaded `updateLineage`
 * into a {@link DecompShape}: the per-column backward lineage (column → owning base
 * relation) plus a `TableReferenceNode`-id → member map, so the routing / anchor
 * gate decide off the plan-node backward walk shared with the multi-source path
 * (not a parallel projection-AST scan). EAV pivot members are correlated subqueries,
 * not join sources, so they carry no planned `TableReferenceNode` and are absent
 * from {@link DecompShape.memberByTableId} (resolved off the advertisement instead).
 */
export function analyzeDecomposition(ctx: PlanningContext, view: MutableViewLike, storage: StorageShape): DecompShape {
	const anchor = storage.members.find(m => m.relationId === storage.anchorRelationId);
	if (!anchor) {
		// Validated at advertisement resolution; defensive.
		raiseMutationDiagnostic({
			reason: 'no-base-lineage',
			table: view.name,
			message: `cannot write through logical table '${view.name}': decomposition anchor '${storage.anchorRelationId}' is not among its members`,
		});
	}
	const lineage = analyzeBodyLineage(ctx, view);
	const memberByTableId = new Map<number, DecompositionMember>();
	for (const [id, ref] of lineage.tableRefsById) {
		const matches = storage.members.filter(m =>
			m.relation.table.toLowerCase() === ref.tableSchema.name.toLowerCase()
			&& m.relation.schema.toLowerCase() === ref.tableSchema.schemaName.toLowerCase());
		if (matches.length > 1) {
			// Two members over the **same** physical base relation (a self-decomposition)
			// both claim this body `TableReferenceNode`, so routing any column off
			// `memberByTableId` would be ambiguous (a last-writer would silently win).
			// The multi-source path rejects self-joins upstream, but that guard sits
			// outside this code; enforce the single-member-per-base-ref assumption
			// locally rather than relying on it.
			raiseMutationDiagnostic({
				reason: 'unsupported-decomposition-member',
				table: view.name,
				message: `cannot write through logical table '${view.name}': decomposition members ${matches.map(m => `'${m.relationId}'`).join(' and ')} both resolve to the same base relation '${ref.tableSchema.schemaName}.${ref.tableSchema.name}' (a self-decomposition); the put fan-out cannot disambiguate which member backs a column`,
			});
		}
		if (matches.length === 1) memberByTableId.set(id, matches[0]);
	}
	return {
		storage, anchor, viewColToBaseRef: lineage.viewColToBaseRef, columns: lineage.columns, memberByTableId,
		bodySource: lineage.bodySource, bodyScope: lineage.bodyScope,
	};
}

/** How one logical column is backed, decided off the threaded backward lineage (+ advertisement for the deferred shapes). */
type ColumnRoute =
	/** An identity base column on a join member — the value-writable / insertable case. */
	| { readonly kind: 'member'; readonly member: DecompositionMember; readonly baseColumn: string; readonly nullExtended: boolean }
	/** A `member.columns` mapping the lineage did not resolve to an identity base column (a computed / non-invertible mapping) — read-only. */
	| { readonly kind: 'computed-mapping'; readonly member: DecompositionMember }
	/** An EAV pivot member backs it (a correlated-subquery projection — an attribute row, not a join column). */
	| { readonly kind: 'eav'; readonly member: DecompositionMember }
	/** Not a logical column of the decomposition / not backed by any member. */
	| { readonly kind: 'unbacked' };

/**
 * The decomposition put fan-out for an authored (`with inverse`) column is
 * deferred (docs/vu-inverses.md § Authored inverses — the documented
 * decomposition deferral): reject a write that targets one, naming the member(s)
 * its puts route to, rather than letting it fall through {@link classifyColumn}'s
 * EAV / computed-mapping fallbacks into a silent mis-route. Read consumers (the
 * WHERE anchor-resolvability gate) deliberately do NOT run this — an authored
 * column reads through its forward expression like any computed column.
 */
function rejectAuthoredDecompositionWrite(view: MutableViewLike, shape: DecompShape, name: string, displayName: string): void {
	const col = shape.columns.find(c => c.name === name);
	if (!col?.authored) return;
	const members = [...new Set(col.authored.puts.map(p => shape.memberByTableId.get(p.table)?.relationId ?? `relation #${p.table}`))];
	raiseMutationDiagnostic({
		reason: 'unsupported-decomposition-member',
		column: displayName,
		table: view.name,
		message: `cannot write through logical table '${view.name}': column '${displayName}' carries an authored inverse (WITH INVERSE) targeting member${members.length > 1 ? 's' : ''} ${members.map(m => `'${m}'`).join(', ')}; the decomposition put fan-out for authored inverses is deferred`,
	});
}

/**
 * Classify one logical column against the decomposition. The **primary routing**
 * (which member backs a writable/insertable column, and its base column) is read
 * from the threaded `updateLineage` (`shape.columns` + `shape.memberByTableId`);
 * the advertisement only disambiguates the deferred shapes (a non-identity mapping,
 * an EAV pivot column), preserving the exact deferral diagnostics. Precedence
 * mirrors the retired advertisement scan: identity base column → member-mapping →
 * EAV pivot → unbacked.
 */
function classifyColumn(view: MutableViewLike, shape: DecompShape, name: string): ColumnRoute {
	const col = shape.columns.find(c => c.name === name);
	// An identity base column on a join member, routed by the plan-node lineage.
	if (col?.baseColumn !== undefined && col.baseTableId !== undefined && col.inverse === undefined) {
		const member = shape.memberByTableId.get(col.baseTableId);
		if (member) return { kind: 'member', member, baseColumn: col.baseColumn, nullExtended: col.nullExtended };
		// The lineage resolved an **identity** base column (a base site, no inverse),
		// but no decomposition member owns its base `TableReferenceNode`. In a
		// faithfully-synthesized body every base table-ref IS a member, so this is a
		// lineage-resolution miss (e.g. a `memberByTableId` schema/name mismatch), NOT a
		// non-identity mapping. Reject defensively — falling through to the name-only
		// `member.columns` match below would silently degrade a *writable* column to
		// `computed-mapping` (read-only), masking the lineage bug as a benign read-only
		// column.
		raiseMutationDiagnostic({
			reason: 'no-base-lineage',
			column: col.displayName,
			table: view.name,
			message: `cannot write through logical table '${view.name}': column '${col.displayName}' resolves to identity base column '${col.baseColumn}', but no decomposition member backs its base relation (lineage-resolution miss); a writable column must not silently degrade to read-only`,
		});
	}
	// A `member.columns` mapping the lineage did not resolve to an identity base column
	// is a non-identity (computed / non-invertible) mapping — read-only.
	for (const member of shape.storage.members) {
		if (member.columns.some(c => c.logicalColumn.toLowerCase() === name)) {
			return { kind: 'computed-mapping', member };
		}
	}
	// An EAV pivot backs a logical column the get body projects as a (non-column)
	// correlated subquery — never a `member.columns` entry, so the loops above miss it.
	const projected = shape.viewColToBaseRef.get(name);
	if (projected && projected.type !== 'column') {
		const eav = shape.storage.members.find(m => m.attributePivot);
		if (eav) return { kind: 'eav', member: eav };
	}
	return { kind: 'unbacked' };
}

/**
 * Decompose a mutation through a decomposition-backed logical table into an
 * ordered `BaseOp[]`. Throws a structured diagnostic for any deferred shape.
 */
export function propagateDecomposition(
	ctx: PlanningContext,
	view: MutableViewLike,
	storage: StorageShape,
	req: MutationRequest,
): BaseOp[] {
	const shape = analyzeDecomposition(ctx, view, storage);

	switch (req.op) {
		case 'delete': return decomposeDelete(ctx, view, shape, req.stmt);
		case 'update': return decomposeUpdate(ctx, view, shape, req.stmt);
		case 'insert':
			// INSERT needs the plan-level shared-surrogate envelope (materialized
			// source + per-row mint), which the AST `BaseOp[]` model cannot express,
			// so it is built directly by `building/view-mutation-builder.ts`
			// (`buildDecompositionInsert`, off `analyzeDecompositionInsert` below).
			// `buildViewMutation` routes a decomposition insert there before
			// `propagate` runs, so this case is unreachable on the supported path.
			raiseMutationDiagnostic({
				reason: 'unsupported-decomposition-insert',
				table: view.name,
				message: `internal: decomposition insert must be built via buildDecompositionInsert, not propagate`,
			});
	}
}

// --- INSERT (shared-surrogate / logical-tuple envelope analysis) ----------

/**
 * One target column of a member insert: its value comes from the materialized
 * envelope (by index) or is a constant literal (the EAV attribute name).
 */
export interface DecompInsertColumn {
	readonly baseColumn: string;
	/** Index into the materialized envelope row supplying the value. */
	readonly envelopeIndex?: number;
	/** Constant value (the EAV attribute literal) when no envelope column supplies it. */
	readonly literal?: SqlValue;
}

/**
 * One base insert a decomposition insert fans out to — one per columnar member,
 * or one per supplied EAV attribute (a triple).
 */
export interface DecompInsertOp {
	readonly table: TableReferenceNode;
	readonly schema: TableSchema;
	readonly columns: readonly DecompInsertColumn[];
	/**
	 * Envelope indices whose non-null presence gates this op per-row: an optional
	 * member inserts only for rows that supply ≥1 of its columns; an EAV triple only
	 * when its value is non-null (the outer-join absence semantics the read
	 * preserves). Empty ⇒ unconditional (mandatory member / singleton).
	 */
	readonly presenceGateIndices: readonly number[];
}

/**
 * The plan-agnostic decomposition of a decomposition INSERT, consumed by
 * `buildDecompositionInsert` (`building/view-mutation-builder.ts`). The **envelope**
 * leading columns are the supplied logical columns (in user-source order),
 * optionally followed by a surrogate shared key sourced from the anchor key
 * column's declared `default` (`keyDefault`). Each member op reads its values back
 * out of that one materialized envelope, so the default is evaluated once per
 * produced row and the value threads across every member insert via the
 * equivalence class (docs/vu-mutation-context.md § Mutation Context, docs/lens.md § The Default Mapper).
 */
export interface DecompInsertAnalysis {
	readonly suppliedColumns: readonly { readonly name: string; readonly type: ScalarType }[];
	/** Member base inserts, anchor first (then advertisement order). */
	readonly ops: readonly DecompInsertOp[];
	/**
	 * The anchor key column's declared `default` — the surrogate's per-row source.
	 * Set only for a surrogate shared key (the engine evaluates it once per produced
	 * row at the envelope, with `mutation_ordinal()` in scope, and threads the value
	 * into every member's key column via the equivalence class). Absent for a
	 * logical-tuple (supplied) key.
	 */
	readonly keyDefault?: AST.Expression;
	/**
	 * The schema owning the ANCHOR MEMBER's base table — where {@link keyDefault} was
	 * declared, which may differ from the logical table's own schema. It is the schema
	 * the default's unqualified relation names resolve against
	 * (`schemaAuthoredContext`), so it must travel with the expression. Set exactly
	 * when `keyDefault` is.
	 */
	readonly keyDefaultSchemaName?: string;
}

/** One supplied logical column routed to its backing member. */
interface RoutedInsertColumn {
	/** Lowercased logical column name (for routing / key matching). */
	readonly name: string;
	readonly envelopeIndex: number;
	readonly type: ScalarType;
	/** A direct (identity) column mapping on a member. */
	readonly columnar?: { readonly relationId: string; readonly basisColumn: string };
	/** An EAV pivot member backing this column as a triple. */
	readonly eav?: DecompositionMember;
	/**
	 * The attribute literal to store for an EAV column — the logical column's
	 * **declared** name (case preserved), since the get body matches the pivot's
	 * attribute column against that literal by exact value (it does not case-fold).
	 */
	readonly eavAttribute?: string;
}

/**
 * Decompose an INSERT through a decomposition-backed logical table into the
 * per-member base inserts plus the shared-surrogate envelope they fan out from
 * (anchor first — the FK-order root). Throws a structured diagnostic for any
 * deferred shape (composite/absent key, non-integer surrogate, an uncoverable
 * not-null member column, a computed/unbacked logical column).
 */
export function analyzeDecompositionInsert(
	ctx: PlanningContext,
	view: MutableViewLike,
	storage: StorageShape,
	stmt: AST.InsertStmt,
): DecompInsertAnalysis {
	rejectReturning(view, stmt.returning);

	const shape = analyzeDecomposition(ctx, view, storage);
	const anchor = shape.anchor;

	// Resolve every member's table once (reused for schema lookups + the seed table).
	const memberRefs = new Map<string, TableReferenceNode>();
	for (const m of storage.members) memberRefs.set(m.relationId, resolveMemberTable(ctx, m));

	// Supplied logical columns: the explicit list, or every projected logical column
	// (in projection order — the order the shared backward consumer enumerates them).
	const suppliedNames = stmt.columns && stmt.columns.length > 0
		? stmt.columns
		: shape.columns.map(c => c.name);

	// Declared-case logical column names (the get body's projection aliases) — the
	// exact attribute literals an EAV write must store (the read does not case-fold).
	const declaredNames = declaredColumnNames(view);

	const routed = suppliedNames.map((raw, idx): RoutedInsertColumn =>
		routeInsertColumn(view, shape, memberRefs, declaredNames, raw, idx));

	// Shared key: a surrogate's value comes from the anchor key column's declared
	// `default`, evaluated once per row at the envelope; a logical-tuple threads the
	// supplied logical PK. `keyEnvelopeIndex` is the envelope column every member's key
	// column reads (the default-sourced column for a surrogate, the supplied PK column
	// for a logical-tuple, or undefined for the singleton empty key).
	const { keyEnvelopeIndex, keyDefault, keyDefaultSchemaName } = resolveInsertSharedKey(view, shape, memberRefs, routed);

	// Member ops, anchor first (FK-order root: members may FK-reference the anchor).
	const ops: DecompInsertOp[] = [];
	emitMemberInsert(view, shape, memberRefs, routed, keyEnvelopeIndex, anchor, ops);
	for (const member of storage.members) {
		if (member.relationId === anchor.relationId) continue;
		emitMemberInsert(view, shape, memberRefs, routed, keyEnvelopeIndex, member, ops);
	}

	return {
		suppliedColumns: routed.map(r => ({ name: r.name, type: r.type })),
		ops,
		keyDefault,
		keyDefaultSchemaName,
	};
}

/**
 * Route one supplied logical column to a columnar member mapping or an EAV pivot,
 * off the threaded backward lineage ({@link classifyColumn}). A columnar route binds
 * the value to its member's identity base column; an EAV route writes an attribute
 * triple gated on the value. Optional members are insertable here (the per-row
 * presence gate in {@link emitMemberInsert} drops absent components).
 */
function routeInsertColumn(
	view: MutableViewLike,
	shape: DecompShape,
	memberRefs: ReadonlyMap<string, TableReferenceNode>,
	declaredNames: ReadonlyMap<string, string>,
	rawName: string,
	idx: number,
): RoutedInsertColumn {
	const name = rawName.toLowerCase();
	rejectAuthoredDecompositionWrite(view, shape, name, rawName);
	const route = classifyColumn(view, shape, name);
	switch (route.kind) {
		case 'member': {
			const ref = memberRefs.get(route.member.relationId)!;
			const col = columnByName(view, ref.tableSchema, route.baseColumn);
			return { name, envelopeIndex: idx, type: columnSchemaToScalarType(col), columnar: { relationId: route.member.relationId, basisColumn: route.baseColumn } };
		}
		case 'eav': {
			const ref = memberRefs.get(route.member.relationId)!;
			const valCol = columnByName(view, ref.tableSchema, route.member.attributePivot!.valueColumn);
			return { name, envelopeIndex: idx, type: columnSchemaToScalarType(valCol), eav: route.member, eavAttribute: declaredNames.get(name) ?? rawName };
		}
		case 'computed-mapping':
			return raiseMutationDiagnostic({
				reason: 'no-inverse',
				column: rawName,
				table: view.name,
				message: `cannot insert into logical table '${view.name}': column '${rawName}' is a computed (non-invertible) decomposition mapping and cannot receive an inserted value`,
			});
		case 'unbacked':
			return raiseMutationDiagnostic({
				reason: 'no-inverse',
				column: rawName,
				table: view.name,
				message: `cannot insert into logical table '${view.name}': column '${rawName}' is not backed by any decomposition member`,
			});
	}
}

/** Resolve the shared key envelope index + optional anchor-default source for an insert. */
function resolveInsertSharedKey(
	view: MutableViewLike,
	shape: DecompShape,
	memberRefs: ReadonlyMap<string, TableReferenceNode>,
	routed: readonly RoutedInsertColumn[],
): {
	keyEnvelopeIndex: number | undefined;
	keyDefault: DecompInsertAnalysis['keyDefault'];
	keyDefaultSchemaName: DecompInsertAnalysis['keyDefaultSchemaName'];
} {
	const sharedKey = shape.storage.sharedKey;
	const anchor = shape.anchor;

	if (sharedKey.kind === 'surrogate') {
		const anchorKeys = memberKeyColumns(view, shape, anchor);
		if (anchorKeys.length !== 1) {
			raiseMutationDiagnostic({
				reason: 'unsupported-decomposition-key',
				table: view.name,
				message: `cannot insert into logical table '${view.name}': a surrogate decomposition needs a single-column key on the anchor '${anchor.relationId}' (v1 threads a single-column surrogate)`,
			});
		}
		const anchorRef = memberRefs.get(anchor.relationId)!;
		// The surrogate's value comes from the anchor key column's declared `default`
		// (the engine no longer auto-generates one): evaluated once per row at the
		// envelope and EC-threaded into every member's key column.
		const keyDefault = requireKeyDefault(view, anchorRef.tableSchema, columnByName(view, anchorRef.tableSchema, anchorKeys[0]));
		return {
			keyEnvelopeIndex: routed.length, // the default-sourced column is appended last
			keyDefault,
			// Schema-authored on the anchor's BASE table, not on the logical table — carry
			// its owner so the build narrows the path to the right schema.
			keyDefaultSchemaName: anchorRef.tableSchema.schemaName,
		};
	}

	// logical-tuple: the supplied logical PK threads to every member's key column.
	const anchorKeys = memberKeyColumns(view, shape, anchor);
	if (anchorKeys.length === 0) {
		// singleton — no key to thread
		return { keyEnvelopeIndex: undefined, keyDefault: undefined, keyDefaultSchemaName: undefined };
	}
	const anchorKeyCol = anchorKeys[0].toLowerCase();
	const keyRouted = routed.find(r => r.columnar
		&& r.columnar.relationId === anchor.relationId
		&& r.columnar.basisColumn.toLowerCase() === anchorKeyCol);
	if (!keyRouted) {
		raiseMutationDiagnostic({
			reason: 'no-default',
			table: view.name,
			message: `cannot insert into logical table '${view.name}': the logical-tuple shared key (anchor '${anchor.relationId}' column '${anchorKeys[0]}') is not supplied through the logical table; a logical-tuple key threads the supplied value, so it must be provided`,
		});
	}
	return { keyEnvelopeIndex: keyRouted.envelopeIndex, keyDefault: undefined, keyDefaultSchemaName: undefined };
}

/**
 * The anchor key column's declared `default` — the surrogate's per-row source —
 * evaluated once per produced row at the envelope (with `mutation_ordinal()` in
 * scope) and EC-threaded into every member's key column. The engine no longer
 * invents a surrogate: a surrogate key whose anchor column declares no default
 * raises `no-default` with the migration recipe.
 */
function requireKeyDefault(view: MutableViewLike, schema: TableSchema, keyCol: ColumnSchema): AST.Expression {
	if (keyCol.defaultValue === null) {
		raiseMutationDiagnostic({
			reason: 'no-default',
			column: keyCol.name,
			table: view.name,
			message: `cannot insert into logical table '${view.name}': the surrogate shared key '${schema.name}.${keyCol.name}' declares no DEFAULT; a surrogate's value comes from the anchor key column's default (e.g. \`default (coalesce((select max(${keyCol.name}) from ${schema.name}), 0) + mutation_ordinal())\`) — the engine no longer auto-generates one`,
			suggestion: `declare a DEFAULT on '${schema.name}.${keyCol.name}', or expose the key as a supplied logical column`,
		});
	}
	return keyCol.defaultValue;
}

/** Emit the base insert op(s) for one member (one columnar op, or one triple per supplied EAV attribute). */
function emitMemberInsert(
	view: MutableViewLike,
	shape: DecompShape,
	memberRefs: ReadonlyMap<string, TableReferenceNode>,
	routed: readonly RoutedInsertColumn[],
	keyEnvelopeIndex: number | undefined,
	member: DecompositionMember,
	ops: DecompInsertOp[],
): void {
	const ref = memberRefs.get(member.relationId)!;
	const schema = ref.tableSchema;

	if (member.attributePivot) {
		// EAV pivot: one triple insert per supplied attribute, gated on a non-null value.
		const pivot = member.attributePivot;
		for (const r of routed) {
			if (r.eav?.relationId !== member.relationId) continue;
			const columns: DecompInsertColumn[] = [
				{ baseColumn: pivot.entityColumn, envelopeIndex: requireKeyIndex(view, member, keyEnvelopeIndex) },
				{ baseColumn: pivot.attributeColumn, literal: r.eavAttribute ?? r.name },
				{ baseColumn: pivot.valueColumn, envelopeIndex: r.envelopeIndex },
			];
			assertNoMissingNotNull(view, schema, columns);
			ops.push({ table: ref, schema, columns, presenceGateIndices: [r.envelopeIndex] });
		}
		return;
	}

	const ownedSupplied = routed.filter(r => r.columnar?.relationId === member.relationId);
	// An optional member with no supplied columns materializes no row (the read's
	// outer join already yields null for an absent component).
	if (member.presence === 'optional' && ownedSupplied.length === 0) return;

	const memberKeys = memberKeyColumns(view, shape, member);
	const columns: DecompInsertColumn[] = [];
	if (memberKeys.length === 1) {
		columns.push({ baseColumn: memberKeys[0], envelopeIndex: requireKeyIndex(view, member, keyEnvelopeIndex) });
	}
	const keyColLower = memberKeys[0]?.toLowerCase();
	for (const r of ownedSupplied) {
		// The anchor's own key column is already threaded above; don't double-insert it.
		if (keyColLower && r.columnar!.basisColumn.toLowerCase() === keyColLower) continue;
		columns.push({ baseColumn: r.columnar!.basisColumn, envelopeIndex: r.envelopeIndex });
	}
	assertNoMissingNotNull(view, schema, columns);

	// Optional members are gated per-row on supplying ≥1 of their (non-key) values.
	const gate = member.presence === 'optional'
		? ownedSupplied.filter(r => r.columnar!.basisColumn.toLowerCase() !== keyColLower).map(r => r.envelopeIndex)
		: [];
	ops.push({ table: ref, schema, columns, presenceGateIndices: gate });
}

/** The shared-key columns for a member (0 for a singleton; >1 is a deferred composite key). */
function memberKeyColumns(view: MutableViewLike, shape: DecompShape, member: DecompositionMember): string[] {
	const keys = shape.storage.sharedKey.keyColumnsByRelation.get(member.relationId) ?? [];
	if (keys.length > 1) {
		raiseMutationDiagnostic({
			reason: 'unsupported-decomposition-key',
			table: view.name,
			message: `cannot write through a decomposition with a composite shared key on member '${member.relationId}': v1 fan-out threads a single-column key`,
		});
	}
	return [...keys];
}

/** A member needs a shared key value to thread, but the decomposition's key is empty (singleton). */
function requireKeyIndex(view: MutableViewLike, member: DecompositionMember, keyEnvelopeIndex: number | undefined): number {
	if (keyEnvelopeIndex === undefined) {
		raiseMutationDiagnostic({
			reason: 'unsupported-decomposition-key',
			table: view.name,
			message: `cannot insert into logical table '${view.name}': member '${member.relationId}' needs a shared key value to thread, but the decomposition has an empty (singleton) key`,
		});
	}
	return keyEnvelopeIndex;
}

/** Reject a not-null base column with no declared default that no envelope value covers. */
function assertNoMissingNotNull(view: MutableViewLike, schema: TableSchema, columns: readonly DecompInsertColumn[]): void {
	const covered = new Set(columns.map(c => c.baseColumn.toLowerCase()));
	for (const col of schema.columns) {
		if (col.generated || !col.notNull || col.defaultValue !== null) continue;
		if (covered.has(col.name.toLowerCase())) continue;
		raiseMutationDiagnostic({
			reason: 'no-default',
			column: col.name,
			table: view.name,
			message: `cannot insert into logical table '${view.name}': basis relation '${schema.name}' column '${col.name}' is NOT NULL with no default and no value reaches it through the decomposition`,
		});
	}
}

function columnByName(view: MutableViewLike, schema: TableSchema, name: string): ColumnSchema {
	const col = schema.columns.find(c => c.name.toLowerCase() === name.toLowerCase());
	if (!col) {
		raiseMutationDiagnostic({
			reason: 'no-base-lineage',
			table: view.name,
			column: name,
			message: `cannot write through logical table '${view.name}': column '${name}' not found on basis relation '${schema.name}'`,
		});
	}
	return col;
}

/**
 * Map each logical column's lowercased name → its **declared** name, read off the
 * get body's projection aliases (`<expr> as <col.name>`). The declared name is the
 * exact attribute literal `compileDecompositionBody` matches an EAV column against,
 * so an EAV write must store that spelling (the read does not case-fold).
 */
function declaredColumnNames(view: MutableViewLike): Map<string, string> {
	const map = new Map<string, string>();
	const sel = view.selectAst;
	if (sel.type !== 'select') return map;
	for (const rc of sel.columns) {
		if (rc.type !== 'column') continue;
		const name = rc.alias ?? (rc.expr.type === 'column' ? rc.expr.name : undefined);
		if (name) map.set(name.toLowerCase(), name);
	}
	return map;
}

// --- DELETE ---------------------------------------------------------------

/**
 * Fan a logical delete out to every member. Order anchor-last; each non-anchor
 * member's identifying set is `select <anchorKey> from <anchor> where <pred>`, so
 * deleting other members never changes it. The anchor's own delete then applies
 * the predicate directly against the anchor (its IN subquery would self-reference
 * the rows it removes, so the bare-predicate form is both simpler and clearer).
 */
function decomposeDelete(ctx: PlanningContext, view: MutableViewLike, shape: DecompShape, stmt: AST.DeleteStmt): BaseOp[] {
	rejectReturning(view, stmt.returning);
	const pred = anchorPredicate(view, shape, stmt.where);

	const ops: BaseOp[] = [];
	// Non-anchor members first (each reads the still-intact anchor), anchor last.
	for (const member of shape.storage.members) {
		if (member.relationId === shape.anchor.relationId) continue;
		ops.push(memberDeleteOp(ctx, view, shape, member, pred, stmt));
	}
	ops.push(anchorDeleteOp(ctx, view, shape, pred, stmt));
	return ops;
}

/**
 * One member's delete. No predicate ⇒ an unconditional `delete from <member>`
 * (truncate the component — also the sound singleton path, which has no key to
 * thread). With an anchor predicate ⇒ `delete from <member> where
 * <memberKeyOrEntity> in (select <anchorKey> from <anchor> where <pred>)`.
 */
function memberDeleteOp(
	ctx: PlanningContext,
	view: MutableViewLike,
	shape: DecompShape,
	member: DecompositionMember,
	pred: AST.Expression | undefined,
	stmt: AST.DeleteStmt,
): BaseOp {
	let where: AST.Expression | undefined;
	if (pred) {
		const memberCol = member.attributePivot
			? member.attributePivot.entityColumn // EAV: delete every triple for the matched entities
			: singleKeyColumn(view, shape, member);
		where = { type: 'in', expr: { type: 'column', name: memberCol }, subquery: anchorKeySubquery(shape, pred) };
	}
	const statement: AST.DeleteStmt = {
		type: 'delete',
		table: memberIdentifier(member),
		where,
		contextValues: stmt.contextValues,
		schemaPath: stmt.schemaPath,
		loc: stmt.loc,
	};
	return { table: resolveMemberTable(ctx, member), op: 'delete', statement };
}

/** `delete from <anchor> [where <pred bare>]`. */
function anchorDeleteOp(
	ctx: PlanningContext,
	view: MutableViewLike,
	shape: DecompShape,
	pred: AST.Expression | undefined,
	stmt: AST.DeleteStmt,
): BaseOp {
	const statement: AST.DeleteStmt = {
		type: 'delete',
		table: memberIdentifier(shape.anchor),
		where: pred ? stripAnchorQualifier(pred, shape) : undefined,
		contextValues: stmt.contextValues,
		schemaPath: stmt.schemaPath,
		loc: stmt.loc,
	};
	return { table: resolveMemberTable(ctx, shape.anchor), op: 'delete', statement };
}

// --- UPDATE ---------------------------------------------------------------

/**
 * Route each assignment to the member that backs it and emit the per-member base
 * ops, anchor-last (so a member whose column the predicate reads is not mutated
 * before a sibling's identifying set is computed, and so every materialization
 * branch reads the still-intact anchor). A **mandatory, non-EAV** member takes one
 * base UPDATE (the legacy path). An **optional columnar** member's write is a per-row
 * materialization transition — matched → base UPDATE, absent → null-extended INSERT,
 * all value columns set null → base DELETE — and an **EAV pivot** member's write is
 * the per-attribute triple analogue (non-null → upsert, null → delete). The branches
 * are ordinary AST base ops keyed off the anchor subquery, not a new plan-node
 * substrate (the same realization consumer 1 used for the outer-join dual). Shared-key
 * (identity) / computed targets stay rejected.
 *
 * `capturedValues` is the optional **capture carrier** the builder threads (parallel to
 * `decomposeUpdate`'s `sourceValues` in multi-source.ts): when present, an **arbitrary**
 * value on an *optional columnar* member OR an **EAV** member (a subquery, cross-member, or
 * mixed anchor+self — and, for EAV, any self-reference, since an EAV value column lowers to a
 * subquery — otherwise rejected) is lowered to base terms and accumulated as a `srcN`
 * projection, and its cell rides the per-row capture two-op path
 * ({@link emitCapturedMemberUpdate} for columnar, {@link emitEavCapturedAttr} for EAV); the
 * builder then materializes the values once over the planned body
 * ({@link buildDecompositionKeyCapture}) and every base op reads them back through the
 * context-injected `__vmupd_keys`. Absent the carrier (the legacy `propagateDecomposition`
 * path, unreachable from build), an arbitrary value stays rejected — the defensive legacy
 * behaviour, exactly as `propagateMultiSource`'s update path does.
 */
export function decomposeUpdate(
	ctx: PlanningContext,
	view: MutableViewLike,
	shape: DecompShape,
	stmt: AST.UpdateStmt,
	capturedValues?: CapturedDecompValue[],
): BaseOp[] {
	rejectReturning(view, stmt.returning);
	const pred = anchorPredicate(view, shape, stmt.where);
	const declaredNames = declaredColumnNames(view);

	// Capture carrier (mirrors multi-source.ts `decomposeUpdate`'s `registerCapturedExpr`):
	// project an already-lowered base-term value into the up-front `__vmupd_keys` capture under
	// a stable `srcN` alias (deduped by `key`), returning that alias. `canCapture` gates whether
	// an arbitrary value — on an optional-columnar OR an EAV member — is admitted (carrier present)
	// or rejected (the legacy carrier-absent path).
	const canCapture = capturedValues !== undefined;
	const srcDedup = new Map<string, string>();
	const registerCapturedExpr = capturedValues
		? (key: string, expr: AST.Expression): string => {
			const existing = srcDedup.get(key);
			if (existing) return existing;
			const alias = `src${capturedValues.length}`;
			srcDedup.set(key, alias);
			capturedValues.push({ alias, expr });
			return alias;
		}
		: undefined;

	// Per-member accumulation. A member is exactly one kind (mandatory-columnar /
	// optional-columnar / EAV), so at most one of the three maps holds a given member.
	const mandatory = new Map<string, Array<{ column: string; value: AST.Expression }>>();
	const optional = new Map<string, { member: DecompositionMember; cells: OptionalCell[] }>();
	const eav = new Map<string, { member: DecompositionMember; cells: EavCell[] }>();
	// member relationId → (target-key lower → first view-column spelling). Two distinct
	// logical columns can route to the same basis column / EAV attribute on one member
	// (e.g. a duplicate rename `b, b as b2`); the per-member UPDATE / triple would then
	// assign it twice. Reject view-aware so the message names both logical columns.
	const seenPerMember = new Map<string, Map<string, string>>();
	const noteTarget = (relationId: string, targetKey: string, viewCol: string): void => {
		let seen = seenPerMember.get(relationId);
		if (!seen) { seen = new Map<string, string>(); seenPerMember.set(relationId, seen); }
		const prior = seen.get(targetKey);
		if (prior !== undefined) {
			raiseMutationDiagnostic({
				reason: 'conflicting-assignment',
				column: viewCol,
				table: view.name,
				message: `cannot update logical table '${view.name}': columns '${prior}' and '${viewCol}' both target '${targetKey}' on member '${relationId}'; an UPDATE cannot assign one column twice`,
			});
		}
		seen.set(targetKey, viewCol);
	};

	for (const asg of stmt.assignments) {
		const routed = routeAssignment(view, shape, declaredNames, asg, canCapture);
		switch (routed.kind) {
			case 'mandatory': {
				noteTarget(routed.member.relationId, routed.basisColumn.toLowerCase(), asg.column);
				let list = mandatory.get(routed.member.relationId);
				if (!list) { list = []; mandatory.set(routed.member.relationId, list); }
				list.push({ column: routed.basisColumn, value: routed.value });
				break;
			}
			case 'optional': {
				noteTarget(routed.member.relationId, routed.basisColumn.toLowerCase(), asg.column);
				let g = optional.get(routed.member.relationId);
				if (!g) { g = { member: routed.member, cells: [] }; optional.set(routed.member.relationId, g); }
				g.cells.push({ basisColumn: routed.basisColumn, value: routed.value, isNull: routed.isNull, kind: routed.valueKind });
				break;
			}
			case 'eav': {
				noteTarget(routed.member.relationId, `attr:${routed.attribute.toLowerCase()}`, asg.column);
				let g = eav.get(routed.member.relationId);
				if (!g) { g = { member: routed.member, cells: [] }; eav.set(routed.member.relationId, g); }
				g.cells.push({ attribute: routed.attribute, value: routed.value, isNull: routed.isNull, kind: routed.valueKind });
				break;
			}
		}
	}

	const ops: BaseOp[] = [];
	const emit = (member: DecompositionMember): void => {
		const m = mandatory.get(member.relationId);
		if (m && m.length > 0) ops.push(memberUpdateOp(ctx, view, shape, member, m, pred, stmt));
		const o = optional.get(member.relationId);
		if (o) emitOptionalMemberUpdate(ctx, view, shape, member, o.cells, pred, stmt, ops, registerCapturedExpr);
		const e = eav.get(member.relationId);
		if (e) emitEavMemberUpdate(ctx, view, shape, member, e.cells, pred, stmt, ops, registerCapturedExpr);
	};
	for (const member of shape.storage.members) {
		if (member.relationId === shape.anchor.relationId) continue;
		emit(member);
	}
	emit(shape.anchor); // anchor last
	return ops;
}

/**
 * One arbitrary optional-columnar value captured into the up-front `__vmupd_keys` set: the
 * `expr` is the assigned value lowered to base terms (member-relationId-qualified, over the
 * planned get body), projected into the capture under the stable `alias` (`src0`, `src1`, …).
 * Each base op reads it back correlated by the stitch key — by the member key (matched UPDATE)
 * or the anchor key (materialize INSERT) — so the value is the **pre-mutation** one regardless
 * of base-op order (the decomposition analogue of multi-source.ts `CrossSourceValue`).
 */
export interface CapturedDecompValue {
	readonly alias: string;
	readonly expr: AST.Expression;
}

/**
 * How an optional/EAV-member assigned value is scoped, after lowering to base terms — the
 * gate on whether a non-constant value is expressible without, or with, the capture substrate.
 */
type ValueKind =
	/** No column ref (a constant, or the null-literal delete / absent-no-op trigger). */
	| 'constant'
	/** Every leaf resolves to an **anchor** base column (`set c = a + 1`) — unified via an upsert. */
	| 'anchor'
	/** Every leaf is the **owning member's** own column (`set c = c + 1`) — matched UPDATE for present
	 *  rows plus a null-substituted, non-empty-filtered materialize INSERT for absent rows (columnar). */
	| 'self'
	/** An **arbitrary** optional-columnar value (subquery / cross-member / mixed anchor+self) admitted
	 *  via the single-identity per-row capture: materialized once over the planned body, read back by
	 *  the stitch key in both branches ({@link emitCapturedMemberUpdate}). Columnar + carrier only. */
	| 'captured';

/** A lowered optional/EAV-member value plus its {@link ValueKind} classification. */
interface LoweredValue {
	readonly kind: ValueKind;
	/** Assigned value, lowered to base terms (member-relationId-qualified column refs). */
	readonly value: AST.Expression;
	/** True for a syntactic null literal (always `constant`; the all-null delete / no-op trigger). */
	readonly isNull: boolean;
}

/** One assigned cell of an optional columnar member's update group. */
interface OptionalCell {
	readonly basisColumn: string;
	/** Assigned value, already lowered to base terms (a constant, anchor-resolvable, self, or an
	 *  arbitrary `captured` expr — the latter projected into `__vmupd_keys` over the planned body). */
	readonly value: AST.Expression;
	readonly isNull: boolean;
	readonly kind: ValueKind;
}

/** One assigned cell of an EAV pivot member's update group (per attribute). */
interface EavCell {
	/** The declared (case-preserved) attribute literal the get body matches by value. */
	readonly attribute: string;
	readonly value: AST.Expression;
	readonly isNull: boolean;
	/**
	 * `constant`, `anchor`, or `captured` — an EAV value column substitutes to a correlated
	 * subquery, so any EAV self-reference (or cross-member / embedded-subquery value) lowers to
	 * a subquery and lands `captured`, threaded through the per-attribute triple pair at emit. A
	 * `self` cell never reaches an EAV group (it requires bare owner-column refs, which an EAV
	 * value never has). `captured` requires the build-path capture carrier.
	 */
	readonly kind: ValueKind;
}

type RoutedAssignment =
	/** A mandatory, non-EAV identity member — the legacy single base UPDATE. */
	| { readonly kind: 'mandatory'; readonly member: DecompositionMember; readonly basisColumn: string; readonly value: AST.Expression }
	/** An optional (outer-joined) columnar member — a per-row materialization transition. */
	| { readonly kind: 'optional'; readonly member: DecompositionMember; readonly basisColumn: string; readonly value: AST.Expression; readonly isNull: boolean; readonly valueKind: ValueKind }
	/** An EAV pivot member — a per-attribute triple upsert/delete. */
	| { readonly kind: 'eav'; readonly member: DecompositionMember; readonly attribute: string; readonly value: AST.Expression; readonly isNull: boolean; readonly valueKind: ValueKind };

/**
 * Resolve one `set <col> = <value>` to its backing member off the threaded backward
 * lineage ({@link classifyColumn}). A mandatory, non-EAV identity member is the legacy
 * value-write; an **optional columnar** member and an **EAV pivot** member are now
 * routed to a per-row materialization transition (matched update / absent insert /
 * emptied delete) instead of rejected. A shared-key (identity) / computed / unbacked
 * target stays rejected with its precise diagnostic.
 */
function routeAssignment(view: MutableViewLike, shape: DecompShape, declaredNames: ReadonlyMap<string, string>, asg: AST.UpdateStmt['assignments'][number], canCapture: boolean): RoutedAssignment {
	const logical = asg.column.toLowerCase();
	if (isSharedKeyColumn(shape, logical)) {
		raiseMutationDiagnostic({
			reason: 'unsupported-decomposition-update',
			column: asg.column,
			table: view.name,
			message: `cannot update logical table '${view.name}': column '${asg.column}' is part of the decomposition shared key; an identity change is not a value write`,
		});
	}
	rejectAuthoredDecompositionWrite(view, shape, logical, asg.column);
	const route = classifyColumn(view, shape, logical);
	switch (route.kind) {
		case 'member': {
			// An optional member is outer-joined (null-extended lineage): writing it is a
			// per-row materialization transition (matched → update, absent → insert, all
			// value columns null → delete), realized as anchor-keyed AST base ops below.
			if (route.member.presence !== 'mandatory' || route.nullExtended) {
				const { kind, value, isNull } = lowerMaterializedValue(view, shape, route.member, asg, canCapture);
				return { kind: 'optional', member: route.member, basisColumn: route.baseColumn, value, isNull, valueKind: kind };
			}
			return { kind: 'mandatory', member: route.member, basisColumn: route.baseColumn, value: rewriteAssignedValue(view, shape, route.member, asg.value) };
		}
		case 'eav': {
			// An EAV pivot backs its logical columns as attribute triples: a null deletes the
			// triple, a constant/anchor value upserts it, and an arbitrary value (a self-reference,
			// cross-member, or subquery — all of which lower to a subquery for EAV) rides the
			// single-identity capture when the carrier is present (`canCapture`), else is rejected.
			const { kind, value, isNull } = lowerMaterializedValue(view, shape, route.member, asg, canCapture);
			return { kind: 'eav', member: route.member, attribute: declaredNames.get(logical) ?? asg.column, value, isNull, valueKind: kind };
		}
		case 'computed-mapping':
			return raiseMutationDiagnostic({
				reason: 'no-inverse',
				column: asg.column,
				table: view.name,
				message: `cannot update logical table '${view.name}': column '${asg.column}' is a computed (non-invertible) decomposition mapping and is read-only`,
			});
		case 'unbacked':
			return raiseMutationDiagnostic({
				reason: 'no-inverse',
				column: asg.column,
				table: view.name,
				message: `cannot update logical table '${view.name}': column '${asg.column}' is not backed by any decomposition member`,
			});
	}
}

/**
 * Lower an optional/EAV-member assigned value to base terms and classify how it is
 * scoped ({@link LoweredValue}). The matched write evaluates the value in the **member's**
 * row scope while the materialize INSERT evaluates it over the **anchor** scan — so a
 * non-constant value is only expressible when both branches can agree on it with **no new
 * runtime substrate**. Three self-contained shapes qualify:
 *
 * - **constant** (no column ref, or a null literal) — survives both scopes trivially.
 * - **anchor** — every leaf resolves to an anchor base column (`set c = a + 1`). The value
 *   is computed once over the anchor scan and the two branches are unified by an upsert
 *   ({@link buildOptionalMemberInsertSelect} `do update`), so the matched side reads the
 *   identical anchor-computed value via `excluded.<col>`.
 * - **self** (columnar only) — every leaf is the owning member's own column (`set c = c + 1`,
 *   `set c = coalesce(c, 0) + 1`). Present rows take the matched UPDATE (their real prior value);
 *   absent rows take a materialize INSERT computing the self-expression with the owner's columns
 *   substituted to NULL, gated by a runtime non-empty filter. The matched and materialize branches
 *   read different scans (member vs null-substituted anchor), so they stay two distinct ops — not
 *   an upsert (see {@link emitOptionalMemberUpdate} / {@link buildSelfMaterializeInsertSelect}).
 *
 * Anything else — a subquery, a cross-member column, an unqualified ref, or a single value
 * mixing anchor and self leaves — is **arbitrary**. With a capture carrier present (`canCapture`)
 * it is admitted as `captured` on **both** an optional columnar member and an **EAV** member:
 * lowered to base terms and (at emit) projected into the up-front `__vmupd_keys` set, read back by
 * the stitch key in both branches — by the member key for columnar ({@link emitCapturedMemberUpdate}),
 * by the entity column / anchor key for the EAV per-attribute triple pair ({@link emitEavMemberUpdate}).
 * An EAV value column substitutes to a correlated subquery, so an EAV self-reference (`set p = p + 1`)
 * lowers to a subquery and reaches here as `captured` (only the carrier-absent legacy
 * `propagateDecomposition` path still rejects it). Classification reads the lowered value's
 * column-ref **relationId qualifiers** (the synthesized body aliases each member by its
 * relationId — the same qualifier {@link rewriteAssignedValue} keys cross-member rejection on);
 * the owner is never the anchor (an optional/EAV member is mandatory-distinct), so `anchor` and
 * `self` never collide.
 */
function lowerMaterializedValue(view: MutableViewLike, shape: DecompShape, owner: DecompositionMember, asg: AST.UpdateStmt['assignments'][number], canCapture: boolean): LoweredValue {
	const lowered = substituteViewColumns(asg.value, shape, view);
	const isNull = isNullLiteral(lowered);
	const { qualifiers, hasUnqualifiedColumn, hasSubquery } = collectValueScopes(lowered);
	const ownerIsColumnar = owner.attributePivot === undefined;

	if (!hasSubquery && !hasUnqualifiedColumn && qualifiers.size === 0) {
		return { kind: 'constant', value: lowered, isNull };
	}
	if (!hasSubquery && !hasUnqualifiedColumn) {
		const anchorId = shape.anchor.relationId;
		if ([...qualifiers].every(q => q === anchorId)) return { kind: 'anchor', value: lowered, isNull };
		if (ownerIsColumnar && [...qualifiers].every(q => q === owner.relationId)) return { kind: 'self', value: lowered, isNull };
	}
	// Arbitrary value. With a capture carrier present it is admitted as `captured` — for an optional
	// **columnar** member (read back by the member key in both branches) and for an **EAV** member
	// alike (read back by the entity column / anchor key into the per-attribute triple pair; an EAV
	// value column substitutes to a correlated subquery, so any EAV self-reference reaches here). The
	// cell just classifies `captured`; the value is registered + read back at emit. Only the
	// carrier-absent legacy `propagateDecomposition` path stays rejected.
	if (canCapture) {
		return { kind: 'captured', value: lowered, isNull };
	}
	raiseMutationDiagnostic({
		reason: 'unsupported-decomposition-update',
		column: asg.column,
		table: view.name,
		message: `cannot update logical table '${view.name}': writing ${ownerIsColumnar ? 'optional-member' : 'EAV-member'} column '${asg.column}' with this value needs the per-row capture carrier to thread it across the matched-update and materialize branches, which the legacy non-build path does not supply`,
	});
}

/**
 * Walk a lowered (base-term) assigned value, collecting the distinct member-relationId
 * qualifiers its column refs carry, whether any column ref is **unqualified**, and whether
 * it embeds a subquery. {@link lowerMaterializedValue} classifies the value by whether every
 * qualifier is the anchor's (`anchor`) or the owning member's (`self`); an unqualified ref or
 * a subquery forces `arbitrary` (the user-term analogue of the predicate gate's
 * {@link collectViewColumnRefs}, but keyed on the base qualifier rather than the logical name).
 */
function collectValueScopes(expr: AST.Expression): { qualifiers: Set<string>; hasUnqualifiedColumn: boolean; hasSubquery: boolean } {
	const qualifiers = new Set<string>();
	let hasUnqualifiedColumn = false;
	let hasSubquery = false;
	const walk = (node: unknown): void => {
		if (Array.isArray(node)) { node.forEach(walk); return; }
		if (!node || typeof node !== 'object' || !('type' in (node as object))) return;
		const n = node as Record<string, unknown> & { type: string };
		if (n.type === 'column') {
			if (typeof n.table === 'string') qualifiers.add(n.table);
			else hasUnqualifiedColumn = true;
			return;
		}
		if (n.type === 'subquery' || n.type === 'select' || n.type === 'exists') { hasSubquery = true; return; }
		for (const v of Object.values(n)) walk(v);
	};
	walk(expr);
	return { qualifiers, hasUnqualifiedColumn, hasSubquery };
}

/** `update <member> set <cols> where <memberKey> in (select <anchorKey> from <anchor> where <pred>)`. */
function memberUpdateOp(
	ctx: PlanningContext,
	view: MutableViewLike,
	shape: DecompShape,
	member: DecompositionMember,
	assignments: ReadonlyArray<{ column: string; value: AST.Expression }>,
	pred: AST.Expression | undefined,
	stmt: AST.UpdateStmt,
): BaseOp {
	const memberKey = singleKeyColumn(view, shape, member);
	const where: AST.InExpr = {
		type: 'in',
		expr: { type: 'column', name: memberKey },
		subquery: anchorKeySubquery(shape, pred),
	};
	const statement: AST.UpdateStmt = {
		type: 'update',
		table: memberIdentifier(member),
		assignments: assignments.map(a => ({ column: a.column, value: a.value })),
		where,
		contextValues: stmt.contextValues,
		schemaPath: stmt.schemaPath,
		loc: stmt.loc,
	};
	return { table: resolveMemberTable(ctx, member), op: 'update', statement };
}

/**
 * Rewrite an assigned value from logical terms into the owning member's base
 * terms, then strip the member's own alias qualifier (the per-member UPDATE
 * targets that table directly). A reference to a *different* member is a
 * cross-source assignment a single-table SET cannot express — rejected.
 */
function rewriteAssignedValue(view: MutableViewLike, shape: DecompShape, owner: DecompositionMember, value: AST.Expression): AST.Expression {
	const base = substituteViewColumns(value, shape, view);
	return transformExpr(base, (col) => {
		if (!col.table) return undefined;
		if (col.table === owner.relationId) return { type: 'column', name: col.name };
		raiseMutationDiagnostic({
			reason: 'cross-source-assignment',
			column: col.name,
			table: view.name,
			message: `cannot update logical table '${view.name}': an update value references column '${col.name}' on decomposition member '${col.table}', a different member than the column it assigns; cross-member assignment is not supported`,
		});
	});
}

// --- UPDATE materialization (optional columnar / EAV) ---------------------

/**
 * Emit the per-row base ops for an optional (outer-joined) columnar member's update
 * group, routed by the group's {@link ValueKind} composition (see the table in the file
 * header):
 *
 * - **has a `captured` cell, OR mixes `anchor` and `self`** → the whole group rides the
 *   single-identity per-row capture ({@link emitCapturedMemberUpdate}): EVERY cell's value
 *   (including any anchor/self/constant sibling) is materialized once over the planned body
 *   under a `srcN`, the matched UPDATE reads each back by the member key, and a filtered
 *   materialize INSERT reads each back by the anchor key (gated on a runtime non-null). This
 *   subsumes the retired same-statement anchor+self reject — a mixed value, like any arbitrary
 *   one, is now a captured value. Requires the capture carrier (the build path); absent it the
 *   defensive legacy reject fires.
 * - **has an `anchor` cell** (no `self`/`captured`) → a single **upsert** unifies the matched
 *   UPDATE and the absent materialize INSERT: the value is computed once over the anchor scan and
 *   both branches read it (insert directly, matched via `excluded.<col>`). Constant cells
 *   fold in as literal projections / `do update set col = excluded.col`.
 * - **has a `self` cell** (no `anchor`) → present rows take the matched UPDATE (their real
 *   prior member value, owner qualifier stripped); absent rows take a materialize INSERT
 *   ({@link buildSelfMaterializeInsertSelect}) that evaluates the self-expression with the
 *   owner's own columns substituted to NULL — an absent row's prior value is null. A runtime
 *   non-empty filter gates it: a **null-propagating** self-expression (`c + 1` → null) is
 *   constant-false and materializes no phantom row, while one that maps null → non-null
 *   (`coalesce(c, 0) + 1`) is constant-true and materializes the new value. The two ops stay
 *   distinct (they **cannot** collapse into an upsert: the matched value is computed over the
 *   member scan, the materialize value over the null-substituted anchor scan — they disagree
 *   row-for-row by construction), and `on conflict (<memberKey>) do nothing` cedes matched
 *   rows to the UPDATE. Constant cells ride along in both branches (the matched UPDATE applies
 *   them; the materialize INSERT projects them, and a non-null constant makes the filter true).
 * - **all `constant`** → the legacy fast lane: all-value-columns-null → base DELETE; else the
 *   matched UPDATE plus, when ≥1 value is non-null, the absent materialize INSERT.
 */
function emitOptionalMemberUpdate(
	ctx: PlanningContext,
	view: MutableViewLike,
	shape: DecompShape,
	member: DecompositionMember,
	cells: readonly OptionalCell[],
	pred: AST.Expression | undefined,
	stmt: AST.UpdateStmt,
	ops: BaseOp[],
	registerCapturedExpr: ((key: string, expr: AST.Expression) => string) | undefined,
): void {
	const hasCaptured = cells.some(c => c.kind === 'captured');
	const hasAnchor = cells.some(c => c.kind === 'anchor');
	const hasSelf = cells.some(c => c.kind === 'self');

	// A group with ≥1 arbitrary (`captured`) cell — or a mixed anchor+self group, which no
	// single-branch fast lane expresses — rides the single-identity per-row capture: every cell's
	// value is materialized once over the planned body and read back by the stitch key in both
	// branches. A `captured` cell can only exist when the carrier is present (the classifier gated
	// it), so the guard only ever fires for the legacy carrier-absent anchor+self case.
	if (hasCaptured || (hasAnchor && hasSelf)) {
		if (!registerCapturedExpr) {
			raiseMutationDiagnostic({
				reason: 'unsupported-decomposition-update',
				table: view.name,
				message: `cannot update logical table '${view.name}': the update of optional member '${member.relationId}' mixes an anchor-resolvable value and a member self-reference in one statement; threading both across the matched-update and materialize branches needs the per-row capture carrier, which the legacy non-build path does not supply`,
			});
		}
		emitCapturedMemberUpdate(ctx, view, shape, member, cells, pred, stmt, ops, registerCapturedExpr);
		return;
	}

	if (hasAnchor) {
		// Anchor-resolvable group → one upsert replaces both the matched UPDATE and the
		// materialize INSERT (the value agrees row-for-row across both branches by construction).
		ops.push(buildOptionalMemberInsertSelect(ctx, view, shape, member, cells, pred, stmt, 'update'));
		return;
	}

	if (hasSelf) {
		// Self-reference group → the matched UPDATE for present rows over the owner-qualifier-stripped
		// values (their real prior member value), plus — only when the materialize is statically
		// **live** — a materialize INSERT for absent rows that evaluates the self-expression with the
		// owner's own columns substituted to NULL (an absent row's prior value is null), gated by a
		// runtime non-empty filter: a null-propagating self-expression (`c + 1` → null) materializes
		// nothing, while a null→non-null one (`coalesce(c, 0) + 1`) does.
		//
		// When that null-substituted non-empty filter folds **constant-false** at plan time (every
		// self cell null-propagates and no non-null constant sibling keeps it alive), no absent row
		// can ever materialize — so we emit ONLY the matched UPDATE (present-rows-only) and skip the
		// INSERT. Because both soundness gates live inside {@link buildSelfMaterializeInsertSelect},
		// skipping the call skips them with it: sound, since a gate is only a plan-time proxy for "a
		// materialized row would violate", and no row materializes. A non-foldable / volatile /
		// parameterized value cannot be proven dead, so it stays live (emit + gate) — conservative,
		// matching the always-emit behavior. The UPDATE must precede the INSERT so the matched rows
		// are settled before the `do nothing` materialize cedes them (see the doc above for why these
		// cannot collapse into a single upsert).
		ops.push(memberUpdateOp(ctx, view, shape, member,
			cells.map(c => ({ column: c.basisColumn, value: stripMemberQualifier(c.value, member) })), pred, stmt));
		if (!foldsConstantFalse(ctx, selfMaterializeNonEmptyFilter(cells, member))) {
			ops.push(buildSelfMaterializeInsertSelect(ctx, view, shape, member, cells, pred, stmt));
		}
		return;
	}

	// Pure-constant group: the legacy fast lane.
	const valueBasisCols = optionalValueColumns(view, shape, member);
	const assignedBasis = new Set(cells.map(c => c.basisColumn.toLowerCase()));
	const allValueColsAssigned = valueBasisCols.every(bc => assignedBasis.has(bc.toLowerCase()));
	const allAssignedNull = cells.every(c => c.isNull);

	if (allAssignedNull && allValueColsAssigned) {
		// The component row is emptied across every value column → delete it. Reuse the
		// member-delete builder via a metadata-only synthetic DeleteStmt (it rebuilds the
		// `<memberKey> in (<anchor subquery>)` predicate, and a no-WHERE update truncates
		// the member — correct, since every logical row's value columns become null).
		const asDelete: AST.DeleteStmt = {
			type: 'delete',
			table: memberIdentifier(member),
			contextValues: stmt.contextValues,
			schemaPath: stmt.schemaPath,
			loc: stmt.loc,
		};
		ops.push(memberDeleteOp(ctx, view, shape, member, pred, asDelete));
		return;
	}

	// Matched rows: the legacy member UPDATE over the assigned (constant) values.
	ops.push(memberUpdateOp(ctx, view, shape, member,
		cells.map(c => ({ column: c.basisColumn, value: cloneExpr(c.value) })), pred, stmt));

	// Absent rows: materialize only when at least one assigned value is non-null (an
	// all-null partial assignment leaves the absent row absent — nothing to create).
	if (cells.some(c => !c.isNull)) {
		ops.push(buildOptionalMemberInsertSelect(ctx, view, shape, member, cells, pred, stmt, 'nothing'));
	}
}

/**
 * Emit the captured two-op path for an optional columnar member group that contains an
 * arbitrary (`captured`) cell — or that mixes an anchor and a self cell (which no single-branch
 * fast lane expresses). EVERY cell's already-lowered base-term value is projected into the
 * up-front `__vmupd_keys` capture under a stable `srcN` alias (a `captured` cell's arbitrary
 * value, but also any anchor/self/constant sibling — uniform, harmless: the capture over the
 * planned body null-extends an absent optional member, so a self/cross-member value over an
 * absent row already captures null). Then:
 *
 * - the **matched UPDATE** (unfiltered over the present rows) sets each value from the capture,
 *   read back by the **member key** (`(select srcN from __vmupd_keys k where k.k0_0 = <memberKey>)`),
 *   so a present row gets its real pre-mutation value; a captured-null on a matched row writes the
 *   column null (a benign physical divergence — it reads identically to absent, never a widen).
 * - the **materialize INSERT** ({@link buildCapturedMaterializeInsert}) over the absent rows reads
 *   each value back by the **anchor key**, gated on ≥1 captured read-back being non-null at runtime
 *   (so a self/cross-member value that captured null springs no phantom row) with
 *   `on conflict (<memberKey>) do nothing` to cede matched rows to the UPDATE.
 *
 * The two ops cannot collapse into an upsert: the filter must suppress the absent branch without
 * suppressing the matched write. The UPDATE precedes the INSERT so the matched rows are settled
 * before the `do nothing` materialize cedes them. The capture is materialized pre-mutation
 * (regardless of base-op order), so a both-sides write (`set c = b + 1, b = b + 100`) reads `c`
 * from the pre-mutation `b`. Reuses {@link assertNoUnassignedValueColumnWiden} (raised here, before
 * either op, so a widen reject stays atomic) + {@link assertNoMissingNotNull} (in the builder).
 */
function emitCapturedMemberUpdate(
	ctx: PlanningContext,
	view: MutableViewLike,
	shape: DecompShape,
	member: DecompositionMember,
	cells: readonly OptionalCell[],
	pred: AST.Expression | undefined,
	stmt: AST.UpdateStmt,
	ops: BaseOp[],
	registerCapturedExpr: (key: string, expr: AST.Expression) => string,
): void {
	const ref = resolveMemberTable(ctx, member);
	const schema = ref.tableSchema;
	const memberKey = singleKeyColumn(view, shape, member);

	// View-soundness gate (atomic, before either op): an unassigned value column that would not
	// land null cannot be materialized. Shared with the constant / self materialize builders.
	assertNoUnassignedValueColumnWiden(view, shape, member, schema, cells);

	// Register every cell's lowered value into the capture (one `srcN` per cell), keyed by its
	// basis column so the two read-back sites (member key, anchor key) bind the same alias.
	const srcByCell = cells.map(c =>
		registerCapturedExpr(`cap:${member.relationId.toLowerCase()}:${c.basisColumn.toLowerCase()}`, cloneExpr(c.value)));

	// Matched UPDATE (unfiltered over the present rows): each value read back by the member key.
	ops.push(memberUpdateOp(ctx, view, shape, member,
		cells.map((c, i) => ({ column: c.basisColumn, value: capturedValueSubquery(srcByCell[i], 0, [keyColumnInfo(schema, memberKey)]) })),
		pred, stmt));

	// Materialize INSERT (filtered over the absent rows): each value read back by the anchor key.
	ops.push(buildCapturedMaterializeInsert(ctx, view, shape, member, cells, srcByCell, pred, stmt));
}

/**
 * Build the absent-row materialize INSERT for a captured optional-member group, modeled on
 * {@link buildSelfMaterializeInsertSelect} (`'nothing'` flavour) but sourcing each value from the
 * up-front `__vmupd_keys` capture rather than a null-substituted self-expression. The select is
 * over the anchor; each projected value is `capturedValueSubquery(srcN, 0, [anchorKey])` — the
 * captured read-back correlated by the anchor key (which holds the shared stitch-key value). The
 * WHERE conjoins the user predicate with an OR-chain `<each captured read-back> is not null`, so a
 * row whose every captured value is null (a self/cross-member value over an absent member, or a
 * subquery returning null) materializes nothing — the **runtime** analogue of the self path's
 * plan-time `foldsConstantFalse`, since a captured value is data-dependent and cannot be folded.
 * `on conflict (<memberKey>) do nothing` cedes the matched rows to the UPDATE (emitted first).
 * Always emitted (the filter decides per row). Runs {@link assertNoMissingNotNull} on the target
 * columns (the widen gate already fired in the caller).
 */
function buildCapturedMaterializeInsert(
	ctx: PlanningContext,
	view: MutableViewLike,
	shape: DecompShape,
	member: DecompositionMember,
	cells: readonly OptionalCell[],
	srcByCell: readonly string[],
	pred: AST.Expression | undefined,
	stmt: AST.UpdateStmt,
): BaseOp {
	const ref = resolveMemberTable(ctx, member);
	const schema = ref.tableSchema;
	const anchorKey = singleKeyColumn(view, shape, shape.anchor);
	const anchorKeyInfo = keyColumnInfo(resolveMemberTable(ctx, shape.anchor).tableSchema, anchorKey);
	const memberKey = singleKeyColumn(view, shape, member);

	const targetColumns: string[] = [memberKey];
	const projections: AST.ResultColumn[] = [
		{ type: 'column', expr: { type: 'column', name: anchorKey, table: shape.anchor.relationId } },
	];
	cells.forEach((c, i) => {
		targetColumns.push(c.basisColumn);
		projections.push({ type: 'column', expr: capturedValueSubquery(srcByCell[i], 0, [anchorKeyInfo]) });
	});
	assertNoMissingNotNull(view, schema, targetColumns.map((baseColumn): DecompInsertColumn => ({ baseColumn })));

	// Non-empty image filter: OR over each captured value (read back by the anchor key) being
	// non-null. A fresh `capturedValueSubquery` per disjunct (distinct AST nodes from the
	// projections') keeps the filter self-contained.
	const nonEmpty = cells
		.map((_, i): AST.Expression => ({ type: 'unary', operator: 'IS NOT NULL', expr: capturedValueSubquery(srcByCell[i], 0, [anchorKeyInfo]) }))
		.reduce((acc, e): AST.Expression => acc ? { type: 'binary', operator: 'OR', left: acc, right: e } : e);
	const where = combineAnd(pred ? cloneExpr(pred) : undefined, nonEmpty);

	const select: AST.SelectStmt = {
		type: 'select',
		columns: projections,
		from: [{ ...memberIdentifierSource(shape.anchor), alias: shape.anchor.relationId }],
		where,
	};
	const statement: AST.InsertStmt = {
		type: 'insert',
		table: memberIdentifier(member),
		columns: targetColumns,
		source: select,
		upsertClauses: [{ type: 'upsert', conflictTarget: [memberKey], action: 'nothing' }],
		contextValues: stmt.contextValues,
		schemaPath: stmt.schemaPath,
		loc: stmt.loc,
	};
	return { table: ref, op: 'insert', statement };
}

/**
 * Build the single-identity (anchor-key) per-row value capture for a decomposition columnar
 * UPDATE — the decomposition dual of `buildMultiSourceKeyCapture` (multi-source.ts), reusing the
 * shared `__vmupd_keys` substrate ({@link MultiSourceKeyCapture} / `makeMultiSourceKeyRef` /
 * `keyColumnName`). Built as plan nodes directly over the **already-planned get body**
 * (`shape.bodySource` + `shape.bodyScope`) — `Project_{k0_0, srcN…}(Filter_{anchorPred}(body))` —
 * so the body is planned once and the captured value already encodes per-row presence (the body
 * null-extends an absent optional member).
 *
 *  - `k0_0` (the only identity column) := the anchor key, read back by every base op (by the
 *    member key in the matched UPDATE, the anchor key in the materialize INSERT — both correlate
 *    `k.k0_0`, which holds the shared stitch-key value, since each member is keyed 1:1 to the
 *    anchor).
 *  - one `srcN` per {@link CapturedDecompValue}, in registration (= read-back) order, so the
 *    flattened `keyColumns` align positionally with the projections every reader scans back.
 *
 * The identity predicate is the same anchor-resolvable lowering the base ops route on
 * ({@link anchorPredicate}, re-validated here — idempotent); a non-anchor WHERE has already
 * thrown in `decomposeUpdate` before any capture is requested (atomic).
 */
export function buildDecompositionKeyCapture(
	ctx: PlanningContext,
	view: MutableViewLike,
	shape: DecompShape,
	where: AST.Expression | undefined,
	capturedValues: readonly CapturedDecompValue[],
): MultiSourceKeyCapture {
	const scope = shape.bodyScope;
	if (!scope) {
		raiseMutationDiagnostic({
			reason: 'no-base-lineage',
			table: view.name,
			message: `cannot write through logical table '${view.name}': the planned decomposition body did not expose a resolvable column scope for the value capture`,
		});
	}
	const anchorKey = singleKeyColumn(view, shape, shape.anchor);

	// The identifying predicate (anchor-resolvable user WHERE → base terms), built as a
	// ScalarPlanNode over the body scope, then a Filter over the planned body source.
	const predAst = anchorPredicate(view, shape, where);
	const predicate = predAst ? buildExpression({ ...ctx, scope }, predAst) : undefined;
	const filtered: RelationalPlanNode = predicate
		? new FilterNode(scope, shape.bodySource, predicate)
		: shape.bodySource;

	// k0_0 := the anchor key, then one srcN per captured value (lowered over the body scope).
	const keyColumns: { name: string; type: ScalarType }[] = [];
	const projections: Projection[] = [];
	const anchorKeyNode = buildExpression({ ...ctx, scope }, { type: 'column', name: anchorKey, table: shape.anchor.relationId });
	keyColumns.push({ name: keyColumnName(0, 0), type: anchorKeyNode.getType() });
	projections.push({ node: anchorKeyNode, alias: keyColumnName(0, 0) });
	for (const cv of capturedValues) {
		const node = buildExpression({ ...ctx, scope }, cv.expr);
		keyColumns.push({ name: cv.alias, type: node.getType() });
		projections.push({ node, alias: cv.alias });
	}

	const source = new ProjectNode(scope, filtered, projections, undefined, undefined, false);
	return { source, descriptor: {}, keyColumns };
}

/**
 * Build the anchor-keyed insert-select that materializes / unifies an optional columnar
 * member's update, in one of two `action` flavours sharing the identical select + soundness
 * gates:
 *
 * - **`'nothing'`** (constant group, absent branch) — `insert into <member> (<memberKey>,
 *   <cols…>) select <anchorKey>, <values…> from <anchor> where <pred> on conflict (<memberKey>)
 *   do nothing`. The matched anchors (whose member row exists) conflict and are ceded to the
 *   separate matched UPDATE; only the absent rows materialize. The insert source never scans
 *   its own target (which the planner cannot assign an access path to).
 * - **`'update'`** (anchor-resolvable group) — the same select, but `on conflict (<memberKey>)
 *   do update set <col> = excluded.<col>, …`. This **replaces both** the matched UPDATE and the
 *   materialize INSERT: the value is computed once over the anchor scan, absent rows insert it,
 *   and matched rows read the identical proposed-insert value via `excluded.<col>` — so the two
 *   branches agree row-for-row (the round-trip oracle holds by construction).
 *
 * The conflict target is the member's stitch key, which `validatePrimaryAdvertisement`
 * (lens-compiler.ts) guarantees at deploy time to be a declared PRIMARY KEY / non-partial
 * UNIQUE on the member basis. That deploy guard is what makes the partition sound: the runtime
 * `on conflict` fires only on a declared PK/UNIQUE violation, so a non-unique stitch key would
 * double-insert the matched rows instead of ceding/updating them — and could not deploy.
 *
 * Two soundness gates (data-independent, plan-time), enforced on **both** flavours:
 * - a member **value** column the statement does not assign must materialize as null
 *   (nullable + no declared default), else its base default would silently widen the
 *   absent row's logical image — rejected `unsupported-decomposition-update`;
 * - a NOT NULL base column with no default that no value covers cannot be created —
 *   rejected via {@link assertNoMissingNotNull} (the decomposition create-conflict).
 */
function buildOptionalMemberInsertSelect(
	ctx: PlanningContext,
	view: MutableViewLike,
	shape: DecompShape,
	member: DecompositionMember,
	cells: readonly OptionalCell[],
	pred: AST.Expression | undefined,
	stmt: AST.UpdateStmt,
	action: 'nothing' | 'update',
): BaseOp {
	const ref = resolveMemberTable(ctx, member);
	const schema = ref.tableSchema;
	const anchorKey = singleKeyColumn(view, shape, shape.anchor);
	const memberKey = singleKeyColumn(view, shape, member);

	assertNoUnassignedValueColumnWiden(view, shape, member, schema, cells);

	const targetColumns: string[] = [memberKey];
	const projections: AST.ResultColumn[] = [
		{ type: 'column', expr: { type: 'column', name: anchorKey, table: shape.anchor.relationId } },
	];
	for (const c of cells) {
		targetColumns.push(c.basisColumn);
		projections.push({ type: 'column', expr: cloneExpr(c.value) });
	}
	assertNoMissingNotNull(view, schema, targetColumns.map((baseColumn): DecompInsertColumn => ({ baseColumn })));

	const select: AST.SelectStmt = {
		type: 'select',
		columns: projections,
		from: [{ ...memberIdentifierSource(shape.anchor), alias: shape.anchor.relationId }],
		where: pred ? cloneExpr(pred) : undefined,
	};
	const upsert: AST.UpsertClause = action === 'nothing'
		? { type: 'upsert', conflictTarget: [memberKey], action: 'nothing' }
		: { type: 'upsert', conflictTarget: [memberKey], action: 'update', assignments: cells.map(c => ({ column: c.basisColumn, value: excludedColumn(c.basisColumn) })) };
	const statement: AST.InsertStmt = {
		type: 'insert',
		table: memberIdentifier(member),
		columns: targetColumns,
		source: select,
		upsertClauses: [upsert],
		contextValues: stmt.contextValues,
		schemaPath: stmt.schemaPath,
		loc: stmt.loc,
	};
	return { table: ref, op: 'insert', statement };
}

/**
 * Build the absent-row materialize INSERT for a **member self-reference** update group
 * (`set c = c + 1`, `set c = coalesce(c, 0) + 1`). Modeled on {@link buildOptionalMemberInsertSelect}
 * (`'nothing'` flavour) and sharing its two soundness gates, but the projected value is the
 * self-expression with the owner's own column refs **substituted to NULL** — an absent row's
 * prior member value is null ({@link substituteOwnerColumnsWithNull}). Every leaf of a `self`
 * cell is the owner's own column (the classifier proved it), so after substitution the value is a
 * constant expression evaluable over the anchor scan; a constant sibling cell passes through.
 *
 * The select is additionally **filtered to a non-empty materialized image**:
 * `… where <pred> and (<v1> is not null or <v2> is not null or …)` over the null-substituted
 * values. This is what makes the always-emit sound: a **null-propagating** self-expression
 * (`c + 1` → `null + 1` → null) yields a constant-false filter and materializes **no** phantom
 * row, while one that maps null → non-null (`coalesce(c, 0) + 1` → `1`) is constant-true and
 * materializes. `on conflict (<memberKey>) do nothing` cedes present rows to the matched UPDATE
 * (which runs first), so only genuinely-absent rows are created — never an upsert (the matched and
 * materialize values are computed over different scans and disagree row-for-row by construction).
 *
 * The caller emits this builder (and therefore runs the two soundness gates) **only when the
 * materialize is statically live** — when the null-substituted non-empty filter cannot be proven
 * constant-false at plan time ({@link foldsConstantFalse}). A provably-dead materialize is skipped
 * entirely, taking both gates with it (sound: no row materializes, so neither gate can be violated).
 */
function buildSelfMaterializeInsertSelect(
	ctx: PlanningContext,
	view: MutableViewLike,
	shape: DecompShape,
	member: DecompositionMember,
	cells: readonly OptionalCell[],
	pred: AST.Expression | undefined,
	stmt: AST.UpdateStmt,
): BaseOp {
	const ref = resolveMemberTable(ctx, member);
	const schema = ref.tableSchema;
	const anchorKey = singleKeyColumn(view, shape, shape.anchor);
	const memberKey = singleKeyColumn(view, shape, member);

	assertNoUnassignedValueColumnWiden(view, shape, member, schema, cells);

	// An absent row's prior member value is null, so the materialized image is the self-expression
	// with the owner's own columns nulled out (a self cell collapses to a constant; a constant cell
	// is unchanged).
	const nulled = cells.map(c => ({ basisColumn: c.basisColumn, value: substituteOwnerColumnsWithNull(c.value, member) }));

	const targetColumns: string[] = [memberKey];
	const projections: AST.ResultColumn[] = [
		{ type: 'column', expr: { type: 'column', name: anchorKey, table: shape.anchor.relationId } },
	];
	for (const n of nulled) {
		targetColumns.push(n.basisColumn);
		projections.push({ type: 'column', expr: cloneExpr(n.value) });
	}
	assertNoMissingNotNull(view, schema, targetColumns.map((baseColumn): DecompInsertColumn => ({ baseColumn })));

	// Non-empty image filter (the shared {@link selfMaterializeNonEmptyFilter} OR-chain
	// `<nulledValue> is not null`) so a null-propagating self-expression creates no phantom row
	// (constant-false), conjoined with the user predicate. The identical filter, folded WITHOUT the
	// user predicate, is the caller's static dead-materialize check ({@link foldsConstantFalse}); the
	// shared helper keeps the two from drifting.
	const where = combineAnd(pred ? cloneExpr(pred) : undefined, selfMaterializeNonEmptyFilter(cells, member));

	const select: AST.SelectStmt = {
		type: 'select',
		columns: projections,
		from: [{ ...memberIdentifierSource(shape.anchor), alias: shape.anchor.relationId }],
		where,
	};
	const statement: AST.InsertStmt = {
		type: 'insert',
		table: memberIdentifier(member),
		columns: targetColumns,
		source: select,
		upsertClauses: [{ type: 'upsert', conflictTarget: [memberKey], action: 'nothing' }],
		contextValues: stmt.contextValues,
		schemaPath: stmt.schemaPath,
		loc: stmt.loc,
	};
	return { table: ref, op: 'insert', statement };
}

/**
 * The self-materialize non-empty image filter: the OR-chain `<nulledValue> is not null` over each
 * cell's value with the owner's own columns substituted to NULL ({@link substituteOwnerColumnsWithNull}).
 * Shared by {@link buildSelfMaterializeInsertSelect} (where it is conjoined with the user predicate as
 * the emitted INSERT's WHERE) and the `hasSelf` branch's static dead-materialize check (folded on its
 * own, {@link foldsConstantFalse}) so the two can never drift. `is not null` is total, so for a
 * null-propagating self group with no non-null constant sibling every disjunct is `null is not null`
 * → the whole chain folds constant-false.
 */
function selfMaterializeNonEmptyFilter(cells: readonly OptionalCell[], member: DecompositionMember): AST.Expression {
	return cells
		.map((c): AST.Expression => ({ type: 'unary', operator: 'IS NOT NULL', expr: substituteOwnerColumnsWithNull(c.value, member) }))
		.reduce((acc, e): AST.Expression => acc ? { type: 'binary', operator: 'OR', left: acc, right: e } : e);
}

/**
 * True when `expr` provably folds **constant-false** at plan time — used by the `hasSelf` branch to
 * decide whether the self-materialize is dead (no absent row can materialize). We reuse the engine's
 * own constant folding rather than hand-rolling an evaluator: build the expression to a scalar plan
 * node ({@link buildExpression}) and run it through {@link createRuntimeExpressionEvaluator}. The
 * input is the {@link selfMaterializeNonEmptyFilter} OR-chain (column-ref-free after null
 * substitution — every self leaf is the owner's own column, a constant sibling carries none), so the
 * fold is a deterministic plan-time constant. `is not null` never yields NULL, so a dead materialize
 * folds to boolean `false` (defensively also `0` / `0n`). Anything else — a non-null fold, a Promise
 * (async / non-constant), or a throw (unbound parameter) — is NOT provably dead, so we stay
 * conservative and return `false` (emit the materialize + its gates).
 *
 * A **non-deterministic** leaf (a function the registry flags non-`DETERMINISTIC` — `random()` or a
 * volatile UDF — or a subquery, though a self cell carries none) short-circuits to `false` *before*
 * the fold: a single plan-time evaluation is an unsound proxy for the per-row runtime filter when the
 * value can vary, and a nullable volatile inside `coalesce(c, …)` could fold NULL (dead) at plan time
 * yet yield non-null per row at runtime — dropping an absent row the always-emit path would have
 * materialized. Keeping volatiles on the emit path matches the ticket's `set c = c + random()`
 * edge-case and the `hasSelf` branch's own contract (only a *foldable* dead materialize is skipped).
 */
function foldsConstantFalse(ctx: PlanningContext, expr: AST.Expression): boolean {
	const isDeterministic = (name: string, argc: number): boolean => {
		const fn = ctx.schemaManager.findFunction(name, argc) ?? ctx.schemaManager.findFunction(name, -1);
		return fn ? (fn.flags & FunctionFlags.DETERMINISTIC) !== 0 : true;
	};
	if (containsNonDeterministicCall(expr, isDeterministic)) return false;
	try {
		const node = buildExpression(ctx, expr);
		const value = createRuntimeExpressionEvaluator(ctx.db)(node);
		return value === false || value === 0 || value === 0n;
	} catch {
		return false;
	}
}

/**
 * View-soundness gate shared by every optional-member materialize insert-select
 * ({@link buildOptionalMemberInsertSelect} and {@link buildSelfMaterializeInsertSelect}): an
 * unassigned member **value** column that would not land null (it is NOT NULL, or carries a
 * declared default) cannot be materialized without changing the absent row's logical image.
 * Reject conservatively rather than silently widen the view. (The companion gate —
 * {@link assertNoMissingNotNull} — is called at each builder's target-column site.)
 */
function assertNoUnassignedValueColumnWiden(
	view: MutableViewLike,
	shape: DecompShape,
	member: DecompositionMember,
	schema: TableSchema,
	cells: readonly OptionalCell[],
): void {
	const assignedBasis = new Set(cells.map(c => c.basisColumn.toLowerCase()));
	for (const bc of optionalValueColumns(view, shape, member)) {
		if (assignedBasis.has(bc.toLowerCase())) continue;
		const col = columnByName(view, schema, bc);
		if (col.notNull || col.defaultValue !== null) {
			raiseMutationDiagnostic({
				reason: 'unsupported-decomposition-update',
				column: bc,
				table: view.name,
				message: `cannot update logical table '${view.name}': materializing an absent row of optional member '${member.relationId}' would leave value column '${bc}' to a base default (it is NOT NULL or declares a default), silently widening the row; assign every value column of the member in this statement, or restrict the update to present rows`,
			});
		}
	}
}

/**
 * Emit the per-attribute base ops for an EAV pivot member's update group. Each attribute is
 * an independent triple, routed by the cell's null-ness and {@link ValueKind}:
 *
 * - **null** value → delete its triple for the matched entities.
 * - **`anchor`** value (`set p = id * 2`) → one **upsert** (`do update`) unifies the matched
 *   UPDATE and the absent materialize INSERT, keyed on `(entity, attribute)` — the value is
 *   computed once over the anchor scan and matched entities read it via `excluded.<valCol>`.
 * - **`constant`** value → matched UPDATE of the value column + `on conflict (entity, attr)
 *   do nothing` materialize INSERT for entities lacking the triple.
 * - **`captured`** value (an EAV self-reference `set p = p + 1`, a cross-member read, or an
 *   embedded subquery — all of which an EAV value column lowers to a subquery for) → the
 *   single-identity capture analogue ({@link emitEavCapturedAttr}): the value is materialized once
 *   over the planned body under a `srcN`, the matched UPDATE reads it back by the **entity** column,
 *   and a filtered materialize INSERT reads it back by the **anchor key** (non-null gated). Requires
 *   the capture carrier (the build path).
 *
 * A `self` value cannot occur here: an EAV value column substitutes to a correlated subquery, so a
 * self-reference lowers to a subquery and classifies `captured`, not `self`.
 */
function emitEavMemberUpdate(
	ctx: PlanningContext,
	view: MutableViewLike,
	shape: DecompShape,
	member: DecompositionMember,
	cells: readonly EavCell[],
	pred: AST.Expression | undefined,
	stmt: AST.UpdateStmt,
	ops: BaseOp[],
	registerCapturedExpr: ((key: string, expr: AST.Expression) => string) | undefined,
): void {
	const pivot = member.attributePivot!;
	for (const cell of cells) {
		if (cell.isNull) {
			ops.push(buildEavAttrOp(ctx, view, shape, member, pivot, cell, pred, stmt, 'delete'));
		} else if (cell.kind === 'anchor') {
			ops.push(buildEavInsertSelect(ctx, view, shape, member, pivot, cell, pred, stmt, 'update'));
		} else if (cell.kind === 'captured') {
			emitEavCapturedAttr(ctx, view, shape, member, pivot, cell, pred, stmt, ops, registerCapturedExpr);
		} else {
			ops.push(buildEavAttrOp(ctx, view, shape, member, pivot, cell, pred, stmt, 'update'));
			ops.push(buildEavInsertSelect(ctx, view, shape, member, pivot, cell, pred, stmt, 'nothing'));
		}
	}
}

/**
 * Emit the captured triple pair for one arbitrary EAV attribute cell — the per-attribute analogue
 * of {@link emitCapturedMemberUpdate} (columnar). The cell's already-lowered base-term value (a
 * self-reference / cross-member / subquery value over the planned body) is projected into the
 * up-front `__vmupd_keys` capture under a stable `srcN` alias, then:
 *
 * - the **matched UPDATE** ({@link buildEavAttrOp} `'update'`, value overridden by the read-back)
 *   sets the value column of every existing `<attr>` triple for the matched entities to
 *   `(select srcN from __vmupd_keys k where k.k0_0 = <entity>)` — the captured value correlated by
 *   the entity column (which holds the anchor key, the shared stitch value). Unfiltered: a captured
 *   null on a matched triple writes `val = null`, which reads identically to an absent triple
 *   through the get-body subquery (a benign physical divergence from the explicit `set p = null`
 *   delete — never a widen).
 * - the **materialize INSERT** ({@link buildEavCapturedInsert}) creates one `<attr>` triple per
 *   matched entity that lacks it, the value read back by the **anchor key**, gated on a runtime
 *   non-null (so an entity whose captured value is null — e.g. incrementing an attribute it does
 *   not have — springs no phantom triple) with `on conflict (entity, attr) do nothing` to cede the
 *   entities that already have the triple to the matched UPDATE (emitted first).
 *
 * Requires the capture carrier (the build path); absent it the defensive legacy reject fires (an
 * arbitrary EAV value cannot be threaded without the `__vmupd_keys` substrate).
 */
function emitEavCapturedAttr(
	ctx: PlanningContext,
	view: MutableViewLike,
	shape: DecompShape,
	member: DecompositionMember,
	pivot: NonNullable<DecompositionMember['attributePivot']>,
	cell: EavCell,
	pred: AST.Expression | undefined,
	stmt: AST.UpdateStmt,
	ops: BaseOp[],
	registerCapturedExpr: ((key: string, expr: AST.Expression) => string) | undefined,
): void {
	if (!registerCapturedExpr) {
		raiseMutationDiagnostic({
			reason: 'unsupported-decomposition-update',
			column: cell.attribute,
			table: view.name,
			message: `cannot update logical table '${view.name}': writing EAV attribute '${cell.attribute}' with this value needs the per-row capture carrier to thread it across the matched-update and materialize-insert triple pair, which the legacy non-build path does not supply`,
		});
	}
	// Register the lowered value into the capture (one `srcN` per attribute), keyed by the attribute
	// so both read-back sites (entity column, anchor key) bind the same alias.
	const srcAlias = registerCapturedExpr(`cap:${member.relationId.toLowerCase()}:attr:${cell.attribute.toLowerCase()}`, cloneExpr(cell.value));
	// Matched UPDATE: existing triples read the captured value back by the entity column.
	ops.push(buildEavAttrOp(ctx, view, shape, member, pivot, cell, pred, stmt, 'update',
		capturedValueSubquery(srcAlias, 0, [keyColumnInfo(resolveMemberTable(ctx, member).tableSchema, pivot.entityColumn)])));
	// Materialize INSERT: entities lacking the triple, value read back by the anchor key, non-null filtered.
	ops.push(buildEavCapturedInsert(ctx, view, shape, member, pivot, cell, srcAlias, pred, stmt));
}

/**
 * One matched EAV op for an attribute: `update <pivot> set <valCol> = <value>` (upsert
 * value branch) or `delete from <pivot>` (null branch), each scoped
 * `where <attrCol> = '<attribute>' and <entityCol> in (<anchor subquery>)`. `valueOverride`
 * supplies the matched-UPDATE value for a `captured` cell (the `__vmupd_keys` read-back correlated
 * by the entity column); absent, the cell's own lowered value is used (the `constant` branch).
 */
function buildEavAttrOp(
	ctx: PlanningContext,
	view: MutableViewLike,
	shape: DecompShape,
	member: DecompositionMember,
	pivot: NonNullable<DecompositionMember['attributePivot']>,
	cell: EavCell,
	pred: AST.Expression | undefined,
	stmt: AST.UpdateStmt,
	op: 'update' | 'delete',
	valueOverride?: AST.Expression,
): BaseOp {
	const where = combineAnd(eavAttrEquals(pivot, cell.attribute), {
		type: 'in',
		expr: { type: 'column', name: pivot.entityColumn },
		subquery: anchorKeySubquery(shape, pred),
	})!;
	const table = memberIdentifier(member);
	const resolved = resolveMemberTable(ctx, member);
	if (op === 'delete') {
		const statement: AST.DeleteStmt = {
			type: 'delete', table, where,
			contextValues: stmt.contextValues, schemaPath: stmt.schemaPath, loc: stmt.loc,
		};
		return { table: resolved, op: 'delete', statement };
	}
	const statement: AST.UpdateStmt = {
		type: 'update', table,
		assignments: [{ column: pivot.valueColumn, value: valueOverride ?? cloneExpr(cell.value) }],
		where,
		contextValues: stmt.contextValues, schemaPath: stmt.schemaPath, loc: stmt.loc,
	};
	return { table: resolved, op: 'update', statement };
}

/**
 * Build the anchor-keyed EAV triple insert-select for one attribute, in one of two `action`
 * flavours sharing the identical select: `insert into <pivot> (<entity>, <attr>, <val>) select
 * <anchorKey>, '<attribute>', <value> from <anchor> where <pred>` followed by
 *
 * - **`'nothing'`** (constant cell, absent branch) — `on conflict (<entity>, <attr>) do nothing`:
 *   one new triple per matched entity that lacks this attribute (entities whose triple exists
 *   conflict and are ceded to the separate matched UPDATE).
 * - **`'update'`** (anchor-resolvable cell) — `on conflict (<entity>, <attr>) do update set
 *   <valCol> = excluded.<valCol>`: **replaces both** the matched UPDATE and the materialize
 *   INSERT, the value computed once over the anchor scan and read by matched entities via
 *   `excluded.<valCol>`.
 *
 * The conflict target `(entity, attribute)` — NOT the stitch key (`entity` alone, which is
 * intentionally one-to-many) — is guaranteed a declared PRIMARY KEY / non-partial UNIQUE on
 * the pivot basis by `validatePrimaryAdvertisement` (lens-compiler.ts) at deploy time. That
 * is what keeps both the matched/materialize partition here and the get-side correlated
 * subquery single-valued; a non-unique `(entity, attr)` could not deploy.
 */
function buildEavInsertSelect(
	ctx: PlanningContext,
	view: MutableViewLike,
	shape: DecompShape,
	member: DecompositionMember,
	pivot: NonNullable<DecompositionMember['attributePivot']>,
	cell: EavCell,
	pred: AST.Expression | undefined,
	stmt: AST.UpdateStmt,
	action: 'nothing' | 'update',
): BaseOp {
	const ref = resolveMemberTable(ctx, member);
	const anchorKey = singleKeyColumn(view, shape, shape.anchor);
	const projections: AST.ResultColumn[] = [
		{ type: 'column', expr: { type: 'column', name: anchorKey, table: shape.anchor.relationId } },
		{ type: 'column', expr: { type: 'literal', value: cell.attribute } },
		{ type: 'column', expr: cloneExpr(cell.value) },
	];
	const select: AST.SelectStmt = {
		type: 'select',
		columns: projections,
		from: [{ ...memberIdentifierSource(shape.anchor), alias: shape.anchor.relationId }],
		where: pred ? cloneExpr(pred) : undefined,
	};
	const upsert: AST.UpsertClause = action === 'nothing'
		? { type: 'upsert', conflictTarget: [pivot.entityColumn, pivot.attributeColumn], action: 'nothing' }
		: { type: 'upsert', conflictTarget: [pivot.entityColumn, pivot.attributeColumn], action: 'update', assignments: [{ column: pivot.valueColumn, value: excludedColumn(pivot.valueColumn) }] };
	const statement: AST.InsertStmt = {
		type: 'insert',
		table: memberIdentifier(member),
		columns: [pivot.entityColumn, pivot.attributeColumn, pivot.valueColumn],
		source: select,
		upsertClauses: [upsert],
		contextValues: stmt.contextValues,
		schemaPath: stmt.schemaPath,
		loc: stmt.loc,
	};
	return { table: ref, op: 'insert', statement };
}

/**
 * Build the absent-entity materialize INSERT for a `captured` EAV attribute cell — the triple
 * analogue of {@link buildCapturedMaterializeInsert} (columnar). `insert into <pivot> (<entity>,
 * <attr>, <val>) select <anchorKey>, '<attribute>', (select srcN from __vmupd_keys k where k.k0_0
 * = <anchorKey>) from <anchor> where <pred> and (select srcN …) is not null on conflict (<entity>,
 * <attr>) do nothing`. The value and the non-null filter both read the captured `srcN` back by the
 * anchor key. That non-null filter is the **runtime** analogue of the columnar self path's
 * plan-time fold: a captured EAV value is data-dependent (a self-reference over an entity that
 * lacks the attribute captures `null + …` = null), so a per-row filter — not a plan-time decision
 * — gates whether the triple materializes, leaving no phantom null triple. `on conflict (entity,
 * attr) do nothing` cedes entities that already have the triple to the matched UPDATE (emitted
 * first); the `(entity, attr)` conflict target is the deploy-guaranteed pivot PK / non-partial
 * UNIQUE (as in {@link buildEavInsertSelect}). Always emitted (the filter decides per row).
 */
function buildEavCapturedInsert(
	ctx: PlanningContext,
	view: MutableViewLike,
	shape: DecompShape,
	member: DecompositionMember,
	pivot: NonNullable<DecompositionMember['attributePivot']>,
	cell: EavCell,
	srcAlias: string,
	pred: AST.Expression | undefined,
	stmt: AST.UpdateStmt,
): BaseOp {
	const ref = resolveMemberTable(ctx, member);
	const anchorKey = singleKeyColumn(view, shape, shape.anchor);
	const anchorKeyInfo = keyColumnInfo(resolveMemberTable(ctx, shape.anchor).tableSchema, anchorKey);
	// A fresh read-back subquery per use (projection + filter) — distinct AST nodes.
	const capturedVal = (): AST.Expression => capturedValueSubquery(srcAlias, 0, [anchorKeyInfo]);
	const projections: AST.ResultColumn[] = [
		{ type: 'column', expr: { type: 'column', name: anchorKey, table: shape.anchor.relationId } },
		{ type: 'column', expr: { type: 'literal', value: cell.attribute } },
		{ type: 'column', expr: capturedVal() },
	];
	const nonNull: AST.Expression = { type: 'unary', operator: 'IS NOT NULL', expr: capturedVal() };
	const where = combineAnd(pred ? cloneExpr(pred) : undefined, nonNull);
	const select: AST.SelectStmt = {
		type: 'select',
		columns: projections,
		from: [{ ...memberIdentifierSource(shape.anchor), alias: shape.anchor.relationId }],
		where,
	};
	const statement: AST.InsertStmt = {
		type: 'insert',
		table: memberIdentifier(member),
		columns: [pivot.entityColumn, pivot.attributeColumn, pivot.valueColumn],
		source: select,
		upsertClauses: [{ type: 'upsert', conflictTarget: [pivot.entityColumn, pivot.attributeColumn], action: 'nothing' }],
		contextValues: stmt.contextValues,
		schemaPath: stmt.schemaPath,
		loc: stmt.loc,
	};
	return { table: ref, op: 'insert', statement };
}

/** `<attrCol> = '<attribute>'` — the pivot attribute selector (matched by value). */
function eavAttrEquals(pivot: NonNullable<DecompositionMember['attributePivot']>, attribute: string): AST.BinaryExpr {
	return { type: 'binary', operator: '=', left: { type: 'column', name: pivot.attributeColumn }, right: { type: 'literal', value: attribute } };
}

/**
 * The optional member's **value** basis columns (its non-key logical mappings) — the
 * set the all-null delete gate ranges over. The shared key is threaded separately and
 * is never a value column.
 */
function optionalValueColumns(view: MutableViewLike, shape: DecompShape, member: DecompositionMember): string[] {
	const keyLower = singleKeyColumn(view, shape, member).toLowerCase();
	const out: string[] = [];
	for (const m of member.columns) {
		const expr = m.basisExpr;
		if (expr.type !== 'column') continue; // a computed mapping is read-only, not a value column
		if (expr.name.toLowerCase() === keyLower) continue;
		out.push(expr.name);
	}
	return out;
}

/** True for a syntactic null literal (the delete / absent-no-op trigger). */
function isNullLiteral(expr: AST.Expression): boolean {
	return expr.type === 'literal' && expr.value === null;
}

/**
 * `excluded.<col>` — the proposed-insert value of an upsert's `do update set` assignment
 * (registered in the upsert scope by `building/insert.ts`; `NEW.<col>` is the equivalent
 * alias). An anchor-resolvable upsert assigns each matched row `<col> = excluded.<col>` so
 * it reads the identical anchor-computed value the absent rows insert.
 */
function excludedColumn(col: string): AST.ColumnExpr {
	return { type: 'column', name: col, table: 'excluded' };
}

/**
 * Strip the owning member's relationId qualifier from a lowered self-reference value, so a
 * per-member UPDATE over it (`<member>.c + 1`) targets that table directly (`c + 1`). The
 * classifier proved every column ref is the owner's, so a plain strip suffices (a constant
 * sibling carries no ref — a no-op). Mirrors {@link rewriteAssignedValue}'s strip without
 * its cross-member reject (the classifier already excluded a foreign qualifier).
 */
function stripMemberQualifier(value: AST.Expression, owner: DecompositionMember): AST.Expression {
	return transformExpr(value, (col) => (col.table === owner.relationId ? { type: 'column', name: col.name } : undefined));
}

/**
 * Substitute the owning member's own column refs in a lowered self-reference value with a NULL
 * literal — an absent row has no member row, so its prior value is null. So `c + 1` lowers to
 * `null + 1` (→ null, filtered out as a phantom row) and `coalesce(c, 0) + 1` to `coalesce(null, 0)
 * + 1` (→ 1, materializes). The classifier proved every column ref of a `self` cell is the owner's,
 * so substituting only the owner qualifier suffices; a constant sibling carries no owner ref and is
 * left unchanged. Mirrors {@link stripMemberQualifier} but maps the owner's columns to NULL rather
 * than to a bare member-scoped reference (the materialize evaluates over the anchor, not the member).
 */
function substituteOwnerColumnsWithNull(value: AST.Expression, owner: DecompositionMember): AST.Expression {
	return transformExpr(value, (col) => (col.table === owner.relationId ? { type: 'literal', value: null } : undefined));
}

// --- predicate / subquery construction ------------------------------------

/**
 * The user WHERE rewritten from logical columns into the get body's base terms,
 * after the anchor-resolvable gate ({@link assertAnchorScoped}) — so each member's
 * identifying set can be read from the anchor alone (see the file header). The gate
 * admits an anchor identity column **and** a computed mapping whose basis is the
 * anchor (`bumped = 11` → `a + 1 = 11`): both substitute into a predicate over the
 * anchor's own base columns. A predicate touching a non-anchor member (or an EAV
 * pivot / a subquery) is deferred onto the snapshot-consistent substrate. The
 * substitution into base terms is the AST construction the anchor subquery rides; the
 * **gate decision** is read off the threaded backward lineage, not a base-qualifier
 * scan of the substituted expression.
 */
function anchorPredicate(view: MutableViewLike, shape: DecompShape, where: AST.Expression | undefined): AST.Expression | undefined {
	if (!where) return undefined;
	assertAnchorScoped(view, shape, where);
	return substituteViewColumns(where, shape, view);
}

/**
 * Gate a user WHERE to **anchor-resolvable** references via the threaded backward
 * lineage: every logical column the predicate names must resolve entirely to the
 * anchor member's own base terms — an identity base column on the anchor
 * ({@link classifyColumn} → `member` whose relation is the anchor), *or* a computed
 * mapping whose basis lives on the anchor ({@link classifyColumn} → `computed-mapping`
 * whose member is the anchor, e.g. `bumped = a + 1` → `a + 1 = 11`). Either substitutes
 * into a predicate over the anchor's base columns, which the `anchorKeySubquery`
 * already evaluates, so no new substrate is needed.
 *
 * A column backed by a genuine **non-anchor member**, an **EAV pivot**, or an embedded
 * **subquery** defers onto the snapshot-consistent multi-member substrate — each with
 * its own accurate message ({@link nonAnchorPredicateDiagnostic}), since an EAV /
 * unbacked / subquery predicate is not a "non-anchor member" and must not be
 * misattributed as one. A name that is not a logical column of the table at all is an
 * encapsulation leak, rejected as `unknown-view-column` (consistent with the
 * single-source / multi-source `assertTopLevelViewColumns` guard — a typo'd /
 * projected-away name is a user error, not a deferred multi-member shape). (Replaces
 * the retired `collectColumnQualifiers` base-qualifier scan — the anchor decision now
 * reads `updateLineage`, the same backward walk the multi-source path consumes.)
 */
function assertAnchorScoped(view: MutableViewLike, shape: DecompShape, where: AST.Expression): void {
	const refs = collectViewColumnRefs(where);
	// Encapsulation-leak guard first: a name the logical table does not expose is an
	// unknown view column (it would otherwise be mislabeled a "non-anchor member" below).
	for (const name of refs.names) {
		if (!shape.columns.some(c => c.name === name)) {
			raiseMutationDiagnostic({
				reason: 'unknown-view-column',
				column: name,
				table: view.name,
				message: `cannot write through logical table '${view.name}': '${name}' is not a column of the logical table`,
				suggestion: `logical table '${view.name}' exposes: ${shape.columns.map(c => c.displayName).join(', ')}.`,
			});
		}
	}
	// A subquery defers regardless of which columns it names (it may name none) — its
	// multi-member fan-out needs the snapshot-consistent substrate. Checked first so the
	// message is subquery-specific rather than a misattributed "non-anchor member".
	if (refs.hasSubquery) {
		raiseMutationDiagnostic({
			reason: 'unsupported-decomposition-predicate',
			table: view.name,
			message: `cannot write through logical table '${view.name}': the WHERE embeds a subquery; a predicate-honest multi-member fan-out needs snapshot-consistent base-op execution (deferred — filter only on anchor base columns)`,
		});
	}
	const anchorId = shape.anchor.relationId;
	for (const name of refs.names) {
		const route = classifyColumn(view, shape, name);
		// Anchor-resolvable — an identity base column on the anchor, OR a computed mapping
		// whose basis is the anchor. Both `member` and `computed-mapping` carry `member`,
		// so the union narrows correctly.
		if ((route.kind === 'member' || route.kind === 'computed-mapping') && route.member.relationId === anchorId) {
			continue;
		}
		raiseMutationDiagnostic(nonAnchorPredicateDiagnostic(view, name, route));
	}
}

/**
 * The deferral diagnostic for a WHERE column that is **not** anchor-resolvable — a
 * non-anchor member, an EAV pivot, or a name backed by no member. Each keeps the
 * `unsupported-decomposition-predicate` reason (the structured contract is unchanged)
 * and differs only in the human message, so the misattribution the support fix removes
 * does not recur: an EAV / unbacked column is not a "non-anchor member". The
 * genuine-non-anchor case preserves the `non-anchor decomposition member` substring the
 * deferral test pins.
 */
function nonAnchorPredicateDiagnostic(view: MutableViewLike, name: string, route: ColumnRoute): MutationDiagnostic {
	const head = `cannot write through logical table '${view.name}': the WHERE references column '${name}',`;
	const need = `a predicate-honest multi-member fan-out needs snapshot-consistent base-op execution`;
	switch (route.kind) {
		case 'eav':
			return {
				reason: 'unsupported-decomposition-predicate', column: name, table: view.name,
				message: `${head} backed by an EAV pivot member; ${need} (deferred — filter only on anchor base columns)`,
			};
		case 'unbacked':
			return {
				reason: 'unsupported-decomposition-predicate', column: name, table: view.name,
				message: `${head} which is not backed by any decomposition member; ${need} (deferred — filter only on anchor base columns)`,
			};
		default: // 'member' / 'computed-mapping' on a non-anchor member
			return {
				reason: 'unsupported-decomposition-predicate', column: name, table: view.name,
				message: `${head} backed by a non-anchor decomposition member; ${need} (deferred — filter only on the anchor / shared key, or pin the rows via the anchor)`,
			};
	}
}

/** `select <anchorKey> from <anchorTable> <anchorAlias> [where <pred>]` — the shared identifying set. */
function anchorKeySubquery(shape: DecompShape, pred: AST.Expression | undefined): AST.SelectStmt {
	const anchorKey = singleKeyColumn(undefined, shape, shape.anchor);
	return {
		type: 'select',
		columns: [{ type: 'column', expr: { type: 'column', name: anchorKey, table: shape.anchor.relationId } }],
		from: [{ ...memberIdentifierSource(shape.anchor), alias: shape.anchor.relationId }],
		where: pred ? cloneExpr(pred) : undefined,
	};
}

/**
 * Substitute references to logical columns (unqualified, or qualified by the
 * logical table's own name) with their backing get-body expression. Base-member-
 * qualified references are left untouched.
 */
function substituteViewColumns(expr: AST.Expression, shape: DecompShape, view: MutableViewLike): AST.Expression {
	const viewName = view.name.toLowerCase();
	return transformExpr(expr, (col) => {
		if (col.table && col.table.toLowerCase() !== viewName) return undefined;
		const repl = shape.viewColToBaseRef.get(col.name.toLowerCase());
		return repl ? cloneExpr(repl) : undefined;
	});
}

/** Strip the anchor's alias qualifier so a predicate targets the bare anchor UPDATE/DELETE. */
function stripAnchorQualifier(expr: AST.Expression, shape: DecompShape): AST.Expression {
	return transformExpr(expr, (col) => (col.table === shape.anchor.relationId ? { type: 'column', name: col.name } : undefined));
}

// --- shape helpers --------------------------------------------------------

/** True when `logical` (lowercased) is one of the anchor's shared-key columns. */
function isSharedKeyColumn(shape: DecompShape, logical: string): boolean {
	const keys = shape.storage.sharedKey.keyColumnsByRelation.get(shape.anchor.relationId) ?? [];
	return keys.some(k => k.toLowerCase() === logical);
}

/**
 * A capture-correlation key column with its declared nullability, resolved off the
 * owning member's base schema — what makes {@link capturedValueSubquery}'s read-back
 * NULL-safe exactly when the key column is nullable (a nullable anchor/member key would
 * otherwise make the correlation silently miss rows keyed NULL). An unknown column
 * (defensive) falls back to the NULL-safe form, which is semantically identical for a
 * NOT NULL column and merely less index-friendly.
 */
function keyColumnInfo(schema: TableSchema, name: string): KeyColumnInfo {
	const col = schema.columns.find(c => c.name.toLowerCase() === name.toLowerCase());
	return { name, nullable: !col || !col.notNull };
}

/**
 * The single shared-key column for a member. v1 threads a single-column key
 * (mirrors `multi-source.ts`' single-column-PK boundary); a composite/absent key
 * is deferred. `view` is optional purely so the deferral message can name the
 * logical table (the anchor-subquery call site has none in scope).
 */
function singleKeyColumn(view: MutableViewLike | undefined, shape: DecompShape, member: DecompositionMember): string {
	const keys = shape.storage.sharedKey.keyColumnsByRelation.get(member.relationId) ?? [];
	if (keys.length !== 1) {
		raiseMutationDiagnostic({
			reason: 'unsupported-decomposition-key',
			table: view?.name,
			message: `cannot write through a decomposition with a ${keys.length === 0 ? 'missing' : 'composite'} shared key on member '${member.relationId}': v1 fan-out threads a single-column key`,
		});
	}
	return keys[0];
}

function memberIdentifier(member: DecompositionMember): AST.IdentifierExpr {
	return { type: 'identifier', name: member.relation.table, schema: member.relation.schema };
}

function memberIdentifierSource(member: DecompositionMember): AST.TableSource {
	return { type: 'table', table: memberIdentifier(member) };
}

function resolveMemberTable(ctx: PlanningContext, member: DecompositionMember): TableReferenceNode {
	return buildTableReference(memberIdentifierSource(member), ctx).tableRef;
}

/**
 * Collect the **logical column names** a user predicate references (lowercased,
 * ignoring any view-name qualifier) and whether it embeds a subquery. The anchor
 * gate ({@link assertAnchorScoped}) maps each collected name to its owning member
 * via the threaded backward lineage — so the gate decision is lineage-driven; this
 * walk only enumerates which columns to check (the user-term analogue of the retired
 * `collectColumnQualifiers`, which scanned base-table qualifiers on the substituted
 * expression).
 */
function collectViewColumnRefs(expr: AST.Expression): { names: Set<string>; hasSubquery: boolean } {
	const names = new Set<string>();
	let hasSubquery = false;
	const walk = (node: unknown): void => {
		if (Array.isArray(node)) { node.forEach(walk); return; }
		if (!node || typeof node !== 'object' || !('type' in (node as object))) return;
		const n = node as Record<string, unknown> & { type: string };
		if (n.type === 'column') {
			if (typeof n.name === 'string') names.add(n.name.toLowerCase());
			return;
		}
		if (n.type === 'subquery' || n.type === 'select' || n.type === 'exists') { hasSubquery = true; return; }
		for (const v of Object.values(n)) walk(v);
	};
	walk(expr);
	return { names, hasSubquery };
}

function rejectReturning(view: MutableViewLike, returning: AST.ResultColumn[] | undefined): void {
	if (returning && returning.length > 0) {
		raiseMutationDiagnostic({
			reason: 'returning-through-view',
			table: view.name,
			message: `RETURNING through logical table '${view.name}' is not yet supported`,
		});
	}
}

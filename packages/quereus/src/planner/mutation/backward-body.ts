import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import { isRelationalNode, type PlanNode, type RelationalComponentRef, type RelationalPlanNode } from '../nodes/plan-node.js';
import { TableReferenceNode } from '../nodes/reference.js';
import type { Scope } from '../scopes/scope.js';
import { buildSelectStmt } from '../building/select.js';
import { resolveBaseSite } from '../analysis/update-lineage.js';
import { raiseMutationDiagnostic } from './mutation-diagnostic.js';
import type { MutableViewLike } from './single-source.js';
import { bodyPlanningContext } from './body-context.js';

/**
 * The **one** plan-node backward-walk consumer the multi-source join walk and the
 * decomposition fan-out share (docs/vu-roundtrip.md § Round-Trip Laws and the
 * Derived Backward Walk). It plans a view body **once** and reads the
 * `PhysicalProperties.updateLineage` the forward pass already threaded, routing
 * each output column back to its owning base relation — instead of each caller
 * re-deriving column→base lineage from the body's projection AST.
 *
 * It is source-count-agnostic: a single base table (a value-only EAV anchor), a
 * two-table inner join (the multi-source acceptance shape), or an n-way
 * anchor-rooted decomposition join (mandatory inner + optional outer members) all
 * funnel through the same read. Multi-source layers its `JoinNode` / side mapping
 * on top of {@link BodyBackwardLineage}; the decomposition fan-out layers its
 * member routing / anchor-resolvable predicate gate on top. Neither re-walks the body's
 * projection AST for routing.
 */

/** One output column of a planned view body, by backward lineage. */
export interface BackwardColumn {
	/** Output (view/logical) column name, lowercased. */
	readonly name: string;
	/** Output column name in its original display spelling. */
	readonly displayName: string;
	/**
	 * Owning base relation's `TableReferenceNode` plan-node id (a `base` or — with
	 * {@link nullExtended} — outer-join-`null-extended` site). `undefined` for a
	 * `computed` output (e.g. an EAV correlated subquery, a non-invertible expr).
	 */
	readonly baseTableId?: number;
	/** Owning base column name (present whenever {@link baseTableId} is). */
	readonly baseColumn?: string;
	/**
	 * True for an identity-or-inverse `base` site that is NOT null-extended — the
	 * site is value-writable (an `inverse` is applied by the consumer; identity
	 * otherwise). A `computed` / `null-extended` site is read-only here.
	 */
	readonly writable: boolean;
	/** True when the owning site is potentially null-extended by an outer join (optional member). */
	readonly nullExtended: boolean;
	/** Backward inverse closure for a non-identity invertible base site (absent for identity). */
	readonly inverse?: (written: AST.Expression) => AST.Expression;
	/** Domain restriction an `inverse` profile carries (conjoined into the identifying predicate). */
	readonly domain?: AST.Expression;
	/**
	 * Set for an outer-join `existence` (`exists … as`) flag — the relational component
	 * whose membership the flag reifies. It has no `baseTableId` / `baseColumn` (it maps
	 * to no base column), but is **writable through an effect**: the multi-source write
	 * path routes a flag-flip to an insert/delete of this component (§ Existence columns).
	 */
	readonly existenceComponent?: RelationalComponentRef;
	/** The join-predicate guard the existence flag is the truth-value of (present iff {@link existenceComponent}). */
	readonly existenceGuard?: AST.Expression;
	/**
	 * Set for an authored (`with inverse`) column — writable and insertable through the
	 * put expressions rather than a single verbatim base column (`baseTableId` /
	 * `baseColumn` stay undefined so no verbatim-value consumer silently admits it).
	 * Each put names its owning base relation by `TableReferenceNode` id; `newRefIndex`
	 * maps `new.<name>` references to output column indexes
	 * (docs/vu-inverses.md § Authored inverses).
	 */
	readonly authored?: {
		readonly puts: ReadonlyArray<{ readonly table: number; readonly baseColumn: string; readonly expr: AST.Expression }>;
		readonly newRefIndex: ReadonlyMap<string, number>;
	};
	/** The projection's source expression (already in base terms) — the substitution target for a user predicate / assigned value over this column. */
	readonly baseTermExpr: AST.Expression;
}

export interface BodyBackwardLineage {
	readonly sel: AST.SelectStmt;
	/** The planned view body (the source of `updateLineage`); reused by callers, not re-planned. */
	readonly root: RelationalPlanNode;
	/** Every `TableReferenceNode` in the planned body's relational spine, by plan-node id. */
	readonly tableRefsById: Map<number, TableReferenceNode>;
	/** Output (view) column name (lowercased) → its base-term replacement expression. */
	readonly viewColToBaseRef: Map<string, AST.Expression>;
	/** Per output column, in projection order. */
	readonly columns: BackwardColumn[];
	/**
	 * The relational source the lowered base-term columns resolve against — the
	 * outermost `JoinNode` for a join body (`anchor ⋈ members`, or an n-way join), or
	 * the bare anchor table/retrieve node for an anchor-only body. Reused (not
	 * re-planned) as the source an up-front identity/value capture builds on top of
	 * ({@link findBodySource}; the decomposition dual of `analyzeJoinView`'s `joinNode`).
	 */
	readonly bodySource: RelationalPlanNode;
	/**
	 * {@link bodySource}'s combined column scope (`ctx.outputScopes.get(bodySource)`) — the
	 * exact scope `buildSelectStmt` resolved the body's own predicate/projections against,
	 * so a capture built over it resolves the member-relationId-qualified base columns
	 * byte-identically. `undefined` when the source exposes no registered scope (a defensive
	 * miss the capture builder rejects).
	 */
	readonly bodyScope: Scope | undefined;
}

/**
 * The relational source a planned view body's lowered base columns resolve against: the
 * **outermost** relational node from the root that carries a **registered output scope** —
 * the `JoinNode` for a columnar / n-way join body (its nested joins ride inside via
 * `getRelations()`), or the FROM relation (the aliased base table) for an anchor-only body
 * with no join (a value-only EAV decomposition). The capture builds its
 * `Project(Filter(source))` on this node and resolves the member-relationId-qualified base
 * columns against its scope, so the returned node **must** be the one the scope was registered
 * on (`buildFrom`/`buildJoin` register on the FROM `AliasNode` / `JoinNode`, NOT the inner
 * `TableReferenceNode` an anchor-only body would otherwise surface). `outputScopes` is the
 * builder's node→scope map; we return the first node reachable from `root` that has an entry,
 * falling back to `root` only if none does (defensive — every body analyzed here has a scoped
 * FROM). (§ Round-Trip Laws and the Derived Backward Walk; the decomposition dual of
 * `analyzeJoinView`'s `joinNode`, the generalized `findJoinNode` in multi-source.ts.)
 */
export function findBodySource(root: RelationalPlanNode, outputScopes: ReadonlyMap<PlanNode, Scope>): RelationalPlanNode {
	let scoped: RelationalPlanNode | undefined;
	const visit = (n: PlanNode): void => {
		if (scoped) return;
		// The outermost scoped node is the FROM relation: a JoinNode (join body) or the FROM
		// AliasNode/table (anchor-only body). Both carry the combined column scope the capture
		// resolves against; an inner TableReferenceNode (deeper) carries none.
		if (isRelationalNode(n) && outputScopes.has(n)) { scoped = n; return; }
		for (const child of n.getRelations()) visit(child);
	};
	visit(root);
	return scoped ?? root;
}

/** Collect every `TableReferenceNode` in a planned body's relational spine, indexed by plan-node id. */
export function collectTableRefs(root: PlanNode): Map<number, TableReferenceNode> {
	const out = new Map<number, TableReferenceNode>();
	const visit = (n: PlanNode): void => {
		if (n instanceof TableReferenceNode) {
			out.set(Number(n.id), n);
			return;
		}
		for (const child of n.getRelations()) visit(child);
	};
	visit(root);
	return out;
}

/**
 * Plan a view body once and read its threaded `updateLineage` into a per-column
 * backward map. The caller must already have rejected any structural shape it does
 * not accept (the multi-source walk rejects `select *` / non-inner joins up front;
 * the decomposition body is synthesized with an explicit projection list). A
 * remaining `select *` projection or projection/attribute arity mismatch surfaces
 * a structured `no-base-lineage` diagnostic here.
 */
export function analyzeBodyLineage(ctx: PlanningContext, view: MutableViewLike): BodyBackwardLineage {
	if (view.selectAst.type !== 'select') {
		raiseMutationDiagnostic({
			reason: 'no-base-lineage',
			table: view.name,
			message: `view '${view.name}' has a ${view.selectAst.type.toUpperCase()} body, which has no recoverable base operation`,
		});
	}
	const sel = view.selectAst;

	// A STORED body plans on its own home-schema path, not the writing statement's
	// (`bodyPlanningContext`); an ephemeral CTE / inline-subquery target keeps `ctx`.
	const bodyPlan = buildSelectStmt(bodyPlanningContext(ctx, view), sel);
	if (!isRelationalNode(bodyPlan)) {
		raiseMutationDiagnostic({
			reason: 'no-base-lineage',
			table: view.name,
			message: `view '${view.name}' body did not produce a relation`,
		});
	}
	const root = bodyPlan as RelationalPlanNode;
	const tableRefsById = collectTableRefs(root);

	const attrs = root.getAttributes();
	const lineage = root.physical.updateLineage;
	const projections = sel.columns;
	if (projections.length !== attrs.length) {
		raiseMutationDiagnostic({
			reason: 'no-base-lineage',
			table: view.name,
			message: `cannot write through view '${view.name}': projection/attribute arity mismatch (${projections.length} vs ${attrs.length})`,
		});
	}

	const viewColToBaseRef = new Map<string, AST.Expression>();
	const columns: BackwardColumn[] = [];
	projections.forEach((rc, i) => {
		const attr = attrs[i];
		const displayName = view.columns?.[i] ?? attr.name;
		const name = displayName.toLowerCase();
		if (rc.type === 'all') {
			// Defensive: callers reject `select *` first (it has no 1:1 projection→base
			// routing). Reaching here is a caller bug, not a user shape.
			raiseMutationDiagnostic({
				reason: 'no-base-lineage',
				table: view.name,
				message: `cannot write through view '${view.name}': a 'select *' body has no per-column base lineage`,
			});
		}
		// The projection's source expression is already in base terms (it lives in the
		// body's own FROM scope), so it is the substitution target for user
		// predicates / assignments written against this output column.
		const baseTermExpr = (rc as AST.ResultColumnExpr).expr;
		viewColToBaseRef.set(name, baseTermExpr);

		const resolved = resolveBaseSite(lineage?.get(attr.id));
		columns.push({
			name,
			displayName,
			baseTableId: resolved.table,
			baseColumn: resolved.baseColumn,
			writable: resolved.writable,
			nullExtended: resolved.nullExtended,
			...(resolved.inverse ? { inverse: resolved.inverse } : {}),
			...(resolved.domain ? { domain: resolved.domain } : {}),
			...(resolved.existenceComponent ? { existenceComponent: resolved.existenceComponent } : {}),
			...(resolved.existenceGuard ? { existenceGuard: resolved.existenceGuard } : {}),
			...(resolved.authored ? { authored: resolved.authored } : {}),
			baseTermExpr,
		});
	});

	// The relational source the lowered base-term columns resolve against + its combined
	// column scope, captured from the SINGLE plan above (the body is planned once). The
	// decomposition value capture / the EAV follow-up build their `Project(Filter(source))`
	// over these rather than re-planning a cloned body (multi-source layers its own typed
	// `findJoinNode` accessor on `root`; the two find the same outermost join).
	const bodySource = findBodySource(root, ctx.outputScopes);
	const bodyScope = ctx.outputScopes.get(bodySource);

	return { sel, root, tableRefsById, viewColToBaseRef, columns, bodySource, bodyScope };
}

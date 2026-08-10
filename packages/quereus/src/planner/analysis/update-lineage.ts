import type * as AST from '../../parser/ast.js';
import type { TableSchema } from '../../schema/table.js';
import { classifyProjectionExpr, traceInvertibleColumn, composeDomain } from './scalar-invertibility.js';
import { expressionToString } from '../../emit/ast-stringify.js';
import type { Attribute, AttributeDefault, AuthoredInverseMeta, AuthoredPut, ConstantBinding, ConstantValue, RelationalComponentRef, ScalarPlanNode, UpdateSite } from '../nodes/plan-node.js';

/**
 * Update-lineage model — per-output-column provenance back onto base columns,
 * per `docs/view-updateability.md` § The Update Site Model.
 *
 * **Shipped scope (Phase 1).** This is the AST-driven, single-source lineage
 * the view-mutation rewrite consumes: a view body's projection list maps each
 * output column to either a writable base column (`base`) or a read-only
 * computed expression (`computed`). It is the dual of the optimizer's FD walk,
 * restricted to the single-source projection-and-filter shape.
 *
 * The doc additionally describes threading a richer `UpdateSite` /
 * `AttributeDefault` surface through `PhysicalProperties.computePhysical`
 * (so `query_plan()` can surface lineage and so arbitrary operator nesting
 * composes). That plan-node-threaded generalization is the Phase-2 foundation
 * and is intentionally NOT wired here — see the Status note in
 * docs/view-updateability.md.
 */

/** Attribute id — matches the `number` keys used by `attribute-provenance.ts`. */
export type AttributeId = number;

/** Where one view output column traces back to on the base table. */
export type ViewColumnLineage =
	| { readonly kind: 'base'; readonly baseColumnName: string }
	| { readonly kind: 'computed'; readonly expr: AST.Expression };

/** One output column of an updateable view body. */
export interface ViewColumn {
	readonly name: string;
	readonly lineage: ViewColumnLineage;
	/** True when the underlying base column is a generated column. */
	readonly generated: boolean;
}

/**
 * Derive the per-output-column lineage of a single-source projection-and-filter
 * view body from its `SELECT` AST and the resolved base table.
 *
 * - `select *` expands to every base column, each tracing to itself.
 * - a bare/aliased column reference traces to that base column (identity /
 *   rename — the only invertible profile in Phase 1).
 * - any other projection expression is `computed` (read-only).
 *
 * An explicit `CREATE VIEW v(a, b)` column list overrides the output names
 * positionally, leaving the lineage targets unchanged.
 */
export function deriveViewColumns(
	sel: AST.SelectStmt,
	baseTable: TableSchema,
	viewColumnsOverride?: ReadonlyArray<string>,
): ViewColumn[] {
	const columns: ViewColumn[] = [];

	for (const rc of sel.columns) {
		if (rc.type === 'all') {
			for (const col of baseTable.columns) {
				columns.push({
					name: col.name,
					lineage: { kind: 'base', baseColumnName: col.name },
					generated: !!col.generated,
				});
			}
			continue;
		}

		const lineage = classifyProjectionExpr(rc.expr);
		const name = rc.alias ?? (rc.expr.type === 'column' ? rc.expr.name : expressionToString(rc.expr));
		if (lineage.kind === 'base') {
			const baseCol = baseTable.columns.find(c => c.name.toLowerCase() === lineage.baseColumnName.toLowerCase());
			columns.push({
				name,
				lineage: { kind: 'base', baseColumnName: baseCol?.name ?? lineage.baseColumnName },
				generated: !!baseCol?.generated,
			});
		} else {
			columns.push({ name, lineage: { kind: 'computed', expr: rc.expr }, generated: false });
		}
	}

	if (viewColumnsOverride && viewColumnsOverride.length > 0) {
		for (let i = 0; i < viewColumnsOverride.length && i < columns.length; i++) {
			columns[i] = { ...columns[i], name: viewColumnsOverride[i] };
		}
	}

	return columns;
}

// ---------------------------------------------------------------------------
// Plan-node-threaded backward walk (the derived dual of the forward FD walk).
//
// These helpers are invoked from each operator's `computePhysical` and READ the
// forward annotation that pass already produced (the node's own `fds` /
// `constantBindings`, the children's `updateLineage`). They never re-derive a
// parallel FD/EC walk — see `docs/vu-roundtrip.md` § Round-Trip Laws and
// the Derived Backward Walk. The result is the `PhysicalProperties.updateLineage`
// / `attributeDefaults` surface the view-mutation orchestrator consumes.
// ---------------------------------------------------------------------------

/** Result of one operator's backward method. */
export interface BackwardLineage {
	readonly updateLineage?: ReadonlyMap<number, UpdateSite>;
	readonly attributeDefaults?: ReadonlyMap<number, AttributeDefault>;
}

/**
 * Compose an outer invertible transform (from `traceInvertibleColumn`) onto a
 * child UpdateSite. For `out = f(child)` where the child traces to base via its
 * own inverse `g⁻¹`, a written `out` binds `base = g⁻¹(f⁻¹(out))` — the child's
 * inverse wraps the outer one; domains conjoin.
 */
function composeUpdateSite(
	child: UpdateSite,
	outerInverse: ((w: AST.Expression) => AST.Expression) | undefined,
	outerDomain: AST.Expression | undefined,
): UpdateSite {
	switch (child.kind) {
		case 'base': {
			const childInv = child.inverse;
			const inverse = childInv && outerInverse
				? (w: AST.Expression) => childInv(outerInverse(w))
				: (childInv ?? outerInverse);
			const domain = composeDomain(child.domain, outerDomain);
			return {
				kind: 'base',
				table: child.table,
				baseColumn: child.baseColumn,
				...(inverse ? { inverse } : {}),
				...(domain ? { domain } : {}),
			};
		}
		case 'computed':
			return child;
		case 'null-extended':
			return { kind: 'null-extended', guard: child.guard, inner: composeUpdateSite(child.inner, outerInverse, outerDomain) };
		case 'existence':
			// Read-only at the combinator; an outer scalar transform on the flag does
			// not make it base-writable. A bare projection (identity, no outer inverse)
			// passes it through unchanged; the resolver still reports it non-writable.
			return child;
		case 'authored':
			// Unreachable from deriveProjectUpdateLineage (it degrades an authored CHILD
			// to `computed` before composing — the site's `newRefIndex` is indexed by the
			// CARRYING select's outputs, which an outer re-projection can reorder/drop).
			// A join merge passes authored sites through addSide without composing, so
			// this case only defends future combinators: pass through unchanged.
			return child;
	}
}

/**
 * Project backward method. For each projection, trace the output back to a base
 * column through the invertible-transform chain (`traceInvertibleColumn`) and
 * compose its `UpdateSite` from the child lineage; a non-invertible / multi-
 * column / leaf-less projection becomes `computed`. Insert defaults carry
 * forward for surviving (traced) columns. Keys thread implicitly: the lineage
 * is keyed by output attribute id and the forward FD walk (already emitted by
 * the caller) carries key-ness along the same projection map.
 */
export function deriveProjectUpdateLineage(
	projections: ReadonlyArray<{ readonly node: ScalarPlanNode; readonly authoredInverse?: AuthoredInverseMeta }>,
	outputAttrs: readonly Attribute[],
	childLineage: ReadonlyMap<number, UpdateSite> | undefined,
	childDefaults: ReadonlyMap<number, AttributeDefault> | undefined,
): BackwardLineage {
	const lineage = new Map<number, UpdateSite>();
	const defaults = new Map<number, AttributeDefault>();
	projections.forEach((proj, i) => {
		const outId = outputAttrs[i]?.id;
		if (outId === undefined) return;
		// Authored wins: a `with inverse` clause overrides any registry-inferred site
		// entirely (the clause is total per column — never composed with inferred
		// steps). An unroutable target (computed / inverse / null-extended child site)
		// degrades the column to `computed` — the author took over, so the inferred
		// put never applies (docs/vu-inverses.md § Authored inverses).
		if (proj.authoredInverse) {
			const authored = childLineage ? deriveAuthoredSite(proj.authoredInverse, childLineage) : undefined;
			lineage.set(outId, authored ?? { kind: 'computed', expr: proj.node.expression });
			return;
		}
		const trace = childLineage ? traceInvertibleColumn(proj.node) : null;
		const childSite = trace ? childLineage!.get(trace.attrId) : undefined;
		if (trace && childSite && childSite.kind !== 'authored') {
			lineage.set(outId, composeUpdateSite(childSite, trace.inverse, trace.domain));
			const carried = childDefaults?.get(trace.attrId);
			if (carried) defaults.set(outId, carried);
		} else {
			// Includes an authored CHILD site re-projected by an outer select: its
			// `newRefIndex` is indexed by the carrying select's outputs, which this
			// projection can reorder/drop — degrade to read-only rather than mis-map.
			lineage.set(outId, { kind: 'computed', expr: proj.node.expression });
		}
	});
	return {
		updateLineage: lineage.size > 0 ? lineage : undefined,
		attributeDefaults: defaults.size > 0 ? defaults : undefined,
	};
}

/**
 * Resolve one projection's authored-inverse metadata into an `authored`
 * UpdateSite: each assignment's build-time-resolved target attribute is read
 * through the child lineage to its owning base relation — the same ownership
 * walk every other put rides. Every target must reach a plain identity base
 * column (writable, not null-extended, no registry inverse — the target IS a
 * raw base column of the FROM sources); otherwise the site is unroutable and
 * the caller degrades the column to `computed`.
 */
function deriveAuthoredSite(
	meta: AuthoredInverseMeta,
	childLineage: ReadonlyMap<number, UpdateSite>,
): UpdateSite | undefined {
	const puts: AuthoredPut[] = [];
	for (const a of meta.assignments) {
		const resolved = resolveBaseSite(childLineage.get(a.targetAttrId));
		if (!resolved.writable || resolved.nullExtended || resolved.table === undefined
			|| resolved.baseColumn === undefined || resolved.inverse !== undefined || resolved.authored) {
			return undefined;
		}
		puts.push({ table: resolved.table, baseColumn: resolved.baseColumn, expr: a.expr });
	}
	return { kind: 'authored', puts, newRefIndex: meta.newRefIndex };
}

/** Build a symbolic default expression from a forward `ConstantBinding` value. */
function constantValueToExpr(value: ConstantValue): AST.Expression {
	if (value.kind === 'literal') return { type: 'literal', value: value.value };
	return typeof value.paramRef === 'number'
		? { type: 'parameter', index: value.paramRef }
		: { type: 'parameter', name: value.paramRef };
}

/**
 * Filter backward method. `updateLineage` passes through unchanged (a filter
 * removes rows, never columns). Insert defaults gain a `constant-fd` entry for
 * every column the forward pass pinned to a constant (`∅ → c = v`), read off the
 * node's already-computed `constantBindings` — NOT a re-scan of the predicate
 * AST. This is the replacement for `building/view-mutation.ts`'s
 * `extractFilterConstants` (deleted by the orchestrator ticket).
 */
export function deriveFilterAttributeDefaults(
	childDefaults: ReadonlyMap<number, AttributeDefault> | undefined,
	outputAttrs: readonly Attribute[],
	constantBindings: ReadonlyArray<ConstantBinding>,
): ReadonlyMap<number, AttributeDefault> | undefined {
	const defaults = new Map<number, AttributeDefault>(childDefaults ?? []);
	for (const binding of constantBindings) {
		const valueExpr = constantValueToExpr(binding.value);
		for (const colIdx of binding.attrs) {
			const attr = outputAttrs[colIdx];
			if (attr) defaults.set(attr.id, { kind: 'constant-fd', value: valueExpr });
		}
	}
	return defaults.size > 0 ? defaults : undefined;
}

/**
 * Join backward method (composition along the forward join FDs). Output
 * attribute ids are preserved per side, so each side's `updateLineage` merges
 * directly; for an outer join the non-preserved side's sites are wrapped
 * `null-extended` under the join predicate as guard (materialization-on-write
 * is a later phase — this only annotates the lineage). `guard` is the join
 * predicate AST; absent for `cross` (which never null-extends).
 */
/**
 * One existence (`exists … as`) flag the JoinNode appends after both sides, for
 * {@link deriveJoinUpdateLineage} to register an `existence` `UpdateSite` against.
 */
export interface JoinExistenceSite {
	/** Output attribute id of the appended flag column. */
	readonly attrId: number;
	/** The non-preserved side the flag reifies the match of. */
	readonly side: 'left' | 'right';
	/** That side's relational plan-node id (the component handle). */
	readonly componentTable: number;
}

export function deriveJoinUpdateLineage(
	joinType: string,
	leftLineage: ReadonlyMap<number, UpdateSite> | undefined,
	rightLineage: ReadonlyMap<number, UpdateSite> | undefined,
	leftDefaults: ReadonlyMap<number, AttributeDefault> | undefined,
	rightDefaults: ReadonlyMap<number, AttributeDefault> | undefined,
	guard: AST.Expression | undefined,
	existence?: ReadonlyArray<JoinExistenceSite>,
): BackwardLineage {
	const lineage = new Map<number, UpdateSite>();
	const defaults = new Map<number, AttributeDefault>();

	const addSide = (
		l: ReadonlyMap<number, UpdateSite> | undefined,
		d: ReadonlyMap<number, AttributeDefault> | undefined,
		nullExtended: boolean,
	): void => {
		if (l) for (const [id, site] of l) {
			lineage.set(id, nullExtended && guard !== undefined ? { kind: 'null-extended', guard, inner: site } : site);
		}
		if (d) for (const [id, def] of d) defaults.set(id, def);
	};

	switch (joinType) {
		case 'inner':
		case 'cross':
			addSide(leftLineage, leftDefaults, false);
			addSide(rightLineage, rightDefaults, false);
			break;
		case 'left':
			addSide(leftLineage, leftDefaults, false);
			addSide(rightLineage, rightDefaults, true);
			break;
		case 'right':
			addSide(leftLineage, leftDefaults, true);
			addSide(rightLineage, rightDefaults, false);
			break;
		case 'full':
			addSide(leftLineage, leftDefaults, true);
			addSide(rightLineage, rightDefaults, true);
			break;
		case 'semi':
		case 'anti':
			// Only the left side's columns appear in the output.
			addSide(leftLineage, leftDefaults, false);
			break;
	}

	// Register an `existence` site per appended flag (read-only here; the write
	// half flips its routing on). The guard is the join predicate the flag is the
	// truth-value of — absent for `cross` (which never null-extends, so the parser
	// rejects existence clauses there; defensively skip if guard is missing).
	if (existence && guard !== undefined) {
		for (const ex of existence) {
			lineage.set(ex.attrId, {
				kind: 'existence',
				component: { kind: 'join-side', table: ex.componentTable, side: ex.side },
				guard,
			});
		}
	}

	return {
		updateLineage: lineage.size > 0 ? lineage : undefined,
		attributeDefaults: defaults.size > 0 ? defaults : undefined,
	};
}

/**
 * The Phase-1 *writable* base column of an UpdateSite: the base column reached
 * by the identity transform (a bare column / rename), else `undefined` (a
 * computed, null-extended, or non-identity-inverse site, which the Phase-1
 * `ViewColumn` model cannot represent as writable). The bridge that keeps the
 * plan-node `updateLineage` and the AST `deriveViewColumns` in agreement on the
 * writable-column set.
 *
 * **Identity-only by design** — this is the AST-parity reader, paired with the
 * identity-only AST classifier (`classifyProjectionExpr`) that
 * `deriveViewColumns` consumes; widening it would break that parity
 * (`viewColumnsFromUpdateLineage` ⇄ `deriveViewColumns`). It is therefore NOT the
 * authority for an `inverse` site's writability, nor for INSERT routing: the n-way
 * {@link resolveBaseSite} (consumed by the multi-source join path, the decomposition
 * fan-out, AND the single-source UPDATE *and INSERT* paths) and the static `view_info`
 * / `column_info` surfaces (`func/builtins/schema.ts` `baseSiteOf`) treat a `base` site
 * **with an `inverse`** as writable (docs § Scalar Invertibility, § Inner Join). The
 * single-source spine now reads that full `base`+`inverse` chain off the planned
 * `updateLineage` (via `resolveBaseSite`) into its `writableSites` map: UPDATE routes
 * any site, INSERT admits the inverse-absent subset (identity + passthrough). This
 * reader stays identity-only purely as the `deriveViewColumns` parity bridge.
 */
export function identityBaseColumn(site: UpdateSite | undefined): string | undefined {
	return site && site.kind === 'base' && site.inverse === undefined ? site.baseColumn : undefined;
}

/**
 * The base-table site an {@link UpdateSite} resolves to, with the outer-join
 * `null-extended` layer unwrapped so the **owning base relation is always
 * surfaced** (a null-extended column still names the base table its inner site
 * targets, just non-writably). This is the *n-way* backward-site reader the put
 * fan-out consumers share — the generalization of the two single-purpose readers
 * above it: the former multi-source-local identity-or-inverse reader (which
 * discarded the table on null-extension) and the single-source identity-only
 * {@link identityBaseColumn}. One reader, consumed by single-source, the
 * multi-source join walk, and the decomposition fan-out (docs/vu-roundtrip.md
 * § Round-Trip Laws and the Derived Backward Walk).
 *
 * - `base` → `{ table, baseColumn, writable: true, nullExtended: false, inverse?, domain? }`.
 * - `null-extended` → the inner base site, but `writable: false`,
 *   `nullExtended: true` (a write would need materialization of the missing side —
 *   deferred; the decomposition fan-out reports it as an optional-member write).
 * - `computed` / absent → `{ writable: false, nullExtended: false }` (read-only).
 *
 * `writable` is **identity-or-inverse base** (matching the multi-source reader it
 * subsumes). A consumer needing *identity-only* writability (the single-source
 * spine and the decomposition value routing) additionally checks
 * `inverse === undefined`.
 */
export interface ResolvedBaseSite {
	/** Producing `TableReferenceNode` plan-node id, or `undefined` for a `computed` site. */
	readonly table?: number;
	readonly baseColumn?: string;
	readonly writable: boolean;
	readonly nullExtended: boolean;
	readonly inverse?: (written: AST.Expression) => AST.Expression;
	readonly domain?: AST.Expression;
	/**
	 * Set on an outer-join `existence` (`exists … as`) flag — the **writable-through-
	 * effect** descriptor: there is no base column (`table` / `baseColumn` stay
	 * `undefined`), but `writable: true` because *writing* the flag drives an
	 * insert/delete of the named {@link RelationalComponentRef}. The multi-source write
	 * path reads this discriminator to route the existence-flip to the conditional
	 * materialization (`true` ⇒ insert the component, `false` ⇒ delete it); a `base`-
	 * column consumer keeps gating on `baseColumn !== undefined`, so it is unaffected.
	 */
	readonly existenceComponent?: RelationalComponentRef;
	/** The join-predicate guard the existence flag is the truth-value of (present iff {@link existenceComponent}). */
	readonly existenceGuard?: AST.Expression;
	/**
	 * Set on an `authored` (`with inverse`) site — writable AND insertable, but the
	 * write fans out through the authored put expressions rather than a single
	 * verbatim base column (`table` / `baseColumn` stay `undefined` so no verbatim-
	 * value consumer silently admits it). Each put names its owning base relation;
	 * `newRefIndex` maps a put expression's `new.<name>` references to output column
	 * indexes of the select that carried the clause.
	 */
	readonly authored?: {
		readonly puts: ReadonlyArray<{ readonly table: number; readonly baseColumn: string; readonly expr: AST.Expression }>;
		readonly newRefIndex: ReadonlyMap<string, number>;
	};
}

export function resolveBaseSite(site: UpdateSite | undefined): ResolvedBaseSite {
	if (!site) return { writable: false, nullExtended: false };
	switch (site.kind) {
		case 'base':
			return { table: site.table, baseColumn: site.baseColumn, writable: true, nullExtended: false, inverse: site.inverse, domain: site.domain };
		case 'null-extended': {
			const inner = resolveBaseSite(site.inner);
			return { ...inner, writable: false, nullExtended: true };
		}
		case 'computed':
			return { writable: false, nullExtended: false };
		case 'existence':
			// An existence flag — a join side OR a set-op branch — is writable through an
			// *effect*, not a base mapping: it has no base column (`table` / `baseColumn`
			// undefined), but a written flag drives an insert/delete of `component`. The
			// join-side variant materializes/removes the non-preserved side (the
			// multi-source write path); the `set-op-branch` variant inserts/deletes the
			// named operand (the set-op write path, `set-op-membership-write` — it routes
			// the per-branch fan-out off the runtime membership probe rather than the join
			// match). Both surface the `existenceComponent` discriminator; base-column
			// readers gate on `baseColumn`, so they are unaffected.
			return { writable: true, nullExtended: false, existenceComponent: site.component, existenceGuard: site.guard };
		case 'authored':
			// Writable and insertable through the authored put expressions; no single
			// verbatim base column (`baseColumn` stays undefined), so a consumer must
			// handle `authored` explicitly to route the write.
			return { writable: true, nullExtended: false, authored: { puts: site.puts, newRefIndex: site.newRefIndex } };
	}
}

/**
 * Re-express the Phase-1 `ViewColumn[]` surface as a thin reader over a planned
 * node's `updateLineage`, for the single-source case. Identity-base sites map to
 * writable `base` columns; everything else (computed, null-extended, non-
 * identity inverse) maps to `computed`, exactly matching `deriveViewColumns`'s
 * conservative AST classification on the same body. Verified equal in the
 * `bx-roundtrip-law-harness` parity check (`test/property.spec.ts`).
 *
 * `generated` is reported `false` here (the writable set is what callers consume);
 * the AST `deriveViewColumns` remains the authority for the generated-column flag
 * until the orchestrator migrates its call sites to a planned node.
 */
export function viewColumnsFromUpdateLineage(
	outputAttrs: readonly Attribute[],
	updateLineage: ReadonlyMap<number, UpdateSite> | undefined,
	viewColumnsOverride?: ReadonlyArray<string>,
): ViewColumn[] {
	const columns: ViewColumn[] = outputAttrs.map((attr) => {
		const site = updateLineage?.get(attr.id);
		const baseCol = identityBaseColumn(site);
		if (baseCol !== undefined) {
			return { name: attr.name, lineage: { kind: 'base', baseColumnName: baseCol }, generated: false };
		}
		const expr: AST.Expression = site && site.kind === 'computed' ? site.expr : { type: 'column', name: attr.name };
		return { name: attr.name, lineage: { kind: 'computed', expr }, generated: false };
	});
	if (viewColumnsOverride && viewColumnsOverride.length > 0) {
		for (let i = 0; i < viewColumnsOverride.length && i < columns.length; i++) {
			columns[i] = { ...columns[i], name: viewColumnsOverride[i] };
		}
	}
	return columns;
}

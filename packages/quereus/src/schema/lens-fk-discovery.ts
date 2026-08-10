import type * as AST from '../parser/ast.js';
import type { LensSlot } from './lens.js';
import type { ForeignKeyConstraintSchema, TableSchema } from './table.js';
import { resolveReferencedColumns } from './table.js';
import type { SchemaManager } from './manager.js';
import { resolveSlotBasisSource } from './lens-prover.js';
import { createLogger } from '../common/logger.js';

const log = createLogger('schema:lens-fk-discovery');

/**
 * Catalog-only lens FK discovery + structural-equivalence helpers, shared by the
 * planner-side enforcement collectors (`planner/mutation/lens-enforcement.ts`) and
 * the runtime cascade walker (`runtime/foreign-key-actions.ts`). Both sit *above*
 * `schema/`, so the pure catalog reads they both need live here to keep them DRY
 * without a layering violation. Nothing in this module plans, emits, or mutates —
 * it reads `LensSlot` / `TableSchema` shape and resolves names.
 */

/**
 * Maps each reconstructible logical column (lowercased) to the basis column it
 * projects from, read off the slot's compiled-body projection. Mirrors the
 * prover's `mappedBasisColumn`: a logical column is reconstructible iff its
 * body-output term is a plain `column` reference, in which case a written value
 * maps straight back to that basis column. The output index stays aligned with
 * `compiledBody.columns`.
 */
export function logicalToBasisColumnMap(slot: LensSlot): Map<string, string> {
	const map = new Map<string, string>();
	let outputIndex = 0;
	for (const p of slot.columnProvenance) {
		const rc = slot.compiledBody.columns[outputIndex];
		outputIndex++;
		if (rc && rc.type === 'column' && rc.expr.type === 'column') {
			map.set(p.logicalColumn.toLowerCase(), (rc.expr as AST.ColumnExpr).name);
		}
	}
	return map;
}

/**
 * Resolves a logical FK's referenced (parent) column **names** — the terms the
 * synthesized `EXISTS` subquery filters the parent on. The names resolve against
 * the registered logical parent view, so logical names are correct here. Prefers
 * the FK's stored `referencedColumnNames` (populated for every declared FK); when
 * a bare `references parent` (no column list) leaves them empty, falls back to the
 * parent logical table's primary-key column names (resolved via the parent's lens
 * slot, or a plain table lookup as a backstop).
 */
export function resolveLogicalReferencedColumns(
	fk: ForeignKeyConstraintSchema,
	referencedSchema: string,
	schemaManager: SchemaManager,
): string[] {
	if (fk.referencedColumnNames && fk.referencedColumnNames.length > 0) {
		return [...fk.referencedColumnNames];
	}
	const parent = schemaManager.getSchema(referencedSchema)?.getLensSlot(fk.referencedTable)?.logicalTable
		?? schemaManager.findTable(fk.referencedTable, referencedSchema);
	if (!parent) return [];
	return parent.primaryKeyDefinition.map(pk => parent.columns[pk.index]?.name).filter((n): n is string => n !== undefined);
}

/** Encodes a `(childCol, parentCol)` basis index pair as an order-independent set key. */
export function pairKey(childCol: number, parentCol: number): string {
	return `${childCol}:${parentCol}`;
}

/**
 * The `(basisChildCol → basisParentCol)` index pair-set of the logical FK, mapped
 * through the child and parent slots' reconstructible projections, or `undefined`
 * when any column is not a plain basis-column projection (a name-only fallback, or
 * an unresolved index) — which disqualifies elision. Implements the structural core
 * shared by the RESTRICT redundancy detector and the cascade elision: every logical
 * FK child column maps with no transform to a `basisChild` column, and every logical
 * referenced column maps with no transform to a `basisParent` column.
 */
export function mappedFkBasisPairs(
	slot: LensSlot,
	fk: ForeignKeyConstraintSchema,
	parentSlot: LensSlot,
	logicalParentColumns: readonly string[],
	basisChild: TableSchema,
	basisParent: TableSchema,
): Set<string> | undefined {
	const childMap = logicalToBasisColumnMap(slot);
	const parentMap = logicalToBasisColumnMap(parentSlot);
	const pairs = new Set<string>();
	for (let i = 0; i < fk.columns.length; i++) {
		const childLogical = slot.logicalTable.columns[fk.columns[i]]?.name;
		if (childLogical === undefined) return undefined;
		const childBasisName = childMap.get(childLogical.toLowerCase());
		if (childBasisName === undefined) return undefined; // name-only fallback ⇒ not value-preserving
		const childBasisCol = basisChild.columnIndexMap.get(childBasisName.toLowerCase());
		if (childBasisCol === undefined) return undefined;

		const parentBasisName = parentMap.get(logicalParentColumns[i].toLowerCase());
		if (parentBasisName === undefined) return undefined; // parent col not a plain projection
		const parentBasisCol = basisParent.columnIndexMap.get(parentBasisName.toLowerCase());
		if (parentBasisCol === undefined) return undefined;

		pairs.add(pairKey(childBasisCol, parentBasisCol));
	}
	return pairs.size > 0 ? pairs : undefined;
}

/**
 * **All** FKs `basisChild` declares whose unordered `(childCol → parentCol)` index
 * pair-set equals `mappedPairs` and that reference `basisParent` (schema + name) —
 * the full match list, not just the first. The basis write's own FK enforcement
 * (`buildChildSideFKChecks` on the child side, `buildParentSideFKChecks` on the
 * parent side) already enforces such an FK, so a matching one subsumes the lens-level
 * check; for the cascade walker a matching one means the physical FK-action walker
 * already propagates over the basis. The comparison is an unordered *set* of index
 * pairs (mirrors `lookupCoveringFK`'s positional `equiMap` reasoning) — a permuted
 * basis FK (same columns, different pairing) yields a different pair-set and must NOT
 * match; a partial FK fails the arity check.
 *
 * Returning *every* match (not the first) is load-bearing for the parent-side RESTRICT
 * caller's action gate: a single non-`restrict` matching basis FK means the basis
 * parent write cascades / nulls rather than rejects, so eliding the lens RESTRICT
 * would be unsound even when a *different* matching basis FK is `restrict`. The
 * action-agnostic child-side and cascade callers take `matches[0]` / `matches.length > 0`.
 */
export function matchingBasisFks(
	basisChild: TableSchema,
	basisParent: TableSchema,
	mappedPairs: ReadonlySet<string>,
): ForeignKeyConstraintSchema[] {
	const matches: ForeignKeyConstraintSchema[] = [];
	for (const bfk of basisChild.foreignKeys ?? []) {
		if (bfk.referencedTable.toLowerCase() !== basisParent.name.toLowerCase()) continue;
		const bfkParentSchema = (bfk.referencedSchema ?? basisChild.schemaName).toLowerCase();
		if (bfkParentSchema !== basisParent.schemaName.toLowerCase()) continue;
		if (bfk.columns.length !== mappedPairs.size) continue;
		let refCols: readonly number[];
		try {
			refCols = resolveReferencedColumns(bfk, basisParent);
		} catch {
			continue;
		}
		if (refCols.length !== bfk.columns.length) continue;
		const bfkPairs = new Set<string>();
		for (let j = 0; j < bfk.columns.length; j++) {
			bfkPairs.add(pairKey(bfk.columns[j], refCols[j]));
		}
		if (bfkPairs.size === mappedPairs.size && [...mappedPairs].every(p => bfkPairs.has(p))) {
			matches.push(bfk);
		}
	}
	return matches;
}

/**
 * The basis FKs on `childSlot`'s basis child structurally equivalent to `fk`'s logical
 * FK over the same mapped `(basisChildCol → basisParentCol)` index-pair set referencing
 * `basisParent` — the single match core both {@link basisChildCarriesEquivalentFk}
 * (action-agnostic, `… .length > 0`) and {@link matchingBasisFksForLensRef}
 * (action-aware) share. Resolves the child's basis source via {@link resolveSlotBasisSource}
 * and reuses the redundancy detector's structural core ({@link mappedFkBasisPairs} +
 * {@link matchingBasisFks}), **without** the non-row-reducing projection gate (a
 * RESTRICT-side conservatism that does not apply when the basis action is what
 * propagates). Returns `[]` on a multi-source child, a non-plain mapping, or no match.
 */
function matchingBasisFksCore(
	childSlot: LensSlot,
	fk: ForeignKeyConstraintSchema,
	parentSlot: LensSlot,
	parentLogicalColumns: readonly string[],
	basisParent: TableSchema,
	schemaManager: SchemaManager,
): ForeignKeyConstraintSchema[] {
	const basisChild = resolveSlotBasisSource(childSlot, schemaManager);
	if (!basisChild) return [];
	const mappedPairs = mappedFkBasisPairs(childSlot, fk, parentSlot, parentLogicalColumns, basisChild, basisParent);
	if (!mappedPairs) return [];
	return matchingBasisFks(basisChild, basisParent, mappedPairs);
}

/**
 * Whether the basis child carries a structurally-equivalent FK referencing
 * `basisParent`. When such a basis FK exists, the physical `executeForeignKeyActions`
 * already propagates the parent-side action over the basis (and the logical view
 * reflects it). Built on {@link matchingBasisFksCore}.
 *
 * **Action-agnostic** — any matching basis FK (cascade / set-null / set-default /
 * restrict) returns `true`. This is **no longer the lens walker's elision gate**: the
 * walker now elides only on an *agreeing* basis action (see
 * {@link matchingBasisFksForLensRef}) and suppresses a *divergent* basis action (see
 * {@link basisFksOverriddenByDivergentLensFk}). It is kept exported for the
 * direct-call unit tests, which assert the structural-match predicate independent of
 * action. Returns `false` on a multi-source child, a non-plain mapping, or no match.
 */
export function basisChildCarriesEquivalentFk(
	childSlot: LensSlot,
	fk: ForeignKeyConstraintSchema,
	parentSlot: LensSlot,
	parentLogicalColumns: readonly string[],
	basisParent: TableSchema,
	schemaManager: SchemaManager,
): boolean {
	return matchingBasisFksCore(childSlot, fk, parentSlot, parentLogicalColumns, basisParent, schemaManager).length > 0;
}

/**
 * One logical FK (on any lens slot in any schema) that references a given parent
 * slot's logical table — the cross-slot discovery unit both the parent-side RESTRICT
 * collector and the cascade walker consume.
 */
export interface LogicalParentFkRef {
	/** The lens slot carrying the FK (the logical child). */
	readonly childSlot: LensSlot;
	/** The logical FK constraint. */
	readonly fk: ForeignKeyConstraintSchema;
	/** Child FK column logical names (declaration order). */
	readonly childLogicalColumns: string[];
	/** Parent referenced column logical names (declaration order, FK-aligned). */
	readonly parentLogicalColumns: string[];
}

/**
 * Every logical FK (on any lens slot in any schema) that references `parentSlot`'s
 * logical table (name + resolved schema, case-insensitive). The physical
 * parent-side machinery discovers FKs by scanning declared `TableSchema.foreignKeys`
 * on basis tables; a logical FK lives only on the **child** slot's `enforced-fk`
 * obligation (on no basis table), so this walks every schema's lens slots instead.
 *
 * Applies the same count-mismatch guard the RESTRICT collector already applied (skip
 * when the resolved parent referenced columns do not match the FK's child arity), and
 * resolves both the child FK column logical names and the parent referenced column
 * logical names so callers need not re-derive them. It does **not** apply an action
 * gate — callers filter (`restrict` for the RESTRICT collector; `cascade` /
 * `setNull` / `setDefault` for the cascade walker).
 */
export function findLogicalParentFkRefs(
	parentSlot: LensSlot,
	schemaManager: SchemaManager,
): LogicalParentFkRef[] {
	const parentLogicalName = parentSlot.logicalTable.name;
	const parentLogicalSchema = parentSlot.logicalTable.schemaName;
	const refs: LogicalParentFkRef[] = [];
	for (const schema of schemaManager._getAllSchemas()) {
		for (const childSlot of schema.getAllLensSlots()) {
			if (!childSlot.obligations || childSlot.obligations.length === 0) continue;
			const childLogicalSchema = childSlot.logicalTable.schemaName;
			for (const obligation of childSlot.obligations) {
				if (obligation.kind !== 'enforced-fk') continue;
				if (obligation.constraint.kind !== 'foreignKey') continue;
				const fk = obligation.constraint.constraint;
				const referencedSchema = fk.referencedSchema ?? childLogicalSchema;
				// This FK must reference *this* parent slot's logical table (name + schema).
				if (fk.referencedTable.toLowerCase() !== parentLogicalName.toLowerCase()) continue;
				if (referencedSchema.toLowerCase() !== parentLogicalSchema.toLowerCase()) continue;
				const parentLogicalColumns = resolveLogicalReferencedColumns(fk, referencedSchema, schemaManager);
				if (parentLogicalColumns.length !== fk.columns.length) {
					log('lens parent-side FK %s: parent column count (%d) != child column count (%d); skipping',
						fk.name ?? '<anon>', parentLogicalColumns.length, fk.columns.length);
					continue;
				}
				const childLogicalColumns = fk.columns.map(childIdx => childSlot.logicalTable.columns[childIdx]?.name ?? `#${childIdx}`);
				refs.push({ childSlot, fk, childLogicalColumns, parentLogicalColumns });
			}
		}
	}
	return refs;
}

/**
 * Builds the **lens basis-FK gate**: the set of basis `schema.table` keys
 * (lowercased) that back ≥1 logical parent slot referenced by ≥1 logical FK —
 * the logical-FK analogue of the physical reverse-FK index. This is exactly the
 * reverse-map scan the three basis-keyed lens FK paths
 * ({@link basisFksOverriddenByDivergentLensFk}, plus the runtime
 * `executeLensForeignKeyActions` / `assertLensRestrictsForParentMutation`)
 * perform per write, run once and cached on {@link SchemaManager}.
 *
 * Keyed by the **basis parent** `schema.table` — the value each basis write
 * carries. A parent slot with no single basis spine resolves to `undefined`
 * (multi-source / decomposition) and contributes no key; at runtime that same
 * slot is skipped (`if (!basis) continue`), so the gate's omission is
 * **consistent** with the full scan — no under-report. A slot whose referencing
 * logical FK set is empty (`findLogicalParentFkRefs(...).length === 0`) also
 * contributes no key — there is nothing for the three paths to find.
 *
 * Conservatism is automatic: building from the live catalog, the gate can only
 * **over-report** (a stray key ⇒ an unnecessary scan that finds nothing ⇒ same
 * result, slower); it never under-reports for the current catalog state. The
 * caller ({@link SchemaManager.basisTableBacksLogicalParentFk}) is responsible
 * for rebuilding it on every event that can change this scan's result.
 */
export function buildLensBasisFkGate(schemaManager: SchemaManager): Set<string> {
	const gate = new Set<string>();
	for (const schema of schemaManager._getAllSchemas()) {
		for (const parentSlot of schema.getAllLensSlots()) {
			const basis = resolveSlotBasisSource(parentSlot, schemaManager);   // undefined ⇒ multi-source/absent ⇒ skip
			if (!basis) continue;
			if (findLogicalParentFkRefs(parentSlot, schemaManager).length === 0) continue;
			gate.add(`${basis.schemaName.toLowerCase()}.${basis.name.toLowerCase()}`);
		}
	}
	return gate;
}

/**
 * The basis FKs (declared on the logical child's basis table) structurally equivalent
 * to `ref`'s logical FK over the same mapped `(basisChildCol → basisParentCol)`
 * index-pair set referencing `basisParent`. The lens walker's per-ref match list — the
 * action-aware generalization of {@link basisChildCarriesEquivalentFk} (which is now
 * `… .length > 0`). Resolves the ref's own basis child via `resolveSlotBasisSource`;
 * returns `[]` on a multi-source child, a non-plain mapping, or no matching basis FK.
 */
export function matchingBasisFksForLensRef(
	ref: LogicalParentFkRef,
	parentSlot: LensSlot,
	basisParent: TableSchema,
	schemaManager: SchemaManager,
): ForeignKeyConstraintSchema[] {
	return matchingBasisFksCore(ref.childSlot, ref.fk, parentSlot, ref.parentLogicalColumns, basisParent, schemaManager);
}

/**
 * The set of basis FKs on tables referencing `basisParent` that are **overridden** by a
 * divergent **non-RESTRICT** logical FK over the same equivalent columns for `operation`
 * — i.e. the basis FKs whose physical action / RESTRICT check must be **suppressed**
 * because the logical action governs (`lens-parent-side-fk-divergent-basis-action`).
 * Reverse-maps `basisParent` → parent slot(s) (mirroring `executeLensForeignKeyActions`),
 * discovers referencing logical FKs ({@link findLogicalParentFkRefs}), and for each
 * logical ref whose op-action is non-RESTRICT, adds every structurally-equivalent basis
 * FK ({@link matchingBasisFksForLensRef}) whose op-action **differs**.
 *
 * The returned FK objects are the same references the enforcement sites iterate over
 * (`TableSchema.foreignKeys`), so `overridden.has(fk)` is a direct identity lookup.
 * Empty (cheap) when no parent slot is backed by `basisParent` — the common non-lens
 * case — which the O(1) {@link SchemaManager.basisTableBacksLogicalParentFk} gate
 * decides at entry, with the full reverse-map scan below as the on-hit confirmation.
 * (This set is not itself `foreign_keys`-gated; its callers are.)
 *
 * **Complement invariant** (the load-bearing correctness argument): for one equivalent
 * basis FK `m` with logical op-action `L` (non-RESTRICT) and basis op-action `B`:
 *  - `L === B` ⇒ the lens walker elides AND `m ∉ overridden` (basis acts; exactly one
 *    application of the action).
 *  - `L !== B` ⇒ the lens walker fires AND `m ∈ overridden` (basis suppressed; exactly
 *    one application — the logical action).
 * So in the canonical single-equivalent-basis-FK case the children are mutated by
 * *exactly one* path: never both (no double-mutation), never neither (no dropped
 * enforcement).
 *
 * **Pathological multi-match residual** (sound, non-minimal): if two basis FKs cover the
 * identical columns with *mixed* actions, the walker fires when *any* match diverges and
 * only the *divergent* basis FKs are suppressed — so an agreeing same-action basis FK may
 * also run, a double application of the *same* (idempotent-ish, e.g. SET NULL twice)
 * action. This matches the existing "default to enforce / any uncertainty double-acts"
 * bias; it is never a *dropped* enforcement.
 */
export function basisFksOverriddenByDivergentLensFk(
	basisParent: TableSchema,
	operation: 'delete' | 'update',
	schemaManager: SchemaManager,
): Set<ForeignKeyConstraintSchema> {
	// O(1) gate: when no lens slot backed by basisParent carries a referencing logical
	// FK, the reverse-map scan below finds nothing — return the empty set without scanning.
	if (!schemaManager.basisTableBacksLogicalParentFk(basisParent.schemaName, basisParent.name)) return new Set();

	const overridden = new Set<ForeignKeyConstraintSchema>();
	const basisNameLower = basisParent.name.toLowerCase();
	const basisSchemaLower = basisParent.schemaName.toLowerCase();
	for (const schema of schemaManager._getAllSchemas()) {
		for (const parentSlot of schema.getAllLensSlots()) {
			const basis = resolveSlotBasisSource(parentSlot, schemaManager);
			if (!basis) continue;
			if (basis.name.toLowerCase() !== basisNameLower) continue;
			if (basis.schemaName.toLowerCase() !== basisSchemaLower) continue;
			for (const ref of findLogicalParentFkRefs(parentSlot, schemaManager)) {
				const logicalAction = operation === 'delete' ? ref.fk.onDelete : ref.fk.onUpdate;
				// Only a non-RESTRICT logical action overrides a basis action. A logical
				// RESTRICT is the prereq's domain (`assertLensRestrictsForParentMutation`),
				// so this predicate never overlaps it.
				if (logicalAction !== 'cascade' && logicalAction !== 'setNull' && logicalAction !== 'setDefault') continue;
				for (const m of matchingBasisFksForLensRef(ref, parentSlot, basisParent, schemaManager)) {
					const basisAction = operation === 'delete' ? m.onDelete : m.onUpdate;
					if (basisAction !== logicalAction) overridden.add(m);
				}
			}
		}
	}
	return overridden;
}

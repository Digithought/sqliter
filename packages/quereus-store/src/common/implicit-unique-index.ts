/**
 * The hidden `_uc_*` secondary index the store materializes per non-derived
 * UNIQUE constraint that no explicit index already covers, so a plain UNIQUE
 * enforces via a point seek rather than a full scan — plus the reuse test that
 * decides when an existing index already serves that role.
 */

import {
	normalizeCollationName,
	type TableSchema,
	type TableIndexSchema,
	type UniqueConstraintSchema,
} from '@quereus/quereus';

/**
 * Deterministic name of the implicit covering index materialized for a
 * NON-DERIVED UNIQUE constraint `uc`: the constraint's own name when it has one,
 * else the auto-name `_uc_<colNames>`. This MUST equal the engine's
 * `catalog.ts` `implicitIndexName`, so a name that ever reaches the catalog
 * bundle generator is recognized as hidden / exposed-implicit rather than a user
 * index.
 */
export function implicitUniqueIndexName(schema: TableSchema, uc: UniqueConstraintSchema): string {
	return uc.name ?? `_uc_${uc.columns.map(i => schema.columns[i]?.name ?? String(i)).join('_')}`;
}

/**
 * True when every column of `idx` carries the same effective collation as the
 * column `uc` declares — the reuse gate of {@link findReusableIndexForUnique}.
 *
 * Positions align because the caller has already matched the column SET
 * (`idx.columns[i]` ↔ `uc.columns[i]`). An index column with no explicit COLLATE
 * has `collation === undefined` and falls back to the declared column collation,
 * so the common `create index ix on t(email)` case stays reuse-eligible.
 *
 * Load-bearing: store index KEYS are encoded under each column's own effective
 * collation (`resolveIndexKeyCollations` — index COLLATE ?? table column collation
 * ?? BINARY), so a collation-mismatched index holds DIFFERENT bytes than the
 * `_uc_*` it would replace. Reusing a BINARY-collated index for a NOCASE-declared
 * UNIQUE would make the enforcement seek UNDER-fetch and silently accept a
 * duplicate. Also mirrors `MemoryTableManager.indexCollationsMatchDeclared`, so
 * both backends reuse the same set of indexes. The cost of the strictness is one
 * duplicate hidden index in a rare declaration.
 */
function indexCollationsMatchDeclared(
	schema: TableSchema,
	idx: TableIndexSchema,
	uc: UniqueConstraintSchema,
): boolean {
	return uc.columns.every((colIdx, i) => {
		const declared = normalizeCollationName(schema.columns[colIdx]?.collation ?? 'BINARY');
		const indexCollation = normalizeCollationName(
			idx.columns[i]?.collation ?? schema.columns[colIdx]?.collation ?? 'BINARY',
		);
		return indexCollation === declared;
	});
}

/**
 * The existing `schema.indexes` entry that already realizes `uc`, or undefined
 * when none does and {@link withImplicitUniqueIndexes} must materialize a hidden
 * `_uc_*` of its own.
 *
 * A FULL (non-partial) index over exactly the constrained columns physically
 * holds an entry for every live row, keyed by the same bytes the `_uc_*` would
 * use — so `StoreTableConstraints.findUniqueConflictViaIndex` can seek it directly and
 * a second identical structure would only double DML maintenance. Reuse is
 * refused for:
 *
 *  - an index-DERIVED UC (`derivedFromIndex`) — it already names its index;
 *  - a PARTIAL UNIQUE (`uc.predicate`) — the co-scoped `_uc_*` carries the SAME
 *    predicate OBJECT, which `StoreTableConstraints.findIndexForUniqueConstraint`
 *    matches on identity; a user index with an equal-but-distinct predicate
 *    physically omits rows the constraint still covers;
 *  - a PARTIAL index — it omits out-of-scope rows a full UNIQUE still covers;
 *  - a collation-mismatched index (see {@link indexCollationsMatchDeclared}).
 *
 * A DESC index IS reusable: every writer and reader of an index derives its
 * direction flags from that index's own `columns[].desc`
 * (`StoreTableConstraints.updateSecondaryIndexes`,
 * `StoreTableConstraints.findUniqueConflictViaIndex`), so the enforcement probe lands
 * on the same window a DESC-encoded entry was written to.
 *
 * Reuse makes a plain UNIQUE's hidden index depend on the set of EXPLICIT
 * indexes, so `StoreModule.createIndex` / `dropIndex` must reconcile the physical
 * `_uc_*` store on the transition — see
 * `StoreModule.reconcileImplicitUniqueIndexStores`.
 */
export function findReusableIndexForUnique(
	schema: TableSchema,
	uc: UniqueConstraintSchema,
): TableIndexSchema | undefined {
	if (uc.derivedFromIndex || uc.predicate) return undefined;
	// Skip the constraint's OWN `_uc_*`, so an ALREADY-MATERIALIZED schema answers the
	// same as its engine-facing original: without this a UC would "reuse" the very index
	// it asked for, and a caller diffing the implicit set
	// (`StoreModule.implicitUniqueIndexNameMap`) would conclude the `_uc_*` is not needed
	// and tear its store down.
	const ownName = implicitUniqueIndexName(schema, uc).toLowerCase();
	return (schema.indexes ?? []).find(idx =>
		idx.name.toLowerCase() !== ownName
		&& !idx.predicate
		&& idx.columns.length === uc.columns.length
		&& idx.columns.every((col, i) => col.index === uc.columns[i])
		&& indexCollationsMatchDeclared(schema, idx, uc));
}

/**
 * Return `schema` with a synthetic secondary index materialized into
 * `schema.indexes` for every NON-DERIVED UNIQUE constraint that lacks one — the
 * store analogue of `MemoryTableManager.ensureUniqueConstraintIndexes`.
 *
 * This is what lets a plain column- or table-level `UNIQUE` be enforced by a
 * bounded index point-seek (`StoreTableConstraints.findUniqueConflictViaIndex`)
 * instead of an O(rows) full scan: DML maintenance
 * (`StoreTableConstraints.updateSecondaryIndexes`) and the UNIQUE check both iterate
 * `schema.indexes`, so once the `_uc_*` entry is present the physical index is
 * maintained and seeked with no new code path.
 *
 * The result is held ONLY in `StoreTableBase.materializedSchema` (the
 * enforcement copy), never in the engine-facing `tableSchema` the store returns
 * from `getSchema()` / registers with the engine. So the read-query planner and
 * the catalog bundle never see `_uc_*` (it is fully derived on open from
 * `uniqueConstraints`); like the memory backend, a plain UNIQUE gets no read-side
 * plan from `_uc_*`, only enforcement / maintenance.
 *
 * Idempotent — a name already present is left untouched — and returns a frozen
 * schema (or the input unchanged when there is nothing to add). A
 * `derivedFromIndex` UC is skipped (its `CREATE UNIQUE INDEX` is already in
 * `schema.indexes`). A partial UNIQUE's synthetic index carries the SAME
 * `uc.predicate` object reference, which
 * `StoreTableConstraints.findIndexForUniqueConstraint` matches on identity.
 *
 * A UC whose columns are already covered by a collation-compatible EXPLICIT full
 * index is left WITHOUT a `_uc_*` — that index enforces it (see
 * {@link findReusableIndexForUnique}), so building a byte-identical twin would
 * only double the work of every INSERT / UPDATE / DELETE.
 */
export function withImplicitUniqueIndexes(schema: TableSchema): TableSchema {
	const ucs = schema.uniqueConstraints;
	if (!ucs || ucs.length === 0) return schema;

	const existing = schema.indexes ?? [];
	const present = new Set(existing.map(idx => idx.name.toLowerCase()));
	const additions: TableIndexSchema[] = [];
	for (const uc of ucs) {
		if (uc.derivedFromIndex) continue;
		const name = implicitUniqueIndexName(schema, uc);
		if (present.has(name.toLowerCase())) continue;
		if (findReusableIndexForUnique(schema, uc)) continue;
		present.add(name.toLowerCase());
		additions.push({
			name,
			columns: uc.columns.map(idx => ({ index: idx, collation: schema.columns[idx]?.collation })),
			// SAME reference as `uc.predicate` (undefined for a full UNIQUE) — load-bearing:
			// findIndexForUniqueConstraint admits a partial `_uc_*` by `ix.predicate === uc.predicate`.
			predicate: uc.predicate,
		});
	}
	if (additions.length === 0) return schema;
	return Object.freeze({ ...schema, indexes: Object.freeze([...existing, ...additions]) });
}

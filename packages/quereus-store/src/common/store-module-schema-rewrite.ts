/**
 * Pure schema-to-schema rewrites the module applies around DDL: reconciling an
 * implicit-default text primary-key collation to the store's key collation at CREATE
 * time, and retargeting a table's SELF-referencing foreign keys when the table or one
 * of its columns is renamed.
 *
 * Free functions rather than a layer of the store-module chain — each takes a schema
 * and returns a schema, reading no module state.
 */

import type { ForeignKeyConstraintSchema, TableSchema } from '@quereus/quereus';
import { buildColumnIndexMap } from '@quereus/quereus';

/**
 * Reconcile each text PRIMARY KEY column's declared collation at CREATE time.
 *
 * The store now encodes PRIMARY KEY uniqueness/ordering PHYSICALLY with a
 * PER-COLUMN key collation (`StoreTable.pkKeyCollations`, drawn from each PK
 * column's declared `collation`), so ANY declared PK collation is honored
 * natively — an explicit `collate binary` text PK is keyed under BINARY, a
 * `collate nocase` under NOCASE, etc. The only thing this reconcile still does is
 * supply the store's table-level DEFAULT (`keyCollation` = K = `config.collation`,
 * default NOCASE) to a text PK column that declares NO explicit collation, so an
 * implicit-default text PK keeps the store's historical NOCASE-keyed behavior
 * (rather than the engine's BINARY column default). An EXPLICIT collation — even
 * one diverging from K — is left exactly as declared and re-keyed natively.
 *
 * Collation governs key bytes only for text, so only PK members whose logical type
 * is textual are touched (an `integer primary key` keeps its BINARY; temporal
 * text-physical types carry no collation). Non-PK columns are never touched.
 *
 * This is the CREATE path only — the load path (`connect` / rehydrate) does not
 * reconcile; the persisted DDL is the source of truth on reopen, and the column's
 * (BINARY-elided) `COLLATE` clause round-trips the per-column key collation.
 *
 * Returns the schema unchanged when no implicit text PK column needs the default
 * applied; otherwise a new schema with a rebuilt `columns` array + `columnIndexMap`.
 */
export function reconcilePkCollations(
	schema: TableSchema,
	keyCollation: string,
): TableSchema {
	const pkIndices = new Set(schema.primaryKeyDefinition.map(def => def.index));
	if (pkIndices.size === 0) return schema;

	let changed = false;
	const newColumns = schema.columns.map((col, idx) => {
		if (!pkIndices.has(idx)) return col;
		// Collation governs key bytes only for text; non-text PK columns (integer,
		// real, blob, …) are encoded type-natively and keep their declared collation.
		// Deliberately `isTextual`, NOT `collationAware`: `any` now keys (and
		// compares) under its declared collation, but an undecorated `any` PK's
		// declared collation is always BINARY — `resolveDefaultCollation` never
		// applies a non-BINARY default to ANY, which declares no supported-collation
		// list — and rewriting it to K here would silently flip that shape's
		// comparison semantics store-side only, diverging from the memory backend
		// for no compatibility gain (the historical K-default covers text PKs, not
		// `any`). Only `text` takes the rewrite.
		if (!col.logicalType.isTextual) return col;
		// An EXPLICIT collation is honored as-declared — the per-column key encoding
		// keys the column under it (Option B physical re-key parity with memory).
		if (col.collationExplicit) return col;
		const declared = (col.collation || 'BINARY').toUpperCase();
		if (declared === keyCollation) return col; // implicit default already == K

		// Implicit default diverges from K (e.g. the engine's BINARY column default
		// under the store's NOCASE K): apply the store's table-level default so an
		// undecorated text PK keeps the store's historical NOCASE-keyed semantics.
		changed = true;
		return { ...col, collation: keyCollation };
	});

	if (!changed) return schema;
	const columns = Object.freeze(newColumns);
	return { ...schema, columns, columnIndexMap: buildColumnIndexMap(columns) };
}

/**
 * Build a column remap array: newColumnIndex -> oldColumnIndex | -1.
 * Maps each column in the new layout to its position in the old layout.
 * -1 means the column is new (fill with default).
 */
export function buildColumnRemap(oldColumnNames: string[], newColumnNames: string[]): number[] {
	const oldIndexByName = new Map<string, number>();
	for (let i = 0; i < oldColumnNames.length; i++) {
		oldIndexByName.set(oldColumnNames[i].toLowerCase(), i);
	}
	return newColumnNames.map(name => {
		const oldIdx = oldIndexByName.get(name.toLowerCase());
		return oldIdx !== undefined ? oldIdx : -1;
	});
}

/** Whether `fk` points back at the table that owns it. */
function isSelfForeignKey(
	fk: ForeignKeyConstraintSchema,
	schemaLower: string,
	tableLower: string,
): boolean {
	return (fk.referencedSchema ?? schemaLower).toLowerCase() === schemaLower
		&& fk.referencedTable.toLowerCase() === tableLower;
}

/**
 * Retarget a self-referencing foreign key's `referencedTable` across a rename of
 * the owning table. A pure copy — unlike the CHECK / partial-index rewrites this
 * touches a name field, not a shared AST, so the caller needs no rollback.
 * Returns the input array when nothing self-references.
 */
export function retargetSelfForeignKeys(
	fks: ReadonlyArray<ForeignKeyConstraintSchema> | undefined,
	schemaName: string,
	oldName: string,
	newName: string,
): ReadonlyArray<ForeignKeyConstraintSchema> | undefined {
	if (!fks) return fks;
	const schemaLower = schemaName.toLowerCase();
	const oldLower = oldName.toLowerCase();
	let changed = false;
	const next = fks.map(fk => {
		if (!isSelfForeignKey(fk, schemaLower, oldLower)) return fk;
		changed = true;
		return { ...fk, referencedTable: newName };
	});
	return changed ? Object.freeze(next) : fks;
}

/**
 * Rename a column inside a self-referencing foreign key's `referencedColumnNames`
 * (the names the FK resolves to parent-column indices at enforcement time). Pure
 * copy, as in {@link retargetSelfForeignKeys}. The child-side `columns` are
 * indices, unaffected by a rename.
 */
export function renameColumnInSelfForeignKeys(
	fks: ReadonlyArray<ForeignKeyConstraintSchema> | undefined,
	schemaName: string,
	tableName: string,
	oldCol: string,
	newCol: string,
): ReadonlyArray<ForeignKeyConstraintSchema> | undefined {
	if (!fks) return fks;
	const schemaLower = schemaName.toLowerCase();
	const tableLower = tableName.toLowerCase();
	const oldColLower = oldCol.toLowerCase();
	let changed = false;
	const next = fks.map(fk => {
		if (!isSelfForeignKey(fk, schemaLower, tableLower)) return fk;
		if (!fk.referencedColumnNames?.some(n => n.toLowerCase() === oldColLower)) return fk;
		changed = true;
		return {
			...fk,
			referencedColumnNames: Object.freeze(
				fk.referencedColumnNames.map(n => n.toLowerCase() === oldColLower ? newCol : n)),
		};
	});
	return changed ? Object.freeze(next) : fks;
}

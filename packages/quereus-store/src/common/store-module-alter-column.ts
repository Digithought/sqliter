/**
 * ALTER TABLE ... ALTER COLUMN: the one ALTER arm that can rewrite stored values and
 * re-encode physical keys. The orchestrating method decides the order of the throw-only
 * checks and the mutations; the per-attribute sub-branches below it are pure — each
 * returns the rewritten column schema plus a DEFERRED value-rewrite closure, mutating
 * nothing itself.
 *
 * Fifth layer of the store-module chain:
 *   StoreModuleBase -> StoreModuleCatalog -> StoreModuleSchemaSync -> StoreModuleIndex
 *   -> StoreModuleAlterColumn -> StoreModuleAlter -> StoreModuleRename -> StoreModule
 */

import type {
	ColumnSchema,
	Database,
	EffectiveRowSource,
	Row,
	SchemaChangeInfo,
	SqlValue,
	TableSchema,
} from '@quereus/quereus';
import {
	QuereusError,
	StatusCode,
	buildColumnIndexMap,
	foldDefaultToType,
	planRetypeConversion,
	validateCollationForType,
} from '@quereus/quereus';
import { StoreTable } from './store-table.js';
import { storeSemanticKeyTransform } from './pk-key-resolution.js';
import { withImplicitUniqueIndexes } from './implicit-unique-index.js';
import { StoreModuleIndex } from './store-module-index.js';
import { effectiveDdlRows, validateUniqueOverExistingRows } from './store-module-index-build.js';

/**
 * Result of an {@link alterColumnChange} attribute sub-branch: the rewritten
 * column schema plus whether the collation BYTES changed (which gates the existing-row
 * UNIQUE re-validation and the PK physical re-key). A sub-branch returns null instead when
 * the column is already in the desired state, so the caller returns the schema untouched.
 *
 * `valueConvert` is the per-value rewrite this change needs — SET DATA TYPE's physical
 * conversion or SET NOT NULL's null → DEFAULT backfill — returned DEFERRED: the sub-branch
 * mutates nothing, and {@link alterColumnChange} applies the closure via
 * {@link StoreTable.mapRowsAtIndex} only after every throw-only check has passed (including
 * the existing-row UNIQUE re-validation, which judges the CONVERTED values through this same
 * closure), so a rejected ALTER never leaves rewritten values behind a stale declared type.
 * The closure owns its own NULL handling (the data-type conversion passes NULL through; the
 * backfill maps it to the DEFAULT). Secondary index KEY bytes encode the indexed column
 * VALUES, so after applying the rewrite the caller rebuilds every secondary index.
 */
interface AlterColumnAttrChange {
	newCol: ColumnSchema;
	collationChanged: boolean;
	valueConvert?: (v: SqlValue) => SqlValue;
}

export abstract class StoreModuleAlterColumn extends StoreModuleIndex {
	/** ALTER COLUMN arm of `StoreModuleAlter.alterTable`: change one attribute (NOT NULL / data type /
	 *  default / collation), running the physical re-key + existing-row re-validation the
	 *  collation / PK paths require, then persist. Behavior-preserving extraction. */
	protected async alterColumnChange(
		db: Database,
		schemaName: string,
		tableName: string,
		table: StoreTable,
		oldSchema: TableSchema,
		change: Extract<SchemaChangeInfo, { type: 'alterColumn' }>,
		rows?: EffectiveRowSource,
	): Promise<TableSchema> {
		const colNameLower = change.columnName.toLowerCase();
		const colIndex = oldSchema.columns.findIndex(c => c.name.toLowerCase() === colNameLower);
		if (colIndex === -1) {
			throw new QuereusError(`Column '${change.columnName}' not found.`, StatusCode.ERROR);
		}
		const oldCol = oldSchema.columns[colIndex];
		// Pull exactly one attribute from the change. Each sub-helper returns the new
		// column schema plus whether the collation bytes changed (`collationChanged` gates
		// the existing-row UNIQUE re-validation and PK re-key below) plus a DEFERRED
		// `valueConvert` closure when the change rewrites stored values — the sub-helper
		// itself mutates nothing. Or null when the column is already in the desired state —
		// preserving the pre-refactor early exits (SET NOT NULL no-op, SET COLLATE
		// already-explicit) that leave the table and any open transaction untouched.
		let attr: AlterColumnAttrChange | null;
		if (change.setNotNull !== undefined) {
			attr = await alterColumnSetNotNull(table, oldSchema, oldCol, colIndex, change, rows);
		} else if (change.setDataType !== undefined) {
			attr = await alterColumnSetDataType(table, oldSchema, oldCol, colIndex, change);
		} else if (change.setDefault !== undefined) {
			attr = { newCol: { ...oldCol, defaultValue: change.setDefault }, collationChanged: false };
		} else if (change.setCollation !== undefined) {
			attr = alterColumnSetCollation(oldCol, change, (n) => db.isCollationRegistered(n));
		} else {
			throw new QuereusError('ALTER COLUMN requires an attribute to change', StatusCode.INTERNAL);
		}
		if (attr === null) {
			return oldSchema;
		}
		const { newCol, collationChanged, valueConvert } = attr;
		// Named for the PENDING act, not a completed one: the deferred value rewrite (SET DATA
		// TYPE conversion / SET NOT NULL backfill) is applied below, after every throw-only
		// check. Both gates that read this run BEFORE it, while the store still holds the old
		// values.
		const rewritesValues = valueConvert !== undefined;

		const updatedColumns = oldSchema.columns.map((c, i) => i === colIndex ? newCol : c);
		// Mirror the memory module (MemoryTableManager.alterColumn): a per-column
		// collation change propagates into every index column ordering by this
		// column, so a `derivedFromIndex` UNIQUE re-keys its enforcement under the
		// new collation. StoreTable.uniqueEnforcementCollations reads the index's
		// per-column collation, so without this the index entry would stay stale
		// and the derived UNIQUE would keep enforcing the OLD collation after the
		// ALTER. NOT metadata-only: the store keys each index column under its own
		// effective collation (resolveIndexKeyCollations), so every index covering
		// this column holds stale key bytes until the rebuild below re-encodes them.
		// An index column with an explicit COLLATE is re-collated too — matching
		// memory, which clobbers it the same way (no surface preserves a differing
		// index COLLATE across an ALTER COLUMN SET COLLATE on its column).
		const updatedIndexes = (collationChanged && oldSchema.indexes)
			? oldSchema.indexes.map(idx => ({
				...idx,
				columns: idx.columns.map(ic =>
					ic.index === colIndex ? { ...ic, collation: newCol.collation } : ic),
			}))
			: oldSchema.indexes;
		const updatedSchema: TableSchema = {
			...oldSchema,
			columns: Object.freeze(updatedColumns),
			columnIndexMap: buildColumnIndexMap(updatedColumns),
			indexes: updatedIndexes ? Object.freeze(updatedIndexes) : updatedIndexes,
		};

		// SET DATA TYPE onto/off a type with a key transform (TIMESPAN's total-seconds
		// groupKey, JSON's structural encoder — see `storeSemanticKeyTransform`)
		// changes the physical KEY BYTES a value encodes to, even when the stored
		// VALUE bytes don't change (text → timespan keeps TEXT physical). Treated
		// exactly like a collation change below: existing-row UNIQUE re-validation
		// (equal-elapsed spellings now collide), a PK re-key when the column is a PK
		// member, and a secondary-index rebuild (index keys encode the column's
		// values). A same-type no-op ALTER never gets here (`inferType` returns the
		// shared type object, so the identity check short-circuits).
		const keyTransformChanged = oldCol.logicalType !== newCol.logicalType
			&& (storeSemanticKeyTransform(oldCol.logicalType) !== undefined
				|| storeSemanticKeyTransform(newCol.logicalType) !== undefined);

		// Existing-row UNIQUE re-validation (Option A, non-PK UNIQUE). Two ways an ALTER
		// COLUMN can make rows that were distinct collide, both judged here BEFORE any
		// mutation/persist so the first collision throws CONSTRAINT and leaves the table
		// unchanged and writable (matches the ADD CONSTRAINT rollback shape):
		//  - SET COLLATE / a key-transform change: the comparators change ('a'/'A' collide
		//    under NOCASE). Re-scan under the NEW collation (`updatedSchema` carries it).
		//  - a value-REWRITING change (`valueConvert`: SET DATA TYPE, or a SET NOT NULL
		//    null → DEFAULT backfill): the comparators are unchanged but the VALUES collapse
		//    ('1'/'01' → 1; two NULLs → the same DEFAULT). The probe judges the CONVERTED
		//    rows — the same closure the deferred rewrite below applies — while the store
		//    still holds the old values. A standalone `create unique index` synthesizes a
		//    `derivedFromIndex` entry in `uniqueConstraints`, so both declaration shapes are
		//    reachable through this walk.
		// The PK is intentionally excluded — it never appears in `uniqueConstraints`;
		// its physical re-key/re-validation is the `pkRekeyNeeded` block below.
		//
		// NOTE: one full row scan per covering constraint, and this gate now fires on the
		// COMMON retype/backfill path, not only on the rare collation/transform ones. Fine
		// while tables covered by several UNIQUE constraints over one column are rare; if a
		// wide-constraint table makes ALTER COLUMN slow, judge all covering constraints in a
		// single pass (one `seen` Set per constraint, one stream).
		if (collationChanged || keyTransformChanged || rewritesValues) {
			const coveringConstraints = (updatedSchema.uniqueConstraints ?? [])
				.filter(uc => uc.columns.includes(colIndex));
			for (const uc of coveringConstraints) {
				// Fresh generator per constraint — an async generator is single-shot.
				const effectiveRows = effectiveDdlRows(table, rows);
				await validateUniqueOverExistingRows(
					valueConvert ? convertRowsAtIndex(effectiveRows, colIndex, valueConvert) : effectiveRows,
					updatedSchema,
					uc,
					db.getKeyNormalizerResolver(),
				);
			}
		}

		// SET COLLATE on a PRIMARY KEY member (Option B physical re-key): re-encode
		// every data-store key under the column's new key collation, then rebuild every
		// secondary index (its keys embed the PK suffix). Runs AFTER the non-PK UNIQUE
		// re-validation above so every throw-only check precedes the first store
		// mutation. `updatedSchema.columns` carries the new collation, so the new key
		// bytes follow it.
		const pkRekeyNeeded = (collationChanged || keyTransformChanged)
			&& oldSchema.primaryKeyDefinition.some(def => def.index === colIndex);
		if (pkRekeyNeeded) {
			// The two throw-only re-key questions — "is the change legal?" over the rows
			// this transaction can SEE (CONSTRAINT), then "can the store carry it?" over
			// the committed rows a rollback must restore (BUSY) — asked BEFORE the DDL
			// flush below, so either refusal leaves the store, the catalog AND the
			// enclosing transaction untouched. Mirrors the memory backend's
			// `MemoryTableManager.validateRekeyedPrimaryKey`. The effective probe judges
			// the wrapper-supplied `rows` when the isolation layer holds the
			// transaction's staged rows outside this store — closing the
			// staged-vs-committed hole the old post-flush pass fell through (a staged
			// insert colliding with a committed row was caught by neither side) — else
			// this module's own effective entries, which include its buffered ops, so a
			// pending insert that is itself the duplicate is caught without flushing.
			await table.validateRekeyedPrimaryKey(
				oldSchema.primaryKeyDefinition,
				updatedSchema.columns,
				effectiveDdlRows(table, rows),
			);
			// Physical re-key ahead — flush buffered writes (see
			// `StoreModuleBase.ddlCommitPendingOps`). Every refusal this arm can make has
			// already run above, reading effectively and throwing without the flush, so a
			// rejected ALTER keeps the transaction alive; `rekeyRows`' own pass 1 is now a
			// backstop, not the gate.
			await this.ddlCommitPendingOps();
			await table.rekeyRows(oldSchema.primaryKeyDefinition, updatedSchema.columns);
			// Materialize so the implicit `_uc_*` PK suffix is re-encoded under the new
			// key collation too (`updatedSchema` carries none on its own). NON-enforcing
			// (`skipDuplicateCheck`): this rebuild reads only committed rows, which may
			// retain a row a wrapper's transaction has deleted whose indexed value
			// collides with a survivor — the pre-mutation
			// `validateUniqueOverExistingRows` walk above already judged every unique
			// structure covering the altered column against the transaction's effective
			// rows, and an index NOT covering it has unchanged values and collation, so
			// it cannot newly collide (the PK-suffix change never affects index-column
			// uniqueness). See `rebuildSecondaryIndexes`' skipDuplicateCheck contract.
			await this.rebuildSecondaryIndexes(schemaName, tableName, table, withImplicitUniqueIndexes(updatedSchema), db.getKeyNormalizerResolver(), true);
		}

		// Deferred value rewrite (SET DATA TYPE physical conversion / SET NOT NULL DEFAULT
		// backfill): every throw-only check above has passed, so the store mutation is now
		// safe — a rejected ALTER never reaches this point, leaving values, DDL and the
		// transaction untouched. Flush buffered writes first so `mapRowsAtIndex` rewrites this
		// transaction's rows too; unflushed, they would replay under the OLD physical type
		// (see `StoreModuleBase.ddlCommitPendingOps`; a re-flush after the PK re-key's own is a no-op).
		//
		// NOTE: `valueConvert` and `pkRekeyNeeded` cannot both be set today, and this ordering
		// depends on that. `valueConvert` comes only from SET DATA TYPE or SET NOT NULL;
		// SET NOT NULL changes neither collation nor logical type, so it never sets
		// `pkRekeyNeeded`, and SET DATA TYPE on a PK member is refused both upstream (every live
		// caller — the engine's ALTER COLUMN emitter, see `runAlterColumn` in
		// runtime/emit/alter-table.ts, and the materialized-view reshape, which declares a
		// key-column retype inexpressible) AND locally, by `alterColumnSetDataType` itself. If a
		// PK-member retype is ever admitted (that local guard removed), this rewrite must move IN
		// FRONT of the `pkRekeyNeeded` block: otherwise `rekeyRows` and its index rebuild encode
		// the PRE-rewrite values and the rebuild below is skipped, leaving keys and indexes
		// disagreeing with the stored values.
		if (valueConvert) {
			await this.ddlCommitPendingOps();
			await table.mapRowsAtIndex(colIndex, valueConvert);
		}

		// The value rewrite above changed stored column values in place (same PK, new value) —
		// and a key-identity transform change re-encodes the column's index-key bytes even with
		// values untouched. Likewise a SET COLLATE on a non-PK column covered by any index
		// (explicit or hidden `_uc_*`): index KEY bytes encode the indexed column values under
		// the column's own effective collation (resolveIndexKeyCollations), so the persisted
		// entries are keyed under the OLD collation until rebuilt — an index-backed lookup or
		// UNIQUE enforcement seek after the ALTER would find nothing. In every case any index
		// covering this column still points at the OLD bytes until rebuilt (mirrors the memory
		// module's `valueConvert` rebuild in MemoryTableManager.alterColumn).
		// `rebuildSecondaryIndexes` reads committed-only, so flush buffered writes first — the
		// value rewrite above already did, and the transform-only / collation-only paths must
		// too; a re-flush with nothing pending is a no-op. Skipped when the PK re-key above
		// already rebuilt every index, so no double rebuild. Materialize so an implicit `_uc_*`
		// over the rewritten column is rebuilt against the new value bytes too (the covering
		// check reads the materialized set for the same reason). The rebuild is NON-enforcing
		// (`skipDuplicateCheck`): the UNIQUE re-validation above already judged the issuer's
		// effective rows — it runs on `collationChanged` too, so the contract holds for the
		// collation arm — and this module's committed rows may retain a row a wrapper's
		// transaction has deleted whose converted value duplicates a survivor — enforcing here
		// would spuriously reject what the probe correctly accepted.
		const materializedUpdated = withImplicitUniqueIndexes(updatedSchema);
		const indexCoversAlteredColumn = (materializedUpdated.indexes ?? [])
			.some(ix => ix.columns.some(ic => ic.index === colIndex));
		if ((rewritesValues || keyTransformChanged || (collationChanged && indexCoversAlteredColumn)) && !pkRekeyNeeded) {
			await this.ddlCommitPendingOps();
			await this.rebuildSecondaryIndexes(schemaName, tableName, table, materializedUpdated, db.getKeyNormalizerResolver(), true);
		}

		// The bare pair, not `StoreModuleIndex.adoptAndPersistSchema` — this arm may already
		// have rewritten stored values (`mapRowsAtIndex`), re-keyed the data store and rebuilt
		// index stores above, so restoring the old cached schema on a persist failure would
		// read re-encoded bytes through the pre-ALTER layout. Same accepted tradeoff as every
		// other row-rewriting arm; see the `NOTE:` above `rebuildSecondaryIndexes` in
		// `StoreModuleAlter.alterDropColumn`.
		table.updateSchema(updatedSchema);
		await this.saveTableDDL(updatedSchema);

		// No emit here: the dispatcher (`StoreModuleAlter.alterTable`) raises the ONE
		// event per statement after every arm, gated on `change.ddl`.
		return updatedSchema;
	}
}

/**
 * SET NOT NULL / DROP NOT NULL sub-branch of {@link alterColumnChange}. Returns the
 * new column schema, or null when the column is already in the desired nullability
 * (the pre-refactor `return oldSchema` no-op). Mutates nothing: the NULL-backfill
 * probe is throw-only, and the backfill itself is returned as a deferred
 * `valueConvert` (null → DEFAULT) the caller applies only after every throw-only
 * check — including the UNIQUE re-validation over the backfilled values — has passed.
 *
 * `rows` is the wrapper-supplied effective row source (the isolation overlay). When present,
 * the reject-vs-backfill decision scans it instead of `table.rowsWithNullAtIndex`: behind the
 * isolation layer the issuer's pending inserts live in the wrapper's overlay, not this store,
 * so the store's own count would miss them and wrongly accept the ALTER. The committed-store
 * `mapRowsAtIndex` backfill is unchanged — the overlay-resident pending rows are the isolation
 * layer's job (its overlay migration), this store only owns its committed rows.
 */
async function alterColumnSetNotNull(
	table: StoreTable,
	oldSchema: TableSchema,
	oldCol: ColumnSchema,
	colIndex: number,
	change: Extract<SchemaChangeInfo, { type: 'alterColumn' }>,
	rows?: EffectiveRowSource,
): Promise<AlterColumnAttrChange | null> {
	let newCol: ColumnSchema;
	let valueConvert: ((v: SqlValue) => SqlValue) | undefined;
	if (change.setNotNull === true && !oldCol.notNull) {
		// Backfill NULLs from a literal DEFAULT, or throw. Routed through the shared
		// `foldDefaultToType` so (a) a signed numeric default (`default -5`, a UnaryExpr)
		// is recognized here exactly as the memory module recognizes it, and (b) the
		// literal is converted to the column's declared type, so a backfilled cell matches
		// what an INSERT under the same DEFAULT would store.
		const defaultLiteral = foldDefaultToType(oldCol.defaultValue, oldCol.logicalType, change.columnName);
		// Decide reject-vs-backfill over the DDL transaction's EFFECTIVE rows. `rows()` (the
		// isolation overlay) sees the issuer's pending inserts; `rowsWithNullAtIndex` (run
		// directly, no wrapper) sees the store's own effective rows. Either way a NULL the
		// transaction can see is backfilled, or rejects the ALTER, like any other row.
		let anyNull: boolean;
		if (rows) {
			anyNull = false;
			for await (const row of rows()) {
				if (row[colIndex] === null) { anyNull = true; break; }
			}
		} else {
			anyNull = (await table.rowsWithNullAtIndex(colIndex)) > 0;
		}
		if (anyNull) {
			if (defaultLiteral === undefined || defaultLiteral === null) {
				// Throw-only, and before the DDL-commit below: the transaction survives.
				throw new QuereusError(
					`column ${change.columnName} contains NULL values`,
					StatusCode.CONSTRAINT,
				);
			}
			const fill = defaultLiteral;
			// Backfill DEFERRED: the caller flushes + `mapRowsAtIndex`es this closure only
			// after its throw-only checks pass. Run directly, that fills the transaction's
			// rows too (the probe saw them). Behind isolation the issuer's overlay-resident
			// NULL rows are filled by the isolation layer's overlay migration, not here —
			// this store never holds them.
			valueConvert = (v) => v === null ? fill : v;
		}
		newCol = { ...oldCol, notNull: true };
	} else if (change.setNotNull === false && oldCol.notNull) {
		if (oldSchema.primaryKeyDefinition.some(def => def.index === colIndex)) {
			throw new QuereusError(
				`Cannot DROP NOT NULL on PRIMARY KEY column '${change.columnName}'`,
				StatusCode.CONSTRAINT,
			);
		}
		newCol = { ...oldCol, notNull: false };
	} else {
		return null; // already in desired state
	}
	return { newCol, collationChanged: false, valueConvert };
}

/**
 * SET DATA TYPE sub-branch of {@link alterColumnChange}. Returns the retyped column
 * schema. Mutates nothing: for every retype between DIFFERENT logical types, a
 * throw-only convert pass over the live rows proves every value convertible, and the
 * conversion itself is returned as a deferred `valueConvert` the caller applies only
 * after every throw-only check — including the UNIQUE re-validation over the converted
 * values — has passed. Gated on logical-type IDENTITY, not the physical storage class:
 * `inferType` flattens aliases to the shared type object (`varchar(50)` IS `TEXT_TYPE`),
 * so an alias retype is schema-only, while a same-class retype (text → date) still
 * rejects values the new type refuses and rewrites the rest to the new type's
 * canonical spelling ('2024-06-05T00:00:00Z' → '2024-06-05') — exactly as an INSERT
 * would have stored them.
 *
 * A retype of a PRIMARY KEY member is refused here rather than converted: the rewrite
 * below is `mapRowsAtIndex`, a payload-only rewrite that reuses `entry.key` verbatim, so
 * a PK column's physical key bytes would stay encoded under the OLD type while the value
 * moves to the new one — unfindable by any lookup under the new encoding, and the same
 * `keyTransformChanged` path in the caller would re-key from the pre-rewrite values before
 * this rewrite ever ran (see the NOTE above the `valueConvert` block in
 * {@link alterColumnChange}). Every live SQL caller already refuses this earlier (the
 * engine's `runAlterColumn` and the materialized-view reshape's inexpressibility check),
 * so this only guards a direct module call — mirrors the memory backend's carve-out
 * (`MemoryTableManager.alterColumn`).
 */
async function alterColumnSetDataType(
	table: StoreTable,
	oldSchema: TableSchema,
	oldCol: ColumnSchema,
	colIndex: number,
	change: Extract<SchemaChangeInfo, { type: 'alterColumn' }>,
): Promise<AlterColumnAttrChange> {
	const { newLogicalType, convert } = planRetypeConversion(change.setDataType!, oldCol.logicalType, change.columnName);
	let valueConvert: ((v: SqlValue) => SqlValue) | undefined;
	if (convert) {
		if (oldSchema.primaryKeyDefinition.some(def => def.index === colIndex)) {
			throw new QuereusError(
				`Cannot change the data type of primary key column '${change.columnName}' of table '${oldSchema.name}'.`,
				StatusCode.CONSTRAINT,
			);
		}
		// Throw-only pass over the LIVE rows, so an unconvertible value this
		// transaction inserted rejects the ALTER with the transaction still intact.
		// The rewrite itself is DEFERRED: the caller flushes + `mapRowsAtIndex`es
		// this closure only after its remaining throw-only checks pass.
		// NOTE: pre-existing gap — this scan reads the store's own effective rows and
		// ignores a wrapper-supplied `rows` stream (unlike the memory module's arm). No
		// hole under isolation: the wrapper's `validateOverlayMigration` converts every
		// staged overlay value itself before the underlying mutates.
		for await (const value of table.iterateEffectiveValuesAtIndex(colIndex)) {
			if (value !== null) convert(value);
		}
		valueConvert = (v) => v === null ? v : convert(v);
	}
	return { newCol: { ...oldCol, logicalType: newLogicalType }, collationChanged: false, valueConvert };
}

/**
 * SET COLLATE sub-branch of {@link alterColumnChange}. Returns the recollated column
 * schema with `collationChanged` set when the collation bytes actually change (a bare
 * metadata flip keeps it false), or null when the column is already explicit in the
 * desired collation (the pre-refactor `return oldSchema` no-op). Synchronous — no
 * row scan happens here; the caller runs the re-validation / re-key the flag gates.
 */
function alterColumnSetCollation(
	oldCol: ColumnSchema,
	change: Extract<SchemaChangeInfo, { type: 'alterColumn' }>,
	isCollationRegistered: (name: string) => boolean,
): AlterColumnAttrChange | null {
	// Per-column collation update. PRIMARY KEY uniqueness/ordering is enforced
	// PHYSICALLY in the key bytes under a PER-COLUMN key collation
	// (`StoreTable.pkKeyCollations`), so a PK-column SET COLLATE is honored
	// natively by physically re-keying the data store + rebuilding every
	// secondary index under the new collation (the `isPkColumn` block below),
	// mirroring the memory module's primary re-key. A re-key that would collide
	// under the new collation throws CONSTRAINT before any mutation. For non-PK
	// UNIQUE constraints we re-validate existing rows under the new collation
	// (Option A). Query-layer ORDER BY / `=` / `table_info().collation` pick the
	// new collation up from the column schema once this updated schema re-registers.
	const normalized = validateCollationForType(change.setCollation!, oldCol.logicalType, change.columnName, isCollationRegistered);
	const nameMatches = normalized === (oldCol.collation || 'BINARY');
	if (nameMatches && oldCol.collationExplicit) {
		return null; // already explicit in the desired collation — no scan, no re-key, no re-persist
	}
	// SET COLLATE is a user declaration with the same standing as a
	// CREATE-time COLLATE clause, so mark the collation explicit (rank 2
	// in the comparison lattice) regardless of the column's creation
	// history — including SET COLLATE binary. When only the name matches
	// but the column was not yet explicit (a defaulted collation, or one
	// inherited from session default_collation), flip the flag as a
	// METADATA-ONLY change: the collation bytes are unchanged, so keep
	// collationChanged false to skip rekeyRows / validateUniqueOverExistingRows
	// below while still re-registering the schema and re-persisting DDL.
	// A different name takes the full physical re-key path AND sets the flag.
	return { newCol: { ...oldCol, collation: normalized, collationExplicit: true }, collationChanged: !nameMatches };
}

/**
 * Read-side wrap for a value-rewriting ALTER COLUMN's pre-mutation UNIQUE probe: each row's
 * value at `colIndex` run through `convert` (the sub-branch's deferred `valueConvert`, which
 * owns its own NULL handling), so the probe judges the POST-alter values while the store
 * still holds the old ones. Mutates nothing — the memory module's `convertRowAtIndex`
 * counterpart. A conversion failure propagates: the setDataType pre-pass already proved
 * every visible value convertible, so a throw here is unreachable, and surfacing it beats
 * probing a stale value that could mask a collision.
 */
async function* convertRowsAtIndex(
	rows: AsyncIterable<Row>,
	colIndex: number,
	convert: (v: SqlValue) => SqlValue,
): AsyncIterable<Row> {
	for await (const row of rows) {
		const newVal = convert(row[colIndex]);
		yield newVal === row[colIndex] ? row : row.map((v, i) => i === colIndex ? newVal : v) as Row;
	}
}

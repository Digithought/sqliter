import type { Database, TableSchema, SchemaChangeInfo, Row, SqlValue, VirtualTable, UpdateResult } from '@quereus/quereus';
import { QuereusError, StatusCode, foldDefaultToType, columnDefToSchema, isConstraintViolation, inferType, validateAndParse, validateCollationForType, formatKeyValue } from '@quereus/quereus';
import type { ConnectionOverlayState, Predicate } from './isolation-types.js';
import { makeFullScanFilterInfo } from './filter-info.js';
import { makePkKeySerializer } from './overlay-rows.js';

/**
 * Carrying a connection's open staging area (its "overlay") forward across an ALTER TABLE.
 *
 * When one connection runs ALTER TABLE, the shared underlying table mutates immediately and
 * irreversibly. Every open overlay therefore has to be judged BEFORE that mutation and then
 * reshaped to match it, or else marked unusable ("poisoned") for its owning connection. This
 * module owns that whole subject; `IsolationModule.alterTable` is its only caller and stays
 * responsible for the surrounding lifecycle — which overlays are in scope, how a failure is
 * routed (issuer vs foreign), and the ALTER PRIMARY KEY overlay swap.
 *
 * The flow, in the order `alterTable` runs it:
 *
 * 1. {@link assertColumnNameNotTombstone} — reject a column name that would collide with the
 *    overlay's private deletion-marker flag, before anything mutates.
 * 2. {@link deriveAlterMigrationPlan} — precompute every per-change-type constant the later
 *    passes need, from the PRE-alter schema (so it is valid before the underlying mutates).
 * 3. {@link validateOverlayMigration} — dry-run one overlay's fallible work without mutating
 *    it. Runs for the issuer before `underlying.alterTable` (atomic abort) and per foreign
 *    overlay after it (a data rejection becomes poison, via {@link buildAlterPoisonMessage}).
 * 4. {@link planPkRekeyMarkerDrops} / {@link applyPkRekeyMarkerDrops} /
 *    {@link reinsertPkRekeyMarkers} — the primary-key re-key marker handling, which the issuer
 *    path also needs BEFORE the underlying mutates so the overlay's own `alterSchema` can be
 *    pre-flighted against the exact state the migrate step will see.
 * 5. {@link migrateOverlayForward} — reshape one overlay to the post-alter schema, in place.
 */

/**
 * What the ALTER-migration helpers need back from the module that owns the overlays.
 * `IsolationModule` satisfies it structurally; nothing here reaches for more of the class
 * than these three members.
 */
export interface AlterMigrationHost {
	/** Name of the extra column every overlay carries as its deletion-marker flag. */
	readonly tombstoneColumn: string;
	/** `<base predicate, rescoped to the overlay> AND <tombstone> = 0`. */
	overlayPredicate(base: Predicate | undefined, baseName: string, overlayName: string): Predicate;
	/** Case-insensitive "does `schema` declare an index named `indexName`". */
	schemaHasIndex(schema: TableSchema, indexName: string): boolean;
}

/**
 * Per-ALTER constants for backfilling a freshly added column into staged overlay
 * rows. Precomputed once per `addColumn` (see `deriveAddColumnBackfill`) so the
 * per-row loop only branches on tombstone / evaluator / literal.
 */
export interface AddColumnBackfillContext {
	/** The folded literal DEFAULT, or `null` when there is no usable literal default. */
	foldedDefault: SqlValue;
	/** Per-row evaluator for a non-foldable `new.<col>` default; absent for a literal default. */
	evaluator?: (row: Row) => SqlValue | Promise<SqlValue>;
	/** Whether the new column is NOT NULL (enforced on both the evaluator and folded-default paths). */
	newColNotNull: boolean;
	/** New column name, for the NOT NULL error message. */
	newColName: string;
	/** Owning table name, for the NOT NULL error message. */
	tableName: string;
}

/**
 * Per-ALTER constants for an `alter column … set not null` overlay backfill (see
 * `deriveSetNotNullBackfill`). Precomputed once so the per-row validate/backfill loops only
 * branch on tombstone / has-default. Present only for a NOT NULL *tightening* (`setNotNull: true`)
 * with staged overlays to carry forward.
 *
 * `alter column … set data type` rides the same derive → validate seam via
 * {@link SetDataTypeConvertContext}. The two are mutually exclusive: the runtime rejects a
 * multi-attribute `alter column` before it reaches this module.
 */
export interface SetNotNullBackfillContext {
	/** Zero-based index of the now-NOT-NULL column in the overlay's data columns. */
	colIndex: number;
	/** The folded literal DEFAULT used to backfill staged NULLs; meaningful only when `hasDefault`. */
	foldedDefault: SqlValue;
	/** Whether a usable literal DEFAULT exists — backfill when true, reject the staged NULL when false. */
	hasDefault: boolean;
	/** Column name, for the CONSTRAINT message. */
	colName: string;
}

/**
 * Per-ALTER constants for an `alter column … set data type` overlay pre-validation (see
 * {@link deriveSetDataTypeConvert}). Present only when the retype actually rewrites values (the
 * new physical type differs from the old) and there are staged overlays to judge — a
 * metadata-only retype leaves every staged value as it stands.
 *
 * The conversion itself is done by the overlay module when the retype is forwarded through its
 * `alterSchema` ({@link forwardAlterColumnToOverlay}); this context exists so
 * {@link validateOverlayMigration} can prove every staged value convertible FIRST — atomically
 * for the issuer, and as the poison-vs-forward gate for a foreign overlay.
 */
export interface SetDataTypeConvertContext {
	/** Zero-based index of the retyped column in the overlay's data columns. */
	colIndex: number;
	/** Per-value conversion; throws MISMATCH exactly as the underlying's does. */
	convert: (v: SqlValue) => SqlValue;
}

/**
 * Per-ALTER constants for an `alter column … set collate` that re-keys the PRIMARY KEY (see
 * {@link derivePkRekey}). Present only when the normalized collation actually changes on a PK
 * member column and there are staged overlays to carry — a non-PK collate change, or a re-declare
 * of the column's current collation, re-keys nothing. A retype of a PK column is rejected
 * upstream, so `setCollation` is the only ALTER COLUMN attribute that re-keys.
 *
 * Under the re-keyed primary key, a staged deletion marker and a staged live row that land on
 * one key are the same logical row's before and after — not two rows — so
 * {@link validateOverlayMigration} accepts the pair and {@link dropCollapsedPkRekeyMarkers}
 * discards the marker before the re-key is forwarded to the overlay. Two live rows on one key
 * stay a real duplicate and are refused. This is the isolation-layer lift of the rule
 * `TransactionLayer.rekeyPrimaryKey` applies to its own write log one level down: a deletion
 * whose key an upsert now occupies is dropped.
 */
export interface PkRekeyContext {
	/** Overlay positions of the PRIMARY KEY columns (identical to the base's — the tombstone flag sits after them). */
	pkIndices: readonly number[];
	/** Serializes a PK tuple under the POST-change collation — two old keys that serialize alike collapse. */
	keyOf: (pk: readonly SqlValue[]) => string;
	/** User-facing table name, for the CONSTRAINT message. */
	tableName: string;
}

/**
 * One post-re-key key's staged rows, as {@link collectPkRekeyGroups} buckets them: the OLD
 * primary-key tuples of the live rows, and the whole overlay rows of the deletion markers that
 * land on that key. Old tuples, because they are what a pre-re-key overlay write addresses;
 * whole marker rows, because a drop that has to be undone must restore the row byte-for-byte
 * (see {@link reinsertPkRekeyMarkers}).
 */
interface PkRekeyGroup {
	livePks: SqlValue[][];
	markerRows: Row[];
}

/**
 * Every per-change-type constant one ALTER's overlay migration needs, derived once from the
 * PRE-alter schema and shared by the validate and migrate passes so the two cannot drift.
 *
 * At most one field is ever populated — each is gated on a different change type (or, for the
 * three `alterColumn` arms, a different attribute, and the runtime admits exactly one attribute
 * per ALTER COLUMN). Bundled into one object rather than threaded as one parameter per
 * attribute, which is what the cluster did while it lived on `IsolationModule`.
 */
export interface AlterMigrationPlan {
	addColumn?: AddColumnBackfillContext;
	setNotNull?: SetNotNullBackfillContext;
	setDataType?: SetDataTypeConvertContext;
	pkRekey?: PkRekeyContext;
}

/**
 * Rejects an ADD / RENAME COLUMN that would give a base column the same name as the
 * overlay's private tombstone flag, BEFORE `underlying.alterTable` runs.
 *
 * Every overlay carries one extra column named `AlterMigrationHost.tombstoneColumn`, so a base
 * column of that name collides with it. Forwarding the change to an open overlay makes the
 * overlay module raise a duplicate-name `ERROR`, which is not a data condition and so
 * rethrows out of `IsolationModule.applyInPlaceOverlayChange` — after the underlying has already
 * (irreversibly) applied. The catalog then keeps the pre-alter column set while the base
 * holds the new one, and the next write to the table lands values against the wrong
 * columns. Rejecting up front keeps the atomic-abort guarantee `IsolationModule.alterTable`
 * documents.
 *
 * NOTE: the check is unconditional — not gated on an overlay existing — so the answer
 * does not depend on whether some connection happens to have a transaction open. That
 * also stops a table from acquiring the colliding name while idle and hitting
 * `IsolationModule.createOverlaySchema`'s (silent) duplicate at the next BEGIN. A CREATE TABLE
 * declaring the name still gets that duplicate — tracked separately.
 */
export function assertColumnNameNotTombstone(
	host: AlterMigrationHost,
	schemaName: string,
	tableName: string,
	change: SchemaChangeInfo,
): void {
	const newName = change.type === 'addColumn' ? change.columnDef.name
		: change.type === 'renameColumn' ? change.newName
		: undefined;
	if (newName?.toLowerCase() !== host.tombstoneColumn.toLowerCase()) return;
	throw new QuereusError(
		`Cannot name a column of '${schemaName}.${tableName}' '${newName}': the transaction-isolation layer reserves that name for its per-connection overlay's deletion marker.`,
		StatusCode.UNSUPPORTED,
	);
}

/**
 * Builds the poison message stamped onto a foreign overlay whose backfill could not
 * satisfy a cross-connection ALTER (see `IsolationModule.alterTable` tier 3). Names the
 * schema.table and the offending column so the owning connection's eventual
 * read/write/commit error is self-explanatory. Poison arises on the addColumn NOT NULL
 * path (a new NOT-NULL column with no usable default), the `set not null` tightening
 * path (a staged NULL with no usable default), the `set data type` path (a staged value
 * that cannot be converted to the new type), and the primary-key `set collate` path (two
 * staged live rows colliding under the new collation); other change types never reach
 * here but are handled defensively.
 */
export function buildAlterPoisonMessage(schemaName: string, tableName: string, change: SchemaChangeInfo): string {
	if (change.type === 'addColumn') {
		return `ALTER on '${schemaName}.${tableName}' added column '${change.columnDef.name}' (NOT NULL) that this connection's uncommitted row cannot satisfy; roll back this transaction.`;
	}
	if (change.type === 'alterColumn') {
		if (change.setDataType !== undefined) {
			return `ALTER on '${schemaName}.${tableName}' changed the data type of column '${change.columnName}' to ${change.setDataType}, which this connection's uncommitted row cannot be converted to; roll back this transaction.`;
		}
		if (change.setCollation !== undefined) {
			return `ALTER on '${schemaName}.${tableName}' changed the collation of primary-key column '${change.columnName}', under which this connection's uncommitted rows collide; roll back this transaction.`;
		}
		return `ALTER on '${schemaName}.${tableName}' tightened column '${change.columnName}' to NOT NULL, which this connection's uncommitted row violates; roll back this transaction.`;
	}
	if (change.type === 'alterPrimaryKey') {
		return `ALTER on '${schemaName}.${tableName}' changed the table's primary key, which this connection's uncommitted rows cannot follow; roll back this transaction.`;
	}
	return `ALTER on '${schemaName}.${tableName}' cannot migrate this connection's uncommitted rows; roll back this transaction.`;
}

/**
 * Precomputes every per-change-type constant this ALTER's overlay migration needs, from the
 * PRE-alter schema — so the whole plan is valid BEFORE the irreversible `underlying.alterTable`
 * and the same plan drives the migration after it.
 *
 * `toMigrate` is the overlays that will actually be carried forward (issuer-own first). The
 * attribute contexts are probed from `toMigrate[0]`'s schema, never from a skipped poisoned
 * overlay whose schema may be a stale pre-alter layout; with no overlays to migrate there is
 * nothing to backfill, convert or re-key, so those arms stay undefined.
 */
export function deriveAlterMigrationPlan(
	change: SchemaChangeInfo,
	db: Database,
	tableName: string,
	toMigrate: readonly [string, ConnectionOverlayState][],
): AlterMigrationPlan {
	return {
		addColumn: deriveAddColumnBackfill(change, db, tableName),
		setNotNull: deriveSetNotNullBackfill(change, toMigrate),
		setDataType: deriveSetDataTypeConvert(change, toMigrate),
		pkRekey: derivePkRekey(change, db, tableName, toMigrate),
	};
}

/**
 * The PRE-alter overlay schema every to-be-migrated overlay shares, or undefined when there is
 * nothing to migrate (or the probe overlay has no queryable schema) and so no context to derive.
 */
function probeOverlaySchema(toMigrate: readonly [string, ConnectionOverlayState][]): TableSchema | undefined {
	if (toMigrate.length === 0) return undefined;
	return toMigrate[0][1].overlayTable.tableSchema;
}

/**
 * Precomputes the per-ALTER constants an `addColumn` overlay backfill needs:
 * the folded literal DEFAULT (the `foldDefaultToType` of the DEFAULT expr — folded and
 * converted to the new column's declared type — or `null` when there is no DEFAULT or it
 * folds to NULL), the engine-supplied per-row
 * evaluator (present only for a non-foldable `new.<col>` default), and whether
 * the new column is NOT NULL. Returns undefined for every non-`addColumn` change
 * so the row loop appends nothing.
 *
 * The new column's nullability is resolved exactly as both underlyings resolve it
 * (`columnDefToSchema(columnDef, default_column_nullability === 'not_null')`) so the
 * pre-validation cannot drift from what the underlying will enforce. Because it is
 * derived purely from `change` + the session option — not the post-alter schema,
 * which does not exist until `underlying.alterTable` runs — this can be built
 * BEFORE the irreversible underlying mutation and reused by the migration after.
 */
function deriveAddColumnBackfill(
	change: SchemaChangeInfo,
	db: Database,
	tableName: string,
): AddColumnBackfillContext | undefined {
	if (change.type !== 'addColumn') return undefined;
	const defaultExpr = change.columnDef.constraints?.find(c => c.type === 'default')?.expr;
	const defaultNotNull = db.options.getStringOption('default_column_nullability') === 'not_null';
	// Thread the session `default_collation` for symmetry with the underlying memory/store
	// ADD COLUMN sites. This site only reads `.notNull`/`.name` off the result (the
	// underlying materializes the real column), so it does not affect collation here — but
	// keeping the call signature identical avoids drift and is correct for any future reader.
	const newColumn = columnDefToSchema(change.columnDef, defaultNotNull, db.options.getStringOption('default_collation'), (n) => db.isCollationRegistered(n));
	// foldDefaultToType returns undefined for a non-foldable expr and null for one that
	// folds to NULL; collapse both to null (the no-usable-literal default). It also converts
	// the literal to the new column's declared type — the staged overlay row writes with
	// `preCoerced: true`, so it can never pick that conversion up implicitly, and without it
	// an overlay row would hold the raw literal where the committed store holds the converted
	// one. An unconvertible literal throws MISMATCH here, before the underlying is mutated.
	const foldedDefault: SqlValue = foldDefaultToType(defaultExpr, newColumn.logicalType, newColumn.name) ?? null;
	return {
		foldedDefault,
		evaluator: change.backfillEvaluator,
		newColNotNull: newColumn.notNull,
		newColName: newColumn.name,
		tableName,
	};
}

/**
 * Precomputes the per-ALTER constants an `alter column … set not null` overlay migration needs:
 * the now-NOT-NULL column's index and the folded literal DEFAULT (with `hasDefault` gating
 * backfill vs reject). Returns undefined unless this is a NOT NULL *tightening*
 * (`setNotNull: true`) with at least one overlay to migrate — a DROP NOT NULL loosens and
 * needs no staged-row work, and with no overlays there is nothing to backfill or reject.
 *
 * `change` for `set not null` carries no default expression, so the DEFAULT is read from the
 * column's PRE-alter schema (via a to-be-migrated overlay — the same layout every migrated overlay
 * shares). Folded exactly as
 * {@link deriveAddColumnBackfill} folds its DEFAULT, so backfill and reject decisions here
 * cannot drift from what the underlying enforces over its committed rows.
 */
function deriveSetNotNullBackfill(
	change: SchemaChangeInfo,
	toMigrate: readonly [string, ConnectionOverlayState][],
): SetNotNullBackfillContext | undefined {
	if (change.type !== 'alterColumn' || change.setNotNull !== true) return undefined;
	const overlaySchema = probeOverlaySchema(toMigrate);
	if (!overlaySchema) return undefined;
	const colIndex = overlaySchema.columnIndexMap.get(change.columnName.toLowerCase());
	if (colIndex === undefined) return undefined;
	const oldCol = overlaySchema.columns[colIndex];
	if (!oldCol) return undefined;
	// foldDefaultToType returns undefined for a non-foldable expr and null for one that folds
	// to NULL; both mean "no usable literal default" — the staged NULL must reject, not
	// backfill. It also converts the literal to the column's declared type, so a backfilled
	// staged row and a backfilled committed row hold the same value (the overlay writes with
	// `preCoerced: true` and cannot pick the conversion up implicitly). An unconvertible
	// literal throws MISMATCH here, before the underlying is mutated — the same point both
	// underlyings fold at.
	const folded = foldDefaultToType(oldCol.defaultValue, oldCol.logicalType, change.columnName);
	const hasDefault = folded !== undefined && folded !== null;
	return {
		colIndex,
		foldedDefault: hasDefault ? folded : null,
		hasDefault,
		colName: change.columnName,
	};
}

/**
 * Precomputes the per-ALTER constants an `alter column … set data type` overlay conversion
 * needs: the retyped column's index and a per-value `convert`. Returns undefined unless this
 * is a retype with at least one overlay to convert, and undefined for an ALIAS retype (the
 * new logical type IS the old type object — `inferType` flattens `varchar(50)` to
 * `TEXT_TYPE`) — both underlyings gate their value rewrite on that exact identity
 * comparison, so mirroring it here keeps overlay and committed rows moving together should
 * "what counts as a value-rewriting retype" ever change. A same-storage-class retype between
 * different types (text → date) DOES convert: staged values are validated and normalized to
 * the new type's canonical spelling, exactly as the underlyings treat their committed rows.
 *
 * `inferType` never throws (an unknown type name falls through SQLite-style affinity rules),
 * so deriving this BEFORE the underlying mutation is safe. `convert` is the literal mirror of
 * `MemoryTableManager.alterColumn` / `StoreModule.alterColumnSetDataType`: `validateAndParse`,
 * rethrowing failure as the same MISMATCH message, so the two legs cannot drift.
 */
function deriveSetDataTypeConvert(
	change: SchemaChangeInfo,
	toMigrate: readonly [string, ConnectionOverlayState][],
): SetDataTypeConvertContext | undefined {
	if (change.type !== 'alterColumn' || change.setDataType === undefined) return undefined;
	const overlaySchema = probeOverlaySchema(toMigrate);
	if (!overlaySchema) return undefined;
	const colIndex = overlaySchema.columnIndexMap.get(change.columnName.toLowerCase());
	if (colIndex === undefined) return undefined;
	const oldCol = overlaySchema.columns[colIndex];
	if (!oldCol) return undefined;
	const newLogicalType = inferType(change.setDataType);
	// Alias retype (same logical type object): the underlying rewrites nothing, so neither do we.
	if (newLogicalType === oldCol.logicalType) return undefined;
	const setDataType = change.setDataType;
	const columnName = change.columnName;
	return {
		colIndex,
		convert: (v: SqlValue): SqlValue => {
			try {
				return validateAndParse(v, newLogicalType, columnName) as SqlValue;
			} catch {
				throw new QuereusError(
					`Cannot convert value in '${columnName}' to ${setDataType}`,
					StatusCode.MISMATCH,
				);
			}
		},
	};
}

/**
 * Precomputes the per-ALTER constants a primary-key re-keying `alter column … set collate`
 * overlay migration needs: the PK column positions and a key serializer built over the
 * POST-change collation — the PRE-alter overlay schema with the named column's collation
 * replaced. The overlay's PK definition mirrors the base's (the tombstone flag is appended
 * after the data columns), so the synthesized schema keys exactly as the re-keyed base will.
 *
 * Returns undefined unless the named column is a PRIMARY KEY member and the normalized
 * collation actually differs from the column's current one — mirroring the underlying's
 * metadata-only gate (`MemoryTableManager.alterColumn`'s `nameMatches`), so overlay and
 * committed rows re-key together or not at all. `validateCollationForType` can throw for an
 * unknown collation, but the engine already validated the name before dispatching the ALTER,
 * and a direct module caller gets the same pre-mutation rejection the underlying would give.
 */
function derivePkRekey(
	change: SchemaChangeInfo,
	db: Database,
	tableName: string,
	toMigrate: readonly [string, ConnectionOverlayState][],
): PkRekeyContext | undefined {
	if (change.type !== 'alterColumn' || change.setCollation === undefined) return undefined;
	const overlaySchema = probeOverlaySchema(toMigrate);
	if (!overlaySchema) return undefined;
	const colIndex = overlaySchema.columnIndexMap.get(change.columnName.toLowerCase());
	if (colIndex === undefined) return undefined;
	if (!overlaySchema.primaryKeyDefinition.some(def => def.index === colIndex)) return undefined;
	const oldCol = overlaySchema.columns[colIndex];
	if (!oldCol) return undefined;
	const normalized = validateCollationForType(change.setCollation, oldCol.logicalType, change.columnName, (n) => db.isCollationRegistered(n));
	if (normalized === (oldCol.collation || 'BINARY')) return undefined; // metadata-only — the underlying re-keys nothing
	const postChangeSchema: TableSchema = {
		...overlaySchema,
		columns: overlaySchema.columns.map((c, i) => (i === colIndex ? { ...c, collation: normalized } : c)),
	};
	return {
		pkIndices: overlaySchema.primaryKeyDefinition.map(def => def.index),
		keyOf: makePkKeySerializer(db, postChangeSchema),
		tableName,
	};
}

/**
 * Buckets an overlay's staged rows by their PRIMARY KEY as the pending `set collate` will
 * re-key it: one {@link PkRekeyGroup} per post-change key. Shared by the validation dry run
 * (which refuses a group holding two live rows) and the migrate-step marker drop (which
 * discards collapsed markers), so the two passes cannot disagree about what collapses.
 *
 * NOTE: materializes one serialized key + one PK tuple per staged row (plus the marker rows
 * themselves), once per pass of one ALTER. If an overlay with very many staged rows ever
 * makes this ALTER slow, group lazily or reuse the merge `IsolationModule.effectiveRowsFor`
 * already builds.
 */
async function collectPkRekeyGroups(
	overlay: VirtualTable,
	tombstoneIdx: number,
	ctx: PkRekeyContext,
): Promise<Map<string, PkRekeyGroup>> {
	const groups = new Map<string, PkRekeyGroup>();
	for await (const row of overlay.query!(makeFullScanFilterInfo())) {
		const pk = ctx.pkIndices.map(i => row[i] as SqlValue);
		const key = ctx.keyOf(pk);
		let group = groups.get(key);
		if (!group) {
			group = { livePks: [], markerRows: [] };
			groups.set(key, group);
		}
		if (row[tombstoneIdx] === 1) group.markerRows.push(row);
		else group.livePks.push(pk);
	}
	return groups;
}

/**
 * Dry-runs an overlay's ALTER migration-fallible work without mutating anything,
 * so the caller can run it for every affected overlay BEFORE the irreversible
 * `underlying.alterTable` (see `IsolationModule.alterTable`). It exercises the EXACT code
 * paths the real migration uses — the tombstone-present guard and, for addColumn,
 * `computeAddColumnValue` per staged row — so a dry-run pass and the subsequent
 * migrate pass cannot diverge:
 *
 * - A clean overlay (`!hasChanges`) stages no rows, so there is nothing to validate.
 * - A missing tombstone column throws INTERNAL here, before the underlying is touched.
 * - For addColumn, each staged row runs through {@link computeAddColumnValue}, which owns
 *   both NOT NULL reject sources and short-circuits tombstone rows; a violation throws
 *   CONSTRAINT here, atomically. Computed values are discarded.
 *
 * For `set not null` with NO usable DEFAULT (`plan.setNotNull.hasDefault === false`), a staged
 * non-tombstone NULL at the now-NOT-NULL column throws CONSTRAINT here — for the issuer this
 * aborts atomically before the underlying mutates; for a foreign overlay the caller maps it to
 * poison. With a usable DEFAULT the staged NULLs are backfilled by
 * {@link backfillStagedNotNull}, so nothing is rejected here.
 *
 * For `set data type` (`plan.setDataType`), every staged non-NULL value is run through the
 * conversion and the result discarded, so an unconvertible one throws MISMATCH here. For the
 * ISSUER this is belt-and-braces — the underlying's own pre-mutation pass walks the same rows
 * via `IsolationModule.issuerEffectiveRows` — EXCEPT when an outer wrapper supplied `rows`, in
 * which case this is the only check. For a FOREIGN overlay it is the only pass that ever sees
 * those rows, and it must run before the migration so a failure becomes poison rather than a
 * half-migrated overlay.
 *
 * For a primary-key re-keying `set collate` (`plan.pkRekey`), the staged rows are grouped by
 * their POST-change key: a deletion marker sharing a key with one live row is that row's
 * before-image (the migrate step discards it — {@link dropCollapsedPkRekeyMarkers}), and
 * markers alone on one key are one deletion — neither is a duplicate. Two LIVE rows on one
 * key ARE, so that throws CONSTRAINT here, mirroring the underlying's own collision message.
 * For the ISSUER this is belt-and-braces (the underlying's pre-mutation pass judges the same
 * staged rows via `IsolationModule.issuerEffectiveRows`, though this check fires first); for a
 * FOREIGN overlay it is the only pass that sees those rows, and its throw becomes poison.
 *
 * Non-addColumn / non-tightening / non-retype / non-re-key changes (an empty `plan`) only run
 * the tombstone guard; their row translation appends/removes nothing fallible on data grounds.
 */
export async function validateOverlayMigration(
	host: AlterMigrationHost,
	oldState: ConnectionOverlayState,
	plan: AlterMigrationPlan,
): Promise<void> {
	const oldOverlay = oldState.overlayTable;
	const oldOverlaySchema = oldOverlay.tableSchema;
	// Mirror the migrate-loop guard exactly: a clean overlay or one without a queryable
	// schema stages nothing and runs none of the fallible checks.
	if (!(oldState.hasChanges && oldOverlaySchema && oldOverlay.query)) return;

	const oldTombstoneIdx = requireTombstoneIndex(host, oldOverlaySchema);

	if (plan.addColumn) {
		// NOTE: full-scans every staged row even when nothing can fail (a nullable column with no
		// evaluator rejects nothing) and even when the reject is row-independent (a mandatory
		// column with no DEFAULT rejects on the first live row). If overlays ever get large, gate
		// the scan on `newColNotNull` and stop at the first live row on the no-evaluator path.
		for await (const oldRow of oldOverlay.query(makeFullScanFilterInfo())) {
			// Discard the result — this is validation only. A NOT NULL violation throws here.
			await computeAddColumnValue(plan.addColumn, oldRow, oldTombstoneIdx);
		}
		return;
	}

	// SET NOT NULL with no usable DEFAULT: reject a staged NULL the forward could not fill.
	// (With a DEFAULT there is nothing to reject — backfillStagedNotNull fills instead.)
	if (plan.setNotNull && !plan.setNotNull.hasDefault) {
		const setNotNullCtx = plan.setNotNull;
		for await (const oldRow of stagedLiveRows(oldOverlay, oldTombstoneIdx)) {
			if (oldRow[setNotNullCtx.colIndex] === null) {
				throw new QuereusError(
					`column ${setNotNullCtx.colName} contains NULL values`,
					StatusCode.CONSTRAINT,
				);
			}
		}
		return;
	}

	// SET DATA TYPE: prove every staged value convertible before anything is rewritten. NULLs
	// are left untouched by the conversion (the underlying's `convertNulls` is false for a retype).
	if (plan.setDataType) {
		const setDataTypeCtx = plan.setDataType;
		for await (const oldRow of stagedLiveRows(oldOverlay, oldTombstoneIdx)) {
			const value = oldRow[setDataTypeCtx.colIndex];
			if (value !== null) setDataTypeCtx.convert(value as SqlValue); // discard — validation only
		}
		return;
	}

	// SET COLLATE re-keying the PRIMARY KEY: two staged LIVE rows landing on one post-change
	// key are a real duplicate — refuse before the underlying re-keys (atomic for the issuer,
	// poison for a foreign overlay via the caller). Marker/live and marker/marker groups
	// collapse cleanly and are handled by the migrate step, not rejected here.
	if (plan.pkRekey) {
		const pkRekeyCtx = plan.pkRekey;
		for (const group of (await collectPkRekeyGroups(oldOverlay, oldTombstoneIdx, pkRekeyCtx)).values()) {
			if (group.livePks.length < 2) continue;
			const keyDesc = group.livePks[1].map(formatKeyValue).join(', ');
			throw new QuereusError(
				`UNIQUE constraint failed: ${pkRekeyCtx.tableName} primary key collides under new collation (key: ${keyDesc})`,
				StatusCode.CONSTRAINT,
			);
		}
	}
}

/**
 * The staged rows an overlay holds that represent LIVE data, i.e. every row except the
 * tombstones — those carry placeholder NULLs at every data column and must never be fed to a
 * per-value check, which would read a NULL that is not the row's real value.
 */
async function *stagedLiveRows(overlay: VirtualTable, tombstoneIdx: number): AsyncIterable<Row> {
	for await (const row of overlay.query!(makeFullScanFilterInfo())) {
		if (row[tombstoneIdx] !== 1) yield row;
	}
}

/**
 * Computes one staged row's value for a freshly added column, mirroring the
 * committed-row backfill (see `base.ts` `recreatePrimaryTreeWithNewColumn` and
 * `store-table.ts` `migrateRows`):
 *
 * - Tombstone rows carry NULL placeholders and their appended value is never read,
 *   so append `null` and never run the evaluator against them (it could reference
 *   NULL siblings or spuriously trip the NOT NULL check).
 * - With a per-row evaluator, derive the value from the existing-columns slice and
 *   enforce NOT NULL on that path.
 * - Otherwise use the folded literal default, enforcing NOT NULL on it too: the engine's own
 *   pre-mutation probe (`validateNotNullBackfill`) only sees the ISSUING connection's rows
 *   (committed + its own staged rows), never a foreign connection's, so a mandatory column
 *   with no usable DEFAULT must be re-checked here for every staged row this pass reaches.
 */
async function computeAddColumnValue(
	ctx: AddColumnBackfillContext,
	oldRow: Row,
	oldTombstoneIdx: number,
): Promise<SqlValue> {
	if (oldRow[oldTombstoneIdx] === 1) return null;
	if (ctx.evaluator) {
		const data = Array.from(oldRow.slice(0, oldTombstoneIdx)) as SqlValue[];
		const value = await ctx.evaluator(data);
		if (ctx.newColNotNull && value === null) {
			throw new QuereusError(
				`NOT NULL constraint failed: backfilling column '${ctx.tableName}.${ctx.newColName}' produced NULL for a staged row`,
				StatusCode.CONSTRAINT,
			);
		}
		return value;
	}
	if (ctx.newColNotNull && ctx.foldedDefault === null) {
		throw new QuereusError(
			`NOT NULL constraint failed: column '${ctx.tableName}.${ctx.newColName}' has no usable DEFAULT for a staged row`,
			StatusCode.CONSTRAINT,
		);
	}
	return ctx.foldedDefault;
}

/**
 * Carries ONE already-open overlay to the post-alter schema, IN PLACE — through the overlay's
 * own `alterSchema` / `createIndex` / ordinary writes — so the overlay's layer chain and
 * savepoint snapshots survive the ALTER and `rollback to savepoint` keeps distinguishing rows
 * staged before the savepoint from rows staged after it (see
 * `IsolationModule.applyIndexChangeToOverlays` for why the old rebuild — copying staged rows
 * into a fresh staging table — destroyed that distinction). Per change type:
 *
 * - ADD / DROP / RENAME COLUMN: {@link forwardColumnShapeToOverlay}.
 * - ALTER COLUMN: {@link forwardAlterColumnToOverlay}.
 * - ADD CONSTRAINT: {@link forwardAddConstraintToOverlay}.
 * - DROP / RENAME CONSTRAINT: {@link forwardConstraintNameChangeToOverlay}.
 *
 * ALTER PRIMARY KEY is excluded from the parameter type: no overlay can follow it in place, so
 * `IsolationModule.replaceOverlayForPrimaryKeyChange` handles that arm instead.
 *
 * The caller wraps this in `IsolationModule.applyInPlaceOverlayChange`, which routes a
 * CONSTRAINT/BUSY failure by who owns the overlay (issuer → INTERNAL drift error; foreign →
 * poison) and rethrows everything else.
 */
export async function migrateOverlayForward(
	host: AlterMigrationHost,
	overlayState: ConnectionOverlayState,
	change: Exclude<SchemaChangeInfo, { type: 'alterPrimaryKey' }>,
	plan: AlterMigrationPlan,
	updatedSchema: TableSchema,
): Promise<void> {
	switch (change.type) {
		case 'addColumn':
		case 'dropColumn':
		case 'renameColumn':
			await forwardColumnShapeToOverlay(host, overlayState, change, plan.addColumn);
			return;
		case 'alterColumn':
			await forwardAlterColumnToOverlay(host, overlayState, change, plan.setNotNull, plan.pkRekey);
			return;
		case 'addConstraint':
			await forwardAddConstraintToOverlay(host, overlayState, change, updatedSchema);
			return;
		case 'dropConstraint':
		case 'renameConstraint':
			await forwardConstraintNameChangeToOverlay(overlayState, change);
			return;
		default: {
			const _exhaustive: never = change;
			return _exhaustive;
		}
	}
}

/**
 * Forwards one column-shape change (ADD / DROP / RENAME COLUMN) to an already-open
 * overlay IN PLACE via the overlay's optional `alterSchema`. The overlay module (the
 * memory module by default) reshapes its open transaction layers with their savepoint
 * snapshots intact, so `rollback to savepoint` keeps distinguishing rows staged before
 * the savepoint from rows staged after it — the rebuild path destroyed that
 * distinction in both directions (see `IsolationModule.applyIndexChangeToOverlays`).
 *
 * A missing `alterSchema` is treated as a no-op, the way the index paths treat a
 * missing `createIndex` / `dropIndex`.
 *
 * `dropColumn` / `renameColumn` forward the caller's change unchanged. `addColumn`
 * forwards an overlay-flavoured copy — see {@link buildOverlayAddColumnChange}.
 */
async function forwardColumnShapeToOverlay(
	host: AlterMigrationHost,
	overlayState: ConnectionOverlayState,
	change: SchemaChangeInfo,
	addColumnCtx: AddColumnBackfillContext | undefined,
): Promise<void> {
	const overlayTable = overlayState.overlayTable;
	if (!overlayTable.alterSchema) return;
	// `deriveAddColumnBackfill` returns a context for every addColumn, so the assertion
	// cannot fire when the change type matches.
	const overlayChange = change.type === 'addColumn'
		? buildOverlayAddColumnChange(host, change, addColumnCtx!, overlayTable)
		: change;
	await overlayTable.alterSchema(overlayChange);
}

/**
 * The overlay-flavoured form of one `addColumn` change:
 *
 * - `insertAtIndex` = the overlay's current tombstone column index, so the new data
 *   column lands ahead of the tombstone flag and the flag stays LAST — the layout
 *   every read/write path of this package assumes. A bare forward would append after
 *   the flag and every value written to the new column would be dropped on read.
 *   A caller that named its own position keeps it: the overlay's data columns mirror
 *   the base's one-for-one below the flag, so the base's index is the overlay's too.
 *   (SQL always appends, so today the caller never names one — but silently ignoring
 *   it would diverge the two layouts.)
 * - The column definition is made NULLABLE. The overlay's ADD re-runs the overlay
 *   module's own NOT NULL validation against a different row population than the
 *   base's: tombstone rows carry placeholder NULL in every non-PK column, so a
 *   NOT NULL column the base already accepted would be rejected here. The base's
 *   NOT NULL is still enforced where it belongs — by the engine's pre-mutation
 *   `validateNotNullBackfill` and the underlying's own ADD (both judged the issuer's
 *   effective rows), and per staged row by {@link computeAddColumnValue}'s
 *   evaluator-path check.
 * - `backfillEvaluator` receives an OVERLAY row (data columns plus the flag) and
 *   routes through {@link computeAddColumnValue} — the same helper
 *   {@link validateOverlayMigration} dry-runs, so validation and forward cannot
 *   drift: NULL for a tombstone row, else the engine's per-row `new.<col>` evaluator
 *   over the flag-stripped row, or the folded literal default.
 */
function buildOverlayAddColumnChange(
	host: AlterMigrationHost,
	change: Extract<SchemaChangeInfo, { type: 'addColumn' }>,
	addColumnCtx: AddColumnBackfillContext,
	overlayTable: VirtualTable,
): SchemaChangeInfo {
	const tombstoneIdx = requireTombstoneIndex(host, overlayTable.tableSchema);
	const constraints = (change.columnDef.constraints ?? []).filter(c => c.type !== 'notNull');
	if (!constraints.some(c => c.type === 'null')) constraints.push({ type: 'null' });
	return {
		...change,
		columnDef: { ...change.columnDef, constraints },
		insertAtIndex: change.insertAtIndex ?? tombstoneIdx,
		backfillEvaluator: (overlayRow: Row) => computeAddColumnValue(addColumnCtx, overlayRow, tombstoneIdx),
	};
}

/**
 * Forwards one ALTER COLUMN attribute change to an already-open overlay IN PLACE, with the
 * NOT NULL attribute deliberately withheld.
 *
 * `set data type` / `set collate` / `set default` forward through the overlay's own
 * `alterSchema`: the overlay module converts / re-keys its open transaction layers with
 * their savepoint snapshots intact, and NULLs pass a retype untouched, so tombstone rows —
 * placeholder NULLs at every non-key data column — ride through unharmed. One preparation
 * step precedes a PRIMARY-KEY re-keying `set collate` (`pkRekeyCtx`): deletion markers the
 * re-key collapses onto another staged row are discarded first
 * ({@link dropCollapsedPkRekeyMarkers}) — the overlay's PK deliberately covers markers, so
 * without the drop its own `alterSchema` would reject the collapsed pair as a PK collision.
 *
 * Neither NOT NULL direction forwards, and the overlay's `notNull` flag is left where it
 * stood when the overlay was created:
 *
 * - **Tightening (`set not null`).** Forwarding would have the overlay module tighten a
 *   column whose tombstone rows carry NULL at every non-PK data column, so it would either
 *   backfill a deletion marker's placeholder NULL from the DEFAULT (corrupting a row that
 *   is not a row) or reject it outright when no usable DEFAULT exists. The base's NOT NULL
 *   is enforced where it belongs — by the underlying over the issuer's effective rows, and
 *   per overlay by {@link validateOverlayMigration} — and the staged LIVE rows' NULLs are
 *   filled here via {@link backfillStagedNotNull}.
 * - **Relaxing (`drop not null`).** Nothing to do: the overlay never enforced the flag, and
 *   the rows it stages are written with `preCoerced: true` through the overlay module's own
 *   write path, which does not consult column nullability at all.
 *
 * NOTE: both directions therefore leave the overlay's `notNull` flag drifted from the base
 * for the rest of the transaction. Inert today — nothing on the overlay path reads it. The
 * one consumer that would, `MemoryTableModule.getBestAccessPlan` (which prunes `IS NULL` on
 * a NOT NULL column to an empty result), is unreachable because the isolation layer builds
 * the overlay's `FilterInfo` itself (see `filter-info.ts`) instead of planning against the
 * overlay module. If overlay scans ever route through the overlay module's planner hook, or
 * its write path starts enforcing nullability, this has to become a real forward that
 * excludes tombstones.
 *
 * The runtime admits exactly one attribute per ALTER COLUMN, so a `setNotNull` change
 * carries nothing else to forward. A missing overlay `alterSchema` is a no-op, as in
 * {@link forwardColumnShapeToOverlay}.
 */
async function forwardAlterColumnToOverlay(
	host: AlterMigrationHost,
	overlayState: ConnectionOverlayState,
	change: Extract<SchemaChangeInfo, { type: 'alterColumn' }>,
	setNotNullCtx: SetNotNullBackfillContext | undefined,
	pkRekeyCtx: PkRekeyContext | undefined,
): Promise<void> {
	if (change.setNotNull !== undefined) {
		if (change.setNotNull === true && setNotNullCtx?.hasDefault) {
			await backfillStagedNotNull(host, overlayState, setNotNullCtx);
		}
		return;
	}
	if (!overlayState.overlayTable.alterSchema) return;
	if (pkRekeyCtx) await dropCollapsedPkRekeyMarkers(host, overlayState, pkRekeyCtx);
	await overlayState.overlayTable.alterSchema(change);
}

/**
 * Discards the deletion markers a pending PRIMARY-KEY re-key collapses onto another staged
 * row, through the overlay's ordinary write path so its layer chain and savepoint snapshots
 * stay intact. Two shapes collapse (see {@link PkRekeyContext}): a marker sharing its
 * post-change key with a live row is that row's before-image — the live row's flush upsert
 * is the complete net effect, so the marker is dropped; markers alone together on one key
 * are one deletion, so all but the first are dropped. A group holding two live rows was
 * already refused by {@link validateOverlayMigration} before the underlying mutated.
 *
 * Runs BEFORE the re-key is forwarded to the overlay, and deletes by each marker's OLD
 * primary key — the overlay is still keyed under the old collation at that moment.
 *
 * NOTE: like {@link backfillStagedNotNull}'s rewrites, the drops land in the overlay's
 * CURRENT savepoint frame. A later `rollback to savepoint` taken BEFORE this ALTER restores
 * the marker while the table stays re-keyed — the same divergence class that method's NOTE
 * documents (`bug-rolled-back-rows-violate-surviving-ddl`), not a new hole opened here.
 */
async function dropCollapsedPkRekeyMarkers(
	host: AlterMigrationHost,
	overlayState: ConnectionOverlayState,
	ctx: PkRekeyContext,
): Promise<void> {
	const plan = await planPkRekeyMarkerDrops(host, overlayState, ctx);
	await applyPkRekeyMarkerDrops(overlayState, ctx, plan);
}

/**
 * The whole overlay rows of every deletion marker {@link dropCollapsedPkRekeyMarkers} will
 * discard, computed without mutating anything. Re-planning after the drops finds nothing
 * (each group then holds at most one marker and no marker beside a live row), so the
 * issuer path — which drops in tier 2 for the pre-flight — can safely run the shared
 * migrate-step drop again as a no-op.
 */
export async function planPkRekeyMarkerDrops(
	host: AlterMigrationHost,
	overlayState: ConnectionOverlayState,
	ctx: PkRekeyContext,
): Promise<Row[]> {
	const overlay = overlayState.overlayTable;
	const overlaySchema = overlay.tableSchema;
	if (!overlaySchema || !overlay.query) return [];
	const tombstoneIdx = requireTombstoneIndex(host, overlaySchema);
	const toDrop: Row[] = [];
	for (const group of (await collectPkRekeyGroups(overlay, tombstoneIdx, ctx)).values()) {
		// NOTE: the marker-only arm (`slice(1)`) is defensive — no marker-only collapse can
		// currently SURVIVE the ALTER. Two markers share a post-change key only if the rows
		// they shadow did too, and such a pair is refused one level down: by the underlying's
		// re-key (a committed pair) or by the overlay's own (a staged-then-deleted pair). It
		// still runs, and is still undone, on the way to those refusals.
		toDrop.push(...(group.livePks.length > 0 ? group.markerRows : group.markerRows.slice(1)));
	}
	return toDrop;
}

/** Deletes each planned marker by its OLD primary key through the overlay's ordinary write path. */
export async function applyPkRekeyMarkerDrops(
	overlayState: ConnectionOverlayState,
	ctx: PkRekeyContext,
	toDrop: readonly Row[],
): Promise<void> {
	const overlay = overlayState.overlayTable;
	const overlaySchema = overlay.tableSchema;
	if (!overlaySchema || toDrop.length === 0) return;
	for (const markerRow of toDrop) {
		const pk = ctx.pkIndices.map(i => markerRow[i] as SqlValue);
		const result: UpdateResult = await overlay.update({
			operation: 'delete',
			values: undefined,
			oldKeyValues: pk,
		});
		// A bare delete of a staged marker has no data condition to hit, so a non-ok result
		// is a layer-invariant violation — raise INTERNAL (which applyInPlaceOverlayChange
		// rethrows loud for issuer and foreign alike), never poison.
		if (isConstraintViolation(result)) {
			throw new QuereusError(
				`Dropping a collapsed deletion marker (pk=[${pk.join(', ')}]) from overlay '${overlaySchema.name}' hit a ${result.constraint} constraint: ${result.message ?? 'no message'}`,
				StatusCode.INTERNAL,
			);
		}
	}
}

/**
 * Undoes {@link applyPkRekeyMarkerDrops} after a refusal that aborts the whole ALTER —
 * the overlay pre-flight's or the underlying's (see the tier-2 re-key block in
 * `IsolationModule.alterTable`). Reinserts each marker row verbatim: a marker minted for a
 * committed row carries NULL at every non-key data column, but one made by deleting a row this
 * transaction had already staged keeps that row's values (the convert-to-tombstone branch
 * of `IsolatedTable.update`), so a reconstructed-from-PK row would not restore what was
 * dropped. The reinserts land in the same savepoint frame the drops did, so the pair nets
 * to nothing.
 */
export async function reinsertPkRekeyMarkers(
	overlayState: ConnectionOverlayState,
	droppedRows: readonly Row[],
): Promise<void> {
	if (droppedRows.length === 0) return;
	const overlay = overlayState.overlayTable;
	const overlaySchema = overlay.tableSchema;
	if (!overlaySchema) return;
	for (const markerRow of droppedRows) {
		const result: UpdateResult = await overlay.update({ operation: 'insert', values: [...markerRow] as SqlValue[] });
		if (isConstraintViolation(result)) {
			throw new QuereusError(
				`Restoring a deletion marker (row=[${markerRow.join(', ')}]) to overlay '${overlaySchema.name}' after a refused ALTER hit a ${result.constraint} constraint: ${result.message ?? 'no message'}`,
				StatusCode.INTERNAL,
			);
		}
	}
}

/**
 * The overlay's tombstone-flag column index, or INTERNAL if the schema lost it — or has no
 * queryable schema at all, which is the same defect from the caller's point of view.
 */
function requireTombstoneIndex(host: AlterMigrationHost, overlaySchema: TableSchema | undefined): number {
	const tombstoneIdx = overlaySchema?.columnIndexMap.get(host.tombstoneColumn.toLowerCase());
	if (tombstoneIdx === undefined) {
		throw new QuereusError(`Tombstone column '${host.tombstoneColumn}' missing from overlay schema`, StatusCode.INTERNAL);
	}
	return tombstoneIdx;
}

/**
 * Backfills a `set not null` tightening into an overlay's staged LIVE rows: every
 * non-tombstone row holding NULL at the tightened column is rewritten with the column's
 * folded literal DEFAULT through the overlay's ordinary write path, so the overlay's layer
 * chain and savepoint snapshots stay intact — the overlay-side mirror of the value rewrite
 * the underlying applies to its committed rows. Tombstone rows are never touched
 * ({@link stagedLiveRows}).
 *
 * Only called with a usable DEFAULT ({@link SetNotNullBackfillContext.hasDefault}); the
 * no-DEFAULT case rejects (issuer) or poisons (foreign) in {@link validateOverlayMigration}
 * before any overlay is touched.
 *
 * NOTE: these rewrites land in the overlay's CURRENT savepoint frame — each is a normal
 * staged write. A later `rollback to savepoint` taken BEFORE this ALTER therefore restores
 * the pre-backfill NULL while the column stays NOT NULL (DDL is not transactional here).
 * That is the same class of divergence as any rolled-back row violating surviving DDL — a
 * row un-inserted past an ADD CONSTRAINT, say — tracked by the backlog ticket
 * `bug-rolled-back-rows-violate-surviving-ddl`, not a new hole opened by this forward.
 */
async function backfillStagedNotNull(
	host: AlterMigrationHost,
	overlayState: ConnectionOverlayState,
	ctx: SetNotNullBackfillContext,
): Promise<void> {
	const overlay = overlayState.overlayTable;
	const overlaySchema = overlay.tableSchema;
	if (!overlaySchema || !overlay.query) return;
	const tombstoneIdx = requireTombstoneIndex(host, overlaySchema);
	const pkIndices = overlaySchema.primaryKeyDefinition.map(def => def.index);
	// Materialize before writing: the rewrites mutate the overlay's pending layer the
	// scan is reading through.
	const toFill: Row[] = [];
	for await (const row of stagedLiveRows(overlay, tombstoneIdx)) {
		if (row[ctx.colIndex] === null) toFill.push(row);
	}
	for (const row of toFill) {
		const values = row.map((v, i) => (i === ctx.colIndex ? ctx.foldedDefault : v)) as SqlValue[];
		// No `onConflict`, so `UpdateResult` is exactly `ok | constraint`. A constraint here
		// (the filled value colliding under a UNIQUE) is a data condition of this overlay's
		// staged rows — thrown as CONSTRAINT for applyInPlaceOverlayChange to route to
		// INTERNAL (issuer, whose merged rows the underlying's own converted-row UNIQUE
		// re-validation already judged) or poison (foreign).
		const result: UpdateResult = await overlay.update({
			operation: 'update',
			values,
			oldKeyValues: pkIndices.map(i => row[i] as SqlValue),
			preCoerced: true,
		});
		if (isConstraintViolation(result)) {
			throw new QuereusError(
				`Backfilling column '${ctx.colName}' in overlay '${overlaySchema.name}' hit a ${result.constraint} constraint: ${result.message ?? 'no message'}`,
				StatusCode.CONSTRAINT,
			);
		}
	}
}

/**
 * Forwards one ADD CONSTRAINT to an already-open overlay, per constraint class:
 *
 * - **UNIQUE** is NOT forwarded as a constraint. The AST `TableConstraint` carries no
 *   partial-predicate field, so a bare forward would enforce uniqueness over tombstone rows
 *   too — a UNIQUE whose columns sit inside the primary key would see two deleted rows
 *   (each carrying its PK and placeholder NULLs elsewhere) as duplicates of each other.
 *   Instead it lands as a tombstone-narrowed **unique index** through the same route CREATE
 *   INDEX takes ({@link installOverlayUniqueConstraint}).
 * - **CHECK** forwards verbatim: the overlay module appends it schema-only (no row scan, no
 *   physical structure). Enforcement is engine-side at DML plan time against the user
 *   table; the overlay's copy exists so a later DROP / RENAME CONSTRAINT resolves it.
 * - **FOREIGN KEY** is deliberately NOT forwarded. FK enforcement is engine-side
 *   (planner-synthesized EXISTS checks) — the overlay never enforces it — and the overlay
 *   module's ADD arm validates existing child rows through a catalog query by table name,
 *   which the unregistered `_overlay_*` staging table cannot serve. The presence guard in
 *   {@link forwardConstraintNameChangeToOverlay} keeps a later DROP / RENAME of the
 *   unforwarded FK a clean no-op on the overlay.
 * - **PRIMARY KEY** cannot reach here — both bundled underlyings reject
 *   `add constraint … primary key` with UNSUPPORTED before any overlay work — so it asserts
 *   INTERNAL rather than leaving a silent gap for a third-party underlying that accepts it
 *   (the overlay could not follow; see the alterPrimaryKey handling in
 *   `IsolationModule.alterTable`).
 */
async function forwardAddConstraintToOverlay(
	host: AlterMigrationHost,
	overlayState: ConnectionOverlayState,
	change: Extract<SchemaChangeInfo, { type: 'addConstraint' }>,
	updatedSchema: TableSchema,
): Promise<void> {
	switch (change.constraint.type) {
		case 'unique':
			await installOverlayUniqueConstraint(host, overlayState, change.constraint, updatedSchema);
			return;
		case 'check':
			if (overlayState.overlayTable.alterSchema) await overlayState.overlayTable.alterSchema(change);
			return;
		case 'foreignKey':
			return;
		case 'primaryKey':
			throw new QuereusError(
				`Isolation layer: the underlying accepted 'add constraint … primary key' on '${updatedSchema.schemaName}.${updatedSchema.name}', which the per-connection overlays cannot follow.`,
				StatusCode.INTERNAL,
			);
	}
}

/**
 * Installs one runtime-added UNIQUE constraint on an overlay as a tombstone-narrowed unique
 * index (see {@link forwardAddConstraintToOverlay} for why a bare constraint forward is
 * wrong). Column indices and per-column collations are read from the post-alter underlying
 * schema — the canonical form, positionally identical to the overlay's data columns (the
 * tombstone flag is appended last). The index is named `constraint name ?? '_uc_<cols>'`,
 * the memory module's own covering-index naming rule (`implicitIndexNameFor`), so the
 * derived UNIQUE the overlay module synthesizes from it resolves under the SAME name a
 * later DROP / RENAME CONSTRAINT forward carries.
 *
 * `MemoryTableManager.createIndex` pre-validates the overlay's effective rows against the
 * narrowed predicate before any mutation, so a staged duplicate raises CONSTRAINT with the
 * overlay untouched — routed by the caller to INTERNAL (the issuer, whose merged rows the
 * underlying already judged via `IsolationModule.issuerEffectiveRows`) or poison (a foreign
 * overlay). A missing overlay `createIndex` is a no-op, as in the index paths.
 */
async function installOverlayUniqueConstraint(
	host: AlterMigrationHost,
	overlayState: ConnectionOverlayState,
	constraint: Extract<SchemaChangeInfo, { type: 'addConstraint' }>['constraint'],
	updatedSchema: TableSchema,
): Promise<void> {
	const overlayTable = overlayState.overlayTable;
	const overlaySchema = overlayTable.tableSchema;
	if (!overlayTable.createIndex || !overlaySchema) return;
	const columns = (constraint.columns ?? []).map(col => {
		const idx = updatedSchema.columnIndexMap.get(col.name.toLowerCase());
		if (idx === undefined) {
			throw new QuereusError(
				`Isolation layer: UNIQUE constraint column '${col.name}' not found on '${updatedSchema.schemaName}.${updatedSchema.name}' after the underlying accepted the constraint.`,
				StatusCode.INTERNAL,
			);
		}
		return idx;
	});
	const indexName = constraint.name ?? `_uc_${columns.map(i => updatedSchema.columns[i].name).join('_')}`;
	if (host.schemaHasIndex(overlaySchema, indexName)) return;
	// A runtime-added UNIQUE carries no partial predicate of its own (the AST has no field
	// for one), so the overlay predicate is exactly the live-rows narrowing.
	await overlayTable.createIndex({
		name: indexName,
		columns: columns.map(i => ({ index: i, collation: updatedSchema.columns[i]?.collation })),
		unique: true,
		predicate: host.overlayPredicate(undefined, updatedSchema.name, overlaySchema.name),
	});
}

/**
 * Forwards DROP / RENAME CONSTRAINT to an already-open overlay, presence-guarded: a
 * constraint the overlay never carried is skipped silently rather than letting the overlay
 * module's NOTFOUND abort the issuer's already-applied ALTER. The guard is what makes the
 * unforwarded classes safe ({@link forwardAddConstraintToOverlay}: FOREIGN KEY always, and
 * UNIQUE under an overlay module without `createIndex`) — their DROP / RENAME is simply a
 * no-op on the overlay.
 *
 * For a UNIQUE the overlay module drops/renames the constraint AND its covering index in
 * lock-step — both live under the constraint's name (or the `_uc_<cols>` implicit-name
 * rule), whether copied at overlay creation (`IsolationModule.createOverlaySchema`) or
 * installed by {@link installOverlayUniqueConstraint} — so the base and overlay
 * representations stay resolvable by one name across the whole constraint lifecycle.
 */
async function forwardConstraintNameChangeToOverlay(
	overlayState: ConnectionOverlayState,
	change: Extract<SchemaChangeInfo, { type: 'dropConstraint' | 'renameConstraint' }>,
): Promise<void> {
	const overlayTable = overlayState.overlayTable;
	const overlaySchema = overlayTable.tableSchema;
	if (!overlayTable.alterSchema || !overlaySchema) return;
	const name = change.type === 'dropConstraint' ? change.constraintName : change.oldName;
	if (!schemaHasNamedConstraint(overlaySchema, name)) return;
	await overlayTable.alterSchema(change);
}

/** Case-insensitive "does `schema` declare a named constraint of ANY class (CHECK / UNIQUE / FOREIGN KEY)". */
function schemaHasNamedConstraint(schema: TableSchema, constraintName: string): boolean {
	const lower = constraintName.toLowerCase();
	return (schema.checkConstraints ?? []).some(c => c.name?.toLowerCase() === lower)
		|| (schema.uniqueConstraints ?? []).some(c => c.name?.toLowerCase() === lower)
		|| (schema.foreignKeys ?? []).some(c => c.name?.toLowerCase() === lower);
}

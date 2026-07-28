/**
 * Generic KVStore-backed Virtual Table implementation.
 *
 * This is a platform-agnostic table implementation that works with any
 * KVStore implementation (LevelDB, IndexedDB, or custom stores).
 *
 * Storage architecture:
 *   - Data store: {schema}.{table} - row data keyed by encoded PK
 *   - Index stores: {schema}.{table}_idx_{name} - one per secondary index
 *   - Stats store: __stats__ - unified store for all table statistics, keyed by {schema}.{table}
 */

import {
	VirtualTable,
	IndexConstraintOp,
	ConflictResolution,
	QuereusError,
	StatusCode,
	compareSqlValues,
	compareSqlValuesFast,
	createTypedComparator,
	hasSemanticOrdering,
	semanticKeyTransform,
	resolveUniqueEnforcementCollations,
	uniqueEnforcementComparators,
	BINARY_COLLATION,
	rowsValueIdentical,
	coerceRowToSchema,
	compilePredicate,
	decodeIdxStr,
	planKindFromCode,
	maintainedTableUniqueViolationError,
	uniqueEnforcementCollations,
	logicalTypeCanHoldText,
	pkKeyCollationName,
	JSON_TYPE,
	type IdxStrSpec,
	type LogicalType,
	type Database,
	type DatabaseInternal,
	type CollationFunction,
	type CollationResolver,
	type ColumnSchema,
	type MaintainedTableSchema,
	type TableSchema,
	type TableIndexSchema,
	type UniqueConstraintSchema,
	type CompiledPredicate,
	type Row,
	type FilterInfo,
	type SqlValue,
	type VirtualTableConnection,
	type UpdateArgs,
	type VirtualTableModule,
	type UpdateResult,
	type BackingRowChange,
} from '@quereus/quereus';

import type { IterateOptions, KVEntry, KVStore } from './kv-store.js';
import { bytesEqual, bytesToHex, compareBytes } from './bytes.js';
import type { StoreEventEmitter } from './events.js';
import type { TransactionCoordinator } from './transaction.js';
import { StoreConnection } from './store-connection.js';
import {
	buildDataKey,
	buildIndexKey,
	buildIndexPrefixBounds,
	buildFullScanBounds,
	buildPkPrefixBounds,
	buildStatsKey,
} from './key-builder.js';
import {
	serializeRow,
	deserializeRow,
	serializeStats,
	deserializeStats,
	type TableStats,
} from './serialization.js';
import { type EncodeOptions, type KeyValueTransform } from './encoding.js';
import { jsonStructuralKey } from './json-key.js';

/** Number of mutations before persisting statistics. */
const STATS_FLUSH_INTERVAL = 100;

/** True when `key` falls within the (gte/gt/lte/lt) window of `bounds`. */
function keyWithinBounds(key: Uint8Array, bounds: IterateOptions): boolean {
	if (bounds.gte && compareBytes(key, bounds.gte) < 0) return false;
	if (bounds.gt && compareBytes(key, bounds.gt) <= 0) return false;
	if (bounds.lte && compareBytes(key, bounds.lte) > 0) return false;
	if (bounds.lt && compareBytes(key, bounds.lt) >= 0) return false;
	return true;
}

/**
 * Resolves the per-constraint default conflict action for PK conflicts.
 * Prefers the table-level `PRIMARY KEY (...) ON CONFLICT <action>` clause
 * over any column-level `defaultConflict` declared on a PK column.
 *
 * Mirrors the helpers in `quereus/.../layer/manager.ts` and
 * `quereus-isolation/.../isolated-table.ts` — the three-tier precedence
 * `statement OR > per-constraint default > ABORT` must agree across all
 * three implementations.
 */
function resolvePkDefaultConflict(schema: TableSchema): ConflictResolution | undefined {
	if (schema.primaryKeyDefaultConflict !== undefined) return schema.primaryKeyDefaultConflict;
	for (const def of schema.primaryKeyDefinition) {
		const col = schema.columns[def.index];
		if (col?.defaultConflict !== undefined) return col.defaultConflict;
	}
	return undefined;
}

/**
 * Resolve the per-column KEY collation for each primary-key column.
 *
 * The store encodes PRIMARY KEY uniqueness/ordering PHYSICALLY in the key bytes, so each
 * text-capable PK column's key must be encoded under the collation the engine actually
 * COMPARES that column under. Returns one entry per PK member, in `pkDef` order:
 *   - `isTextual` member (`text`) → its declared `collation` (normalized upper-case), or
 *     `fallback` (the table key collation K) when the column carries none.
 *   - text-capable but not `isTextual` member — `any`, `json`, and the temporal types
 *     (`date` / `time` / `datetime` / `timespan`) → hard-coded `'BINARY'`, see below.
 *   - never-text member → `undefined`: collation is meaningless for
 *     integer/real/blob keys (they encode type-natively), so the encoder ignores
 *     it and the data/index key bytes are identical regardless.
 *
 * Note that `undefined` does NOT mean "encode type-natively" to `encodeValue` — it means
 * "fall back to `options.collation`", the table key collation K. Only a never-text column
 * may be left `undefined`, because only it never reaches the collation branch.
 *
 * Every name returned here is encoded through the key-normalizer resolver carried
 * in `EncodeOptions.normalizers` (`db.getKeyNormalizerResolver()`), so a collation
 * registered or overridden with `db.registerCollation` produces key bytes that agree
 * with the comparator the store's UNIQUE enforcement uses. A collation that cannot
 * key — unregistered, or registered with a comparator but no normalizer — is rejected
 * at DDL time by {@link StoreTable.validateKeyCollations}, so no encode call ever has
 * to fall back. Shared by {@link StoreTable} (data-key + index-maintenance) and
 * `StoreModule.buildIndexEntries` (index rebuild) so the PK suffix encoding can
 * never drift between the two.
 */
export function resolvePkKeyCollations(
	pkDef: ReadonlyArray<{ index: number }>,
	columns: ReadonlyArray<ColumnSchema>,
	fallback: string,
): (string | undefined)[] {
	return pkDef.map(def => {
		const col = columns[def.index];
		// Delegates the isTextual/text-capable/never-text branch to the engine's
		// `pkKeyCollationName` — the same decision `quereus-isolation`'s modified-PK set
		// makes for its own key normalizers, so the two can never drift apart again. Only
		// the fallback-to-K and uppercase-normalization are store-specific.
		const name = pkKeyCollationName(col);
		return name === undefined ? undefined : (name || fallback).toUpperCase();
	});
}

/**
 * The store's per-type key VALUE TRANSFORM for a semantic-ordering logical type, or
 * `undefined` when raw values already key faithfully.
 *
 * The contract is TWO-sided — identity AND order. `StoreTable` implements no
 * `comparePrimaryKey`, so the isolation layer merges overlay against underlying with
 * its own fallback comparator (the PK type's `compare` via `createTypedComparator`)
 * and needs this table's key BYTE order to agree with it; and byte equality must be
 * exactly the type's equality, or two spellings of one value land on two keys.
 *
 *  - JSON → the store-local structural encoder ({@link jsonStructuralKey}): a
 *    `Uint8Array` whose memcmp order reproduces the type's structural `compare`
 *    (canonical-text bytes are identity-faithful but sort `[10]` before `[2]`,
 *    which broke overlay shadowing — see json-key.ts).
 *  - Everything else → the engine's {@link semanticKeyTransform} (the type's
 *    `groupKey`). Today that is TIMESPAN: total seconds against the same reference
 *    date as `TIMESPAN.compare`, so 'PT1H' and 'PT60M' collide on one key AND byte
 *    order is elapsed-time order.
 *
 * JSON deliberately gets NO engine `groupKey` — `groupKey` also drives GROUP BY /
 * `IN` / hash-join identity, where canonical-text identity is already correct and a
 * `Uint8Array` key would be a behaviour change for no benefit. Hence this
 * store-local seam. A semantic-ordering type with NEITHER a `groupKey` nor an entry
 * here cannot key a persisted structure soundly; `StoreTable` rejects it at DDL time
 * (see `validateSemanticKeyTransforms`).
 */
export function storeSemanticKeyTransform(type: LogicalType | undefined): KeyValueTransform | undefined {
	// Matched by NAME, not object identity (`type === JSON_TYPE`): the engine and this
	// package can be loaded as two module instances (e.g. the logic suite runs the
	// engine from src via ts-node while the store resolves `@quereus/quereus` to dist),
	// and each instance carries its own JSON_TYPE singleton. The `hasSemanticOrdering`
	// gate keeps a hypothetical plain custom type named 'JSON' out of this branch.
	if (hasSemanticOrdering(type) && type.name === JSON_TYPE.name) return jsonStructuralKey;
	return semanticKeyTransform(type);
}

/**
 * Resolve the per-column key value transform for each primary-key column —
 * {@link storeSemanticKeyTransform} of the member's logical type. One entry per PK
 * member in `pkDef` order; `undefined` for every type whose raw value already keys
 * faithfully. The companion of {@link resolvePkKeyCollations}: every call site that
 * threads the collations MUST thread these too, or key identity/order drifts
 * between the write path and the rebuild/lookup path.
 */
export function resolvePkKeyTransforms(
	pkDef: ReadonlyArray<{ index: number }>,
	columns: ReadonlyArray<ColumnSchema>,
): (KeyValueTransform | undefined)[] {
	return pkDef.map(def => storeSemanticKeyTransform(columns[def.index]?.logicalType));
}

/**
 * Per-column key value transforms for a secondary index's OWN columns (the
 * index half of `buildIndexKey`), positionally aligned with `index.columns`.
 * Same rule as {@link resolvePkKeyTransforms}: a semantic-ordering member
 * canonicalizes through {@link storeSemanticKeyTransform}, everything else
 * encodes raw.
 */
export function resolveIndexKeyTransforms(
	index: TableIndexSchema,
	columns: ReadonlyArray<ColumnSchema>,
): (KeyValueTransform | undefined)[] {
	return index.columns.map(col => storeSemanticKeyTransform(columns[col.index]?.logicalType));
}

/**
 * Per-PK-column typed equality comparator for semantic-ordering members, `undefined`
 * elsewhere. Backs {@link StoreTable.keysEqual}: two PK arrays naming the same
 * physical key under {@link resolvePkKeyTransforms} ('PT1H' / 'PT60M') must also
 * answer "same row" here, or self-PK exclusion in the UNIQUE checks false-conflicts
 * a row against its own differently-spelled image.
 */
function resolvePkSemanticEquality(
	pkDef: ReadonlyArray<{ index: number }>,
	columns: ReadonlyArray<ColumnSchema>,
): (((a: SqlValue, b: SqlValue) => number) | undefined)[] {
	return pkDef.map(def => {
		const logicalType = columns[def.index]?.logicalType;
		return hasSemanticOrdering(logicalType) ? createTypedComparator(logicalType) : undefined;
	});
}

/**
 * True when `col` can produce a TEXT value at runtime, and so when its physical
 * key bytes are produced by a collation normalizer rather than a type-native
 * encoding. The `ColumnSchema`-shaped wrapper over the engine's
 * {@link logicalTypeCanHoldText}; both collation-safety guards over the store's
 * secondary indexes — the write-side {@link StoreTable.indexSeekHonorsEnforcementCollation}
 * and the read-side `StoreModule.tryIndexAccessPlan` — exempt a never-text column
 * from their K-vs-C comparison, so a false "non-text" answer is a silent
 * wrong-result (a seek under the wrong collation, with the residual dropped).
 */
export function columnCanHoldText(col: ColumnSchema | undefined): boolean {
	return logicalTypeCanHoldText(col?.logicalType);
}

/**
 * True when a byte window — or a byte-order advertisement — over `column` is SOUND.
 *
 * The store physically orders rows by memcmp of each column's key bytes, which for a
 * text-capable column are produced by `keyCollation`'s normalizer. A range seek (and the
 * `providesOrdering` / `monotonicOn` advertisement) equates that byte order with the order
 * `compareCollation`'s comparator defines. Two things must hold for that equation:
 *
 *  - **Same collation on both sides** (`compareCollation === keyCollation`). A `keyCollation`
 *    merely COARSER than `compareCollation` — the relaxation the EQUALITY seek is allowed to
 *    make, see `StoreModule.tryIndexAccessPlan` — is not enough here: it would need the key
 *    normalizer to be monotone with respect to the OTHER collation's order. It generally is
 *    not, even for built-ins: with `keyCollation = NOCASE` and `compareCollation = BINARY`,
 *    'K' (U+212A KELVIN SIGN) is `> 'z'` under BINARY, yet its key bytes are
 *    `toLowerCase('K') = 'k'`, which sorts BEFORE 'z' — the row falls outside a `> 'z'`
 *    window and is silently dropped.
 *  - **The normalizer preserves order** (`db._isCollationOrderPreserving`). `registerCollation`
 *    promises only that a normalizer partitions strings the way the comparator calls them
 *    equal; a custom pair may agree on equality and disagree on order.
 *
 * A never-text column is exempt: its key bytes are type-native and collation-independent.
 *
 * Returning `false` costs an optimization (the caller full-scans and lets the
 * collation-aware `matchesFilters` residual decide); returning `true` wrongly is a silent
 * wrong-result. Shared by `StoreTable`'s read arms and `StoreModule`'s access planner so the
 * "mark handled" and "build a window" decisions can never disagree.
 */
export function keyOrderMatchesCollation(
	db: Database,
	column: ColumnSchema | undefined,
	keyCollation: string,
	compareCollation: string,
): boolean {
	// A semantic-ordering logical type (TIMESPAN, JSON — see docs/types.md "Semantic
	// ordering") is ordered by its `compare` (elapsed time / structural), which the
	// engine's Sort, comparison operators, and the memory backend all use. Both types'
	// key bytes now encode through an order-preserving transform (TIMESPAN's `groupKey`
	// total seconds; JSON's structural encoding — see `storeSemanticKeyTransform`), so
	// byte order DOES match the type's `compare` for every well-formed value and this
	// blanket decline is conservative, costing the seek/sort-elision, never a row.
	// Re-opening the window/advertisement (and the byte-EQ arms in `analyzePKAccess` /
	// `analyzeIndexAccess`) is tracked in backlog `feat-reopen-timespan-store-seeks`.
	if (hasSemanticOrdering(column?.logicalType)) return false;
	if (!columnCanHoldText(column)) return true;
	if (compareCollation.toUpperCase() !== keyCollation.toUpperCase()) return false;
	return (db as DatabaseInternal)._isCollationOrderPreserving(keyCollation);
}

/**
 * How many LEADING primary-key members have key bytes whose memcmp order matches their
 * declared collation's comparator order, per {@link keyOrderMatchesCollation}.
 *
 * `pkKeyCollations` is {@link resolvePkKeyCollations}' output for this table; an `undefined`
 * entry belongs to a never-text member, which {@link keyOrderMatchesCollation} exempts
 * outright — `tableKeyCollation` is passed only so the exempt branch has a name to ignore.
 * The comparison collation is the column's declared one, which `reconcilePkCollations` has
 * already aligned with the key collation for every *textual* PK member.
 *
 * What the advertisement is measured against is the order the planner's `Sort` would have
 * produced. For most members Sort orders under the operand's COLLATION, so a collation match
 * is the question; for a member whose logical type carries SEMANTIC ordering (TIMESPAN, JSON
 * — see docs/types.md "Semantic ordering") Sort now ranks by `logicalType.compare`, which no
 * text-byte encoding reproduces, and {@link keyOrderMatchesCollation} closes the gate for
 * such members outright (the memory backend's typed BTree order is the canonical order under
 * that ruling; the store declines rather than advertising a divergent byte order).
 *
 * `0` ⇒ even the leading member is unsafe: no range seek, no PK-order advertisement.
 * A prefix shorter than the PK truncates the ordering advertisement rather than voiding it.
 */
export function pkOrderPreservingPrefixLength(
	db: Database,
	schema: TableSchema,
	pkKeyCollations: ReadonlyArray<string | undefined>,
	tableKeyCollation: string,
): number {
	const pk = schema.primaryKeyDefinition;
	let n = 0;
	while (n < pk.length) {
		const col = schema.columns[pk[n].index];
		const keyCollation = pkKeyCollations[n] ?? tableKeyCollation;
		// NOTE: an explicit `k any collate nocase` PK declines its seek here — the key
		// collation is BINARY (what ANY_TYPE.compare actually uses) while `col.collation` is
		// the declared-but-ignored NOCASE, so the two sides differ and the gate closes. Both
		// sides genuinely compare under BINARY, so the decline is conservative: it costs the
		// seek, never a row. If that declaration ever shows up in practice, resolve the
		// comparison collation the way `resolvePkKeyCollations` resolves the key collation
		// rather than widening the gate.
		if (!keyOrderMatchesCollation(db, col, keyCollation, col?.collation ?? 'BINARY')) break;
		n++;
	}
	return n;
}

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
 * Return `schema` with a synthetic secondary index materialized into
 * `schema.indexes` for every NON-DERIVED UNIQUE constraint that lacks one — the
 * store analogue of `MemoryTableManager.ensureUniqueConstraintIndexes`.
 *
 * This is what lets a plain column- or table-level `UNIQUE` be enforced by a
 * bounded index point-seek ({@link StoreTable.findUniqueConflictViaIndex})
 * instead of an O(rows) full scan: DML maintenance
 * ({@link StoreTable.updateSecondaryIndexes}) and the UNIQUE check both iterate
 * `schema.indexes`, so once the `_uc_*` entry is present the physical index is
 * maintained and seeked with no new code path.
 *
 * The result is held ONLY in {@link StoreTable.materializedSchema} (the
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
 * {@link StoreTable.findIndexForUniqueConstraint} matches on identity.
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

/** A UNIQUE conflict: the offending row and the primary key it lives at. */
type UniqueConflict = { pk: SqlValue[]; row: Row };

/**
 * Returned by {@link StoreTable.findUniqueConflictViaIndex} when the index
 * cannot soundly answer the check and the caller must fall back to the full
 * data-store scan. Distinct from `null`, which means "the index answered: no
 * conflict".
 */
const INDEX_UNUSABLE = Symbol('store.uniqueIndexUnusable');

/**
 * Configuration for a store table.
 */
export interface StoreTableConfig {
	/** Collation for text keys. Default: 'NOCASE'. */
	collation?: 'BINARY' | 'NOCASE';
	/**
	 * Serialized-byte budget for a single index-build write batch (see
	 * `StoreModule.buildIndexEntries`). Parsed from the `max_batch_bytes` module
	 * arg; undefined falls back to the module default.
	 */
	maxBatchBytes?: number;
	/** Additional platform-specific options. */
	[key: string]: unknown;
}

/**
 * Interface for the store module that manages this table.
 * Provides access to stores and coordinators.
 */
export interface StoreTableModule {
	/** Get the data store for a table. */
	getStore(schemaName: string, tableName: string, config: StoreTableConfig): Promise<KVStore>;
	/** Get an index store for a table. */
	getIndexStore(schemaName: string, tableName: string, indexName: string): Promise<KVStore>;
	/** Get the stats store for a table. */
	getStatsStore(schemaName: string, tableName: string): Promise<KVStore>;
	/**
	 * Get the module's single shared transaction coordinator (one per storage
	 * module, shared by every table — the unit of cross-table atomicity).
	 * Synchronous: ops are addressed by explicit store handle, so obtaining a
	 * coordinator never requires opening storage.
	 */
	getCoordinator(): TransactionCoordinator;
	/** Save table DDL to persistent storage. */
	saveTableDDL(tableSchema: TableSchema): Promise<void>;
}

/**
 * One externally-applied row op against a SOURCE table's committed storage,
 * the input vocabulary of {@link StoreTable.applyExternalRowChanges}. An
 * `upsert` carries the full table row in schema column order (its PK — and thus
 * its data key — is derived from the row, so an upsert can never relocate a
 * row); a `delete` carries the PK values in PK-definition order.
 */
export type ExternalRowOp =
	| { op: 'upsert'; row: Row }
	| { op: 'delete'; pk: SqlValue[] };

/**
 * Generic KVStore-backed virtual table.
 *
 * This class provides the core table functionality shared across all
 * storage backends. Platform-specific behavior is delegated to the
 * StoreTableModule.
 */
export class StoreTable extends VirtualTable {
	protected storeModule: StoreTableModule;
	protected config: StoreTableConfig;
	protected store: KVStore | null = null;
	protected storeInitPromise: Promise<KVStore> | null = null;
	protected indexStores: Map<string, KVStore> = new Map();
	protected statsStore: KVStore | null = null;
	protected coordinator: TransactionCoordinator | null = null;
	/**
	 * Disposer returned by the coordinator's `registerCallbacks`, captured on the
	 * first {@link attachCoordinator}. Run by {@link dispose} at hard eviction to
	 * deregister this instance's {stats apply/discard} pair from the module-wide
	 * coordinator; null until attached, and nulled again after dispose.
	 */
	private coordinatorDisposer: (() => void) | null = null;
	protected connection: StoreConnection | null = null;
	protected eventEmitter?: StoreEventEmitter;
	protected encodeOptions: EncodeOptions;
	protected pkDirections: boolean[];
	/**
	 * Per-PK-column KEY collation (see {@link resolvePkKeyCollations}). Drives the
	 * physical encoding of every data key and the PK suffix of every secondary-index
	 * key, so a text PK column declared BINARY/NOCASE/RTRIM is keyed under its own
	 * collation rather than one fixed table-level collation. Recomputed on every
	 * {@link updateSchema} (an ALTER COLUMN SET COLLATE on a PK member changes it).
	 */
	protected pkKeyCollations: (string | undefined)[];
	/**
	 * Per-PK-column key-identity value transform (see {@link resolvePkKeyTransforms}).
	 * Threaded alongside {@link pkKeyCollations} into every data-key / PK-suffix /
	 * PK-prefix-bounds encode, so a semantic-ordering PK member (TIMESPAN) keys
	 * semantically-equal spellings to one physical key. Recomputed on every
	 * {@link updateSchema}.
	 */
	protected pkKeyTransforms: (KeyValueTransform | undefined)[];
	/**
	 * Per-PK-column typed EQUALITY comparator for the semantic-ordering members only —
	 * `undefined` for every other member, which {@link keysEqual} still compares with
	 * strict `!==` as before. Keeps self-PK exclusion and PK-identity questions in
	 * agreement with the physical key identity above ('PT1H' row IS the 'PT60M' row).
	 */
	protected pkSemanticEquality: (((a: SqlValue, b: SqlValue) => number) | undefined)[];
	/**
	 * `db.getCollationResolver()`, bound once at construction. Every collation-aware
	 * VALUE comparison this table makes — pushed-constraint re-check, UNIQUE conflict
	 * detection — resolves names through it, so a collation registered with
	 * `db.registerCollation` on *this* connection is honored rather than silently
	 * degraded to BINARY by the process-global built-in registry.
	 *
	 * Only the resolver closure is cached: it reads the live registry, so a collation
	 * registered after connect is still visible. Resolved *functions* are hoisted no
	 * further than the comparator or constraint check that resolved them.
	 *
	 * Its key-bytes counterpart, `db.getKeyNormalizerResolver()`, is bound into
	 * {@link encodeOptions} so the names in {@link pkKeyCollations} resolve to the same
	 * per-connection registry.
	 */
	protected readonly collationResolver: CollationResolver;
	protected ddlSaved = false;

	// Statistics tracking
	protected cachedStats: TableStats | null = null;
	protected pendingStatsDelta = 0;
	protected mutationCount = 0;
	protected statsFlushPending = false;

	// Lazy cache of compiled partial-UNIQUE predicates. Keyed on the
	// UniqueConstraintSchema object identity — UC schemas are frozen and a
	// new constraint object after CREATE/DROP INDEX produces a fresh compile;
	// the WeakMap lets the GC reclaim entries for retired constraints.
	private readonly predicateCache: WeakMap<UniqueConstraintSchema, CompiledPredicate> = new WeakMap();

	// Lazy cache of compiled partial-index predicates, keyed on the IndexSchema
	// object identity (frozen; a CREATE/DROP INDEX or reopen produces a fresh
	// object, so the WeakMap reclaims retired entries). Mirrors predicateCache but
	// for secondary-index maintenance rather than UNIQUE enforcement.
	private readonly indexPredicateCache: WeakMap<TableIndexSchema, CompiledPredicate> = new WeakMap();

	/**
	 * {@link tableSchema} with a hidden `_uc_*` secondary index materialized per
	 * non-derived UNIQUE constraint (see {@link withImplicitUniqueIndexes}) — the
	 * schema that drives UNIQUE ENFORCEMENT ({@link findIndexForUniqueConstraint})
	 * and physical index MAINTENANCE ({@link updateSecondaryIndexes}).
	 *
	 * Deliberately SEPARATE from the engine-facing {@link tableSchema}: the engine
	 * reads `tableInstance.tableSchema` at CREATE (`SchemaManager.finalizeCreatedTableSchema`)
	 * and the read-query planner reads the registered schema, and NEITHER may see
	 * `_uc_*` (mirrors the memory backend keeping its materialized schema
	 * manager-local; a plain UNIQUE gets no read-side plan from `_uc_*`, only
	 * enforcement). Recomputed alongside `tableSchema` in the constructor and
	 * {@link updateSchema}.
	 */
	private materializedSchema: TableSchema;

	constructor(
		db: Database,
		storeModule: StoreTableModule,
		tableSchema: TableSchema,
		config: StoreTableConfig,
		eventEmitter?: StoreEventEmitter,
		isConnected = false
	) {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		super(db, storeModule as unknown as VirtualTableModule<any, any>, tableSchema.schemaName, tableSchema.name);
		this.storeModule = storeModule;
		// The engine-facing schema stays NON-materialized (the engine registers it and the
		// read-query planner reads it — neither may see `_uc_*`); the hidden `_uc_*`
		// per-UNIQUE index that lets plain UNIQUE enforce via a point-seek lives only in
		// {@link materializedSchema}.
		this.tableSchema = tableSchema;
		this.materializedSchema = withImplicitUniqueIndexes(tableSchema);
		this.config = config;
		this.eventEmitter = eventEmitter;
		this.collationResolver = db.getCollationResolver();
		this.encodeOptions = {
			collation: config.collation || 'NOCASE',
			normalizers: db.getKeyNormalizerResolver(),
		};
		this.pkDirections = tableSchema.primaryKeyDefinition.map(pk => !!pk.desc);
		this.pkKeyCollations = resolvePkKeyCollations(
			tableSchema.primaryKeyDefinition,
			tableSchema.columns,
			this.encodeOptions.collation ?? 'NOCASE',
		);
		this.pkKeyTransforms = resolvePkKeyTransforms(tableSchema.primaryKeyDefinition, tableSchema.columns);
		this.pkSemanticEquality = resolvePkSemanticEquality(tableSchema.primaryKeyDefinition, tableSchema.columns);
		// Validate the MATERIALIZED schema, so a `_uc_*` over a text column that needs the
		// table key collation K is rejected up front just like an explicit index would be.
		this.validateKeyCollations(this.materializedSchema, this.pkKeyCollations);
		this.validateSemanticKeyTransforms(this.materializedSchema);
		this.ddlSaved = isConnected;
	}

	/**
	 * Reject, at DDL time, any collation this table's key encoding would need but cannot
	 * use — before a single row is written under bytes the connection cannot reproduce.
	 *
	 * A collation keys a persisted structure only if it carries a KEY NORMALIZER (the
	 * `(s) => string` whose output equality partitions strings exactly as its comparator
	 * does). `db.registerCollation(name, cmp)` with no `{ normalizer }` gives a collation
	 * that can order rows but not key them; an unregistered name gives nothing at all.
	 * Both raise here rather than at the first insert.
	 *
	 * Checked over exactly the collations the key encoding actually uses:
	 *   - every defined `pkKeyCollations` entry (text-capable PK columns);
	 *   - the table key collation K, but only when it is reachable — a secondary index
	 *     encodes a TEXT-CAPABLE index column's bytes under K (`buildIndexKey`).
	 *
	 * So neither a table with an integer PK and no secondary index, nor one whose every
	 * index column is type-natively keyed, is made unopenable by a K it never encodes with.
	 *
	 * Blast radius: this also fires on catalog rehydration. Reopening a persisted database
	 * from a connection that has not re-registered its custom collation now throws at
	 * CREATE-TABLE-from-catalog rather than silently reading rows under a key layout it
	 * cannot reproduce. See `docs/plugins.md`.
	 *
	 * Takes `pkKeyCollations` rather than reading the field so `updateSchema` can validate
	 * the incoming schema BEFORE it overwrites its own state with it.
	 */
	private validateKeyCollations(schema: TableSchema, pkKeyCollations: ReadonlyArray<string | undefined>): void {
		const names = new Set<string>();
		for (const collation of pkKeyCollations) {
			if (collation !== undefined) names.add(collation);
		}
		const indexKeysText = (schema.indexes ?? []).some(index =>
			index.columns.some(col => columnCanHoldText(schema.columns[col.index])));
		if (indexKeysText) {
			names.add((this.encodeOptions.collation ?? 'NOCASE').toUpperCase());
		}

		const dbInternal = this.db as DatabaseInternal;
		for (const name of names) {
			if (dbInternal._getCollationNormalizer(name)) continue;
			// Unregistered names raise `no such collation sequence: X` from the resolver;
			// reaching past it means the collation exists but is comparator-only.
			this.collationResolver(name);
			throw new QuereusError(
				`collation ${name} cannot key a persisted structure: no key normalizer registered `
					+ `— pass { normalizer } to registerCollation`,
				StatusCode.ERROR,
			);
		}
	}

	/**
	 * Reject, at DDL time, a key member whose semantic-ordering logical type has no
	 * store key transform — before a single row is keyed under bytes whose order the
	 * type's `compare` (and so the isolation merge, the memory oracle, and Sort)
	 * disagrees with.
	 *
	 * A semantic-ordering type keys soundly only through an order- and
	 * identity-preserving transform ({@link storeSemanticKeyTransform}: the type's
	 * `groupKey`, or a store-local encoder like JSON's structural one). This gap used
	 * to be undetectable — JSON sat here transform-less for a release, keying in
	 * canonical-text order while every comparator ordered structurally, and the only
	 * symptom was a misaligned overlay merge deep inside a transaction. Unreachable
	 * today (TIMESPAN and JSON are both covered); it exists so the NEXT
	 * semantic-ordering type fails loudly at CREATE TABLE instead.
	 *
	 * Checked over the same materialized schema as {@link validateKeyCollations}:
	 * every PK member and every (explicit or hidden `_uc_*`) index column.
	 *
	 * CAVEAT: this can only check that a transform EXISTS — a `groupKey` that is
	 * identity-faithful but not order-preserving passes undetected, so a new type's
	 * transform still needs its byte order argued against its `compare` (see
	 * json-key.ts for the shape of that argument).
	 */
	private validateSemanticKeyTransforms(schema: TableSchema): void {
		const check = (colIndex: number, member: string): void => {
			const col = schema.columns[colIndex];
			const type = col?.logicalType;
			if (!hasSemanticOrdering(type) || storeSemanticKeyTransform(type) !== undefined) return;
			throw new QuereusError(
				`column ${col?.name ?? String(colIndex)} (${member}): semantic-ordering type `
					+ `${type.name} cannot key a persisted structure: its raw encoding would not `
					+ `reproduce the type's compare order — the type needs an order-preserving `
					+ `groupKey or a store key encoder (see storeSemanticKeyTransform)`,
				StatusCode.ERROR,
			);
		};
		for (const def of schema.primaryKeyDefinition) check(def.index, 'primary key');
		for (const index of schema.indexes ?? []) {
			for (const col of index.columns) check(col.index, `index ${index.name}`);
		}
	}

	/** Get the table configuration. */
	getConfig(): StoreTableConfig {
		return this.config;
	}

	/** Get the table schema (engine-facing, WITHOUT the hidden `_uc_*` indexes). */
	getSchema(): TableSchema {
		return this.tableSchema!;
	}

	/**
	 * Get the enforcement schema — {@link getSchema} plus the hidden `_uc_*`
	 * index materialized per non-derived UNIQUE. Used by the module to resolve the
	 * physical index store to build/tear down during ALTER; never registered with
	 * the engine.
	 */
	getMaterializedSchema(): TableSchema {
		return this.materializedSchema;
	}

	/**
	 * Update the table schema after an ALTER TABLE / CREATE INDEX operation.
	 *
	 * Validates the incoming schema's key collations before adopting any of it, so a
	 * rejection leaves this table on its previous, consistent schema.
	 */
	updateSchema(newSchema: TableSchema): void {
		// `newSchema` is the engine-facing (non-materialized) schema; recompute the
		// enforcement copy alongside it. Validate the MATERIALIZED copy so a `_uc_*` over a
		// text column that needs the table key collation K is caught before adoption.
		const materialized = withImplicitUniqueIndexes(newSchema);
		const pkKeyCollations = resolvePkKeyCollations(
			newSchema.primaryKeyDefinition,
			newSchema.columns,
			this.encodeOptions.collation ?? 'NOCASE',
		);
		this.validateKeyCollations(materialized, pkKeyCollations);
		this.validateSemanticKeyTransforms(materialized);
		this.tableSchema = newSchema;
		this.materializedSchema = materialized;
		this.pkDirections = newSchema.primaryKeyDefinition.map(pk => !!pk.desc);
		this.pkKeyCollations = pkKeyCollations;
		this.pkKeyTransforms = resolvePkKeyTransforms(newSchema.primaryKeyDefinition, newSchema.columns);
		this.pkSemanticEquality = resolvePkSemanticEquality(newSchema.primaryKeyDefinition, newSchema.columns);
	}

	/**
	 * Mark the table's DDL as already persisted to the catalog, so the lazy
	 * first-store-access save in {@link initializeStore} is skipped. Called by
	 * `StoreModule.createIndex` / `dropIndex` after they eagerly write the catalog
	 * bundle, so a subsequent INSERT does not redundantly re-persist identical DDL.
	 */
	markDdlSaved(): void {
		this.ddlSaved = true;
	}

	/** Close and forget a cached index-store handle, if any. */
	async releaseIndexStore(indexName: string): Promise<void> {
		const cached = this.indexStores.get(indexName);
		if (!cached) return;
		this.indexStores.delete(indexName);
		try { await cached.close(); } catch { /* close is best-effort */ }
	}

	/**
	 * Returns true if the table has at least one LIVE row — the open transaction's
	 * pending overlay over the committed store. Stops after the first hit.
	 *
	 * Effective (not committed-only) because its one caller, `ADD COLUMN`'s NOT
	 * NULL-without-DEFAULT rejection, must see rows the same transaction inserted:
	 * they are migrated too (the arm DDL-commits before `migrateRows`), and a
	 * committed-only probe would wave them through only to give them a NULL in a
	 * NOT NULL column. Conversely, a pending delete of the last row makes the table
	 * legitimately empty. Reading effectively keeps the check throw-only and
	 * BEFORE the DDL-commit, so a rejection leaves the transaction intact.
	 */
	async hasAnyRows(): Promise<boolean> {
		for await (const _entry of this.iterateEffectiveEntries(buildFullScanBounds())) {
			return true;
		}
		return false;
	}

	/**
	 * Yield the LIVE value of `colIndex` for every row — the open transaction's
	 * pending overlay over the committed store. For throw-only ALTER COLUMN probes
	 * that must run BEFORE the arm's DDL-commit (see `StoreModule.ddlCommitPendingOps`):
	 * they have to see rows this transaction wrote, because those rows are rewritten
	 * too, and a rejection here must leave the transaction intact.
	 */
	async *iterateEffectiveValuesAtIndex(colIndex: number): AsyncIterable<SqlValue> {
		for await (const entry of this.iterateEffectiveEntries(buildFullScanBounds())) {
			yield deserializeRow(entry.value)[colIndex];
		}
	}

	/**
	 * Count the LIVE rows whose column at `colIndex` holds NULL (see
	 * {@link iterateEffectiveValuesAtIndex} for why this reads effectively).
	 * Used by ALTER COLUMN SET NOT NULL to decide whether the tightening is safe.
	 */
	async rowsWithNullAtIndex(colIndex: number): Promise<number> {
		let count = 0;
		for await (const value of this.iterateEffectiveValuesAtIndex(colIndex)) {
			if (value === null) count++;
		}
		return count;
	}

	/**
	 * Apply a per-row mapping function to every stored row, in place (re-writing
	 * the same key). The mapper may throw QuereusError — propagated to the caller;
	 * the batch is written only after every row maps, so a throw leaves the store
	 * untouched.
	 *
	 * NOTE: reads and writes the COMMITTED store, outside the coordinator. Sound
	 * only because every caller calls `StoreModule.ddlCommitPendingOps` first, so
	 * "committed" is "everything live". A caller that skips that flush would leave
	 * its transaction's pending rows unmapped, and they would replay unconverted
	 * over the rewritten store at commit.
	 */
	async mapRowsAtIndex(
		colIndex: number,
		mapper: (value: SqlValue) => SqlValue,
	): Promise<void> {
		const store = await this.ensureStore();
		const bounds = buildFullScanBounds();
		const batch = store.batch();
		for await (const entry of store.iterate(bounds)) {
			const row = deserializeRow(entry.value);
			const oldVal = row[colIndex];
			const newVal = mapper(oldVal);
			if (newVal === oldVal) continue;
			const newRow = row.slice();
			newRow[colIndex] = newVal;
			batch.put(entry.key, serializeRow(newRow as Row));
		}
		await batch.write();
	}

	/**
	 * Re-key every stored row under a new primary-key definition.
	 *
	 * Two-pass, signatures-only pass 1: the first pass computes each row's new data
	 * key and retains only a `Set` of key SIGNATURES (hex of the key bytes) to detect
	 * collisions — two distinct old keys collapsing to one new key under a coarser
	 * collation or a narrower PK. On collision we throw `CONSTRAINT` without touching
	 * the store. The second pass RE-SCANS the same committed store, recomputes each
	 * new key, and batches deletes of displaced old keys + puts of new (key, row)
	 * pairs into ONE atomic batch. Rows whose new key matches the old key are no-ops.
	 *
	 * Holding signatures instead of whole rows halves peak memory: the prior design
	 * retained the entire table in a map AND again in the batch. The re-scan trades
	 * O(rows) CPU (a second iterate + newKey recompute) for not buffering the table
	 * twice. Pass 1 and pass 2 iterate the SAME bounds over the SAME committed store
	 * and see identical rows: nothing writes between them — we are single-threaded
	 * within the ALTER, outside the coordinator, and every caller ran
	 * `StoreModule.ddlCommitPendingOps` first so "committed" is "everything live".
	 *
	 * The final single `batch.write()` is the ONLY thing making the re-key
	 * all-or-nothing — do not chunk-flush it. Its residual peak (the batch still holds
	 * every changed row) is irreducible without breaking atomicity; tracked separately
	 * in `debt-store-atomic-batch-bounded-memory`.
	 *
	 * Only the data store is rewritten — secondary indexes are rebuilt by the
	 * caller (the keys embed the PK suffix, so they must be rebuilt whenever
	 * the PK changes).
	 *
	 * The new key for each row is encoded under `newColumns`'s per-column PK
	 * collations, so this drives BOTH:
	 *   - `ALTER PRIMARY KEY` — the PK *columns* change; `newColumns` defaults to the
	 *     current column set (their collations are unchanged), and
	 *   - `ALTER COLUMN … SET COLLATE` on a PK member — the PK columns stay the same
	 *     but one column's collation changes; the caller passes the post-ALTER
	 *     `updatedSchema.columns` so the new key bytes follow the new collation.
	 * The OLD key is taken verbatim from the stored entry (never re-encoded), so the
	 * old collation is implicit in the existing bytes and need not be supplied.
	 */
	async rekeyRows(
		newPkDef: ReadonlyArray<{ index: number; desc?: boolean }>,
		newColumns: ReadonlyArray<ColumnSchema> = this.tableSchema!.columns,
	): Promise<void> {
		const store = await this.ensureStore();
		const bounds = buildFullScanBounds();

		const newPkDirections = newPkDef.map(pk => !!pk.desc);
		const newPkCollations = resolvePkKeyCollations(
			newPkDef,
			newColumns,
			this.encodeOptions.collation ?? 'NOCASE',
		);
		// Post-ALTER key-identity transforms too: an ALTER PRIMARY KEY onto (or a SET
		// DATA TYPE creating) a semantic-ordering member must collapse equal spellings
		// — pass 1 then rejects 'PT1H'/'PT60M' as a duplicate PK, all-or-nothing.
		const newPkTransforms = resolvePkKeyTransforms(newPkDef, newColumns);
		// Both passes key rows through this one helper, so a collision judged in pass 1
		// is byte-identical to the key pass 2 writes.
		const computeNewKey = (row: Row): Uint8Array =>
			buildDataKey(newPkDef.map(pk => row[pk.index]), this.encodeOptions, newPkDirections, newPkCollations, newPkTransforms);

		// Pass 1 — collision detection only. Hold one hex signature per new key, never
		// the row or old key. On a repeat, reject before any write; the store is
		// untouched on rejection.
		const seen = new Set<string>();
		for await (const entry of store.iterate(bounds)) {
			const hex = bytesToHex(computeNewKey(deserializeRow(entry.value)));
			if (seen.has(hex)) {
				throw new QuereusError(
					`UNIQUE constraint failed: duplicate primary key on rekey of '${this.schemaName}.${this.tableName}'`,
					StatusCode.CONSTRAINT,
				);
			}
			seen.add(hex);
		}

		// Pass 2 — re-scan and build the single atomic batch. Recompute each new key and
		// only rewrite rows whose key actually moves (`newKey !== oldKey`).
		const batch = store.batch();
		for await (const entry of store.iterate(bounds)) {
			const row = deserializeRow(entry.value);
			const newKey = computeNewKey(row);
			if (!bytesEqual(entry.key, newKey)) {
				batch.delete(entry.key);
				// NOTE: the row VALUE is unchanged, so `serializeRow(row)` reproduces
				// `entry.value` byte-for-byte. We re-serialize rather than reuse
				// `entry.value` to avoid retaining an iterator-owned buffer in the batch.
				// If re-key CPU ever shows up hot, reuse `entry.value` where the backend
				// guarantees the buffer is not reused across iteration.
				batch.put(newKey, serializeRow(row));
			}
		}
		await batch.write();
	}

	/**
	 * Migrate all stored rows from the old column layout to a new one.
	 * The remap array maps newColumnIndex -> oldColumnIndex | -1.
	 * -1 means the column is new (fill with defaultValue).
	 *
	 * `backfill`, when supplied (ADD COLUMN with a non-foldable DEFAULT such as
	 * `new.<col>`), derives the new column's value from each existing row instead of the
	 * single `defaultValue`, and rejects a NULL it produces for a NOT NULL column. The
	 * batch is only written once every row migrates, so a throwing evaluator / NOT NULL
	 * violation leaves the store untouched for the caller's rollback.
	 */
	async migrateRows(
		remap: number[],
		defaultValue: SqlValue,
		backfill?: { evaluator: (row: Row) => SqlValue | Promise<SqlValue>; notNull: boolean; columnName: string },
	): Promise<void> {
		const store = await this.ensureStore();
		const bounds = buildFullScanBounds();
		const batch = store.batch();

		for await (const entry of store.iterate(bounds)) {
			const oldRow = deserializeRow(entry.value);
			let newColumnValue = defaultValue;
			if (backfill) {
				newColumnValue = await backfill.evaluator(oldRow);
				if (backfill.notNull && newColumnValue === null) {
					throw new QuereusError(
						`NOT NULL constraint failed: backfilling column '${this.schemaName}.${this.tableName}.${backfill.columnName}' produced NULL for an existing row`,
						StatusCode.CONSTRAINT,
					);
				}
			}
			const newRow: Row = new Array(remap.length);
			for (let i = 0; i < remap.length; i++) {
				newRow[i] = remap[i] === -1 ? newColumnValue : oldRow[remap[i]];
			}
			batch.put(entry.key, serializeRow(newRow));
		}

		await batch.write();
	}

	/**
	 * Ensure the data store is open and DDL is persisted.
	 * Uses a promise-based singleton pattern to prevent race conditions
	 * when multiple concurrent queries access the same table.
	 */
	protected ensureStore(): Promise<KVStore> {
		if (this.store) {
			return Promise.resolve(this.store);
		}

		if (this.storeInitPromise) {
			return this.storeInitPromise;
		}

		this.storeInitPromise = this.initializeStore();
		return this.storeInitPromise;
	}

	/**
	 * Internal method to actually initialize the store.
	 * Only called once per table instance.
	 */
	private async initializeStore(): Promise<KVStore> {
		const tableKey = `${this.schemaName}.${this.tableName}`.toLowerCase();

		try {
			this.store = await this.storeModule.getStore(this.schemaName, this.tableName, this.config);

			if (!this.store) {
				throw new Error(`getStore returned null/undefined for ${tableKey}`);
			}

			// Save DDL on first access (only for newly created tables)
			if (!this.ddlSaved && this.tableSchema) {
				await this.storeModule.saveTableDDL(this.tableSchema);
				this.ddlSaved = true;
			}

			return this.store;
		} catch (error) {
			this.storeInitPromise = null;
			throw error;
		}
	}

	/**
	 * Get or create an index store for the given index name.
	 */
	protected async ensureIndexStore(indexName: string): Promise<KVStore> {
		let indexStore = this.indexStores.get(indexName);
		if (!indexStore) {
			indexStore = await this.storeModule.getIndexStore(this.schemaName, this.tableName, indexName);
			this.indexStores.set(indexName, indexStore);
		}
		return indexStore;
	}

	/**
	 * Get or create the stats store.
	 */
	protected async ensureStatsStore(): Promise<KVStore> {
		if (!this.statsStore) {
			this.statsStore = await this.storeModule.getStatsStore(this.schemaName, this.tableName);
		}
		return this.statsStore;
	}

	/**
	 * Resolve + cache the module's shared TransactionCoordinator and hook the
	 * stats lifecycle callbacks, WITHOUT creating or registering a connection.
	 * Synchronous (the coordinator is handle-addressed, never store-opening — see
	 * `StoreTableModule.getCoordinator`), so the backing host's resolution path can
	 * call it eagerly. Attaching matters for reads: `iterateEffective` /
	 * `readEffectiveRowByKey` consult `this.coordinator` for the pending merge, so a
	 * table whose only writer is the privileged backing host (which queues ops on the
	 * module coordinator, never through `update()`) must still hold the
	 * reference for its read paths to be reads-own-writes.
	 *
	 * The coordinator is module-wide, so its commit/rollback callback array holds
	 * one {stats apply/discard} pair per PARTICIPATING table; each table's
	 * `applyPendingStats` early-returns when its own `pendingStatsDelta` is 0, so a
	 * table that did no work contributes nothing. Registers only on first call per
	 * StoreTable instance (the `if (!this.coordinator)` guard); a fresh instance
	 * after drop+recreate re-registers against the shared coordinator. The OLD
	 * instance is not GC'd on its own — its callback closures capture `this` and
	 * stay pinned on the module-wide coordinator until {@link dispose} runs the
	 * captured disposer (called at the genuine eviction sites, see
	 * `StoreModule.tearDownTableStorage` / `renameTable`).
	 */
	attachCoordinator(): TransactionCoordinator {
		if (!this.coordinator) {
			this.coordinator = this.storeModule.getCoordinator();

			this.coordinatorDisposer = this.coordinator.registerCallbacks({
				onCommit: () => this.applyPendingStats(),
				onRollback: () => this.discardPendingStats(),
			});
		}
		return this.coordinator;
	}

	/**
	 * Ensure the coordinator is available and connection is registered.
	 */
	protected async ensureCoordinator(): Promise<TransactionCoordinator> {
		const coordinator = this.attachCoordinator();

		if (!this.connection) {
			this.connection = new StoreConnection(`${this.schemaName}.${this.tableName}`, coordinator);
			await (this.db as DatabaseInternal).registerConnection(this.connection);
		}

		return coordinator;
	}

	/** Apply pending stats on commit. */
	protected applyPendingStats(): void {
		if (this.pendingStatsDelta === 0) return;

		if (!this.cachedStats) {
			this.cachedStats = { rowCount: 0, updatedAt: Date.now() };
		}
		this.cachedStats.rowCount = Math.max(0, this.cachedStats.rowCount + this.pendingStatsDelta);
		this.cachedStats.updatedAt = Date.now();
		this.mutationCount += Math.abs(this.pendingStatsDelta);
		this.pendingStatsDelta = 0;

		if (this.mutationCount >= STATS_FLUSH_INTERVAL && !this.statsFlushPending) {
			this.statsFlushPending = true;
			queueMicrotask(() => this.flushStats());
		}
	}

	/** Discard pending stats on rollback. */
	protected discardPendingStats(): void {
		this.pendingStatsDelta = 0;
	}

	/** Flush statistics to the stats store. */
	protected async flushStats(): Promise<void> {
		this.statsFlushPending = false;
		this.mutationCount = 0;

		if (!this.cachedStats) {
			return;
		}

		const statsStore = await this.ensureStatsStore();
		const statsKey = buildStatsKey(this.schemaName, this.tableName);
		await statsStore.put(statsKey, serializeStats(this.cachedStats));
	}

	/** Create a new connection for transaction support. */
	async createConnection(): Promise<VirtualTableConnection> {
		await this.ensureCoordinator();
		return this.connection!;
	}

	/** Get the current connection. */
	getConnection(): VirtualTableConnection | undefined {
		return this.connection ?? undefined;
	}

	/** Extract primary key values from a row. */
	protected extractPK(row: Row): SqlValue[] {
		const schema = this.tableSchema!;
		return schema.primaryKeyDefinition.map(pk => row[pk.index]);
	}

	/**
	 * Coerce each cell in `row` to its declared column logical type.
	 * Mirrors the memory-table path (MemoryTableManager.performInsert/performUpdate)
	 * so INTEGER/REAL affinity is applied and JSON columns are parsed into native
	 * objects before PK extraction, serialization, and index-key construction.
	 */
	protected coerceRow(row: Row): Row {
		return coerceRowToSchema(row, this.tableSchema!.columns, `${this.schemaName}.${this.tableName}`);
	}

	/**
	 * Query the table with optional filters.
	 *
	 * All three access arms read the EFFECTIVE row state: the committed store
	 * merged with this table's coordinator's pending ops when a transaction is
	 * active (read-your-own-writes — see {@link iterateEffective} /
	 * {@link readLiveRowByPk}). Merged emission stays in encoded-PK-key order,
	 * preserving the module's `providesOrdering` / `monotonicOn` advertisements.
	 */
	async *query(filterInfo: FilterInfo): AsyncIterable<Row> {
		const store = await this.ensureStore();

		// Multi-seek (`plan=5`, an IN-list served as N point seeks) dispatches FIRST —
		// before analyzePKAccess: the FilterInfo carries N*W EQ constraints, so on a
		// table whose PK column is also the leading column of the chosen index,
		// analyzePKAccess would match the FIRST equality and answer a single-value
		// point lookup — one list value's rows, a silent wrong result.
		const idxSpec = decodeIdxStr(filterInfo.idxStr);
		if (idxSpec && planKindFromCode(idxSpec.plan) === 'multiSeek') {
			yield* this.scanMultiSeek(idxSpec, filterInfo);
			return;
		}

		const pkAccess = this.analyzePKAccess(filterInfo);

		if (pkAccess.type === 'point') {
			const row = await this.readLiveRowByPk(pkAccess.values!);
			if (row && this.matchesFilters(row, filterInfo, this.resolveFilterCollations(filterInfo))) {
				yield row;
			}
			return;
		}

		if (pkAccess.type === 'range') {
			yield* this.scanPKRange(store, pkAccess, filterInfo);
			return;
		}

		// Secondary-index scan arm — reached only when the predicate did NOT resolve
		// to a PK point/range (PK access is cheaper and already handled above). When
		// the planner chose a secondary index (idxStr carries `idx=<name>(…)`), derive
		// its byte window and iterate it instead of full-scanning.
		const indexAccess = this.analyzeIndexAccess(filterInfo);
		if (indexAccess) {
			const indexStore = await this.ensureIndexStore(indexAccess.index.name);
			yield* this.scanIndex(indexStore, indexAccess, filterInfo);
			return;
		}

		// Full table scan
		const collations = this.resolveFilterCollations(filterInfo);
		const bounds = buildFullScanBounds();
		for await (const entry of this.iterateEffective(store, bounds)) {
			const row = deserializeRow(entry.value);
			if (this.matchesFilters(row, filterInfo, collations)) {
				yield row;
			}
		}
	}

	/**
	 * Iterate the effective entry state of this table's data store within
	 * `bounds`: the committed `store.iterate` stream merged with the
	 * coordinator's pending ops for the data store (read-your-own-writes).
	 *
	 * Both inputs are sorted by encoded key bytes, so this is an
	 * order-preserving two-way merge: a pending put wins over a committed entry
	 * at the same key, a pending delete suppresses its committed entry, and
	 * pending puts outside `bounds` are excluded. With no active transaction
	 * (or an empty pending bucket) it degrades to the bare committed iterate.
	 *
	 * The pending side is the module coordinator's bucket for THIS table's data
	 * store handle (`store`) — every data op is queued under that exact handle, so
	 * a sibling table's pending ops (a different data-store handle) never bleed in.
	 */
	protected async *iterateEffective(
		store: KVStore,
		bounds: IterateOptions,
		reverse = false,
	): AsyncIterable<KVEntry> {
		const pending = this.coordinator?.isInTransaction()
			? this.coordinator.getOrderedPendingOps(store)
			: null;
		const iterOptions: IterateOptions = reverse ? { ...bounds, reverse } : bounds;

		if (!pending || (pending.puts.length === 0 && pending.deletes.size === 0)) {
			yield* store.iterate(iterOptions);
			return;
		}

		const puts = pending.puts.filter(p => keyWithinBounds(p.key, bounds));
		if (reverse) puts.reverse();
		// In iteration order, "before" means byte-less for forward and byte-greater
		// for reverse; sign folds the direction into one comparison.
		const sign = reverse ? -1 : 1;
		let putIdx = 0;

		for await (const entry of store.iterate(iterOptions)) {
			// Emit pending puts that precede this committed entry in iteration order.
			while (putIdx < puts.length && sign * compareBytes(puts[putIdx].key, entry.key) < 0) {
				yield puts[putIdx++];
			}
			// Equal keys: the pending put shadows the committed entry.
			if (putIdx < puts.length && compareBytes(puts[putIdx].key, entry.key) === 0) {
				yield puts[putIdx++];
				continue;
			}
			if (pending.deletes.has(bytesToHex(entry.key))) continue;
			yield entry;
		}

		// Pending puts beyond the last committed entry.
		while (putIdx < puts.length) {
			yield puts[putIdx++];
		}
	}

	/**
	 * True when a byte window over the LEADING PK column reproduces the comparator's order
	 * — the precondition {@link buildPKRangeBounds} needs, and the exact condition
	 * `StoreModule.computeBestAccessPlan` uses before claiming the range filters handled.
	 * When false, the range arm degrades to a full scan + `matchesFilters` residual.
	 */
	protected leadingPkRangeIsOrderSafe(): boolean {
		return pkOrderPreservingPrefixLength(
			this.db,
			this.tableSchema!,
			this.pkKeyCollations,
			this.encodeOptions.collation ?? 'NOCASE',
		) >= 1;
	}

	/**
	 * True when some PK member's logical type carries semantic ordering (TIMESPAN,
	 * JSON). Such PKs decline the point arm and full-scan, where
	 * {@link matchesFilters} applies the type's compare. Historically required —
	 * byte-key equality was a strict subset of the type's equality ('PT1H' ≡
	 * 'PT60M' elapsed-time-equal, byte-distinct) and a point window under-fetched
	 * with no residual able to resurrect a skipped row. Both types' key transforms
	 * (see {@link storeSemanticKeyTransform}) now make byte equality the type's
	 * equality, so the decline is conservative; re-opening is tracked in backlog
	 * `feat-reopen-timespan-store-seeks`. (Range windows and ordering
	 * advertisements are already declined by {@link keyOrderMatchesCollation}.)
	 */
	protected pkHasSemanticOrderingMember(): boolean {
		const schema = this.tableSchema!;
		return schema.primaryKeyDefinition.some(def =>
			hasSemanticOrdering(schema.columns[def.index]?.logicalType));
	}

	/** Analyze filter info to determine PK access pattern. */
	protected analyzePKAccess(filterInfo: FilterInfo): PKAccessPattern {
		const schema = this.tableSchema!;
		const pkColumns = schema.primaryKeyDefinition.map(pk => pk.index);

		if (pkColumns.length === 0) {
			return { type: 'scan' };
		}

		// Check for equality on all PK columns
		const eqValues: SqlValue[] = new Array(pkColumns.length);
		let allEq = true;

		for (let i = 0; i < pkColumns.length; i++) {
			const pkColIdx = pkColumns[i];
			const eqConstraintEntry = filterInfo.constraints?.find(
				c => c.constraint.iColumn === pkColIdx && c.constraint.op === IndexConstraintOp.EQ
			);
			if (eqConstraintEntry && eqConstraintEntry.argvIndex > 0) {
				eqValues[i] = filterInfo.args[eqConstraintEntry.argvIndex - 1];
			} else {
				allEq = false;
				break;
			}
		}

		if (allEq && !this.pkHasSemanticOrderingMember()) {
			return { type: 'point', values: eqValues };
		}

		// Check for range constraints on first PK column
		const firstPkCol = pkColumns[0];
		const rangeOps = [IndexConstraintOp.LT, IndexConstraintOp.LE, IndexConstraintOp.GT, IndexConstraintOp.GE];
		const rangeConstraints = filterInfo.constraints?.filter(
			c => c.constraint.iColumn === firstPkCol && rangeOps.includes(c.constraint.op)
		) || [];

		// A range window is only sound when the leading PK column's key bytes order the way
		// its comparator does; otherwise fall through to the full scan, where matchesFilters
		// applies the range under the real comparator.
		if (rangeConstraints.length > 0 && this.leadingPkRangeIsOrderSafe()) {
			return {
				type: 'range',
				columnIndex: firstPkCol,
				constraints: rangeConstraints.map(c => ({
					columnIndex: c.constraint.iColumn,
					op: c.constraint.op,
					value: c.argvIndex > 0 ? filterInfo.args[c.argvIndex - 1] : undefined,
				})),
			};
		}

		return { type: 'scan' };
	}

	/**
	 * Convert a leading-PK-column range access into one seek + early-terminate
	 * iterate window.
	 *
	 * Each LT/LE/GT/GE constraint's bound value is encoded under the SAME
	 * per-column DESC direction and key collation as the data keys (via
	 * {@link encodePkPrefixBounds}), giving the byte region `[lo, hi)` whose
	 * leading column equals that value (`lo = encode([x])`,
	 * `hi = incrementLastByte(lo)`). The op maps that region's endpoints onto a
	 * `gte`/`lt` window; because a DESC column bit-inverts its bytes (larger value
	 * ⇒ smaller bytes), the lower/upper assignment swaps with direction:
	 *
	 *   | op | ASC      | DESC     |
	 *   |----|----------|----------|
	 *   | GE | gte = lo | lt  = hi |
	 *   | GT | gte = hi | lt  = lo |
	 *   | LE | lt  = hi | gte = lo |
	 *   | LT | lt  = lo | gte = hi |
	 *
	 * Across constraints (BETWEEN ⇒ one lower + one upper; a redundant same-side
	 * pair ⇒ the tighter wins) we keep the MAX lower candidate for `gte` and the
	 * MIN upper candidate for `lt`. A candidate that resolves to `undefined` (an
	 * `hi` whose increment overflowed all-0xff) leaves that side unbounded — a safe
	 * SUPERSET, since {@link matchesFilters} stays the authoritative collation-aware
	 * row filter. A NULL/missing bound value is likewise skipped (the planner never
	 * pushes `= NULL`, and a range op against NULL rejects every row in matchesFilters).
	 *
	 * NOTE: a range window over a text PK column is sound only when the column's key
	 * normalizer is ORDER-preserving with respect to its comparator — i.e. the comparator
	 * orders two strings the way memcmp orders their normalized bytes. That is NOT implied
	 * by `db.registerCollation`'s normalizer contract, which promises only an equality
	 * partition, and a built-in NAME may be re-registered with a comparator + normalizer
	 * pair that preserves equality while inverting order. This method is therefore only
	 * ever reached under {@link leadingPkRangeIsOrderSafe} — enforced by
	 * {@link analyzePKAccess} here and mirrored by `StoreModule.computeBestAccessPlan`
	 * before it claims the range filters handled. A collation without the
	 * `orderPreserving` assertion costs the seek, never a row.
	 */
	protected buildPKRangeBounds(access: PKAccessPattern): IterateOptions {
		const full = buildFullScanBounds();
		const constraints = access.constraints;
		if (!constraints || constraints.length === 0) return full;

		const dir = this.pkDirections[0];

		let gte: Uint8Array = full.gte;
		let lt: Uint8Array | undefined;

		for (const c of constraints) {
			if (c.value === undefined || c.value === null) continue;
			const { gte: lo, lt: hi } = this.encodePkPrefixBounds([c.value]);
			const lower = !dir
				? (c.op === IndexConstraintOp.GE ? lo : c.op === IndexConstraintOp.GT ? hi : undefined)
				: (c.op === IndexConstraintOp.LE ? lo : c.op === IndexConstraintOp.LT ? hi : undefined);
			const upper = !dir
				? (c.op === IndexConstraintOp.LE ? hi : c.op === IndexConstraintOp.LT ? lo : undefined)
				: (c.op === IndexConstraintOp.GE ? hi : c.op === IndexConstraintOp.GT ? lo : undefined);
			if (lower && compareBytes(lower, gte) > 0) gte = lower;
			if (upper && (lt === undefined || compareBytes(upper, lt) < 0)) lt = upper;
		}

		return lt === undefined ? { gte } : { gte, lt };
	}

	/**
	 * Scan a leading-PK-column range, seeking to the window start and
	 * early-terminating at its end.
	 *
	 * {@link buildPKRangeBounds} converts the LT/LE/GT/GE constraints into one
	 * encoded-byte `gte`/`lt` window under the same per-column DESC directions and
	 * key collations the data keys use, so the iterate visits a SUPERSET of the
	 * qualifying rows (a collation widening or the bound-byte increment can
	 * over-fetch, never under-fetch). {@link matchesFilters} stays the authoritative
	 * collation-aware row filter. {@link iterateEffective} restricts the pending
	 * merge to the same `bounds`, so read-your-own-writes holds on the narrowed window.
	 */
	protected async *scanPKRange(
		store: KVStore,
		access: PKAccessPattern,
		filterInfo: FilterInfo
	): AsyncIterable<Row> {
		const collations = this.resolveFilterCollations(filterInfo);
		const bounds = this.buildPKRangeBounds(access);
		for await (const entry of this.iterateEffective(store, bounds)) {
			const row = deserializeRow(entry.value);
			if (this.matchesFilters(row, filterInfo, collations)) {
				yield row;
			}
		}
	}

	/**
	 * Resolve the secondary index chosen by the planner from `filterInfo.idxStr`.
	 *
	 * The planner emits `idx=<name>(<n>);plan=…` when its access plan set both an
	 * `indexName` and `seekColumnIndexes` (see `getBestAccessPlan` and
	 * rule-select-access-path.ts). Decoding goes through the engine's shared
	 * `decodeIdxStr`, so the store, the in-memory vtab, and the isolation overlay all
	 * read one format. Returns null for the PK/scan sentinels (`_primary_`, `fullscan`,
	 * `empty`), an idxStr that names no index, or a name absent from `schema.indexes` —
	 * every one of which routes back to a PK/full-scan arm.
	 */
	protected resolveIndexFromIdxStr(idxStr: string | null): TableIndexSchema | null {
		const spec = decodeIdxStr(idxStr);
		if (!spec) return null;
		const name = spec.indexName;
		if (!name || name === '_primary_') return null;
		const indexes = this.tableSchema?.indexes ?? [];
		return indexes.find(i => i.name.toLowerCase() === name.toLowerCase()) ?? null;
	}

	/**
	 * Analyze filter info to determine a secondary-index access pattern, mirroring
	 * {@link analyzePKAccess} but over the index chosen in `idxStr`.
	 *
	 * A contiguous leading-prefix EQ on the index columns yields a `point` window
	 * (the prefix covers every entry sharing those leading values — an index seek
	 * is a PREFIX scan, not a single row, since the index need not be unique and
	 * the PK suffix varies); otherwise a range (LT/LE/GT/GE) on the LEADING index
	 * column yields a `range` window. Returns null when neither applies or when the
	 * index is unresolved. {@link matchesFilters} stays the authoritative row filter,
	 * so the window need only be a SUPERSET.
	 *
	 * Index-column bytes are encoded under the table key collation K (NOT the index's
	 * per-column declared collation — see `buildIndexKey`), while `matchesFilters` compares
	 * under the index column's effective collation C. The EQ/prefix window is a superset
	 * whenever K is coarser-or-equal to C, which `StoreModule.tryIndexAccessPlan` checked
	 * before it named this index. The RANGE window additionally needs byte order to BE
	 * comparator order, so it is gated on {@link keyOrderMatchesCollation} (which demands
	 * `C === K` plus K's `orderPreserving` assertion); when that fails we return null and
	 * the caller full-scans.
	 */
	protected analyzeIndexAccess(filterInfo: FilterInfo): IndexAccessPattern | null {
		const index = this.resolveIndexFromIdxStr(filterInfo.idxStr);
		if (!index) return null;

		const indexCols = index.columns.map(c => c.index);
		const indexDirections = index.columns.map(c => !!c.desc);

		// Contiguous leading-prefix EQ → point/prefix window. A prefix member whose
		// logical type carries semantic ordering stops the prefix: its byte-equality
		// window under-fetches the type's equality (see pkHasSemanticOrderingMember),
		// and a skipped row cannot be resurrected by the residual.
		const eqValues: SqlValue[] = [];
		for (let i = 0; i < indexCols.length; i++) {
			if (hasSemanticOrdering(this.tableSchema!.columns[indexCols[i]]?.logicalType)) break;
			const eq = filterInfo.constraints?.find(
				c => c.constraint.iColumn === indexCols[i]
					&& c.constraint.op === IndexConstraintOp.EQ
					&& c.argvIndex > 0,
			);
			if (!eq) break;
			eqValues.push(filterInfo.args[eq.argvIndex - 1]);
		}
		if (eqValues.length > 0) {
			const bounds = buildIndexPrefixBounds(
				eqValues,
				this.encodeOptions,
				indexDirections.slice(0, eqValues.length),
			);
			return { index, type: 'point', bounds };
		}

		// Else a range on the LEADING index column.
		const leadingCol = indexCols[0];
		const rangeOps = [IndexConstraintOp.LT, IndexConstraintOp.LE, IndexConstraintOp.GT, IndexConstraintOp.GE];
		const rangeConstraints = (filterInfo.constraints ?? []).filter(
			c => c.constraint.iColumn === leadingCol && rangeOps.includes(c.constraint.op),
		);
		if (rangeConstraints.length > 0 && this.indexRangeIsOrderSafe(index, leadingCol)) {
			const bounds = this.buildIndexRangeBounds(
				rangeConstraints.map(c => ({
					op: c.constraint.op,
					value: c.argvIndex > 0 ? filterInfo.args[c.argvIndex - 1] : undefined,
				})),
				indexDirections[0],
			);
			return { index, type: 'range', bounds };
		}

		return null;
	}

	/**
	 * True when a byte window over `leadingCol` of `index` reproduces the comparator's
	 * order. Mirrors the range arm of `StoreModule.tryIndexAccessPlan`: the window's bytes
	 * come from the table key collation K, the residual compares under the index column's
	 * effective collation C, so both must be the same order-preserving collation.
	 */
	protected indexRangeIsOrderSafe(index: TableIndexSchema, leadingCol: number): boolean {
		const schema = this.tableSchema!;
		const K = this.encodeOptions.collation ?? 'NOCASE';
		const col = schema.columns[leadingCol];
		const indexCol = index.columns.find(c => c.index === leadingCol);
		const C = indexCol?.collation ?? col?.collation ?? 'BINARY';
		return keyOrderMatchesCollation(this.db, col, K, C);
	}

	/**
	 * Convert leading-index-column LT/LE/GT/GE constraints into one encoded-byte
	 * `gte`/`lt` window — the secondary-index analogue of {@link buildPKRangeBounds}.
	 *
	 * Each bound value is encoded under {@link encodeOptions} (the table key collation K
	 * and its normalizer resolver) and the leading index column's DESC `dir` — exactly as
	 * {@link buildIndexKey} encodes
	 * that column — via {@link buildIndexPrefixBounds}, giving the byte region
	 * `[lo, hi)` whose leading column equals that value. The op maps that region's
	 * endpoints onto `gte`/`lt`, with the same DESC lower/upper SWAP as the PK path:
	 *
	 *   | op | ASC      | DESC     |
	 *   |----|----------|----------|
	 *   | GE | gte = lo | lt  = hi |
	 *   | GT | gte = hi | lt  = lo |
	 *   | LE | lt  = hi | gte = lo |
	 *   | LT | lt  = lo | gte = hi |
	 *
	 * Across constraints keep the MAX lower and MIN upper. An `undefined` upper (an
	 * `hi` whose increment overflowed all-0xff) leaves that side unbounded — a safe
	 * SUPERSET. A NULL/missing bound value is skipped (the planner never pushes
	 * `= NULL`, and a range op against NULL rejects every row in matchesFilters).
	 */
	protected buildIndexRangeBounds(
		constraints: Array<{ op: IndexConstraintOp; value?: SqlValue }>,
		dir: boolean,
	): IterateOptions {
		const full = buildFullScanBounds();
		let gte: Uint8Array = full.gte;
		let lt: Uint8Array | undefined;

		for (const c of constraints) {
			if (c.value === undefined || c.value === null) continue;
			const { gte: lo, lt: hi } = buildIndexPrefixBounds([c.value], this.encodeOptions, [dir]);
			const lower = !dir
				? (c.op === IndexConstraintOp.GE ? lo : c.op === IndexConstraintOp.GT ? hi : undefined)
				: (c.op === IndexConstraintOp.LE ? lo : c.op === IndexConstraintOp.LT ? hi : undefined);
			const upper = !dir
				? (c.op === IndexConstraintOp.LE ? hi : c.op === IndexConstraintOp.LT ? lo : undefined)
				: (c.op === IndexConstraintOp.GE ? hi : c.op === IndexConstraintOp.GT ? lo : undefined);
			if (lower && compareBytes(lower, gte) > 0) gte = lower;
			if (upper && (lt === undefined || compareBytes(upper, lt) < 0)) lt = upper;
		}

		return lt === undefined ? { gte } : { gte, lt };
	}

	/**
	 * Scan a secondary index over `access.bounds`, resolving each index entry to its
	 * base row and re-filtering.
	 *
	 * {@link iterateEffective} yields the committed index entries merged with this
	 * transaction's pending index puts/deletes (read-your-own-writes over the
	 * index), in index-key byte order — the order the isolation overlay merge relies
	 * on (`isolated-table.ts` § buildSortKey). We resolve each entry to its row via
	 * its stored data-key value WITHOUT reordering, so index-key order is preserved.
	 *
	 * Defense in depth mirroring the memory layer's live-recheck: a resolved-null
	 * row (the entry's row was deleted — a pending index delete would normally
	 * suppress the entry, but a committed entry can lag) is skipped, and every
	 * resolved row is re-checked by {@link matchesFilters} (the byte window is only
	 * a superset, and a stale entry whose indexed column no longer matches is
	 * dropped).
	 */
	protected async *scanIndex(
		indexStore: KVStore,
		access: IndexAccessPattern,
		filterInfo: FilterInfo,
		multi?: MultiSeekWindowContext,
	): AsyncIterable<Row> {
		// Re-check each resolved row under the INDEX's per-column collation (see
		// matchesFilters): the planner dropped the residual based on the index
		// column's collation, which an explicit index `COLLATE` can make differ from
		// the table column's declared collation.
		const indexCollations = multi?.collations
			?? this.resolveFilterCollations(filterInfo, this.indexColumnCollations(access.index));
		for await (const entry of this.iterateEffective(indexStore, access.bounds)) {
			// NOTE: a legacy index store (written before index values carried the data
			// key) holds EMPTY values; a zero-length data key is not a row key, so skip
			// it rather than resolve it to the wrong row. Because the access plan marked
			// the filter handled and dropped the residual, an indexed query over such a
			// store returns NOTHING rather than the matching rows — a silent wrong
			// result, not an error. Backwards compatibility is waived project-wide
			// (AGENTS.md) and no test provider carries on-disk data, so nothing exercises
			// this today. If real persisted stores predating this format come into play,
			// their indexes must be dropped + recreated (or the table rebuilt); the
			// durable fix is to version-stamp the index store and rebuild on open, or to
			// fall back to a full scan the first time an empty value is seen.
			if (entry.value.length === 0) continue;
			// Cross-window dedup for a multi-seek: a data key an earlier window already
			// YIELDED is skipped before the data-store read, so a duplicate costs no
			// extra `get`. The seen-set is only ever ADDED to on a yield (below) — adding
			// at visit time would let a stale index entry that fails its residual poison
			// the set and suppress the row's live entry in a later window.
			const dataKeyHex = multi ? bytesToHex(entry.value) : undefined;
			if (dataKeyHex !== undefined && multi!.seen.has(dataKeyHex)) continue;
			// NOTE: one extra data-store `get` per matched index entry — the row lives
			// in the data store, not the index (the index value carries only the data
			// key, no covering payload). Fine now; if index-covered scans ever dominate
			// a profile, consider storing the serialized row as a covering index value,
			// at the cost of an index rewrite on EVERY column change (not just indexed
			// columns) — deliberately not done here.
			const row = await this.readEffectiveRowByKey(entry.value);
			if (!row) continue;
			if (this.matchesFilters(row, filterInfo, indexCollations)
				|| (multi !== undefined && multi.extraTuples.some(fi => this.matchesFilters(row, fi, indexCollations)))) {
				if (dataKeyHex !== undefined) multi!.seen.add(dataKeyHex);
				yield row;
			}
		}
	}

	/**
	 * Fail loudly on a multi-seek FilterInfo this table cannot serve. The plan already
	 * dropped the residual Filter, and {@link matchesFilters} ANDs every pushed
	 * constraint — so falling through to the scan arm would AND N mutually-exclusive
	 * equalities and return zero rows: a silent wrong answer, not a slow one.
	 */
	private multiSeekMalformed(filterInfo: FilterInfo, why: string): never {
		throw new QuereusError(
			`Malformed multi-seek FilterInfo (idxStr '${filterInfo.idxStr}') on ${this.schemaName}.${this.tableName}: ${why}`,
			StatusCode.INTERNAL,
		);
	}

	/**
	 * Decode a multi-seek FilterInfo into its N seek tuples of width W. Tuple i pairs
	 * `args[i*W … i*W+W-1]` with the same slice of `constraints` (argvIndex runs
	 * 1…N*W in order — see rule-select-access-path's multiSeek emission). A tuple with
	 * a NULL/undefined component is dropped: IN is set membership and a NULL component
	 * matches nothing. The planner pre-reduces literal lists, but a parameter-bound /
	 * mixed-binding list reaches here unreduced, so this skip is the only line of
	 * defense for those.
	 */
	private decodeMultiSeekTuples(
		spec: IdxStrSpec,
		filterInfo: FilterInfo,
	): { tuples: MultiSeekTuple[]; seekWidth: number } {
		const seekWidth = Number.parseInt(spec.params.get('seekWidth') ?? '1', 10);
		const inCount = Number.parseInt(spec.params.get('inCount') ?? '0', 10);
		if (!Number.isInteger(seekWidth) || seekWidth < 1) {
			this.multiSeekMalformed(filterInfo, `seekWidth=${spec.params.get('seekWidth')}`);
		}
		if (!Number.isInteger(inCount) || inCount < 1) {
			this.multiSeekMalformed(filterInfo, `inCount=${spec.params.get('inCount')}`);
		}
		const constraints = filterInfo.constraints ?? [];
		if (constraints.length < inCount * seekWidth) {
			this.multiSeekMalformed(filterInfo, `${constraints.length} constraints for ${inCount}×${seekWidth} seek keys`);
		}
		if (filterInfo.args.length < inCount * seekWidth) {
			this.multiSeekMalformed(filterInfo, `${filterInfo.args.length} args for ${inCount}×${seekWidth} seek keys`);
		}

		const tuples: MultiSeekTuple[] = [];
		for (let t = 0; t < inCount; t++) {
			const entries = constraints.slice(t * seekWidth, (t + 1) * seekWidth);
			if (entries.some(e => e.constraint.op !== IndexConstraintOp.EQ || e.argvIndex <= 0)) {
				this.multiSeekMalformed(filterInfo, `seek tuple ${t} carries a non-EQ or unbound constraint`);
			}
			const values = entries.map(e => filterInfo.args[e.argvIndex - 1]);
			if (values.some(v => v === null || v === undefined)) continue;
			tuples.push({ entries, values });
		}
		return { tuples, seekWidth };
	}

	/**
	 * Order one tuple's values to match `keyCols` (the leading index columns, or the
	 * PK definition) using each constraint entry's column. The plan's seek columns and
	 * the constraint list must agree; a tuple that does not cover exactly those
	 * columns is malformed.
	 */
	private orderTupleValues(
		tuple: MultiSeekTuple,
		keyCols: readonly number[],
		filterInfo: FilterInfo,
	): SqlValue[] {
		const byCol = new Map<number, SqlValue>();
		tuple.entries.forEach((e, i) => byCol.set(e.constraint.iColumn, tuple.values[i]));
		if (byCol.size !== keyCols.length) {
			this.multiSeekMalformed(filterInfo, `seek tuple covers ${byCol.size} columns, expected ${keyCols.length}`);
		}
		return keyCols.map(colIdx => {
			if (!byCol.has(colIdx)) this.multiSeekMalformed(filterInfo, `seek tuple missing column ${colIdx}`);
			return byCol.get(colIdx)!;
		});
	}

	/**
	 * Serve a multi-seek (`plan=5`) FilterInfo: one point window per distinct
	 * IN-list tuple, scanned in ascending encoded-key order.
	 *
	 * Window order is not cosmetic. Encoded-byte order IS index-key order (per-column
	 * DESC inversion is baked into the bytes), and the isolation overlay merges an
	 * index scan with its pending rows by (indexKey, PK) — an out-of-order underlying
	 * stream misplaces overlay rows in the output. Two overlap hazards are folded
	 * away before scanning:
	 *   - Tuples whose K-encoded prefix byte-matches (duplicate bound parameters, or
	 *     case variants under a NOCASE table key collation) share ONE window, each
	 *     kept as a residual alternative — see {@link MultiSeekWindowContext} for why
	 *     a single tuple's residual would drop rows when the comparison collation is
	 *     finer than K.
	 *   - A window with no finite upper bound (all-0xff prefix — see
	 *     buildIndexPrefixBounds) contains every later-sorting window outright (any
	 *     key ≥ an all-0xff prefix necessarily starts with it), so those windows fold
	 *     into it instead of re-scanning an overlapping range out of order.
	 *
	 * Emission is lazy per window — `… in (…) limit 1` stops after the first yielded
	 * row without materializing the remaining windows. Each window goes through
	 * {@link scanIndex} → {@link iterateEffective}, so read-your-own-writes and the
	 * stale-entry / deleted-row defenses hold per seek key.
	 */
	protected async *scanMultiSeek(spec: IdxStrSpec, filterInfo: FilterInfo): AsyncIterable<Row> {
		const { tuples, seekWidth } = this.decodeMultiSeekTuples(spec, filterInfo);

		if (spec.indexName === '_primary_') {
			yield* this.scanMultiSeekPrimary(tuples, seekWidth, filterInfo);
			return;
		}

		const index = this.resolveIndexFromIdxStr(filterInfo.idxStr);
		if (!index) this.multiSeekMalformed(filterInfo, `no index named '${spec.indexName}'`);
		const indexCols = index.columns.map(c => c.index);
		const indexDirections = index.columns.map(c => !!c.desc);
		if (seekWidth > indexCols.length) {
			this.multiSeekMalformed(filterInfo, `seekWidth ${seekWidth} exceeds ${index.name}'s ${indexCols.length} columns`);
		}
		const seekCols = indexCols.slice(0, seekWidth);
		// The K-encoded byte windows below carry no residual able to resurrect a
		// skipped row, so a seek column whose byte equality under-fetches the type's
		// equality (TIMESPAN, JSON — see pkHasSemanticOrderingMember) cannot be
		// multi-seeked. StoreModule.tryIndexAccessPlan declines such plans; one
		// arriving anyway is malformed.
		if (seekCols.some(colIdx => hasSemanticOrdering(this.tableSchema!.columns[colIdx]?.logicalType))) {
			this.multiSeekMalformed(filterInfo, 'semantic-ordering seek column');
		}

		// One window per distinct K-encoded tuple prefix; K-equal tuples merge into
		// one window, each kept as a residual alternative.
		const windows = new Map<string, MultiSeekWindow>();
		for (const tuple of tuples) {
			const ordered = this.orderTupleValues(tuple, seekCols, filterInfo);
			const bounds = buildIndexPrefixBounds(ordered, this.encodeOptions, indexDirections.slice(0, seekWidth));
			const hex = bytesToHex(bounds.gte);
			const info: FilterInfo = { ...filterInfo, constraints: tuple.entries };
			const existing = windows.get(hex);
			if (existing) existing.infos.push(info);
			else windows.set(hex, { bounds, infos: [info] });
		}
		if (windows.size === 0) return; // every tuple had a NULL component — nothing matches

		const sorted = [...windows.values()].sort((a, b) => compareBytes(a.bounds.gte, b.bounds.gte));
		const disjoint: MultiSeekWindow[] = [];
		for (const w of sorted) {
			const last = disjoint[disjoint.length - 1];
			if (last && last.bounds.lt === undefined) last.infos.push(...w.infos);
			else disjoint.push(w);
		}

		const indexStore = await this.ensureIndexStore(index.name);
		// Identical for every window (resolveFilterCollations dedups by column), so
		// resolve once and thread it through.
		const collations = this.resolveFilterCollations(filterInfo, this.indexColumnCollations(index));
		const seen = new Set<string>();
		for (const w of disjoint) {
			yield* this.scanIndex(
				indexStore,
				{ index, type: 'point', bounds: w.bounds },
				w.infos[0],
				{ seen, collations, extraTuples: w.infos.slice(1) },
			);
		}
	}

	/**
	 * Multi-seek over the PRIMARY key: each tuple is a full PK, resolved by a point
	 * read in ascending encoded-data-key order (the table's native emission order).
	 *
	 * NOT reachable from this module's own plans today: `StoreModule.computeBestAccessPlan`
	 * claims IN-list filters only for secondary indexes (see its EQ_OPS vs EQ_OR_IN_OPS
	 * split and tickets/backlog/feat-store-pk-in-list-multiseek). The branch exists so
	 * a `_primary_` multi-seek arriving from a future plan gets a correct answer rather
	 * than the scan arm's silent zero rows, and it is what PK-IN enablement will build on.
	 */
	protected async *scanMultiSeekPrimary(
		tuples: MultiSeekTuple[],
		seekWidth: number,
		filterInfo: FilterInfo,
	): AsyncIterable<Row> {
		const pkColumns = this.tableSchema!.primaryKeyDefinition.map(pk => pk.index);
		if (pkColumns.length === 0) {
			this.multiSeekMalformed(filterInfo, 'primary-key multi-seek on a table with no primary key');
		}
		if (seekWidth !== pkColumns.length) {
			this.multiSeekMalformed(filterInfo, `seekWidth ${seekWidth} does not cover the ${pkColumns.length}-column primary key`);
		}
		// Mirrors analyzePKAccess's conservative decline of the point arm for such PKs
		// (see pkHasSemanticOrderingMember); with the residual gone there is no scan to
		// degrade to, so fail loudly rather than risk an under-fetch.
		if (this.pkHasSemanticOrderingMember()) {
			this.multiSeekMalformed(filterInfo, 'semantic-ordering primary-key member');
		}

		// Dedup by encoded data key (collapses K-equal tuples), keeping every merged
		// tuple's residual as an alternative — same rationale as the index branch.
		const points = new Map<string, { key: Uint8Array; infos: FilterInfo[] }>();
		for (const tuple of tuples) {
			const ordered = this.orderTupleValues(tuple, pkColumns, filterInfo);
			const key = this.encodeDataKey(ordered);
			const hex = bytesToHex(key);
			const info: FilterInfo = { ...filterInfo, constraints: tuple.entries };
			const existing = points.get(hex);
			if (existing) existing.infos.push(info);
			else points.set(hex, { key, infos: [info] });
		}

		const collations = this.resolveFilterCollations(filterInfo);
		for (const p of [...points.values()].sort((a, b) => compareBytes(a.key, b.key))) {
			const row = await this.readEffectiveRowByKey(p.key);
			if (row && p.infos.some(fi => this.matchesFilters(row, fi, collations))) {
				yield row;
			}
		}
	}

	/**
	 * Check if a row matches the filter constraints.
	 *
	 * `collations` maps a constrained column index to the comparison function that
	 * column must be re-checked under; every caller builds it once per scan with
	 * {@link resolveFilterCollations}, whose doc comment explains how the name is
	 * chosen. A column absent from the map compares BINARY — the same result
	 * {@link resolveFilterCollations} produces for an undeclared collation, and the
	 * only reachable absence, since both walk the constraint list under identical
	 * skip conditions.
	 */
	protected matchesFilters(
		row: Row,
		filterInfo: FilterInfo,
		collations: ReadonlyMap<number, CollationFunction>,
	): boolean {
		if (!filterInfo.constraints || filterInfo.constraints.length === 0) {
			return true;
		}

		for (const constraintEntry of filterInfo.constraints) {
			const { constraint, argvIndex } = constraintEntry;
			if (constraint.iColumn < 0 || argvIndex <= 0) {
				continue;
			}

			const rowValue = row[constraint.iColumn];
			const filterValue = filterInfo.args[argvIndex - 1];
			const collation = collations.get(constraint.iColumn) ?? BINARY_COLLATION;

			// A semantic-ordering column (TIMESPAN, JSON) must filter under the type's
			// compare — the same order the engine's operators and Sort use — or a pushed
			// `d > 'PT90M'` would text-compare and drop rows the predicate admits. The
			// comparator is built per row only on this rare column kind; if a profile
			// ever shows it, resolve it once per scan alongside the collations.
			const logicalType = this.tableSchema!.columns[constraint.iColumn]?.logicalType;
			const compare = hasSemanticOrdering(logicalType)
				? createTypedComparator(logicalType, collation)
				: undefined;

			if (!this.compareValues(rowValue, constraint.op, filterValue, collation, compare)) {
				return false;
			}
		}

		return true;
	}

	/**
	 * Resolve, ONCE per scan, the comparison collation function for every pushed
	 * constraint column, keyed by column index.
	 *
	 * The name for a column is its DECLARED collation (absent ⇒ BINARY) — the same
	 * resolution the access path's collation-cover analysis uses
	 * (indexColumnCollationLookup / primaryKeyCollationLookup) when it decides a
	 * pushed constraint is fully covered, and the same source this file's UNIQUE
	 * checks compare under. On a collation MATCH the planner drops the residual
	 * Filter, so {@link matchesFilters} alone must reproduce the predicate.
	 *
	 * `indexCollationNames` (from {@link indexColumnCollations}) overrides the
	 * declared name for the secondary-index scan arm: the planner's MATCH there is
	 * against the INDEX column's collation, which an explicit `COLLATE` on the index
	 * can make differ from the table column's.
	 *
	 * Names resolve against {@link collationResolver}, so an unregistered collation
	 * raises `no such collation sequence` at scan setup rather than byte-ordering
	 * every row.
	 *
	 * NOTE: rebuilt on every `query()` / `scanPKRange()` / `scanIndex()` call — one
	 * registry lookup per distinct constrained column, dwarfed by the scan's I/O. If a
	 * point-lookup-heavy profile ever shows it, memoize on the `FilterInfo`.
	 */
	protected resolveFilterCollations(
		filterInfo: FilterInfo,
		indexCollationNames?: ReadonlyMap<number, string | undefined>,
	): ReadonlyMap<number, CollationFunction> {
		const resolved = new Map<number, CollationFunction>();
		if (!filterInfo.constraints) return resolved;

		for (const { constraint, argvIndex } of filterInfo.constraints) {
			if (constraint.iColumn < 0 || argvIndex <= 0) continue;
			if (resolved.has(constraint.iColumn)) continue;

			const name = indexCollationNames?.has(constraint.iColumn)
				? indexCollationNames.get(constraint.iColumn)
				: this.tableSchema!.columns[constraint.iColumn]?.collation;
			resolved.set(constraint.iColumn, name ? this.collationResolver(name) : BINARY_COLLATION);
		}

		return resolved;
	}

	/**
	 * Effective per-column comparison collation for a secondary index's columns:
	 * the index column's own `COLLATE` when present, else the underlying table
	 * column's declared collation. Mirrors the resolution `StoreModule`'s
	 * index-maintenance UNIQUE dedup uses (`indexCol.collation ?? tableColumn`), so
	 * a re-checked index-scan row compares under the same collation the planner used
	 * to justify dropping (or keeping) the residual Filter.
	 */
	protected indexColumnCollations(index: TableIndexSchema): Map<number, string | undefined> {
		const cols = this.tableSchema!.columns;
		const map = new Map<number, string | undefined>();
		for (const c of index.columns) {
			map.set(c.index, c.collation ?? cols[c.index]?.collation);
		}
		return map;
	}

	/**
	 * Compare two values according to an operator, under `collationFunc` (already
	 * resolved by {@link resolveFilterCollations} against this database's collation
	 * registry). So the LT/LE/GT/GE range bounds honour a NOCASE/RTRIM/custom column
	 * collation rather than a raw BINARY JS comparison — the capability
	 * `StoreModule.getBestAccessPlan` advertises via `honorsCollatedRangeBounds`.
	 * NULL on either side fails every operator except EQ-with-both-NULL (the
	 * internal point-lookup convention; the planner never pushes `= NULL`).
	 */
	protected compareValues(
		a: SqlValue,
		op: IndexConstraintOp,
		b: SqlValue,
		collationFunc: CollationFunction,
		semanticCompare?: (a: SqlValue, b: SqlValue) => number,
	): boolean {
		if (a === null || b === null) {
			return op === IndexConstraintOp.EQ ? a === b : false;
		}

		const cmp = semanticCompare ? semanticCompare(a, b) : compareSqlValuesFast(a, b, collationFunc);
		switch (op) {
			case IndexConstraintOp.EQ: return cmp === 0;
			case IndexConstraintOp.NE: return cmp !== 0;
			case IndexConstraintOp.LT: return cmp < 0;
			case IndexConstraintOp.LE: return cmp <= 0;
			case IndexConstraintOp.GT: return cmp > 0;
			case IndexConstraintOp.GE: return cmp >= 0;
			default: return true;
		}
	}

	/** Perform an update operation (INSERT, UPDATE, DELETE). */
	async update(args: UpdateArgs): Promise<UpdateResult> {
		const store = await this.ensureStore();
		const coordinator = await this.ensureCoordinator();
		const inTransaction = coordinator.isInTransaction();
		const schema = this.tableSchema!;
		const { operation, values, oldKeyValues } = args;

		switch (operation) {
			case 'insert': {
				if (!values) throw new QuereusError('INSERT requires values', StatusCode.MISUSE);
				const coerced = args.preCoerced ? values : this.coerceRow(values);
				const pk = this.extractPK(coerced);
				const key = this.encodeDataKey(pk);

				// Check for existing row (for conflict handling).
				// Resolve PK-conflict action: statement OR > per-constraint default > ABORT.
				const pkEffective = args.onConflict ?? resolvePkDefaultConflict(schema) ?? ConflictResolution.ABORT;

				// Trusted-flush safety analysis — why this arm diverges from the others.
				// The insert arm's probe stays committed-only on the trusted-flush path,
				// while the update/delete arms below read the effective
				// (pending-over-committed) image UNCONDITIONALLY. That divergence is
				// safe: `flushOverlayToUnderlying` (isolation, isolated-table.ts) wraps
				// the flush in its own coordinator mini-transaction, the overlay holds
				// at most ONE entry per PK, and tombstone deletes are ordered before
				// inserts/updates — so when any flush write probes its own key, no
				// pending op exists at that key yet in the mini-transaction and the
				// effective read equals the committed read on every trusted probe. The
				// committed-only read kept here is therefore NOT a read-correctness
				// requirement but a pinned INTERNAL invariant: the flush routes existing
				// PKs to update, so a row present here is an isolation-layer violation we
				// must surface loudly (store-backing-host-substrate analysis).
				let existingRow: Row | null;
				if (args.trustedWrite) {
					const committed = await store.get(key);
					existingRow = committed ? deserializeRow(committed) : null;
				} else {
					existingRow = await this.readEffectiveRowByKey(key);
				}
				if (args.trustedWrite) {
					// Trusted flush insert: the overlay flush routes existing PKs to
					// update (via rowExistsInUnderlying), so a row already present here
					// is an isolation-layer invariant violation. Fail loudly rather than
					// silently overwrite — the flush try/catch rolls back and rethrows
					// (isolation-merged-unique-stale-underlying-false-positive).
					if (existingRow) {
						throw new QuereusError(
							`Trusted flush insert on '${this.tableName}' hit an existing PK; the overlay flush should route existing PKs to update. This indicates an isolation-layer invariant violation.`,
							StatusCode.INTERNAL,
						);
					}
				} else if (existingRow) {
					if (pkEffective === ConflictResolution.IGNORE) {
						return { status: 'ok', row: undefined };
					}
					if (pkEffective !== ConflictResolution.REPLACE) {
						return {
							status: 'constraint',
							constraint: 'unique',
							message: `UNIQUE constraint failed: ${this.tableName} PK.`,
							existingRow,
						};
					}
				}

				// Enforce non-PK UNIQUE constraints. Pass the original statement-level
				// onConflict so checkUniqueConstraints can resolve each UC's own
				// defaultConflict independently of the PK's default. Secondary-UNIQUE
				// REPLACE evictions accumulate in `evicted` for the executor pipeline.
				// Skipped for trusted flush writes: the overlay already validated the
				// final state and a value-swap cycle cannot pass a row-by-row re-check.
				const evicted: Row[] = [];
				if (!args.trustedWrite) {
					const ucResult = await this.checkUniqueConstraints(
						inTransaction,
						coerced,
						[pk],
						args.onConflict,
						evicted,
					);
					if (ucResult) return ucResult;
				}

				const oldRow = existingRow;
				const serializedRow = serializeRow(coerced);
				if (inTransaction) {
					coordinator.put(key, serializedRow, store);
				} else {
					await store.put(key, serializedRow);
				}

				// Update secondary indexes. An effective `oldRow` (a pending row at the
				// same PK, evicted under REPLACE) cancels the earlier pending index-put;
				// a commit-batch delete of a never-committed index key is a harmless no-op.
				await this.updateSecondaryIndexes(inTransaction, oldRow, coerced, pk);

				// Track statistics (only count as new if not replacing)
				if (!existingRow) {
					this.trackMutation(+1, inTransaction);
				}

				// Queue or emit event
				if (oldRow) {
					// REPLACE — emit as update
					const updateEvent = {
						type: 'update' as const,
						schemaName: schema.schemaName,
						tableName: schema.name,
						key: pk,
						oldRow,
						newRow: coerced,
					};
					if (inTransaction) {
						coordinator.queueEvent(updateEvent);
					} else {
						this.eventEmitter?.emitDataChange(updateEvent);
					}
				} else {
					const insertEvent = {
						type: 'insert' as const,
						schemaName: schema.schemaName,
						tableName: schema.name,
						key: pk,
						newRow: coerced,
					};
					if (inTransaction) {
						coordinator.queueEvent(insertEvent);
					} else {
						this.eventEmitter?.emitDataChange(insertEvent);
					}
				}

				return { status: 'ok', row: coerced, replacedRow: oldRow ?? undefined, evictedRows: evicted.length > 0 ? evicted : undefined };
			}

			case 'update': {
				if (!values || !oldKeyValues) throw new QuereusError('UPDATE requires values and oldKeyValues', StatusCode.MISUSE);
				const coerced = args.preCoerced ? values : this.coerceRow(values);
				const oldPk = this.extractPK(oldKeyValues);
				const newPk = this.extractPK(coerced);
				const oldKey = this.encodeDataKey(oldPk);
				const newKey = this.encodeDataKey(newPk);

				// Get old row for index updates. Read the effective
				// (pending-over-committed) image UNCONDITIONALLY — including the trusted
				// flush path — so an old image written earlier in the same transaction is
				// visible. This fixes index cleanup, the `uniqueColumnsChanged` gate, and
				// the event's `oldRow`. Trusted is safe here (see the insert-arm comment):
				// deletes-first ordering + one-entry-per-PK ⇒ effective ≡ committed on a
				// flush write probing its own key.
				const oldRow = await this.readEffectiveRowByKey(oldKey);

				// A PK "change" only relocates the row when the ENCODED key differs.
				// Under a non-binary PK collation (e.g. NOCASE) a case-only rewrite
				// ('apple' → 'APPLE') keeps the same physical key, so it is an in-place
				// update, not a relocation. Comparing raw values via keysEqual would
				// mis-classify it as a move and then false-detect a PK conflict against
				// the row's own existing entry at newKey (== oldKey). The encoded keys
				// are the storage layer's source of truth (mirrors the rekey path above).
				const pkChanged = !bytesEqual(oldKey, newKey);

				// Resolve PK-conflict action: statement OR > per-constraint default > ABORT.
				const pkEffective = args.onConflict ?? resolvePkDefaultConflict(schema) ?? ConflictResolution.ABORT;

				// PK-change UPDATE collides like an INSERT at the new key.
				// Capture the evicted row so it can be reported via `replacedRow`
				// (consumed by the executor for ON DELETE cascade/SET NULL of the
				// row at the new PK). Read the effective (pending-over-committed) image
				// so an evictee written earlier in the same transaction conflicts/evicts
				// rather than being silently overwritten.
				// Skipped for trusted flush writes — the overlay flush never changes a
				// row's PK (oldKeyValues and the row's PK columns are the same overlay
				// entry), so pkChanged is false there; the guard makes the intent explicit.
				let replacedAtNewPk: Row | null = null;
				if (pkChanged && !args.trustedWrite) {
					const existingAtNewRow = await this.readEffectiveRowByKey(newKey);
					if (existingAtNewRow) {
						if (pkEffective === ConflictResolution.IGNORE) {
							return { status: 'ok', row: undefined };
						}
						if (pkEffective !== ConflictResolution.REPLACE) {
							return {
								status: 'constraint',
								constraint: 'unique',
								message: `UNIQUE constraint failed: ${this.tableName} PK.`,
								existingRow: existingAtNewRow,
							};
						}
						replacedAtNewPk = existingAtNewRow;
					}
				}

				// Enforce non-PK UNIQUE constraints. For same-PK UPDATE, only check
				// constraints whose covered columns actually changed; pass [oldPk]
				// (= newPk) to skip self. For PK-change UPDATE, treat as relocation:
				// skip both old and new PK so we don't false-conflict against the
				// row we're moving. Pass the original statement-level onConflict so
				// each UC's own defaultConflict can be resolved independently.
				const selfPks: SqlValue[][] = pkChanged ? [oldPk, newPk] : [oldPk];
				// Skip the UNIQUE re-check for trusted flush writes: the overlay
				// merged-view check already validated the final state, and a value-swap
				// cycle cannot pass a row-by-row logical-UNIQUE re-check
				// (isolation-merged-unique-stale-underlying-false-positive).
				const shouldCheckUniques = !args.trustedWrite
					&& (pkChanged || (oldRow ? this.uniqueColumnsChanged(oldRow, coerced) : true));
				// Secondary-UNIQUE REPLACE evictions accumulate for the executor pipeline.
				const evicted: Row[] = [];
				if (shouldCheckUniques) {
					const ucResult = await this.checkUniqueConstraints(
						inTransaction,
						coerced,
						selfPks,
						args.onConflict,
						evicted,
					);
					if (ucResult) return ucResult;
				}

				// When REPLACE evicted a row at the new PK, fully delete it first
				// (data + secondary indexes + row-count + delete event) so its
				// state doesn't leak when we then put the moved row at newPk.
				// Mirrors MemoryTable's `recordDelete(newPK, existingRowAtNewKey)`
				// step in the PK-change-REPLACE path.
				if (replacedAtNewPk) {
					await this.deleteRowAt(inTransaction, newPk, replacedAtNewPk);
				}

				// Delete old key if PK changed
				if (pkChanged) {
					if (inTransaction) {
						coordinator.delete(oldKey, store);
					} else {
						await store.delete(oldKey);
					}
				}

				const serializedRow = serializeRow(coerced);
				if (inTransaction) {
					coordinator.put(newKey, serializedRow, store);
				} else {
					await store.put(newKey, serializedRow);
				}

				// Update secondary indexes. For PK-change UPDATE the old entry lives
				// at oldPk and the new entry must land at newPk; for same-PK UPDATE
				// both halves use the same key.
				await this.updateSecondaryIndexes(inTransaction, oldRow, coerced, oldPk, newPk);

				// Queue or emit event
				const updateEvent = {
					type: 'update' as const,
					schemaName: schema.schemaName,
					tableName: schema.name,
					key: newPk,
					oldRow: oldRow || undefined,
					newRow: coerced,
				};
				if (inTransaction) {
					coordinator.queueEvent(updateEvent);
				} else {
					this.eventEmitter?.emitDataChange(updateEvent);
				}

				return { status: 'ok', row: coerced, replacedRow: replacedAtNewPk ?? undefined, evictedRows: evicted.length > 0 ? evicted : undefined };
			}

			case 'delete': {
				if (!oldKeyValues) throw new QuereusError('DELETE requires oldKeyValues', StatusCode.MISUSE);
				const pk = this.extractPK(oldKeyValues);
				const key = this.encodeDataKey(pk);

				// Get old row for index cleanup. Read the effective
				// (pending-over-committed) image so a row inserted earlier in the same
				// transaction is seen: this fixes index cleanup, the `-1` stats delta
				// (netting an insert+delete to zero), and the event's `oldRow`.
				// `coordinator.delete(key)` cancels a pending put; a commit-batch delete
				// of a never-committed key is a harmless no-op. The trusted flush delete
				// arm does NOT pass `trustedWrite`, but deletes-first ordering +
				// one-entry-per-PK keep effective ≡ committed there too (see insert arm).
				const oldRow = await this.readEffectiveRowByKey(key);

				if (inTransaction) {
					coordinator.delete(key, store);
				} else {
					await store.delete(key);
				}

				// Remove from secondary indexes
				if (oldRow) {
					await this.updateSecondaryIndexes(inTransaction, oldRow, null, pk);
					this.trackMutation(-1, inTransaction);
				}

				// Queue or emit event
				const deleteEvent = {
					type: 'delete' as const,
					schemaName: schema.schemaName,
					tableName: schema.name,
					key: pk,
					oldRow: oldRow || undefined,
				};
				if (inTransaction) {
					coordinator.queueEvent(deleteEvent);
				} else {
					this.eventEmitter?.emitDataChange(deleteEvent);
				}

				return { status: 'ok', row: oldRow || undefined };
			}

			default:
				throw new QuereusError(`Unknown operation: ${operation}`, StatusCode.MISUSE);
		}
	}

	/**
	 * Update secondary indexes after a row change.
	 *
	 * For PK-change UPDATE, `oldPk` (where the existing entry lives) and `newPk`
	 * (where the relocated entry will live) differ; using a single pk for both
	 * sides leaks the old entry. Other paths pass the same pk for both.
	 */
	protected async updateSecondaryIndexes(
		inTransaction: boolean,
		oldRow: Row | null,
		newRow: Row | null,
		oldPk: SqlValue[],
		newPk: SqlValue[] = oldPk,
	): Promise<void> {
		// Maintain the MATERIALIZED index set: the hidden `_uc_*` per-UNIQUE index must be
		// kept in step with DML so the enforcement seek finds every live row.
		const indexes = this.materializedSchema.indexes || [];

		for (const index of indexes) {
			const indexStore = await this.ensureIndexStore(index.name);
			const indexCols = index.columns.map(c => c.index);
			const indexDirections = index.columns.map(c => !!c.desc);
			// Canonicalize semantic-ordering index members ('PT1H'/'PT60M' → one key) so a
			// UNIQUE enforcement seek and delete-then-insert maintenance address one entry.
			const indexTransforms = resolveIndexKeyTransforms(index, this.tableSchema!.columns);

			// Partial index: only rows the predicate unambiguously accepts are
			// indexed (mirrors buildIndexEntries' build-time filtering). Guarding both
			// halves keeps a row that transitions across the predicate scope on UPDATE
			// correct — an in-scope→out-of-scope edit removes the old entry and adds
			// none; the reverse adds without a stale delete. A full index (no
			// predicate) always maintains its entry.
			const predicate = this.compileIndexFor(index);

			// Remove old index entry (only if the old row was within scope).
			if (oldRow && (!predicate || predicate.evaluate(oldRow) === true)) {
				const oldIndexValues = indexCols.map(i => oldRow[i]);
				const oldIndexKey = buildIndexKey(
					oldIndexValues,
					oldPk,
					this.encodeOptions,
					indexDirections,
					this.pkDirections,
					this.pkKeyCollations,
					indexTransforms,
					this.pkKeyTransforms,
				);

				if (inTransaction && this.coordinator) {
					this.coordinator.delete(oldIndexKey, indexStore);
				} else {
					await indexStore.delete(oldIndexKey);
				}
			}

			// Add new index entry (only if the new row is within scope).
			if (newRow && (!predicate || predicate.evaluate(newRow) === true)) {
				const newIndexValues = indexCols.map(i => newRow[i]);
				const newIndexKey = buildIndexKey(
					newIndexValues,
					newPk,
					this.encodeOptions,
					indexDirections,
					this.pkDirections,
					this.pkKeyCollations,
					indexTransforms,
					this.pkKeyTransforms,
				);
				// Index value = the row's encoded DATA key. The index-entry key can
				// locate a row's byte window, but its PK suffix is not losslessly
				// recoverable to SqlValues (a NOCASE/RTRIM PK column encodes lossily)
				// and its length varies per entry in a range scan — so a scan resolves
				// each entry back to its base row via this stored data key
				// (`scanIndex` → `readEffectiveRowByKey(entry.value)`), never by
				// decoding the suffix. `newPk` is the PK the entry is keyed under, so
				// its data key byte-matches the data store's key for this row.
				const dataKeyValue = this.encodeDataKey(newPk);

				if (inTransaction && this.coordinator) {
					this.coordinator.put(newIndexKey, dataKeyValue, indexStore);
				} else {
					await indexStore.put(newIndexKey, dataKeyValue);
				}
			}
		}
	}

	/**
	 * Returns the compiled predicate for a partial-UNIQUE constraint, or undefined
	 * when the constraint covers the full table. Compilation is memoized per
	 * UniqueConstraintSchema instance so the hot UNIQUE-check path doesn't recompile.
	 */
	private compileFor(uc: UniqueConstraintSchema): CompiledPredicate | undefined {
		if (!uc.predicate) return undefined;
		let compiled = this.predicateCache.get(uc);
		if (!compiled) {
			compiled = compilePredicate(uc.predicate, this.tableSchema!.columns, this.tableSchema!.name);
			this.predicateCache.set(uc, compiled);
		}
		return compiled;
	}

	/**
	 * Returns the compiled predicate for a partial secondary index, or undefined
	 * for a full index. Compilation is memoized per IndexSchema instance so the hot
	 * DML index-maintenance path doesn't recompile.
	 */
	private compileIndexFor(index: TableIndexSchema): CompiledPredicate | undefined {
		if (!index.predicate) return undefined;
		let compiled = this.indexPredicateCache.get(index);
		if (!compiled) {
			compiled = compilePredicate(index.predicate, this.tableSchema!.columns, this.tableSchema!.name);
			this.indexPredicateCache.set(index, compiled);
		}
		return compiled;
	}

	/**
	 * Check if two PK arrays name the same row. A semantic-ordering member compares
	 * through its type's `compare` (see {@link resolvePkSemanticEquality}) so
	 * differently-spelled equal values ('PT1H' / 'PT60M') answer "same row",
	 * agreeing with the physical key identity {@link encodeDataKey} produces; every
	 * other member keeps the original strict `!==`.
	 */
	protected keysEqual(a: SqlValue[], b: SqlValue[]): boolean {
		if (a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) {
			const semantic = this.pkSemanticEquality[i];
			if (semantic ? semantic(a[i], b[i]) !== 0 : a[i] !== b[i]) return false;
		}
		return true;
	}

	/**
	 * Per-constrained-column comparison functions for one UNIQUE constraint: the
	 * type's `compare` for a semantic-ordering column (so 'PT1H' conflicts with
	 * 'PT60M', matching the memory backend's typed BTree), else the enforcement
	 * collation the caller resolved (`resolveUniqueEnforcementCollations`) through
	 * `compareSqlValuesFast` — the exact comparison every finder used before.
	 *
	 * Thin wrapper over the engine's `uniqueEnforcementComparators`, which memory
	 * and the isolation overlay share so the three backends cannot drift.
	 */
	private uniqueColumnComparators(
		uc: UniqueConstraintSchema,
		collations: ReadonlyArray<CollationFunction>,
	): ((a: SqlValue, b: SqlValue) => number)[] {
		return uniqueEnforcementComparators(this.tableSchema!.columns, uc.columns, collations);
	}

	/**
	 * Returns true if any column covered by a UNIQUE constraint differs between
	 * oldRow and newRow, or — for partial UNIQUE — any column referenced by the
	 * partial predicate differs (which can transition the row across the
	 * predicate scope and re-trigger the uniqueness check).
	 */
	protected uniqueColumnsChanged(oldRow: Row, newRow: Row): boolean {
		const ucs = this.tableSchema?.uniqueConstraints;
		if (!ucs || ucs.length === 0) return false;
		for (const uc of ucs) {
			for (const colIdx of uc.columns) {
				if (compareSqlValues(oldRow[colIdx], newRow[colIdx]) !== 0) return true;
			}
			if (uc.predicate) {
				const compiled = this.compileFor(uc);
				if (compiled) {
					for (const colIdx of compiled.referencedColumns) {
						if (compareSqlValues(oldRow[colIdx], newRow[colIdx]) !== 0) return true;
					}
				}
			}
		}
		return false;
	}

	/**
	 * Enforce table-level UNIQUE constraints against the prospective newRow.
	 * Honors `onConflict`: IGNORE returns an ok-with-undefined-row; REPLACE
	 * deletes the conflicting row(s) and continues; otherwise returns a
	 * constraint result. Returns null when all constraints pass.
	 *
	 * Rows whose PK is in `selfPks` are skipped (the row being inserted/updated).
	 * NULL in any covered column skips that constraint (multiple NULLs are allowed
	 * per SQL standard).
	 *
	 * Reads through the transaction coordinator's pending writes when active so
	 * intra-transaction duplicates are detected.
	 *
	 * REPLACE evictions (rows at OTHER PKs) are deleted from storage and pushed onto
	 * `evicted` so the DML executor runs the full delete pipeline for each
	 * (change-tracking, row-time MV maintenance, FK cascade, auto-events).
	 */
	protected async checkUniqueConstraints(
		inTransaction: boolean,
		newRow: Row,
		selfPks: SqlValue[][],
		onConflict: ConflictResolution | undefined,
		evicted: Row[],
	): Promise<UpdateResult | null> {
		const schema = this.tableSchema!;
		const uniqueConstraints = schema.uniqueConstraints;
		if (!uniqueConstraints || uniqueConstraints.length === 0) return null;

		for (const uc of uniqueConstraints) {
			if (uc.columns.some(idx => newRow[idx] === null)) continue;

			// Partial UNIQUE: a row whose predicate is not unambiguously TRUE is
			// outside the index's scope and contributes nothing to uniqueness.
			const predicate = this.compileFor(uc);
			if (predicate && predicate.evaluate(newRow) !== true) continue;

			const conflict = await this.findUniqueConflictFor(uc, predicate, newRow, selfPks);
			if (!conflict) continue;

			// Resolve action per-constraint: statement OR > per-UC default > ABORT.
			const effective = onConflict ?? uc.defaultConflict ?? ConflictResolution.ABORT;
			if (effective === ConflictResolution.IGNORE) {
				return { status: 'ok', row: undefined };
			}
			if (effective === ConflictResolution.REPLACE) {
				await this.deleteRowAt(inTransaction, conflict.pk, conflict.row);
				// Report the eviction so the executor runs its full delete pipeline —
				// including the row-time covering-structure maintenance that drops the
				// evicted source row's backing entry within this statement (else a later
				// same-UC row sees a phantom). The executor processes the eviction before
				// the writing row's own bookkeeping, so the backing delete still lands
				// mid-statement.
				evicted.push(conflict.row);
				continue;
			}
			const colNames = uc.columns.map(i => schema.columns[i].name).join(', ');
			return {
				status: 'constraint',
				constraint: 'unique',
				message: `UNIQUE constraint failed: ${schema.name} (${colNames})`,
				existingRow: conflict.row,
			};
		}
		return null;
	}

	/**
	 * Route one UNIQUE constraint's conflict search to the cheapest SOUND finder,
	 * in descending preference:
	 *
	 *  1. A linked row-time covering MV — its backing table (hosted by any
	 *     backing-host-capable module — memory by default, this store module under
	 *     `using store` — queried through the db with reads-own-writes) answers the
	 *     uniqueness question, mirroring the memory enforcement path.
	 *  2. A physical secondary index realizing the constraint — one prefix seek
	 *     instead of a full table scan (see {@link findIndexForUniqueConstraint}).
	 *  3. The full data-store scan ({@link findUniqueConflict}) — always correct,
	 *     O(rows) per checked row.
	 *
	 * Every finder returns the SAME `{pk, row}` shape, so the caller's conflict
	 * action (ABORT / IGNORE / REPLACE eviction) is finder-independent.
	 */
	private async findUniqueConflictFor(
		uc: UniqueConstraintSchema,
		predicate: CompiledPredicate | undefined,
		newRow: Row,
		selfPks: SqlValue[][],
	): Promise<UniqueConflict | null> {
		const schema = this.tableSchema!;
		const coveringMv = (this.db as DatabaseInternal)._findRowTimeCoveringStructure(schema.schemaName, schema.name, uc);
		if (coveringMv) return this.findUniqueConflictViaCoveringMv(coveringMv, uc, predicate, newRow, selfPks);

		const index = this.findIndexForUniqueConstraint(uc);
		if (index) {
			const viaIndex = await this.findUniqueConflictViaIndex(index, uc, predicate, newRow, selfPks);
			if (viaIndex !== INDEX_UNUSABLE) return viaIndex;
		}
		return this.findUniqueConflict(uc, predicate, newRow, selfPks);
	}

	/**
	 * The `schema.indexes` entry whose physical index store can serve `uc`'s
	 * conflict search as a point seek, or undefined when none can.
	 *
	 * Every non-derived UNIQUE now carries a materialized implicit index
	 * (`_uc_*`, see {@link withImplicitUniqueIndexes}), so — like the memory
	 * backend — a plain column- or table-level `UNIQUE` is index-servable, not
	 * only an explicit `CREATE INDEX`. A UC is index-servable when:
	 *
	 *  - it is index-derived (`derivedFromIndex`, from `CREATE UNIQUE INDEX`) and
	 *    its named index is still present — the index's partial predicate then
	 *    equals the constraint's by construction (`appendIndexToTableSchema`); or
	 *  - some index's columns equal `uc.columns` positionally AND whose predicate
	 *    is the SAME object as `uc.predicate` (reference identity — the implicit
	 *    materializer sets it that way). For a FULL UNIQUE that is
	 *    `undefined === undefined`, which also admits any user full index over the
	 *    same columns. For a PARTIAL `unique(...) where p` it admits only the
	 *    co-scoped `_uc_*` (which holds exactly the in-scope rows); an arbitrary
	 *    user partial index with a DIFFERENT predicate object stays conservative
	 *    (declined → full scan), because it physically omits rows the constraint
	 *    still covers. The serving index need not be UNIQUE — a plain index over
	 *    the constrained columns still holds every in-scope row.
	 *
	 * Collation guard (see {@link indexSeekHonorsEnforcementCollation}) may still
	 * reject the found index, which routes the check back to the full scan.
	 */
	private findIndexForUniqueConstraint(uc: UniqueConstraintSchema): TableIndexSchema | undefined {
		// NOTE: re-resolved for every constrained ROW written, and the collation guard
		// below re-derives `uniqueEnforcementCollations` each time. Both are linear in
		// `schema.indexes` / `uc.columns` and dwarfed by the seek's I/O, so this is fine
		// now. If a table with many indexes ever shows up on an insert-heavy profile,
		// memoize the (uc → index | undefined) resolution in a WeakMap keyed on the
		// frozen UniqueConstraintSchema, as `predicateCache` above does — a CREATE/DROP
		// INDEX yields fresh constraint objects, so such a cache invalidates itself.
		// Reads the MATERIALIZED index set so the hidden `_uc_*` realizing a plain UNIQUE
		// is visible (the engine-facing `tableSchema` carries only explicit/derived indexes).
		const indexes = this.materializedSchema.indexes;
		if (!indexes || indexes.length === 0) return undefined;

		const index = uc.derivedFromIndex
			? indexes.find(ix => ix.name === uc.derivedFromIndex)
			: indexes.find(ix => ix.predicate === uc.predicate
				&& ix.columns.length === uc.columns.length
				&& ix.columns.every((c, i) => c.index === uc.columns[i]));
		if (!index) return undefined;
		return this.indexSeekHonorsEnforcementCollation(uc) ? index : undefined;
	}

	/**
	 * True when a point seek into the index realizing `uc` returns a SUPERSET of
	 * the constraint's true conflict set — the only condition under which the
	 * seek may replace the full scan.
	 *
	 * An index key's leading (index-column) bytes are encoded under the TABLE KEY
	 * collation K (`buildIndexKey` passes `this.encodeOptions`), NOT the index's
	 * declared per-column COLLATE and NOT the constraint's enforcement collation
	 * C (`uniqueEnforcementCollations` — the index's per-column COLLATE for an
	 * index-derived UC, else the declared column collation). A seek therefore
	 * fetches exactly `{rows K-equal to newRow}` while the re-validation keeps
	 * `{rows C-equal to newRow}`. Soundness needs
	 * `{C-equal} ⊆ {K-equal}`, i.e. K must be COARSER-OR-EQUAL to C per column:
	 *
	 *  - non-text column → its bytes are type-native, collation-independent: safe.
	 *  - C == K → the sets coincide: safe.
	 *  - K = NOCASE, C = BINARY → K strictly coarser: safe superset.
	 *  - otherwise (K = BINARY over C = NOCASE/RTRIM; K = NOCASE over C = RTRIM)
	 *    the seek UNDER-fetches and a real duplicate would be silently accepted:
	 *    reject, so the caller full-scans.
	 *
	 * Same direction and same admitted cases as the read-side guard in
	 * `StoreModule.tryIndexAccessPlan`; conservative rather than exhaustive
	 * (K = RTRIM over C = BINARY is provably safe but declined), which costs an
	 * optimization, never correctness. The coarseness test is only sound for the
	 * built-in names: a custom K equals a custom C only when the index column names
	 * that same collation, and otherwise falls through to the full scan.
	 */
	private indexSeekHonorsEnforcementCollation(uc: UniqueConstraintSchema): boolean {
		const schema = this.tableSchema!;
		const K = (this.encodeOptions.collation ?? 'NOCASE').toUpperCase();

		const collations = uniqueEnforcementCollations(schema, uc);
		return uc.columns.every((colIdx, i) => {
			if (!columnCanHoldText(schema.columns[colIdx])) return true;
			const C = (collations[i] ?? 'BINARY').toUpperCase();
			return C === K || (K === 'NOCASE' && C === 'BINARY');
		});
	}

	/**
	 * The index analogue of {@link findUniqueConflict}: seek the index realizing
	 * `uc` at the point formed by `newRow`'s constrained-column values, and
	 * re-validate each resolved candidate exactly as the full scan does.
	 *
	 * The seek encodes ALL of `uc.columns` (positionally aligned with the index's
	 * columns, guaranteed by `appendIndexToTableSchema` / the column-set match in
	 * {@link findIndexForUniqueConstraint}) as a leading prefix of the index key,
	 * under the same key collation and per-column DESC directions
	 * {@link updateSecondaryIndexes} used to write it. The remaining suffix is the
	 * row's PK, so the window spans every entry sharing those column values.
	 * {@link iterateEffective} merges this transaction's pending index puts/deletes
	 * over the committed entries, giving read-your-own-writes; each entry resolves
	 * to its LIVE row through the data key stored as the entry's value.
	 *
	 * The seek only narrows the CANDIDATE set to a superset (guaranteed by
	 * {@link indexSeekHonorsEnforcementCollation}); the authoritative comparison is
	 * the identical self-PK exclusion, per-column enforcement-collation compare,
	 * and partial-predicate scope check the full scan performs. A partial index
	 * already excludes out-of-scope rows physically — the predicate re-check is
	 * kept as defense in depth.
	 *
	 * Returns {@link INDEX_UNUSABLE} rather than a (possibly wrong) answer when an
	 * entry carries a legacy empty value.
	 */
	private async findUniqueConflictViaIndex(
		index: TableIndexSchema,
		uc: UniqueConstraintSchema,
		predicate: CompiledPredicate | undefined,
		newRow: Row,
		selfPks: SqlValue[][],
	): Promise<UniqueConflict | null | typeof INDEX_UNUSABLE> {
		const indexStore = await this.ensureIndexStore(index.name);
		// Resolved once, above the candidate loop: the resolver throws on an
		// unregistered name and cannot be inlined, so a per-candidate call would be
		// pure overhead.
		const collations = resolveUniqueEnforcementCollations(this.tableSchema!, uc, this.collationResolver);
		const compares = this.uniqueColumnComparators(uc, collations);
		// Same per-column transforms `updateSecondaryIndexes` wrote the entries under, so
		// the probe for 'PT60M' lands on the window holding the 'PT1H' entry.
		const bounds = buildIndexPrefixBounds(
			uc.columns.map(c => newRow[c]),
			this.encodeOptions,
			index.columns.map(c => !!c.desc),
			resolveIndexKeyTransforms(index, this.tableSchema!.columns),
		);

		for await (const entry of this.iterateEffective(indexStore, bounds)) {
			// A legacy index store (written before index values carried the data key)
			// holds EMPTY values. `scanIndex` may skip such an entry — a read that
			// returns too few rows. Skipping here would instead ACCEPT a duplicate, so
			// abandon the index and let the caller full-scan. See the NOTE in
			// `scanIndex` for the durable fix.
			if (entry.value.length === 0) return INDEX_UNUSABLE;

			// Resolve to the LIVE row: a pending index delete normally suppresses the
			// entry, but a committed entry can lag a row deleted this transaction.
			const candidate = await this.readEffectiveRowByKey(entry.value);
			if (!candidate) continue;

			const pk = this.extractPK(candidate);
			if (selfPks.some(skip => this.keysEqual(pk, skip))) continue;
			if (uc.columns.some((c, i) => compares[i](newRow[c], candidate[c]) !== 0)) continue;
			if (predicate && predicate.evaluate(candidate) !== true) continue;
			return { pk, row: candidate };
		}
		return null;
	}

	/**
	 * Scan committed + pending data rows for a row matching `newRow` on
	 * `uc.columns` whose PK is not in `selfPks`. For partial UNIQUE, candidates
	 * whose row does not satisfy the predicate are skipped. Returns the first
	 * match or null.
	 */
	private async findUniqueConflict(
		uc: UniqueConstraintSchema,
		predicate: CompiledPredicate | undefined,
		newRow: Row,
		selfPks: SqlValue[][],
	): Promise<UniqueConflict | null> {
		const store = await this.ensureStore();
		// Pending ops for THIS table's data store handle — the same handle the
		// write path queues data ops under, so the merge sees only this table's
		// pending state, never a sibling table's on the shared module coordinator.
		const pending = this.coordinator?.isInTransaction()
			? this.coordinator.getPendingOpsForStore(store)
			: null;
		const constrainedCols = uc.columns;
		// One comparison collation per constrained column — the index's per-column
		// COLLATE for an index-derived UNIQUE, else the declared column collation.
		// Resolved once here, not per candidate row.
		const collations = resolveUniqueEnforcementCollations(this.tableSchema!, uc, this.collationResolver);
		const compares = this.uniqueColumnComparators(uc, collations);

		const matches = (candidate: Row): UniqueConflict | null => {
			const pk = this.extractPK(candidate);
			for (const skip of selfPks) {
				if (this.keysEqual(pk, skip)) return null;
			}
			for (let i = 0; i < constrainedCols.length; i++) {
				const idx = constrainedCols[i];
				if (compares[i](newRow[idx], candidate[idx]) !== 0) return null;
			}
			// Partial UNIQUE: candidate must also be in the predicate's scope to conflict.
			if (predicate && predicate.evaluate(candidate) !== true) return null;
			return { pk, row: candidate };
		};

		const seen = new Set<string>();
		const bounds = buildFullScanBounds();
		for await (const entry of store.iterate(bounds)) {
			const hex = bytesToHex(entry.key);
			seen.add(hex);
			if (pending?.deletes.has(hex)) continue;
			const overlay = pending?.puts.get(hex);
			const value = overlay ? overlay.value : entry.value;
			const found = matches(deserializeRow(value));
			if (found) return found;
		}

		if (pending) {
			for (const [hex, op] of pending.puts) {
				if (seen.has(hex)) continue;
				const found = matches(deserializeRow(op.value));
				if (found) return found;
			}
		}
		return null;
	}

	/**
	 * Find a UNIQUE conflict through a linked row-time covering MV's backing table
	 * (the store analogue of the memory `checkUniqueViaMaterializedView`). The
	 * backing scan yields candidate conflicting **source** PKs (reads-own-writes via
	 * the backing's coordinated connection); each is validated against the *live*
	 * store row (committed + this transaction's pending overlay) so a backing entry
	 * that lags a row deleted/updated internally this statement is skipped rather
	 * than raised as a false conflict. Returns the first real conflict or null.
	 */
	private async findUniqueConflictViaCoveringMv(
		mv: MaintainedTableSchema,
		uc: UniqueConstraintSchema,
		predicate: CompiledPredicate | undefined,
		newRow: Row,
		selfPks: SqlValue[][],
	): Promise<UniqueConflict | null> {
		const newSourcePk = this.extractPK(newRow);
		// Resolved once, above the candidate loop.
		const collations = resolveUniqueEnforcementCollations(this.tableSchema!, uc, this.collationResolver);
		const compares = this.uniqueColumnComparators(uc, collations);
		const candidates = await (this.db as DatabaseInternal)._lookupCoveringConflicts(mv, uc, newRow, newSourcePk);
		for (const cand of candidates) {
			const liveRow = await this.readLiveRowByPk(cand.pk);
			if (!liveRow) continue; // stale backing candidate (source row gone)
			if (selfPks.some(pk => this.keysEqual(pk, cand.pk))) continue;
			// Re-validate under each column's enforcement collation (the index's
			// per-column COLLATE for an index-derived UNIQUE, else declared) — see
			// uniqueEnforcementCollations. The candidate generation
			// (_lookupCoveringConflicts) narrows under the SOURCE column's declared
			// collation, so for a FINER index (BINARY over a NOCASE column) it returns a
			// superset this filters down correctly. A finer/incomparable index-derived
			// UNIQUE whose declared candidate set could be a SUBSET (e.g. a coarser NOCASE
			// index over a BINARY column) is declined upstream by the collation gate in
			// findRowTimeCoveringStructure, so only BINARY-floor or equal-collation MVs
			// reach here — the superset this re-validation can soundly filter.
			if (uc.columns.some((c, i) => compares[i](newRow[c], liveRow[c]) !== 0)) continue;
			if (predicate && predicate.evaluate(liveRow) !== true) continue;
			return { pk: cand.pk, row: liveRow };
		}
		return null;
	}

	/**
	 * Read the live row at `pk` — this transaction's pending overlay (a pending
	 * delete ⇒ gone; a pending put ⇒ its value) shadowing the committed store.
	 * Backs `query()`'s point-lookup arm and validates covering-MV conflict
	 * candidates against the source of truth.
	 */
	private async readLiveRowByPk(pk: SqlValue[]): Promise<Row | null> {
		return this.readEffectiveRowByKey(this.encodeDataKey(pk));
	}

	// ── Backing-host surface ──────────────────────────────────────────────
	// Narrow public surface `StoreBackingHost` (backing-host.ts) drives. Each
	// method addresses the table's CURRENT schema/encoding state, so a host
	// resolved fresh per engine call always keys and merges consistently with
	// the table's own read/write paths.

	/** Encode `pkValues` (in PK-definition order) exactly as the data store keys rows. */
	encodeDataKey(pkValues: SqlValue[]): Uint8Array {
		return buildDataKey(pkValues, this.encodeOptions, this.pkDirections, this.pkKeyCollations, this.pkKeyTransforms);
	}

	/**
	 * Byte bounds covering every data key whose leading PK columns equal
	 * `prefixValues` — encoded under the same per-column DESC directions and key
	 * collations as {@link encodeDataKey}, so seek + early-terminate addresses the
	 * exact slice. An empty prefix yields full-scan bounds.
	 */
	encodePkPrefixBounds(prefixValues: SqlValue[]): { gte: Uint8Array; lt?: Uint8Array } {
		return buildPkPrefixBounds(
			prefixValues,
			this.encodeOptions,
			this.pkDirections.slice(0, prefixValues.length),
			this.pkKeyCollations.slice(0, prefixValues.length),
			this.pkKeyTransforms.slice(0, prefixValues.length),
		);
	}

	/**
	 * Effective (pending-over-committed) point read by encoded data key: a pending
	 * delete ⇒ null, a pending put ⇒ its value, else the committed store entry.
	 */
	async readEffectiveRowByKey(key: Uint8Array): Promise<Row | null> {
		const store = await this.ensureStore();
		// Pending ops for THIS table's data store handle — see findUniqueConflict.
		const pending = this.coordinator?.isInTransaction()
			? this.coordinator.getPendingOpsForStore(store)
			: null;
		if (pending) {
			const hex = bytesToHex(key);
			if (pending.deletes.has(hex)) return null;
			const overlay = pending.puts.get(hex);
			if (overlay) return deserializeRow(overlay.value);
		}
		const value = await store.get(key);
		return value ? deserializeRow(value) : null;
	}

	/**
	 * Effective ordered entry scan within `bounds` (see {@link iterateEffective}).
	 * Opens the data store first — which fires the lazy first-access `saveTableDDL`
	 * for a freshly created table, the catalog write a store-backed MV backing
	 * relies on to survive reopen.
	 */
	async *iterateEffectiveEntries(
		bounds: IterateOptions,
		reverse = false,
	): AsyncIterable<KVEntry> {
		const store = await this.ensureStore();
		yield* this.iterateEffective(store, bounds, reverse);
	}

	/** Buffer a privileged row-count delta, applied at coordinator commit (host writes). */
	trackPrivilegedMutation(delta: number): void {
		this.trackMutation(delta, true);
	}

	/**
	 * Declared secondary-UNIQUE enforcement for maintenance writes — the store
	 * mirror of the memory manager's `enforceSecondaryUniqueOnMaintenance` (see
	 * `vtab/backing-host.ts` § Constraint validation for the contract and
	 * docs/mv-constraints.md § Derived-row constraint validation for the
	 * semantics). Called by `StoreBackingHost.applyMaintenance` AFTER the op
	 * batch lands in the coordinator's pending state: post-batch is load-bearing
	 * (a `replace-all` diff applies puts before deletes, so a per-op check would
	 * false-positive when the derived set moves a unique value between primary
	 * keys), and checking only the WRITTEN images is complete (pre-existing
	 * contents already satisfied the constraint).
	 *
	 * Reuses {@link findUniqueConflict} — pending-overlay reads, per-column
	 * collations, NULL-pass, partial-predicate scope, self-PK exclusion — with
	 * the covering-MV route deliberately bypassed: a covering MV over THIS table
	 * is cascade-maintained only after the batch returns, so it lags the batch
	 * and would miss a same-batch colliding pair. The conflict action is a hard
	 * abort (a derivation write carries no user OR clause, and a declared
	 * `on conflict replace`/`ignore` default must not evict or drop derived
	 * rows). Per-image cost is one effective full scan: unlike the DML path
	 * ({@link findUniqueConflictFor}), this one is NOT routed through
	 * {@link findUniqueConflictViaIndex}, because a backing table keeps no
	 * secondary indexes by design — there is never an index store to seek.
	 *
	 * Zero overhead when the table declares no secondary UNIQUE (every MV-sugar
	 * backing, and most maintained tables): one empty-array check.
	 */
	async enforceSecondaryUniqueForMaintenance(changes: readonly BackingRowChange[]): Promise<void> {
		const schema = this.tableSchema;
		const ucs = schema?.uniqueConstraints;
		if (!schema || !ucs || ucs.length === 0 || changes.length === 0) return;

		for (const change of changes) {
			if (change.op === 'delete') continue;
			const newRow = change.newRow;
			const selfPks = [this.extractPK(newRow)];
			for (const uc of ucs) {
				// SQL semantics: UNIQUE allows multiple NULLs.
				if (uc.columns.some(idx => newRow[idx] === null)) continue;
				// Partial UNIQUE: an out-of-scope image contributes nothing.
				const predicate = this.compileFor(uc);
				if (predicate && predicate.evaluate(newRow) !== true) continue;
				const conflict = await this.findUniqueConflict(uc, predicate, newRow, selfPks);
				if (conflict) {
					const colNames = uc.columns.map(i => schema.columns[i]?.name ?? String(i));
					throw maintainedTableUniqueViolationError(
						schema.schemaName, schema.name,
						uc.name ?? `_uc_${colNames.join('_')}`,
						colNames,
						uc.columns.map(i => newRow[i]),
					);
				}
			}
		}
	}

	/**
	 * Reset statistics to an absolute committed row count and flush immediately.
	 * Used by the host's `replaceContents` (create-fill / refresh), where the new
	 * count is exact, replacing any drifted delta-tracked estimate.
	 */
	async resetStats(rowCount: number): Promise<void> {
		this.cachedStats = { rowCount, updatedAt: Date.now() };
		this.pendingStatsDelta = 0;
		this.mutationCount = 0;
		await this.flushStats();
	}

	/**
	 * Open (and cache) the data store, firing the lazy first-access `saveTableDDL`.
	 * Public for the host's `replaceContents`, which writes the store directly.
	 */
	openDataStore(): Promise<KVStore> {
		return this.ensureStore();
	}

	// ── External row-write surface ────────────────────────────────────────
	// Module-side entry point for externally-applied writes to a SOURCE table
	// (the index-maintaining sibling of `StoreBackingHost`, which is for MV
	// BACKING tables and deliberately keeps no indexes). Resolved per call via
	// `StoreModule.getTableForExternalWrite`; addresses the table's CURRENT
	// schema/encoding state so keys and index entries match its own DML paths.

	/**
	 * Effective (pending-over-committed) point read by PK values — the public
	 * read an external writer issues before an upsert to learn the row's current
	 * image. Thin wrapper over the same private point-lookup that backs
	 * {@link query}'s point arm, so an external read merges pending-over-committed
	 * exactly like an engine read does.
	 */
	readRowByPk(pk: SqlValue[]): Promise<Row | null> {
		return this.readLiveRowByPk(pk);
	}

	/**
	 * Apply externally-originated row ops directly to this source table's
	 * COMMITTED storage: table-owned data-key put/delete, secondary-index
	 * maintenance, and stats tracking. The index-maintaining counterpart of
	 * `StoreBackingHost.applyMaintenance` (which targets index-less MV backings),
	 * built for trusted replication-style writes.
	 *
	 * Deliberately:
	 *   - emits NO module {@link DataChangeEvent}s — the external writer owns
	 *     emission and the `remote` flag;
	 *   - opens NO coordinator transaction — writes land in committed state
	 *     immediately (`store.put`/`store.delete`, never the coordinator);
	 *   - runs NO constraint validation (PK/UNIQUE/CHECK/FK) — the origin is
	 *     trusted, mirroring the backing-host posture.
	 *
	 * Returns the EFFECTIVE per-op {@link BackingRowChange}s with accurate
	 * before-images (the shape `Database.ingestExternalRowChanges` consumes),
	 * suppressing no-ops to match the normative upsert-suppression contract in
	 * `vtab/backing-host.ts`: a delete of an absent key, and a value-identical
	 * upsert (`rowsValueIdentical` — byte-faithful, collation-UNAWARE, against the
	 * effective existing row) write nothing and report nothing. A collation-equal /
	 * byte-different upsert (e.g. a case-only rewrite under a NOCASE PK) keeps the
	 * SAME data key (key identity is collation-aware) but IS a real update that
	 * replaces the stored bytes and reports `update`.
	 *
	 * Last-writer-wins against any concurrently pending local transaction on this
	 * table: the external write commits to storage at once, and that transaction's
	 * pending batch may overwrite these keys when it commits. This is the same
	 * posture the prior raw-KV sync adapter took — not a regression, now stated.
	 */
	async applyExternalRowChanges(ops: readonly ExternalRowOp[]): Promise<BackingRowChange[]> {
		const changes: BackingRowChange[] = [];
		if (ops.length === 0) return changes;

		// Route through the lazy store-open path so the first external write to a
		// freshly created table persists its DDL exactly like a first vtab write.
		const store = await this.ensureStore();

		for (const op of ops) {
			switch (op.op) {
				case 'delete': {
					const key = this.encodeDataKey(op.pk);
					const existing = await this.readEffectiveRowByKey(key);
					if (!existing) break; // absent key → no storage/index/stats op, nothing reported
					await store.delete(key);
					await this.updateSecondaryIndexes(false, existing, null, op.pk);
					this.trackMutation(-1, false);
					changes.push({ op: 'delete', oldRow: existing });
					break;
				}
				case 'upsert': {
					const pk = this.extractPK(op.row);
					const key = this.encodeDataKey(pk);
					const existing = await this.readEffectiveRowByKey(key);
					if (existing && rowsValueIdentical(existing, op.row)) {
						// Byte-identical to the effective row → a true no-op: no write, no
						// index touch, no stats delta, nothing reported (echo-prevention seam).
						break;
					}
					await store.put(key, serializeRow(op.row));
					// PK derives from the row, so the key never relocates: oldPk == newPk.
					await this.updateSecondaryIndexes(false, existing, op.row, pk);
					if (!existing) this.trackMutation(+1, false);
					changes.push(existing
						? { op: 'update', oldRow: existing, newRow: op.row }
						: { op: 'insert', newRow: op.row });
					break;
				}
				default: {
					// A new ExternalRowOp variant must extend this switch; never-assignment
					// makes that a compile error rather than a silent no-op.
					const exhaustiveCheck: never = op;
					throw new QuereusError(`Unknown external row op: ${JSON.stringify(exhaustiveCheck)}`, StatusCode.INTERNAL);
				}
			}
		}
		return changes;
	}

	/**
	 * Fully delete the row at `pk` (data + secondary indexes + stats + delete event).
	 * Used by REPLACE conflict resolution to evict a conflicting unique row before
	 * the caller's insert/update proceeds.
	 */
	private async deleteRowAt(
		inTransaction: boolean,
		pk: SqlValue[],
		oldRow: Row,
	): Promise<void> {
		const store = await this.ensureStore();
		const key = this.encodeDataKey(pk);
		if (inTransaction && this.coordinator) {
			this.coordinator.delete(key, store);
		} else {
			await store.delete(key);
		}
		await this.updateSecondaryIndexes(inTransaction, oldRow, null, pk);
		this.trackMutation(-1, inTransaction);

		const schema = this.tableSchema!;
		const deleteEvent = {
			type: 'delete' as const,
			schemaName: schema.schemaName,
			tableName: schema.name,
			key: pk,
			oldRow,
		};
		if (inTransaction && this.coordinator) {
			this.coordinator.queueEvent(deleteEvent);
		} else {
			this.eventEmitter?.emitDataChange(deleteEvent);
		}
	}

	/**
	 * Begin a table-scoped transaction by ensuring the coordinator is active.
	 *
	 * Used by the isolation layer's flush path, which treats the underlying
	 * write as an independent mini-transaction. Idempotent: if the coordinator
	 * is already in a transaction (e.g. started by a registered connection),
	 * this is a no-op.
	 */
	async begin(): Promise<void> {
		const coordinator = await this.ensureCoordinator();
		coordinator.begin();
	}

	/**
	 * Commits a table-scoped transaction, flushing any buffered writes to the KV store.
	 * No-op if the coordinator is not currently in a transaction.
	 */
	async commit(): Promise<void> {
		if (this.coordinator?.isInTransaction()) {
			await this.coordinator.commit();
		}
	}

	/**
	 * Rolls back a table-scoped transaction, discarding any buffered writes.
	 * No-op if the coordinator is not currently in a transaction.
	 */
	async rollback(): Promise<void> {
		if (this.coordinator?.isInTransaction()) {
			this.coordinator.rollback();
		}
	}

	/** Disconnect from the store. */
	async disconnect(): Promise<void> {
		// Called by Quereus after each scan completes.
		// Do NOT clear the store - it's shared across concurrent queries.
		// Only flush pending stats if there are mutations.
		if (this.mutationCount > 0 && this.store) {
			await this.flushStats();
		}
		// Store remains available for subsequent queries.
		// Use destroy() to fully clean up the table.
	}

	/**
	 * Hard teardown: fully detach this instance from the module-wide coordinator.
	 *
	 * Distinct from the per-scan {@link disconnect} (which only flushes stats and
	 * deliberately keeps the table hooked mid-life). Called ONLY at the genuine
	 * eviction sites — `StoreModule.tearDownTableStorage` (drop / reclaim) and
	 * `renameTable` — where this instance is removed from the module's `tables` map
	 * and will never be used again. It best-effort flushes any buffered stats (the
	 * backing store is about to be deleted / relocated, so this is the last chance,
	 * same posture as the teardown-time `disconnect` it replaces), then runs the
	 * coordinator disposer so this instance's {stats apply/discard} callback pair —
	 * and the `this` its closures capture — is spliced off the shared coordinator's
	 * array rather than pinned for the module's lifetime.
	 *
	 * Idempotent: the disposer is run at most once and both it and the coordinator
	 * reference are nulled, so a double-dispose is a no-op and a re-`attachCoordinator`
	 * after dispose registers a fresh pair instead of double-registering.
	 */
	async dispose(): Promise<void> {
		if (this.mutationCount > 0 && this.store) {
			await this.flushStats();
		}
		this.coordinatorDisposer?.();
		this.coordinatorDisposer = null;
		this.coordinator = null;
	}

	/** Get the current estimated row count. */
	async getEstimatedRowCount(): Promise<number> {
		if (this.cachedStats) {
			return this.cachedStats.rowCount;
		}

		const statsStore = await this.ensureStatsStore();
		const statsKey = buildStatsKey(this.schemaName, this.tableName);
		const statsData = await statsStore.get(statsKey);

		if (statsData) {
			this.cachedStats = deserializeStats(statsData);
			return this.cachedStats.rowCount;
		}

		// No stats yet, return 0
		return 0;
	}

	/** Track a mutation and schedule lazy stats persistence. */
	protected trackMutation(delta: number, inTransaction = false): void {
		if (inTransaction) {
			// Buffer during transaction - stats will be applied at commit
			this.pendingStatsDelta += delta;
			return;
		}

		if (!this.cachedStats) {
			this.cachedStats = { rowCount: 0, updatedAt: Date.now() };
		}

		this.cachedStats.rowCount = Math.max(0, this.cachedStats.rowCount + delta);
		this.cachedStats.updatedAt = Date.now();
		this.mutationCount++;

		// Schedule lazy flush after threshold
		if (this.mutationCount >= STATS_FLUSH_INTERVAL && !this.statsFlushPending) {
			this.statsFlushPending = true;
			queueMicrotask(() => this.flushStats());
		}
	}
}

/** PK access pattern analysis result. */
interface PKAccessPattern {
	type: 'point' | 'range' | 'scan';
	values?: SqlValue[];
	columnIndex?: number;
	constraints?: Array<{ columnIndex: number; op: IndexConstraintOp; value?: SqlValue }>;
}

/**
 * Secondary-index access pattern analysis result: the chosen index plus the
 * encoded byte window {@link StoreTable.scanIndex} iterates. `point` is a
 * leading-prefix EQ window, `range` a leading-column LT/LE/GT/GE window; both
 * resolve to a `bounds` scan (an index seek is always a prefix scan, never a
 * single entry).
 */
interface IndexAccessPattern {
	index: TableIndexSchema;
	type: 'point' | 'range';
	bounds: IterateOptions;
}

/** One pushed-constraint entry, as {@link FilterInfo.constraints} carries it. */
type ConstraintEntry = FilterInfo['constraints'][number];

/**
 * One multi-seek tuple: its W constraint entries and their bound values, in
 * constraint order (see {@link StoreTable.decodeMultiSeekTuples}).
 */
interface MultiSeekTuple {
	entries: ConstraintEntry[];
	values: SqlValue[];
}

/** One multi-seek byte window and the tuples (as per-tuple FilterInfos) it serves. */
interface MultiSeekWindow {
	bounds: { gte: Uint8Array; lt?: Uint8Array };
	infos: FilterInfo[];
}

/**
 * Per-window context a multi-seek passes to {@link StoreTable.scanIndex} (absent for
 * ordinary single-window scans).
 *
 * `seen` — data-key hexes already YIELDED by an earlier window. Checked before the
 * data-store read (a cross-window duplicate costs no extra `get`), added only on a
 * yield: adding at visit time would let a stale index entry (row re-keyed since
 * indexing) that FAILS its residual poison the set and suppress the row's live entry
 * in a later window.
 * NOTE: holds one hex string per row the multi-seek yields, for the whole seek — the
 * only unbounded allocation on this path. Windows are byte-disjoint, so the only real
 * duplicate source is a stale index entry; if a large-result `IN` ever shows up as a
 * memory problem, the set can be scoped per window (or dropped for a consistent store).
 *
 * `collations` — the constraint collation map, resolved once per multi-seek (it is
 * identical for every window).
 *
 * `extraTuples` — additional seek tuples whose K-encoded window byte-equals this
 * window's (duplicate bound parameters, or case-variant values under a NOCASE table
 * key collation K). A row is yielded when it matches the primary FilterInfo OR any of
 * these: when the column's comparison collation C is strictly finer than K (K=NOCASE
 * over a BINARY column — the one coarser pairing the plan admits), the merged tuples
 * are C-distinct and each admits different rows, so a single tuple's residual would
 * silently drop the other tuples' rows.
 */
interface MultiSeekWindowContext {
	seen: Set<string>;
	collations: ReadonlyMap<number, CollationFunction>;
	extraTuples: readonly FilterInfo[];
}

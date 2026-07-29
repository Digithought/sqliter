/**
 * Key builder utilities for constructing storage keys.
 *
 * Storage naming convention:
 *   {schema}.{table}              - Data store (row data)
 *   {schema}.{table}_idx_{name}   - Index store (secondary indexes)
 *   {schema}.{table}_stats        - Stats store (row count, etc.)
 *   __catalog__                   - Catalog store (DDL metadata)
 *
 * Within each store, keys are minimal:
 *   - Data store: just the encoded primary key
 *   - Index store: encoded index columns + encoded primary key
 *   - Stats store: single empty key (stats is the only value)
 *   - Catalog store: {schema}.{table} as the key
 */

import type { SqlValue } from '@quereus/quereus';
import { encodeCompositeKey, assertNoUnpairedSurrogate, type EncodeOptions, type KeyValueTransform } from './encoding.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Store name suffixes for different data types.
 */
export const STORE_SUFFIX = {
	INDEX: '_idx_',
	STATS: '_stats',
} as const;

/** Reserved catalog store name. */
export const CATALOG_STORE_NAME = '__catalog__';

/** Reserved stats store name. */
export const STATS_STORE_NAME = '__stats__';

/**
 * Raise when any identifier in `names` carries an unpaired surrogate — such an identifier
 * has no faithful UTF-8 key bytes, so encoding it straight through `TextEncoder` would fold
 * it to U+FFFD and collide with every other identifier differing only in that respect. See
 * {@link assertNoUnpairedSurrogate}. Shared by the physical store-name builders and every
 * catalog-key builder below so the guard reads identically regardless of which kind of name
 * is being built.
 */
function assertKeyableIdentifiers(...names: string[]): void {
	for (const name of names) {
		assertNoUnpairedSurrogate(name, `the identifier "${name}"`);
	}
}

/**
 * Build the store name for a table's data.
 * Format: {schema}.{table}
 *
 * Guarded by {@link assertKeyableIdentifiers}: the physical name is handed to a provider
 * that may encode it to bytes (`LevelDBProvider.encodeSublevelName` runs it through
 * `TextEncoder`), which folds every unpaired surrogate to U+FFFD — so two tables whose
 * names differ only in a lone surrogate would share one physical store. Every call site
 * builds the name before its first side effect, so the throw always lands on a clean no-op.
 *
 * Refusing the identifier here is also what lets `StoreModule.assertStoreNameFree` stand in
 * for a PHYSICAL store collision check: that guard compares names as JS strings, before any
 * provider encoding, so distinct logical names imply distinct physical stores only where the
 * provider's encoding is injective. With unpaired surrogates refused it is — for LevelDB
 * (percent-escaped UTF-8) and IndexedDB (verbatim `DOMString`). It is NOT for
 * `@quereus/plugin-nativescript-sqlite`, whose `getTableName` folds every character outside
 * `[a-zA-Z0-9_]` to `_`; that is a lossy mapping this guard neither causes nor repairs. See
 * `tickets/backlog/bug-mobile-provider-physical-store-name-collisions.md`.
 */
// NOTE: composes with a literal '.' delimiter, so the schema/table boundary is
// not recoverable from the physical name. A lone dotted identifier round-trips
// fine (both create and reconnect compose the same name), but two distinct
// logical pairs that differ only in where the dot falls — e.g. (schema 'x',
// table 'y.z') vs (schema 'x.y', table 'z') — collapse to the same physical
// store 'x.y.z' and would clobber each other. Harmless today (schema names are
// effectively never dotted); if dotted schema names become reachable, switch to
// a boundary-safe encoding (length-prefix or escape the delimiter).
export function buildDataStoreName(schemaName: string, tableName: string): string {
	assertKeyableIdentifiers(schemaName, tableName);
	return `${schemaName}.${tableName}`.toLowerCase();
}

/**
 * Build the store name for a secondary index.
 * Format: {schema}.{table}_idx_{indexName}
 *
 * Identifier-guarded for the same reason as {@link buildDataStoreName} — see its docstring
 * for why refusing an unpaired surrogate is what keeps distinct logical names on distinct
 * physical stores, and for the one provider whose encoding that still does not hold for.
 */
export function buildIndexStoreName(
	schemaName: string,
	tableName: string,
	indexName: string
): string {
	assertKeyableIdentifiers(schemaName, tableName, indexName);
	return `${schemaName}.${tableName}_idx_${indexName}`.toLowerCase();
}

/**
 * Build the store name for table statistics.
 * @deprecated Stats are now stored in the unified __stats__ store. Use buildStatsKey instead.
 * Format: {schema}.{table}_stats
 */
export function buildStatsStoreName(schemaName: string, tableName: string): string {
	return `${schemaName}.${tableName}_stats`.toLowerCase();
}

/**
 * Build a stats key for use in the unified __stats__ store.
 * Format: {schema}.{table}
 */
export function buildStatsKey(schemaName: string, tableName: string): Uint8Array {
	assertKeyableIdentifiers(schemaName, tableName);
	return encoder.encode(`${schemaName}.${tableName}`.toLowerCase());
}

/**
 * Build a data row key (just the encoded primary key).
 *
 * `directions[i] === true` marks PK column i as DESC — its encoded bytes are
 * bit-inverted so natural byte-lex iteration yields DESC order for that column.
 *
 * `collations[i]`, when defined, encodes PK column i under its own key collation
 * (overriding `options.collation`), so each text PK column honors its declared
 * collation in the physical key bytes. Non-text members ignore it.
 *
 * `transforms[i]`, when defined, canonicalizes PK column i's value before encoding
 * (see {@link KeyValueTransform}), so semantically-equal spellings of a
 * semantic-ordering member ('PT1H' / 'PT60M') land on one key.
 */
export function buildDataKey(
	pkValues: SqlValue[],
	options?: EncodeOptions,
	directions?: ReadonlyArray<boolean>,
	collations?: ReadonlyArray<string | undefined>,
	transforms?: ReadonlyArray<KeyValueTransform | undefined>,
): Uint8Array {
	return encodeCompositeKey(pkValues, options, directions, collations, transforms);
}

/**
 * Build a secondary index key.
 * Format: {encoded_index_cols}{encoded_pk}
 *
 * The index columns come first for range scans, followed by PK for uniqueness.
 * `indexDirections` and `pkDirections` independently control DESC bit-inversion
 * for each half so ordered index scans honor per-column direction.
 *
 * `pkCollations[i]`, when defined, encodes the PK-suffix column i under its own
 * key collation (overriding `options.collation`). The PK suffix MUST be encoded
 * with the same per-column collations as the data key (see `buildDataKey`), so
 * index maintenance (delete-then-insert on UPDATE/DELETE) addresses the same
 * bytes the data store keys by. Index columns keep `options.collation`.
 *
 * `indexTransforms` / `pkTransforms` canonicalize each half's values before
 * encoding (see {@link KeyValueTransform}); the PK-suffix transforms MUST match
 * the data key's for the same reason as the collations above.
 */
export function buildIndexKey(
	indexValues: SqlValue[],
	pkValues: SqlValue[],
	options?: EncodeOptions,
	indexDirections?: ReadonlyArray<boolean>,
	pkDirections?: ReadonlyArray<boolean>,
	pkCollations?: ReadonlyArray<string | undefined>,
	indexTransforms?: ReadonlyArray<KeyValueTransform | undefined>,
	pkTransforms?: ReadonlyArray<KeyValueTransform | undefined>,
): Uint8Array {
	const indexEncoded = encodeCompositeKey(indexValues, options, indexDirections, undefined, indexTransforms);
	const pkEncoded = encodeCompositeKey(pkValues, options, pkDirections, pkCollations, pkTransforms);
	return concatBytes(indexEncoded, pkEncoded);
}

/**
 * Build a catalog key for DDL storage.
 * Format: {schema}.{table}
 *
 * Guarded by {@link assertKeyableIdentifiers}: an unpaired surrogate in either identifier
 * has no faithful UTF-8 key bytes, so two tables whose quoted names differ only in a lone
 * surrogate would otherwise fold to the same catalog key and clobber each other's DDL.
 */
export function buildCatalogKey(schemaName: string, tableName: string): Uint8Array {
	assertKeyableIdentifiers(schemaName, tableName);
	return encoder.encode(`${schemaName}.${tableName}`.toLowerCase());
}

/**
 * Reserved key-prefix strings for view / materialized-view catalog entries.
 *
 * Table entries keep their existing **unprefixed** key `{schema}.{table}` (a UTF-8
 * encoding of an identifier, whose bytes are all printable — never `0x00`). View and
 * MV entries are given a leading-`0x00` reserved prefix (`"\x00view\x00"` /
 * `"\x00mview\x00"`) so they can never collide with a same-named table entry — a view
 * (or MV) and a table may legally share a name. A leading `0x00` byte is a valid KV
 * key byte for every provider (in-memory, LevelDB, and IndexedDB all accept arbitrary
 * `Uint8Array` keys).
 *
 * Classification rule: {@link buildCatalogScanBounds} (no schema arg) is a full range
 * scan (`gte: []`, `lt: [0xff]`) and so returns these prefixed view/MV entries
 * alongside the unprefixed table entries (every prefix byte `0x00` < `0xff`).
 * {@link classifyCatalogKey} routes each loaded entry to the correct rehydration phase
 * by testing for these prefixes; the two prefixes are mutually exclusive ('v' vs 'm'
 * after the leading `0x00`) and neither is a prefix of a table key.
 */
const VIEW_KEY_PREFIX = '\x00view\x00';
const MVIEW_KEY_PREFIX = '\x00mview\x00';
const META_KEY_PREFIX = '\x00meta\x00';
const VIEW_KEY_PREFIX_BYTES = encoder.encode(VIEW_KEY_PREFIX);
const MVIEW_KEY_PREFIX_BYTES = encoder.encode(MVIEW_KEY_PREFIX);
const META_KEY_PREFIX_BYTES = encoder.encode(META_KEY_PREFIX);

/** Kind of a loaded catalog entry, determined by its key prefix. */
export type CatalogEntryKind = 'table' | 'view' | 'materializedView' | 'meta';

/**
 * Build a catalog key for a (non-materialized) view's DDL.
 * Format: `\x00view\x00{schema}.{view}` (reserved prefix — never collides with a
 * same-named table entry).
 */
export function buildViewCatalogKey(schemaName: string, viewName: string): Uint8Array {
	assertKeyableIdentifiers(schemaName, viewName);
	return encoder.encode(`${VIEW_KEY_PREFIX}${`${schemaName}.${viewName}`.toLowerCase()}`);
}

/**
 * Build a catalog key for a materialized view's DDL.
 * Format: `\x00mview\x00{schema}.{mv}` (reserved prefix — never collides with a
 * same-named table entry).
 */
export function buildMaterializedViewCatalogKey(schemaName: string, mvName: string): Uint8Array {
	assertKeyableIdentifiers(schemaName, mvName);
	return encoder.encode(`${MVIEW_KEY_PREFIX}${`${schemaName}.${mvName}`.toLowerCase()}`);
}

/**
 * Inverse of {@link buildMaterializedViewCatalogKey}: recover the qualified
 * lowercased `schema.mv` name from a `\x00mview\x00…` catalog key by stripping the
 * reserved prefix. Used by `rehydrateCatalog` to name each MV entry so the
 * store can withhold the adopt fast path per-entry (the stale-at-close set in the
 * clean-shutdown marker is keyed by this same `schema.mv` string). The caller has
 * already classified the key as a materialized view ({@link classifyCatalogKey});
 * the returned string is treated as opaque (never `.`-split).
 */
export function parseMaterializedViewCatalogKey(key: Uint8Array): string {
	return decoder.decode(key.subarray(MVIEW_KEY_PREFIX_BYTES.length));
}

/**
 * Build a catalog key for a store-internal meta entry (not DDL). Format:
 * `\x00meta\x00{name}` — same reserved leading-`0x00` scheme as the view/MV
 * prefixes, so a meta key can never collide with a table entry, and the 'm'-vs
 * `\x00meta`/`\x00mview` byte sequences diverge at the second character.
 * The meta entries are the clean-shutdown marker ({@link CLEAN_SHUTDOWN_META_NAME})
 * and the durable stale-MV set ({@link STALE_MVS_META_NAME}).
 */
export function buildMetaCatalogKey(name: string): Uint8Array {
	return encoder.encode(`${META_KEY_PREFIX}${name}`);
}

/**
 * Reserved meta-entry name for the clean-shutdown marker: written by
 * `StoreModule.closeAll` after every batch has flushed, consumed (read +
 * immediately deleted — single-use) by `rehydrateCatalog`. Its presence at open
 * attests no crash since the last close, which is the trust basis for the
 * materialized-view adopt-without-refill fast path.
 *
 * The marker **value** is a JSON array of the qualified lowercased `schema.mv`
 * names that were stale-at-close (row-time maintenance detached, so the durable
 * backing may be behind) — see {@link parseMaterializedViewCatalogKey}. `[]` is
 * the common clean case (nothing stale). Any unparseable / wrong-shape payload
 * (including a legacy bare `'1'`) degrades to refill-everything: the safe posture.
 */
export const CLEAN_SHUTDOWN_META_NAME = 'clean_shutdown';

/**
 * Reserved meta-entry name for the durable stale-MV set: the crash-survivable
 * record of which materialized views have **logically** fallen out of date
 * (`derivation.stale` — row-time maintenance detached mid-session by a
 * body-relevant source schema change, so later source writes never reached the
 * backing). Modeled on {@link CLEAN_SHUTDOWN_META_NAME} but, unlike the marker,
 * it is **persistent current-truth, not single-use**: `StoreModule` overwrites it
 * (a `sync: true` point-write) whenever the stale set changes during a session and
 * at clean close, `rehydrateCatalog` only **reads** it (never deletes it), and a
 * crash leaves the last synced value intact.
 *
 * The **value** is a JSON array of lowercased qualified `schema.mv` names currently
 * stale (e.g. `[]` or `["main.mv","main.mv2"]`). In the atomic-commit domain (a
 * provider exposing {@link KVStoreProvider.beginAtomicBatch}) this is the adopt
 * fast path's logical-staleness exclusion basis — `!durableStale.has(name)` —
 * which (unlike the clean-shutdown marker) survives a crash, so a non-stale backing
 * adopts even after a crash. Any unparseable / wrong-shape payload degrades to
 * refill-everything: the safe posture (see `docs/mv-backing-host.md`
 * § Cross-module atomicity).
 */
export const STALE_MVS_META_NAME = 'stale_mvs';

/**
 * Classify a loaded catalog key by its reserved prefix so `rehydrateCatalog` can
 * route each entry to the correct phase. A view/MV entry must never be fed to the
 * table-phase `importCatalog` (which would fail-loud or mis-handle it); a meta
 * entry is not DDL at all and must never reach any import phase.
 */
export function classifyCatalogKey(key: Uint8Array): CatalogEntryKind {
	if (startsWithBytes(key, VIEW_KEY_PREFIX_BYTES)) return 'view';
	if (startsWithBytes(key, MVIEW_KEY_PREFIX_BYTES)) return 'materializedView';
	if (startsWithBytes(key, META_KEY_PREFIX_BYTES)) return 'meta';
	return 'table';
}

/** True when `key` begins with the byte sequence `prefix`. */
function startsWithBytes(key: Uint8Array, prefix: Uint8Array): boolean {
	if (key.length < prefix.length) return false;
	for (let i = 0; i < prefix.length; i++) {
		if (key[i] !== prefix[i]) return false;
	}
	return true;
}

/**
 * Build range bounds for scanning all rows in a data store.
 *
 * Data stores are per-table so any non-empty key belongs to this table — an
 * unbounded scan is safe and avoids the trap that a leading 0xff byte (produced
 * by inverted NULL type prefix 0x00 ^ 0xff for DESC columns) would be excluded
 * by an `lt: [0xff]` upper bound.
 */
export function buildFullScanBounds(): { gte: Uint8Array } {
	return {
		gte: new Uint8Array(0),
	};
}

/**
 * Build range bounds for scanning an index with a prefix.
 *
 * `directions[i] === true` flips bytes of prefix component i to match DESC
 * encoding in the stored index keys.
 *
 * `lt` is omitted when the encoded prefix is all-0xff bytes (e.g. a single
 * leading DESC NULL, whose type byte inverts to 0xff) — no finite exclusive
 * upper bound exists, so the scan runs to the end of the store.
 *
 * An empty prefix yields unbounded full-scan bounds: index stores are
 * per-index, so every key belongs to this index, and capping at `lt: [0xff]`
 * would wrongly exclude entries whose leading column is a DESC NULL (encoded
 * with a 0xff type byte) — the same trap {@link buildFullScanBounds} documents
 * for data stores.
 *
 * NOTE: all three `StoreTable` callers (`analyzeIndexAccess`, `buildIndexRangeBounds`,
 * `scanMultiSeek`) pass NO `transforms` — sound only because each declines a
 * semantic-ordering column before it gets here (the EQ-prefix loop breaks on
 * `hasSemanticOrdering`; the range arm is gated on `keyOrderMatchesCollation`; the
 * multi-seek throws INTERNAL, its plan having already been declined by
 * `tryIndexAccessPlan` (store-module-access-plan.ts)). If backlog `feat-reopen-timespan-store-seeks`
 * re-opens any arm, thread the column's transforms through first or the bounds will
 * address raw-value bytes while the index holds transformed ones.
 */
export function buildIndexPrefixBounds(
	prefixValues: SqlValue[],
	options?: EncodeOptions,
	directions?: ReadonlyArray<boolean>,
	transforms?: ReadonlyArray<KeyValueTransform | undefined>,
): { gte: Uint8Array; lt?: Uint8Array } {
	if (prefixValues.length === 0) {
		return buildFullScanBounds();
	}

	const prefixEncoded = encodeCompositeKey(prefixValues, options, directions, undefined, transforms);
	return {
		gte: prefixEncoded,
		lt: incrementLastByte(prefixEncoded),
	};
}

/**
 * Build range bounds for scanning a data store by a PRIMARY KEY prefix.
 *
 * The leading PK values are encoded exactly as {@link buildDataKey} encodes
 * them — same per-column DESC `directions` and per-column key `collations`
 * (`StoreTable.pkKeyCollations`) — so the bounds address the same key bytes
 * the data store is keyed by.
 *
 * Relies on the composite-key prefix-preservation property: `encodeCompositeKey`
 * concatenates self-delimiting per-column encodings (text NUL-terminated with
 * 0x01 escaping, fixed-width tagged numerics), so the encoding of a leading
 * value subset is a byte-prefix of every full key sharing those values — and
 * that holds through per-column DESC bit-inversion and per-column collation
 * encoders, which both apply column-locally.
 *
 * An empty prefix yields full-scan bounds (see {@link buildFullScanBounds} for
 * why the data store must NOT cap with `lt: [0xff]` — a DESC NULL leading
 * column encodes to a 0xff byte). The non-empty case is unaffected by that
 * caveat because its upper bound derives from the actual prefix bytes; when
 * those are all 0xff (so no finite increment exists), `lt` is omitted and the
 * scan runs to the end of the store.
 */
export function buildPkPrefixBounds(
	prefixValues: SqlValue[],
	options?: EncodeOptions,
	directions?: ReadonlyArray<boolean>,
	collations?: ReadonlyArray<string | undefined>,
	transforms?: ReadonlyArray<KeyValueTransform | undefined>,
): { gte: Uint8Array; lt?: Uint8Array } {
	if (prefixValues.length === 0) {
		return buildFullScanBounds();
	}

	const prefixEncoded = encodeCompositeKey(prefixValues, options, directions, collations, transforms);
	return {
		gte: prefixEncoded,
		lt: incrementLastByte(prefixEncoded),
	};
}

/**
 * Build range bounds for scanning catalog entries.
 * Optionally filter by schema prefix.
 */
export function buildCatalogScanBounds(schemaName?: string): { gte: Uint8Array; lt: Uint8Array } {
	if (schemaName) {
		const prefix = `${schemaName}.`.toLowerCase();
		// UTF-8 output never contains 0xff bytes, so the increment cannot overflow.
		return {
			gte: encoder.encode(prefix),
			lt: incrementLastByte(encoder.encode(prefix))!,
		};
	}
	return {
		gte: new Uint8Array(0),
		lt: new Uint8Array([0xff]),
	};
}

/**
 * Increment the last byte of a key to create an exclusive upper bound.
 * Returns undefined when every byte is 0xff — no finite upper bound exists
 * (every successor byte string still starts with the all-0xff prefix), so
 * callers must scan unbounded above instead.
 */
function incrementLastByte(key: Uint8Array): Uint8Array | undefined {
	const result = new Uint8Array(key.length);
	result.set(key);

	// Increment from the end, handling overflow
	for (let i = result.length - 1; i >= 0; i--) {
		if (result[i] < 0xff) {
			result[i]++;
			return result;
		}
		result[i] = 0;
	}

	return undefined;
}

/**
 * Concatenate multiple byte arrays.
 */
function concatBytes(...arrays: Uint8Array[]): Uint8Array {
	const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
	const result = new Uint8Array(totalLength);
	let offset = 0;
	for (const arr of arrays) {
		result.set(arr, offset);
		offset += arr.length;
	}
	return result;
}

// ============================================================================
// Legacy exports for backwards compatibility during migration
// These will be removed after all consumers are updated.
// ============================================================================

/** @deprecated Use buildDataStoreName instead */
export const KEY_PREFIX = {
	DATA: encoder.encode('d:'),
	INDEX: encoder.encode('i:'),
	META: encoder.encode('m:'),
} as const;

/** @deprecated Use buildDataKey instead */
export function buildTablePrefix(
	_prefix: 'd' | 'i' | 'm',
	schemaName: string,
	tableName: string
): Uint8Array {
	return encoder.encode(`${schemaName}.${tableName}`.toLowerCase());
}

/** @deprecated Use buildFullScanBounds instead */
export function buildTableScanBounds(
	_schemaName: string,
	_tableName: string,
): { gte: Uint8Array } {
	return buildFullScanBounds();
}

/** @deprecated Use buildIndexPrefixBounds instead */
export function buildIndexScanBounds(
	_schemaName: string,
	_tableName: string,
	_indexName: string,
	prefixValues?: SqlValue[],
	options?: EncodeOptions
): { gte: Uint8Array; lt?: Uint8Array } {
	return buildIndexPrefixBounds(prefixValues || [], options);
}

/** @deprecated Use buildCatalogKey instead */
export function buildMetaKey(
	_metaType: 'ddl' | 'stats' | 'index',
	schemaName: string,
	objectName: string,
	_subName?: string
): Uint8Array {
	return buildCatalogKey(schemaName, objectName);
}

/** @deprecated Use buildCatalogScanBounds instead */
export function buildMetaScanBounds(
	_metaType: 'ddl' | 'stats' | 'index',
	schemaName?: string
): { gte: Uint8Array; lt: Uint8Array } {
	return buildCatalogScanBounds(schemaName);
}

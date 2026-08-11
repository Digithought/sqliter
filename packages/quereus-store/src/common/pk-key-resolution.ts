/**
 * Resolution of the physical KEY properties of a table's primary-key and
 * secondary-index columns: the per-column key collation, the key-identity value
 * transform for semantic-ordering types, and the order-safety predicates that
 * decide whether a byte window may stand in for a comparator range.
 *
 * Shared by the store table (data-key + index-maintenance encoding) and
 * `StoreModule` (index rebuild, access planning) so key encoding can never drift
 * between the two.
 */

import {
	createTypedComparator,
	hasSemanticOrdering,
	semanticKeyTransform,
	logicalTypeCanHoldText,
	pkKeyCollationName,
	JSON_TYPE,
	TIMESPAN_TYPE,
	type LogicalType,
	type Database,
	type DatabaseInternal,
	type ColumnSchema,
	type TableSchema,
	type TableIndexSchema,
	type SqlValue,
} from '@quereus/quereus';

import { type KeyValueTransform } from './encoding.js';
import { jsonKeyEncodable, jsonStructuralKey } from './json-key.js';

/**
 * Resolve the per-column KEY collation for each primary-key column.
 *
 * The store encodes PRIMARY KEY uniqueness/ordering PHYSICALLY in the key bytes, so each
 * text-capable PK column's key must be encoded under the collation the engine actually
 * COMPARES that column under. Returns one entry per PK member, in `pkDef` order:
 *   - collation-aware member (`text`, `any` — the types whose `compare` applies the
 *     collation it is handed, `LogicalType.collationAware`) → its declared `collation`
 *     (normalized upper-case), or `fallback` (the table key collation K) when the
 *     column carries none.
 *   - text-capable but collation-blind member — `json` and the temporal types
 *     (`date` / `time` / `datetime` / `timespan`) → hard-coded `'BINARY'`: those
 *     types' `compare` is not the generic storage-class + collation comparison (the
 *     temporals ignore the argument; JSON ranks structurally), and their empty
 *     `supportedCollations` list keeps a non-BINARY column COLLATE out at DDL time.
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
 * at DDL time by `StoreTableBase.validateKeyCollations`, so no encode call ever has
 * to fall back. Shared by `StoreTable` (data-key + index-maintenance) and
 * the index rebuild `buildIndexEntries` (store-module-index-build.ts) so the PK suffix
 * encoding can never drift between the two.
 */
export function resolvePkKeyCollations(
	pkDef: ReadonlyArray<{ index: number }>,
	columns: ReadonlyArray<ColumnSchema>,
	fallback: string,
): (string | undefined)[] {
	return pkDef.map(def => {
		const col = columns[def.index];
		// Delegates the collation-aware/collation-blind/never-text branch to the engine's
		// `pkKeyCollationName` — the same decision `quereus-isolation`'s modified-PK set
		// makes for its own key normalizers, so the two can never drift apart again. Only
		// the fallback-to-K and uppercase-normalization are store-specific.
		const name = pkKeyCollationName(col);
		return name === undefined ? undefined : (name || fallback).toUpperCase();
	});
}

/**
 * Per-column KEY collation for a secondary index's OWN columns (the index half of
 * `buildIndexKey`), positionally aligned with `index.columns` — the index twin of
 * {@link resolvePkKeyCollations}. Same three-way branch, delegated to the engine's
 * `pkKeyCollationName`:
 *   - never-text column (`integer`, `real`, `blob`) → `undefined`: encoded
 *     type-natively, collation is moot.
 *   - text-capable but collation-blind (`json`, the temporal types) → hard-coded
 *     `'BINARY'` — those types' `compare` is not the generic collation comparison.
 *   - collation-aware (`text`, `any`) → the index column's own COLLATE, else the
 *     table column's declared collation, else `'BINARY'`.
 *
 * The fallback is `BINARY`, NOT the table key collation K — deliberately asymmetric
 * with {@link resolvePkKeyCollations}, whose fallback IS K. For a PK member the
 * asymmetry is illusory: `reconcilePkCollations` (store-module-schema-rewrite.ts)
 * rewrites an undecorated text PK column's declared collation to K at CREATE time, so
 * for a PK member K *is* the declared collation. No such rewrite exists for non-PK
 * columns — an undecorated `text` column genuinely compares under BINARY (in the
 * engine's operators and in the store's `matchesFilters` residual alike), so BINARY is
 * what its index bytes must encode under, or the stored order/equality disagrees with
 * every comparison made against it.
 */
export function resolveIndexKeyCollations(
	index: TableIndexSchema,
	columns: ReadonlyArray<ColumnSchema>,
): (string | undefined)[] {
	return index.columns.map(col => {
		const tableCol = columns[col.index];
		// The collation handed to `pkKeyCollationName` is always defined, so an
		// `undefined` answer means never-text (its textual branch returns the collation
		// verbatim; passing a bare `col.collation ?? tableCol.collation` would conflate
		// "undecorated text column" with "never-text" and silently fall back to K at
		// encode time — the exact drift this resolver exists to remove).
		const name = pkKeyCollationName(tableCol === undefined ? undefined : {
			logicalType: tableCol.logicalType,
			collation: col.collation ?? tableCol.collation ?? 'BINARY',
		});
		return name === undefined ? undefined : (name || 'BINARY').toUpperCase();
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
 *
 * This is the PHYSICAL KEY BYTES resolver — it feeds `buildIndexKey` / `buildDataKey`
 * and its output is memcmp-ordered and persisted. {@link storeDedupeKeyTransform} is
 * its build/validate-time twin: same job, but for the transient UNIQUE dedupe
 * signature, which is free to leave a comparable value for `serializeKey`'s collation
 * normalizer instead of committing to structural bytes.
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
 * The build/validate-time twin of {@link storeSemanticKeyTransform}, for the UNIQUE
 * dedupe SIGNATURE rather than physical key bytes (`buildIndexEntries`'s in-pass
 * `seen` check and `assertNoDuplicateRows`, both in store-module-index-build.ts).
 *
 * The signature is a `serializeKey` call over the (possibly transformed) values, and
 * `serializeKey` applies a column's collation NORMALIZER only to a raw `string` value
 * — a transform that returns a `Uint8Array` (as {@link storeSemanticKeyTransform} does
 * for JSON, via {@link jsonStructuralKey}) is tagged as an opaque byte array instead,
 * and the normalizer never runs. For JSON that would silently drop the index
 * COLLATE on exactly the case `JSON_TYPE.compare` treats as text (a string-scalar
 * pair) and let a build-time UNIQUE index admit rows a write-time insert would then
 * reject (bug-store-index-build-dedupe-skips-collation) — so this resolver special-
 * cases JSON: a string scalar is left AS a string, so `serializeKey`'s normalizer
 * still runs; every other JSON value (object, array, number, boolean, or null) falls
 * back to the structural bytes, matching `JSON_TYPE.compare`'s non-text ranking.
 *
 * Every other semantic-ordering type (TIMESPAN today) is unaffected: its `compare`
 * ignores the collation it is handed, and its `groupKey` transform already collides
 * every equal-identity spelling onto one value on both the build and write paths, so
 * this resolver defers to {@link storeSemanticKeyTransform} unchanged.
 */
export function storeDedupeKeyTransform(type: LogicalType | undefined): KeyValueTransform | undefined {
	if (hasSemanticOrdering(type) && type.name === JSON_TYPE.name) return jsonDedupeKey;
	return storeSemanticKeyTransform(type);
}

/**
 * A declared-JSON value as the UNIQUE dedupe signature must see it: a top-level string
 * scalar verbatim (so `serializeKey` runs the column's collation normalizer over it,
 * mirroring `JSON_TYPE.compare`'s collation-honoring string/string branch), every other
 * node as {@link jsonStructuralKey}'s bytes (mirroring `deepCompareJson`, which takes no
 * collation — a NESTED string leaf is code-point-compared even under an index COLLATE).
 */
function jsonDedupeKey(value: SqlValue): SqlValue {
	return typeof value === 'string' ? value : jsonStructuralKey(value);
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
 * Per-column {@link storeDedupeKeyTransform} for an arbitrary column-index list —
 * the UNIQUE dedupe-signature counterpart of {@link resolveIndexKeyTransforms},
 * shared by both build/validate-time dedupe sites (`buildIndexEntries`' in-pass
 * `seen` check over an index's columns, `assertNoDuplicateRows` over a constraint's)
 * so the two cannot drift onto different transforms.
 */
export function resolveDedupeKeyTransforms(
	colIndices: ReadonlyArray<number>,
	columns: ReadonlyArray<ColumnSchema>,
): (KeyValueTransform | undefined)[] {
	return colIndices.map(i => storeDedupeKeyTransform(columns[i]?.logicalType));
}

/**
 * Per-PK-column typed equality comparator for semantic-ordering members, `undefined`
 * elsewhere. Backs `StoreTableConstraints.keysEqual`: two PK arrays naming the same
 * physical key under {@link resolvePkKeyTransforms} ('PT1H' / 'PT60M') must also
 * answer "same row" here, or self-PK exclusion in the UNIQUE checks false-conflicts
 * a row against its own differently-spelled image.
 */
export function resolvePkSemanticEquality(
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
 * secondary indexes — the write-side `StoreTableConstraints.indexSeekHonorsEnforcementCollation`
 * and the read-side {@link keyOrderMatchesCollation} — exempt a never-text column from their
 * key-vs-comparison collation test, so a false "non-text" answer is a silent wrong-result
 * (a seek under the wrong collation, with the residual dropped).
 */
export function columnCanHoldText(col: ColumnSchema | undefined): boolean {
	return logicalTypeCanHoldText(col?.logicalType);
}

/**
 * True when this semantic-ordering type's store key bytes memcmp in EXACTLY the type's
 * `compare` order — and byte-equal exactly when `compare` says equal — for every value a
 * store-backed table can HOLD.
 *
 * An explicit per-type assertion, deliberately NOT
 * `storeSemanticKeyTransform(type) !== undefined`: a transform is only required to be
 * identity-faithful, and `validateSemanticKeyTransforms` can check only that one exists —
 * nothing forces a future type's transform to be order-preserving. A type absent here
 * keeps the pre-existing blanket decline in {@link keyOrderMatchesCollation} — no byte
 * window, no ordering advertisement, answered by full scan + the type-aware residual.
 *
 * Why the stored-value claim holds for the two listed types:
 *  - TIMESPAN — every write path coerces through `TIMESPAN_TYPE.parse` (row coercion,
 *    the engine's pre-coerced UPDATE fast path, the ALTER retype backfill's
 *    `validateAndParse`), which raises on anything unparseable. So every stored value
 *    parses, `groupKey` returns total seconds for all of them, and every stored key
 *    member is a fixed-width NUMERIC whose memcmp order is elapsed-time order. The
 *    raw-text fallback branch of `groupKey` is unreachable for stored values.
 *  - JSON — every stored value is a `JSON_TYPE.parse` output (never a blob, never a
 *    bigint), all of which {@link jsonStructuralKey} encodes; its tag order reproduces
 *    both `deepCompareJson`'s rank order and, for cross-storage-class pairs (where
 *    `createTypedComparator` short-circuits before reaching `JSON_TYPE.compare`),
 *    `getStorageClass`'s NULL < NUMERIC < TEXT < BLOB < OBJECT. SQL NULL never reaches
 *    a transform (`encodeCompositeKey` exempts it) and its `0x00` tag sorts below the
 *    BLOB tag the structural bytes travel under, matching NULL-first placement.
 *
 * Matched by NAME, not object identity, for the same dual-module-instance reason
 * {@link storeSemanticKeyTransform} documents. This is a claim about values the table
 * holds; a query-supplied seek bound needs {@link semanticProbeIsKeyFaithful} on top.
 */
export function semanticKeyOrderIsFaithful(type: LogicalType | undefined): boolean {
	return hasSemanticOrdering(type)
		&& (type.name === TIMESPAN_TYPE.name || type.name === JSON_TYPE.name);
}

/**
 * True when `probe`'s key bytes sit at the position the type's `compare` gives it
 * relative to every STORED value — the per-VALUE precondition every re-opened seek
 * window (range bound AND equality probe) needs on top of
 * {@link semanticKeyOrderIsFaithful}, which is a claim about stored values only. A probe
 * comes from the query, and nothing coerces it to the column's declared type, so an
 * unfaithful probe is reachable where an unfaithful stored value is not. Two concrete
 * TIMESPAN under-fetches motivate the gate:
 *
 *  - `where d > 5`: `createTypedComparator` short-circuits on the storage-class
 *    mismatch before `TIMESPAN.compare` runs, so every stored (TEXT-class) value ranks
 *    ABOVE the NUMERIC probe and the predicate admits every row — but `groupKey(5)`
 *    passes the non-string through unchanged, so the byte window is `> NUMERIC(5)` and
 *    a row storing 'PT1S' (total 1) falls outside it. Rows lost.
 *  - `where d > 'not a duration'`: `TIMESPAN.compare` falls back to BINARY text against
 *    the canonical stored text, while `groupKey` falls back to the raw text, which
 *    encodes TEXT-tagged and sorts above every NUMERIC-tagged stored key. Different
 *    position, rows lost.
 *
 * THE canonical statement of how each arm degrades on `false` — the call sites point
 * here rather than restating it. A window may only ever be WIDENED, never narrowed, and
 * the type-aware residual (`StoreTableScan.matchesFilters`) decides rows in every case:
 *
 *  - a RANGE bound is SKIPPED (`buildPKRangeBounds`, `buildIndexRangeBounds`) — dropping
 *    one bound only widens the window, worst case back to the full scan.
 *  - a full-PK EQUALITY declines the WHOLE point arm (`analyzePKAccess`) — a point window
 *    is a single byte position, so it cannot be widened, only under-fetched.
 *  - a secondary index's EQ PREFIX stops SHORT at that column (`analyzeIndexAccess`) — a
 *    window over the columns before it is a strict superset.
 *  - an IN-list MULTI-SEEK has none of the three available (its merged windows are the
 *    whole access) and so never reaches this gate: it is declined per SCHEMA upstream.
 *
 * The TIMESPAN arm calls the COLUMN's own `groupKey`, not the imported singleton's,
 * for the dual-module-instance reason {@link storeSemanticKeyTransform} documents.
 * A semantic-ordering type outside the {@link semanticKeyOrderIsFaithful} allow-list
 * answers `false`, consistent with that predicate — no window is built for it anyway.
 */
export function semanticProbeIsKeyFaithful(type: LogicalType | undefined, probe: SqlValue): boolean {
	if (!hasSemanticOrdering(type)) return true;
	if (type.name === TIMESPAN_TYPE.name) {
		// A number out of groupKey means the probe parsed; the raw-string fallback (or
		// a non-string probe) means it has no faithful byte position.
		return typeof probe === 'string' && typeof type.groupKey?.(probe) === 'number';
	}
	if (type.name === JSON_TYPE.name) return jsonKeyEncodable(probe);
	return false;
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
 *    merely COARSER than `compareCollation` is not enough: it would need the key normalizer
 *    to be monotone with respect to the OTHER collation's order. It generally is not, even
 *    for built-ins: with `keyCollation = NOCASE` and `compareCollation = BINARY`,
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
 *
 * The PK caller ({@link pkOrderPreservingPrefixLength}) can genuinely pass two DIFFERENT
 * collations, because {@link resolvePkKeyCollations} still falls back to the table key
 * collation K for an undecorated text PK member. The secondary-index caller
 * ({@link indexLeadingRangeIsOrderSafe}) usually passes the same name on both sides — index
 * key bytes encode under the index column's own effective collation, which is what the scan
 * residual re-compares under — so for a `text` or `any` column it reduces to the
 * `orderPreserving` assertion alone. The one index shape where the two sides still differ is
 * a collation-blind column (`json`, the temporal types) under an index column carrying an
 * explicit non-BINARY COLLATE (index DDL does not type-gate the way column DDL does): its
 * key bytes are hard-`BINARY` while its residual compares under the declared name, and this
 * predicate correctly declines it.
 */
export function keyOrderMatchesCollation(
	db: Database,
	column: ColumnSchema | undefined,
	keyCollation: string,
	compareCollation: string,
): boolean {
	// A semantic-ordering logical type (TIMESPAN, JSON — see docs/types.md "Semantic
	// ordering") is ordered by its `compare` (elapsed time / structural), which the
	// engine's Sort, comparison operators, and the memory backend all use. Byte order
	// stands in for that order only for the types `semanticKeyOrderIsFaithful` asserts
	// it for; any other semantic-ordering type keeps the blanket decline — no byte
	// window, no ordering advertisement, full scan + the type-aware residual. A
	// faithful type FALLS THROUGH to the collation checks below rather than returning
	// true: `logicalTypeCanHoldText` admits both types (json is OBJECT-physical but
	// text-capable; timespan is TEXT-physical), and the collation comparison is what
	// correctly declines a collation-blind column under an INDEX column carrying an
	// explicit non-BINARY COLLATE (index DDL does not type-gate the way column DDL
	// does) — its key bytes are hard-BINARY while the residual re-compares under the
	// declared name. Seek BOUNDS additionally pass through the per-value
	// `semanticProbeIsKeyFaithful` gate at window-build time.
	if (hasSemanticOrdering(column?.logicalType) && !semanticKeyOrderIsFaithful(column?.logicalType)) return false;
	if (!columnCanHoldText(column)) return true;
	if (compareCollation.toUpperCase() !== keyCollation.toUpperCase()) return false;
	return (db as DatabaseInternal)._isCollationOrderPreserving(keyCollation);
}

/**
 * The collation `StoreTableScan.matchesFilters` re-compares index position `position`
 * under — the index column's own `COLLATE`, else the table column's declared collation,
 * else BINARY (see `indexColumnCollations`). The same resolution the planner used when it
 * decided the residual Filter could be dropped, so it is the order/equality a byte window
 * over that position has to reproduce.
 *
 * NOTE: this duplicates {@link resolveIndexKeyCollations}' collation-aware branch — same
 * three-step fallback, same BINARY default — which is why both gates below admit every
 * `text` and `any` column. Change either fallback without the other and the gates start
 * declining (or, worse, admitting) shapes nobody intended; keep the two in step.
 */
function indexResidualCollation(
	columns: ReadonlyArray<ColumnSchema>,
	index: TableIndexSchema,
	position: number,
): string {
	const spec = index.columns[position];
	return (spec?.collation ?? columns[spec?.index ?? -1]?.collation ?? 'BINARY').toUpperCase();
}

/**
 * True when an EQUALITY/prefix byte window over the leading `prefixLength` columns of
 * secondary `index` is EXACTLY the qualifying set — the condition under which the access
 * planner may claim the equality filters handled and drop the residual Filter.
 *
 * `keyCollations` is {@link resolveIndexKeyCollations}' output for `index` (the scan passes
 * its memoized copy, the access planner resolves one on the spot): the collation each
 * position's key bytes are ACTUALLY encoded under. The window equals the qualifying set iff
 * that agrees, per position, with {@link indexResidualCollation}.
 *
 * For a `text` or `any` column the two agree by construction — both resolve to the index
 * `COLLATE` else the declared collation else BINARY — so those admit, including the
 * `text` column of a table whose key collation K is something else entirely, and an
 * `x any collate nocase` index column (whose window is now genuinely the NOCASE-equal
 * set — ANY's `compare` honors the collation, so key bytes, residual, and enforcement
 * all agree). The shape that does NOT agree is a collation-blind column (`json`, the
 * temporal types) under an index column carrying an explicit non-BINARY COLLATE:
 * `pkKeyCollationName` keys those hard-`BINARY` while the residual still compares under
 * the declared name, so the window would be byte-equal only and miss rows the residual
 * admits — declined. Never-text columns are exempt — their key bytes are type-native.
 */
export function indexPrefixSeekIsCollationExact(
	columns: ReadonlyArray<ColumnSchema>,
	index: TableIndexSchema,
	keyCollations: ReadonlyArray<string | undefined>,
	prefixLength: number,
): boolean {
	for (let i = 0; i < prefixLength; i++) {
		const spec = index.columns[i];
		if (!spec) return false;
		if (!columnCanHoldText(columns[spec.index])) continue;
		if ((keyCollations[i] ?? 'BINARY').toUpperCase() !== indexResidualCollation(columns, index, i)) return false;
	}
	return true;
}

/**
 * True when a byte RANGE window over index-column `position` of secondary `index` is SOUND.
 *
 * Strictly stronger than {@link indexPrefixSeekIsCollationExact} at the same position: the
 * same key-vs-residual collation agreement, PLUS the collation's `orderPreserving`
 * assertion, because a range window also equates memcmp of the key bytes with the residual
 * comparator's ORDER. Both halves are {@link keyOrderMatchesCollation}, which admits a
 * semantic-ordering column only when {@link semanticKeyOrderIsFaithful} asserts its key
 * bytes order as the type's `compare` does (and the collation sides agree — a `collate`
 * decoration on the index column still declines it).
 *
 * `position` is 0 for a standalone leading-column range (see
 * {@link indexLeadingRangeIsOrderSafe}) and `prefixLength` for the trailing bound of a
 * prefix-equality + trailing-range seek. The question is identical at either position: the
 * columns BEFORE it are pinned to one value each, so the window is a contiguous byte region
 * whose ordering within the prefix is governed solely by this column's key bytes. What the
 * pinned columns need is the (weaker) EXACTNESS test — {@link indexPrefixSeekIsCollationExact}
 * over the prefix — which the callers apply alongside this one.
 *
 * THE shared predicate for the two decision sites: `tryIndexAccessPlan`
 * (store-module-access-plan.ts) marks the range filters handled only when it holds, and
 * `StoreTableScan.analyzeIndexAccess` builds a window only when it holds. They must agree —
 * a plan that claims a filter the scan then declines to window loses the residual Filter and
 * returns the whole table — so they call this rather than each restating it.
 */
export function indexRangeAtPositionIsOrderSafe(
	db: Database,
	columns: ReadonlyArray<ColumnSchema>,
	index: TableIndexSchema,
	keyCollations: ReadonlyArray<string | undefined>,
	position: number,
): boolean {
	const spec = index.columns[position];
	if (!spec) return false;
	return keyOrderMatchesCollation(
		db,
		columns[spec.index],
		keyCollations[position] ?? 'BINARY',
		indexResidualCollation(columns, index, position),
	);
}

/**
 * {@link indexRangeAtPositionIsOrderSafe} at position 0 — the standalone leading-column
 * range window, which needs no equality prefix ahead of it.
 */
export function indexLeadingRangeIsOrderSafe(
	db: Database,
	columns: ReadonlyArray<ColumnSchema>,
	index: TableIndexSchema,
	keyCollations: ReadonlyArray<string | undefined>,
): boolean {
	return indexRangeAtPositionIsOrderSafe(db, columns, index, keyCollations, 0);
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
 * — see docs/types.md "Semantic ordering") Sort ranks by `logicalType.compare`, and the
 * member counts only when {@link semanticKeyOrderIsFaithful} asserts the stored key bytes
 * memcmp in exactly that order (TIMESPAN's total-seconds transform, JSON's structural
 * encoding). A semantic-ordering type outside that allow-list breaks the prefix, and the
 * memory backend's typed BTree order remains the canonical order for it.
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
		if (!keyOrderMatchesCollation(db, col, keyCollation, col?.collation ?? 'BINARY')) break;
		n++;
	}
	return n;
}

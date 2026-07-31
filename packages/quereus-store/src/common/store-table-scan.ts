/**
 * The read path of the KVStore-backed virtual table: turning a pushed predicate
 * into a byte window over the data store or a secondary index, iterating that
 * window, and re-checking every pushed constraint under the column's real
 * collation.
 *
 * Second layer of the store-table chain:
 *   StoreTableBase -> StoreTableScan -> StoreTableConstraints -> StoreTable
 */

import {
	IndexConstraintOp,
	QuereusError,
	StatusCode,
	compareSqlValuesFast,
	createTypedComparator,
	hasSemanticOrdering,
	BINARY_COLLATION,
	decodeIdxStr,
	planKindFromCode,
	type IdxStrSpec,
	type CollationFunction,
	type ColumnSchema,
	type CompareFn,
	type TableIndexSchema,
	type Row,
	type FilterInfo,
	type SqlValue,
} from '@quereus/quereus';

import type { IterateOptions, KVStore } from './kv-store.js';
import { bytesToHex, compareBytes } from './bytes.js';
import {
	buildIndexKey,
	buildIndexPrefixBounds,
	buildFullScanBounds,
} from './key-builder.js';
import {
	deserializeRow,
} from './serialization.js';
import { keyOrderMatchesCollation, pkOrderPreservingPrefixLength, resolveIndexKeyCollations, storeSemanticKeyTransform } from './pk-key-resolution.js';

import { StoreTableBase } from './store-table-base.js';

/**
 * Read-path layer of the generic KVStore-backed virtual table.
 *
 * Every arm below reads the EFFECTIVE row state (see
 * {@link StoreTableBase.iterateEffective}), so a byte window narrowed here still
 * honors read-your-own-writes.
 */
export abstract class StoreTableScan extends StoreTableBase {
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
	 * True when a byte window over the LEADING PK column reproduces the comparator's order
	 * — the precondition {@link buildPKRangeBounds} needs, and the exact condition
	 * `computeBestAccessPlan` (store-module-access-plan.ts) uses before claiming the range filters handled.
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
	 * {@link analyzePKAccess} here and mirrored by `computeBestAccessPlan` (store-module-access-plan.ts)
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
	 * Index-column bytes are encoded under each column's own key collation C
	 * (`resolveIndexKeyCollations` — the index column's COLLATE, else the table column's
	 * declared collation, else BINARY), which is also the collation `matchesFilters`
	 * re-checks under — so the EQ/prefix window is EXACTLY the qualifying set. The RANGE
	 * window additionally needs byte order to BE comparator order, so it is gated on
	 * {@link indexRangeIsOrderSafe}; when that fails we return null and the caller
	 * full-scans.
	 */
	protected analyzeIndexAccess(filterInfo: FilterInfo): IndexAccessPattern | null {
		const index = this.resolveIndexFromIdxStr(filterInfo.idxStr);
		if (!index) return null;

		const indexCols = index.columns.map(c => c.index);
		const indexDirections = index.columns.map(c => !!c.desc);
		const indexCollations = this.indexKeyCollations(index);

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
				indexCollations.slice(0, eqValues.length),
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
				indexCollations[0],
			);
			return { index, type: 'range', bounds };
		}

		return null;
	}

	/**
	 * Lazy cache behind {@link indexKeyCollations}: one resolved array per index-schema
	 * object, invalidated when the column array it was resolved against is replaced (an
	 * ALTER can retype a column without minting new index objects, so the index identity
	 * alone is not a safe key).
	 */
	private readonly indexKeyCollationsCache = new WeakMap<
		TableIndexSchema,
		{ columns: ReadonlyArray<ColumnSchema>; collations: (string | undefined)[] }
	>();

	/**
	 * Per-column KEY collation for `index`'s own columns, memoized — see
	 * {@link resolveIndexKeyCollations}. The one resolution every scan-side encode site
	 * ({@link analyzeIndexAccess}, {@link buildIndexRangeBounds}, {@link scanMultiSeek})
	 * threads into `buildIndexPrefixBounds`, so a scan window can never address
	 * different bytes than the maintenance writes.
	 */
	protected indexKeyCollations(index: TableIndexSchema): (string | undefined)[] {
		const columns = this.tableSchema!.columns;
		const cached = this.indexKeyCollationsCache.get(index);
		if (cached && cached.columns === columns) return cached.collations;
		const collations = resolveIndexKeyCollations(index, columns);
		this.indexKeyCollationsCache.set(index, { columns, collations });
		return collations;
	}

	/**
	 * Per-column comparators stating the store's actual index-key BYTE order for
	 * `indexName` — the `VirtualTable.getIndexComparator` isolation hook, mirroring
	 * `MemoryTable.getIndexComparator`. The isolation layer merges the overlay's pending
	 * rows against this table's index scan by `(indexKey, PK)` sort key and prefers these
	 * over its descriptor-derived fallback, so each column's comparator must reproduce
	 * the order {@link scanIndex} emits in:
	 *   - the column's KEY collation ({@link indexKeyCollations}: index COLLATE, else the
	 *     table column's declared collation, else BINARY) for text;
	 *   - the logical type's `compare` for a semantic-ordering column (its key bytes
	 *     encode through an order-preserving transform — see `storeSemanticKeyTransform`);
	 *   - negated for a DESC column (its key bytes are bit-inverted).
	 * Resolved against the MATERIALIZED schema so a hidden `_uc_*` name resolves too.
	 */
	getIndexComparator(indexName: string): CompareFn[] | undefined {
		const schema = this.materializedSchema;
		const index = schema.indexes?.find(ix => ix.name.toLowerCase() === indexName.toLowerCase());
		if (!index) return undefined;
		const keyCollations = this.indexKeyCollations(index);
		return index.columns.map((col, i) => {
			const columnSchema = schema.columns[col.index];
			const name = keyCollations[i];
			const collationFunc = name ? this.collationResolver(name) : undefined;
			const typedComparator = createTypedComparator(columnSchema.logicalType, collationFunc);
			return col.desc
				? (a: SqlValue, b: SqlValue): number => -typedComparator(a, b)
				: typedComparator;
		});
	}

	/**
	 * True when a byte window over `leadingCol` of `index` reproduces the comparator's
	 * order. Mirrors the range arm of `tryIndexAccessPlan` (store-module-access-plan.ts): both
	 * demand the table key collation K equal the index column's effective collation C, plus
	 * K's `orderPreserving` assertion. Index-column bytes now encode under C itself
	 * (`resolveIndexKeyCollations`), so the K-vs-C comparison is CONSERVATIVE — it declines
	 * `C ≠ K` windows that would in fact be sound — but it must stay in lockstep with the
	 * planner's `rangeSafeToHandle` until the guard collapse lands
	 * (tickets: store-index-collation-guard-collapse), or a plan the planner declined could
	 * be answered here and vice versa.
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
	 * Each bound value is encoded under the leading index column's own key `collation`
	 * ({@link indexKeyCollations}) and DESC `dir` — exactly as {@link buildIndexKey}
	 * encodes that column — via {@link buildIndexPrefixBounds}, giving the byte region
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
		collation: string | undefined,
	): IterateOptions {
		const full = buildFullScanBounds();
		let gte: Uint8Array = full.gte;
		let lt: Uint8Array | undefined;

		for (const c of constraints) {
			if (c.value === undefined || c.value === null) continue;
			const { gte: lo, lt: hi } = buildIndexPrefixBounds([c.value], this.encodeOptions, [dir], [collation]);
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
	 *   - Tuples whose encoded prefix byte-matches (duplicate bound parameters, or
	 *     case variants under a NOCASE key collation C) share ONE window, each kept
	 *     as a residual alternative — see {@link MultiSeekWindowContext}.
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
		// The encoded byte windows below carry no residual able to resurrect a
		// skipped row, so a seek column whose byte equality under-fetches the type's
		// equality (TIMESPAN, JSON — see pkHasSemanticOrderingMember) cannot be
		// multi-seeked. `tryIndexAccessPlan` (store-module-access-plan.ts) declines such plans; one
		// arriving anyway is malformed.
		if (seekCols.some(colIdx => hasSemanticOrdering(this.tableSchema!.columns[colIdx]?.logicalType))) {
			this.multiSeekMalformed(filterInfo, 'semantic-ordering seek column');
		}

		// One window per distinct encoded tuple prefix (each column under its own key
		// collation C — see indexKeyCollations); C-equal tuples merge into one window,
		// each kept as a residual alternative.
		const seekCollations = this.indexKeyCollations(index).slice(0, seekWidth);
		const windows = new Map<string, MultiSeekWindow>();
		for (const tuple of tuples) {
			const ordered = this.orderTupleValues(tuple, seekCols, filterInfo);
			const bounds = buildIndexPrefixBounds(ordered, this.encodeOptions, indexDirections.slice(0, seekWidth), seekCollations);
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
	 * NOT reachable from this module's own plans today: `computeBestAccessPlan` (store-module-access-plan.ts)
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
	 * pushed constraint is fully covered, and the same source `StoreTableConstraints`'
	 * UNIQUE checks compare under. On a collation MATCH the planner drops the residual
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
 * encoded byte window {@link StoreTableScan.scanIndex} iterates. `point` is a
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
 * constraint order (see {@link StoreTableScan.decodeMultiSeekTuples}).
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
 * Per-window context a multi-seek passes to {@link StoreTableScan.scanIndex} (absent for
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
 * `extraTuples` — additional seek tuples whose encoded window byte-equals this
 * window's (duplicate bound parameters, or case-variant values under a NOCASE key
 * collation). A row is yielded when it matches the primary FilterInfo OR any of
 * these. Index bytes now encode under the same collation C the residual compares
 * under (`indexKeyCollations`), so byte-equal tuples are C-equal and each merged
 * tuple's residual admits the same rows — the OR is redundancy, kept because it is
 * what makes the fold safe by construction rather than by that argument, and it is
 * what a custom equality-only normalizer (byte-equal ⇏ comparator-equal order but
 * equal partition) still relies on.
 */
interface MultiSeekWindowContext {
	seen: Set<string>;
	collations: ReadonlyMap<number, CollationFunction>;
	extraTuples: readonly FilterInfo[];
}

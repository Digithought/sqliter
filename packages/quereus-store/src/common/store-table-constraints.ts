/**
 * Secondary-index maintenance and UNIQUE enforcement for the KVStore-backed
 * virtual table — the two halves of keeping a table's indexes and uniqueness
 * invariants true across a write. Index upkeep is how UNIQUE is enforced (a
 * conflict is answered by a seek when an index soundly covers the constraint's
 * enforcement collations, and by a data-store scan otherwise), and a REPLACE
 * eviction needs both.
 *
 * Third layer of the store-table chain:
 *   StoreTableBase -> StoreTableScan -> StoreTableConstraints -> StoreTable
 */

import {
	ConflictResolution,
	compareSqlValues,
	resolveUniqueEnforcementCollations,
	uniqueEnforcementComparators,
	compilePredicate,
	maintainedTableUniqueViolationError,
	uniqueEnforcementCollations,
	type DatabaseInternal,
	type CollationFunction,
	type MaintainedTableSchema,
	type TableIndexSchema,
	type UniqueConstraintSchema,
	type CompiledPredicate,
	type Row,
	type SqlValue,
	type UpdateResult,
	type BackingRowChange,
} from '@quereus/quereus';

import { bytesToHex } from './bytes.js';
import {
	buildIndexKey,
	buildIndexPrefixBounds,
	buildFullScanBounds,
} from './key-builder.js';
import {
	deserializeRow,
} from './serialization.js';
import { columnCanHoldText, resolveIndexKeyCollations, resolveIndexKeyTransforms, resolvePkSemanticEquality } from './pk-key-resolution.js';
import { findReusableIndexForUnique, implicitUniqueIndexName, withImplicitUniqueIndexes } from './implicit-unique-index.js';

import { StoreTableScan } from './store-table-scan.js';

/** A UNIQUE conflict: the offending row and the primary key it lives at. */
type UniqueConflict = { pk: SqlValue[]; row: Row };

/**
 * Returned by {@link StoreTableConstraints.findUniqueConflictViaIndex} when the index
 * cannot soundly answer the check and the caller must fall back to the full
 * data-store scan. Distinct from `null`, which means "the index answered: no
 * conflict".
 */
const INDEX_UNUSABLE = Symbol('store.uniqueIndexUnusable');

/**
 * Index-maintenance and UNIQUE-enforcement layer of the generic KVStore-backed
 * virtual table.
 *
 * Conflict detection compares under the constraint's ENFORCEMENT collations,
 * which need not match the collations the index keys under — every index-seek
 * shortcut here is gated on that agreement and falls back to the data-store scan
 * when it cannot be shown.
 */
export abstract class StoreTableConstraints extends StoreTableScan {
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
			// Each index column keys under its OWN collation (index COLLATE ?? table column
			// collation ?? BINARY) — the same resolution `buildIndexEntries` uses for the
			// build/rebuild path; the two MUST agree or a maintenance delete misses the
			// entry the build wrote and the index silently rots.
			const indexCollations = resolveIndexKeyCollations(index, this.tableSchema!.columns);

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
					{ values: oldIndexValues, directions: indexDirections, collations: indexCollations, transforms: indexTransforms },
					{ values: oldPk, directions: this.pkDirections, collations: this.pkKeyCollations, transforms: this.pkKeyTransforms },
					this.encodeOptions,
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
					{ values: newIndexValues, directions: indexDirections, collations: indexCollations, transforms: indexTransforms },
					{ values: newPk, directions: this.pkDirections, collations: this.pkKeyCollations, transforms: this.pkKeyTransforms },
					this.encodeOptions,
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
	 * Every non-derived UNIQUE is realized by an index in the materialized schema
	 * — a hidden `_uc_*`, or the explicit index it reuses when one covers the same
	 * columns (see {@link withImplicitUniqueIndexes} /
	 * {@link findReusableIndexForUnique}) — so, like the memory backend, a plain
	 * column- or table-level `UNIQUE` is index-servable, not only an explicit
	 * `CREATE INDEX`. A UC is index-servable when:
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

		let index: TableIndexSchema | undefined;
		if (uc.derivedFromIndex) {
			index = indexes.find(ix => ix.name === uc.derivedFromIndex);
		} else {
			// Among the column-set matches, prefer the constraint's OWN index by name
			// (`implicitUniqueIndexName` — the `_uc_*` the materializer minted for it).
			// `withImplicitUniqueIndexes` APPENDS `_uc_*` after the explicit indexes, so a
			// bare first-match would land on an explicit index that
			// `findReusableIndexForUnique` REFUSED for a collation mismatch — whose key
			// bytes now differ from the enforcement collation, so seeking it would
			// under-fetch and silently accept a duplicate. When no `_uc_*` exists the
			// remaining match is the reuse-approved index, whose collations
			// `indexCollationsMatchDeclared` proved equal to the declared ones.
			const candidates = indexes.filter(ix => ix.predicate === uc.predicate
				&& ix.columns.length === uc.columns.length
				&& ix.columns.every((c, i) => c.index === uc.columns[i]));
			const ownName = implicitUniqueIndexName(this.materializedSchema, uc).toLowerCase();
			index = candidates.find(ix => ix.name.toLowerCase() === ownName) ?? candidates[0];
		}
		if (!index) return undefined;
		return this.indexSeekHonorsEnforcementCollation(index, uc) ? index : undefined;
	}

	/**
	 * True when a point seek into `index` returns a SUPERSET of `uc`'s true conflict
	 * set — the only condition under which the seek may replace the full scan.
	 *
	 * An index key's leading (index-column) bytes are encoded under the index's own
	 * per-column key collations (`resolveIndexKeyCollations`), and the constraint
	 * re-validates candidates under its enforcement collations
	 * (`uniqueEnforcementCollations` — the index's per-column COLLATE for an
	 * index-derived UC, else the declared column collation). For every index a
	 * *designed* path can hand this method, the two resolve identically by
	 * construction — the seek window is then exactly the C-equal set — so the check
	 * is a plain per-column equality of the two resolutions (upper-cased; never-text
	 * columns exempt, their bytes being type-native).
	 *
	 * Kept rather than deleted because one undesigned path can still disagree:
	 * `withImplicitUniqueIndexes` skips materializing a `_uc_*` whose NAME is already
	 * taken (a user index literally named `_uc_email`, or a named UC colliding with an
	 * index name), and the column-set fallback in
	 * {@link findIndexForUniqueConstraint} can then hand this a same-columns index
	 * whose key collations differ from the enforcement collations. A false `true`
	 * there silently accepts a duplicate; a decline only costs the full scan.
	 */
	private indexSeekHonorsEnforcementCollation(index: TableIndexSchema, uc: UniqueConstraintSchema): boolean {
		const schema = this.tableSchema!;
		const keyCollations = resolveIndexKeyCollations(index, schema.columns);
		const enforcement = uniqueEnforcementCollations(schema, uc);
		// Positions align: index.columns[i].index === uc.columns[i], guaranteed by the
		// derived-UC construction (appendIndexToTableSchema) / the column-set match in
		// findIndexForUniqueConstraint.
		return uc.columns.every((colIdx, i) => {
			if (!columnCanHoldText(schema.columns[colIdx])) return true;
			const key = keyCollations[i];
			const C = (enforcement[i] ?? 'BINARY').toUpperCase();
			return key !== undefined && key === C;
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
		// Same per-column key collations and transforms `updateSecondaryIndexes` wrote
		// the entries under, so the probe for 'A@x' lands on the window holding the
		// NOCASE-keyed 'a@x' entry and the probe for 'PT60M' on the 'PT1H' one.
		const bounds = buildIndexPrefixBounds(
			uc.columns.map(c => newRow[c]),
			this.encodeOptions,
			index.columns.map(c => !!c.desc),
			resolveIndexKeyCollations(index, this.tableSchema!.columns),
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
	 * Fully delete the row at `pk` (data + secondary indexes + stats + delete event).
	 * Used by REPLACE conflict resolution to evict a conflicting unique row before
	 * the caller's insert/update proceeds.
	 */
	protected async deleteRowAt(
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
		this.emitOrQueueDataChange(inTransaction, {
			type: 'delete',
			schemaName: schema.schemaName,
			tableName: schema.name,
			key: pk,
			oldRow,
		});
	}
}

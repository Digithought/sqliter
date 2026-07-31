/**
 * The catalog store: how a table / view / materialized view's DDL text is turned
 * into a persisted entry, written, compared, reloaded and removed, plus the two
 * pieces of durable open/close bookkeeping that live beside it (the clean-shutdown
 * marker and the stale-materialized-view set).
 *
 * Second layer of the store-module chain:
 *   StoreModuleBase -> StoreModuleCatalog -> StoreModuleSchemaSync -> StoreModuleIndex
 *   -> StoreModuleAlterColumn -> StoreModuleAlter -> StoreModuleRename -> StoreModule
 */

import type { CatalogObjectKind, Database, MaintainedTableSchema, TableSchema, ViewSchema } from '@quereus/quereus';
import {
	exposedImplicitIndexes,
	generateIndexDDL,
	generateIndexTagsDDL,
	generateMaintainedTableDDL,
	generateTableDDL,
	generateViewDDL,
	isHiddenImplicitIndex,
	isMaintainedTable,
} from '@quereus/quereus';
import {
	CLEAN_SHUTDOWN_META_NAME,
	STALE_MVS_META_NAME,
	buildCatalogKey,
	buildCatalogScanBounds,
	buildMaterializedViewCatalogKey,
	buildMetaCatalogKey,
	buildViewCatalogKey,
	classifyCatalogKey,
} from './key-builder.js';
import { assertNoUnpairedSurrogate } from './encoding.js';
import { StoreModuleBase } from './store-module-base.js';

/** A catalog entry as it would be written: the store key and its persisted DDL text. */
interface CatalogEntry {
	key: Uint8Array;
	ddl: string;
}

/**
 * Guard the FULL persisted schema text, not just the object's own name: a lone
 * surrogate anywhere in it — a quoted column name, a `default '…'` string literal, a
 * `check` constraint's string constant — folds to U+FFFD under `TextEncoder` and would
 * read back as different schema text than what was created. Independent of the
 * catalog-key builders' identifier guard; it catches what they cannot see.
 */
function assertPersistableDdlText(ddl: string): void {
	assertNoUnpairedSurrogate(ddl, 'persisted schema text');
}

/**
 * The catalog entry a plain view would be persisted as. Building it is the check:
 * {@link buildViewCatalogKey} rejects an unencodable name, and the caller then runs
 * {@link assertPersistableDdlText} over `ddl`. Shared by the write path
 * ({@link saveViewDDL}) and the pre-flight veto
 * ({@link assertCatalogObjectPersistable}) so the two cannot drift.
 */
function viewCatalogEntry(view: ViewSchema): CatalogEntry {
	return {
		key: buildViewCatalogKey(view.schemaName, view.name),
		ddl: generateViewDDL(view),
	};
}

/**
 * The catalog entry a materialized view would be persisted as, or `undefined` when
 * `table` carries no derivation (not an MV — nothing lands under the MV prefix).
 * Counterpart of {@link viewCatalogEntry}; same write/veto sharing.
 */
function maintainedViewCatalogEntry(table: TableSchema): CatalogEntry | undefined {
	if (!isMaintainedTable(table)) return undefined;
	return {
		key: buildMaterializedViewCatalogKey(table.schemaName, table.name),
		ddl: generateMaintainedTableDDL(table),
	};
}

export abstract class StoreModuleCatalog extends StoreModuleBase {
	/**
	 * Build the catalog entry for a table: its CREATE TABLE DDL, one
	 * `CREATE [UNIQUE] INDEX` statement per persistable secondary index, and one
	 * `alter index … set tags (…)` statement per exposed implicit index carrying
	 * user tags, newline-joined into a single multi-statement bundle keyed by
	 * `{schema}.{table}`.
	 *
	 * Bundling the indexes into the table's own entry means every existing
	 * re-persist path — `saveTableDDL` (each `alterTable` arm, `renameTable`) and
	 * the `table_modified` listener (`persistCatalogIfChanged`) — carries the
	 * indexes along for free, and `removeTableDDL` drops them with the table. The
	 * bundle is consumed on reopen by `rehydrateCatalog` → `importCatalog`, whose
	 * `parser.parseAll` splits it AST-by-AST (never on `\n`) and imports each
	 * statement in document order, so the table registers before its indexes.
	 *
	 * Both the table DDL and the index DDL are emitted without a `db` arg, keeping
	 * the persistence-safe fully-qualified form. Hidden implicit covering indexes
	 * (the auto-built BTree backing a declared UNIQUE constraint) are excluded —
	 * they are a backing detail that round-trips via the table's UNIQUE constraint,
	 * not as a standalone CREATE INDEX. For store tables `buildTableSchemaFromAST`
	 * synthesizes none of those, so in practice every index is included; the guard
	 * is defensive. A `CREATE UNIQUE INDEX`'s derived UNIQUE constraint is already
	 * excluded from the table DDL by the generator, so it round-trips solely via
	 * its own `CREATE UNIQUE INDEX` line — no doubling.
	 *
	 * An *exposed* implicit index (a non-derived UNIQUE constraint tagged
	 * `quereus.expose_implicit_index = true`, never materialized in store mode)
	 * must NOT get a synthetic `CREATE INDEX` line — re-import would materialize a
	 * real `IndexSchema` and change the store-mode shape. Its user tags
	 * (`UniqueConstraintSchema.exposedIndexTags`) instead ride a trailing
	 * `alter index … set tags` line, which `importDDL` re-applies silently after
	 * the CREATE TABLE in the same entry has registered the constraint. Empty tag
	 * records emit no line, and `exposedImplicitIndexes` returns `[]` for
	 * memory-mode tables (name materialized) and orders descriptors by the
	 * `uniqueConstraints` array, so the bundle stays byte-deterministic — which
	 * the compare-write in `persistCatalogIfChanged` relies on.
	 */
	private buildCatalogEntry(tableSchema: TableSchema): string {
		// `tableSchema` is always the engine-facing schema (no `_uc_*`; the store keeps the
		// materialized enforcement copy internal), so hidden implicit indexes reach here
		// only through the `uniqueConstraints`-driven `isHiddenImplicitIndex` /
		// `exposedImplicitIndexes` paths — never as a materialized `CREATE INDEX`.
		const parts: string[] = [generateTableDDL(tableSchema)];
		for (const idx of tableSchema.indexes ?? []) {
			if (isHiddenImplicitIndex(tableSchema, idx.name)) continue;
			parts.push(generateIndexDDL(idx, tableSchema));
		}
		for (const desc of exposedImplicitIndexes(tableSchema)) {
			if (desc.tags && Object.keys(desc.tags).length > 0) {
				parts.push(generateIndexTagsDDL(tableSchema.schemaName, desc.name, desc.tags));
			}
		}
		return parts.join('\n');
	}

	/**
	 * Encode a bundle of persisted schema text (DDL) for the catalog store.
	 * The guard is {@link assertPersistableDdlText} — see it for why the FULL text
	 * is checked, not just the object's name.
	 */
	private encodeCatalogDDL(ddl: string): Uint8Array {
		assertPersistableDdlText(ddl);
		return new TextEncoder().encode(ddl);
	}

	/**
	 * The catalog entry a plain table would be persisted as: its `{schema}.{table}` key
	 * (which {@link buildCatalogKey} refuses for an unencodable identifier) plus the DDL
	 * bundle {@link buildCatalogEntry} produces. Counterpart of {@link viewCatalogEntry} /
	 * {@link maintainedViewCatalogEntry}, and shared the same way — by the write path
	 * ({@link saveTableDDL}) and by the pre-flight veto
	 * ({@link assertCatalogObjectPersistable}) — so the two cannot drift.
	 */
	private tableCatalogEntry(tableSchema: TableSchema): CatalogEntry {
		return {
			key: buildCatalogKey(tableSchema.schemaName, tableSchema.name),
			ddl: this.buildCatalogEntry(tableSchema),
		};
	}

	/**
	 * Save table DDL (bundled with its secondary index DDL) to the catalog store.
	 */
	async saveTableDDL(tableSchema: TableSchema): Promise<void> {
		const { key, ddl } = this.tableCatalogEntry(tableSchema);
		const catalogStore = await this.provider.getCatalogStore();
		await catalogStore.put(key, this.encodeCatalogDDL(ddl));
	}

	/**
	 * Remove DDL from the catalog store when a table is dropped.
	 */
	async removeTableDDL(schemaName: string, tableName: string): Promise<void> {
		const catalogKey = buildCatalogKey(schemaName, tableName);
		const catalogStore = await this.provider.getCatalogStore();
		await catalogStore.delete(catalogKey);
	}

	/**
	 * Persist a plain view's catalog entry (DDL via `generateViewDDL`), keyed by its
	 * reserved view prefix. Compare-write (skip identical) — see
	 * {@link persistObjectCatalogEntryIfChanged}.
	 */
	async saveViewDDL(view: ViewSchema): Promise<void> {
		const { key, ddl } = viewCatalogEntry(view);
		await this.persistObjectCatalogEntryIfChanged(key, ddl);
	}

	/** Remove a plain view's catalog entry (on DROP VIEW). */
	async removeViewDDL(schemaName: string, viewName: string): Promise<void> {
		const catalogStore = await this.provider.getCatalogStore();
		await catalogStore.delete(buildViewCatalogKey(schemaName, viewName));
	}

	/**
	 * Persist a materialized view's catalog entry (DDL via `generateMaintainedTableDDL`
	 * over the maintained table — the unified record), keyed by its reserved MV
	 * prefix. Compare-write (skip identical) — see
	 * {@link persistObjectCatalogEntryIfChanged}.
	 */
	async saveMaterializedViewDDL(mv: MaintainedTableSchema): Promise<void> {
		const entry = maintainedViewCatalogEntry(mv);
		// Callers only reach here with a maintained table; the guard keeps the shared
		// helper's `undefined` arm honest rather than asserting non-null.
		if (!entry) return;
		await this.persistObjectCatalogEntryIfChanged(entry.key, entry.ddl);
	}

	/** Remove a materialized view's catalog entry (on DROP MATERIALIZED VIEW). */
	async removeMaterializedViewDDL(schemaName: string, mvName: string): Promise<void> {
		const catalogStore = await this.provider.getCatalogStore();
		await catalogStore.delete(buildMaterializedViewCatalogKey(schemaName, mvName));
	}

	/**
	 * Pre-flight veto (see `VirtualTableModule.assertCatalogObjectPersistable`): refuse a
	 * view / materialized view / table whose catalog entry this module could not durably
	 * write.
	 *
	 * It runs exactly the derivation the write path runs — {@link viewCatalogEntry} /
	 * {@link maintainedViewCatalogEntry} / {@link tableCatalogEntry} build the key
	 * (rejecting an unencodable identifier) and {@link assertPersistableDdlText} checks the
	 * generated DDL text — so the veto and the write cannot disagree about what is
	 * persistable. It is the only synchronous path a rejection can travel: the actual save
	 * is chained onto `persistQueue` behind a `SchemaChangeNotifier` listener, and both
	 * layers swallow.
	 *
	 * The `'table'` kind arrives only from the RENAME pre-flight scan, which offers EVERY
	 * table in every schema whose record the propagation would rewrite — most of them not
	 * ours. {@link ownsTableCatalogEntry} is the synchronous self-filter that keeps a
	 * memory-backed dependent from being refused on our behalf.
	 *
	 * Gated on `subscribedDb === db`: this module persists a view/MV only while subscribed
	 * to that `Database`'s change notifier (`StoreModuleSchemaSync.ensureSchemaSubscription`, driven by the
	 * first `create`/`connect`/`alterTable`/`rehydrateCatalog`). A module registered but
	 * never handed a `db` writes nothing, so vetoing there would reject a definition that
	 * loses nothing. The gate becomes removable if persistence is ever made unconditional
	 * (`bug-store-untouched-table-and-early-view-never-persisted`).
	 */
	// NOTE: regenerates the object's full DDL text on every CREATE VIEW / CREATE MATERIALIZED
	// VIEW / view-or-MV SET TAGS, and the persist that follows regenerates it again. DDL is
	// rare and the text is small, so the duplicate render is not worth caching today; if a
	// schema-heavy workload (a large `apply schema` deploying many views) ever shows up hot
	// here, thread the already-built CatalogEntry from the veto through to the write.
	assertCatalogObjectPersistable(db: Database, kind: CatalogObjectKind, object: ViewSchema | TableSchema): void {
		if (this.subscribedDb !== db) return;
		const entry = this.prospectiveCatalogEntry(kind, object);
		if (entry) assertPersistableDdlText(entry.ddl);
	}

	/**
	 * The entry {@link assertCatalogObjectPersistable} is being asked about, or `undefined`
	 * when this module would write none for it (a non-maintained table offered as
	 * `'materializedView'`, or a table we do not own).
	 */
	private prospectiveCatalogEntry(
		kind: CatalogObjectKind,
		object: ViewSchema | TableSchema,
	): CatalogEntry | undefined {
		switch (kind) {
			case 'view': return viewCatalogEntry(object as ViewSchema);
			case 'materializedView': return maintainedViewCatalogEntry(object as TableSchema);
			case 'table': {
				const table = object as TableSchema;
				return this.ownsTableCatalogEntry(table) ? this.tableCatalogEntry(table) : undefined;
			}
		}
	}

	/**
	 * Whether this module would be the one to write `table`'s catalog entry — the
	 * synchronous stand-in for the write path's absent-entry self-filter (see
	 * {@link persistCatalogIfChanged}), which reads the catalog store and so is unavailable
	 * to a hook that is synchronous and IO-free by contract.
	 *
	 * Ownership is tested exactly as `StoreModule.resolveOwnedTable` tests it: a table this
	 * session already touched (it is in `tables`), or one whose `vtabModule` is this module
	 * — or a WRAPPER exposing this module as `underlying`, which is what a store table looks
	 * like under `@quereus/quereus-isolation` (its `vtabModule` is the `IsolationModule`).
	 * Not ours ⇒ no entry ⇒ no check, which is what keeps a memory-backed dependent table in
	 * a database that also has store tables from being refused.
	 *
	 * Where this is STRICTER than the write path — a store-owned table whose catalog entry
	 * has not been written yet, which `persistCatalogIfChanged` would skip — refusing is the
	 * safe side: that table's eventual lazy `saveTableDDL` would throw on the diverged text
	 * anyway, on the same swallowing path with nothing left to tell the user.
	 */
	private ownsTableCatalogEntry(table: TableSchema): boolean {
		const tableKey = `${table.schemaName}.${table.name}`.toLowerCase();
		if (this.tables.has(tableKey)) return true;
		const owner = table.vtabModule as unknown as { underlying?: unknown } | undefined;
		return owner === this || owner?.underlying === this;
	}

	/**
	 * Compare-write a view/MV catalog entry: write only when the entry is absent or its
	 * DDL differs from `newDDL` (skip identical). Unlike the table path's
	 * {@link persistCatalogIfChanged} there is **no** absent→skip self-filter — a view/MV
	 * belongs to this db's catalog unconditionally (one module instance serves one
	 * Database). Skipping identical writes makes any event whose regenerated DDL is
	 * unchanged (e.g. a `materialized_view_refreshed`) a no-op, so a second consecutive
	 * reopen yields identical catalog bytes. (Rehydration itself fires no view/MV events
	 * at all — `importCatalog` is silent.)
	 */
	private async persistObjectCatalogEntryIfChanged(key: Uint8Array, newDDL: string): Promise<void> {
		const catalogStore = await this.provider.getCatalogStore();
		const existing = await catalogStore.get(key);
		if (existing !== undefined && new TextDecoder().decode(existing) === newDDL) return;
		await catalogStore.put(key, this.encodeCatalogDDL(newDDL));
	}

	/**
	 * Read-compare-write the catalog DDL for a table that just fired `table_modified`.
	 *
	 * - **Absent** catalog entry → the table is not store-backed in this catalog (a
	 *   memory table in the same `db`, or a store table never persisted) → skip. This
	 *   self-filters foreign-module tables without relying on `vtabModule` identity
	 *   (which points at the isolation wrapper when wrapped).
	 * - **Present** but identical DDL → skip (no redundant write). This is what makes a
	 *   structural ALTER — whose own `alterTable` already wrote the final DDL, then fires
	 *   `table_modified` with that same final schema — a no-op here (no double-write).
	 * - **Present** and different DDL → re-persist (the tag swap; or a beneficial
	 *   propagated rewrite of a dependent store table).
	 */
	protected async persistCatalogIfChanged(key: Uint8Array, newObject: TableSchema): Promise<void> {
		const catalogStore = await this.provider.getCatalogStore();
		const existing = await catalogStore.get(key);
		if (existing === undefined) return; // not store-backed in this catalog — skip

		// Regenerate the full bundle (table DDL + index DDL + exposed-implicit-index
		// tag DDL): a SET TAGS on an index fires `table_modified` on the OWNING table
		// with the updated index in `tableSchema.indexes` — or, for an exposed
		// implicit index, with the updated `exposedIndexTags` on the originating
		// UNIQUE constraint — so the changed DDL re-persists here with no
		// index-specific plumbing. An identical bundle is what makes a structural
		// ALTER (and the createIndex follow-up event) a no-op — no double-write.
		const newDDL = this.buildCatalogEntry(newObject);
		const existingDDL = new TextDecoder().decode(existing);
		if (existingDDL === newDDL) return; // identical — no redundant write

		await catalogStore.put(key, this.encodeCatalogDDL(newDDL));
	}

	/**
	 * Load all DDL **values** from the catalog store (keys discarded).
	 * Used to restore persisted tables on startup and by tests asserting persisted DDL.
	 * Note: this returns table, view, AND materialized-view entries intermixed —
	 * `StoreModuleSchemaSync.rehydrateCatalog` uses {@link loadCatalogEntries} (keys retained) to
	 * classify them. Meta entries (e.g. the clean-shutdown marker) are not DDL
	 * and are filtered out.
	 */
	async loadAllDDL(): Promise<string[]> {
		const catalogStore = await this.provider.getCatalogStore();
		const bounds = buildCatalogScanBounds();
		const decoder = new TextDecoder();
		const ddlStatements: string[] = [];

		for await (const entry of catalogStore.iterate(bounds)) {
			if (classifyCatalogKey(entry.key) === 'meta') continue;
			const ddl = decoder.decode(entry.value);
			ddlStatements.push(ddl);
		}

		return ddlStatements;
	}

	/**
	 * Load every catalog entry as `{ key, ddl }`. Unlike {@link loadAllDDL} (values
	 * only) this retains the key so `StoreModuleSchemaSync.rehydrateCatalog` can classify each entry
	 * (table / view / materialized view) by its reserved key prefix.
	 */
	protected async loadCatalogEntries(): Promise<Array<{ key: Uint8Array; ddl: string }>> {
		const catalogStore = await this.provider.getCatalogStore();
		const decoder = new TextDecoder();
		const entries: Array<{ key: Uint8Array; ddl: string }> = [];
		for await (const entry of catalogStore.iterate(buildCatalogScanBounds())) {
			entries.push({ key: entry.key, ddl: decoder.decode(entry.value) });
		}
		return entries;
	}

	/**
	 * Consume the clean-shutdown marker, deleting it in the same breath (single-use).
	 *
	 * Returns `{ trusted, staleAtClose }`:
	 * - `trusted` — the marker was present AND its payload parsed as a string array.
	 *   Absence (a fresh store, a crash, or a prior rehydrate without an intervening
	 *   `StoreModule.closeAll`) yields `false`, so every adopt this session falls back to
	 *   refill.
	 * - `staleAtClose` — the qualified lowercased `schema.mv` names that were
	 *   stale-at-close (written by `StoreModule.closeAll`); those MVs refill even under trust.
	 *
	 * Conservative parse: any unparseable / wrong-shape payload (including a legacy
	 * bare `'1'`, which parses to a number, not an array) degrades to
	 * `{ trusted: false, staleAtClose: ∅ }` — refill everything — rather than
	 * trust-everything. The marker is deleted regardless of parse outcome.
	 */
	protected async consumeCleanShutdownMarker(): Promise<{ trusted: boolean; staleAtClose: ReadonlySet<string> }> {
		const catalogStore = await this.provider.getCatalogStore();
		const markerKey = buildMetaCatalogKey(CLEAN_SHUTDOWN_META_NAME);
		const raw = await catalogStore.get(markerKey);
		if (raw === undefined) return { trusted: false, staleAtClose: new Set() };
		// Single-use AND durable-before-session-writes: forcing this delete to stable
		// storage before any of the session's (independently flushed, different-store)
		// data writes can land closes the power-loss window where a persisted data write
		// outlives a lost marker-delete and resurrects a consumed marker. (Backends
		// without a durability knob no-op the hint — losing it is conservative there, and
		// memory has no crash.) See docs/mv-backing-host.md § Cross-module atomicity.
		await catalogStore.delete(markerKey, { sync: true }); // single-use, regardless of parse outcome

		try {
			const parsed: unknown = JSON.parse(new TextDecoder().decode(raw));
			if (!Array.isArray(parsed) || !parsed.every((s): s is string => typeof s === 'string')) {
				console.warn('[StoreModule] clean-shutdown marker payload is not a string array; refilling all backings.');
				return { trusted: false, staleAtClose: new Set() };
			}
			return { trusted: true, staleAtClose: new Set(parsed) };
		} catch (e) {
			console.warn(
				`[StoreModule] clean-shutdown marker payload did not parse as JSON; refilling all backings: ${
					e instanceof Error ? e.message : String(e)
				}`,
			);
			return { trusted: false, staleAtClose: new Set() };
		}
	}

	/**
	 * Write the durable stale-MV set (`\x00meta\x00stale_mvs`) with `sync: true`. Unlike
	 * the clean-shutdown marker this entry is persistent current-truth — overwritten as
	 * staleness changes, never deleted — so a crash leaves the last synced value intact.
	 * The `sync` mirrors the marker-consume delete's durability discipline (and carries
	 * the same documented backend caveat: a backend without a durability knob no-ops it).
	 */
	protected async writeDurableStaleMvSet(json: string): Promise<void> {
		const catalogStore = await this.provider.getCatalogStore();
		await catalogStore.put(
			buildMetaCatalogKey(STALE_MVS_META_NAME),
			new TextEncoder().encode(json),
			{ sync: true },
		);
	}

	/**
	 * Read + conservative-parse the durable stale-MV set, mirroring
	 * {@link consumeCleanShutdownMarker}'s parse discipline (but READ-only — never
	 * deleted). Returns:
	 * - `{ present: false }` — no entry on disk (a pre-atomic store, or an upgrade where
	 *   the capability was gained but no stale-set has been written yet) → the caller
	 *   falls back to the clean-shutdown marker path.
	 * - `{ present: true, stale }` — the parsed set of qualified `schema.mv` names.
	 * - `{ present: true, stale: null }` — a present but unparseable / wrong-shape payload
	 *   → the caller refills everything (the always-safe posture).
	 */
	protected async readDurableStaleMvSet(): Promise<
		{ present: false } | { present: true; stale: ReadonlySet<string> | null }
	> {
		const catalogStore = await this.provider.getCatalogStore();
		const raw = await catalogStore.get(buildMetaCatalogKey(STALE_MVS_META_NAME));
		if (raw === undefined) return { present: false };
		try {
			const parsed: unknown = JSON.parse(new TextDecoder().decode(raw));
			if (!Array.isArray(parsed) || !parsed.every((s): s is string => typeof s === 'string')) {
				console.warn('[StoreModule] durable stale-MV set payload is not a string array; refilling all backings.');
				return { present: true, stale: null };
			}
			return { present: true, stale: new Set(parsed) };
		} catch (e) {
			console.warn(
				`[StoreModule] durable stale-MV set payload did not parse as JSON; refilling all backings: ${
					e instanceof Error ? e.message : String(e)
				}`,
			);
			return { present: true, stale: null };
		}
	}
}

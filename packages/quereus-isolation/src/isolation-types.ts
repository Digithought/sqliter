import type { Database, TableIndexSchema as IndexSchema, VirtualTable, VirtualTableModule } from '@quereus/quereus';

/** Partial-index predicate AST, as `IndexSchema`/`UniqueConstraintSchema` carry it. */
export type Predicate = NonNullable<IndexSchema['predicate']>;

/**
 * Configuration for creating an isolation-wrapped module.
 */
export interface IsolationModuleConfig {
	/**
	 * The module to wrap with isolation semantics.
	 */
	underlying: VirtualTableModule<any, any>;

	/**
	 * Module to use for overlay storage (uncommitted changes).
	 * Defaults to memory vtab if not specified.
	 *
	 * A host-injected module must honor the partial predicates on the index/UNIQUE schemas
	 * the isolation layer builds (see `IsolationModule.liveRowPredicate`), and its
	 * `alterSchema` must honor the `validateOnly` dry-run parameter (see
	 * `VirtualTable.alterSchema`) — the isolation layer pre-flights a primary-key re-keying
	 * `alter column … set collate` against the overlay before the shared underlying mutates
	 * irreversibly, and a module that silently applies instead of validating would re-key
	 * the overlay early and break that sequencing.
	 */
	overlay?: VirtualTableModule<any, any>;

	/**
	 * Column name to use for tombstone marker in overlay tables.
	 * Defaults to '_tombstone'.
	 */
	tombstoneColumn?: string;
}

/**
 * Per-table state tracking the underlying table (shared across all connections).
 */
export interface UnderlyingTableState {
	underlyingTable: VirtualTable;
}

/**
 * Per-connection overlay state for a specific table.
 * Each connection gets its own overlay that persists across IsolatedTable instances.
 */
export interface ConnectionOverlayState {
	overlayTable: VirtualTable;
	hasChanges: boolean;
	/**
	 * The `Database` this overlay was created against — carried so
	 * `IsolationModule.releaseOverlayTable` can free the overlay's staging
	 * table on ANY discard path, including `IsolationModule.destroy` and
	 * `IsolationModule.closeAll`, which sweep overlays across multiple db ids
	 * and so have no single ambient `db` to hand the overlay module's `destroy`.
	 * Set at every real creation site (`ensureOverlay`, and the ALTER PRIMARY KEY
	 * clean-overlay swap in `replaceOverlayForPrimaryKeyChange`); the default
	 * `MemoryTableModule` overlay ignores it, but a host-injected `config.overlay`
	 * keyed per-db needs the overlay's OWN db, not the sweeper's.
	 */
	db: Database;
	/**
	 * Set by a cross-connection DDL that left this (foreign) overlay unflushable:
	 * an ALTER that could not migrate it to the post-alter column layout (the overlay
	 * still holds PRE-alter rows, structurally inconsistent with the now-committed
	 * schema), or a DROP TABLE that removed the table it stages rows for. Either way
	 * any data op that would merge or flush it must throw this message. Undefined =
	 * healthy. Cleared only by discarding the overlay (rollback / commit-failure →
	 * rollback).
	 */
	poison?: { message: string };
}

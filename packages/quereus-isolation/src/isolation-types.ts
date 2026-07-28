import type { VirtualTableModule } from '@quereus/quereus';

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

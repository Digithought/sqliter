/**
 * A module that omits the `alterTable` hook entirely — the stand-in for a third-party backend
 * that cannot re-key itself. Storage is delegated to an inner memory module, but this is NOT a
 * `MemoryTableModule` subclass, so the engine's memory-specific ALTER PRIMARY KEY fast paths
 * are not mistakenly taken.
 *
 * `renameTable` is omitted by default too, which matters for ALTER PRIMARY KEY: the engine's
 * fallback rebuild ends in a DROP + RENAME, so a module without the hook keeps its rows under
 * the shadow table's name. Pass `withRenameTable: true` for the backend shape that CAN take
 * the rebuild.
 *
 * Shared by `alter-table-conformance.spec.ts` and `alter-primary-key-in-transaction.spec.ts`.
 */

import { MemoryTableModule } from '../src/vtab/memory/module.js';
import type { AnyVirtualTableModule } from '../src/vtab/module.js';

export function makeNoAlterModule(opts: { withRenameTable?: boolean } = {}): AnyVirtualTableModule {
	const inner = new MemoryTableModule();
	return {
		concurrencyMode: inner.concurrencyMode,
		create: inner.create.bind(inner),
		connect: inner.connect.bind(inner),
		destroy: inner.destroy.bind(inner),
		getCapabilities: inner.getCapabilities.bind(inner),
		getBestAccessPlan: inner.getBestAccessPlan.bind(inner),
		// alterTable intentionally omitted; `renameTable` too unless opted back in.
		...(opts.withRenameTable ? { renameTable: inner.renameTable.bind(inner) } : {}),
	};
}

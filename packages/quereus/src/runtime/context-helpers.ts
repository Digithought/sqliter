import type { RuntimeContext } from './types.js';
import type { RowDescriptor, RowGetter } from '../planner/nodes/plan-node.js';
import type { SqlValue, Row } from '../common/types.js';
import { QuereusError } from '../common/errors.js';
import { StatusCode } from '../common/types.js';
import { createLogger } from '../common/logger.js';
import { CONTEXT_STRICT } from './strict-flags.js';

const ctxLog = createLogger('runtime:context');
const ctxLookupLog = createLogger('runtime:context:lookup');

type IndexEntry = { rowGetter: RowGetter; columnIndex: number };

/**
 * Best-effort label identifying which emitter installed a row context. Threaded
 * (optionally) into {@link RowContextMap.set} / {@link createRowSlot} /
 * {@link withRowContext} purely to enrich the `QUEREUS_CONTEXT_STRICT` diagnostic.
 * Shadow **detection never depends on it** — it degrades to the descriptor's
 * attribute-ID list — so threading labels through emit sites can be incremental.
 */
export type ContextInstaller = { nodeType: string; id: string } | string;

/**
 * Iterate the attribute IDs in a descriptor, yielding [attrId, columnIndex].
 * Uses for...in to handle both sparse arrays and plain objects (e.g. spread-created
 * descriptors in aggregate.ts).
 */
export function* descriptorEntries(descriptor: RowDescriptor): Generator<[number, number]> {
	for (const key in descriptor) {
		const attrId = +key;
		const columnIndex = descriptor[attrId];
		if (columnIndex !== undefined) {
			yield [attrId, columnIndex];
		}
	}
}

/**
 * A Map-like container for row contexts that maintains a secondary
 * attribute index for O(1) column reference resolution.
 *
 * All mutations (set/delete) automatically update the index,
 * so callers that directly manipulate the context (e.g. aggregate.ts)
 * get correct index behavior for free.
 */
export class RowContextMap {
	private map = new Map<RowDescriptor, RowGetter>();

	/**
	 * Direct attribute-ID → resolver for O(1) column lookup. Last-`set`-wins:
	 * `slot.set(row)` does NOT update this; only `set`/`delete` on this map do.
	 * See the "source-attr contexts and child pulls" invariant in docs/runtime.md
	 * for why a streaming operator must release its source-attr context before
	 * pulling its child.
	 */
	readonly attributeIndex: Array<IndexEntry | undefined> = [];

	/**
	 * Strict context-shadow harness (`QUEREUS_CONTEXT_STRICT`) hooks. **Undefined
	 * on the base map** — implemented only by the strict `RowContextMap` subclass
	 * in strict-fork.ts. Declared optional so the hot paths ({@link resolveAttribute},
	 * {@link createRowSlot}'s per-row `set`) degrade to a no-op when the flag is
	 * off: no per-row cost and no epoch side-tables on the base map. `declare` so no
	 * field is emitted on the base instance — the strict subclass supplies the real
	 * implementations as instance fields.
	 */
	declare noteRowSet?: (descriptor: RowDescriptor) => void;
	declare assertNoShadow?: (attributeId: number, columnName: string | undefined, rctx: RuntimeContext) => void;

	set(descriptor: RowDescriptor, rowGetter: RowGetter, _installer?: ContextInstaller): this {
		this.map.set(descriptor, rowGetter);
		// Index this descriptor's attribute IDs (overwrites previous bindings)
		for (const [attrId, columnIndex] of descriptorEntries(descriptor)) {
			this.attributeIndex[attrId] = { rowGetter, columnIndex };
		}
		// `_installer` is ignored on the base map; the strict subclass records it.
		return this;
	}

	delete(descriptor: RowDescriptor): boolean {
		// Collect affected attribute IDs before removing
		const affectedAttrIds: number[] = [];
		for (const [attrId] of descriptorEntries(descriptor)) {
			affectedAttrIds.push(attrId);
			this.attributeIndex[attrId] = undefined;
		}
		const result = this.map.delete(descriptor);
		if (affectedAttrIds.length > 0) {
			// Rebuild affected index entries from remaining contexts.
			// Map preserves insertion order; iterating forward means the last
			// (newest) matching entry wins — matching original newest→oldest semantics.
			// Must iterate ALL remaining entries (no early termination) so newer
			// entries correctly overwrite older ones.
			for (const [desc, getter] of this.map) {
				for (const attrId of affectedAttrIds) {
					const colIdx = desc[attrId];
					if (colIdx !== undefined) {
						this.attributeIndex[attrId] = { rowGetter: getter, columnIndex: colIdx };
					}
				}
			}
		}
		return result;
	}

	get(descriptor: RowDescriptor): RowGetter | undefined {
		return this.map.get(descriptor);
	}

	entries(): MapIterator<[RowDescriptor, RowGetter]> {
		return this.map.entries();
	}

	get size(): number {
		return this.map.size;
	}
}

/**
 * A mutable slot for efficient row context management in streaming operations.
 * Avoids per-row Map mutations while maintaining context safety.
 */
export interface RowSlot {
	/** Replace the current row (cheap field write) */
	set(row: Row): void;
	/**
	 * Re-claim this slot's descriptor in the context map so its `attributeIndex`
	 * entries point back at this slot. Useful when a child iterator (e.g. an
	 * underlying scan) creates and `set`s its own slot for the same attribute
	 * IDs in between this slot's `set` calls — without re-claiming, downstream
	 * lookups would resolve through the child's slot whose row is the iterator's
	 * cursor position, not this slot's matched row.
	 *
	 * This is the *child-shadows-operator* resolution of the "source-attr
	 * contexts and child pulls" invariant (docs/runtime.md); call it before
	 * yielding (see emit/asof-scan.ts). The mirror direction —
	 * operator-shadows-child — is resolved by tear-down-before-pull instead
	 * (see emit/aggregate.ts and emit/window.ts).
	 */
	reactivate(): void;
	/** Tear down (removes descriptor from context) */
	close(): void;
}

/**
 * Create a row slot for efficient streaming context management.
 * The slot installs a context entry once and updates it by reference.
 * Perfect for scan/join/window operations that process many rows.
 */
export function createRowSlot(
	rctx: RuntimeContext,
	descriptor: RowDescriptor,
	installer?: ContextInstaller
): RowSlot {
	// Internal boxed reference - one allocation per slot
	const ref = { current: undefined as Row | undefined };

	const getter: RowGetter = () => ref.current!;

	// Install only once — RowContextMap maintains the attribute index
	rctx.context.set(descriptor, getter, installer);
	if (ctxLog.enabled && rctx.contextTracker) {
		rctx.contextTracker.addContext(descriptor, 'createRowSlot');
	}

	const attrs = Object.keys(descriptor).filter(k => descriptor[parseInt(k)] !== undefined);
	ctxLog('CREATE slot with attrs=[%s]', attrs.join(','));

	return {
		set(row: Row) {
			ref.current = row;
			// Strict-only: bump this descriptor's epoch. `slot.set` does NOT reclaim
			// the attributeIndex, so a stale operator context can keep winning while
			// this child row is newer — the shadow the harness detects.
			if (CONTEXT_STRICT) rctx.context.noteRowSet?.(descriptor);
		},
		reactivate() {
			// Re-call set() on the context map so attributeIndex points back at
			// this slot's getter for all attribute IDs in `descriptor`.
			rctx.context.set(descriptor, getter, installer);
		},
		close() {
			rctx.context.delete(descriptor);
			if (ctxLog.enabled && rctx.contextTracker) {
				rctx.contextTracker.removeContext(descriptor);
			}
			ctxLog('CLOSE slot with attrs=[%s]', attrs.join(','));
		}
	};
}

/**
 * Resolve an attribute ID to its column value in the current context.
 * Uses the attribute index for O(1) fast-path lookup. Falls back to a
 * linear scan when the indexed entry's row is not yet populated (e.g.
 * a slot created but not yet set).
 */
export function resolveAttribute(rctx: RuntimeContext, attributeId: number, columnName?: string): SqlValue {
	// Strict shadow check (QUEREUS_CONTEXT_STRICT): assert the attribute-index
	// winner is the most-recently-set live context for this attr, catching an
	// operator that left a stale source-attr context winning while a child set a
	// newer row. Off ⇒ branch not taken, no cost, no epoch bookkeeping exists.
	// See docs/runtime.md § Invariant: source-attr contexts and child pulls.
	// NOTE: per-read cost is O(live contexts carrying the attr); that count is small
	// in practice. If a pathological plan makes strict-mode CI slow, index the
	// per-attr candidate list instead of scanning all live entries.
	if (CONTEXT_STRICT) rctx.context.assertNoShadow?.(attributeId, columnName, rctx);

	const entry = rctx.context.attributeIndex[attributeId];
	if (entry !== undefined) {
		const row = entry.rowGetter();
		if (Array.isArray(row) && entry.columnIndex < row.length) {
			ctxLookupLog('FOUND column %s (attr#%d) at index %d', columnName || '?', attributeId, entry.columnIndex);
			return row[entry.columnIndex];
		}
	}

	// Fallback: the index entry's row may not be populated yet (slot created
	// but not set). Scan remaining contexts newest→oldest, matching the
	// original behavior of skipping entries with invalid rows.
	const contextsReversed = Array.from(rctx.context.entries()).reverse();
	for (const [descriptor, rowGetter] of contextsReversed) {
		const columnIndex = descriptor[attributeId];
		if (columnIndex !== undefined) {
			const row = rowGetter();
			if (Array.isArray(row) && columnIndex < row.length) {
				return row[columnIndex];
			}
		}
	}

	// Error path: attribute not found
	if (ctxLookupLog.enabled) {
		ctxLookupLog('LOOKUP FAILED for column %s (attr#%d)', columnName || '?', attributeId);

		const contextsReversed = Array.from(rctx.context.entries()).reverse();
		ctxLookupLog('Available contexts:');
		for (const [descriptor, _] of contextsReversed) {
			const attrs = Object.keys(descriptor).filter(k => descriptor[parseInt(k)] !== undefined);
			ctxLookupLog('  - Descriptor with attrs=[%s]', attrs.join(','));
		}

		if (rctx.planStack && rctx.planStack.length > 0) {
			const currentNode = rctx.planStack[rctx.planStack.length - 1];
			ctxLookupLog('LOOKUP FAILED in node %s id=%d', currentNode.nodeType, currentNode.id);
			ctxLookupLog('Execution stack: %s',
				rctx.planStack.map(n => `${n.nodeType}#${n.id}`).join(' → '));
		}
	}

	throw new QuereusError(
		`No row context found for column ${columnName || `attr#${attributeId}`}. The column reference must be evaluated within the context of its source relation.`,
		StatusCode.ERROR
	);
}

/**
 * Look up a specific column by descriptor and index.
 * Useful when you already know which descriptor contains the column.
 */
export function lookupColumn(rctx: RuntimeContext, descriptor: RowDescriptor, columnIndex: number): SqlValue | undefined {
	const rowGetter = rctx.context.get(descriptor);
	if (!rowGetter) {
		ctxLookupLog('LOOKUP by index %d - no context found', columnIndex);
		return undefined;
	}

	const row = rowGetter();
	if (Array.isArray(row) && columnIndex < row.length) {
		ctxLookupLog('LOOKUP by index %d - found value', columnIndex);
		return row[columnIndex];
	}
	ctxLookupLog('LOOKUP by index %d - index out of bounds', columnIndex);
	return undefined;
}

/**
 * Execute an async function with a temporary row context (Map.set + Map.delete).
 *
 * Useful for **one-off** evaluations such as constraint checks and DML context
 * setup where a full {@link createRowSlot} lifecycle is unnecessary.
 */
export async function withAsyncRowContext<T>(
	rctx: RuntimeContext,
	descriptor: RowDescriptor,
	rowGetter: RowGetter,
	fn: () => T | Promise<T>,
	installer?: ContextInstaller
): Promise<T> {
	const attrs = Object.keys(descriptor).filter(k => descriptor[parseInt(k)] !== undefined);
	ctxLog('PUSH async context with attrs=[%s]', attrs.join(','));

	rctx.context.set(descriptor, rowGetter, installer);
	if (ctxLog.enabled && rctx.contextTracker) {
		rctx.contextTracker.addContext(descriptor, 'withAsyncRowContext');
	}
	try {
		return await fn();
	} finally {
		rctx.context.delete(descriptor);
		if (ctxLog.enabled && rctx.contextTracker) {
			rctx.contextTracker.removeContext(descriptor);
		}
		ctxLog('POP async context with attrs=[%s]', attrs.join(','));
	}
}

/**
 * Execute a synchronous function with a temporary row context (Map.set + Map.delete).
 *
 * Useful for **one-off** evaluations where a full {@link createRowSlot}
 * lifecycle is unnecessary.
 */
export function withRowContext<T>(
	rctx: RuntimeContext,
	descriptor: RowDescriptor,
	rowGetter: RowGetter,
	fn: () => T,
	installer?: ContextInstaller
): T {
	const attrs = Object.keys(descriptor).filter(k => descriptor[parseInt(k)] !== undefined);
	ctxLog('PUSH context with attrs=[%s]', attrs.join(','));

	rctx.context.set(descriptor, rowGetter, installer);
	if (ctxLog.enabled && rctx.contextTracker) {
		rctx.contextTracker.addContext(descriptor, 'withRowContext');
	}
	try {
		return fn();
	} finally {
		rctx.context.delete(descriptor);
		if (ctxLog.enabled && rctx.contextTracker) {
			rctx.contextTracker.removeContext(descriptor);
		}
		ctxLog('POP context with attrs=[%s]', attrs.join(','));
	}
}

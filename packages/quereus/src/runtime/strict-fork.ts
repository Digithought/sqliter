import { QuereusError } from '../common/errors.js';
import { StatusCode } from '../common/types.js';
import type { RuntimeContext } from './types.js';
import type { RowDescriptor, RowGetter, TableDescriptor, TableGetter } from '../planner/nodes/plan-node.js';
import { RowContextMap, descriptorEntries, type ContextInstaller } from './context-helpers.js';
import { FORK_STRICT, CONTEXT_STRICT } from './strict-flags.js';

/**
 * Strict test harnesses for the runtime context.
 *
 * Two independent, off-by-default concerns share the one `RowContextMap`
 * subclass and the one `createStrictRowContextMap()` factory (so the ~9
 * RuntimeContext construction sites wire both at once):
 *
 *   1. **`QUEREUS_FORK_STRICT`** — parent-immutability during a fork's lifetime.
 *      Wraps `tableContexts` / `context` so mutating the *parent* while one of its
 *      forks is being driven throws. State is tracked **per parent map** (not
 *      globally) so concurrent unrelated drivers don't interfere, forks may mutate
 *      their own fresh maps freely, and sub-forks are independently tracked.
 *      See docs/runtime-parallel.md § Parallel runtime fork contract.
 *
 *   2. **`QUEREUS_CONTEXT_STRICT`** — stale-shadow detection. Maintains a per-
 *      descriptor epoch and a per-attribute index-winner map so `assertNoShadow`
 *      (called from `resolveAttribute`) can catch a streaming operator that left a
 *      stale source-attr context winning the `attributeIndex` while a child set a
 *      newer row for the same IDs. See docs/runtime.md § Invariant: source-attr
 *      contexts and child pulls, and § Strict context-shadow test mode.
 *
 * Production behavior is unchanged: when both flags are unset, every helper here
 * is a no-op pass-through and `createStrictRowContextMap()` returns a vanilla
 * `RowContextMap`.
 */

// `STRICT_MODE` retains the fork-strict meaning it had before context-strict was
// added, so the fork-contract code below reads unchanged.
const STRICT_MODE = FORK_STRICT;

/** Per-wrapped-map state: how many forks of this map are currently being driven. */
interface ForkState {
	activeForks: number;
}

/** Wrapped map → its state. Used by the proxy/subclass to know when to throw. */
const stateByWrappedMap = new WeakMap<object, ForkState>();

/** Forked map → state of the parent map it was forked from. Used by drive() to bump parent. */
const parentStateOfFork = new WeakMap<object, ForkState>();

export function strictForkEnabled(): boolean {
	return STRICT_MODE;
}

function violation(target: string, count: number): never {
	throw new QuereusError(
		`strict-fork: parent context mutated ${target} while ${count} fork(s) are active. ` +
		`This is a fork-contract violation. See docs/runtime-parallel.md § Parallel runtime fork contract.`,
		StatusCode.INTERNAL,
	);
}

/**
 * Wrap a fresh `tableContexts` Map. In non-strict mode returns the input
 * unchanged; in strict mode returns a Proxy that throws on set/delete/clear
 * while any fork of this map is being driven.
 */
export function wrapTableContextsStrict(
	map: Map<TableDescriptor, TableGetter>,
): Map<TableDescriptor, TableGetter> {
	if (!STRICT_MODE) return map;
	const state: ForkState = { activeForks: 0 };
	const proxy = new Proxy(map, {
		get(target, prop, _receiver) {
			const raw = Reflect.get(target, prop, target);
			if (typeof raw !== 'function') return raw;
			if (prop === 'set' || prop === 'delete' || prop === 'clear') {
				return function strictMutation(...args: unknown[]): unknown {
					if (state.activeForks > 0) violation('tableContexts', state.activeForks);
					return (raw as (...a: unknown[]) => unknown).apply(target, args);
				};
			}
			return (raw as (...a: unknown[]) => unknown).bind(target);
		},
	});
	stateByWrappedMap.set(proxy, state);
	return proxy;
}

/**
 * `RowContextMap` subclass carrying the state for both strict harnesses. The
 * fork-strict guard fires only when `forkState` is non-null (fork-strict on); the
 * context-strict bookkeeping runs only when `CONTEXT_STRICT`. Either concern may
 * be active without the other.
 */
class StrictRowContextMap extends RowContextMap {
	/** Fork-strict state, or null when only context-strict is active. */
	private readonly forkState: ForkState | null;

	// --- context-strict (QUEREUS_CONTEXT_STRICT) bookkeeping; touched only when the
	//     flag is on. A monotonic clock keeps every epoch unique, so the winner is
	//     unambiguously the max-epoch live context for an attr. ---
	private clock = 0;
	/** Per-descriptor epoch of its most recent set() or noteRowSet() (slot.set). */
	private readonly epoch = new Map<RowDescriptor, number>();
	/** attrId → descriptor currently winning the attributeIndex, kept in lockstep. */
	private readonly winnerByAttr: Array<RowDescriptor | undefined> = [];
	/** Best-effort installer label per descriptor, for diagnostics only. */
	private readonly installer = new Map<RowDescriptor, ContextInstaller>();

	constructor(forkState: ForkState | null) {
		super();
		this.forkState = forkState;
	}

	override set(descriptor: RowDescriptor, rowGetter: RowGetter, installer?: ContextInstaller): this {
		if (this.forkState && this.forkState.activeForks > 0) violation('context (RowContextMap)', this.forkState.activeForks);
		const ret = super.set(descriptor, rowGetter, installer);
		if (CONTEXT_STRICT) {
			// A fresh set() reclaims the index for these attrs (mirrors super.set's
			// attributeIndex rebuild) AND bumps the descriptor's epoch.
			this.epoch.set(descriptor, ++this.clock);
			if (installer !== undefined) this.installer.set(descriptor, installer);
			for (const [attrId] of descriptorEntries(descriptor)) {
				this.winnerByAttr[attrId] = descriptor;
			}
		}
		return ret;
	}

	override delete(descriptor: RowDescriptor): boolean {
		if (this.forkState && this.forkState.activeForks > 0) violation('context (RowContextMap)', this.forkState.activeForks);
		if (!CONTEXT_STRICT) return super.delete(descriptor);
		// Capture affected attrs before removal so we can rebuild winnerByAttr in the
		// same forward-iteration (last-wins) order super.delete rebuilds attributeIndex.
		const affected: number[] = [];
		for (const [attrId] of descriptorEntries(descriptor)) affected.push(attrId);
		const result = super.delete(descriptor);
		this.epoch.delete(descriptor);
		this.installer.delete(descriptor);
		for (const attrId of affected) this.winnerByAttr[attrId] = undefined;
		for (const [desc] of this.entries()) {
			for (const attrId of affected) {
				if (desc[attrId] !== undefined) this.winnerByAttr[attrId] = desc;
			}
		}
		return result;
	}

	// `noteRowSet` / `assertNoShadow` are arrow-function instance fields (not prototype
	// methods) so they cleanly override the base's `declare`d optional properties under
	// `useDefineForClassFields`.

	/**
	 * Per-row `slot.set` notification: bump the descriptor's epoch only. The winner
	 * is deliberately **not** touched — `slot.set` does not reclaim the
	 * attributeIndex, and that asymmetry is exactly the stale-shadow this harness
	 * detects.
	 */
	readonly noteRowSet = (descriptor: RowDescriptor): void => {
		this.epoch.set(descriptor, ++this.clock);
	};

	/**
	 * Assert the attribute-index winner for `attributeId` is the most-recently-set
	 * live context for it. Throws when a *different* live context carries the same
	 * attr with a strictly-newer row update **whose value for this attr differs** —
	 * the operator-shadows-child silent wrong-row.
	 *
	 * The value comparison is the load-bearing refinement over pure recency. A wider
	 * projection legitimately re-carries a source attribute (e.g. a nested-loop join
	 * output `[...left, ...right]` still exposes the left row's `d.id`) in a fresh,
	 * newer row object that agrees on the shared column. A read resolves the same
	 * value through either context, so it is not observably wrong — only a *differing*
	 * value at the resolved column is a silent wrong-row worth failing on.
	 */
	readonly assertNoShadow = (attributeId: number, columnName: string | undefined, rctx: RuntimeContext): void => {
		const winnerDesc = this.winnerByAttr[attributeId];
		if (winnerDesc === undefined) return; // no index entry — nothing can shadow
		// Skip when the winner's own row is unpopulated: resolveAttribute falls back
		// to a newest→oldest scan then, so the index winner is not actually read.
		const winnerCol = winnerDesc[attributeId];
		const winnerRow = this.get(winnerDesc)?.();
		if (winnerCol === undefined || !Array.isArray(winnerRow) || winnerCol >= winnerRow.length) return;
		const winnerVal = winnerRow[winnerCol];
		const winnerEpoch = this.epoch.get(winnerDesc) ?? -1;

		for (const [desc, getter] of this.entries()) {
			if (desc === winnerDesc) continue;
			const col = desc[attributeId];
			if (col === undefined) continue; // doesn't carry this attr
			if ((this.epoch.get(desc) ?? -1) <= winnerEpoch) continue; // not newer than winner
			const row = getter();
			if (!Array.isArray(row) || col >= row.length) continue; // unpopulated candidate — skip
			// `desc` is a strictly-newer live context for this attr. If it resolves the
			// same value the read is not observably wrong regardless of which wins — only
			// a differing value is the silent wrong-row this harness exists to catch.
			// NOTE: `===` is reference equality for blobs (Uint8Array), so two distinct
			// blob objects with identical bytes at a shared column would false-positive
			// here (test-mode only, never observed in the suite). If it ever trips, swap
			// this shared-column check for a value-aware SQL comparison (compareSqlValues).
			if (row[col] === winnerVal) continue;
			throw contextShadowError(attributeId, columnName, winnerDesc, desc, this.installer, rctx);
		}
	};
}

/**
 * Construct a `RowContextMap`. Returns the strict subclass when either strict flag
 * is on (fork-strict wraps set/delete against parent mutation; context-strict adds
 * shadow bookkeeping); otherwise the vanilla map. Use at any RuntimeContext
 * construction site instead of `new RowContextMap()`.
 */
export function createStrictRowContextMap(): RowContextMap {
	if (!STRICT_MODE && !CONTEXT_STRICT) return new RowContextMap();
	// Fork state exists only under fork-strict; context-strict-only maps pass a null
	// fork state (the guard is inert) and are not registered for fork bookkeeping.
	const forkState: ForkState | null = STRICT_MODE ? { activeForks: 0 } : null;
	const map = new StrictRowContextMap(forkState);
	if (forkState) stateByWrappedMap.set(map, forkState);
	return map;
}

/** Render a descriptor for diagnostics: its installer label if threaded, else its attr-ID list. */
function describeDescriptor(descriptor: RowDescriptor, installer: Map<RowDescriptor, ContextInstaller>): string {
	const label = installer.get(descriptor);
	if (label !== undefined) {
		return typeof label === 'string' ? label : `${label.nodeType}#${label.id}`;
	}
	const attrs: number[] = [];
	for (const [attrId] of descriptorEntries(descriptor)) attrs.push(attrId);
	return `attrs=[${attrs.join(',')}]`;
}

function contextShadowError(
	attributeId: number,
	columnName: string | undefined,
	winnerDesc: RowDescriptor,
	shadowDesc: RowDescriptor,
	installer: Map<RowDescriptor, ContextInstaller>,
	rctx: RuntimeContext,
): QuereusError {
	const col = columnName ? `${columnName} (attr#${attributeId})` : `attr#${attributeId}`;
	const winner = describeDescriptor(winnerDesc, installer);
	const shadow = describeDescriptor(shadowDesc, installer);
	// Best-effort reading operator: planStack top, populated only when tracing is on.
	const stack = rctx.planStack;
	const reader = stack && stack.length > 0
		? `${stack[stack.length - 1].nodeType}#${stack[stack.length - 1].id}`
		: 'unknown (planStack empty; enable trace-plan-stack)';
	return new QuereusError(
		`context-strict: stale-shadow on column ${col}. The attribute index still points at the ` +
		`context installed by ${winner} (stale row), but a strictly-newer row was set on the ` +
		`context installed by ${shadow}. A read here resolves to the stale row — a silent wrong-row. ` +
		`Reading operator: ${reader}. A streaming operator must release its source-attr context before ` +
		`pulling its child; see docs/runtime.md § Invariant: source-attr contexts and child pulls.`,
		StatusCode.INTERNAL,
	);
}

/**
 * Record that `child` was forked from `parent`. The child carries a hidden
 * reference back to the parent's ForkState so drive() can bump it.
 * No-op outside strict mode.
 */
export function markForkOf(child: object, parent: object): void {
	if (!STRICT_MODE) return;
	const parentState = stateByWrappedMap.get(parent);
	if (parentState) parentStateOfFork.set(child, parentState);
}

/**
 * Bump the parent's active-forks counter for the given forked map.
 * Returns the state object (or null) so the caller can drop it later.
 * No-op outside strict mode.
 */
export function bumpParentForkCounter(forkedMap: object): ForkState | null {
	if (!STRICT_MODE) return null;
	const state = parentStateOfFork.get(forkedMap);
	if (!state) return null;
	state.activeForks++;
	return state;
}

/** Drop a counter previously bumped via {@link bumpParentForkCounter}. */
export function dropParentForkCounter(state: ForkState | null): void {
	if (!STRICT_MODE || state === null) return;
	state.activeForks--;
}

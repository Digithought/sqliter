import type { CacheNode } from '../../planner/nodes/cache-node.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { asRun } from '../types.js';
import type { Row } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { emitCallFromPlan } from '../emitters.js';
import { streamWithCache, createCacheState, type CacheState, type SharedCacheConfig } from '../cache/shared-cache.js';
import { buffered, traced } from '../async-util.js';
import { isLoggingEnabled } from '../../common/logger.js';

/**
 * Usage example for other emitters needing caching (NLJ inner caching, CTE materialization):
 *
 * ```typescript
 * import { streamWithCache, createCacheState } from '../cache/shared-cache.js';
 *
 * // In your emitter closure — mint a stable per-emit-site key, NOT the CacheState:
 * const cacheKey = Symbol(`nlj-inner:${plan.id}`);
 * const config = { threshold: 10000, strategy: 'memory', name: 'NLJ-inner' };
 *
 * // In your run function — get-or-create the state on the per-execution context so
 * // it resets between prepared-statement runs (never build CacheState at emit time —
 * // the closure outlives one execution and would replay stale rows). See emitCache below.
 * const states = (rctx.cacheStates ??= new Map<symbol, CacheState>());
 * const cacheState = states.get(cacheKey) ?? states.set(cacheKey, createCacheState()).get(cacheKey)!;
 * yield* streamWithCache(sourceIterable, config, cacheState);
 * ```
 */

/**
 * Emits a smart cache instruction that materializes input on first iteration
 * and serves subsequent iterations from cached results.
 *
 * Now uses the shared cache utility to avoid code duplication.
 */
export function emitCache(plan: CacheNode, ctx: EmissionContext): Instruction {
	const config: SharedCacheConfig = {
		threshold: plan.threshold,
		strategy: plan.strategy,
		name: `CacheNode-${plan.id}`,
		eager: plan.eager
	};

	// Stable per-emit-site key for the per-execution cache state
	// (RuntimeContext.cacheStates). Minted once here in the emitter closure, so it
	// is identical across every re-drive of THIS cache within one execution (the
	// instruction tree is cached and reused on the prepared Statement), yet a fresh
	// RuntimeContext per execution means a re-executed statement gets a fresh
	// CacheState and re-drives its source instead of replaying stale rows. Mirrors
	// the executionMemo/scanConnections symbol pattern.
	const cacheKey = Symbol(`cache:${plan.id}`);

	async function* run(rctx: RuntimeContext, sourceCallback: (innerCtx: RuntimeContext) => AsyncIterable<Row>): AsyncIterable<Row> {
		const cacheStates = (rctx.cacheStates ??= new Map<symbol, CacheState>());
		let cacheState = cacheStates.get(cacheKey);
		if (!cacheState) {
			cacheState = createCacheState();
			cacheStates.set(cacheKey, cacheState);
		}

		let sourceIterable = sourceCallback(rctx);

		// Optional: Add buffering for large threshold caches to improve performance
		if (plan.threshold > 50000) {
			sourceIterable = buffered(sourceIterable, Math.min(plan.threshold / 10, 5000));
		}

		// Optional: Add tracing in debug mode
		if (isLoggingEnabled('runtime:cache')) {
			sourceIterable = traced(sourceIterable, `cache-${plan.id}`,
				(row, index) => `row ${index}: [${row.length} columns]`);
		}

		yield* streamWithCache(sourceIterable, config, cacheState);
	}

	const sourceInstruction = emitCallFromPlan(plan.source, ctx);

	return {
		params: [sourceInstruction],
		run: asRun(run),
		note: `cache(${plan.strategy}, threshold=${plan.threshold})`
	};
}

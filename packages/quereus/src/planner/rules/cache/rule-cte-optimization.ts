/**
 * Rule: CTE Optimization
 *
 * Required Characteristics:
 * - Node must support CTE operations (CTECapable interface)
 * - Node must be relational (produces rows)
 * - Source must be cacheable for materialization
 *
 * Applied When:
 * - CTE would benefit from materialization/caching based on cost analysis
 *
 * Benefits: Reduces redundant computation for repeated CTE access
 */

import { createLogger } from '../../../common/logger.js';
import type { PlanNode } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import { CTENode } from '../../nodes/cte-node.js';
import { CacheNode } from '../../nodes/cache-node.js';
import { CapabilityDetectors, CachingAnalysis, PlanNodeCharacteristics, type CTECapable } from '../../framework/characteristics.js';

const log = createLogger('optimizer:rule:cte-optimization');

export function ruleCteOptimization(node: PlanNode, context: OptContext): PlanNode | null {
	// Guard: node must support CTE operations
	if (!CapabilityDetectors.isCTE(node)) {
		return null;
	}

	// Get CTE characteristics
	const cteNode = node as CTECapable;
	log('Optimizing CTE %s', cteNode.cteName);

	// Source is already optimized by framework
	const source = cteNode.getCTESource();

	// Heuristics for when to cache CTEs:
	// 1. CTE has materialization hint
	// 2. CTE is estimated to be reasonably sized
	// 3. CTE is not already cached
	// NOTE: the `sourceSize > 0` gate below decides caching on a number that cannot
	// carry the answer. A never-`ANALYZE`d table reports 0 rows, and that 0 means
	// "unknown", not "empty" (`SchemaManager` hardcodes `TableSchema.estimatedRows`
	// to 0 at CREATE TABLE), so today whether a CTE is cached turns on whether
	// ANALYZE has run — and the rule never consults the reference count, so once a
	// real estimate arrives it caches single-reference CTEs too, and double-buffers
	// multi-reference ones against the materialization-advisory pass (see the NOTE
	// below). Tracked in backlog `bug-cte-cache-gate-reads-unknown-as-empty`; do not
	// paper over it with a `|| default` here, which caches single-reference CTEs.
	const sourceSize = PlanNodeCharacteristics.estimatesRows(source);
	const isAlreadyCached = CapabilityDetectors.isCached(source) && source.isCached();
	const shouldCache = (
		cteNode.materializationHint === 'materialized' ||
		(sourceSize > 0 && sourceSize < context.tuning.cte.maxSizeForCaching)
	) && !isAlreadyCached;

	if (shouldCache) {
		log('Adding cache to CTE %s (estimated rows: %d)', cteNode.cteName, sourceSize);

		// Use characteristics-based cache threshold calculation
		const cacheThreshold = Math.min(
			CachingAnalysis.getCacheThreshold(source),
			context.tuning.cte.maxCacheThreshold
		);

		// NOTE: when the materialization-advisory pass later marks this CTE
		// materialize (multi-referenced or MATERIALIZED hint), this inner
		// CacheNode double-buffers: emitCTE buffers the rows per execution AND
		// this cache buffers them again, driven only by the single first
		// reference. Correct but a wasted buffer — if it shows up in memory
		// profiles, drop the CTE-specific wrap here (needs its own test pass;
		// it also changes single-reference CTE caching behavior).
		const cachedSource = new CacheNode(
			source.scope,
			source,
			'memory',
			cacheThreshold
		);

		// Create new CTE with cached source (specific to CTENode implementation).
		// The original's `tableDescriptor` is carried over: emitCTE keys its shared
		// per-execution buffer on that identity, so a replacement that minted a
		// fresh one would give this copy its own buffer and re-drive the source.
		const result = new CTENode(
			node.scope,
			cteNode.cteName,
			cteNode.columns,
			cachedSource,
			cteNode.materializationHint,
			cteNode.isRecursive,
			node instanceof CTENode ? node.materialize : false,
			cteNode.tableDescriptor
		);

		log('Created CTE with caching');
		return result;
	}

	return null; // No transformation needed
}

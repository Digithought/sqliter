/**
 * Rule: Scalar-Subquery Cache
 *
 * Required Characteristics:
 * - Node must be a ScalarSubqueryNode
 * - Inner subquery must be uncorrelated (no outer attribute references)
 * - Inner subquery must be deterministic and read-only (functional)
 * - Inner subquery must not already be cached
 *
 * Applied When:
 * - A scalar subquery embedded in a WHERE / projection / ORDER BY / HAVING
 *   expression would re-execute its full pipeline for every outer row.
 *
 * Benefits: Materializes the inner result once and replays from cache on
 * subsequent evaluations, reducing O(N) inner scans to O(1) per execution.
 *
 * EAGER vs. NON-EAGER — this rule uses NON-eager. `emitScalarSubquery` iterates
 * the entire input on every evaluation (it must read every row to detect the
 * ">1 row" error), so it has no short-circuit that could abort a streaming cache
 * build mid-drain. A streaming (non-eager) CacheNode is therefore fully drained
 * and committed on the first evaluation, and subsequent evaluations replay from
 * the buffer. Do NOT "fix" this to eager. (Eager mode exists for a first-match
 * short-circuiting consumer; its only historical caller, `rule-in-subquery-cache`,
 * was retired in favor of the emit-level IN-subquery set probe — see
 * `runtime/emit/subquery.ts` and `docs/runtime-caching.md` § Eager vs.
 * streaming-first build.)
 */

import { createLogger } from '../../../common/logger.js';
import type { PlanNode } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import { ScalarSubqueryNode } from '../../nodes/subquery.js';
import { CacheNode } from '../../nodes/cache-node.js';
import { CapabilityDetectors, CachingAnalysis, PlanNodeCharacteristics } from '../../framework/characteristics.js';
import { isCorrelatedSubquery } from '../../cache/correlation-detector.js';
import { PlanNodeType } from '../../nodes/plan-node-type.js';

const log = createLogger('optimizer:rule:scalar-subquery-cache');

export function ruleScalarSubqueryCache(node: PlanNode, context: OptContext): PlanNode | null {
	// Guard: must be a ScalarSubqueryNode
	if (node.nodeType !== PlanNodeType.ScalarSubquery) {
		return null;
	}

	const scalarNode = node as ScalarSubqueryNode;
	const inner = scalarNode.subquery;

	// Gate: inner must not already be cached (idempotent under the fixpoint pass)
	if (CapabilityDetectors.isCached(inner) && inner.isCached()) {
		log('scalar-subquery inner already cached, skipping');
		return null;
	}

	// Gate: inner must be uncorrelated. A correlated inner's result depends on
	// the outer row and must NOT be cached.
	if (isCorrelatedSubquery(inner)) {
		log('scalar-subquery is correlated, skipping cache wrapping');
		return null;
	}

	// Gate: inner must be deterministic and read-only. This also excludes the
	// impure DML-bearing inner, which keeps its run-once memo in emitScalarSubquery.
	if (!PlanNodeCharacteristics.isFunctional(inner)) {
		log('scalar-subquery inner is not functional, skipping cache wrapping');
		return null;
	}

	log('Wrapping uncorrelated scalar-subquery inner in CacheNode');

	const cacheThreshold = Math.min(
		CachingAnalysis.getCacheThreshold(inner),
		context.tuning.cte.maxCacheThreshold
	);

	// Non-eager (streaming): the scalar consumer drains the whole input on the
	// first evaluation, committing the buffer, so later evaluations replay. See
	// the eager-vs-non-eager note in the module header.
	const cachedInner = new CacheNode(
		inner.scope,
		inner,
		'memory',
		cacheThreshold,
		false  // non-eager: scalar consumer already fully drains on first eval
	);

	// Rebuild via withChildren so future constructor fields can't be dropped.
	return scalarNode.withChildren([cachedInner]);
}

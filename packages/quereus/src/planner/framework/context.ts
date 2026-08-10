/**
 * Optimizer context that wraps Optimizer with StatsProvider and other utilities
 * Provides unified interface for optimization rules
 */

import type { Optimizer } from '../optimizer.js';
import type { StatsProvider } from '../stats/index.js';
import type { OptimizerTuning } from '../optimizer-tuning.js';
import { createLogger } from '../../common/logger.js';
import { Database } from '../../core/database.js';
import type { PlanNode } from '../nodes/plan-node.js';

const log = createLogger('optimizer:framework:context');

/**
 * Context object passed to optimization rules
 * Contains all the utilities and data sources rules need
 */
export interface OptContext {
	/** The optimizer instance */
	readonly optimizer: Optimizer;

	/** Statistics provider for cardinality and selectivity estimates */
	readonly stats: StatsProvider;

	/** Optimizer tuning parameters */
	readonly tuning: OptimizerTuning;

	/**
	 * Current optimization phase. Always 'rewrite' today — `createOptContext`'s
	 * `phase` parameter is never passed a different value by any call site, and
	 * no pass/rule currently branches on it. Kept as a documented part of the
	 * phase-management contract (see registry.ts `RulePhase`) rather than
	 * removed outright; wire it through `PassManager` if a phase-gated pass
	 * needs it.
	 */
	readonly phase: 'rewrite' | 'impl';

	/** Diagnostics bag that rules can populate (emitted after optimization) */
	readonly diagnostics: OptimizerDiagnostics;

	/** Database instance */
	readonly db: Database;

	/** Context-scoped visited rules tracking (nodeId → ruleIds) */
	readonly visitedRules: Map<string, Set<string>>;

	/** Cache of already-optimized nodes within this context (nodeId → optimized result) */
	readonly optimizedNodes: Map<string, PlanNode>;
}

/** Optimizer diagnostics structure */
export interface OptimizerDiagnostics {
	// QuickPick join enumeration
	quickpick?: {
		tours?: number;
		bestCost?: number;
	};
	// Extensible for future diagnostics
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	[key: string]: any;
}

/**
 * Implementation of optimization context
 */
export class OptimizationContext implements OptContext {
	readonly visitedRules = new Map<string, Set<string>>();
	readonly optimizedNodes = new Map<string, PlanNode>();
	readonly diagnostics = {} as OptimizerDiagnostics;

	constructor(
		public readonly optimizer: Optimizer,
		public readonly stats: StatsProvider,
		public readonly tuning: OptimizerTuning,
		public readonly phase: 'rewrite' | 'impl' = 'rewrite',
		public readonly db: Database,
	) {
		log('Created optimization context (phase: %s)', phase);
	}
}

/**
 * Factory function to create optimization context
 */
export function createOptContext(
	optimizer: Optimizer,
	stats: StatsProvider,
	tuning: OptimizerTuning,
	db: Database,
	phase: 'rewrite' | 'impl' = 'rewrite',
): OptContext {
	return new OptimizationContext(optimizer, stats, tuning, phase, db);
}

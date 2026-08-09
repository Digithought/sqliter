import type { CreateAssertionNode } from '../../planner/nodes/create-assertion-node.js';
import type { Database } from '../../core/database.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { asRun } from '../types.js';
import type { EmissionContext } from '../emission-context.js';
import { QuereusError } from '../../common/errors.js';
import { SqlValue, StatusCode } from '../../common/types.js';
import { createLogger } from '../../common/logger.js';
import type { IntegrityAssertionSchema, AssertionDependentTable } from '../../schema/assertion.js';
import { buildAssertionViolationSql } from '../../schema/assertion.js';
import { planAssertionBodyForAnalysis } from '../../planner/analysis/assertion-plan.js';
import { collectTableReferences } from '../../planner/analysis/binding-extractor.js';

const log = createLogger('runtime:emit:create-assertion');
const warnLog = log.extend('warn');

/**
 * The base-table references the body reads, one entry per reference — the
 * informational list `assertion_info().dependent_tables` reports.
 *
 * Planned the same way the commit-time evaluator plans it — same home-schema path,
 * same analysis stage, same hoist suppression (see `planAssertionBodyForAnalysis`) —
 * and walked with the same collector the evaluator's `extractBindings` walks with,
 * so the informational list and the set enforcement actually derives cannot
 * disagree about what the body reads.
 *
 * Best-effort: enforcement does NOT read `dependentTables` (the evaluator recomputes
 * its base set when it compiles the body), so a failure here only blanks a column of
 * `assertion_info()` and must never fail the CREATE. The builder
 * (`planAssertionBody`) already proved this same violation SQL builds against the
 * live catalog, so a failure here is a discovery-only failure (optimizer-stage, or
 * the plan-shape walk) — never "the body names something that doesn't exist" — and
 * usually means the body will fail to plan at commit time too. Warn, don't swallow.
 */
function discoverDependentTables(
	db: Database,
	violationSql: string,
	schemaName: string,
	name: string,
): AssertionDependentTable[] {
	try {
		const analyzed = planAssertionBodyForAnalysis(db, violationSql, schemaName);
		const deps = Array.from(
			collectTableReferences(analyzed),
			([relationKey, ref]): AssertionDependentTable => ({ relationKey, base: ref.base }));
		log('Assertion %s dependencies discovered: %o', name, deps);
		return deps;
	} catch (depErr) {
		warnLog(
			'Dependency discovery failed for assertion %s.%s; assertion_info().dependent_tables will be empty: %O',
			schemaName, name, depErr
		);
		return [];
	}
}

export function emitCreateAssertion(plan: CreateAssertionNode, _ctx: EmissionContext): Instruction {

	async function run(rctx: RuntimeContext): Promise<SqlValue> {
		// Ensure we're in a transaction before DDL (lazy/JIT transaction start)
		await rctx.db._ensureTransaction();

		// Convert the CHECK expression to SQL text for storage. Shared with the
		// `ALTER TABLE … RENAME` propagation, which regenerates this same text from
		// the rewritten expression (see `buildAssertionViolationSql`).
		let violationSql: string;
		try {
			violationSql = buildAssertionViolationSql(plan.checkExpression);
		} catch (e) {
			throw new QuereusError(
				`Cannot create assertion '${plan.name}': failed to convert check expression to SQL`,
				StatusCode.ERROR,
				e instanceof Error ? e : undefined
			);
		}

		// Everything that can reject the statement runs before any discovery work:
		// a name clash must not pay for a plan it then throws away.
		const schemaManager = rctx.db.schemaManager;
		const schema = schemaManager.getSchema(plan.schemaName);
		if (!schema) {
			throw new QuereusError(`Schema not found: ${plan.schemaName}`, StatusCode.ERROR);
		}

		// Assertion names are unique per schema.
		if (schema.getAssertion(plan.name)) {
			throw new QuereusError(
				`Assertion ${plan.name} already exists`,
				StatusCode.CONSTRAINT
			);
		}

		const assertionSchema: IntegrityAssertionSchema = {
			name: plan.name,
			schemaName: plan.schemaName,
			violationSql,
			deferrable: true, // Auto-deferred for multi-table constraints
			initiallyDeferred: true,
			dependentTables: discoverDependentTables(rctx.db, violationSql, plan.schemaName, plan.name),
			checkExpression: plan.checkExpression,
		};

		schemaManager.addAssertion(schema.name, assertionSchema);

		log('Created assertion %s.%s with violationSql: %s', plan.schemaName, plan.name, violationSql);
		return null;
	}

	return {
		params: [],
		run: asRun(run),
		note: `createAssertion(${plan.schemaName}.${plan.name})`
	};
}

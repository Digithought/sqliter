import type { CreateAssertionNode } from '../../planner/nodes/create-assertion-node.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { asRun } from '../types.js';
import type { EmissionContext } from '../emission-context.js';
import { QuereusError } from '../../common/errors.js';
import { SqlValue, StatusCode } from '../../common/types.js';
import { createLogger } from '../../common/logger.js';
import type { IntegrityAssertionSchema, AssertionDependentTable } from '../../schema/assertion.js';
import { expressionToString } from '../../emit/ast-stringify.js';

const log = createLogger('runtime:emit:create-assertion');
const warnLog = log.extend('warn');

export function emitCreateAssertion(plan: CreateAssertionNode, _ctx: EmissionContext): Instruction {

	async function run(rctx: RuntimeContext): Promise<SqlValue> {
		// Ensure we're in a transaction before DDL (lazy/JIT transaction start)
		await rctx.db._ensureTransaction();

		// Convert the CHECK expression to SQL text for storage
		// The CHECK expression should be negated to become a violation query:
		// check (condition) becomes "select 1 where not (condition)"
		let violationSql: string;
		try {
			const exprSql = expressionToString(plan.checkExpression);
			violationSql = `select 1 where not (${exprSql})`;
		} catch (e) {
			throw new QuereusError(
				`Cannot create assertion '${plan.name}': failed to convert check expression to SQL`,
				StatusCode.ERROR,
				e instanceof Error ? e : undefined
			);
		}

		// Create the assertion schema object
		const assertionSchema: IntegrityAssertionSchema = {
			name: plan.name,
			schemaName: plan.schemaName,
			violationSql,
			deferrable: true, // Auto-deferred for multi-table constraints
			initiallyDeferred: true,
			dependentTables: [],
			checkExpression: plan.checkExpression,
		};

		// Discover dependent base tables (best-effort; conservative if any failure).
		// Plan under the assertion's home-schema path so unqualified table names in
		// the body resolve against the assertion's own schema first.
		try {
			const planNode = rctx.db.getPlan(violationSql, rctx.db._homeSchemaPath(plan.schemaName));
			const deps = new Map<string, AssertionDependentTable>();
			(function collect(node: unknown) {
				const candidate = node as {
					getRelations?: () => Iterable<unknown>;
					tableSchema?: { name?: string; schemaName?: string };
					id?: unknown;
				};
				if (candidate && typeof candidate.getRelations === 'function') {
					for (const child of candidate.getRelations()) collect(child);
				}
				if (candidate?.tableSchema?.name && candidate?.id !== undefined) {
					const base = `${candidate.tableSchema.schemaName}.${candidate.tableSchema.name}`.toLowerCase();
					const relationKey = `${base}#${String(candidate.id)}`;
					if (!deps.has(relationKey)) deps.set(relationKey, { relationKey, base });
				}
			})(planNode);
			assertionSchema.dependentTables = Array.from(deps.values());
			log('Assertion %s dependencies discovered: %o', plan.name, assertionSchema.dependentTables);
		} catch (depErr) {
			// A total discovery failure leaves dependent_tables empty; enforcement
			// then falls back to running the full violation query on every commit.
			// Surface that degradation — a silent debug line made it invisible.
			warnLog(
				'Dependency discovery failed for assertion %s.%s; enforcement falls back to the full violation query: %O',
				plan.schemaName, plan.name, depErr
			);
		}

		// Add to the assertion's home schema
		const schemaManager = rctx.db.schemaManager;
		const schema = schemaManager.getSchema(plan.schemaName);
		if (!schema) {
			throw new QuereusError(`Schema not found: ${plan.schemaName}`, StatusCode.ERROR);
		}

		// Check for existing assertion (names are unique per schema)
		const existing = schema.getAssertion(plan.name);
		if (existing) {
			throw new QuereusError(
				`Assertion ${plan.name} already exists`,
				StatusCode.CONSTRAINT
			);
		}

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

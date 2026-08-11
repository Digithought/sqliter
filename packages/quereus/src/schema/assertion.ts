import type * as AST from '../parser/ast.js';
import type { Database } from '../core/database.js';
import type { Schema } from './schema.js';
import { expressionToString } from '../emit/ast-stringify.js';
import { snapshotObjectRefResolvers } from './object-ref-resolver.js';
import { reachableObjects, type ObjectReach } from './object-dependency-closure.js';

export interface AssertionDependentTable {
  /**
   * Instance-unique table reference key, e.g. `schema.table#nodeId`.
   *
   * Meaningful ONLY within one recorded list, where it tells two references to
   * the same table apart (a self-join records two entries). The embedded node id
   * comes from a process-wide counter over whichever plan produced the list, so
   * it will never equal the key the commit-time evaluator computes for the same
   * table — do not build a lookup that compares the two.
   */
  relationKey: string;
  /** Base table identifier, e.g. schema.table */
  base: string;
}

export interface IntegrityAssertionSchema {
  /** Assertion name, unique within its schema */
  name: string;
  /** Canonical name of the schema the assertion lives in (see SchemaManager.canonicalSchemaName) */
  schemaName: string;
  /** SQL text of the violation-producing query. Any returned row indicates a violation. */
  violationSql: string;
  /** Whether the assertion is deferrable. Currently always enforced at COMMIT. */
  deferrable: boolean;
  /** If true, initially deferred. Currently informational. */
  initiallyDeferred: boolean;
  /**
   * Base-table references in the body — informational only; it feeds
   * `assertion_info().dependent_tables` and enforcement never reads it (the
   * commit-time evaluator derives its own set when it compiles the body, from
   * the same `planAssertionBodyForAnalysis` + `collectTableReferences` pair — see
   * `planner/analysis/relation-key.ts`).
   *
   * NOTE: recorded once at CREATE, and after that only string-re-keyed by the
   * `ALTER TABLE … RENAME` propagation — no other schema change re-derives it.
   * It can therefore go stale where the body's plan shape depends on something
   * other than the table names in its text (a view in the body redefined over
   * different tables is the reachable case). Harmless while nothing but
   * introspection reads it; the day a consumer needs it to be live, re-derive it
   * on the schema-change events the evaluator already invalidates its cache on
   * rather than adding another remap.
   */
  dependentTables?: AssertionDependentTable[];
  /**
   * Original CHECK expression AST. Populated when the assertion is created
   * via CREATE ASSERTION; absent for assertions reconstructed from persisted
   * `violationSql` alone. Consumed by the optimizer's assertion-hoist analysis
   * — assertions without it fall through to commit-time enforcement only.
   */
  checkExpression?: AST.Expression;
}

/**
 * Renders the violation-producing query an assertion's CHECK expression implies:
 * `check (<expr>)` holds exactly when `select 1 where not (<expr>)` returns no
 * row, so any row it returns is a violation. The commit-time evaluator re-parses
 * and re-plans this text (see `AssertionEvaluator.getOrCompilePlan`).
 *
 * Shared by `CREATE ASSERTION` and the `ALTER TABLE … RENAME` propagation, so a
 * body rewritten by a rename regenerates byte-identically to what a fresh create
 * would have produced for the same expression.
 */
export function buildAssertionViolationSql(check: AST.Expression): string {
	return `select 1 where not (${expressionToString(check)})`;
}

/** An assertion paired with the {@link Schema} object that owns it. */
export interface OwnedAssertion {
	/** The owning schema — `schema.name` is the CANONICAL spelling for a message. */
	schema: Schema;
	assertion: IntegrityAssertionSchema;
}

/**
 * Every live assertion in EVERY schema, those owned by `homeSchemaName` first.
 *
 * The DROP guards scan all schemas because an assertion in one schema can name
 * an object in another (`create assertion temp.a check (… from main.t …)`) and
 * one broken body makes every write to the whole database fail. They scan the
 * dropped object's own schema FIRST for the same reason
 * `tablesProbedTargetFirst` (`schema/expression-dependents.ts`) scans the
 * probed table first: the guards report the first hit, and the same-schema
 * messages are the ones users and tests already know, so an unrelated schema
 * must not win a race just because it sorts earlier.
 *
 * NOTE: past the home schema the order is `_getAllSchemas()` × assertion
 * insertion order, so with TWO blocking assertions which one the refusal names
 * follows catalog insertion rather than any user-visible rule. Harmless while
 * the message is advisory — every one of them has to be dealt with anyway.
 */
export function* assertionsHomeSchemaFirst(
	db: Database,
	homeSchemaName: string,
): Iterable<OwnedAssertion> {
	const homeLower = homeSchemaName.toLowerCase();
	const rest: OwnedAssertion[] = [];
	for (const schema of db.schemaManager._getAllSchemas()) {
		const home = schema.name.toLowerCase() === homeLower;
		for (const assertion of schema.getAllAssertions()) {
			if (home) yield { schema, assertion };
			else rest.push({ schema, assertion });
		}
	}
	yield* rest;
}

/**
 * How an error should spell an assertion when the object it blocks lives in
 * `homeSchemaName`: bare when the two share a schema, schema-qualified when they
 * do not — the same rule `describeDependentTable` follows, and the only way a
 * cross-schema refusal names an assertion the user can actually find and drop.
 */
export function describeOwnedAssertion(owned: OwnedAssertion, homeSchemaName: string): string {
	return owned.schema.name.toLowerCase() === homeSchemaName.toLowerCase()
		? `'${owned.assertion.name}'`
		: `'${owned.schema.name}.${owned.assertion.name}'`;
}

/** An assertion paired with everything its CHECK body can reach. */
export interface AssertionReach {
	owned: OwnedAssertion;
	reach: ObjectReach;
}

/**
 * Every live assertion that has a body to scan, home schema first, each paired
 * with its {@link reachableObjects} closure.
 *
 * The single place the DROP guards' shared preamble lives, so the two of them
 * cannot drift on the part that is easy to get wrong: ONE catalog snapshot for
 * the whole scan. A guard runs before its statement's first mutation, so the
 * snapshot is the live state, and every assertion resolving against the same one
 * is the discipline `schema/object-ref-resolver.ts` documents — a per-assertion
 * snapshot would be correct today only by accident.
 *
 * NOTE: one breadth-first walk PER LIVE ASSERTION on every drop, uncached, over
 * already-parsed ASTs. DDL is rare and each walk stops at the bodies that
 * assertion actually reaches, so this is not worth caching now; a database
 * holding many assertions over deep view chains would be what makes a cached
 * reverse dependency index (invalidated on every view / assertion change) worth
 * its consistency risk.
 */
export function* assertionReachesHomeSchemaFirst(
	db: Database,
	homeSchemaName: string,
): Iterable<AssertionReach> {
	const resolvers = snapshotObjectRefResolvers(db);
	for (const owned of assertionsHomeSchemaFirst(db, homeSchemaName)) {
		// NOTE: an assertion with no `checkExpression` has no AST to scan and is
		// skipped, exactly as the rename propagation skips it. Unreachable today —
		// `SchemaManager.importDDL` accepts only createTable / createIndex /
		// createView / createMaterializedView / alterIndex, so no assertion
		// persistence path exists and every live assertion came from
		// `CREATE ASSERTION`. If a reconstruction path is ever added, the guards
		// need a re-parse arm here or they silently stop protecting those assertions.
		const check = owned.assertion.checkExpression;
		if (!check) continue;
		yield { owned, reach: reachableObjects(db, check, owned.schema.name, resolvers) };
	}
}


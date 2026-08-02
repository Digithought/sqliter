import type * as AST from '../parser/ast.js';

export interface AssertionDependentTable {
  /** Instance-unique table reference key, e.g. schema.table#nodeId */
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
  /** Base tables referenced; filled during assertion preparation/creation. */
  dependentTables?: AssertionDependentTable[];
  /**
   * Original CHECK expression AST. Populated when the assertion is created
   * via CREATE ASSERTION; absent for assertions reconstructed from persisted
   * `violationSql` alone. Consumed by the optimizer's assertion-hoist analysis
   * — assertions without it fall through to commit-time enforcement only.
   */
  checkExpression?: AST.Expression;
}



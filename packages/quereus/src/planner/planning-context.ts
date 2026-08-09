import type * as AST from '../parser/ast.js';
import type { SqlParameters } from '../common/types.js';
import type { Database } from '../core/database.js';
import type { SchemaManager } from '../schema/manager.js';
import type { Scope } from './scopes/scope.js';
import type { PlanNode, ScalarPlanNode, TableDescriptor } from './nodes/plan-node.js';
import type { CTEScopeNode } from './nodes/cte-node.js';
import type { CTEReferenceNode } from './nodes/cte-reference-node.js';

/**
 * Debug options for query planning and execution.
 */
export interface DebugOptions {
  /** Enable runtime instruction tracing (logs inputs/outputs) */
  traceInstructions?: boolean;
  /** Enable detailed plan tree output */
  showPlan?: boolean;
  /** Enable instruction program output */
  showProgram?: boolean;
  /** Custom debug context for additional logging */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  debugContext?: Record<string, any>;
}

/**
 * Represents a dependency on a schema object that was resolved during planning.
 * Used for plan invalidation when schema changes.
 */
export interface SchemaDependency {
	readonly type: 'table' | 'view' | 'function' | 'vtab_module' | 'collation';
	readonly schemaName?: string; // undefined for functions, collations, and vtab modules
	readonly objectName: string;
	readonly objectVersion?: number; // For future versioning support
}

/**
 * Tracks schema dependencies during planning and provides invalidation callbacks.
 */
export class BuildTimeDependencyTracker {
	private dependencies = new Set<string>();
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private resolvedObjects = new Map<string, WeakRef<any>>();
	private invalidationCallbacks = new Set<() => void>();

	/**
	 * Records a dependency on a schema object and stores a weak reference to it.
	 */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	recordDependency(dep: SchemaDependency, object: any): void {
		const key = this.dependencyKey(dep);
		this.dependencies.add(key);
		this.resolvedObjects.set(key, new WeakRef(object));
	}

	/**
	 * Adds a callback to be invoked when schema dependencies become invalid.
	 */
	addInvalidationCallback(callback: () => void): () => void {
		this.invalidationCallbacks.add(callback);
		return () => this.invalidationCallbacks.delete(callback);
	}

	/**
	 * Checks if all dependencies are still valid by verifying weak references.
	 */
	checkIntegrity(): boolean {
		for (const [_key, weakRef] of this.resolvedObjects.entries()) {
			if (weakRef.deref() === undefined) {
				// Object was garbage collected, dependency is invalid
				return false;
			}
		}
		return true;
	}

	/**
	 * Gets all tracked dependencies.
	 */
	getDependencies(): SchemaDependency[] {
		return Array.from(this.dependencies).map(key => this.parseDependencyKey(key));
	}

	/**
	 * Checks if any dependencies are tracked.
	 */
	hasAnyDependencies(): boolean {
		return this.dependencies.size > 0;
	}

	/**
	 * Notifies all invalidation callbacks.
	 */
	notifyInvalidation(): void {
		for (const callback of this.invalidationCallbacks) {
			callback();
		}
	}

	private dependencyKey(dep: SchemaDependency): string {
		const schema = dep.schemaName || '';
		const version = dep.objectVersion || 0;
		return `${dep.type}:${schema}:${dep.objectName}:${version}`;
	}

	private parseDependencyKey(key: string): SchemaDependency {
		const [type, schemaName, objectName, versionStr] = key.split(':');
		return {
			type: type as SchemaDependency['type'],
			schemaName: schemaName || undefined,
			objectName,
			objectVersion: parseInt(versionStr) || undefined
		};
	}
}

/**
 * Provides contextual information necessary during the query planning phase.
 * This object is passed to various planning functions to give them access to
 * the database schema, current symbol resolution scope, and other relevant details.
 */
export interface PlanningContext {
  /**
   * The Database instance, providing access to the schema manager, function registry, etc.
   */
  readonly db: Database;

  /**
   * The SchemaManager instance, for direct access if needed (also available via db.schemaManager).
   */
  readonly schemaManager: SchemaManager; // Redundant if db is present, but can be convenient

  /**
   * The current Scope for symbol resolution (columns, parameters, CTEs).
   * Planning functions for nested structures (like subqueries) will typically create a new Scope
   * with the current scope as its parent and pass that down in a new PlanningContext.
   */
  readonly scope: Scope;

	/**
	 * The current parameters for the statement, as discovered by references.
	 */
	readonly parameters: SqlParameters;

  /**
   * Debug options controlling tracing and diagnostics output.
   */
  readonly debug?: DebugOptions;

  /**
   * Aggregates from the SELECT list (used when building HAVING expressions).
   * This allows buildExpression to recognize when an aggregate function in HAVING
   * refers to an already-computed aggregate from SELECT.
   */
  readonly aggregates?: Array<{
    expression: ScalarPlanNode;
    alias: string;
    columnIndex: number;
    attributeId: number;
  }>;

  /**
   * Active CTEs available in the current planning context.
   * This map contains all CTEs from the current WITH clause and any parent WITH clauses,
   * allowing subqueries in expressions to resolve CTE references correctly.
   */
  readonly cteNodes?: Map<string, CTEScopeNode>;

  /**
   * Schema dependency tracker for this planning session.
   */
  readonly schemaDependencies: BuildTimeDependencyTracker;

  /**
   * Schema object cache for resolved objects during planning.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly schemaCache: Map<string, any>;

  /**
   * Cache for CTE reference nodes to ensure consistent attribute IDs across multiple references
   * to the same CTE with the same alias. Key format: "cteName:alias"
   */
  cteReferenceCache?: Map<string, CTEReferenceNode>;

  /**
   * Per-statement memo of CTE runtime identities, keyed by the source `with` member.
   * Every `CTENode` built from one member — however many times the builders re-plan
   * that member (the view write-through path re-enters the same statement builder,
   * a multi-source decomposition once per base member) — shares one descriptor and
   * therefore one per-execution row buffer (`emitCTE` keys its buffer on it), so a
   * data-modifying body writes once per statement execution by construction rather
   * than by nothing having re-planned it. Keyed on the AST member OBJECT, not its
   * name, so a nested statement's same-named member keeps its own identity.
   *
   * REQUIRED (unlike the optional `cteNodes` / `cteReferenceCache` scope plumbing):
   * a context missing it would silently mint one descriptor per build, which both
   * doubles a re-planned member's write and blinds `buildBlock`'s unreferenced-member
   * scan. Every context factory must supply a fresh map per statement build.
   */
  readonly cteDescriptors: Map<AST.CommonTableExpr, TableDescriptor>;

  /** maps a RelationalPlanNode to its column scope during building */
  readonly outputScopes: Map<PlanNode, Scope>;

  /**
   * Optional schema search path for resolving unqualified table names.
   * Overrides the database-level default search path when present.
   * Comes from the WITH SCHEMA clause on statements.
   */
  readonly schemaPath?: string[];

  /**
   * Set to `<schemaName>` by {@link import('./stored-body-context.js').storedBodyContext}
   * when this context IS the home naming environment of that schema's stored body.
   * Read only by `building/select.ts`, to decide whether a sub-select carrying a
   * {@link import('../parser/ast.js').SelectStmt.storedBodyEnv} marker still needs
   * the swap: while the body itself is being planned the context already is that
   * environment, so re-swapping would clear the body's own CTE definitions.
   */
  readonly storedBodyOf?: string;

  /**
   * Per-lowering memo of the CTE definitions carried on a copied body fragment
   * ({@link import('../parser/ast.js').StoredBodyEnv.withClause}), keyed by the body's
   * `WITH` clause AST object. Created by `buildViewMutation` for a non-ephemeral target,
   * so every fragment of ONE lowering shares one plan node per body-local CTE — two
   * fragments referencing the same definition must not each build their own copy, or the
   * runtime evaluates the definition twice (and a non-deterministic one disagrees between
   * fragments). Sharing one `CTENode` across references is the shape the
   * materialization-advisory pass already handles: it marks a multi-referenced CTE
   * `materialize`, and `emitCTE` buffers it once per statement execution. Keyed on the
   * clause OBJECT rather than the CTE name so a second lowering in the same statement
   * (a different view) keeps its own definitions.
   */
  readonly storedBodyCTECache?: Map<AST.WithClause, Map<string, CTEScopeNode>>;
}

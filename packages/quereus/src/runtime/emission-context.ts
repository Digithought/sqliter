import type { Database } from '../core/database.js';
import type { SchemaManager } from '../schema/manager.js';
import type { TableSchema } from '../schema/table.js';
import type { FunctionSchema } from '../schema/function.js';
import type { AnyVirtualTableModule } from '../vtab/module.js';
import { createLogger } from '../common/logger.js';
import { QuereusError } from '../common/errors.js';
import { StatusCode } from '../common/types.js';
import { BINARY_COLLATION, type CollationFunction } from '../util/comparison.js';
import { BUILTIN_NORMALIZERS } from '../util/key-serializer.js';
import type { KeyNormalizer } from '../types/logical-type.js';

const log = createLogger('runtime:emission-context');

/**
 * Represents a dependency on a schema object that was resolved during emission.
 * Used for plan invalidation when schema changes.
 */
export interface SchemaDependency {
	readonly type: 'table' | 'function' | 'vtab_module' | 'collation';
	readonly schemaName?: string; // undefined for functions, collations, and vtab modules
	readonly objectName: string;
	readonly objectVersion?: number; // For future versioning support
}

/**
 * Tracks schema dependencies and provides a unique identifier for a set of dependencies.
 */
export class DependencyTracker {
	private dependencies = new Set<string>();
	private _fingerprint: string | null = null;

	/**
	 * Records a dependency on a schema object.
	 */
	addDependency(dep: SchemaDependency): void {
		const key = this.dependencyKey(dep);
		this.dependencies.add(key);
		this._fingerprint = null; // Invalidate cached fingerprint
	}

	/**
	 * Gets all tracked dependencies.
	 */
	getDependencies(): SchemaDependency[] {
		return Array.from(this.dependencies).map(key => this.parseDependencyKey(key));
	}

	/**
	 * Gets a fingerprint representing the current set of dependencies.
	 * This can be used to quickly check if dependencies have changed.
	 */
	getFingerprint(): string {
		if (this._fingerprint === null) {
			const sorted = Array.from(this.dependencies).sort();
			this._fingerprint = sorted.join('|');
		}
		return this._fingerprint;
	}

	/**
	 * Checks if this tracker has any dependencies that overlap with the given dependency.
	 */
	dependsOn(dep: SchemaDependency): boolean {
		const key = this.dependencyKey(dep);
		return this.dependencies.has(key);
	}

	/**
	 * Clears all tracked dependencies.
	 */
	clear(): void {
		this.dependencies.clear();
		this._fingerprint = null;
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

type SchemaObject = TableSchema | FunctionSchema | { module: AnyVirtualTableModule, auxData?: unknown } | CollationFunction;

/**
 * Context provided to emitters during plan emission.
 * Allows schema lookups and tracks dependencies for plan invalidation.
 * Also captures schema object references for runtime use.
 */
export class EmissionContext {
	private readonly schemaManager: SchemaManager;
	private readonly dependencyTracker = new DependencyTracker();
	/** Schema snapshot for table/view references during emission */
	private readonly schemaSnapshot = new Map<string, SchemaObject>();
	public readonly tracePlanStack: boolean;
	/**
	 * Whether `emitCallFromPlan` may compile pure synchronous scalar subtrees into
	 * fused closures (runtime/scalar-fusion.ts) instead of per-row sub-programs.
	 * Resolved once here: `trace_plan_stack` disables fusion because a fused subtree
	 * bypasses the per-instruction tracing wrapper (its frames would silently vanish
	 * from `ctx.planStack`), and `runtime_fuse_scalars` (default true) is the explicit
	 * kill switch. The override forces a decision regardless of either option — used
	 * by the debug-introspection surfaces (`scheduler_program()`, `execution_trace()`,
	 * `Statement.getDebugProgram()`), which must report the unfused instruction graph.
	 */
	public readonly fuseScalars: boolean;

	constructor(
		public readonly db: Database,
		options?: { fuseScalars?: boolean },
	) {
		const option = db.getOption('trace_plan_stack');
		this.tracePlanStack = typeof option === 'object' && option !== null && 'value' in option
			? Boolean((option as { value: unknown }).value)
			: Boolean(option);
		this.fuseScalars = options?.fuseScalars
			?? (!this.tracePlanStack && db.options.getBooleanOption('runtime_fuse_scalars'));
		this.schemaManager = db.schemaManager;
	}

	/**
	 * Looks up a table schema and records the dependency.
	 * Also captures the table reference for runtime use.
	 */
	findTable(tableName: string, schemaName?: string): TableSchema | undefined {
		const table = this.schemaManager.findTable(tableName, schemaName);
		if (table) {
			const key = `table:${table.schemaName}:${table.name}`;
			this.schemaSnapshot.set(key, table);
			this.dependencyTracker.addDependency({
				type: 'table',
				schemaName: table.schemaName,
				objectName: table.name
			});
			log('Recorded table dependency: %s.%s', table.schemaName, table.name);
		}
		return table;
	}

	/**
	 * Looks up a function schema and records the dependency.
	 * Also captures the function reference for runtime use.
	 */
	findFunction(funcName: string, numArgs: number): FunctionSchema | undefined {
		const func = this.schemaManager.findFunction(funcName, numArgs);
		if (func) {
			const key = `function:${func.name}/${func.numArgs}`;
			this.schemaSnapshot.set(key, func);
			this.dependencyTracker.addDependency({
				type: 'function',
				objectName: `${func.name}/${func.numArgs}`
			});
			log('Recorded function dependency: %s/%d', func.name, func.numArgs);
		}
		return func;
	}

	/**
	 * Looks up a virtual table module and records the dependency.
	 * Also captures the module reference for runtime use.
	 */
	getVtabModule(moduleName: string): { module: AnyVirtualTableModule, auxData?: unknown } | undefined {
		const moduleInfo = this.schemaManager.getModule(moduleName);
		if (moduleInfo) {
			const key = `vtab_module:${moduleName}`;
			this.schemaSnapshot.set(key, moduleInfo);
			this.dependencyTracker.addDependency({
				type: 'vtab_module',
				objectName: moduleName
			});
			log('Recorded vtab module dependency: %s', moduleName);
		}
		return moduleInfo;
	}

	/**
	 * Looks up a collation and records the dependency.
	 * Also captures the collation reference for runtime use.
	 */
	// NOTE: the dependency is keyed on the name as written, so `collation:nocase` and
	// `collation:NOCASE` are distinct keys for one collation. Harmless — validation
	// re-resolves case-insensitively — but it can list the same collation twice in a
	// plan fingerprint; normalize the key if fingerprint identity ever has to be exact.
	getCollation(collationName: string): CollationFunction | undefined {
		const collation = this.db._getCollation(collationName);
		if (collation) {
			const key = `collation:${collationName}`;
			this.schemaSnapshot.set(key, collation);
			this.dependencyTracker.addDependency({
				type: 'collation',
				objectName: collationName
			});
			log('Recorded collation dependency: %s', collationName);
		}
		return collation;
	}

	/**
	 * Resolves a collation name to its function against this emission's database,
	 * recording the dependency for plan invalidation. This is the only collation
	 * lookup an emitter should use — a name has no meaning outside a `Database`.
	 *
	 * Throws `QuereusError` (`no such collation sequence: X`) on an unknown name — the
	 * miss is delegated to {@link Database.getCollationResolver} so build-time and
	 * emit-time resolution report the same error. There is deliberately no BINARY
	 * fallback: it would silently produce wrong sort order, wrong UNIQUE enforcement,
	 * and wrong index seeks. An unresolvable name here means the *producer* of the name
	 * is wrong (DDL validates column collations at create time) — fix the producer.
	 */
	resolveCollation(collationName: string): CollationFunction {
		if (collationName === 'BINARY') return BINARY_COLLATION; // Fast path
		const func = this.getCollation(collationName);
		if (!func) return this.db.getCollationResolver()(collationName);
		return func;
	}

	/**
	 * Resolves a collation name to its key normalizer against this emission's database,
	 * recording the dependency for plan invalidation. This is the only normalizer lookup
	 * an emitter should use: an operator that buckets rows by a text key must partition
	 * them exactly as {@link resolveCollation}'s comparator would, or grouping and
	 * comparison disagree on the same column in the same connection.
	 *
	 * Throws `QuereusError` on an unknown name, and on a comparator-only collation that
	 * carries no normalizer — both delegated to {@link Database.getKeyNormalizerResolver}
	 * so every caller reports the same error.
	 *
	 * Pass the name through `hashKeyCollationName()` first: a key whose operand types can
	 * never hold text never consults its collation, so demanding a normalizer for it would
	 * reject a valid query.
	 */
	resolveKeyNormalizer(collationName: string | undefined): KeyNormalizer {
		if (!collationName || collationName === 'BINARY') return BUILTIN_NORMALIZERS.BINARY; // Fast path
		this.getCollation(collationName); // Record the dependency; the resolver owns the miss
		return this.db.getKeyNormalizerResolver()(collationName);
	}

	/**
	 * Gets the dependency tracker for this emission context.
	 */
	getDependencyTracker(): DependencyTracker {
		return this.dependencyTracker;
	}

	/**
	 * Gets a snapshot of all dependencies recorded during emission.
	 */
	getDependencies(): SchemaDependency[] {
		return this.dependencyTracker.getDependencies();
	}

	/**
	 * Gets a fingerprint representing all dependencies.
	 */
	getDependencyFingerprint(): string {
		return this.dependencyTracker.getFingerprint();
	}

	/**
	 * Provides access to the database instance for cases where direct access is needed.
	 * Use sparingly - prefer the specific lookup methods above.
	 */
	getDatabase(): Database {
		return this.db;
	}

	/**
	 * Provides access to the schema manager for cases where direct access is needed.
	 * Use sparingly - prefer the specific lookup methods above.
	 */
	getSchemaManager(): SchemaManager {
		return this.schemaManager;
	}

	/**
	 * Retrieves a captured schema object by its key.
	 * This allows runtime instructions to use the schema objects that were
	 * captured at emission time, providing consistency even if the schema changes.
	 */
	getCapturedSchemaObject<T = SchemaObject>(key: string): T | undefined {
		return this.schemaSnapshot.get(key) as T | undefined;
	}

	/**
	 * Validates that all captured schema objects still exist in the current schema.
	 * This can be called at the start of query execution to provide early error detection.
	 * Only validates objects that were actually captured during emission.
	 */
	validateCapturedSchemaObjects(): void {
		for (const [key, capturedObject] of this.schemaSnapshot.entries()) {
			const [type, ...nameParts] = key.split(':');

			switch (type) {
				case 'table': {
					const [schemaName, tableName] = nameParts;
					const currentTable = this.schemaManager.findTable(tableName, schemaName);
					if (!currentTable) {
						throw new QuereusError(
							`Table ${schemaName}.${tableName} was dropped after query was planned`,
							StatusCode.ERROR
						);
					}
					// Optionally check if it's the same object reference
					if (currentTable !== capturedObject) {
						log('Warning: Table %s.%s schema changed after query was planned', schemaName, tableName);
					}
					break;
				}
				case 'function': {
					const funcKey = nameParts.join(':'); // Rejoin in case function name had colons
					const [funcName, numArgsStr] = funcKey.split('/');
					const numArgs = parseInt(numArgsStr);
					const currentFunc = this.schemaManager.findFunction(funcName, numArgs);
					if (!currentFunc) {
						throw new QuereusError(
							`Function ${funcName}/${numArgs} was removed after query was planned`,
							StatusCode.ERROR
						);
					}
					if (currentFunc !== capturedObject) {
						log('Warning: Function %s/%d changed after query was planned', funcName, numArgs);
					}
					break;
				}
				case 'vtab_module': {
					const moduleName = nameParts.join(':');
					const currentModule = this.schemaManager.getModule(moduleName);
					if (!currentModule) {
						throw new QuereusError(
							`Virtual table module ${moduleName} was unregistered after query was planned`,
							StatusCode.ERROR
						);
					}
					if (currentModule !== capturedObject) {
						log('Warning: Virtual table module %s changed after query was planned', moduleName);
					}
					break;
				}
				case 'collation': {
					const collationName = nameParts.join(':');
					const currentCollation = this.db._getCollation(collationName);
					if (!currentCollation) {
						throw new QuereusError(
							`Collation ${collationName} was removed after query was planned`,
							StatusCode.ERROR
						);
					}
					if (currentCollation !== capturedObject) {
						log('Warning: Collation %s changed after query was planned', collationName);
					}
					break;
				}
				default:
					log('Warning: Unknown schema object type in validation: %s', type);
			}
		}
	}

	/**
	 * Gets the number of schema objects captured during emission.
	 * Useful for debugging and testing.
	 */
	getCapturedObjectCount(): number {
		return this.schemaSnapshot.size;
	}
}



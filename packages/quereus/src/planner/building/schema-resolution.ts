import type { PlanningContext, SchemaDependency } from '../planning-context.js';
import type { TableSchema } from '../../schema/table.js';
import type { FunctionSchema } from '../../schema/function.js';
import type { AnyVirtualTableModule } from '../../vtab/module.js';
import type { CollationFunction } from '../../util/comparison.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import { createLogger } from '../../common/logger.js';

const log = createLogger('planner:schema-resolution');

/** The pseudo-schema name used to access pre-transaction (committed) state */
export const COMMITTED_SCHEMA = 'committed';

/** Check if a schema name refers to the committed pseudo-schema */
export function isCommittedSchemaRef(schemaName?: string): boolean {
	return schemaName?.toLowerCase() === COMMITTED_SCHEMA;
}

/**
 * Resolves a table schema at build time and records the dependency.
 */
export function resolveTableSchema(
	ctx: PlanningContext,
	tableName: string,
	schemaName?: string
): TableSchema {
	// Intercept 'committed' pseudo-schema: resolve the real table from default search path
	if (isCommittedSchemaRef(schemaName)) {
		return resolveTableSchema(ctx, tableName, undefined);
	}

	// If schema is explicitly provided, search only that schema
	if (schemaName) {
		const resolvedSchemaName = schemaName;
		const cacheKey = `table:${resolvedSchemaName.toLowerCase()}:${tableName.toLowerCase()}`;

		// Check cache first
		const cached = ctx.schemaCache.get(cacheKey);
		if (cached) {
			log('Using cached table schema: %s.%s', resolvedSchemaName, tableName);
			return cached as TableSchema;
		}

		// Resolve table schema with explicit schema name
		const tableSchema = ctx.schemaManager.findTable(tableName, resolvedSchemaName);
		if (!tableSchema) {
			throw new QuereusError(
				`Table not found: ${resolvedSchemaName}.${tableName}`,
				StatusCode.ERROR
			);
		}

		// Record dependency
		const dependency: SchemaDependency = {
			type: 'table',
			schemaName: tableSchema.schemaName,
			objectName: tableSchema.name
		};
		ctx.schemaDependencies.recordDependency(dependency, tableSchema);

		// Cache result
		ctx.schemaCache.set(cacheKey, tableSchema);

		log('Resolved table schema: %s.%s', tableSchema.schemaName, tableSchema.name);
		return tableSchema;
	}

	// No explicit schema, use search path
	const schemaPath = ctx.schemaPath;
	const lowerTableName = tableName.toLowerCase();
	const cacheKey = schemaPath
		? `table:path(${schemaPath.map(s => s.toLowerCase()).join(',')}):${lowerTableName}`
		: `table:default:${lowerTableName}`;

	// Check cache first
	const cached = ctx.schemaCache.get(cacheKey);
	if (cached) {
		log('Using cached table schema: %s (from search path)', tableName);
		return cached as TableSchema;
	}

	// Resolve table schema using search path
	const tableSchema = ctx.schemaManager.findTable(tableName, undefined, schemaPath);
	if (!tableSchema) {
		// Generate helpful error message
		const searchedSchemas = schemaPath || ['main', 'temp'];
		// Views count here: an unqualified name resolves through the path across
		// tables and views alike, so an off-path VIEW is exactly as suggestible.
		const existsIn = ctx.schemaManager.findSchemasContainingRelation(tableName);

		let errorMsg = `Table '${tableName}' not found in schema path: ${searchedSchemas.join(', ')}`;

		if (existsIn.length > 0) {
			// Table exists in other schemas - suggest qualified name
			const suggestions = existsIn.map(s => `${s}.${tableName}`).join(', ');
			errorMsg += `\n  Did you mean: ${suggestions}?`;
			if (!schemaPath) {
				// Also suggest adding to search path if not using WITH SCHEMA
				errorMsg += `\n  Or add '${existsIn[0]}' to your schema path with: PRAGMA schema_path = '${searchedSchemas.join(',')},${existsIn[0]}'`;
			} else {
				errorMsg += `\n  Or add '${existsIn[0]}' to your WITH SCHEMA clause`;
			}
		}

		throw new QuereusError(errorMsg, StatusCode.ERROR);
	}

	// Record dependency
	const dependency: SchemaDependency = {
		type: 'table',
		schemaName: tableSchema.schemaName,
		objectName: tableSchema.name
	};
	ctx.schemaDependencies.recordDependency(dependency, tableSchema);

	// Cache result
	ctx.schemaCache.set(cacheKey, tableSchema);

	log('Resolved table schema: %s.%s (from search path)', tableSchema.schemaName, tableSchema.name);
	return tableSchema;
}

/**
 * Resolves a function schema at build time and records the dependency.
 */
export function resolveFunctionSchema(
	ctx: PlanningContext,
	funcName: string,
	numArgs: number
): FunctionSchema {
	const cacheKey = `function:${funcName}/${numArgs}`;

	// Check cache first
	const cached = ctx.schemaCache.get(cacheKey);
	if (cached) {
		log('Using cached function schema: %s/%d', funcName, numArgs);
		return cached as FunctionSchema;
	}

	// Resolve function schema - try exact match first
	let functionSchema = ctx.schemaManager.findFunction(funcName, numArgs);

	// If not found, try variable argument function
	if (!functionSchema) {
		functionSchema = ctx.schemaManager.findFunction(funcName, -1);
	}

	if (!functionSchema) {
		throw new QuereusError(
			`Function not found: ${funcName}/${numArgs}`,
			StatusCode.ERROR
		);
	}

	// Record dependency using the actual function's numArgs
	const dependency: SchemaDependency = {
		type: 'function',
		objectName: `${functionSchema.name}/${functionSchema.numArgs}`
	};
	ctx.schemaDependencies.recordDependency(dependency, functionSchema);

	// Cache result with the requested key for future lookups
	ctx.schemaCache.set(cacheKey, functionSchema);

	log('Resolved function schema: %s/%d', functionSchema.name, functionSchema.numArgs);
	return functionSchema;
}

/**
 * Resolves a virtual table module at build time and records the dependency.
 */
export function resolveVtabModule(
	ctx: PlanningContext,
	moduleName: string
): { module: AnyVirtualTableModule, auxData?: unknown } {
	const cacheKey = `vtab_module:${moduleName}`;

	// Check cache first
	const cached = ctx.schemaCache.get(cacheKey);
	if (cached) {
		log('Using cached vtab module: %s', moduleName);
		return cached;
	}

	// Resolve vtab module
	const moduleInfo = ctx.schemaManager.getModule(moduleName);
	if (!moduleInfo) {
		throw new QuereusError(
			`Virtual table module not found: ${moduleName}`,
			StatusCode.ERROR
		);
	}

	// Record dependency
	const dependency: SchemaDependency = {
		type: 'vtab_module',
		objectName: moduleName
	};
	ctx.schemaDependencies.recordDependency(dependency, moduleInfo);

	// Cache result
	ctx.schemaCache.set(cacheKey, moduleInfo);

	log('Resolved vtab module: %s', moduleName);
	return moduleInfo;
}

/**
 * Resolves a collation function at build time and records the dependency.
 * Delegates the lookup to `db.getCollationResolver()` — the one resolution
 * primitive — so a build-time miss reports the same `no such collation
 * sequence: X` error as emit time, and never falls back to BINARY.
 */
export function resolveCollation(
	ctx: PlanningContext,
	collationName: string
): CollationFunction {
	const cacheKey = `collation:${collationName}`;

	// Check cache first
	const cached = ctx.schemaCache.get(cacheKey);
	if (cached) {
		log('Using cached collation: %s', collationName);
		return cached as CollationFunction;
	}

	const collation = ctx.db.getCollationResolver()(collationName);

	// Record dependency
	const dependency: SchemaDependency = {
		type: 'collation',
		objectName: collationName
	};
	ctx.schemaDependencies.recordDependency(dependency, collation);

	// Cache result
	ctx.schemaCache.set(cacheKey, collation);

	log('Resolved collation: %s', collationName);
	return collation;
}

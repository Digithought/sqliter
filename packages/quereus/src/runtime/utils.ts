import { QuereusError } from '../common/errors.js';
import { StatusCode } from '../common/types.js';
import type { TableSchema } from '../schema/table.js';
import type { VirtualTable } from '../vtab/table.js';
import type { RuntimeContext } from './types.js';
import type { VirtualTableConnection } from '../vtab/connection.js';
import { createLogger } from '../common/logger.js';
import type { RowDescriptor, Attribute } from '../planner/nodes/plan-node.js';

const log = createLogger('runtime:utils');
const errorLog = log.extend('error');
export const ctxLog = createLogger('runtime:context');

/**
 * Check if a value is an AsyncIterable.
 *
 * NOTE: Hermes (React Native's JS engine) has a bug where AsyncGenerator objects
 * don't have Symbol.asyncIterator as an own or inherited property, even though
 * they are valid async iterables. We work around this by also checking for
 * the presence of a .next() method (duck typing for async iterators).
 */
export function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	// Standard check: Symbol.asyncIterator
	if (Symbol.asyncIterator in value) {
		return true;
	}
	// Hermes workaround: AsyncGenerator has .next() but not Symbol.asyncIterator
	const maybeAsyncGen = value as { next?: unknown; constructor?: { name?: string } };
	if (typeof maybeAsyncGen.next === 'function' &&
	    maybeAsyncGen.constructor?.name === 'AsyncGenerator') {
		return true;
	}
	return false;
}

/**
 * Get an AsyncIterator from an AsyncIterable, handling Hermes's missing Symbol.asyncIterator.
 *
 * @throws TypeError if value is not a valid async iterable
 */
export function getAsyncIterator<T>(value: AsyncIterable<T>): AsyncIterator<T> {
	// Standard path: use Symbol.asyncIterator
	if (Symbol.asyncIterator in value) {
		return value[Symbol.asyncIterator]();
	}
	// Hermes workaround: AsyncGenerator is its own iterator
	const maybeAsyncGen = value as unknown as { next?: () => Promise<IteratorResult<T>>; constructor?: { name?: string } };
	if (typeof maybeAsyncGen.next === 'function' &&
	    maybeAsyncGen.constructor?.name === 'AsyncGenerator') {
		return maybeAsyncGen as AsyncIterator<T>;
	}
	throw new TypeError('Value is not async iterable');
}

export async function asyncIterableToArray<T>(iterable: AsyncIterable<T>): Promise<T[]> {
	const result: T[] = [];
	for await (const item of iterable) {
		result.push(item);
	}
	return result;
}

/**
 * Helper to get or create a VirtualTable connection for a given table.
 * This ensures transaction consistency by reusing connections within the same context.
 */
export async function getVTableConnection(ctx: RuntimeContext, tableSchema: TableSchema): Promise<VirtualTableConnection> {
	if (ctx.readCommitted) {
		// NOTE: this helper currently has no callers anywhere in the repo, so the
		// guard below is a standing precondition for whoever revives it, not an
		// active safety net. Delete both together if the helper goes.
		// Assertion, not control flow: this helper is the transaction-JOINING path —
		// it reuses the writer's registered connection and `registerConnection`
		// auto-joins new connections to the open transaction. A mutex-free committed
		// read is gated read-only before routing (Database._isConcurrentReadEligible),
		// so reaching here means the eligibility gate failed.
		throw new QuereusError(
			`getVTableConnection reached during a committed read (table '${tableSchema.schemaName}.${tableSchema.name}')`,
			StatusCode.INTERNAL);
	}
	const tableName = `${tableSchema.schemaName}.${tableSchema.name}`;

	// Check if we already have an active connection for this table
	const existingConnections = ctx.db.getConnectionsForTable(tableName);
	if (existingConnections.length > 0) {
		log(`Reusing existing connection for table ${tableName}`);
		return existingConnections[0];
	}

	// Create a new VirtualTable instance
	const vtab = await getVTable(ctx, tableSchema);

	// Try to create a connection if the table supports it
	let connection: VirtualTableConnection;
	if (vtab.createConnection) {
		connection = await vtab.createConnection();
		log(`Created new connection ${connection.connectionId} for table ${tableName}`);
	} else if (vtab.getConnection) {
		const existingConn = vtab.getConnection();
		if (existingConn) {
			connection = existingConn;
			log(`Using existing internal connection ${connection.connectionId} for table ${tableName}`);
		} else {
			throw new QuereusError(`Table '${tableName}' does not support connections`, StatusCode.INTERNAL);
		}
	} else {
		throw new QuereusError(`Table '${tableName}' does not support connections`, StatusCode.INTERNAL);
	}

	// Register the connection with the database
	await ctx.db.registerConnection(connection);

	// Set as the active connection in the runtime context if none is set
	if (!ctx.activeConnection) {
		ctx.activeConnection = connection;
	}

	return connection;
}

/**
 * Helper to get the VirtualTable instance for a given TableReferenceNode.
 * This is the legacy method that creates ephemeral instances.
 * When reusing connections, this will also inject the existing connection into the VirtualTable.
 */
export async function getVTable(ctx: RuntimeContext, tableSchema: TableSchema): Promise<VirtualTable> {
	// All tables are virtual, so vtabModuleName should always be present.
	if (!tableSchema.vtabModuleName) {
		throw new QuereusError(`Table schema for '${tableSchema.name}' is missing vtabModuleName.`, StatusCode.INTERNAL);
	}
	const moduleInfo = ctx.db._getVtabModule(tableSchema.vtabModuleName);
	if (!moduleInfo) {
		throw new QuereusError(`Virtual table module '${tableSchema.vtabModuleName}' not found for table '${tableSchema.name}'`, StatusCode.ERROR);
	}
	const module = moduleInfo.module;
	if (typeof module.connect !== 'function') {
		throw new QuereusError(`Virtual table module '${tableSchema.vtabModuleName}' does not implement connect`, StatusCode.MISUSE);
	}
	const vtabArgs = tableSchema.vtabArgs || {};
	// Pass the full tableSchema to connect() so modules can use the primaryKeyDefinition
	const vtabInstance = await module.connect(ctx.db, moduleInfo.auxData, tableSchema.vtabModuleName, tableSchema.schemaName, tableSchema.name, vtabArgs, tableSchema);

	// If a connection for this table is already registered, offer it to the fresh instance
	// via the module-neutral adoptConnection hook. The module owns the accept/reject
	// decision (subtype + backing-state match); the runtime knows nothing about any module.
	const qualifiedName = `${tableSchema.schemaName}.${tableSchema.name}`;
	const existingConnections = ctx.db.getConnectionsForTable(qualifiedName);
	if (existingConnections.length > 0) {
		// NOTE: getVTable adopts existingConnections[0]; if covering-connection semantics ever
		// matter here (cf. isCovering in connection.ts / DeferredConstraintQueue), prefer the
		// covering connection.
		await vtabInstance.adoptConnection?.(existingConnections[0]);
	}

	return vtabInstance;
}

/**
 * Helper to properly disconnect and unregister a VirtualTable instance.
 */
export async function disconnectVTable(ctx: RuntimeContext, vtab: VirtualTable): Promise<void> {
	// Disconnect the VirtualTable instance
	if (typeof vtab.disconnect === 'function') {
		await vtab.disconnect().catch((e: unknown) => {
			errorLog(`Error during disconnect for table '${vtab.tableName}': ${e}`);
		});
	}
}

/**
 * Helper function to log context push operations
 */
export function logContextPush(descriptor: RowDescriptor, note: string, attributes?: readonly Attribute[]) {
	const attrs = Object.keys(descriptor).filter(k => descriptor[parseInt(k)] !== undefined);
	const attrNames = attributes ? attributes.map(attr => `${attr.name}(#${attr.id})`).join(',') : 'unknown';
	ctxLog('PUSH context %s: attrs=[%s] names=[%s]', note, attrs.join(','), attrNames);
}

/**
 * Helper function to log context pop operations
 */
export function logContextPop(descriptor: RowDescriptor, note: string) {
	const attrs = Object.keys(descriptor).filter(k => descriptor[parseInt(k)] !== undefined);
	ctxLog('POP context %s: attrs=[%s]', note, attrs.join(','));
}

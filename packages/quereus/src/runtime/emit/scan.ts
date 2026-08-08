import { StatusCode, type Row, type SqlValue } from "../../common/types.js";
import { SeqScanNode, IndexScanNode, IndexSeekNode } from "../../planner/nodes/table-access-nodes.js";
import { AbortError, QuereusError, throwIfAborted } from "../../common/errors.js";
import type { VirtualTable } from "../../vtab/table.js";
import type { BaseModuleConfig, AnyVirtualTableModule } from "../../vtab/module.js";
import type { FilterInfo } from "../../vtab/filter-info.js";
import type { Instruction, RuntimeContext } from "../types.js";
import { asRun } from "../types.js";
import type { EmissionContext } from "../emission-context.js";
import { createValidatedInstruction, emitPlanNode } from "../emitters.js";
import { disconnectVTable } from "../utils.js";
import { buildRowDescriptor } from "../../util/row-descriptor.js";
import { createRowSlot } from "../context-helpers.js";
import { REPR_STRICT } from "../strict-flags.js";
import { assertRowConforms, RepresentationError } from "../strict-representation.js";

/**
 * Optional override hook supplied by callers that need to mutate the
 * `FilterInfo` handed to the vtab at runtime — e.g., `OrdinalSlice`
 * stamping `limit` / `offset` after resolving its scalar expressions.
 *
 * The override receives the plan's `FilterInfo` (already augmented with
 * any IndexSeek dynamic args) and returns a possibly-cloned, possibly-
 * augmented copy. Returning the input unchanged is legal.
 */
export type FilterInfoOverride = (
	baseFilterInfo: FilterInfo,
	runtimeCtx: RuntimeContext,
	dynamicArgs: SqlValue[],
) => FilterInfo | Promise<FilterInfo>;

/**
 * Emits instructions for physical table access nodes (SeqScan, IndexScan, IndexSeek).
 *
 * Optionally accepts a `filterInfoOverride` so wrapping operators (e.g.,
 * `OrdinalSlice`) can push `limit`/`offset` directives into the vtab call
 * without re-emitting the leaf or duplicating connect/disconnect lifecycle.
 */
export function emitSeqScan(
	plan: SeqScanNode | IndexScanNode | IndexSeekNode,
	ctx: EmissionContext,
	filterInfoOverride?: FilterInfoOverride,
): Instruction {
	// Handle physical access nodes
	const source = plan.source;
	const schema = source.tableSchema;

	// Create row descriptor mapping attribute IDs to column indices
	const rowDescriptor = buildRowDescriptor(plan.getAttributes());

	// Look up the virtual table module during emission and record the dependency
	const moduleInfo = ctx.getVtabModule(schema.vtabModuleName);
	if (!moduleInfo) {
		throw new QuereusError(`Virtual table module '${schema.vtabModuleName}' not found`, StatusCode.ERROR);
	}

	// Capture the module info key for runtime retrieval
	const moduleKey = `vtab_module:${schema.vtabModuleName}`;

	// Stable per-scan-node key for the per-execution connection cache
	// (RuntimeContext.scanConnections). Minted once here in the emitter closure, so
	// it is identical across every re-scan of THIS scan site within one execution
	// (the instruction tree is cached and reused), yet distinct from every other
	// scan site — a self-join's two scans over the same table get different keys and
	// therefore isolated instances. Mirrors the executionMemo symbol pattern.
	const scanConnectionKey = Symbol(`scan:${plan.nodeType}(${schema.name})`);

	// QUEREUS_REPR_STRICT seam: rows leaving a module's `query()`, checked against the
	// table's declared column types. Catches a non-conforming module (in-tree or
	// third-party) at its OWN boundary rather than three layers downstream. Everything
	// the check needs is built here only when the flag is on, so a normal emit allocates
	// nothing on its behalf.
	const reprColumnTypes = REPR_STRICT ? schema.columns.map(col => col.logicalType) : undefined;
	const reprColumnNames = REPR_STRICT ? schema.columns.map(col => col.name) : undefined;
	const reprWhere = REPR_STRICT
		? `module '${schema.vtabModuleName}' query() row for ${schema.schemaName}.${schema.name}`
		: '';

	async function* run(runtimeCtx: RuntimeContext, ...dynamicArgs: SqlValue[]): AsyncIterable<Row> {
		// Use the captured module info instead of doing a fresh lookup
		const capturedModuleInfo = ctx.getCapturedSchemaObject<{ module: AnyVirtualTableModule, auxData?: unknown }>(moduleKey);
		if (!capturedModuleInfo) {
			throw new QuereusError(`Virtual table module '${schema.vtabModuleName}' was not captured during emission`, StatusCode.INTERNAL);
		}

		const module = capturedModuleInfo.module;
		if (typeof module.connect !== 'function') {
			throw new QuereusError(`Virtual table module '${schema.vtabModuleName}' does not implement connect`, StatusCode.MISUSE);
		}

		// Reuse a per-execution connected instance when one exists for this scan site
		// (NLJ inner re-scan). On a cache miss connect once and store it; the teardown
		// in statement.ts disconnects each cached instance exactly once. When no cache
		// is present (transient/analysis RuntimeContexts), fall back to owning the
		// lifecycle: connect here and disconnect in this generator's finally.
		const connectionCache = runtimeCtx.scanConnections;
		const cachedInstance = connectionCache?.get(scanConnectionKey);
		// True only when this invocation must disconnect the instance itself (no cache
		// to defer teardown to). A reused (cached) instance is never owned here.
		let ownsInstance = false;
		let vtabInstance: VirtualTable;
		if (cachedInstance) {
			vtabInstance = cachedInstance;
		} else {
			// `schema.name` is the name this scan was EMITTED against. A deferred constraint
			// evaluates a plan frozen at row-write time, so an `ALTER TABLE ... RENAME TO`
			// later in the same transaction leaves that name pointing at nothing. The queue
			// stamps the entry's old→new mapping onto the context while it evaluates; resolve
			// through it so we connect under the name the table carries now. Undefined for
			// every other execution, so this costs one optional lookup. Nothing else in this
			// scan is name-bound — `schema.columns`, the row descriptor and the `FilterInfo`
			// are positional, and a table rename changes no column.
			const effectiveName = runtimeCtx.tableNameRemap?.get(
				`${schema.schemaName}.${schema.name}`.toLowerCase()) ?? schema.name;
			try {
				const options: BaseModuleConfig = {
					...(schema.vtabArgs ?? {}),
					// Per-reference (`committed.<table>`) OR per-execution (mutex-free
					// committed read — see RuntimeContext.readCommitted). The OR makes a
					// `committed.` reference inside a concurrent read a no-op, not a conflict.
					...((source.readCommitted || runtimeCtx.readCommitted) ? { _readCommitted: true } : {})
				};
				vtabInstance = await module.connect(
					runtimeCtx.db,
					capturedModuleInfo.auxData,
					schema.vtabModuleName,
					schema.schemaName,
					effectiveName,
					options
				);
			} catch (e: unknown) {
				const message = e instanceof Error ? e.message : String(e);
				throw new QuereusError(`Module '${schema.vtabModuleName}' connect failed for table '${effectiveName}': ${message}`, e instanceof QuereusError ? e.code : StatusCode.ERROR, e instanceof Error ? e : undefined);
			}

			if (connectionCache) {
				connectionCache.set(scanConnectionKey, vtabInstance);
			} else {
				ownsInstance = true;
			}
		}

		const rowSlot = createRowSlot(runtimeCtx, rowDescriptor);
		try {
			// If this is an IndexSeek with dynamic seek keys, populate args from params
			let effectiveFilterInfo: FilterInfo = (plan instanceof IndexSeekNode && dynamicArgs && dynamicArgs.length > 0)
				? { ...plan.filterInfo, args: dynamicArgs }
				: plan.filterInfo;

			if (filterInfoOverride) {
				effectiveFilterInfo = await filterInfoOverride(effectiveFilterInfo, runtimeCtx, dynamicArgs);
			}

			if (typeof vtabInstance.query !== 'function') {
				// Fallback or error if query is not available. For now, throwing an error.
				// Later, we could implement the open/filter/next loop here as a fallback.
				// Checked inside the try so an owned (un-cached) instance still disconnects.
				throw new QuereusError(`Virtual table '${schema.name}' does not support query.`, StatusCode.UNSUPPORTED);
			}

			const asyncRowIterable = vtabInstance.query(effectiveFilterInfo);
			throwIfAborted(runtimeCtx.signal);
			for await (const row of asyncRowIterable) {
				// Cooperative cancellation checkpoint: a request-timeout (or any
				// caller abort) interrupts the scan between rows so the whole query
				// pipeline unwinds promptly instead of draining the table.
				// NOTE: for the memory vtab this is now the ONLY per-row cancellation
				// checkpoint — the inner scan layers (safeIterate/scanLayer) went sync,
				// so do not remove it expecting an inner checkpoint to cover the scan.
				throwIfAborted(runtimeCtx.signal);
				// Synchronous and inside this loop on purpose: enabling the flag must not
				// introduce a microtask hop into the scan's fast path (docs/runtime.md).
				if (REPR_STRICT) assertRowConforms(row, reprColumnTypes!, reprWhere, reprColumnNames);
				rowSlot.set(row);
				yield row;
			}
		} catch (e: unknown) {
			// Preserve cancellation identity — don't re-wrap it as a generic query error.
			// A representation violation is likewise rethrown verbatim: re-wrapping it
			// would bury the seam/column/type detail its message exists to carry.
			if (e instanceof AbortError || e instanceof RepresentationError) throw e;
			const message = e instanceof Error ? e.message : String(e);
			throw new QuereusError(`Error during query on table '${schema.name}': ${message}`, e instanceof QuereusError ? e.code : StatusCode.ERROR, e instanceof Error ? e : undefined);
		} finally {
			// The row slot is per-invocation and must close on every pass.
			rowSlot.close();
			// Disconnect only when this invocation owns the instance (no per-execution
			// cache to defer teardown to). A cached instance stays live across re-scans
			// and is released once at statement teardown, not here.
			if (ownsInstance) {
				await disconnectVTable(runtimeCtx, vtabInstance);
			}
		}
	}

	// Emit parameter instructions for dynamic seek keys (IndexSeek only)
	const params: Instruction[] = [];
	if (plan instanceof IndexSeekNode) {
		for (const key of plan.getSeekKeys()) {
			params.push(emitPlanNode(key, ctx));
		}
	}

	return createValidatedInstruction(
		params,
		asRun(run),
		ctx,
		`${plan.nodeType}(${schema.name})`
	);
}

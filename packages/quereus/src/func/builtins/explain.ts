import type { Row } from "../../common/types.js";
import type { SqlValue } from "../../common/types.js";
import { createIntegratedTableValuedFunction } from "../registration.js";
import { INTEGER_TYPE, REAL_TYPE, TEXT_TYPE } from "../../types/builtin-types.js";
import { QuereusError } from "../../common/errors.js";
import { StatusCode } from "../../common/types.js";
import type { Database } from "../../core/database.js";
import { safeJsonStringify } from "../../util/serialization.js";
import { CollectingInstructionTracer, type Instruction, InstructionTraceEvent } from "../../runtime/types.js";
import { PlanNode, RelationalPlanNode } from "../../planner/nodes/plan-node.js";
import { EmissionContext } from "../../runtime/emission-context.js";
import { emitPlanNode } from "../../runtime/emitters.js";
import { Scheduler } from "../../runtime/scheduler.js";
import { analyzeRowSpecific } from "../../planner/analysis/constraint-extractor.js";
import { Parser } from "../../parser/parser.js";
import * as AST from "../../parser/ast.js";
import { astToString } from "../../emit/ast-stringify.js";
import { computeBasisBackfill } from "../../schema/basis-backfill.js";
import { computeSchemaHash } from "../../schema/schema-hasher.js";
import { planAssertionBodyForAnalysis } from "../../planner/analysis/assertion-plan.js";
import { resolveBaseSite } from "../../planner/analysis/update-lineage.js";
import type { LensSlot } from "../../schema/lens.js";
import { createLogger } from "../../common/logger.js";
import { splitBaseKey } from "../../util/qualified-name.js";
import { relationKeyBase } from "../../planner/analysis/relation-key.js";

const log = createLogger('func:builtins:explain');

interface NamedSchemaLike {
	name: string;
	schemaName?: string;
}

// Helper function to safely get function name from nodes that have it
function getFunctionName(node: PlanNode): string | null {
	const candidate = (node as { functionName?: unknown }).functionName;
	if (typeof candidate === 'string') {
		return candidate;
	}
	return null;
}

// Helper function to safely get alias from nodes that have it
function getAlias(node: PlanNode): string | null {
	const candidate = (node as { alias?: unknown }).alias;
	if (typeof candidate === 'string') {
		return candidate;
	}
	return null;
}

// Helper function to safely get table name or related identifier
function getObjectName(node: PlanNode): string | null {
	// Check for function name first (table functions, scalar functions, etc.)
	const functionName = getFunctionName(node);
	if (functionName) {
		return functionName;
	}

	// Check for table schema in table reference nodes
	const tableSchema = (node as { tableSchema?: NamedSchemaLike }).tableSchema;
	if (tableSchema && typeof tableSchema.name === 'string') {
		return tableSchema.schemaName ? `${tableSchema.schemaName}.${tableSchema.name}` : tableSchema.name;
	}

	// Check for CTE name
	const cteName = (node as { cteName?: unknown }).cteName;
	if (typeof cteName === 'string') {
		return cteName;
	}

	// Check for view schema in view reference nodes
	const viewSchema = (node as { viewSchema?: NamedSchemaLike }).viewSchema;
	if (viewSchema && typeof viewSchema.name === 'string') {
		return viewSchema.schemaName ? `${viewSchema.schemaName}.${viewSchema.name}` : viewSchema.name;
	}

	return null;
}

// Query plan explanation function (table-valued function)
export const queryPlanFunc = createIntegratedTableValuedFunction(
	{
		name: 'query_plan',
		numArgs: 1,
		deterministic: true,
		returnType: {
			typeClass: 'relation',
			isReadOnly: true,
			isSet: false,
			columns: [
				{ name: 'id', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'parent_id', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'subquery_level', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'node_type', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'op', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'detail', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'object_name', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'alias', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'properties', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'physical', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'est_cost', type: { typeClass: 'scalar', logicalType: REAL_TYPE, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'est_rows', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: true, isReadOnly: true }, generated: true }
			],
			keys: [],
			rowConstraints: []
		},
		relationalAdvertisement: {
			isSet: true,
			// `id` (column 0) is the assigned nodeId and is unique per plan node.
			keys: [[{ index: 0 }]],
			deterministic: true,
		},
	},
	async function* (db: Database, sql: SqlValue): AsyncIterable<Row> {
		if (typeof sql !== 'string') {
			throw new QuereusError('query_plan() requires a SQL string argument', StatusCode.ERROR);
		}

		try {
			// Parse and plan the SQL to get the actual plan tree
			const plan = db.getPlan(sql);

			// Traverse the plan tree and yield information about each node
			let nodeId = 1;
			const nodeStack: Array<{ node: PlanNode; parentId: number | null; level: number }> = [
				{ node: plan, parentId: null, level: 0 }
			];

			while (nodeStack.length > 0) {
				const { node, parentId, level } = nodeStack.pop()!;
				const currentId = nodeId++;

				// Get node type
				const nodeType = node.nodeType || 'UNKNOWN';

				// Determine operation type and details
				let op = 'UNKNOWN';
				let detail = 'Unknown operation';
				let objectName: string | null = null;
				let alias: string | null = null;
				const estCost = node.estimatedCost || 1.0;
				const estRows = (node as RelationalPlanNode).estimatedRows || 10;

				// Use node's toString() method for detail if available
				if (typeof node.toString === 'function') {
					detail = node.toString();
				}

				if (node.nodeType) {
					op = node.nodeType.replace(/Node$/, '').toUpperCase();

					// Extract object name and alias using helper functions
					objectName = getObjectName(node);
					alias = getAlias(node);
				}

				// Get logical properties using the correct method name
				let properties: string | null = null;
				const logicalAttributes = node.getLogicalAttributes();
				if (logicalAttributes && Object.keys(logicalAttributes).length > 0) {
					// Attach minimal QuickPick diagnostics from optimizer if available
					const diag = db.optimizer.getLastDiagnostics?.();
					if (diag?.quickpick) {
						(logicalAttributes as Record<string, unknown>).quickpick = diag.quickpick;
					}
					properties = safeJsonStringify(logicalAttributes);
				}

				// Get physical properties (if available)
				let physical: string | null = null;
				if (node.physical) {
					physical = safeJsonStringify(node.physical);
				}

				yield [
					currentId,           // id
					parentId,           // parent_id
					level,              // subquery_level
					nodeType,           // node_type
					op,                 // op
					detail,             // detail
					objectName,         // object_name
					alias,              // alias
					properties,         // properties
					physical,           // physical
					estCost,            // est_cost
					estRows             // est_rows
				];

				// Add children to stack (in reverse order so they're processed in correct order)
				// getChildren() is guaranteed to exist on all PlanNode instances
				const children = node.getChildren();
				for (let i = children.length - 1; i >= 0; i--) {
					nodeStack.push({ node: children[i], parentId: currentId, level });
				}
			}
		} catch (error: unknown) {
			// If planning fails, yield an error row
			const message = error instanceof Error ? error.message : String(error);
			yield [1, null, 0, 'ERROR', 'ERROR', `Failed to plan SQL: ${message}`, null, null, null, null, null, null];
		}
	}
);

/**
 * One row of the compiled instruction listing produced by
 * {@link collectSchedulerProgram}. Every address here is a global instruction
 * address (`Scheduler.addressOf`) — unique across the main program and every
 * nested sub-program — which is what makes it joinable against trace events.
 */
interface SchedulerProgramEntry {
	addr: number;
	dependencies: number[];
	description: string;
	isSubprogram: boolean;
	parentAddr: number | null;
}

// NOTE: a TVF body runs *inside* the statement that called it — under the
// same exec mutex the caller already holds (Database._acquireExecMutex).
// It must reach plan/emit/execute in-process (db.getPlan, db.prepare,
// Statement.iterateRowsWithTrace) and never issue a nested top-level query
// via db.eval/db.exec, which deadlocks waiting on a mutex the outer
// statement cannot release until this generator returns.
//
// Shared by scheduler_program() and execution_trace(), which must report the
// same (full, sub-program) instruction listing — execution_trace() joins its
// trace events against these addresses. Throws rather than
// returning an error row; callers keep their own error handling.
function collectSchedulerProgram(db: Database, sql: string): SchedulerProgramEntry[] {
	const entries: SchedulerProgramEntry[] = [];

	// Parse and plan the SQL to get the actual plan tree
	const plan = db.getPlan(sql);

	// Emit the plan to get the instruction tree. Unfused: this listing exists to
	// show the instruction graph, and execution_trace() joins against it by
	// instruction address — both must report the same (full, sub-program) form.
	// Scalar fusion would dissolve scalar sub-programs into single fused(...)
	// instructions.
	const emissionContext = new EmissionContext(db, { fuseScalars: false });
	const rootInstruction = emitPlanNode(plan, emissionContext);

	// Create a scheduler to get the instruction sequence. The scheduler owns
	// addressing; nothing here encodes or decodes an address.
	const scheduler = new Scheduler(rootInstruction);
	scheduler.ensureAddressesAssigned();
	appendSchedulerEntries(scheduler, null, entries);

	return entries;
}

/**
 * Appends one entry per instruction in `scheduler`, then recurses into each
 * instruction's nested programs so a program nested two deep (e.g. a correlated
 * scalar subquery inside a filter predicate) is listed too. Sub-program rows
 * follow the instruction that owns them, which is also their `parentAddr`.
 */
function appendSchedulerEntries(
	scheduler: Scheduler,
	parentAddr: number | null,
	entries: SchedulerProgramEntry[]
): void {
	for (let i = 0; i < scheduler.instructions.length; i++) {
		const instruction = scheduler.instructions[i];
		const addr = scheduler.addressOf(i);

		entries.push({
			addr,
			dependencies: scheduler.dependencyAddressesOf(i),
			description: instruction.note || `INSTRUCTION_${addr}`,
			isSubprogram: parentAddr !== null,
			parentAddr,
		});

		if (instruction.programs) {
			for (const subProgram of instruction.programs) {
				appendSchedulerEntries(subProgram, addr, entries);
			}
		}
	}
}

// Scheduler program explanation function (table-valued function)
export const schedulerProgramFunc = createIntegratedTableValuedFunction(
	{
		name: 'scheduler_program',
		numArgs: 1,
		deterministic: true,
		returnType: {
			typeClass: 'relation',
			isReadOnly: true,
			isSet: false,
			columns: [
				{ name: 'addr', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'dependencies', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true }, // JSON array of dependency IDs
				{ name: 'description', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'estimated_cost', type: { typeClass: 'scalar', logicalType: REAL_TYPE, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'is_subprogram', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true }, // 0/1 boolean
				{ name: 'parent_addr', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: true, isReadOnly: true }, generated: true }
			],
			keys: [],
			rowConstraints: []
		}
	},
	async function* (db: Database, sql: SqlValue): AsyncIterable<Row> {
		if (typeof sql !== 'string') {
			throw new QuereusError('scheduler_program() requires a SQL string argument', StatusCode.ERROR);
		}

		try {
			const entries = collectSchedulerProgram(db, sql);
			for (const entry of entries) {
				yield [
					entry.addr,                         // addr
					JSON.stringify(entry.dependencies), // dependencies
					entry.description,                  // description
					null,                                // estimated_cost (not available in current implementation)
					entry.isSubprogram ? 1 : 0,         // is_subprogram
					entry.parentAddr                    // parent_addr
				];
			}
		} catch (error: unknown) {
			// If compilation fails, yield an error instruction
			const message = error instanceof Error ? error.message : String(error);
			yield [0, '[]', `Failed to compile SQL: ${message}`, null, 0, null];
		}
	}
);

// Stack trace function for debugging execution
export const stackTraceFunc = createIntegratedTableValuedFunction(
	{
		name: 'stack_trace',
		numArgs: 1,
		deterministic: true,
		returnType: {
			typeClass: 'relation',
			isReadOnly: true,
			isSet: false,
			columns: [
				{ name: 'frame_id', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'depth', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'location', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'plan_node_type', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'operation', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'table_or_function', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'is_virtual', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true } // 0/1 boolean
			],
			keys: [],
			rowConstraints: []
		}
	},
	async function* (db: Database, sql: SqlValue): AsyncIterable<Row> {
		if (typeof sql !== 'string') {
			throw new QuereusError('stack_trace() requires a SQL string argument', StatusCode.ERROR);
		}

		try {
			// Parse and plan the SQL to capture the call stack
			const plan = db.getPlan(sql);

			// Simulate a call stack based on the plan structure
			let frameId = 0;
			const stack: Array<{ name: string; location: string; vars: Record<string, unknown> }> = [];

			// Add main execution frame
			stack.push({
				name: 'main',
				location: 'database.ts:exec',
				vars: { sql, autocommit: db.getAutocommit() }
			});

			// Add planning frames
			stack.push({
				name: 'buildPlan',
				location: 'database.ts:_buildPlan',
				vars: { planType: plan.nodeType }
			});

			// Add frames based on plan node types
			const addPlanFrames = (node: PlanNode, depth: number = 0) => {
				if (!node || depth > 10) return; // Prevent infinite recursion

				switch (node.nodeType) {
					case 'Block': {
						const statements = (node as { statements?: ReadonlyArray<unknown> }).statements;
						stack.push({
							name: 'buildBlock',
							location: 'building/block.ts:buildBlock',
							vars: { statementCount: statements?.length ?? 0 }
						});
						break;
					}
					case 'Filter': {
						const condition = (node as { condition?: { toString(): string } }).condition;
						stack.push({
							name: 'buildFilter',
							location: 'building/select.ts:buildSelectStmt',
							vars: { condition: condition?.toString() ?? 'unknown' }
						});
						break;
					}
					case 'Project': {
						const projections = (node as { projections?: ReadonlyArray<unknown> }).projections;
						stack.push({
							name: 'buildProject',
							location: 'building/select.ts:buildSelectStmt',
							vars: { projectionCount: projections?.length ?? 0 }
						});
						break;
					}
				}

				// Recursively add frames for children
				// getChildren() is guaranteed to exist on all PlanNode instances
				const children = node.getChildren();
				children.forEach((child: PlanNode) => addPlanFrames(child, depth + 1));
			};

			addPlanFrames(plan);

			// Yield stack frames (reverse order - deepest first)
			for (let i = stack.length - 1; i >= 0; i--) {
				const frame = stack[i];
				yield [
					frameId++,                    // frame_id
					i,                           // depth
					frame.location,              // location
					frame.name,                   // plan_node_type
					frame.name,                   // operation
					null,                        // table_or_function
					0                            // is_virtual
				];
			}
		} catch (error: unknown) {
			// If analysis fails, yield an error frame
			const message = error instanceof Error ? error.message : String(error);
			yield [0, 0, 'error', 'stack_trace', `Failed to analyze: ${message}`, null, 0];
		}
	}
);

// Execution trace function for performance analysis
export const executionTraceFunc = createIntegratedTableValuedFunction(
	{
		name: 'execution_trace',
		numArgs: 1,
		deterministic: false, // Execution traces are not deterministic
		returnType: {
			typeClass: 'relation',
			isReadOnly: true,
			isSet: false,
			columns: [
				{ name: 'instruction_index', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'operation', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'dependencies', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true }, // JSON array of instruction indices this depends on
				{ name: 'input_values', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true }, // JSON
				{ name: 'output_value', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true }, // JSON
				{ name: 'duration_ms', type: { typeClass: 'scalar', logicalType: REAL_TYPE, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'sub_programs', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true }, // JSON
				{ name: 'error_message', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'timestamp_ms', type: { typeClass: 'scalar', logicalType: REAL_TYPE, nullable: false, isReadOnly: true }, generated: true }
			],
			keys: [],
			rowConstraints: []
		}
	},
	async function* (db: Database, sql: SqlValue): AsyncIterable<Row> {
		if (typeof sql !== 'string') {
			throw new QuereusError('execution_trace() requires a SQL string argument', StatusCode.ERROR);
		}

		try {
			// First, get the scheduler program to understand instruction dependencies
			const instructionDependencies = new Map<number, number[]>();
			const instructionOperations = new Map<number, string>();

			try {
				// Get scheduler program information. Must stay in-process (not db.eval —
				// see the NOTE on collectSchedulerProgram): this generator body already
				// runs under the exec mutex the outer statement holds.
				for (const entry of collectSchedulerProgram(db, sql)) {
					instructionDependencies.set(entry.addr, entry.dependencies);
					instructionOperations.set(entry.addr, entry.description);
				}
			} catch (schedulerError: unknown) {
				const message = schedulerError instanceof Error ? schedulerError.message : String(schedulerError);
				log('Could not get scheduler program info: %s', message);
			}

			// Import the CollectingInstructionTracer
			const tracer = new CollectingInstructionTracer();

			// Parse the query and execute with tracing
			let stmt: ReturnType<Database['prepare']> | undefined;
			try {
				stmt = db.prepare(sql);
				// Trace the UNFUSED graph so instruction indices line up with the
				// scheduler_program() rows joined above. Compile is deferred, so setting
				// this right after prepare is race-free (see Statement._emitUnfused).
				stmt._emitUnfused = true;

				// Execute the query with tracing to collect actual instruction events
				const results: Row[] = [];
				for await (const row of stmt.iterateRowsWithTrace(undefined, tracer)) {
					results.push(row); // We don't yield the results, just the trace events
				}

			} catch (executionError: unknown) {
				// If execution fails, we might still have some trace events
				log('Query execution failed during tracing: %s', executionError instanceof Error ? executionError.message : String(executionError));
			} finally {
				await stmt?.finalize();
			}

			// Get the collected trace events
			const traceEvents = tracer.getTraceEvents();

			// Group events by instruction index and consolidate into single rows
			const eventsByInstruction = new Map<number, InstructionTraceEvent[]>();
			for (const event of traceEvents) {
				const instructionIndex = event.instructionIndex;
				if (!eventsByInstruction.has(instructionIndex)) {
					eventsByInstruction.set(instructionIndex, []);
				}
				eventsByInstruction.get(instructionIndex)!.push(event);
			}

			// Get sub-program information for enhanced context
			const subPrograms = tracer.getSubPrograms ? tracer.getSubPrograms() : new Map();

			// Create one row per instruction execution
			for (const [instructionIndex, events] of eventsByInstruction.entries()) {
				const inputEvent = events.find(e => e.type === 'input');
				const outputEvent = events.find(e => e.type === 'output');
				const errorEvent = events.find(e => e.type === 'error');

				// Use operation name from scheduler program, fallback to event note
				const operationName = instructionOperations.get(instructionIndex) || inputEvent?.note || 'Unknown';
				const dependencies = instructionDependencies.get(instructionIndex) || [];

				// Calculate duration between input and output
				let duration: number | null = null;
				if (inputEvent && outputEvent) {
					duration = outputEvent.timestamp - inputEvent.timestamp;
				}

				// Build enhanced sub-program information
				let subProgramsInfo: unknown = null;
				if (inputEvent?.subPrograms && inputEvent.subPrograms.length > 0) {
					// Enhance sub-program info with details from the tracer
					subProgramsInfo = inputEvent.subPrograms.map(sp => {
						const subProgramDetail = subPrograms.get(sp.programIndex);
						const baseInfo = {
							programIndex: sp.programIndex,
							instructionCount: sp.instructionCount,
							rootNote: sp.rootNote
						};

						if (subProgramDetail) {
							// Add instruction details from the sub-program, addressed the same
							// way as every other row so they can be looked up in the listing.
							const subScheduler = subProgramDetail.scheduler;
							const instructions = subScheduler.instructions.map((instr: Instruction, idx: number) => {
								const address = subScheduler.addressOf(idx);
								return {
									index: address,
									operation: instr.note || `instruction_${address}`,
									dependencies: subScheduler.dependencyAddressesOf(idx)
								};
							});
							return { ...baseInfo, instructions };
						}

						return baseInfo;
					});
				}

				const timestamp = inputEvent?.timestamp || outputEvent?.timestamp || Date.now();

				yield [
					instructionIndex,                                                          // instruction_index
					operationName,                                                            // operation
					safeJsonStringify(dependencies),                                          // dependencies
					inputEvent?.args ? safeJsonStringify(inputEvent.args) : null,            // input_values
					outputEvent?.result !== undefined ? safeJsonStringify(outputEvent.result) : null, // output_value
					duration,                                                                  // duration_ms
					subProgramsInfo ? safeJsonStringify(subProgramsInfo) : null,             // sub_programs
					errorEvent?.error || null,                                                // error_message
					timestamp                                                                  // timestamp_ms
				];
			}

			// If no trace events were captured, yield a summary row
			if (eventsByInstruction.size === 0) {
				yield [
					0,                    // instruction_index
					'NO_TRACE_DATA',      // operation
					safeJsonStringify([]), // dependencies
					null,                 // input_values
					safeJsonStringify('No instruction-level trace events captured'), // output_value
					null,                 // duration_ms
					null,                 // sub_programs
					null,                 // error_message
					Date.now()            // timestamp_ms
				];
			}

		} catch (error: unknown) {
			// If tracing setup fails, yield an error event
			const message = error instanceof Error ? error.message : String(error);
			yield [
				0,                                                        // instruction_index
				'TRACE_SETUP',                                           // operation
				safeJsonStringify([]),                                    // dependencies
				null,                                                     // input_values
				null,                                                     // output_value
				null,                                                     // duration_ms
				null,                                                     // sub_programs
				`Failed to setup execution trace: ${message}`,           // error_message
				Date.now()                                                // timestamp_ms
			];
		}
	}
);

// Row-level execution trace function for detailed data flow analysis
export const rowTraceFunc = createIntegratedTableValuedFunction(
	{
		name: 'row_trace',
		numArgs: 1,
		deterministic: false, // Row traces are not deterministic
		returnType: {
			typeClass: 'relation',
			isReadOnly: true,
			isSet: false,
			columns: [
				{ name: 'instruction_index', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'operation', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'row_index', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'row_data', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true }, // JSON array of row values
				{ name: 'timestamp_ms', type: { typeClass: 'scalar', logicalType: REAL_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'row_count', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: true, isReadOnly: true }, generated: true } // Total rows for this instruction (filled in last row)
			],
			keys: [],
			rowConstraints: []
		}
	},
	async function* (db: Database, sql: SqlValue): AsyncIterable<Row> {
		if (typeof sql !== 'string') {
			throw new QuereusError('row_trace() requires a SQL string argument', StatusCode.ERROR);
		}

		try {
			// Import the CollectingInstructionTracer
			const tracer = new CollectingInstructionTracer();

			// Parse the query and execute with tracing
			let stmt: ReturnType<Database['prepare']> | undefined;
			try {
				stmt = db.prepare(sql);

				// Execute the query with tracing to collect row-level events
				const results: Row[] = [];
				for await (const row of stmt.iterateRowsWithTrace(undefined, tracer)) {
					results.push(row); // We don't yield the results, just the trace events
				}

			} catch (executionError: unknown) {
				// If execution fails, we might still have some trace events
				const message = executionError instanceof Error ? executionError.message : String(executionError);
				log('Query execution failed during row tracing: %s', message);
			} finally {
				await stmt?.finalize();
			}

			// Get the collected trace events and filter for row events
			const traceEvents = tracer.getTraceEvents();
			const rowEvents = traceEvents.filter(event => event.type === 'row');

			// Group row events by instruction index to calculate row counts
			const rowsByInstruction = new Map<number, typeof rowEvents>();
			for (const event of rowEvents) {
				const instructionIndex = event.instructionIndex;
				if (!rowsByInstruction.has(instructionIndex)) {
					rowsByInstruction.set(instructionIndex, []);
				}
				rowsByInstruction.get(instructionIndex)!.push(event);
			}

			// Yield detailed information for each row
			for (const [instructionIndex, instructionRowEvents] of rowsByInstruction.entries()) {
				const totalRows = instructionRowEvents.length;

				for (let i = 0; i < instructionRowEvents.length; i++) {
					const event = instructionRowEvents[i];
					const isLastRow = i === instructionRowEvents.length - 1;

					yield [
						instructionIndex,                                                    // instruction_index
						event.note || 'Unknown',                                           // operation
						event.rowIndex ?? i,                                               // row_index
						safeJsonStringify(event.row),                                      // row_data
						event.timestamp,                                                    // timestamp_ms
						isLastRow ? totalRows : null                                       // row_count (only on last row)
					];
				}
			}

			// If no row events were captured, yield a summary row
			if (rowEvents.length === 0) {
				yield [
					0,                                            // instruction_index
					'NO_ROW_DATA',                               // operation
					0,                                           // row_index
					safeJsonStringify('No row-level trace events captured'), // row_data
					Date.now(),                                  // timestamp_ms
					0                                            // row_count
				];
			}

		} catch (error: unknown) {
			// If tracing setup fails, yield an error event
			yield [
				0,                                                        // instruction_index
				'ROW_TRACE_SETUP',                                       // operation
				0,                                                       // row_index
				safeJsonStringify(`Failed to setup row trace: ${error instanceof Error ? error.message : String(error)}`), // row_data
				Date.now(),                                              // timestamp_ms
				null                                                     // row_count
			];
		}
	}
);

// Schema size function (table-valued function)
export const schemaSizeFunc = createIntegratedTableValuedFunction(
	{
		name: 'schema_size',
		numArgs: 0,
		deterministic: false, // Schema can change
		returnType: {
			typeClass: 'relation',
			isReadOnly: true,
			isSet: false,
			columns: [
				{ name: 'object_type', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'object_name', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'estimated_rows', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'estimated_size_kb', type: { typeClass: 'scalar', logicalType: REAL_TYPE, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'column_count', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'index_count', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true }
			],
			keys: [],
			rowConstraints: []
		}
	},
	async function* (_db: Database, _sql: SqlValue): AsyncIterable<Row> {
		// TODO: Implementation of schemaSizeFunc
	}
);

// Effective-lens introspection: the composed read body + per-attribute
// provenance for a logical table (docs/lens.md § quereus_effective_lens).
export const effectiveLensFunc = createIntegratedTableValuedFunction(
	{
		name: 'quereus_effective_lens',
		numArgs: 2,
		deterministic: false, // Depends on current lens deployment state.
		returnType: {
			typeClass: 'relation',
			isReadOnly: true,
			isSet: false,
			columns: [
				{ name: 'logical_column', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'source', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				// The put disposition: 'authored' (a `with inverse` clause supplies the
				// put) · 'inferred' (registry invertibility / identity / passthrough) ·
				// 'none' (computed, read-only). docs/lens.md § quereus_effective_lens.
				{ name: 'inverse', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				// Advertisement-backed provenance: the member relationId of the resolved
				// primary-storage decomposition that backs this column, or NULL when the
				// column is name-match / override-only (docs/lens.md § The Default Mapper).
				{ name: 'advertised_member', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true },
				// The resolved decomposition's anchor relationId (= advertisement id), or
				// NULL when no advertisement backs this logical table.
				{ name: 'advertisement_anchor', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'effective_sql', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
			],
			keys: [],
			rowConstraints: [],
		},
	},
	async function* (db: Database, schemaArg: SqlValue, tableArg: SqlValue): AsyncIterable<Row> {
		if (typeof schemaArg !== 'string' || typeof tableArg !== 'string') {
			throw new QuereusError('quereus_effective_lens(schema, table) requires two string arguments', StatusCode.ERROR);
		}

		const schema = db.schemaManager.getSchema(schemaArg);
		if (!schema) {
			throw new QuereusError(`quereus_effective_lens: schema '${schemaArg}' not found`, StatusCode.NOTFOUND);
		}
		if (schema.kind !== 'logical') {
			throw new QuereusError(`quereus_effective_lens: schema '${schemaArg}' is not a logical schema`, StatusCode.ERROR);
		}
		const slot = schema.getLensSlot(tableArg);
		if (!slot) {
			throw new QuereusError(`quereus_effective_lens: no lens slot for '${schemaArg}.${tableArg}'`, StatusCode.NOTFOUND);
		}

		// Repeat the composed body on every row (symmetry with query_plan), so a
		// single SELECT surfaces both the per-column provenance and the SQL. The
		// advertisement columns surface the resolved decomposition (if any) that
		// backs each logical column — additive to the existing provenance rows.
		const effectiveSql = astToString(slot.compiledBody);
		const anchor = slot.advertisement?.storage?.anchorRelationId ?? null;
		const inverse = lensInverseDispositions(db, slot);
		for (let i = 0; i < slot.columnProvenance.length; i++) {
			const p = slot.columnProvenance[i];
			yield [p.logicalColumn, p.source, inverse[i] ?? 'none', p.advertisedBy ?? null, anchor, effectiveSql];
		}
	}
);

/**
 * Per-logical-column put disposition for `quereus_effective_lens` — `'authored'`
 * (a `with inverse` clause supplies the put) / `'inferred'` (an identity,
 * passthrough, or registry-inverted base write path — including an optional
 * member's null-extended base column, whose put the fan-out materializes) /
 * `'none'` (computed, read-only). Read off the **logically** planned body's
 * backward `updateLineage` (the same surface `column_info` reads, planned via
 * `_buildPlan` for the same lineage-preservation reason), positionally aligned
 * with the slot's column provenance — the compiled body's output columns are
 * the logical columns in declaration order. A body that fails to plan degrades
 * every column to `'none'` rather than failing the TVF.
 */
function lensInverseDispositions(db: Database, slot: LensSlot): string[] {
	try {
		const { plan } = db._buildPlan([slot.compiledBody as AST.Statement]);
		const root = plan.getRelations()[0];
		if (!root) return slot.columnProvenance.map(() => 'none');
		const lineage = root.physical?.updateLineage;
		const attrs = root.getAttributes();
		return slot.columnProvenance.map((_p, i) => {
			const attr = attrs[i];
			const site = resolveBaseSite(attr ? lineage?.get(attr.id) : undefined);
			if (site.authored) return 'authored';
			if (site.baseColumn !== undefined) return 'inferred';
			return 'none';
		});
	} catch (e) {
		log('quereus_effective_lens: lens body failed to plan for inverse dispositions, reporting none: %O', e);
		return slot.columnProvenance.map(() => 'none');
	}
}

// Basis re-decomposition backfill introspection: per-new-basis-relation backfill
// DDL the engine generates for a pure re-decomposition, tagged engine-generated
// vs app-supplied (docs/lens.md § The deployed basis representation).
//
// Sequencing contract (the generated SQL reads the PRIOR get-body over the PRIOR
// basis tables, which must still hold data when the app runs it):
//   1. apply schema Y — migrate the basis (new members created; prior members
//      retained, not dropped — they are the backfill source).
//   2. apply schema X — recompile the lens (rotates the snapshot; `previous` now
//      holds the prior get-body).
//   3. select * from quereus_basis_backfill('x') — run the re-decomposition /
//      partial `backfill_sql`; supply app data for missing / needs-data rows.
//   4. GC the now-detached prior basis members when convenient (out of scope).
export const basisBackfillFunc = createIntegratedTableValuedFunction(
	{
		name: 'quereus_basis_backfill',
		numArgs: 1,
		deterministic: false, // Depends on the rotated deployment-snapshot pair.
		returnType: {
			typeClass: 'relation',
			isReadOnly: true,
			isSet: false,
			columns: [
				{ name: 'logical_table', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'basis_relation', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				// 're-decomposition' | 'partial' | 'needs-data'
				{ name: 'category', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				// The generated insert…select…from(<prior get>); NULL when needs-data.
				{ name: 'backfill_sql', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true },
				// Comma-joined basis columns the engine backfills.
				{ name: 'generated_columns', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				// Comma-joined basis columns the application must supply (empty for re-decomposition).
				{ name: 'missing_columns', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'reason', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
			],
			keys: [],
			rowConstraints: [],
		},
	},
	async function* (db: Database, schemaArg: SqlValue): AsyncIterable<Row> {
		if (typeof schemaArg !== 'string') {
			throw new QuereusError('quereus_basis_backfill(logical_schema) requires a string argument', StatusCode.ERROR);
		}

		const schema = db.schemaManager.getSchema(schemaArg);
		if (!schema) {
			throw new QuereusError(`quereus_basis_backfill: schema '${schemaArg}' not found`, StatusCode.NOTFOUND);
		}
		if (schema.kind !== 'logical') {
			throw new QuereusError(`quereus_basis_backfill: schema '${schemaArg}' is not a logical schema`, StatusCode.ERROR);
		}

		// The rotated snapshot pair is the source of truth — robust to the lens
		// already pointing at the new basis. With no `previous` (a first deploy, or
		// nothing deployed) there is nothing to backfill.
		const snaps = db.declaredSchemaManager.getDeployedLensSnapshots(schemaArg);
		if (!snaps?.previous || !snaps.current) return;

		// Recompute the live basis hash so a basis that drifted out-of-band since
		// the last lens deploy surfaces as a per-row warning rather than silently
		// generating a stale backfill.
		const basisDeclared = snaps.current.basisSchemaName
			? db.declaredSchemaManager.getDeclaredSchema(snaps.current.basisSchemaName)
			: undefined;
		const liveBasisHash = basisDeclared ? computeSchemaHash(basisDeclared) : undefined;

		const rows = computeBasisBackfill(snaps.previous, snaps.current, liveBasisHash);
		for (const r of rows) {
			yield [
				r.logicalTable,
				r.basisRelation,
				r.category,
				r.backfillSql,
				r.generatedColumns.join(', '),
				r.missingColumns.join(', '),
				r.reason,
			];
		}
	}
);

// Lens advisory governance introspection: the **expand** path for the deploy
// summary's `acknowledged: N` tally (docs/lens-prover.md § Acknowledging advisories).
// One row per advisory of the last deploy of a logical schema — active ones, the
// ones an in-source `quereus.lens.ack.<code>` tag suppressed, and any that
// re-surfaced because their recorded fingerprint no longer matches.
export const lensAdvisoriesFunc = createIntegratedTableValuedFunction(
	{
		name: 'quereus_lens_advisories',
		numArgs: 1,
		deterministic: false, // Depends on the current lens deploy report.
		returnType: {
			typeClass: 'relation',
			isReadOnly: true,
			isSet: false,
			columns: [
				{ name: 'logical_table', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'code', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'constraint', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'column', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true },
				// 'active' | 're-surfaced' | 'acknowledged' | 'acknowledged-unconditional'
				{ name: 'status', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'rationale', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'current_fingerprint', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'recorded_fingerprint', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'message', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
			],
			keys: [],
			rowConstraints: [],
		},
	},
	async function* (db: Database, schemaArg: SqlValue): AsyncIterable<Row> {
		if (typeof schemaArg !== 'string') {
			throw new QuereusError('quereus_lens_advisories(logical_schema) requires a string argument', StatusCode.ERROR);
		}
		const schema = db.schemaManager.getSchema(schemaArg);
		if (!schema) {
			throw new QuereusError(`quereus_lens_advisories: schema '${schemaArg}' not found`, StatusCode.NOTFOUND);
		}
		if (schema.kind !== 'logical') {
			throw new QuereusError(`quereus_lens_advisories: schema '${schemaArg}' is not a logical schema`, StatusCode.ERROR);
		}
		const report = db.declaredSchemaManager.getDeployedLensReport(schemaArg);
		if (!report) return; // never deployed (or a blocked deploy left no report)

		// Default-report rows (un-acknowledged + re-surfaced), then the expanded
		// acknowledged ones. Each row is grouped by its logical table + code.
		for (const w of report.warnings) {
			yield [
				w.site.table, w.code, w.site.constraint ?? null, w.site.column ?? null,
				w.resurfaced ? 're-surfaced' : 'active', null, null, null, w.message,
			];
		}
		for (const a of report.acknowledged) {
			yield [
				a.site.table, a.code, a.site.constraint ?? null, a.site.column ?? null,
				a.unconditional ? 'acknowledged-unconditional' : 'acknowledged',
				a.rationale, a.currentFingerprint, a.recordedFingerprint ?? null, a.message,
			];
		}
	}
);

// Explain assertion analysis and prepared parameterization (pre-physical)
export const explainAssertionFunc = createIntegratedTableValuedFunction(
	{
		name: 'explain_assertion',
		numArgs: 1,
		deterministic: true,
		returnType: {
			typeClass: 'relation',
			isReadOnly: true,
			isSet: false,
			columns: [
				{ name: 'assertion', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'relation_key', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'base', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'classification', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'prepared_pk_params', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true }, // JSON array of param names or NULL
				{ name: 'violation_sql', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true }
			],
			keys: [],
			rowConstraints: []
		}
	},
	async function* (db: Database, assertionName: SqlValue): AsyncIterable<Row> {
		if (typeof assertionName !== 'string') {
			throw new QuereusError('explain_assertion(name) requires an assertion name', StatusCode.ERROR);
		}

		// Accept `schema.name` (schema-scoped lookup) or a bare name (find-first
		// across all schemas — assertion names are only unique per schema).
		const all = db.schemaManager.getAllAssertions();
		const dot = assertionName.indexOf('.');
		const wantedSchema = dot >= 0 ? assertionName.slice(0, dot).toLowerCase() : undefined;
		const wantedName = (dot >= 0 ? assertionName.slice(dot + 1) : assertionName).toLowerCase();
		const assertion = all.find(a =>
			a.name.toLowerCase() === wantedName
			&& (wantedSchema === undefined || a.schemaName.toLowerCase() === wantedSchema));
		if (!assertion) {
			throw new QuereusError(`Assertion not found: ${assertionName}`, StatusCode.NOTFOUND);
		}

		const sql = assertion.violationSql;

		// Build pre-physical plan for analysis
		let ast: AST.Statement;
		try {
			const parser = new Parser();
			ast = parser.parse(sql) as AST.Statement;
		} catch (e) {
			throw new QuereusError(`Failed to parse assertion SQL: ${(e as Error).message}`, StatusCode.ERROR, e as Error);
		}

		// The shared recipe: home-schema path (the stored body resolves unqualified
		// names against the assertion's own schema, same as commit-time
		// enforcement), analysis stage, and hoist suppression — without the last, a
		// canonical-shaped assertion's own hoisted facts fold its violation query to
		// empty and the explain shows no classifications at all.
		const analyzed = planAssertionBodyForAnalysis(
			db, ast, assertion.schemaName) as unknown as RelationalPlanNode;

		// Classify each table reference as row/group/global.
		const { classifications, groupKeys } = analyzeRowSpecific(analyzed);

		for (const [relationKey, cls] of classifications) {
			const base = relationKeyBase(relationKey);
			let prepared: string | null = null;
			if (base) {
				const [schemaName, tableName] = splitBaseKey(base);
				const table = db._findTable(tableName, schemaName);
				if (table) {
					if (cls === 'row') {
						// Prepared parameters are PK-based: ["pk0", "pk1", ...]
						const pkCount = table.primaryKeyDefinition.length;
						const names = Array.from({ length: pkCount }, (_, i) => `pk${i}`);
						prepared = JSON.stringify(names);
					} else if (cls === 'group') {
						// Prepared parameters are the group key column names on this table.
						const cols = groupKeys.get(relationKey) ?? [];
						const names = cols.map(idx => table.columns[idx]?.name ?? `col${idx}`);
						prepared = JSON.stringify(names);
					}
				}
			}

			yield [
				assertion.name,
				relationKey,
				base,
				cls,
				prepared,
				sql
			];
		}
	}
);

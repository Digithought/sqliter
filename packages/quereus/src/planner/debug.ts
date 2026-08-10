import type { PlanNode } from './nodes/plan-node.js';
import { isRelationalNode } from './nodes/plan-node.js';
import { safeJsonStringify } from '../util/serialization.js';
import { astToString } from '../emit/ast-stringify.js';
import type { Instruction, InstructionTracer } from '../runtime/types.js';
import type { Scheduler } from '../runtime/scheduler.js';
import type * as AST from '../parser/ast.js';
import { quereusError } from '../common/errors.js';
import { StatusCode } from '../common/types.js';
import type { BaseType } from '../common/datatype.js';

/**
 * Detailed information about a PlanNode for debugging purposes.
 */
export interface PlanNodeDebugInfo {
  id: string;
  nodeType: string;
  type: BaseType; // The result of getType()
  estimatedCost: number;
  estimatedRows?: number;
  totalCost: number;
  children: PlanNodeDebugInfo[];
  relations: PlanNodeDebugInfo[];
  properties: Record<string, unknown>; // Node-specific properties
}

/**
 * Information about an instruction in the execution program.
 */
export interface InstructionDebugInfo {
  index: number;
  note?: string;
  paramCount: number;
  paramIndices: number[];
  destination: number | null;
  subPrograms?: SubProgramDebugInfo[];
}

/**
 * Information about a sub-program for debugging purposes.
 */
export interface SubProgramDebugInfo {
  programIndex: number;
  instructionCount: number;
  rootNote?: string;
  instructions: InstructionDebugInfo[];
}

/**
 * Checks if a value is an AST node
 */
function isAstNode(value: unknown): value is AST.AstNode {
	return !!value && typeof value === 'object' && 'type' in value && typeof (value as { type: unknown }).type === 'string';
}

/**
 * Recursively processes a value, converting AST nodes to SQL strings
 */
function processValue(value: unknown): unknown {
	if (value === null || value === undefined) {
		return value;
	}

	// If it's an AST node, convert to SQL string
	if (isAstNode(value)) {
		try {
			return astToString(value);
		} catch {
			return `[AST:${value.type}]`; // Fallback if stringify fails
		}
	}

	// If it's an array, process each element
	if (Array.isArray(value)) {
		return value.map(processValue);
	}

	// If it's an object, process each property
	if (typeof value === 'object') {
		// Skip circular references and complex objects
		if (value.constructor !== Object && value.constructor !== Array) {
			return '[COMPLEX_OBJECT]';
		}

		const processed: Record<string, unknown> = {};
		for (const [key, val] of Object.entries(value)) {
			try {
				processed[key] = processValue(val);
			} catch {
				processed[key] = '[UNPROCESSABLE]';
			}
		}
		return processed;
	}

	// For primitives, return as-is
	return value;
}

/**
 * Serializes a PlanNode tree to a detailed JSON representation using the existing visit pattern.
 */
export function serializePlanTree(rootNode: PlanNode): string {
	const nodeMap = new Map<PlanNode, PlanNodeDebugInfo>();

	// First pass: collect all nodes using the visit pattern
	rootNode.visit((node) => {
		if (!nodeMap.has(node)) {
			// Get node-specific properties by examining the node object
			const properties: Record<string, unknown> = {};

			// Extract interesting properties from the node (excluding functions and circular refs)
			for (const [key, value] of Object.entries(node)) {
				if (key === 'scope' || key === 'id' || key === 'nodeType' || key === 'estimatedCost') {
					continue; // Skip these as they're handled separately
				}

				if (typeof value === 'function') {
					continue; // Skip functions
				}

				if (value && typeof value === 'object' && 'nodeType' in value) {
					// This is likely another PlanNode, skip to avoid duplication
					continue;
				}

				try {
					// Process the property value, converting AST nodes to SQL strings
					properties[key] = processValue(value);
				} catch {
					properties[key] = '[UNSERIALIZABLE]';
				}
			}

			nodeMap.set(node, {
				id: node.id,
				nodeType: node.nodeType,
				type: node.getType(),
				estimatedCost: node.estimatedCost,
				estimatedRows: isRelationalNode(node) ? node.estimatedRows : undefined,
				totalCost: node.getTotalCost(),
				children: [], // Will be filled in second pass
				relations: [], // Will be filled in second pass
				properties
			});
		}
	});

	// Second pass: establish relationships
	for (const [node, info] of nodeMap) {
		info.children = node.getChildren()
			.map(child => nodeMap.get(child))
			.filter(Boolean) as PlanNodeDebugInfo[];

		info.relations = node.getRelations()
			.map(relation => nodeMap.get(relation))
			.filter(Boolean) as PlanNodeDebugInfo[];
	}

	const rootInfo = nodeMap.get(rootNode);
	if (!rootInfo) {
		quereusError('Root node not found in serialization map', StatusCode.INTERNAL);
	}

	return safeJsonStringify(rootInfo, 2);
}

/**
 * Generates a human-readable program listing of instructions.
 */
export function generateInstructionProgram(
  instructions: readonly Instruction[],
  destinations: readonly (number | null)[]
): string {
  const lines: string[] = [];
  lines.push('=== INSTRUCTION PROGRAM ===');
  lines.push('');

  const subProgramMap = new Map<number, { scheduler: Scheduler; parentIndex: number }>();
  let nextSubProgramId = 0;

  for (let i = 0; i < instructions.length; i++) {
    const instruction = instructions[i];
    const dest = destinations[i];
    const note = instruction.note ? ` ; ${instruction.note}` : '';
    const destStr = dest !== null ? ` -> [${dest}]` : ' -> [RESULT]';

    let subProgramInfo = '';
    if (instruction.programs && instruction.programs.length > 0) {
      const programIds: number[] = [];
      for (const program of instruction.programs) {
        const programId = nextSubProgramId++;
        subProgramMap.set(programId, { scheduler: program, parentIndex: i });
        programIds.push(programId);
      }
      subProgramInfo = ` SUB-PROGRAMS: [${programIds.join(', ')}]`;
    }

    lines.push(`[${i.toString().padStart(3)}] PARAMS: [${instruction.params.map((_, idx) =>
      instructions.findIndex(inst => inst === instruction.params[idx])
    ).join(', ')}]${destStr}${note}${subProgramInfo}`);
  }

  // Add sub-program listings
  if (subProgramMap.size > 0) {
    lines.push('');
    lines.push('=== SUB-PROGRAMS ===');

    for (const [programId, { scheduler, parentIndex }] of subProgramMap) {
      lines.push('');
      lines.push(`--- SUB-PROGRAM ${programId} (called by instruction ${parentIndex}) ---`);
      const subProgram = generateInstructionProgram(scheduler.instructions, scheduler.destinations);
      // Remove the header and footer from sub-program and indent
      const subLines = subProgram.split('\n').slice(2, -2);
      for (const line of subLines) {
        if (line.trim()) {
          lines.push(`  ${line}`);
        }
      }
    }
  }

  lines.push('');
  lines.push('=== END PROGRAM ===');
  return lines.join('\n');
}

/**
 * Extracts detailed information about the instruction program structure.
 */
export function getInstructionDebugInfo(
  instructions: readonly Instruction[],
  destinations: readonly (number | null)[]
): InstructionDebugInfo[] {
  let nextSubProgramId = 0;

  return instructions.map((instruction, index) => {
    let subPrograms: SubProgramDebugInfo[] | undefined;

    if (instruction.programs && instruction.programs.length > 0) {
      subPrograms = instruction.programs.map(scheduler => {
        const programId = nextSubProgramId++;
        const subInstructions = getInstructionDebugInfo(scheduler.instructions, scheduler.destinations);

        return {
          programIndex: programId,
          instructionCount: scheduler.instructions.length,
          rootNote: scheduler.instructions[scheduler.instructions.length - 1]?.note,
          instructions: subInstructions
        };
      });
    }

    return {
      index,
      note: instruction.note,
      paramCount: instruction.params.length,
      paramIndices: instruction.params.map(param =>
        instructions.findIndex(inst => inst === param)
      ),
      destination: destinations[index],
      subPrograms
    };
  });
}

/**
 * Generates a comprehensive trace report that includes sub-program execution details.
 */
export function generateTraceReport(
  tracer: InstructionTracer
): string {
  const events = tracer.getTraceEvents?.() || [];
  const subPrograms = tracer.getSubPrograms?.() || new Map();

  const lines: string[] = [];
  lines.push('=== EXECUTION TRACE ===');
  lines.push('');

  for (const event of events) {
    const timestamp = new Date(event.timestamp).toISOString();
    const typeStr = event.type.toUpperCase().padEnd(6);
    const note = event.note ? ` (${event.note})` : '';

    lines.push(`[${event.instructionIndex.toString().padStart(3)}] ${typeStr} ${timestamp}${note}`);

    if (event.type === 'input' && event.subPrograms) {
      for (const subProgram of event.subPrograms) {
        lines.push(`     └─ SUB-PROGRAM ${subProgram.programIndex}: ${subProgram.instructionCount} instructions${subProgram.rootNote ? ` (${subProgram.rootNote})` : ''}`);
      }
    }

    if (event.type === 'error') {
      lines.push(`     ERROR: ${event.error}`);
    }
  }

  if (subPrograms.size > 0) {
    lines.push('');
    lines.push('=== SUB-PROGRAM DETAILS ===');

    for (const [programId, { scheduler, parentInstructionIndex }] of subPrograms) {
      lines.push('');
      lines.push(`--- SUB-PROGRAM ${programId} (parent instruction: ${parentInstructionIndex}) ---`);
      const programListing = generateInstructionProgram(scheduler.instructions, scheduler.destinations);
      // Remove header/footer and indent
      const programLines = programListing.split('\n').slice(2, -2);
      for (const line of programLines) {
        if (line.trim()) {
          lines.push(`  ${line}`);
        }
      }
    }
  }

  lines.push('');
  lines.push('=== END TRACE ===');
  return lines.join('\n');
}

/**
 * Options for plan formatting
 */
export interface PlanDisplayOptions {
	/** Show concise plan by default (true) or full details (false) */
	concise?: boolean;
	/** Node IDs to expand with full details (only applies when concise=true) */
	expandNodes?: string[];
	/** Maximum depth to display (default: no limit) */
	maxDepth?: number;
	/** Show physical properties if available */
	showPhysical?: boolean;
}

/**
 * Creates a concise, tree-like representation of the plan
 */
export function formatPlanTree(rootNode: PlanNode, options: PlanDisplayOptions = {}): string {
	const { concise = true, expandNodes = [], maxDepth, showPhysical = true } = options;
	const lines: string[] = [];
	const nodesSeen = new Set<PlanNode>();

	// NOTE: recursive tree-walk (also formatPlanSummary/collectPath below). Unlike
	// the read-time accessors (physical/getTotalCost/visit), this is diagnostic-only
	// (EXPLAIN / plan display), so a deep plan is not on the query hot path. If plan
	// formatting ever needs to run on arbitrarily deep plans, convert to an explicit
	// worklist like PlanNode.computePostOrder / visit.
	function formatNode(node: PlanNode, depth: number, isLast: boolean, prefix: string): void {
		if (maxDepth !== undefined && depth > maxDepth) {
			return;
		}

		// Avoid infinite recursion for circular references
		if (nodesSeen.has(node)) {
			lines.push(`${prefix}├─ [CIRCULAR: ${node.nodeType}#${node.id}]`);
			return;
		}
		nodesSeen.add(node);

		// Determine if this node should be expanded
		const shouldExpand = !concise || expandNodes.includes(node.id);

		// Node header with connection lines
		const connector = isLast ? '└─ ' : '├─ ';
		const nodeType = node.nodeType;
		const nodeId = `#${node.id}`;
		const description = node.toString();

		// Build the header line
		let headerLine = `${prefix}${connector}${nodeType}${nodeId}`;
		if (description && description !== nodeType) {
			headerLine += `: ${description}`;
		}

		// Add cost information if available
		const cost = node.estimatedCost;
		const totalCost = node.getTotalCost();
		if (cost > 0 || totalCost > 0) {
			headerLine += ` [cost: ${cost}, total: ${totalCost}]`;
		}

		// Add physical properties if requested and available
		if (showPhysical && node.physical) {
			const physical = node.physical;
			const physicalInfo = [];
			if (physical.estimatedRows !== undefined) {
				physicalInfo.push(`rows: ${physical.estimatedRows}`);
			}
			if (physical.ordering && physical.ordering.length > 0) {
				physicalInfo.push(`ordered: ${physical.ordering.map(o => `${o.column}${o.desc ? ' desc' : ' asc'}`).join(',')}`);
			}
			if (physical.readonly !== undefined) {
				physicalInfo.push(`readonly: ${physical.readonly}`);
			}
			if (physicalInfo.length > 0) {
				headerLine += ` {${physicalInfo.join(', ')}}`;
			}
		}

		lines.push(headerLine);

		// Add expanded details if requested
		if (shouldExpand) {
			const logical = node.getLogicalAttributes();
			if (logical && Object.keys(logical).length > 0) {
				const logicalLines = JSON.stringify(logical, null, 2).split('\n');
				const extendedPrefix = prefix + (isLast ? '    ' : '│   ');
				lines.push(`${extendedPrefix}┌─ Logical Attributes:`);
				for (let i = 0; i < logicalLines.length; i++) {
					const line = logicalLines[i];
					const isLastLogicalLine = i === logicalLines.length - 1;
					const logicalConnector = isLastLogicalLine ? '└─ ' : '│  ';
					lines.push(`${extendedPrefix}${logicalConnector}${line}`);
				}
			}
		}

		// Process children
		const children = node.getChildren();
		const relations = node.getRelations();
		const allChildren = [...children, ...relations];

		// Filter out duplicates (in case a child is both a child and relation)
		const uniqueChildren = Array.from(new Set(allChildren));

		for (let i = 0; i < uniqueChildren.length; i++) {
			const child = uniqueChildren[i];
			const isLastChild = i === uniqueChildren.length - 1;
			const childPrefix = prefix + (isLast ? '    ' : '│   ');
			formatNode(child, depth + 1, isLastChild, childPrefix);
		}

		nodesSeen.delete(node);
	}

	lines.push('Query Plan:');
	formatNode(rootNode, 0, true, '');

	// Add help text
	if (concise && expandNodes.length === 0) {
		lines.push('');
		lines.push('Tip: Use --expand-nodes node1,node2,... to see detailed properties for specific nodes');
	}

	return lines.join('\n');
}

/**
 * Generates a compact plan summary showing just the execution path
 */
export function formatPlanSummary(rootNode: PlanNode): string {
	const path: string[] = [];
	const visited = new Set<PlanNode>();

	function collectPath(node: PlanNode): void {
		if (visited.has(node)) return;
		visited.add(node);

		const description = node.toString();
		const nodeInfo = description && description !== node.nodeType
			? `${node.nodeType}(${description})`
			: node.nodeType;

		path.push(nodeInfo);

		// Follow the main execution path (first child for most nodes)
		const children = node.getChildren();
		if (children.length > 0) {
			collectPath(children[0]);
		}
	}

	collectPath(rootNode);
	return `Execution Path: ${path.join(' → ')}`;
}

/**
 * Enhanced plan serialization with formatting options
 */
export function serializePlanTreeWithOptions(rootNode: PlanNode, options: PlanDisplayOptions = {}): string {
	if (options.concise !== false) {
		return formatPlanTree(rootNode, options);
	} else {
		// Use the existing detailed serialization
		return serializePlanTree(rootNode);
	}
}

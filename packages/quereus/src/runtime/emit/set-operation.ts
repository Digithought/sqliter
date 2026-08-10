import type { SetOperationNode } from '../../planner/nodes/set-operation-node.js';
import type { Instruction, RuntimeContext, InstructionRun } from '../types.js';
import { asRun } from '../types.js';
import type { EmissionContext } from '../emission-context.js';
import { emitPlanNode } from '../emitters.js';
import type { Row } from '../../common/types.js';
import { BTree } from 'inheritree';
import { createSemanticRowComparator, BINARY_COLLATION } from '../../util/comparison.js';

export function emitSetOperation(plan: SetOperationNode, ctx: EmissionContext): Instruction {
  const leftInst = emitPlanNode(plan.left, ctx);
  const rightInst = emitPlanNode(plan.right, ctx);

  // Pre-resolve the row-identity comparator (safe for mixed-type rows in set
  // operations). The comparator runs over the DATA columns only — membership flags
  // are appended after, but dedup / probe identity is on data columns alone, so set
  // identity is never perturbed by the flags. Columns whose merged output type has
  // semantic ordering (TIMESPAN, JSON) compare through the type's compare so set
  // identity agrees with `=` (see createSemanticRowComparator).
  //
  // Each data column's collation is the CROSS-INPUT resolved collation: `SetOperationNode`
  // merges both operands' column types through the shared comparison lattice and writes
  // the result into the output attribute/column types (`set-operation-cross-input-collation-merge`).
  // This emitter reads `attr.type.collationName` verbatim, so dedup/membership and an
  // enclosing ORDER BY (which keys off the same output-column collation) stay in lockstep —
  // the node is the single resolution site; do NOT re-resolve here.
  const attributes = plan.getAttributes();
  // DATA arity is recursive (`plan.dataColumnCount()`), NOT `plan.left.getType().columns.length`
  // — a flagged inner set-op operand on the left would over-count by its surfaced flags.
  const dataColCount = plan.dataColumnCount();
  const dataAttributes = attributes.slice(0, dataColCount);
  const dataComparator = createSemanticRowComparator(
    dataAttributes.map(attr => attr.type.logicalType),
    dataAttributes.map(attr => attr.type.collationName ? ctx.resolveCollation(attr.type.collationName) : BINARY_COLLATION)
  );

  // Helper function to create a properly structured DATA row (flags excluded; the
  // membership runner appends them after the operator produces its rows).
  function createOutputRow(inputRow: Row): Row {
    const outputRow: Row = [];
    for (let i = 0; i < dataColCount; i++) {
      outputRow[i] = inputRow[i]; // Map by position since columns should align
    }
    return outputRow;
  }

  async function* runUnionAll(rctx: RuntimeContext, leftRows: AsyncIterable<Row>, rightRows: AsyncIterable<Row>): AsyncIterable<Row> {
    // Process left rows - let SortNode handle row context
    for await (const row of leftRows) {
      yield createOutputRow(row);
    }

    // Process right rows - let SortNode handle row context
    for await (const row of rightRows) {
      yield createOutputRow(row);
    }
  }

  async function* runUnionDistinct(rctx: RuntimeContext, leftRows: AsyncIterable<Row>, rightRows: AsyncIterable<Row>): AsyncIterable<Row> {
    // Use BTree for proper SQL value comparison instead of JSON.stringify
    const distinctTree = new BTree<Row, Row>(
      (row: Row) => row,
      dataComparator
    );

    for await (const row of leftRows) {
      const outputRow = createOutputRow(row);
      const newPath = distinctTree.insert(outputRow);
      if (newPath.on) {
        // This is a new distinct row
        yield outputRow; // Let SortNode handle row context
      }
    }
    for await (const row of rightRows) {
      const outputRow = createOutputRow(row);
      const newPath = distinctTree.insert(outputRow);
      if (newPath.on) {
        // This is a new distinct row
        yield outputRow; // Let SortNode handle row context
      }
    }
  }

  async function* runIntersect(rctx: RuntimeContext, leftRows: AsyncIterable<Row>, rightRows: AsyncIterable<Row>): AsyncIterable<Row> {
    // Use BTree for proper SQL value comparison
    const leftTree = new BTree<Row, Row>(
      (row: Row) => row,
      dataComparator
    );

    // Build left set
    for await (const row of leftRows) {
      const outputRow = createOutputRow(row);
      leftTree.insert(outputRow);
    }

    // Check right rows against left set
    const yielded = new BTree<Row, Row>(
      (row: Row) => row,
      dataComparator
    );

    for await (const row of rightRows) {
      const outputRow = createOutputRow(row);
      const leftPath = leftTree.find(outputRow);
      if (leftPath.on) {
        // This row exists in left set - yield the LEFT row to preserve left-side types
        const leftRow = leftTree.get(outputRow)!;
        const yieldedPath = yielded.insert(leftRow);
        if (yieldedPath.on) {
          // Haven't yielded this row yet (handles duplicates in right)
          yield leftRow; // Let SortNode handle row context
        }
      }
    }
  }

  async function* runExcept(rctx: RuntimeContext, leftRows: AsyncIterable<Row>, rightRows: AsyncIterable<Row>): AsyncIterable<Row> {
    // Use BTree for proper SQL value comparison
    const rightTree = new BTree<Row, Row>(
      (row: Row) => row,
      dataComparator
    );
    const leftRowsArray: Row[] = [];

    // Collect left rows
    for await (const row of leftRows) {
      leftRowsArray.push(createOutputRow(row));
    }

    // Build right set
    for await (const row of rightRows) {
      rightTree.insert(createOutputRow(row));
    }

    // Track already-yielded rows to deduplicate (EXCEPT returns distinct rows)
    const yielded = new BTree<Row, Row>(
      (row: Row) => row,
      dataComparator
    );

    // Yield left rows that are not in right set
    for (const outputRow of leftRowsArray) {
      const rightPath = rightTree.find(outputRow);
      if (!rightPath.on) {
        const yieldedPath = yielded.insert(outputRow);
        if (yieldedPath.on) {
          yield outputRow; // Let SortNode handle row context
        }
      }
    }
  }

  // Surfaced-flag runner (`<setop> exists <branch> as <name>`, read half — generalized
  // to nestable flagged set-ops, `nestable-flagged-set-ops`). Selected whenever the node
  // surfaces ANY flag — its own membership flags OR an operand's flags (a flag-less outer
  // over a flagged operand still surfaces the inner flags). Buffers each operand's FULL
  // row (so the operand's flag columns survive), keys the probe sets on the DATA columns
  // (storing the full row), and produces each output row under the projection rule
  // `[data] ++ [L flags] ++ [R flags] ++ [own flags]`:
  //   - L / R flags: if the data tuple is present in that operand, the stored operand
  //     row's flag slice; else `false × <flag count>` (sound — an output row absent from
  //     an operand is in none of its nested branches, so every such flag is false).
  //   - own flags: the per-spec probe `data ∈ <branch set>` → boolean.
  // Dedup / multiplicity is still decided on data columns only, so set identity is
  // unchanged by the flags. A surfaced inner flag thus equals `tuple ∈ <that inner
  // branch's data relation>` row-by-row at every depth.
  async function* runWithSurfacedFlags(_rctx: RuntimeContext, leftRows: AsyncIterable<Row>, rightRows: AsyncIterable<Row>): AsyncIterable<Row> {
    const membership = plan.membership ?? [];
    const leftFlagCount = plan.left.getType().columns.length - dataColCount;
    const rightFlagCount = plan.right.getType().columns.length - dataColCount;
    // Probe sets keyed on the DATA columns (dataComparator), each storing the FULL
    // operand row so its surfaced flag slice survives.
    const leftSet = new BTree<Row, Row>((row: Row) => row, dataComparator);
    const rightSet = new BTree<Row, Row>((row: Row) => row, dataComparator);
    const leftBuf: Row[] = [];
    const rightBuf: Row[] = [];

    for await (const row of leftRows) { leftBuf.push(row); leftSet.insert(row); }
    for await (const row of rightRows) { rightBuf.push(row); rightSet.insert(row); }

    // An operand's surfaced flags for a data tuple: the stored full row's flag slice when
    // present, else default-false (each flag = `tuple ∈ <nested branch>`, false when the
    // tuple is absent from the operand). Flag values are a function of the data tuple, so
    // the first stored row's slice is canonical even under a bag operand.
    const leftFlagsFor = (data: Row): Row => {
      if (leftFlagCount === 0) return [];
      const stored = leftSet.get(data);
      return stored ? stored.slice(dataColCount, dataColCount + leftFlagCount) : Array.from({ length: leftFlagCount }, () => false);
    };
    const rightFlagsFor = (data: Row): Row => {
      if (rightFlagCount === 0) return [];
      const stored = rightSet.get(data);
      return stored ? stored.slice(dataColCount, dataColCount + rightFlagCount) : Array.from({ length: rightFlagCount }, () => false);
    };
    const ownFlagsFor = (data: Row): Row =>
      membership.map(spec => ((spec.branch === 'left' ? leftSet : rightSet).find(data).on ? true : false));

    // [data] ++ [L flags] ++ [R flags] ++ [own flags].
    const surface = (data: Row): Row => [...data, ...leftFlagsFor(data), ...rightFlagsFor(data), ...ownFlagsFor(data)];

    if (plan.op === 'unionAll') {
      // Bag: preserve multiplicity — every input row yields one output row.
      for (const row of leftBuf) yield surface(createOutputRow(row));
      for (const row of rightBuf) yield surface(createOutputRow(row));
      return;
    }

    // Distinct operators: dedup the output on DATA columns only.
    const yielded = new BTree<Row, Row>((row: Row) => row, dataComparator);
    switch (plan.op) {
      case 'union': {
        for (const row of leftBuf) { const d = createOutputRow(row); if (yielded.insert(d).on) yield surface(d); }
        for (const row of rightBuf) { const d = createOutputRow(row); if (yielded.insert(d).on) yield surface(d); }
        break;
      }
      case 'intersect': {
        // Rows present in BOTH branches (deduped). Own flags all probe true; an R flag
        // reads the stored right row's slice (the tuple is in the right operand).
        for (const row of leftBuf) {
          const d = createOutputRow(row);
          if (rightSet.find(d).on && yielded.insert(d).on) yield surface(d);
        }
        break;
      }
      case 'except': {
        // Rows in left and NOT in right (deduped). Own flags: left true, right false; an
        // R flag defaults false (the tuple is absent from the right operand).
        for (const row of leftBuf) {
          const d = createOutputRow(row);
          if (!rightSet.find(d).on && yielded.insert(d).on) yield surface(d);
        }
        break;
      }
    }
  }

  let run: InstructionRun;
  if (plan.hasSurfacedFlags) {
    run = asRun(runWithSurfacedFlags);
  } else {
    switch (plan.op) {
      case 'unionAll':
        run = asRun(runUnionAll);
        break;
      case 'union':
        run = asRun(runUnionDistinct);
        break;
      case 'intersect':
        run = asRun(runIntersect);
        break;
      case 'except':
        run = asRun(runExcept);
        break;
    }
  }

  return {
    params: [leftInst, rightInst],
    run,
    note: plan.op
  };
}

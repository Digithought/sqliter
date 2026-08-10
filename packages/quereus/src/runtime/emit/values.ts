import type { ValuesNode } from '../../planner/nodes/values-node.js';
import type { SingleRowNode } from '../../planner/nodes/single-row.js';
import type { TableLiteralNode } from '../../planner/nodes/values-node.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { asRun } from '../types.js';
import { emitPlanNode } from '../emitters.js';
import { type SqlValue, type Row, StatusCode } from '../../common/types.js';
import { QuereusError } from '../../common/errors.js';
import type { EmissionContext } from '../emission-context.js';

export function emitSingleRow(_plan: SingleRowNode, _ctx: EmissionContext): Instruction {
	async function* run(_rctx: RuntimeContext): AsyncIterable<Row> {
		yield []; // Yield one empty row
	}

	return {
		params: [],
		run,
		note: 'single_row'
	};
}

export function emitValues(plan: ValuesNode, ctx: EmissionContext): Instruction {
	const nCols = plan.getType().columns.length;

	async function* run(ctx: RuntimeContext, ...values: Array<SqlValue>): AsyncIterable<Row> {
		for (let i = 0; i < values.length; i += nCols) {
			const row = values.slice(i, i + nCols);
			yield row;
		}
	}

	// Flatten all rows into a single array of expressions
	const rowExprs = plan.rows.flatMap(row => {
		if (row.length !== nCols) {
			throw new QuereusError('All rows must have the same number of columns', StatusCode.SYNTAX, undefined, row[0]?.expression.loc?.start.line, row.at(-1)?.expression.loc?.start.column);
		}
		return row.map(expr => emitPlanNode(expr, ctx));
	});

	return {
		params: rowExprs,
		run: asRun(run),
		note: `values(${plan.rows.length} rows, ${plan.rows[0]?.length || 0} cols)`
	};
}

export function emitTableLiteral(plan: TableLiteralNode, _ctx: EmissionContext): Instruction {
	async function* runArray(_rctx: RuntimeContext): AsyncIterable<Row> {
		for (const row of plan.rows as ReadonlyArray<Row>) {
			yield row;
		}
	}

	async function* runAsyncIterable(_rctx: RuntimeContext): AsyncIterable<Row> {
		yield* plan.rows as AsyncIterable<Row>;
	}

	const run = plan.rows instanceof Array ? runArray : runAsyncIterable;

	return {
		params: [],
		run,
		note: `tableLiteral(${plan.rowCount ?? '?'} rows, ${plan.getType().columns.length} cols)`
	};
}


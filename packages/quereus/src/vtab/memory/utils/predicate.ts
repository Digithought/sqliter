import type { Expression } from '../../../parser/ast.js';
import type { ColumnSchema } from '../../../schema/column.js';
import type { Row, SqlValue } from '../../../common/types.js';
import { compareSqlValues, isTruthy } from '../../../util/comparison.js';
import { QuereusError } from '../../../common/errors.js';
import { StatusCode } from '../../../common/types.js';

/**
 * SQL three-valued truthiness of a predicate value. NULL stays unknown (`null`);
 * every other value collapses to the engine's canonical {@link isTruthy} — so a
 * partial index / UNIQUE / materialized-view predicate scopes rows exactly as the
 * Filter / runtime path does (numeric-string coercion: `'abc'`, `'0'`, blobs ⇒
 * false). Previously these compiled predicates used a divergent "non-(`false`|`0`|
 * `0n`|`''`) ⇒ true" rule, which disagreed with the query engine for bare
 * string / blob values.
 */
function predicateTruthy(v: SqlValue): boolean | null {
	return v === null ? null : isTruthy(v);
}

/**
 * Compiled partial-index predicate. Walks a Row, returning SQL three-valued
 * boolean (true, false, or null = unknown).
 *
 * Only true means the row participates in the index (matching SQLite partial-index
 * semantics: false and unknown both exclude the row).
 */
export interface CompiledPredicate {
	evaluate: (row: Row) => boolean | null;
	/** Column indices the predicate references — used by the UPDATE path to decide
	 *  whether re-checking uniqueness is necessary. */
	referencedColumns: ReadonlySet<number>;
}

type Evaluator = (row: Row) => SqlValue;

/**
 * Compile a partial-index predicate AST into a row evaluator. Supports the
 * expression forms ordinarily found in partial-index WHERE clauses: literals,
 * column references, comparison operators, AND/OR/NOT, IS [NOT] NULL, and
 * literal-only IN-lists.
 *
 * Throws QuereusError on unsupported expression forms or unknown column
 * references so failures surface at index-creation time rather than producing
 * wrong runtime answers.
 *
 * When `tableName` is supplied, a `table`-qualified reference naming any OTHER
 * table (`where zzz.active = 1` on table `t`) is rejected here too — otherwise
 * the qualifier is ignored and the ref binds by bare name, so two statements
 * that read differently would compile to the same index. A self-qualifier
 * (`where t.active = 1`, case-insensitive) is accepted. Callers that do not yet
 * know their owning table name pass `undefined` and keep the lenient
 * ignore-the-qualifier behaviour.
 */
export function compilePredicate(
	expr: Expression,
	columns: ReadonlyArray<ColumnSchema>,
	tableName?: string,
): CompiledPredicate {
	const columnIndexMap = new Map<string, number>();
	columns.forEach((col, idx) => columnIndexMap.set(col.name.toLowerCase(), idx));

	const referencedColumns = new Set<number>();
	const evaluator = compileExpression(expr, columnIndexMap, referencedColumns, tableName);

	const evaluate = (row: Row): boolean | null => predicateTruthy(evaluator(row));

	return { evaluate, referencedColumns };
}

function compileExpression(
	expr: Expression,
	columnIndexMap: ReadonlyMap<string, number>,
	referencedColumns: Set<number>,
	tableName: string | undefined,
): Evaluator {
	switch (expr.type) {
		case 'literal': {
			const value = expr.value;
			if (value && typeof value === 'object' && 'then' in value) {
				throw new QuereusError(
					'Partial-index predicates may not contain async/promise literals',
					StatusCode.ERROR,
				);
			}
			return () => value as SqlValue;
		}
		case 'column':
		case 'identifier': {
			const ref = expr;
			if (ref.type === 'column' && ref.schema) {
				throw new QuereusError(
					`Partial-index predicate cannot reference schema-qualified column '${ref.schema}.${ref.name}'`,
					StatusCode.ERROR,
				);
			}
			if (ref.type === 'identifier' && ref.schema) {
				throw new QuereusError(
					`Partial-index predicate cannot reference schema-qualified identifier '${ref.schema}.${ref.name}'`,
					StatusCode.ERROR,
				);
			}
			// A `table`-qualified ref (`zzz.active`) naming a table other than the owning
			// one is rejected: without this the qualifier is dropped and the ref binds by
			// bare name, so `where zzz.active` and `where active` compile identically.
			// Only `ColumnExpr` carries a `table` field (an `identifier` never does).
			// NOTE: a persisted store DB written by pre-fix code may already hold such a
			// foreign-qualified predicate; recompiling it now throws (on rebuild/first
			// maintenance) where it previously bound by bare name. Only matters if a legacy
			// DB with an already-wrong index is reopened; no migration is attempted.
			if (ref.type === 'column' && ref.table && tableName !== undefined
				&& ref.table.toLowerCase() !== tableName.toLowerCase()) {
				throw new QuereusError(
					`Partial-index predicate cannot reference column '${ref.table}.${ref.name}' `
						+ `of a different table (predicate is scoped to '${tableName}')`,
					StatusCode.ERROR,
				);
			}
			const colIdx = columnIndexMap.get(ref.name.toLowerCase());
			if (colIdx === undefined) {
				throw new QuereusError(
					`Partial-index predicate references unknown column '${ref.name}'`,
					StatusCode.ERROR,
				);
			}
			referencedColumns.add(colIdx);
			return (row: Row) => row[colIdx];
		}
		case 'unary':
			return compileUnary(expr, columnIndexMap, referencedColumns, tableName);
		case 'binary':
			return compileBinary(expr, columnIndexMap, referencedColumns, tableName);
		case 'in':
			return compileIn(expr, columnIndexMap, referencedColumns, tableName);
		default:
			throw new QuereusError(
				`Unsupported expression in partial-index predicate: ${expr.type}`,
				StatusCode.ERROR,
			);
	}
}

function compileIn(
	expr: Extract<Expression, { type: 'in' }>,
	columnIndexMap: ReadonlyMap<string, number>,
	referencedColumns: Set<number>,
	tableName: string | undefined,
): Evaluator {
	if (expr.subquery) {
		throw new QuereusError(
			'Partial-index predicate may not contain IN subqueries',
			StatusCode.ERROR,
		);
	}
	if (!expr.values || expr.values.length === 0) {
		// `col IN ()` is always false (SQLite semantics).
		return () => false;
	}
	const inputEval = compileExpression(expr.expr, columnIndexMap, referencedColumns, tableName);
	const valueEvals = expr.values.map(v => compileExpression(v, columnIndexMap, referencedColumns, tableName));
	return (row) => {
		const a = inputEval(row);
		if (a === null) return null;
		let sawNull = false;
		for (const ve of valueEvals) {
			const b = ve(row);
			if (b === null) { sawNull = true; continue; }
			if (compareSqlValues(a, b) === 0) return true;
		}
		// Three-valued IN: no match plus a NULL ⇒ unknown; otherwise false.
		return sawNull ? null : false;
	};
}

function compileUnary(
	expr: Extract<Expression, { type: 'unary' }>,
	columnIndexMap: ReadonlyMap<string, number>,
	referencedColumns: Set<number>,
	tableName: string | undefined,
): Evaluator {
	const op = expr.operator.toUpperCase();
	const operand = compileExpression(expr.expr, columnIndexMap, referencedColumns, tableName);

	switch (op) {
		case 'IS NULL':
			return (row) => operand(row) === null;
		case 'IS NOT NULL':
			return (row) => operand(row) !== null;
		case 'IS TRUE':
			return (row) => {
				const t = predicateTruthy(operand(row));
				return t === null ? false : t;
			};
		case 'IS NOT TRUE':
			return (row) => {
				const t = predicateTruthy(operand(row));
				return t === null ? true : !t;
			};
		case 'IS FALSE':
			return (row) => {
				const t = predicateTruthy(operand(row));
				return t === null ? false : !t;
			};
		case 'IS NOT FALSE':
			return (row) => {
				const t = predicateTruthy(operand(row));
				return t === null ? true : t;
			};
		case 'NOT':
			return (row) => {
				const t = predicateTruthy(operand(row));
				return t === null ? null : !t;
			};
		case '+':
			return (row) => {
				const v = operand(row);
				if (v === null) return null;
				if (typeof v === 'number' || typeof v === 'bigint') return v;
				const n = Number(v);
				return Number.isNaN(n) ? null : n;
			};
		case '-':
			return (row) => {
				const v = operand(row);
				if (v === null) return null;
				if (typeof v === 'number') return -v;
				if (typeof v === 'bigint') return -v;
				const n = Number(v);
				return Number.isNaN(n) ? null : -n;
			};
		default:
			throw new QuereusError(
				`Unsupported unary operator in partial-index predicate: ${expr.operator}`,
				StatusCode.ERROR,
			);
	}
}

function compileBinary(
	expr: Extract<Expression, { type: 'binary' }>,
	columnIndexMap: ReadonlyMap<string, number>,
	referencedColumns: Set<number>,
	tableName: string | undefined,
): Evaluator {
	const op = expr.operator.toUpperCase();
	const left = compileExpression(expr.left, columnIndexMap, referencedColumns, tableName);
	const right = compileExpression(expr.right, columnIndexMap, referencedColumns, tableName);

	switch (op) {
		case 'AND':
			// Three-valued AND: any FALSE ⇒ false (short-circuit); else any NULL ⇒ null.
			return (row) => {
				const a = predicateTruthy(left(row));
				if (a === false) return false;
				const b = predicateTruthy(right(row));
				if (b === false) return false;
				if (a === null || b === null) return null;
				return true;
			};
		case 'OR':
			// Three-valued OR: any TRUE ⇒ true (short-circuit); else any NULL ⇒ null.
			return (row) => {
				const a = predicateTruthy(left(row));
				if (a === true) return true;
				const b = predicateTruthy(right(row));
				if (b === true) return true;
				if (a === null || b === null) return null;
				return false;
			};
		case '=':
		case '==':
			return makeCompare(left, right, (cmp) => cmp === 0);
		case '<>':
		case '!=':
			return makeCompare(left, right, (cmp) => cmp !== 0);
		case '<':
			return makeCompare(left, right, (cmp) => cmp < 0);
		case '<=':
			return makeCompare(left, right, (cmp) => cmp <= 0);
		case '>':
			return makeCompare(left, right, (cmp) => cmp > 0);
		case '>=':
			return makeCompare(left, right, (cmp) => cmp >= 0);
		case 'IS':
			// `a IS b` is total equality including NULL.
			return (row) => {
				const a = left(row);
				const b = right(row);
				if (a === null && b === null) return true;
				if (a === null || b === null) return false;
				return compareSqlValues(a, b) === 0;
			};
		case 'IS NOT':
			return (row) => {
				const a = left(row);
				const b = right(row);
				if (a === null && b === null) return false;
				if (a === null || b === null) return true;
				return compareSqlValues(a, b) !== 0;
			};
		default:
			throw new QuereusError(
				`Unsupported binary operator in partial-index predicate: ${expr.operator}`,
				StatusCode.ERROR,
			);
	}
}

function makeCompare(left: Evaluator, right: Evaluator, predicate: (cmp: number) => boolean): Evaluator {
	return (row) => {
		const a = left(row);
		const b = right(row);
		if (a === null || b === null) return null;
		return predicate(compareSqlValues(a, b));
	};
}

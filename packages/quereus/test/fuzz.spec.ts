import * as fc from 'fast-check';
import { Database } from '../src/core/database.js';
import { QuereusError } from '../src/common/errors.js';

// ============================================================================
// Reproducibility seed
// ============================================================================
//
// fast-check is random by default. That is good for cumulative coverage across
// runs, but it makes a rare failure impossible to replay — and a *Mocha timeout*
// is the worst case, because it kills the test before fast-check can print the
// seed it would normally report on an assertion failure.
//
// So we resolve a single base seed per process — from QUEREUS_FUZZ_SEED when
// set, otherwise random — print it once, and feed it to every `fc.assert` (which
// drives the property inputs) AND every `fc.sample` (which draws the SQL strings
// and seed rows inside each property body). With both seeded, an entire run is
// deterministic: read the printed seed and re-run with
// `QUEREUS_FUZZ_SEED=<seed>` to reproduce it exactly, including a timeout.
//
// The default stays random so the suite keeps exploring new inputs run-to-run;
// pinning the env var only narrows it to one reproducible run.
const FUZZ_SEED: number = (() => {
	const raw = process.env.QUEREUS_FUZZ_SEED;
	if (raw !== undefined && raw.trim() !== '') {
		const parsed = Number(raw);
		if (Number.isFinite(parsed)) return Math.trunc(parsed);
		console.warn(`[fuzz] ignoring non-numeric QUEREUS_FUZZ_SEED=${JSON.stringify(raw)}; using a random seed`);
	}
	return Math.floor(Math.random() * 0x1_0000_0000);
})();

console.log(`[fuzz] QUEREUS_FUZZ_SEED=${FUZZ_SEED} — set this env var to reproduce this run (including any timeout).`);

// ============================================================================
// Types
// ============================================================================

interface ColumnInfo {
	name: string;
	type: string;
	primaryKey?: boolean;
	notNull?: boolean;
	unique?: boolean;
	defaultValue?: string;
}

interface TableInfo {
	name: string;
	columns: ColumnInfo[];
}

interface SchemaInfo {
	tables: TableInfo[];
}

// ============================================================================
// Phase 1: Schema + Data Generators
// ============================================================================

const TABLE_NAMES = ['t1', 't2', 't3'];
const COLUMN_TYPES = ['integer', 'real', 'text', 'blob', 'any'];

const COL_PREFIXES: Record<string, string> = {
	integer: 'c_int',
	real: 'c_real',
	text: 'c_text',
	blob: 'c_blob',
	any: 'c_any',
};

const arbColumnType = fc.constantFrom(...COLUMN_TYPES);

function arbColumn(index: number): fc.Arbitrary<ColumnInfo> {
	return fc.record({
		type: arbColumnType,
		notNull: fc.boolean(),
		unique: fc.boolean(),
	}).map(({ type, notNull, unique }) => ({
		name: `${COL_PREFIXES[type]}${index}`,
		type,
		notNull,
		unique,
	}));
}

function arbTableInfo(tableName: string): fc.Arbitrary<TableInfo> {
	return fc.integer({ min: 2, max: 5 }).chain(colCount =>
		fc.tuple(
			fc.tuple(...Array.from({ length: colCount }, (_, i) => arbColumn(i))),
			fc.integer({ min: 0, max: colCount - 1 }), // which column gets PK
			fc.boolean(), // whether to have a PK at all
		).map(([columns, pkIndex, hasPk]) => {
			const cols = [...columns];
			if (hasPk) {
				cols[pkIndex] = { ...cols[pkIndex], primaryKey: true, notNull: true };
			}
			return { name: tableName, columns: cols };
		})
	);
}

const arbSchemaInfo: fc.Arbitrary<SchemaInfo> = fc.integer({ min: 1, max: 3 }).chain(tableCount =>
	fc.tuple(...TABLE_NAMES.slice(0, tableCount).map(n => arbTableInfo(n)))
		.map(tables => ({ tables: [...tables] }))
);

function arbValueForType(type: string): fc.Arbitrary<string> {
	switch (type) {
		case 'integer':
			return fc.integer({ min: -1000, max: 1000 }).map(n => String(n));
		case 'real':
			return fc.oneof(
				fc.integer({ min: -100, max: 100 }).map(n => `${n}.${Math.abs(n % 100)}`),
				fc.constant('0.0'),
			);
		case 'text':
			return fc.string({ minLength: 0, maxLength: 20 })
				.map(s => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`);
		case 'blob':
			// NOTE: one constant blob value. The set-identity oracles below compare rows
			// through `cast(col as text)`, and that conversion is lossy for bytes that are
			// not valid UTF-8 (they all decode to U+FFFD). With a single blob value nothing
			// can collide; if blob generation ever widens, distinct blobs will fold onto one
			// text value and those oracles will quietly lose discriminating power — give
			// them a lossless rendering (or compare the raw values) at that point.
			return fc.constant("x'00'");
		case 'any':
			return fc.oneof(
				fc.integer({ min: -100, max: 100 }).map(n => String(n)),
				fc.constant("'hello'"),
				fc.constant('null'),
			);
		default:
			return fc.constant('null');
	}
}

function arbSeedRow(table: TableInfo): fc.Arbitrary<string> {
	const valueArbs = table.columns.map(col =>
		col.notNull
			? arbValueForType(col.type)
			: fc.oneof(arbValueForType(col.type), fc.constant('null'))
	);
	return fc.tuple(...valueArbs).map(vals =>
		`insert into ${table.name} (${table.columns.map(c => c.name).join(', ')}) values (${[...vals].join(', ')})`
	);
}

async function createSchema(db: Database, schema: SchemaInfo): Promise<void> {
	for (const table of schema.tables) {
		const colDefs = table.columns.map(col => {
			let def = `${col.name} ${col.type}`;
			if (col.primaryKey) def += ' primary key';
			if (col.notNull && !col.primaryKey) def += ' not null';
			if (col.unique && !col.primaryKey) def += ' unique';
			if (col.defaultValue) def += ` default ${col.defaultValue}`;
			return def;
		});
		await db.exec(`create table ${table.name} (${colDefs.join(', ')}) using memory`);
	}
}

async function seedTable(db: Database, table: TableInfo, rowCount: number, seed: number): Promise<void> {
	if (rowCount === 0) return;
	// Generate and execute seed rows using fast-check's sample. Seeded for
	// reproducibility (see FUZZ_SEED); the caller varies the seed per table so
	// two same-shaped tables don't end up with identical data.
	const rows = fc.sample(arbSeedRow(table), { numRuns: rowCount, seed });
	for (const sql of rows) {
		try {
			await db.exec(sql);
		} catch (e) {
			if (!(e instanceof QuereusError)) throw e;
			// Constraint violations during seeding are expected (duplicate PKs, etc.)
		}
	}
}

async function setupSchema(db: Database, schema: SchemaInfo, rowsPerTable: number): Promise<void> {
	await createSchema(db, schema);
	for (let t = 0; t < schema.tables.length; t++) {
		await seedTable(db, schema.tables[t], rowsPerTable, FUZZ_SEED + t);
	}
}

// ============================================================================
// Phase 2: SQL String Arbitraries
// ============================================================================

const ARITH_OPS = ['+', '-', '*', '/', '%'];
const CMP_OPS = ['=', '!=', '<', '<=', '>', '>=', 'is', 'is not'];
const LOGICAL_OPS = ['and', 'or'];
const STRING_OPS = ['||'];
const ALL_BIN_OPS = [...ARITH_OPS, ...CMP_OPS, ...LOGICAL_OPS, ...STRING_OPS];

const SINGLE_ARG_FUNCS = ['abs', 'typeof', 'length', 'upper', 'lower', 'trim', 'hex', 'quote', 'unicode', 'char', 'total', 'group_concat'];
const DOUBLE_ARG_FUNCS = ['coalesce', 'ifnull', 'nullif', 'min', 'max', 'substr', 'replace', 'instr', 'iif'];
const WINDOW_FUNCS = ['row_number', 'rank', 'dense_rank', 'ntile', 'lag', 'lead', 'first_value', 'last_value'];

function allColumns(schema: SchemaInfo): string[] {
	const cols: string[] = [];
	for (const t of schema.tables) {
		for (const c of t.columns) {
			cols.push(c.name);
			cols.push(`${t.name}.${c.name}`);
		}
	}
	return cols;
}

function buildSqlArbitraries(schema: SchemaInfo) {
	const columns = allColumns(schema);
	const tableNames = schema.tables.map(t => t.name);
	const depthId = 'sql-expr';

	const arbs = fc.letrec(tie => ({
		// — Expressions —

		literal: fc.oneof(
			fc.integer({ min: -999, max: 999 }).map(n => n < 0 ? `(${n})` : String(n)),
			fc.constant('0.5'),
			fc.constant('3.14'),
			fc.constantFrom("'hello'", "'world'", "''", "'test string'"),
			fc.constant('null'),
			fc.constant('1'),
			fc.constant('0'),
		),

		column: columns.length > 0
			? fc.constantFrom(...columns)
			: fc.constant('1'),

		binExpr: fc.tuple(
			tie('expr'),
			fc.constantFrom(...ALL_BIN_OPS),
			tie('expr'),
		).map(([l, op, r]) => `(${l} ${op} ${r})`),

		unaryExpr: fc.oneof(
			(tie('expr') as fc.Arbitrary<string>).map((e: string) => `(- ${e})`),
			(tie('expr') as fc.Arbitrary<string>).map((e: string) => `(not ${e})`),
			(tie('expr') as fc.Arbitrary<string>).map((e: string) => `(+ ${e})`),
		),

		funcCall: fc.oneof(
			fc.tuple(
				fc.constantFrom(...SINGLE_ARG_FUNCS),
				tie('expr'),
			).map(([fn, arg]) => `${fn}(${arg})`),
			fc.tuple(
				fc.constantFrom(...DOUBLE_ARG_FUNCS),
				tie('expr'),
				tie('expr'),
			).map(([fn, a, b]) => {
				if (fn === 'iif') return `iif(${a}, ${b}, null)`;
				if (fn === 'substr') return `substr(${a}, ${b}, 3)`;
				if (fn === 'replace') return `replace(${a}, 'a', ${b})`;
				if (fn === 'instr') return `instr(${a}, ${b})`;
				return `${fn}(${a}, ${b})`;
			}),
		),

		caseExpr: fc.tuple(
			tie('expr'), tie('expr'), tie('expr'),
		).map(([cond, then, els]) =>
			`case when ${cond} then ${then} else ${els} end`
		),

		castExpr: fc.tuple(
			tie('expr'),
			fc.constantFrom('integer', 'real', 'text', 'blob'),
		).map(([e, t]) => `cast(${e} as ${t})`),

		inExpr: fc.tuple(
			tie('expr'),
			fc.array(tie('literal') as fc.Arbitrary<string>, { minLength: 1, maxLength: 4 }),
		).map(([e, vals]) => `${e} in (${vals.join(', ')})`),

		betweenExpr: fc.tuple(
			tie('expr'), tie('expr'), tie('expr'),
		).map(([e, lo, hi]) => `${e} between ${lo} and ${hi}`),

		existsExpr: (tie('subSelect') as fc.Arbitrary<string>).map((s: string) => `exists (${s})`),

		subquery: (tie('subSelect') as fc.Arbitrary<string>).map((s: string) => `(${s})`),

		correlatedSubquery: tableNames.length >= 2
			? fc.tuple(
				fc.constantFrom(...tableNames),
				fc.constantFrom(...tableNames),
			).filter(([t1, t2]) => t1 !== t2)
				.chain(([outer, inner]) => {
					const outerCols = schema.tables.find(t => t.name === outer)?.columns ?? [];
					const innerCols = schema.tables.find(t => t.name === inner)?.columns ?? [];
					const outerCol = outerCols.length > 1 ? outerCols[1].name : outerCols[0]?.name ?? 'id';
					const innerCol = innerCols.length > 1 ? innerCols[1].name : innerCols[0]?.name ?? 'id';
					return fc.constant(`${outerCol} in (select ${innerCol} from ${inner} where ${outer}.${outerCol} = ${inner}.${innerCol})`);
				})
			: fc.constant('1 = 1'),

		likeExpr: fc.tuple(
			tie('column') as fc.Arbitrary<string>,
			fc.constantFrom('like', 'glob'),
			fc.constantFrom("'%test%'", "'hello%'", "'_ello'", "'%'", "'[a-z]%'"),
		).map(([col, op, pattern]) => `${col} ${op} ${pattern}`),

		recursiveCte: fc.tuple(
			fc.integer({ min: 1, max: 20 }),
			fc.constantFrom(...tableNames),
		).map(([maxDepth, _tbl]) =>
			`with recursive cnt(x) as (select 1 union all select x + 1 from cnt where x < ${maxDepth}) select cnt.x from cnt limit 50`
		),

		expr: fc.oneof(
			{ depthIdentifier: depthId, maxDepth: 5, depthSize: 'small' },
			tie('literal'),
			tie('column'),
			tie('binExpr'),
			tie('unaryExpr'),
			tie('funcCall'),
			tie('caseExpr'),
			tie('castExpr'),
			tie('inExpr'),
			tie('betweenExpr'),
			tie('likeExpr'),
			tie('correlatedSubquery'),
		),

		// — SELECT —

		selectColumns: fc.oneof(
			fc.constant('*'),
			fc.array(tie('expr') as fc.Arbitrary<string>, { minLength: 1, maxLength: 4 })
				.map(exprs => exprs.map((e, i) => `${e} as col${i}`).join(', ')),
		),

		whereClause: fc.oneof(
			fc.constant(''),
			(tie('expr') as fc.Arbitrary<string>).map((e: string) => `where ${e}`),
		),

		orderByClause: fc.oneof(
			fc.constant(''),
			fc.tuple(
				tie('expr') as fc.Arbitrary<string>,
				fc.constantFrom('asc', 'desc', ''),
			).map(([e, dir]) => `order by ${e} ${dir}`.trim()),
		),

		limitClause: fc.oneof(
			fc.constant(''),
			fc.integer({ min: 0, max: 50 }).map(n => `limit ${n}`),
			fc.tuple(
				fc.integer({ min: 0, max: 50 }),
				fc.integer({ min: 0, max: 20 }),
			).map(([lim, off]) => `limit ${lim} offset ${off}`),
		),

		groupByClause: fc.oneof(
			fc.constant(''),
			...(columns.length > 0
				? [fc.constantFrom(...columns).map((c: string) => `group by ${c}`)]
				: [fc.constant('')]),
		),

		havingClause: fc.oneof(
			fc.constant(''),
			(tie('expr') as fc.Arbitrary<string>).map((e: string) => `having ${e}`),
		),

		fromClause: fc.oneof(
			fc.constantFrom(...tableNames),
			// Simple join
			tableNames.length >= 2
				? fc.tuple(
					fc.constantFrom(...tableNames),
					fc.constantFrom('inner join', 'left join', 'cross join'),
					fc.constantFrom(...tableNames),
					tie('expr') as fc.Arbitrary<string>,
				).map(([t1, jt, t2, cond]) =>
					jt === 'cross join' ? `${t1} ${jt} ${t2}` : `${t1} ${jt} ${t2} on ${cond}`
				)
				: fc.constantFrom(...tableNames),
		),

		distinct: fc.constantFrom('', 'distinct'),

		selectCore: fc.tuple(
			tie('distinct') as fc.Arbitrary<string>,
			tie('selectColumns') as fc.Arbitrary<string>,
			tie('fromClause') as fc.Arbitrary<string>,
			tie('whereClause') as fc.Arbitrary<string>,
			tie('groupByClause') as fc.Arbitrary<string>,
			tie('havingClause') as fc.Arbitrary<string>,
			tie('orderByClause') as fc.Arbitrary<string>,
			tie('limitClause') as fc.Arbitrary<string>,
		).map(([dist, cols, from, where, groupBy, having, orderBy, limit]) => {
			let sql = `select ${dist} ${cols} from ${from}`.replace(/\s+/g, ' ').trim();
			if (where) sql += ` ${where}`;
			if (groupBy) sql += ` ${groupBy}`;
			if (having && groupBy) sql += ` ${having}`;
			if (orderBy) sql += ` ${orderBy}`;
			if (limit) sql += ` ${limit}`;
			return sql;
		}),

		// Subselect used for subqueries — simpler to avoid deep recursion
		subSelect: fc.tuple(
			fc.constantFrom(...tableNames),
			tie('expr') as fc.Arbitrary<string>,
		).map(([tbl, expr]) => `select ${expr} from ${tbl} limit 5`),

		select: fc.oneof(
			{ depthIdentifier: 'select-compound', maxDepth: 1, depthSize: 'small' },
			tie('selectCore'),
			// Compound
			fc.tuple(
				tie('selectCore') as fc.Arbitrary<string>,
				fc.constantFrom('union', 'union all', 'intersect', 'except'),
				tie('selectCore') as fc.Arbitrary<string>,
			).map(([s1, op, s2]) => `${s1} ${op} ${s2}`),
		),

		// — CTE —
		cte: fc.tuple(
			fc.constantFrom('cte1', 'cte2'),
			tie('selectCore') as fc.Arbitrary<string>,
			tie('selectCore') as fc.Arbitrary<string>,
		).map(([name, inner, outer]) =>
			`with ${name} as (${inner}) ${outer}`
		),

		// — Window functions —
		windowFunc: fc.tuple(
			fc.constantFrom(...WINDOW_FUNCS),
			columns.length > 0 ? fc.constantFrom(...columns.filter(c => !c.includes('.'))) : fc.constant('1'),
			fc.constantFrom('asc', 'desc'),
			fc.constantFrom(
				'', 'rows between unbounded preceding and current row',
				'rows between 1 preceding and 1 following',
				'range between unbounded preceding and current row',
			),
		).map(([fn, orderCol, dir, frame]) => {
			const args = fn === 'ntile' ? '(2)' : (
				['lag', 'lead'].includes(fn as string)
					? `(${columns.length > 0 ? columns.filter(c => !c.includes('.'))[0] : '1'})`
					: ['first_value', 'last_value'].includes(fn as string)
						? `(${columns.length > 0 ? columns.filter(c => !c.includes('.'))[0] : '1'})`
						: '()'
			);
			let over = `order by ${orderCol} ${dir}`;
			if (frame) over += ` ${frame}`;
			return `${fn}${args} over (${over})`;
		}),

		windowSelect: fc.tuple(
			fc.constantFrom(...tableNames),
			tie('windowFunc') as fc.Arbitrary<string>,
			tie('whereClause') as fc.Arbitrary<string>,
			tie('limitClause') as fc.Arbitrary<string>,
		).map(([tbl, wfn, where, limit]) => {
			let sql = `select *, ${wfn} as w from ${tbl}`;
			if (where) sql += ` ${where}`;
			if (limit) sql += ` ${limit}`;
			return sql;
		}),

		// — DML —

		insert: fc.tuple(
			fc.constantFrom(...schema.tables),
		).chain(([table]) => {
			const cols = table.columns;
			const valArbs = cols.map(c =>
				c.notNull ? arbValueForType(c.type) : fc.oneof(arbValueForType(c.type), fc.constant('null'))
			);
			return fc.tuple(
				fc.tuple(...valArbs),
				fc.boolean(), // returning?
			).map(([vals, returning]) => {
				let sql = `insert into ${table.name} (${cols.map(c => c.name).join(', ')}) values (${[...vals].join(', ')})`;
				if (returning) sql += ' returning *';
				return sql;
			});
		}),

		update: fc.tuple(
			fc.constantFrom(...schema.tables),
		).chain(([table]) => {
			const cols = table.columns.filter(c => !c.primaryKey);
			if (cols.length === 0) return fc.constant(`update ${table.name} set ${table.columns[0].name} = ${table.columns[0].name}`);
			return fc.tuple(
				fc.constantFrom(...cols),
				fc.constantFrom('literal', 'expr') as fc.Arbitrary<string>,
				fc.boolean(), // has WHERE
				fc.boolean(), // returning
			).map(([col, _valType, hasWhere, returning]) => {
				let sql = `update ${table.name} set ${col.name} = 42`;
				if (hasWhere) sql += ` where ${table.columns[0].name} is not null`;
				if (returning) sql += ' returning *';
				return sql;
			});
		}),

		delete: fc.tuple(
			fc.constantFrom(...schema.tables),
		).chain(([table]) =>
			fc.tuple(
				fc.boolean(), // has WHERE
				fc.boolean(), // returning
			).map(([hasWhere, returning]) => {
				let sql = `delete from ${table.name}`;
				if (hasWhere) sql += ` where ${table.columns[0].name} is not null`;
				if (returning) sql += ' returning *';
				return sql;
			})
		),

		dml: fc.oneof(
			tie('insert'),
			tie('update'),
			tie('delete'),
		),

		statement: fc.oneof(
			tie('select'),
			tie('select'),  // weight selects more
			tie('dml'),
			tie('cte'),
			tie('windowSelect'),
			tie('recursiveCte'),
		),
	}));

	return arbs;
}

// ============================================================================
// Phase 3: Test Harness
// ============================================================================

// NOTE: queries run without a per-query time budget — a genuine engine hang
// surfaces only as the describe block's 120s Mocha timeout, which names no SQL.
// The seed printed at startup makes such a run replayable; if a real hang ever
// shows up, wrap these execs in an `AbortSignal` (db.exec/db.eval accept
// `{ signal }`) timed well above the slowest legitimate query (~20ms observed)
// so it fails fast and names the offending SQL instead of an opaque 120s stall.

/**
 * Execute SQL and drain all results. Returns true if successful, throws on
 * unexpected (non-QuereusError) exceptions.
 */
async function execAndDrain(db: Database, sql: string): Promise<void> {
	try {
		await db.exec(sql);
	} catch (err) {
		if (err instanceof QuereusError) return; // expected
		const name = (err as Error)?.constructor?.name ?? 'Unknown';
		const msg = (err as Error)?.message ?? String(err);
		throw new Error(`Unexpected ${name}: ${msg}\nSQL: ${sql}`);
	}
}

async function evalAndDrain(db: Database, sql: string): Promise<void> {
	try {
		for await (const _row of db.eval(sql)) {
			// drain all rows
		}
	} catch (err) {
		if (err instanceof QuereusError) return; // expected
		const name = (err as Error)?.constructor?.name ?? 'Unknown';
		const msg = (err as Error)?.message ?? String(err);
		throw new Error(`Unexpected ${name}: ${msg}\nSQL: ${sql}`);
	}
}

/** Run a SELECT and collect all rows */
async function collectRows(db: Database, sql: string): Promise<Record<string, unknown>[]> {
	const rows: Record<string, unknown>[] = [];
	for await (const row of db.eval(sql)) {
		rows.push(row as Record<string, unknown>);
	}
	return rows;
}

/** Run a SELECT, tolerating QuereusError. Returns null if query errors. */
async function tryCollectRows(db: Database, sql: string): Promise<Record<string, unknown>[] | null> {
	try {
		return await collectRows(db, sql);
	} catch (err) {
		if (err instanceof QuereusError) return null;
		throw err;
	}
}

describe('Grammar-Based SQL Fuzzing', function () {
	this.timeout(120_000);

	let db: Database;

	it('SELECT queries do not crash', async function () {
		await fc.assert(
			fc.asyncProperty(
				arbSchemaInfo,
				fc.integer({ min: 0, max: 15 }),
				fc.integer({ min: 3, max: 10 }),
				async (schema, rowCount, sampleCount) => {
					db = new Database();
					try {
						await setupSchema(db, schema, rowCount);
						const arbs = buildSqlArbitraries(schema);
						const sqls = fc.sample(arbs.select as fc.Arbitrary<string>, { numRuns: sampleCount, seed: FUZZ_SEED });
						for (const sql of sqls) {
							await evalAndDrain(db, sql);
						}
					} finally {
						await db.close();
					}
				}
			),
			{ numRuns: 200, endOnFailure: true, seed: FUZZ_SEED }
		);
	});

	it('DML queries do not crash', async function () {
		await fc.assert(
			fc.asyncProperty(
				arbSchemaInfo,
				fc.integer({ min: 0, max: 10 }),
				fc.integer({ min: 2, max: 6 }),
				async (schema, rowCount, sampleCount) => {
					db = new Database();
					try {
						await setupSchema(db, schema, rowCount);
						const arbs = buildSqlArbitraries(schema);
						const sqls = fc.sample(arbs.dml as fc.Arbitrary<string>, { numRuns: sampleCount, seed: FUZZ_SEED });
						for (const sql of sqls) {
							await execAndDrain(db, sql);
						}
					} finally {
						await db.close();
					}
				}
			),
			{ numRuns: 100, endOnFailure: true, seed: FUZZ_SEED }
		);
	});

	it('compound/CTE queries do not crash', async function () {
		await fc.assert(
			fc.asyncProperty(
				arbSchemaInfo,
				fc.integer({ min: 1, max: 10 }),
				fc.integer({ min: 1, max: 4 }),
				fc.integer({ min: 1, max: 4 }),
				async (schema, rowCount, cteSampleCount, compoundSampleCount) => {
					db = new Database();
					try {
						await setupSchema(db, schema, rowCount);
						const arbs = buildSqlArbitraries(schema);
						const ctes = fc.sample(arbs.cte as fc.Arbitrary<string>, { numRuns: cteSampleCount, seed: FUZZ_SEED });
						const compounds = fc.sample(arbs.select as fc.Arbitrary<string>, { numRuns: compoundSampleCount, seed: FUZZ_SEED });
						for (const sql of [...ctes, ...compounds]) {
							await evalAndDrain(db, sql);
						}
					} finally {
						await db.close();
					}
				}
			),
			{ numRuns: 100, endOnFailure: true, seed: FUZZ_SEED }
		);
	});

	it('window function queries do not crash', async function () {
		await fc.assert(
			fc.asyncProperty(
				arbSchemaInfo,
				fc.integer({ min: 1, max: 10 }),
				fc.integer({ min: 2, max: 6 }),
				async (schema, rowCount, sampleCount) => {
					db = new Database();
					try {
						await setupSchema(db, schema, rowCount);
						const arbs = buildSqlArbitraries(schema);
						const sqls = fc.sample(arbs.windowSelect as fc.Arbitrary<string>, { numRuns: sampleCount, seed: FUZZ_SEED });
						for (const sql of sqls) {
							await evalAndDrain(db, sql);
						}
					} finally {
						await db.close();
					}
				}
			),
			{ numRuns: 100, endOnFailure: true, seed: FUZZ_SEED }
		);
	});

	it('mixed workload does not crash', async function () {
		await fc.assert(
			fc.asyncProperty(
				arbSchemaInfo,
				fc.integer({ min: 0, max: 15 }),
				fc.integer({ min: 3, max: 10 }),
				async (schema, rowCount, sampleCount) => {
					db = new Database();
					try {
						await setupSchema(db, schema, rowCount);
						const arbs = buildSqlArbitraries(schema);
						const sqls = fc.sample(arbs.statement as fc.Arbitrary<string>, { numRuns: sampleCount, seed: FUZZ_SEED });
						for (const sql of sqls) {
							// Use eval for SELECT-like, exec for DML
							const trimmed = sql.trimStart().toLowerCase();
							if (trimmed.startsWith('insert') || trimmed.startsWith('update') || trimmed.startsWith('delete')) {
								await execAndDrain(db, sql);
							} else {
								await evalAndDrain(db, sql);
							}
						}
					} finally {
						await db.close();
					}
				}
			),
			{ numRuns: 200, endOnFailure: true, seed: FUZZ_SEED }
		);
	});

	it('SELECT results are deterministic', async function () {
		await fc.assert(
			fc.asyncProperty(
				arbSchemaInfo,
				fc.integer({ min: 1, max: 15 }),
				async (schema, rowCount) => {
					db = new Database();
					try {
						await setupSchema(db, schema, rowCount);
						const arbs = buildSqlArbitraries(schema);
						const sqls = fc.sample(arbs.select as fc.Arbitrary<string>, { numRuns: 5, seed: FUZZ_SEED });
						for (const sql of sqls) {
							const r1 = await tryCollectRows(db, sql);
							if (r1 === null) continue; // query errored, skip
							const r2 = await tryCollectRows(db, sql);
							if (r2 === null) throw new Error(`Query succeeded first time but failed second time\nSQL: ${sql}`);
							const s1 = r1.map(r => JSON.stringify(r));
							const s2 = r2.map(r => JSON.stringify(r));
							if (s1.length !== s2.length) {
								throw new Error(`Determinism violation: row count ${s1.length} vs ${s2.length}\nSQL: ${sql}`);
							}
							for (let i = 0; i < s1.length; i++) {
								if (s1[i] !== s2[i]) {
									throw new Error(`Determinism violation at row ${i}\nSQL: ${sql}`);
								}
							}
						}
					} finally {
						await db.close();
					}
				}
			),
			{ numRuns: 100, endOnFailure: true, seed: FUZZ_SEED }
		);
	});

	it('COUNT(*) is non-negative', async function () {
		await fc.assert(
			fc.asyncProperty(
				arbSchemaInfo,
				fc.integer({ min: 0, max: 15 }),
				async (schema, rowCount) => {
					db = new Database();
					try {
						await setupSchema(db, schema, rowCount);
						for (const table of schema.tables) {
							const rows = await tryCollectRows(db, `select count(*) as cnt from ${table.name}`);
							if (rows === null) continue;
							const cnt = rows[0].cnt as number;
							if (cnt < 0) {
								throw new Error(`COUNT(*) returned ${cnt} for table ${table.name}`);
							}
						}
					} finally {
						await db.close();
					}
				}
			),
			{ numRuns: 100, endOnFailure: true, seed: FUZZ_SEED }
		);
	});

	it('LIMIT constrains result set size', async function () {
		await fc.assert(
			fc.asyncProperty(
				arbSchemaInfo,
				fc.integer({ min: 1, max: 15 }),
				fc.integer({ min: 0, max: 20 }),
				async (schema, rowCount, limit) => {
					db = new Database();
					try {
						await setupSchema(db, schema, rowCount);
						for (const table of schema.tables) {
							const rows = await tryCollectRows(db, `select * from ${table.name} limit ${limit}`);
							if (rows === null) continue;
							if (rows.length > limit) {
								throw new Error(`LIMIT ${limit} returned ${rows.length} rows from ${table.name}`);
							}
						}
					} finally {
						await db.close();
					}
				}
			),
			{ numRuns: 100, endOnFailure: true, seed: FUZZ_SEED }
		);
	});

	it('ORDER BY ASC produces sorted results', async function () {
		await fc.assert(
			fc.asyncProperty(
				arbSchemaInfo,
				fc.integer({ min: 2, max: 15 }),
				async (schema, rowCount) => {
					db = new Database();
					try {
						await setupSchema(db, schema, rowCount);
						for (const table of schema.tables) {
							for (const col of table.columns) {
								const rows = await tryCollectRows(db, `select ${col.name} as v from ${table.name} order by ${col.name} asc`);
								if (rows === null || rows.length < 2) continue;
								// Check sortedness: nulls first, then ascending
								let seenNonNull = false;
								for (let i = 0; i < rows.length; i++) {
									if (rows[i].v === null) {
										if (seenNonNull) {
											// null after non-null is OK in some SQL dialects, skip strict check
										}
									} else {
										seenNonNull = true;
										if (i > 0 && rows[i - 1].v !== null) {
											const prev = rows[i - 1].v;
											const curr = rows[i].v;
											if (typeof prev === typeof curr) {
												// Same runtime typeof guaranteed by the guard; cast is type-only.
												if ((prev as number) > (curr as number)) {
													throw new Error(
														`ORDER BY ASC violation: ${JSON.stringify(prev)} > ${JSON.stringify(curr)} in ${table.name}.${col.name}`
													);
												}
											}
										}
									}
								}
							}
						}
					} finally {
						await db.close();
					}
				}
			),
			{ numRuns: 100, endOnFailure: true, seed: FUZZ_SEED }
		);
	});
});

// ============================================================================
// Phase 4: Algebraic Identity Properties
// ============================================================================

describe('Algebraic Identities', function () {
	this.timeout(120_000);

	let db: Database;

	it('COUNT(*) matches iteration count', async function () {
		await fc.assert(
			fc.asyncProperty(
				arbSchemaInfo,
				fc.integer({ min: 0, max: 20 }),
				async (schema, rowCount) => {
					db = new Database();
					try {
						await setupSchema(db, schema, rowCount);
						for (const table of schema.tables) {
							const countRows = await tryCollectRows(db, `select count(*) as cnt from ${table.name}`);
							fc.pre(countRows !== null);
							const cnt = countRows![0].cnt as number;

							const allRows = await tryCollectRows(db, `select * from ${table.name}`);
							fc.pre(allRows !== null);

							if (cnt !== allRows!.length) {
								throw new Error(
									`COUNT(*) = ${cnt} but iteration yielded ${allRows!.length} rows for table ${table.name}`
								);
							}
						}
					} finally {
						await db.close();
					}
				}
			),
			{ numRuns: 100, endOnFailure: true, seed: FUZZ_SEED }
		);
	});

	it('SELECT DISTINCT results are unique', async function () {
		await fc.assert(
			fc.asyncProperty(
				arbSchemaInfo,
				fc.integer({ min: 1, max: 20 }),
				async (schema, rowCount) => {
					db = new Database();
					try {
						await setupSchema(db, schema, rowCount);
						for (const table of schema.tables) {
							for (const col of table.columns) {
								const rows = await tryCollectRows(
									db,
									`select distinct ${col.name} as v from ${table.name}`
								);
								if (rows === null) continue;
								const serialized = rows.map(r => JSON.stringify(r.v));
								const unique = new Set(serialized);
								if (unique.size !== serialized.length) {
									throw new Error(
										`DISTINCT returned duplicates for ${table.name}.${col.name}: ${serialized.length} rows, ${unique.size} unique`
									);
								}
							}
						}
					} finally {
						await db.close();
					}
				}
			),
			{ numRuns: 100, endOnFailure: true, seed: FUZZ_SEED }
		);
	});

	it('UNION deduplicates, UNION ALL does not', async function () {
		await fc.assert(
			fc.asyncProperty(
				arbSchemaInfo,
				fc.integer({ min: 1, max: 15 }),
				async (schema, rowCount) => {
					db = new Database();
					try {
						await setupSchema(db, schema, rowCount);
						for (const table of schema.tables) {
							const col = table.columns[0].name;
							const base = `select ${col} from ${table.name}`;

							const baseRows = await tryCollectRows(db, base);
							if (baseRows === null) continue;
							const baseCount = baseRows.length;

							// UNION ALL A, A should double the row count
							const unionAllRows = await tryCollectRows(db, `${base} union all ${base}`);
							if (unionAllRows === null) continue;
							if (unionAllRows.length !== 2 * baseCount) {
								throw new Error(
									`UNION ALL: expected ${2 * baseCount} rows, got ${unionAllRows.length} for ${table.name}.${col}`
								);
							}

							// UNION A, A should deduplicate, so count <= base count
							const unionRows = await tryCollectRows(db, `${base} union ${base}`);
							if (unionRows === null) continue;
							if (unionRows.length > baseCount) {
								throw new Error(
									`UNION: expected <= ${baseCount} rows, got ${unionRows.length} for ${table.name}.${col}`
								);
							}
						}

						// Cross-table: UNION count <= UNION ALL count
						if (schema.tables.length >= 2) {
							const t1 = schema.tables[0];
							const t2 = schema.tables[1];
							const a = `select cast(${t1.columns[0].name} as text) as v from ${t1.name}`;
							const b = `select cast(${t2.columns[0].name} as text) as v from ${t2.name}`;

							const unionAllRows = await tryCollectRows(db, `${a} union all ${b}`);
							const unionRows = await tryCollectRows(db, `${a} union ${b}`);
							if (unionAllRows !== null && unionRows !== null) {
								if (unionRows.length > unionAllRows.length) {
									throw new Error(
										`UNION row count (${unionRows.length}) > UNION ALL row count (${unionAllRows.length})`
									);
								}
							}
						}
					} finally {
						await db.close();
					}
				}
			),
			{ numRuns: 75, endOnFailure: true, seed: FUZZ_SEED }
		);
	});

	it('EXCEPT + INTERSECT = original (as sets)', async function () {
		// Use a schema generator that always produces 2+ tables
		const arbMultiTableSchema: fc.Arbitrary<SchemaInfo> = fc.integer({ min: 2, max: 3 }).chain(tableCount =>
			fc.tuple(...TABLE_NAMES.slice(0, tableCount).map(n => arbTableInfo(n)))
				.map(tables => ({ tables: [...tables] }))
		);

		await fc.assert(
			fc.asyncProperty(
				arbMultiTableSchema,
				fc.integer({ min: 1, max: 15 }),
				async (schema, rowCount) => {
					db = new Database();
					try {
						await setupSchema(db, schema, rowCount);

						const t1 = schema.tables[0];
						const t2 = schema.tables[1];
						const a = `select cast(${t1.columns[0].name} as text) as v from ${t1.name}`;
						const b = `select cast(${t2.columns[0].name} as text) as v from ${t2.name}`;

						// Get deduplicated A as the reference set
						const aRows = await tryCollectRows(
							db,
							`select distinct cast(${t1.columns[0].name} as text) as v from ${t1.name}`
						);
						if (aRows === null) return; // query errored, skip

						// (A except B) union (A intersect B) should equal distinct A
						const combinedRows = await tryCollectRows(
							db,
							`(${a} except ${b}) union (${a} intersect ${b})`
						);
						if (combinedRows === null) return; // query errored, skip

						const aSet = new Set(aRows.map(r => JSON.stringify(r.v)));
						const combinedSet = new Set(combinedRows.map(r => JSON.stringify(r.v)));

						if (aSet.size !== combinedSet.size) {
							throw new Error(
								`EXCEPT+INTERSECT set size ${combinedSet.size} != original set size ${aSet.size}`
							);
						}
						for (const v of aSet) {
							if (!combinedSet.has(v)) {
								throw new Error(`Value ${v} in original but not in EXCEPT+INTERSECT result`);
							}
						}
					} finally {
						await db.close();
					}
				}
			),
			{ numRuns: 75, endOnFailure: true, seed: FUZZ_SEED }
		);
	});

	it('A EXCEPT A returns zero rows', async function () {
		await fc.assert(
			fc.asyncProperty(
				arbSchemaInfo,
				fc.integer({ min: 0, max: 15 }),
				async (schema, rowCount) => {
					db = new Database();
					try {
						await setupSchema(db, schema, rowCount);
						for (const table of schema.tables) {
							const col = table.columns[0].name;
							const q = `select ${col} from ${table.name}`;
							const rows = await tryCollectRows(db, `${q} except ${q}`);
							if (rows === null) continue;
							if (rows.length !== 0) {
								throw new Error(
									`A EXCEPT A returned ${rows.length} rows for ${table.name}.${col}`
								);
							}
						}
					} finally {
						await db.close();
					}
				}
			),
			{ numRuns: 100, endOnFailure: true, seed: FUZZ_SEED }
		);
	});

	it('SUM consistency: aggregate matches manual sum', async function () {
		await fc.assert(
			fc.asyncProperty(
				arbSchemaInfo,
				fc.integer({ min: 0, max: 20 }),
				async (schema, rowCount) => {
					db = new Database();
					try {
						await setupSchema(db, schema, rowCount);
						for (const table of schema.tables) {
							for (const col of table.columns) {
								if (col.type !== 'integer' && col.type !== 'real') continue;

								const sumRows = await tryCollectRows(
									db,
									`select sum(${col.name}) as s from ${table.name}`
								);
								if (sumRows === null) continue;
								const sqlSum = sumRows[0].s;

								const valRows = await tryCollectRows(
									db,
									`select ${col.name} as v from ${table.name}`
								);
								if (valRows === null) continue;

								// Manual sum: exclude NULLs; all-NULL yields NULL
								const nonNulls = valRows
									.filter(r => r.v !== null)
									.map(r => r.v as number);

								if (nonNulls.length === 0) {
									if (sqlSum !== null) {
										throw new Error(
											`SUM of all NULLs should be NULL, got ${sqlSum} for ${table.name}.${col.name}`
										);
									}
								} else {
									const manualSum = nonNulls.reduce((acc, v) => acc + v, 0);
									if (typeof sqlSum !== 'number' || Math.abs(sqlSum - manualSum) > 1e-6) {
										throw new Error(
											`SUM mismatch: SQL=${sqlSum}, manual=${manualSum} for ${table.name}.${col.name}`
										);
									}
								}
							}
						}
					} finally {
						await db.close();
					}
				}
			),
			{ numRuns: 100, endOnFailure: true, seed: FUZZ_SEED }
		);
	});
});

// ============================================================================
// Phase 5: Optimizer Equivalence (Differential Testing)
// ============================================================================

describe('Optimizer Equivalence', function () {
	this.timeout(120_000);

	// Rule groups by category (rewrite rules only — safe to disable without
	// preventing physical plan generation)
	const PREDICATE_RULES = ['predicate-pushdown', 'filter-merge', 'filter-conjunct-ordering'];
	const JOIN_REWRITE_RULES = ['join-greedy-commute', 'join-key-inference'];
	const SUBQUERY_RULES = ['subquery-decorrelation'];
	const CACHE_RULES = ['mutating-subquery-cache', 'scalar-cse'];
	const DISTINCT_RULES = ['distinct-elimination'];

	// All rewrite rules combined for the catch-all test
	const ALL_REWRITE_RULES = [
		...PREDICATE_RULES,
		...JOIN_REWRITE_RULES,
		...SUBQUERY_RULES,
		...CACHE_RULES,
		...DISTINCT_RULES,
		'projection-pruning',
	];

	/**
	 * Create paired databases with identical schema and data.
	 * The restricted database has the specified rules disabled.
	 */
	async function createPairedDatabases(
		schema: SchemaInfo,
		rowCount: number,
		disabledRuleIds: string[],
	): Promise<[Database, Database]> {
		const dbFull = new Database();
		const dbRestricted = new Database();

		// Disable rules on restricted DB
		const baseTuning = dbRestricted.optimizer.tuning;
		dbRestricted.optimizer.updateTuning({
			...baseTuning,
			disabledRules: new Set(disabledRuleIds),
		});

		// Create identical schemas
		await createSchema(dbFull, schema);
		await createSchema(dbRestricted, schema);

		// Seed with identical data — verify both DBs agree on each insert.
		// Seeded per table (see FUZZ_SEED) so the paired DBs get identical data
		// and same-shaped tables don't collide on identical rows.
		for (let t = 0; t < schema.tables.length; t++) {
			const table = schema.tables[t];
			const rows = fc.sample(arbSeedRow(table), { numRuns: rowCount, seed: FUZZ_SEED + t });
			for (const sql of rows) {
				let fullOk = true;
				let restrictedOk = true;
				try { await dbFull.exec(sql); } catch (e) {
					if (!(e instanceof QuereusError)) throw e;
					fullOk = false;
				}
				try { await dbRestricted.exec(sql); } catch (e) {
					if (!(e instanceof QuereusError)) throw e;
					restrictedOk = false;
				}
				if (fullOk !== restrictedOk) {
					throw new Error(
						`Seeding diverged: insert ${fullOk ? 'succeeded' : 'failed'} on full but ` +
						`${restrictedOk ? 'succeeded' : 'failed'} on restricted\nSQL: ${sql}`
					);
				}
			}
		}

		return [dbFull, dbRestricted];
	}

	/**
	 * Compare result sets order-independently. Throws on mismatch.
	 * both-null (both errored) = OK; one-null = bug; both-non-null must match.
	 */
	function assertEqualResultSets(
		full: Record<string, unknown>[] | null,
		restricted: Record<string, unknown>[] | null,
		sql: string,
		ruleIds: string[],
	): void {
		if (full === null && restricted === null) return;

		if (full === null || restricted === null) {
			const which = full === null ? 'full (rules enabled)' : 'restricted (rules disabled)';
			throw new Error(
				`Only ${which} errored when disabling rules [${ruleIds.join(', ')}]\nSQL: ${sql}`
			);
		}

		// Sort rows by JSON serialization for order-independent comparison
		const normalize = (rows: Record<string, unknown>[]) =>
			rows.map(r => JSON.stringify(r)).sort();
		const s1 = normalize(full);
		const s2 = normalize(restricted);

		if (s1.length !== s2.length) {
			throw new Error(
				`Row count mismatch: ${s1.length} (full) vs ${s2.length} (restricted) ` +
				`when disabling rules [${ruleIds.join(', ')}]\nSQL: ${sql}`
			);
		}
		for (let i = 0; i < s1.length; i++) {
			if (s1[i] !== s2[i]) {
				throw new Error(
					`Row mismatch at sorted position ${i} when disabling rules [${ruleIds.join(', ')}]\n` +
					`Full:       ${s1[i]}\nRestricted: ${s2[i]}\nSQL: ${sql}`
				);
			}
		}
	}

	/**
	 * Run differential test: same queries on paired databases, compare results.
	 */
	async function runDifferentialTest(
		schema: SchemaInfo,
		rowCount: number,
		disabledRuleIds: string[],
		queryArbitrary: fc.Arbitrary<string>,
		queryCount: number,
	): Promise<void> {
		const [dbFull, dbRestricted] = await createPairedDatabases(schema, rowCount, disabledRuleIds);
		try {
			const queries = fc.sample(queryArbitrary, { numRuns: queryCount, seed: FUZZ_SEED });
			for (const sql of queries) {
				const fullResult = await tryCollectRows(dbFull, sql);
				const restrictedResult = await tryCollectRows(dbRestricted, sql);
				assertEqualResultSets(fullResult, restrictedResult, sql, disabledRuleIds);
			}
		} finally {
			await dbFull.close();
			await dbRestricted.close();
		}
	}

	it('predicate pushdown rules produce identical results', async function () {
		await fc.assert(
			fc.asyncProperty(
				arbSchemaInfo,
				fc.integer({ min: 5, max: 15 }),
				async (schema, rowCount) => {
					const arbs = buildSqlArbitraries(schema);
					await runDifferentialTest(
						schema, rowCount, PREDICATE_RULES,
						arbs.select as fc.Arbitrary<string>, 5,
					);
				}
			),
			{ numRuns: 25, endOnFailure: true, seed: FUZZ_SEED }
		);
	});

	it('join rewrite rules produce identical results', async function () {
		await fc.assert(
			fc.asyncProperty(
				arbSchemaInfo,
				fc.integer({ min: 5, max: 15 }),
				async (schema, rowCount) => {
					const arbs = buildSqlArbitraries(schema);
					await runDifferentialTest(
						schema, rowCount, JOIN_REWRITE_RULES,
						arbs.select as fc.Arbitrary<string>, 5,
					);
				}
			),
			{ numRuns: 25, endOnFailure: true, seed: FUZZ_SEED }
		);
	});

	it('subquery decorrelation produces identical results', async function () {
		await fc.assert(
			fc.asyncProperty(
				arbSchemaInfo,
				fc.integer({ min: 5, max: 15 }),
				async (schema, rowCount) => {
					const arbs = buildSqlArbitraries(schema);
					await runDifferentialTest(
						schema, rowCount, SUBQUERY_RULES,
						arbs.select as fc.Arbitrary<string>, 5,
					);
				}
			),
			{ numRuns: 25, endOnFailure: true, seed: FUZZ_SEED }
		);
	});

	it('cache/CTE rules produce identical results', async function () {
		await fc.assert(
			fc.asyncProperty(
				arbSchemaInfo,
				fc.integer({ min: 5, max: 15 }),
				async (schema, rowCount) => {
					const arbs = buildSqlArbitraries(schema);
					const queryArb = fc.oneof(
						arbs.cte as fc.Arbitrary<string>,
						arbs.select as fc.Arbitrary<string>,
					);
					await runDifferentialTest(
						schema, rowCount, CACHE_RULES,
						queryArb, 5,
					);
				}
			),
			{ numRuns: 25, endOnFailure: true, seed: FUZZ_SEED }
		);
	});

	it('distinct elimination produces identical results', async function () {
		await fc.assert(
			fc.asyncProperty(
				arbSchemaInfo,
				fc.integer({ min: 5, max: 15 }),
				async (schema, rowCount) => {
					const arbs = buildSqlArbitraries(schema);
					await runDifferentialTest(
						schema, rowCount, DISTINCT_RULES,
						arbs.select as fc.Arbitrary<string>, 5,
					);
				}
			),
			{ numRuns: 25, endOnFailure: true, seed: FUZZ_SEED }
		);
	});

	it('all rewrite rules disabled produces identical results', async function () {
		await fc.assert(
			fc.asyncProperty(
				arbSchemaInfo,
				fc.integer({ min: 5, max: 15 }),
				async (schema, rowCount) => {
					const arbs = buildSqlArbitraries(schema);
					const queryArb = fc.oneof(
						arbs.select as fc.Arbitrary<string>,
						arbs.cte as fc.Arbitrary<string>,
						arbs.windowSelect as fc.Arbitrary<string>,
					);
					await runDifferentialTest(
						schema, rowCount, ALL_REWRITE_RULES,
						queryArb, 5,
					);
				}
			),
			{ numRuns: 20, endOnFailure: true, seed: FUZZ_SEED }
		);
	});
});

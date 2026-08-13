/**
 * One-off measurement harness for ticket apply-schema-migration-plan-representation.
 * Splits `apply schema` wall time into: diff+render, DDL re-lex/parse,
 * plan (build+optimize), and emit+run. NOT part of the bench suite — delete after
 * the numbers are recorded.
 *
 * Run: node bench/apply-schema-split.mjs [colsPerTable] (requires a built dist/)
 */
import { Database } from '../dist/src/core/database.js';
import { Parser } from '../dist/src/parser/parser.js';
import { collectSchemaCatalog } from '../dist/src/schema/catalog.js';
import { computeSchemaDiff, generateMigrationDDL } from '../dist/src/schema/schema-differ.js';

const TABLES = 54;
const VIEWS = 14;
const EXTRA_COLS = Number(process.argv[2] ?? 0);
const RUNS = 7;

function buildDeclaration() {
	const parts = [];
	for (let t = 0; t < TABLES; t++) {
		const cols = [
			'id INTEGER PRIMARY KEY',
			'name TEXT NOT NULL',
			'email TEXT',
			'qty INTEGER NOT NULL DEFAULT 0',
			'price REAL DEFAULT 1.5',
			'note TEXT COLLATE NOCASE',
			'active INTEGER NOT NULL DEFAULT 1',
			'created TEXT',
		];
		for (let c = 0; c < EXTRA_COLS; c++) {
			cols.push(`attribute_column_${c} TEXT DEFAULT 'placeholder value ${c}'`);
		}
		const constraints = [`constraint ck_${t}_qty check (qty >= 0)`];
		if (t > 0) {
			cols.push(`parent_id INTEGER`);
			constraints.push(`constraint fk_${t}_parent foreign key (parent_id) references tbl_${t - 1}(id)`);
		}
		parts.push(`\ttable tbl_${t} {\n\t\t${[...cols, ...constraints].join(',\n\t\t')}\n\t}`);
	}
	for (let v = 0; v < VIEWS; v++) {
		parts.push(`\tview vw_${v} as select a.id, a.name, b.qty from tbl_${v} a join tbl_${v + 1} b on b.parent_id = a.id where a.active = 1 and b.qty > 0`);
	}
	return `declare schema main {\n${parts.join('\n\n')}\n}`;
}

const ms = (ns) => Number(ns) / 1e6;

/** One apply on a fresh Database, instrumented. Returns per-leg nanosecond totals. */
async function timedApply(declaration) {
	const db = new Database();

	let planNs = 0n;
	let parseNs = 0n;
	let parseCalls = 0;

	// TS `private` is compile-time only, so these are ordinary runtime properties.
	const realBuildPlan = db._buildPlan.bind(db);
	db._buildPlan = (...args) => {
		const t = process.hrtime.bigint();
		try { return realBuildPlan(...args); } finally { planNs += process.hrtime.bigint() - t; }
	};
	const optimizer = db.optimizer;
	const realOptimize = optimizer.optimize.bind(optimizer);
	optimizer.optimize = (...args) => {
		const t = process.hrtime.bigint();
		try { return realOptimize(...args); } finally { planNs += process.hrtime.bigint() - t; }
	};
	const realParseSql = db._parseSql.bind(db);
	db._parseSql = (sql) => {
		const t = process.hrtime.bigint();
		try { return realParseSql(sql); } finally { parseNs += process.hrtime.bigint() - t; parseCalls++; }
	};

	await db.exec(declaration);

	// Reset: only the apply leg counts.
	planNs = 0n; parseNs = 0n; parseCalls = 0;

	const t0 = process.hrtime.bigint();
	await db.exec('apply schema main');
	const totalNs = process.hrtime.bigint() - t0;

	await db.close();
	return { totalNs, planNs, parseNs, parseCalls };
}

async function main() {
	const declaration = buildDeclaration();
	console.log(`declaration: ${TABLES} tables, ${VIEWS} views, ${(declaration.length / 1024).toFixed(1)} KB`);

	for (let i = 0; i < 3; i++) await timedApply(declaration); // warm JIT

	const runs = [];
	for (let i = 0; i < RUNS; i++) runs.push(await timedApply(declaration));
	const median = (pick) => {
		const v = runs.map(pick).map(Number).sort((a, b) => a - b);
		return v[Math.floor(v.length / 2)];
	};
	const totalNs = median(r => r.totalNs);
	const planNs = median(r => r.planNs);
	const parseNs = median(r => r.parseNs);

	// Out-of-band: diff+render cost, and raw lex+parse over exactly those statements.
	const fresh = new Database();
	await fresh.exec(declaration);
	const declared = fresh.declaredSchemaManager.getDeclaredSchema('main');
	const collation = fresh.options.getStringOption('default_collation');

	let ddl = [];
	const diffSamples = [];
	for (let i = 0; i < 7; i++) {
		const catalog = collectSchemaCatalog(fresh, 'main');
		const t = process.hrtime.bigint();
		const d = computeSchemaDiff(declared, catalog, 'allow', collation);
		ddl = generateMigrationDDL(d, 'main');
		diffSamples.push(Number(process.hrtime.bigint() - t));
	}
	diffSamples.sort((a, b) => a - b);
	const diffNs = diffSamples[3];

	const parser = new Parser();
	const parseSamples = [];
	for (let i = 0; i < 7; i++) {
		const t = process.hrtime.bigint();
		for (const s of ddl) parser.parseAll(s);
		parseSamples.push(Number(process.hrtime.bigint() - t));
	}
	parseSamples.sort((a, b) => a - b);
	const rawParseNs = parseSamples[3];

	const total = ms(totalNs);
	const pct = (n) => `${(ms(n) / total * 100).toFixed(1)}%`;
	console.log(`\nstatements generated: ${ddl.length} (${ddl.reduce((a, s) => a + s.length, 0)} chars of DDL)`);
	console.log(`\napply schema total (median of ${RUNS}): ${total.toFixed(2)} ms`);
	console.log(`  diff + render DDL:       ${ms(diffNs).toFixed(2)} ms  (${pct(diffNs)})   [out-of-band]`);
	console.log(`  re-lex + re-parse DDL:   ${ms(parseNs).toFixed(2)} ms  (${pct(parseNs)})   [in-apply, ${runs[0].parseCalls} calls]`);
	console.log(`  raw parse of same DDL:   ${ms(rawParseNs).toFixed(2)} ms  (${pct(rawParseNs)})   [out-of-band cross-check]`);
	console.log(`  plan (build + optimize): ${ms(planNs).toFixed(2)} ms  (${pct(planNs)})`);
	const rest = total - ms(parseNs) - ms(planNs) - ms(diffNs);
	console.log(`  emit + run + rest:       ${rest.toFixed(2)} ms  (${(rest / total * 100).toFixed(1)}%)`);

	await fresh.close();
}

main().catch(e => { console.error(e); process.exit(1); });

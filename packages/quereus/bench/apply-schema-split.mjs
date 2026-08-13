/**
 * One-off measurement harness for ticket apply-schema-migration-plan-representation.
 * Splits `apply schema` wall time into: diff+render, DDL re-lex/parse,
 * plan (build+optimize), and emit+run. NOT part of the bench suite — the sibling
 * ticket apply-schema-unchanged-fast-path measures against it too; delete once that
 * one lands and its numbers are recorded.
 *
 * Run: node bench/apply-schema-split.mjs [colsPerTable] (requires a built dist/)
 */
import { Database } from '../dist/src/core/database.js';
import { Parser } from '../dist/src/parser/parser.js';
import { collectSchemaCatalog } from '../dist/src/schema/catalog.js';
import { computeSchemaDiff, generateMigrationDDL, generateMigrationPlan } from '../dist/src/schema/schema-differ.js';
import { spineCloneAst } from '../dist/src/util/ast-spine-clone.js';

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

/**
 * A/B of the migration loop alone — the only thing the plan-representation change
 * touched. `mode: 'ast'` is today's apply path (execute each plan step's statement
 * AST when it has one); `mode: 'text'` reproduces the pre-change path exactly
 * (parse the rendered DDL, then execute). Catalog collection, diff and render are
 * identical in both arms, so the delta between them IS the removed re-lex/re-parse
 * leg — measured on one machine, in one process, at the same JIT state.
 *
 * Runs outside `emitApplySchema`'s mutex / statement machinery and skips the
 * module batch hooks, so these totals sit slightly below `apply schema total`
 * above. Compare the two arms to each other, not to that number.
 */
async function timedMigrateLoop(declaration, mode) {
	const db = new Database();
	await db.exec(declaration);
	const declared = db.declaredSchemaManager.getDeclaredSchema('main');
	const collation = db.options.getStringOption('default_collation');

	let parseNs = 0n;
	const realParseSql = db._parseSql.bind(db);
	db._parseSql = (sql) => {
		const t = process.hrtime.bigint();
		try { return realParseSql(sql); } finally { parseNs += process.hrtime.bigint() - t; }
	};

	const t0 = process.hrtime.bigint();
	const diff = computeSchemaDiff(declared, collectSchemaCatalog(db, 'main'), 'allow', collation);
	const plan = generateMigrationPlan(diff, 'main');
	for (const step of plan) {
		// Mirrors `runBatchedMigrationLoop`, spine clone included — the clone is part of
		// the AST path's cost, not an optimization the harness may skip.
		if (mode === 'ast' && step.ast) await db._execAstWithinTransaction([spineCloneAst(step.ast)]);
		else await db._execWithinTransaction(step.sql);
	}
	const totalNs = process.hrtime.bigint() - t0;

	await db.close();
	return { totalNs, parseNs };
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

	// A/B the migration loop itself: today's AST path vs the pre-change text path.
	for (const mode of ['text', 'ast']) {
		for (let i = 0; i < 3; i++) await timedMigrateLoop(declaration, mode);
	}
	const loopRuns = { text: [], ast: [] };
	for (let i = 0; i < RUNS; i++) {
		for (const mode of ['text', 'ast']) loopRuns[mode].push(await timedMigrateLoop(declaration, mode));
	}
	const loopMedian = (mode, pick) => {
		const v = loopRuns[mode].map(pick).map(Number).sort((a, b) => a - b);
		return v[Math.floor(v.length / 2)];
	};
	const textTotal = ms(loopMedian('text', r => r.totalNs));
	const astTotal = ms(loopMedian('ast', r => r.totalNs));
	console.log(`\nmigration loop A/B (diff + render + execute; median of ${RUNS}, no mutex/batch-hook overhead):`);
	console.log(`  text path (pre-change):  ${textTotal.toFixed(2)} ms   parse leg ${ms(loopMedian('text', r => r.parseNs)).toFixed(2)} ms`);
	console.log(`  AST path (current):      ${astTotal.toFixed(2)} ms   parse leg ${ms(loopMedian('ast', r => r.parseNs)).toFixed(2)} ms`);
	console.log(`  delta:                   ${(textTotal - astTotal).toFixed(2)} ms  (${((1 - astTotal / textTotal) * 100).toFixed(1)}% of the text-path loop)`);
}

main().catch(e => { console.error(e); process.exit(1); });

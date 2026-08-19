/**
 * Acceptance harness for the `apply schema` applied-state fast path
 * (docs/schema.md § Applied-state snapshot).
 *
 * Times a NO-OP re-apply — `apply schema main` when the catalog already matches
 * the declaration — in both of its shapes, on one machine in one run:
 *
 *   - the **full-diff no-op**: pays `collectSchemaCatalog` + `computeSchemaDiff` +
 *     `generateMigrationPlan` in full. This is what EVERY no-op apply cost before
 *     the fast path landed. Forced here by poisoning the applied-state snapshot
 *     before each timed run, so it is measured warm and in the same process as
 *     the fast-pathed number (timing the genuine first re-apply instead would
 *     compare a cold sample against a warm median and overstate the win).
 *   - the **fast-pathed no-op**: both sides are re-rendered and compared; the
 *     diff and the plan are skipped.
 *
 * Then prices the pieces the fast path added (catalog render, declared render,
 * string compare) against the `computeSchemaDiff` it removed.
 *
 * NOT part of the bench suite. Run: node bench/apply-schema-unchanged.mjs [colsPerTable]
 * (requires a built dist/)
 *
 * NOTE: it stays ad hoc DELIBERATELY — decided, not pending. Folding it into
 * `bench/suites/` was considered and declined: this file is not an end-to-end benchmark
 * but a DECOMPOSITION. It times a no-op `apply schema` broken into the internal functions
 * the applied-state fast path removed (`computeSchemaDiff`, `generateMigrationPlan`),
 * added (`renderCatalogForComparison` plus an exact string compare) and still pays
 * (`collectSchemaCatalog`), and it deliberately poisons the applied-state snapshot between
 * runs so the pre-fast-path shape is measured warm and in-process. The bench framework
 * times exactly one `fn` per benchmark and cannot express that: forcing it in would keep
 * one number and lose the five that make it useful. Its figures are quoted in
 * `docs/schema.md` as a one-off measurement, not as a tracked series.
 *
 * Giving the fast path a STANDING, ratio-guarded benchmark is a different and larger
 * piece of work — a fast-pathed apply against a forced full-diff apply, guarded by their
 * ratio — and is parked as `feat-bench-apply-schema-fastpath-guard` in the backlog. It
 * would live alongside this file rather than replace it.
 */
import { Database } from '../dist/src/core/database.js';
import { collectSchemaCatalog } from '../dist/src/schema/catalog.js';
import { renderCatalogForComparison } from '../dist/src/schema/catalog-rendering.js';
import { computeSchemaDiff, generateMigrationPlan } from '../dist/src/schema/schema-differ.js';
import { renderDeclaredSchemaCanonical, computeSchemaHash } from '../dist/src/schema/schema-hasher.js';

const TABLES = 54;
const VIEWS = 14;
const EXTRA_COLS = Number(process.argv[2] ?? 0);
const RUNS = 9;

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
const med = (xs) => { const v = [...xs].map(Number).sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };
const time = (fn) => { const t = process.hrtime.bigint(); const r = fn(); return [process.hrtime.bigint() - t, r]; };
const timeAsync = async (fn) => { const t = process.hrtime.bigint(); const r = await fn(); return [process.hrtime.bigint() - t, r]; };

async function main() {
	const declaration = buildDeclaration();
	console.log(`declaration: ${TABLES} tables, ${VIEWS} views, ${(declaration.length / 1024).toFixed(1)} KB`);

	const db = new Database();
	await db.exec(declaration);
	// Apply #1 migrates (creates everything) — records no snapshot.
	await db.exec('apply schema main');
	if (db.declaredSchemaManager.getAppliedSnapshot('main')) {
		throw new Error('expected the migrating apply to record no snapshot');
	}

	// Apply #2 diffs, finds nothing, and records.
	await db.exec('apply schema main');
	if (!db.declaredSchemaManager.getAppliedSnapshot('main')) {
		throw new Error('expected the verified-no-op apply to record a snapshot');
	}

	const declared = db.declaredSchemaManager.getDeclaredSchema('main');
	const collation = db.options.getStringOption('default_collation');

	/** Forces the next apply onto the full-diff path by recording renderings that cannot match. */
	const poisonSnapshot = () => db.declaredSchemaManager.setAppliedSnapshot('main', {
		declaredRendering: '', catalogRendering: '', defaultCollation: '',
	});

	// Warm the fast path and every leg measured below.
	for (let i = 0; i < 5; i++) {
		await db.exec('apply schema main');
		poisonSnapshot();
		await db.exec('apply schema main');
		const c = collectSchemaCatalog(db, 'main');
		computeSchemaDiff(declared, c, 'allow', collation);
		renderCatalogForComparison(c);
		renderDeclaredSchemaCanonical(declared);
		computeSchemaHash(declared);
	}

	const fastNs = [], slowNs = [], collectNs = [], diffNs = [], planNs = [], catRenderNs = [], declRenderNs = [], cmpNs = [], hashNs = [];
	let prevText = '';
	let stepCount = 0, catalogSize = 0, declaredSize = 0;
	for (let i = 0; i < RUNS; i++) {
		fastNs.push((await timeAsync(() => db.exec('apply schema main')))[0]);

		// Same statement, same catalog, snapshot forced to miss → the pre-change cost.
		poisonSnapshot();
		slowNs.push((await timeAsync(() => db.exec('apply schema main')))[0]);

		const [cNs, catalog] = time(() => collectSchemaCatalog(db, 'main'));
		collectNs.push(cNs);
		const [dNs, diff] = time(() => computeSchemaDiff(declared, catalog, 'allow', collation));
		diffNs.push(dNs);
		const [pNs, steps] = time(() => generateMigrationPlan(diff, 'main'));
		planNs.push(pNs);
		stepCount = steps.length;

		const [rNs, text] = time(() => renderCatalogForComparison(catalog));
		catRenderNs.push(rNs);
		catalogSize = text.length;
		cmpNs.push(time(() => text === prevText)[0]);
		prevText = text;

		const [drNs, declText] = time(() => renderDeclaredSchemaCanonical(declared));
		declRenderNs.push(drNs);
		declaredSize = declText.length;

		hashNs.push(time(() => computeSchemaHash(declared))[0]);
	}

	const full = ms(med(slowNs));
	const fast = ms(med(fastNs));
	console.log(`\nmigration steps on the unchanged re-apply: ${stepCount} (expected 0)`);
	console.log(`rendered catalog: ${(catalogSize / 1024).toFixed(1)} KB; rendered declaration: ${(declaredSize / 1024).toFixed(1)} KB`);
	console.log(`  (both strings are retained per schema for as long as the declaration lives)`);

	console.log(`\nno-op \`apply schema main\` (median of ${RUNS} each, interleaved):`);
	console.log(`  full-diff:   ${full.toFixed(2)} ms`);
	console.log(`  fast-pathed: ${fast.toFixed(2)} ms   (${((1 - fast / full) * 100).toFixed(0)}% off)`);

	console.log(`\nwhat the fast path removes (measured out-of-band, same inputs):`);
	console.log(`  computeSchemaDiff:       ${ms(med(diffNs)).toFixed(2)} ms`);
	console.log(`  generateMigrationPlan:   ${ms(med(planNs)).toFixed(2)} ms`);
	console.log(`what it adds:`);
	console.log(`  renderCatalogForComparison: ${ms(med(catRenderNs)).toFixed(2)} ms`);
	console.log(`  exact string compare:       ${ms(med(cmpNs)).toFixed(3)} ms`);
	console.log(`what it still pays:`);
	console.log(`  collectSchemaCatalog:    ${ms(med(collectNs)).toFixed(2)} ms`);
	console.log(`\nmemoized once per \`declare schema\` (not on the fast path):`);
	console.log(`  renderDeclaredSchemaCanonical: ${ms(med(declRenderNs)).toFixed(2)} ms   [ceiling input for the persisted-snapshot backlog ticket]`);
	console.log(`  computeSchemaHash (for scale): ${ms(med(hashNs)).toFixed(2)} ms   [same render over a tag-stripped copy, plus FNV-1a]`);

	await db.close();
}

main().catch(e => { console.error(e); process.exit(1); });

/**
 * One-off measurement harness for ticket apply-schema-unchanged-fast-path.
 * Measures the cost of a NO-OP re-apply (`apply schema main` when the catalog
 * already matches the declaration) and splits it into the legs a fast path could
 * skip: `collectSchemaCatalog`, `computeSchemaDiff`, `generateMigrationPlan`, plus
 * the statement floor (parse + plan + emit) that no fast path can remove.
 *
 * Then prices the three candidate "nothing changed" signals against each other:
 * a declared-side schema hash, a both-sides catalog content fingerprint (split
 * into collect / render / hash legs), and a live-object identity snapshot.
 *
 * NOT part of the bench suite. Run: node bench/apply-schema-unchanged.mjs [colsPerTable]
 * (requires a built dist/)
 */
import { Database } from '../dist/src/core/database.js';
import { collectSchemaCatalog } from '../dist/src/schema/catalog.js';
import { computeSchemaDiff, generateMigrationPlan } from '../dist/src/schema/schema-differ.js';
import { computeSchemaHash } from '../dist/src/schema/schema-hasher.js';
import { fnv1aHash, toBase64Url } from '../dist/src/util/hash.js';

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

/** The canonical string a both-sides catalog fingerprint would hash. */
function renderCatalog(cat) {
	return [
		...cat.tables.map(t => `${t.ddl}${JSON.stringify(t.tags ?? null)}${t.namedConstraints.map(c => `${c.name}${c.definition}${JSON.stringify(c.tags ?? null)}`).join('')}${JSON.stringify(t.maintained ? { h: t.maintained.bodyHash, m: t.maintained.backingModuleName ?? null, a: t.maintained.backingModuleArgs ?? null } : null)}`),
		...cat.views.map(v => `${v.name}${v.definition}${JSON.stringify(v.tags ?? null)}`),
		...cat.indexes.map(x => `${x.name}${x.tableName}${x.definition}${JSON.stringify(x.tags ?? null)}${x.implicit ? 1 : 0}`),
		...cat.assertions.map(a => `${a.name}${a.definition}`),
	].join('\n');
}

/** Reference snapshot of the live schema objects — no rendering, no hashing. */
function identitySnapshot(db) {
	const schema = db.schemaManager.getSchema('main');
	const refs = [];
	for (const t of schema.getAllTables()) {
		refs.push(t);
		if (t.indexes) for (const i of t.indexes) refs.push(i);
	}
	for (const v of schema.getAllViews()) refs.push(v);
	for (const a of schema.getAllAssertions()) refs.push(a);
	return refs;
}

function refsEqual(a, b) {
	if (!a || !b || a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

/** A db with the declaration applied once, so every later apply is a no-op. */
async function settledDb(declaration) {
	const db = new Database();
	await db.exec(declaration);
	await db.exec('apply schema main');
	return db;
}

async function main() {
	const declaration = buildDeclaration();
	console.log(`declaration: ${TABLES} tables, ${VIEWS} views, ${(declaration.length / 1024).toFixed(1)} KB`);

	const db = await settledDb(declaration);
	const declared = db.declaredSchemaManager.getDeclaredSchema('main');
	const collation = db.options.getStringOption('default_collation');

	// Warm.
	for (let i = 0; i < 5; i++) {
		await db.exec('apply schema main');
		const c = collectSchemaCatalog(db, 'main');
		computeSchemaDiff(declared, c, 'allow', collation);
		computeSchemaHash(declared);
		toBase64Url(fnv1aHash(renderCatalog(c)));
		identitySnapshot(db);
	}

	const totals = [], collectNs = [], diffNs = [], planNs = [], hashNs = [], renderNs = [], fnvNs = [], cmpNs = [], identNs = [];
	let prevText = '';
	let stepCount = 0, catalogSize = 0, refCount = 0, identStable = true;
	let prevRefs = identitySnapshot(db);
	for (let i = 0; i < RUNS; i++) {
		const t = process.hrtime.bigint();
		await db.exec('apply schema main');
		totals.push(process.hrtime.bigint() - t);

		const [cNs, catalog] = time(() => collectSchemaCatalog(db, 'main'));
		collectNs.push(cNs);
		const [dNs, diff] = time(() => computeSchemaDiff(declared, catalog, 'allow', collation));
		diffNs.push(dNs);
		const [pNs, steps] = time(() => generateMigrationPlan(diff, 'main'));
		planNs.push(pNs);
		stepCount = steps.length;

		hashNs.push(time(() => computeSchemaHash(declared))[0]);

		const [rNs, text] = time(() => renderCatalog(catalog));
		renderNs.push(rNs);
		catalogSize = text.length;
		fnvNs.push(time(() => toBase64Url(fnv1aHash(text)))[0]);

		// Exact-string compare against the previously rendered catalog — the
		// collision-free alternative to hashing it.
		cmpNs.push(time(() => text === prevText)[0]);
		prevText = text;

		const [iNs, refs] = time(() => identitySnapshot(db));
		identNs.push(iNs);
		refCount = refs.length;
		if (!refsEqual(refs, prevRefs)) identStable = false;
		prevRefs = refs;
	}

	const total = ms(med(totals));
	const pct = (n) => `${(ms(n) / total * 100).toFixed(1)}%`;
	console.log(`\nmigration steps on the unchanged re-apply: ${stepCount} (expected 0)`);
	console.log(`rendered catalog size: ${(catalogSize / 1024).toFixed(1)} KB; live schema objects: ${refCount}`);
	console.log(`object identities stable across ${RUNS} no-op applies: ${identStable}`);
	console.log(`\nno-op \`apply schema main\` total (median of ${RUNS}): ${total.toFixed(2)} ms`);
	console.log(`  collectSchemaCatalog:    ${ms(med(collectNs)).toFixed(2)} ms  (${pct(med(collectNs))})`);
	console.log(`  computeSchemaDiff:       ${ms(med(diffNs)).toFixed(2)} ms  (${pct(med(diffNs))})`);
	console.log(`  generateMigrationPlan:   ${ms(med(planNs)).toFixed(2)} ms  (${pct(med(planNs))})`);
	const floor = total - ms(med(collectNs)) - ms(med(diffNs)) - ms(med(planNs));
	console.log(`  statement floor (rest):  ${floor.toFixed(2)} ms  (${(floor / total * 100).toFixed(1)}%)   [parse+plan+emit of the apply stmt itself]`);
	console.log(`\ncandidate fast-path signals:`);
	console.log(`  declared-side computeSchemaHash:  ${ms(med(hashNs)).toFixed(2)} ms   [uncached; memoizable at declare time]`);
	console.log(`  catalog fingerprint = collect ${ms(med(collectNs)).toFixed(2)} + render ${ms(med(renderNs)).toFixed(2)} + fnv ${ms(med(fnvNs)).toFixed(2)} = ${(ms(med(collectNs)) + ms(med(renderNs)) + ms(med(fnvNs))).toFixed(2)} ms`);
	console.log(`  catalog render + exact compare:   collect ${ms(med(collectNs)).toFixed(2)} + render ${ms(med(renderNs)).toFixed(2)} + cmp ${ms(med(cmpNs)).toFixed(3)} = ${(ms(med(collectNs)) + ms(med(renderNs)) + ms(med(cmpNs))).toFixed(2)} ms`);
	console.log(`  live-object identity snapshot:    ${ms(med(identNs)).toFixed(3)} ms`);
	console.log(`  epoch-counter compare:            ~0 ms`);

	await db.close();
}

main().catch(e => { console.error(e); process.exit(1); });

import { describe, it } from 'mocha';
import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { Parser } from '../../src/parser/parser.js';
import { BuildTimeDependencyTracker, type PlanningContext } from '../../src/planner/planning-context.js';
import { GlobalScope } from '../../src/planner/scopes/global.js';
import { ParameterScope } from '../../src/planner/scopes/param.js';
import { propagate } from '../../src/planner/mutation/propagate.js';
import { keysOf } from '../../src/planner/util/fd-utils.js';
import type { SqlValue } from '../../src/common/types.js';
import type * as AST from '../../src/parser/ast.js';

/**
 * Cross-check gate for the `view_info()` updateability surface
 * (docs/view-updateability.md § Information Schema Surface).
 *
 * These tests assert *agreement* between the static surface and the two sources
 * it claims to mirror — they do not re-implement its logic:
 *
 *  - `effective_targets` must equal the distinct base set the view-mutation
 *    substrate's `propagate()` actually reaches for the view.
 *  - When the forward FD walk advertises a key on the view output (`keysOf`
 *    non-empty), `is_deletable` must be `'YES'` and that key must project onto
 *    each reachable base's primary key.
 */
describe('view_info() cross-checks', () => {
	function ctxFor(db: Database): PlanningContext {
		// Assemble a root planning context the same way Statement compilation does.
		const parameterScope = new ParameterScope(new GlobalScope(db.schemaManager));
		return {
			db,
			schemaManager: db.schemaManager,
			parameters: {},
			scope: parameterScope,
			cteNodes: new Map(),
			schemaDependencies: new BuildTimeDependencyTracker(),
			schemaCache: new Map(),
			cteReferenceCache: new Map(),
			outputScopes: new Map(),
		};
	}

	/** Read the single `view_info(name)` row as a column→value record. */
	async function viewInfoRow(db: Database, name: string): Promise<Record<string, SqlValue>> {
		const stmt = db.prepare(`select * from view_info('${name}')`);
		try {
			const cols = stmt.getColumnNames();
			let row: Record<string, SqlValue> | undefined;
			for await (const r of stmt.iterateRows()) {
				row = {};
				(r as SqlValue[]).forEach((v, i) => { row![cols[i]] = v; });
			}
			expect(row, `view_info('${name}') returned a row`).to.not.equal(undefined);
			return row!;
		} finally {
			await stmt.finalize();
		}
	}

	/** Distinct, sorted base-table names `propagate()` emits for an update statement. */
	function propagateBaseSet(db: Database, viewName: string, updateSql: string): string[] {
		const ctx = ctxFor(db);
		const view = db.schemaManager.getView('main', viewName);
		expect(view, `view '${viewName}' registered`).to.not.equal(undefined);
		const stmt = new Parser().parseAll(updateSql)[0] as AST.UpdateStmt;
		const ops = propagate(ctx, view!, { op: 'update', stmt });
		return [...new Set(ops.map(o => o.table.tableSchema.name))].sort();
	}

	it('single-source: effective_targets equals the base set propagate() reaches', async () => {
		const db = new Database();
		await db.exec(`create table t (id integer primary key, name text, color text)`);
		await db.exec(`create view gv as select id, name from t where color = 'green'`);

		const info = await viewInfoRow(db, 'gv');
		const reached = propagateBaseSet(db, 'gv', `update gv set name = 'x' where id = 1`);

		expect(info.effective_targets).to.equal('["t"]');
		expect(JSON.stringify(reached)).to.equal(info.effective_targets);
		await db.close();
	});

	it('multi-source join: effective_targets equals the base set propagate() reaches', async () => {
		const db = new Database();
		await db.exec(`create table ms_parent (pid integer primary key, label text)`);
		await db.exec(`create table ms_child (cid integer primary key, pref integer, note text,
			foreign key (pref) references ms_parent(pid))`);
		await db.exec(`create view ms_jv as
			select c.cid as cid, c.note as note, p.label as label
			from ms_child c join ms_parent p on p.pid = c.pref`);

		const info = await viewInfoRow(db, 'ms_jv');
		// Assign a column owned by EACH side so propagate fans out to both bases.
		const reached = propagateBaseSet(db, 'ms_jv', `update ms_jv set note = 'x', label = 'y' where cid = 1`);

		expect(info.effective_targets).to.equal('["ms_child","ms_parent"]');
		expect(JSON.stringify(reached)).to.equal(info.effective_targets);
		await db.close();
	});

	it('keysOf agreement: an advertised forward key ⇒ is_deletable=YES projecting onto the base PK', async () => {
		const db = new Database();
		await db.exec(`create table t (id integer primary key, name text)`);
		await db.exec(`create view v_identity as select id, name from t`);

		const view = db.schemaManager.getView('main', 'v_identity')!;
		const root = db._buildPlan([view.selectAst as AST.Statement]).plan.getRelations()[0];
		expect(root, 'view body planned to a relation').to.not.equal(undefined);

		const keys = keysOf(root);
		expect(keys.length, 'forward walk advertises a key').to.be.greaterThan(0);

		const info = await viewInfoRow(db, 'v_identity');
		expect(info.is_deletable).to.equal('YES');

		// Every advertised key column traces to the base PK column `id` through base lineage.
		const attrs = root.getAttributes();
		const lineage = root.physical?.updateLineage;
		for (const key of keys) {
			for (const colIdx of key) {
				const site = lineage?.get(attrs[colIdx].id);
				expect(site?.kind, `key column ${colIdx} has base lineage`).to.equal('base');
				expect(site && site.kind === 'base' ? site.baseColumn : undefined).to.equal('id');
			}
		}
		await db.close();
	});
});

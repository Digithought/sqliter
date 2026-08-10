import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database } from '../src/index.js';
import { assertNotMaintainedTableTarget } from '../src/runtime/emit/dml-executor.js';
import { QuereusError } from '../src/common/errors.js';
import { StatusCode } from '../src/common/types.js';

/**
 * Engine-level READONLY backstop for maintained tables, exercised directly at
 * the seam — the runtime DML executor's `assertNotMaintainedTableTarget`
 * (`runtime/emit/dml-executor.ts`). User DML naming a maintained table is
 * rewritten to write-through at plan time, so a mutation plan whose target still
 * carries a derivation can only be a plan-time mis-dispatch; the backstop turns
 * that whole bug class into a loud READONLY error keyed structurally on
 * `derivation` presence (never on the table name).
 *
 * The backstop is deliberately unreachable from SQL on the supported path
 * (dispatch routes every reachable spelling away from it — pinned end-to-end by
 * `mv-cross-schema-dispatch.spec.ts` and `53.1`/`51.7`), so the honest pin is
 * the exported guard exercised against a real derivation-bearing schema plus the
 * one wiring call site in `emitDmlExecutor`.
 */
describe('Maintained-table READONLY backstop (DML executor guard)', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table src (id integer primary key, v integer)');
		await db.exec('insert into src values (1, 10)');
		await db.exec('create materialized view mv as select id, v from src');
	});
	afterEach(async () => { await db.close(); });

	it('throws READONLY naming the schema-qualified table for a derivation-bearing schema', () => {
		const maintained = db.schemaManager.getMaintainedTable('main', 'mv');
		expect(maintained, 'maintained table resolved').to.not.be.undefined;

		let err: unknown;
		try {
			assertNotMaintainedTableTarget(maintained!);
		} catch (e) {
			err = e;
		}
		expect(err, 'guard threw').to.be.instanceOf(QuereusError);
		expect((err as QuereusError).code, 'READONLY status').to.equal(StatusCode.READONLY);
		expect((err as QuereusError).message, 'names the schema-qualified table').to.contain('main.mv');
		expect((err as QuereusError).message, 'explains the derived-contents reason').to.contain('maintained table');
	});

	it('does not throw for a plain (derivation-less) table schema', () => {
		const src = db.schemaManager.getTable('main', 'src');
		expect(src, 'plain table resolved').to.not.be.undefined;
		expect(src!.derivation, 'plain table carries no derivation').to.be.undefined;
		expect(() => assertNotMaintainedTableTarget(src!)).to.not.throw();
	});

	it('stops throwing once the derivation is detached (structural keying, not by name)', async () => {
		// `drop maintained` is a catalog-only flip: the same name `mv` is now an
		// ordinary, user-writable table with no derivation, so the guard — keyed on
		// `derivation` presence — must let it pass.
		await db.exec('alter table mv drop maintained');
		const detached = db.schemaManager.getTable('main', 'mv');
		expect(detached, 'table survives the detach').to.not.be.undefined;
		expect(detached!.derivation, 'derivation shed by detach').to.be.undefined;
		expect(() => assertNotMaintainedTableTarget(detached!)).to.not.throw();
	});
});

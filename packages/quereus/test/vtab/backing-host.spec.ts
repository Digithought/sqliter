import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { MemoryTableModule } from '../../src/vtab/memory/module.js';
import { QuereusError } from '../../src/common/errors.js';
import { StatusCode } from '../../src/common/types.js';
import type { BackingHost } from '../../src/vtab/backing-host.js';
import type { Row } from '../../src/common/types.js';

/**
 * Direct contract coverage for the backing-host capability surface
 * (`vtab/backing-host.ts`) on its reference implementation, the memory module's
 * `getBackingHost`. The MV suites exercise this surface only implicitly through
 * the engine; these tests pin the contract points a second host implementation
 * (and the `USING <module>` follow-on) will be built against:
 *
 *  - capability resolution (a host for an owned table, undefined for an unknown one);
 *  - `ownsConnection` incarnation pinning (rejects another table's connection and a
 *    dropped+recreated incarnation's stale connection);
 *  - the INTERNAL guard on driving the privileged surface with a foreign connection;
 *  - `scanEffective` reads-own-writes (pending state visible on the writing
 *    connection, invisible to a fresh one), `equalityPrefix` ranging, `descending`;
 *  - `replaceContents` committed replacement + the `onDuplicateKey` diagnostic.
 */
describe('backing-host capability (memory reference implementation)', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		// Composite PK (a, b) so equalityPrefix has a leading column to range on.
		await db.exec("create table comp (a integer, b integer, v text, primary key (a, b)) using memory");
		await db.exec("insert into comp values (1,1,'a'),(1,2,'b'),(2,1,'c')");
	});
	afterEach(async () => { await db.close(); });

	function memoryModule(tableName = 'comp'): MemoryTableModule {
		const schema = db.schemaManager.getTable('main', tableName);
		expect(schema, `'${tableName}' table schema`).to.not.be.undefined;
		expect(schema!.vtabModule, `'${tableName}' module`).to.be.instanceOf(MemoryTableModule);
		return schema!.vtabModule as MemoryTableModule;
	}

	function resolveHost(tableName = 'comp'): BackingHost {
		const host = memoryModule(tableName).getBackingHost(db, 'main', tableName);
		expect(host, `backing host for '${tableName}'`).to.not.be.undefined;
		return host!;
	}

	async function collect(iter: AsyncIterable<Row>): Promise<Row[]> {
		const out: Row[] = [];
		for await (const r of iter) out.push(r);
		return out;
	}

	async function expectInternal(run: () => Promise<unknown> | unknown): Promise<void> {
		try {
			await run();
		} catch (e) {
			expect(e).to.be.instanceOf(QuereusError);
			expect((e as QuereusError).code).to.equal(StatusCode.INTERNAL);
			return;
		}
		expect.fail('expected a QuereusError with StatusCode.INTERNAL');
	}

	it('getBackingHost resolves a host for an owned table and undefined for an unknown one', () => {
		expect(resolveHost()).to.not.be.undefined;
		expect(memoryModule().getBackingHost(db, 'main', 'no_such_table')).to.be.undefined;
	});

	it("ownsConnection accepts this table's connections and rejects another table's", async () => {
		await db.exec('create table other (k integer primary key, v text) using memory');
		const compHost = resolveHost('comp');
		const otherHost = resolveHost('other');
		const compConn = compHost.connect();
		const otherConn = otherHost.connect();

		expect(compHost.ownsConnection(compConn)).to.equal(true);
		expect(otherHost.ownsConnection(otherConn)).to.equal(true);
		expect(compHost.ownsConnection(otherConn)).to.equal(false);
		expect(otherHost.ownsConnection(compConn)).to.equal(false);
	});

	it("a drop+recreate yields a new incarnation whose host rejects the old incarnation's connection", async () => {
		const oldHost = resolveHost();
		const oldConn = oldHost.connect();

		await db.exec('drop table comp');
		await db.exec('create table comp (a integer, b integer, v text, primary key (a, b)) using memory');

		const newHost = resolveHost();
		// The new incarnation must not adopt the stale connection…
		expect(newHost.ownsConnection(oldConn)).to.equal(false);
		await expectInternal(() => newHost.applyMaintenance(oldConn, [{ kind: 'upsert', row: [9, 9, 'z'] }]));
		// …while the old host stays pinned (by reference) to its own incarnation.
		expect(oldHost.ownsConnection(oldConn)).to.equal(true);
	});

	it('driving the privileged surface with a foreign connection throws INTERNAL', async () => {
		await db.exec('create table other (k integer primary key, v text) using memory');
		const compHost = resolveHost('comp');
		const otherConn = resolveHost('other').connect();

		await expectInternal(() => compHost.applyMaintenance(otherConn, []));
		await expectInternal(() => compHost.scanEffective(otherConn, {}));
	});

	it('applyMaintenance is reads-own-writes on the connection and invisible to a fresh one', async () => {
		const host = resolveHost();
		const conn = host.connect();

		const changes = await host.applyMaintenance(conn, [
			{ kind: 'upsert', row: [3, 1, 'z'] },
			{ kind: 'delete-key', key: [1, 2] },
		]);
		expect(changes).to.deep.equal([
			{ op: 'insert', newRow: [3, 1, 'z'] },
			{ op: 'delete', oldRow: [1, 2, 'b'] },
		]);

		// The writing connection's effective state reflects the pending ops…
		expect(await collect(host.scanEffective(conn, {}))).to.deep.equal(
			[[1, 1, 'a'], [2, 1, 'c'], [3, 1, 'z']]);
		// …while a fresh connection still sees only the committed state.
		expect(await collect(host.scanEffective(host.connect(), {}))).to.deep.equal(
			[[1, 1, 'a'], [1, 2, 'b'], [2, 1, 'c']]);
	});

	it('a value-identical upsert writes nothing and reports nothing (skip-identical contract)', async () => {
		const host = resolveHost();
		const conn = host.connect();

		// [1,2,'b'] is the committed row, byte-identical → suppressed: no reported
		// change, and the connection's effective state is untouched.
		const changes = await host.applyMaintenance(conn, [{ kind: 'upsert', row: [1, 2, 'b'] }]);
		expect(changes).to.deep.equal([]);
		expect(await collect(host.scanEffective(conn, {}))).to.deep.equal(
			[[1, 1, 'a'], [1, 2, 'b'], [2, 1, 'c']]);
	});

	it('the skip compares against the EFFECTIVE row (pending over committed), not committed-only', async () => {
		const host = resolveHost();
		const conn = host.connect();

		// A prior same-transaction write changes the row's pending image…
		expect(await host.applyMaintenance(conn, [{ kind: 'upsert', row: [1, 2, 'x'] }])).to.deep.equal(
			[{ op: 'update', oldRow: [1, 2, 'b'], newRow: [1, 2, 'x'] }]);
		// …so a second upsert back to the COMMITTED value is NOT a no-op relative to
		// pending: it must report (and apply) the update.
		expect(await host.applyMaintenance(conn, [{ kind: 'upsert', row: [1, 2, 'b'] }])).to.deep.equal(
			[{ op: 'update', oldRow: [1, 2, 'x'], newRow: [1, 2, 'b'] }]);
		expect(await collect(host.scanEffective(conn, { equalityPrefix: [1] }))).to.deep.equal(
			[[1, 1, 'a'], [1, 2, 'b']]);
	});

	it('a collation-equal / byte-different upsert is NOT suppressed (re-keys the stored bytes)', async () => {
		await db.exec("create table tc (name text collate nocase primary key, v integer) using memory");
		await db.exec("insert into tc values ('Apple', 1)");
		const host = resolveHost('tc');
		const conn = host.connect();

		// 'apple' NOCASE-matches the stored 'Apple' (key identity is collation-aware) but
		// value identity is byte-faithful, so this is a real update that replaces the
		// stored bytes — never a skip (see vtab/backing-host.ts § value-identical
		// suppression; contrast with replace-all's collation-aware wholesale diff).
		const changes = await host.applyMaintenance(conn, [{ kind: 'upsert', row: ['apple', 1] }]);
		expect(changes).to.deep.equal([{ op: 'update', oldRow: ['Apple', 1], newRow: ['apple', 1] }]);
		expect(await collect(host.scanEffective(conn, {}))).to.deep.equal([['apple', 1]]);
	});

	it('scanEffective honors equalityPrefix as a leading-PK range and descending order', async () => {
		const host = resolveHost();
		const conn = host.connect();

		expect(await collect(host.scanEffective(conn, { equalityPrefix: [1] }))).to.deep.equal(
			[[1, 1, 'a'], [1, 2, 'b']]);
		expect(await collect(host.scanEffective(conn, { equalityPrefix: [99] }))).to.deep.equal([]);
		expect(await collect(host.scanEffective(conn, { descending: true }))).to.deep.equal(
			[[2, 1, 'c'], [1, 2, 'b'], [1, 1, 'a']]);
	});

	it('replaceContents atomically replaces the committed contents', async () => {
		const host = resolveHost();
		await host.replaceContents([[5, 1, 'x'], [6, 1, 'y']]);
		expect(await collect(host.scanEffective(host.connect(), {}))).to.deep.equal(
			[[5, 1, 'x'], [6, 1, 'y']]);
	});

	it('replaceContents reports a duplicate PK through the onDuplicateKey factory', async () => {
		const host = resolveHost();
		try {
			await host.replaceContents(
				[[7, 1, 'x'], [7, 1, 'y']],
				() => new QuereusError('not a set', StatusCode.CONSTRAINT),
			);
			expect.fail('expected the onDuplicateKey error');
		} catch (e) {
			expect(e).to.be.instanceOf(QuereusError);
			expect((e as QuereusError).message).to.contain('not a set');
			expect((e as QuereusError).code).to.equal(StatusCode.CONSTRAINT);
		}
		// The failed replace must not have torn the committed contents.
		expect(await collect(host.scanEffective(host.connect(), {}))).to.deep.equal(
			[[1, 1, 'a'], [1, 2, 'b'], [2, 1, 'c']]);
	});
});

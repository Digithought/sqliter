import { describe, it, beforeEach } from 'mocha';
import { expect } from 'chai';
import { Database, MemoryTableModule } from '@quereus/quereus';
import type { TableSchema } from '@quereus/quereus';
import { IsolationModule } from '../src/index.js';

/**
 * Coverage for the three attach-lifecycle seam forwards added to
 * `IsolationModule` (`ensure`/`retire`/`discardBackingForAttach`). The engine
 * drives the maintained-table lifecycle against the REGISTERED (wrapped) module,
 * so the wrapper must (a) advertise each seam iff the underlying implements it —
 * presence IS the capability — and (b) delegate straight to the underlying with
 * the arguments unchanged and `this` bound to the underlying.
 *
 * The conformance suite proper has no spy reaching these seams through a wrap
 * (the in-`@quereus/quereus` discard-backing spec hits a bare `MemoryTableModule`),
 * so without this spec the forwards — including the presence-mirroring guard and
 * the `.call(this.underlying, …)` binding — are untested in-repo. Mirrors the spy
 * shape of `packages/quereus/test/materialized-view-discard-backing.spec.ts`.
 */

interface SeamCall {
	op: 'ensure' | 'retire' | 'discard';
	db: Database;
	schemaName: string;
	tableName: string;
	schema?: TableSchema;
}

/**
 * A memory module that records each attach-seam invocation (capturing the
 * received args and asserting `this` via `this.calls`). It does NOT override
 * `getBackingHost`, so memory still hosts the live table directly. The base
 * `MemoryTableModule` declares none of these methods, so these are additions.
 */
class SpyBackingModule extends MemoryTableModule {
	readonly calls: SeamCall[] = [];

	async ensureBackingForAttach(db: Database, schemaName: string, tableName: string, backingSchema: TableSchema): Promise<void> {
		this.calls.push({ op: 'ensure', db, schemaName, tableName, schema: backingSchema });
	}

	async retireBackingForAttach(db: Database, schemaName: string, tableName: string, plainSchema: TableSchema): Promise<void> {
		this.calls.push({ op: 'retire', db, schemaName, tableName, schema: plainSchema });
	}

	async discardBackingForAttach(db: Database, schemaName: string, tableName: string): Promise<void> {
		this.calls.push({ op: 'discard', db, schemaName, tableName });
	}
}

describe('IsolationModule attach-seam forwarding', () => {
	let db: Database;
	let tableSchema: TableSchema;

	beforeEach(async () => {
		db = new Database();
		db.registerModule('mem', new MemoryTableModule());
		await db.exec(`create table probe (id integer primary key, name text) using mem`);
		const schema = db.schemaManager.getTable('main', 'probe');
		expect(schema, 'probe table schema').to.exist;
		tableSchema = schema!;
	});

	describe('presence mirroring', () => {
		it('advertises all three seams when the underlying implements them', () => {
			const wrap = new IsolationModule({ underlying: new SpyBackingModule() });
			expect(wrap.ensureBackingForAttach, 'ensureBackingForAttach').to.be.a('function');
			expect(wrap.retireBackingForAttach, 'retireBackingForAttach').to.be.a('function');
			expect(wrap.discardBackingForAttach, 'discardBackingForAttach').to.be.a('function');
		});

		it('advertises none of the seams when the underlying omits them', () => {
			const wrap = new IsolationModule({ underlying: new MemoryTableModule() });
			expect(wrap.ensureBackingForAttach, 'ensureBackingForAttach').to.be.undefined;
			expect(wrap.retireBackingForAttach, 'retireBackingForAttach').to.be.undefined;
			expect(wrap.discardBackingForAttach, 'discardBackingForAttach').to.be.undefined;
		});
	});

	describe('delegation', () => {
		it('forwards ensure/retire with all four args, in order, to the underlying', async () => {
			const spy = new SpyBackingModule();
			const wrap = new IsolationModule({ underlying: spy });

			await wrap.ensureBackingForAttach!(db, 'main', 'probe', tableSchema);
			await wrap.retireBackingForAttach!(db, 'main', 'probe', tableSchema);

			expect(spy.calls).to.deep.equal([
				{ op: 'ensure', db, schemaName: 'main', tableName: 'probe', schema: tableSchema },
				{ op: 'retire', db, schemaName: 'main', tableName: 'probe', schema: tableSchema },
			]);
		});

		it('forwards discard with its three args to the underlying', async () => {
			const spy = new SpyBackingModule();
			const wrap = new IsolationModule({ underlying: spy });

			await wrap.discardBackingForAttach!(db, 'main', 'probe');

			expect(spy.calls).to.deep.equal([
				{ op: 'discard', db, schemaName: 'main', tableName: 'probe' },
			]);
		});

		// `.call(this.underlying, …)` is the only thing that keeps `this` pointing at
		// the spy inside the recorder; a bare `underlyingEnsure(…)` would leave `this`
		// undefined and `this.calls.push` would throw — so a clean run proves the bind.
		it('binds `this` to the underlying (no throw, recorder reachable)', async () => {
			const spy = new SpyBackingModule();
			const wrap = new IsolationModule({ underlying: spy });

			await wrap.ensureBackingForAttach!(db, 'main', 'probe', tableSchema);

			expect(spy.calls).to.have.lengthOf(1);
		});
	});
});

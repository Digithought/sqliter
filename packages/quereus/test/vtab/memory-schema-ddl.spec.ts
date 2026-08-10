/**
 * The memory module's object-lifecycle schema events carry canonical DDL.
 *
 * A schema event's `ddl` is what a replication layer ships to a peer and
 * re-executes there; an event with no `ddl` crosses the wire as an empty
 * statement and changes nothing on the receiver. The memory module previously
 * attached none to any of its four object-lifecycle events (create/drop table,
 * create/drop index), so a memory-backed table replicated nothing at all.
 *
 * There is no end-to-end sync harness for memory-backed tables, so these assert
 * the emitted event directly: each `ddl` must equal what the canonical generator
 * renders for the live schema — that byte-equality is what lets a receiver
 * recognize an object it already has instead of failing "already exists".
 *
 * The events only route through the module when it is constructed WITH an
 * emitter; the default `memory` module registered by `new Database()` has none,
 * so the engine's own `emitAutoSchemaEventIfNeeded` fallback covers it (that
 * fallback carries no DDL — see the NOTE at its definition in schema/manager.ts).
 */

import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { MemoryTableModule } from '../../src/vtab/memory/module.js';
import { DefaultVTableEventEmitter } from '../../src/vtab/events.js';
import type { VTableSchemaChangeEvent } from '../../src/vtab/events.js';
import { generateTableDDL, generateIndexDDL } from '../../src/schema/ddl-generator.js';

const MODULE = 'memory_events';
const CREATE_T = `create table t (id integer primary key, note text) using ${MODULE}`;

describe('memory module schema-change DDL', () => {
	let db: Database;
	let events: VTableSchemaChangeEvent[];

	beforeEach(() => {
		db = new Database();
		const emitter = new DefaultVTableEventEmitter();
		db.registerModule(MODULE, new MemoryTableModule(emitter));
		events = [];
		emitter.onSchemaChange(e => events.push(e));
	});

	afterEach(async () => {
		await db.close();
	});

	/** The single event the statement under test emitted (fails loudly on 0 or 2+). */
	function onlyEvent(): VTableSchemaChangeEvent {
		expect(events.map(e => `${e.type}/${e.objectType}/${e.objectName}`)).to.have.lengthOf(1);
		return events[0];
	}

	const liveTable = () => db.schemaManager.getTable('main', 't')!;
	const liveIndex = (name: string) =>
		liveTable().indexes!.find(i => i.name.toLowerCase() === name)!;

	it('attaches canonical CREATE TABLE ddl to the create event', async () => {
		await db.exec(CREATE_T);

		const event = onlyEvent();
		expect([event.type, event.objectType, event.objectName])
			.to.deep.equal(['create', 'table', 't']);
		expect(event.ddl).to.equal(generateTableDDL(liveTable()));
		expect(event.ddl).to.include('CREATE TABLE "main"."t"');
	});

	it('attaches canonical CREATE INDEX ddl to the add-index event', async () => {
		await db.exec(CREATE_T);
		events = [];

		await db.exec('create index idx_t_note on t (note)');

		const event = onlyEvent();
		expect([event.type, event.objectType, event.objectName])
			.to.deep.equal(['create', 'index', 'idx_t_note']);
		// Byte-equal to what a receiving peer regenerates from its own catalog.
		expect(event.ddl).to.equal(generateIndexDDL(liveIndex('idx_t_note'), liveTable()));
		expect(event.ddl).to.include('CREATE INDEX "idx_t_note" ON "main"."t"');
	});

	it('attaches a qualified DROP INDEX to the drop-index event', async () => {
		await db.exec(CREATE_T);
		await db.exec('create index idx_t_note on t (note)');
		events = [];

		await db.exec('drop index idx_t_note');

		const event = onlyEvent();
		expect([event.type, event.objectType, event.objectName])
			.to.deep.equal(['drop', 'index', 'idx_t_note']);
		expect(event.ddl).to.equal('drop index "main"."idx_t_note"');
	});

	it('attaches a qualified DROP TABLE to the drop-table event', async () => {
		await db.exec(CREATE_T);
		events = [];

		await db.exec('drop table t');

		const event = onlyEvent();
		expect([event.type, event.objectType, event.objectName])
			.to.deep.equal(['drop', 'table', 't']);
		expect(event.ddl).to.equal('drop table "main"."t"');
	});

	it('emits exactly one drop event when dropping a table that has an index', async () => {
		// Load-bearing for replication bookkeeping: the receiver registers ONE
		// remote-event expectation per migration and expectations never expire, so a
		// second (per-index) drop event would leak a local-looking event back onto
		// the wire.
		await db.exec(CREATE_T);
		await db.exec('create index idx_t_note on t (note)');
		events = [];

		await db.exec('drop table t');

		const event = onlyEvent();
		expect([event.type, event.objectType, event.objectName])
			.to.deep.equal(['drop', 'table', 't']);
	});

	it('re-parses its own DROP TABLE / DROP INDEX text', async () => {
		// The drop forms are compared by presence, not by text, so the only
		// requirement on them is that they execute on the receiver.
		await db.exec(CREATE_T);
		await db.exec('create index idx_t_note on t (note)');

		await db.exec('drop index "main"."idx_t_note"');
		expect(liveTable().indexes ?? []).to.deep.equal([]);

		await db.exec('drop table "main"."t"');
		expect(db.schemaManager.getTable('main', 't')).to.be.undefined;
	});
});

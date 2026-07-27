// Regression coverage for `fk-update-actions-fire-when-key-unchanged`:
// `executeForeignKeyActions` (src/runtime/foreign-key-actions.ts) used to re-issue the
// child DML for every ON UPDATE action (CASCADE / SET NULL / SET DEFAULT) after ANY
// parent row update, even when the column the child references never moved. A value-only
// assertion cannot see this for CASCADE — the child is rewritten to the value it already
// holds, so the final value is unchanged even though a write (and a data-change event)
// fired. These specs assert on the emitted event stream instead, which the phantom write
// does move: before the fix, updating an unrelated parent column emitted a spurious child
// UPDATE event (`changedColumns: []` for cascade). See
// test/logic/41-foreign-keys.sqllogic for the sibling value-level assertions.

import { expect } from 'chai';
import { Database, type DatabaseDataChangeEvent } from '../../src/index.js';

describe('runtime FK action gate: untouched referenced column emits no child event', () => {
	let db: Database;
	let events: DatabaseDataChangeEvent[];

	beforeEach(async () => {
		db = new Database();
		await db.exec('pragma foreign_keys = true');
		events = [];
		db.onDataChange((event) => {
			events.push(event);
		});
	});

	afterEach(async () => {
		await db.close();
	});

	it('ON UPDATE SET DEFAULT: untouched column ⇒ no child event; re-key ⇒ one child event', async () => {
		await db.exec(`
			create table p (id integer primary key, other integer);
			create table c (cid integer primary key, p_id integer default 99,
				foreign key (p_id) references p(id) on update set default);
			insert into p values (1, 100), (99, 200);
			insert into c values (10, 1);
		`);

		events.length = 0;
		await db.exec('update p set other = 111 where id = 1');
		void expect(events.filter(e => e.tableName === 'c'), 'untouched referenced column must not touch the child').to.deep.equal([]);

		events.length = 0;
		await db.exec('update p set id = 7 where id = 1');
		const childEvents = events.filter(e => e.tableName === 'c');
		void expect(childEvents.length, 'genuine re-key must still fire the child action exactly once').to.equal(1);
		void expect(childEvents[0].type).to.equal('update');
		void expect(childEvents[0].changedColumns).to.deep.equal(['p_id']);
		void expect(childEvents[0].newRow).to.deep.equal([10, 99]);
	});

	it('ON UPDATE SET NULL (nullable child column): untouched column ⇒ no child event; re-key ⇒ one child event', async () => {
		await db.exec(`
			create table p (id integer primary key, other integer);
			create table c (cid integer primary key, p_id integer null,
				foreign key (p_id) references p(id) on update set null);
			insert into p values (1, 100);
			insert into c values (10, 1);
		`);

		events.length = 0;
		await db.exec('update p set other = 111 where id = 1');
		void expect(events.filter(e => e.tableName === 'c'), 'untouched referenced column must not touch the child').to.deep.equal([]);

		events.length = 0;
		await db.exec('update p set id = 7 where id = 1');
		const childEvents = events.filter(e => e.tableName === 'c');
		void expect(childEvents.length, 'genuine re-key must still fire the child action exactly once').to.equal(1);
		void expect(childEvents[0].type).to.equal('update');
		void expect(childEvents[0].changedColumns).to.deep.equal(['p_id']);
		void expect(childEvents[0].newRow).to.deep.equal([10, null]);
	});

	it('ON UPDATE SET NULL (non-nullable child column): untouched column must succeed as a no-op, not raise NOT NULL', async () => {
		// Before the fix this raised `NOT NULL constraint failed: c.p_id` — the action
		// re-issued unconditionally and tripped the child's NOT NULL. Spelled out rather
		// than leaning on Quereus's NOT NULL column default, so the case keeps testing
		// what it claims if that default ever changes.
		await db.exec(`
			create table p (id integer primary key, other integer);
			create table c (cid integer primary key, p_id integer not null,
				foreign key (p_id) references p(id) on update set null);
			insert into p values (1, 100);
			insert into c values (10, 1);
		`);

		events.length = 0;
		await db.exec('update p set other = 111 where id = 1');
		void expect(events.filter(e => e.tableName === 'c'), 'untouched referenced column must not touch the child').to.deep.equal([]);
	});

	it('ON UPDATE CASCADE: untouched column ⇒ no child event (no phantom rewrite-to-same-value); re-key ⇒ one child event', async () => {
		await db.exec(`
			create table p (id integer primary key, other integer);
			create table c (cid integer primary key, p_id integer,
				foreign key (p_id) references p(id) on update cascade);
			insert into p values (1, 100);
			insert into c values (10, 1);
		`);

		events.length = 0;
		await db.exec('update p set other = 111 where id = 1');
		void expect(events.filter(e => e.tableName === 'c'), 'untouched referenced column must not emit a phantom child update').to.deep.equal([]);

		events.length = 0;
		await db.exec('update p set id = 7 where id = 1');
		const childEvents = events.filter(e => e.tableName === 'c');
		void expect(childEvents.length, 'genuine re-key must still fire the cascade exactly once').to.equal(1);
		void expect(childEvents[0].type).to.equal('update');
		void expect(childEvents[0].changedColumns).to.deep.equal(['p_id']);
		void expect(childEvents[0].newRow).to.deep.equal([10, 7]);
	});
});

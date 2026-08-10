import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { planOps } from './_helpers.js';

/**
 * Plan shape for the semantic-ordering gate on physical equi-join keys (ticket
 * `mixed-type-equi-join-key-drops-semantic-matches`).
 *
 * The answers are pinned by test/logic/15.1-semantic-ordering.sqllogic; this pins
 * the REASON. Without it, a future change could restore the right row set for the
 * wrong reason (a canonicalized hash key on a mixed pair) or over-decline (a
 * same-type pair silently dropping to nested loop), and nothing would fail.
 */
describe('Plan shape: mixed semantic-ordering equi-join keys', () => {
	let db: Database;

	const PHYSICAL_JOINS = ['HASHJOIN', 'MERGEJOIN', 'BLOOMJOIN'];
	const physicalJoinOps = (ops: readonly string[]) => ops.filter(op => PHYSICAL_JOINS.includes(op));

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table mixed_l (id integer primary key, d timespan)');
		await db.exec('create table plain_r (id integer primary key, d text)');
		await db.exec('create table same_r (id integer primary key, d timespan)');
		await db.exec("insert into mixed_l values (1, 'PT1H')");
		await db.exec("insert into plain_r values (10, 'PT60M')");
		await db.exec("insert into same_r values (20, 'PT60M')");
	});

	afterEach(async () => {
		await db.close();
	});

	it('demotes a mixed ON pair to the generic nested-loop join', async () => {
		const ops = await planOps(db, 'select mixed_l.id from mixed_l join plain_r on mixed_l.d = plain_r.d');
		expect(physicalJoinOps(ops), 'a timespan ↔ text key must not reach a physical join').to.deep.equal([]);
		expect(ops).to.include('JOIN');
	});

	it('demotes a mixed USING pair to the generic nested-loop join', async () => {
		const ops = await planOps(db, 'select mixed_l.id from mixed_l join plain_r using (d)');
		expect(physicalJoinOps(ops)).to.deep.equal([]);
		expect(ops).to.include('JOIN');
	});

	it('keeps the physical key path for a same-type ON pair', async () => {
		const ops = await planOps(db, 'select mixed_l.id from mixed_l join same_r on mixed_l.d = same_r.d');
		expect(physicalJoinOps(ops), 'a timespan ↔ timespan key is admissible').to.not.be.empty;
	});

	it('keeps the physical key path for a same-type USING pair', async () => {
		const ops = await planOps(db, 'select mixed_l.id from mixed_l join same_r using (d)');
		expect(physicalJoinOps(ops)).to.not.be.empty;
	});
});

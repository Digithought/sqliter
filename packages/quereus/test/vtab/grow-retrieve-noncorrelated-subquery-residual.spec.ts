/**
 * Regression for `rule-grow-retrieve` burying a NON-correlated subquery's residual.
 *
 * When a WHERE combines a pushed-down conjunct (here a primary-key `=`) with a
 * self-contained subquery over a DIFFERENT table, grow-retrieve's index-style fallback
 * slides the `=` into the Retrieve and residualizes the rest. The residual — which
 * carries the subquery's own inner Retrieve — must be kept ABOVE the grown Retrieve as
 * a Filter, so the bottom-up physical pass still visits and physicalizes that inner
 * Retrieve.
 *
 * Before the fix the guard only kept a *correlated* subquery residual above; a
 * self-contained `IN (SELECT …)` / `EXISTS (…)` / scalar subquery was buried in the
 * module context, its inner Retrieve was never physicalized, and execution threw:
 *   "RetrieveNode for table '…' was not rewritten to a physical access node."
 *
 * Only reproducible against a module whose `getBestAccessPlan` advertises a beneficial
 * access path (the in-tree memory backend does not reach the grow rule) — hence
 * `TestIndexSubqueryModule`.
 */

import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { TestIndexSubqueryModule, indexSubqueryStore } from './test-index-subquery-residual-module.js';

describe('grow-retrieve: non-correlated subquery residual stays physicalizable', () => {
	let db: Database;

	beforeEach(async () => {
		indexSubqueryStore.clear();
		db = new Database();
		db.registerModule('idxsubq', new TestIndexSubqueryModule());
		await db.exec('create table entity (id integer primary key, kind integer) using idxsubq');
		await db.exec('create table other (val integer primary key) using idxsubq');
		await db.exec('insert into entity values (10, 1), (20, 2), (30, 3), (40, 4)');
		await db.exec('insert into other values (20), (40)');
	});

	afterEach(async () => {
		await db.close();
		indexSubqueryStore.clear();
	});

	const ids = async (sql: string): Promise<number[]> => {
		const out: number[] = [];
		for await (const row of db.eval(sql)) out.push(row.id as number);
		return out;
	};

	it('keeps a non-correlated IN (subquery) residual above the grown Retrieve', async () =>
		expect(await ids('select id from entity where id = 20 and id in (select val from other) order by id'))
			.to.deep.equal([20]));

	it('handles an IN (subquery) that filters out the seeked row', async () =>
		expect(await ids('select id from entity where id = 30 and id in (select val from other) order by id'))
			.to.deep.equal([]));

	it('keeps a non-correlated EXISTS (subquery) residual above the grown Retrieve', async () =>
		expect(await ids('select id from entity where id = 30 and exists (select 1 from other where val = 40) order by id'))
			.to.deep.equal([30]));

	it('keeps a non-correlated scalar-subquery residual above the grown Retrieve', async () =>
		expect(await ids('select id from entity where id = 40 and id = (select max(val) from other) order by id'))
			.to.deep.equal([40]));

	// NOT IN (subquery) lowers to a NOT-wrapped InNode; the walker still finds the
	// buried inner Retrieve structurally (any relational descendant), so the residual
	// stays above the grown Retrieve.
	it('keeps a non-correlated NOT IN (subquery) residual above the grown Retrieve', async () =>
		expect(await ids('select id from entity where id = 10 and id not in (select val from other) order by id'))
			.to.deep.equal([10]));

	it('still returns the plain IN (subquery) (no extra conjunct) correctly', async () =>
		expect(await ids('select id from entity where id in (select val from other) order by id'))
			.to.deep.equal([20, 40]));
});

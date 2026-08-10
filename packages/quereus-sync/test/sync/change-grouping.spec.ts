/**
 * Unit tests for transaction grouping (`buildTransactionChangeSets`).
 *
 * These exercise the pure grouping/bounding logic in isolation: one ChangeSet
 * per source transaction, never split, never merged; transaction-granularity
 * bounding; oversized-transaction telemetry; DDL grouping.
 */

import { expect } from 'chai';
import {
	buildTransactionChangeSets,
	groupByTransaction,
} from '../../src/sync/change-grouping.js';
import { createHLC, deterministicTxnId, compareHLC, type HLC } from '../../src/clock/hlc.js';
import { generateSiteId, type SiteId } from '../../src/clock/site.js';
import type { Change, ColumnChange, SchemaMigration } from '../../src/sync/protocol.js';

const SITE = generateSiteId();
const OTHER_SITE = generateSiteId();

/** Build a column change whose HLC is `(wallTime, counter, site, opSeq)`. */
function col(
	wallTime: number,
	counter: number,
	opSeq: number,
	site: SiteId = SITE,
	column = `c${opSeq}`,
): ColumnChange {
	return {
		type: 'column',
		schema: 'main',
		table: 'users',
		pk: [1],
		column,
		value: `v${opSeq}`,
		hlc: createHLC(BigInt(wallTime), counter, site, opSeq),
	};
}

function migration(
	wallTime: number,
	counter: number,
	opSeq: number,
	site: SiteId = SITE,
): SchemaMigration {
	return {
		type: 'create_table',
		schema: 'main',
		table: 'users',
		ddl: 'create table users (id integer primary key)',
		hlc: createHLC(BigInt(wallTime), counter, site, opSeq),
		schemaVersion: 1,
	};
}

function base(wallTime: number, counter: number, site: SiteId = SITE): HLC {
	return createHLC(BigInt(wallTime), counter, site, 0);
}

describe('change-grouping', () => {
	describe('buildTransactionChangeSets', () => {
		it('returns [] for an empty stream', () => {
			expect(buildTransactionChangeSets([], [], 1000)).to.deep.equal([]);
		});

		it('groups one transaction (N facts) into one ChangeSet in opSeq order', () => {
			// Deliberately out of opSeq order to verify the grouper sorts.
			const changes: Change[] = [col(1000, 0, 2), col(1000, 0, 0), col(1000, 0, 1)];

			const result = buildTransactionChangeSets(changes, [], 1000);

			expect(result).to.have.lengthOf(1);
			const cs = result[0];
			expect(cs.changes.map(c => (c as ColumnChange).column)).to.deep.equal(['c0', 'c1', 'c2']);
			// hlc is the group's max fact HLC (last opSeq).
			expect(cs.hlc.opSeq).to.equal(2);
			// Deterministic id derived from the base (wallTime, counter, siteId).
			expect(cs.transactionId).to.equal(deterministicTxnId(base(1000, 0)));
			expect(cs.schemaMigrations).to.deep.equal([]);
		});

		it('never merges two transactions: distinct transactionId and hlc', () => {
			const t1 = [col(1000, 0, 0), col(1000, 0, 1)];
			const t2 = [col(1000, 1, 0), col(1000, 1, 1)];

			const result = buildTransactionChangeSets([...t2, ...t1], [], 1000);

			expect(result).to.have.lengthOf(2);
			// Ordered by base HLC ascending regardless of input order.
			expect(result[0].transactionId).to.equal(deterministicTxnId(base(1000, 0)));
			expect(result[1].transactionId).to.equal(deterministicTxnId(base(1000, 1)));
			expect(result[0].transactionId).to.not.equal(result[1].transactionId);
			expect(compareHLC(result[0].hlc, result[1].hlc)).to.be.lessThan(0);
		});

		it('bounds at transaction granularity: stops once cumulative >= batchSize', () => {
			const t1 = [col(1000, 0, 0), col(1000, 0, 1)];
			const t2 = [col(1000, 1, 0), col(1000, 1, 1)];
			const t3 = [col(1000, 2, 0), col(1000, 2, 1)];

			// batchSize 3: after t1 cumulative=2 (<3, continue); after t2 cumulative=4 (>=3, stop).
			const result = buildTransactionChangeSets([...t1, ...t2, ...t3], [], 3);

			expect(result).to.have.lengthOf(2);
			expect(result[0].changes).to.have.lengthOf(2);
			expect(result[1].changes).to.have.lengthOf(2);
			// t3 is not returned this round.
			expect(result.map(cs => cs.transactionId)).to.not.include(
				deterministicTxnId(base(1000, 2)),
			);
		});

		it('never splits an oversized transaction; reports it via onOversized', () => {
			const facts = [0, 1, 2, 3, 4].map(opSeq => col(1000, 0, opSeq));
			const oversized: Array<{ id: string; count: number }> = [];

			const result = buildTransactionChangeSets(facts, [], 2, (id, count) =>
				oversized.push({ id, count }),
			);

			expect(result).to.have.lengthOf(1);
			expect(result[0].changes).to.have.lengthOf(5);
			expect(oversized).to.deep.equal([
				{ id: deterministicTxnId(base(1000, 0)), count: 5 },
			]);
		});

		it('forms a DDL-only ChangeSet for a transaction with no data facts', () => {
			const result = buildTransactionChangeSets([], [migration(1000, 0, 0)], 1000);

			expect(result).to.have.lengthOf(1);
			expect(result[0].changes).to.deep.equal([]);
			expect(result[0].schemaMigrations).to.have.lengthOf(1);
			expect(result[0].hlc.opSeq).to.equal(0);
			expect(result[0].transactionId).to.equal(deterministicTxnId(base(1000, 0)));
		});

		it('groups DDL + DML of the same transaction into one ChangeSet (DDL at lower opSeq)', () => {
			// Migration takes opSeq 0; data facts take 1, 2 — same base.
			const result = buildTransactionChangeSets(
				[col(1000, 0, 1), col(1000, 0, 2)],
				[migration(1000, 0, 0)],
				1000,
			);

			expect(result).to.have.lengthOf(1);
			const cs = result[0];
			expect(cs.schemaMigrations).to.have.lengthOf(1);
			expect(cs.changes).to.have.lengthOf(2);
			// Group hlc is the max fact (last DML opSeq), not the migration.
			expect(cs.hlc.opSeq).to.equal(2);
		});
	});

	describe('groupByTransaction', () => {
		it('separates transactions from different sites at the same (wallTime, counter)', () => {
			const groups = groupByTransaction(
				[col(1000, 0, 0, SITE), col(1000, 0, 0, OTHER_SITE)],
				[],
			);
			expect(groups).to.have.lengthOf(2);
		});
	});
});

/**
 * Group a flat, HLC-bearing change/migration stream into per-transaction
 * {@link ChangeSet}s.
 *
 * After `sync-per-transaction-hlc-tick`, every fact a transaction produces shares
 * one base HLC `(wallTime, counter, siteId)` and differs only in `opSeq`. That
 * triple **is** the transaction's identity, so grouping by it reconstructs the
 * source transactions exactly — one `ChangeSet` per commit, never split, never
 * merged. Schema migrations of a transaction share the same base (DDL takes the
 * lowest `opSeq`s) and rejoin their data facts here.
 *
 * Bounding by `batchSize` happens at **transaction granularity**: whole
 * transactions accumulate until the cumulative data-change count reaches the
 * bound; a transaction is never split to hit it. A single oversized transaction
 * (more facts than `batchSize`) is returned whole and reported via `onOversized`.
 */

import { type HLC, compareHLC, createHLC, deterministicTxnId } from '../clock/hlc.js';
import type { SiteId } from '../clock/site.js';
import type { Change, ChangeSet, SchemaMigration } from './protocol.js';

/** One source transaction's facts, keyed by its base HLC identity. */
interface TransactionGroup {
	/** Base HLC `(wallTime, counter, siteId)` with `opSeq` 0 — the transaction identity. */
	readonly base: HLC;
	readonly siteId: SiteId;
	readonly changes: Change[];
	readonly migrations: SchemaMigration[];
}

/**
 * Group changes and migrations by transaction identity `(wallTime, counter,
 * siteId)`. Input order is irrelevant — groups are ordered by base HLC ascending
 * and each group's facts/migrations are ordered by `opSeq`.
 */
export function groupByTransaction(
	changes: Change[],
	migrations: SchemaMigration[],
): TransactionGroup[] {
	const groups = new Map<string, TransactionGroup>();

	const groupFor = (hlc: HLC): TransactionGroup => {
		// deterministicTxnId excludes opSeq, so it is exactly the transaction identity.
		const key = deterministicTxnId(hlc);
		let group = groups.get(key);
		if (!group) {
			group = {
				base: createHLC(hlc.wallTime, hlc.counter, hlc.siteId, 0),
				siteId: hlc.siteId,
				changes: [],
				migrations: [],
			};
			groups.set(key, group);
		}
		return group;
	};

	for (const change of changes) groupFor(change.hlc).changes.push(change);
	for (const migration of migrations) groupFor(migration.hlc).migrations.push(migration);

	const ordered = [...groups.values()];
	ordered.sort((a, b) => compareHLC(a.base, b.base));
	for (const group of ordered) {
		group.changes.sort((a, b) => a.hlc.opSeq - b.hlc.opSeq);
		group.migrations.sort((a, b) => a.hlc.opSeq - b.hlc.opSeq);
	}
	return ordered;
}

/**
 * The group's maximum fact HLC (its last `opSeq`). A consumer that sets
 * `lastSyncHLC = ChangeSet.hlc` and re-fetches resumes strictly *after* the whole
 * transaction, because `buildChangeLogScanBoundsAfter` excludes everything `<=` it.
 */
function maxGroupHLC(group: TransactionGroup): HLC {
	let max = group.base;
	for (const change of group.changes) {
		if (compareHLC(change.hlc, max) > 0) max = change.hlc;
	}
	for (const migration of group.migrations) {
		if (compareHLC(migration.hlc, max) > 0) max = migration.hlc;
	}
	return max;
}

/**
 * Build per-transaction {@link ChangeSet}s from a flat change/migration stream,
 * bounded at transaction granularity by `batchSize`.
 *
 * @param onOversized - called once per transaction whose data-change count
 *   exceeds `batchSize`; the transaction is still returned whole.
 */
export function buildTransactionChangeSets(
	changes: Change[],
	migrations: SchemaMigration[],
	batchSize: number,
	onOversized?: (transactionId: string, changeCount: number) => void,
): ChangeSet[] {
	if (changes.length === 0 && migrations.length === 0) return [];

	const groups = groupByTransaction(changes, migrations);
	const result: ChangeSet[] = [];
	let cumulative = 0;

	for (const group of groups) {
		const transactionId = deterministicTxnId(group.base);
		result.push({
			siteId: group.siteId,
			transactionId,
			hlc: maxGroupHLC(group),
			changes: group.changes,
			schemaMigrations: group.migrations,
		});

		if (group.changes.length > batchSize) {
			onOversized?.(transactionId, group.changes.length);
		}

		// Accumulate WHOLE transactions; stop once the bound is reached. The
		// remaining transactions come on the next getChangesSince call (the
		// consumer advances its watermark to the last returned ChangeSet.hlc).
		cumulative += group.changes.length;
		if (cumulative >= batchSize) break;
	}

	return result;
}

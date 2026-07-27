/**
 * Change application logic.
 *
 * Handles the 3-phase change application pattern:
 *   1. resolveChange — CRDT conflict resolution (no writes)
 *   2. applyToStore callback — write data to store
 *   3. commitChangeMetadata — persist CRDT metadata
 */

import type { WriteBatch } from '@quereus/store';
import { compareHLC, maxHLC, assertWithinDrift } from '../clock/hlc.js';
import { siteIdEquals, type SiteId } from '../clock/site.js';
import type { ColumnVersion } from '../metadata/column-version.js';
import type { Tombstone } from '../metadata/tombstones.js';
import { encodePkIdentity } from '../metadata/keys.js';
import type {
	ChangeSet,
	Change,
	ColumnChange,
	RowDeletion,
	ApplyResult,
	DataChangeToApply,
	SchemaChangeToApply,
	SchemaMigration,
} from './protocol.js';
import type { SyncContext } from './sync-context.js';
import { toError, deleteRowVersionsAndLogEntries } from './sync-context.js';
import { admitGroup } from './admission.js';

/**
 * Result of resolving a single change (without writing metadata).
 * Separates resolution from commit for correct write order.
 */
export interface ResolvedChange {
	outcome: 'applied' | 'skipped' | 'conflict';
	change: Change;
	dataChange?: DataChangeToApply;
	/** For column changes: the old version to clean up in the change log. */
	oldColumnVersion?: ColumnVersion;
	/** For delete changes: the prior tombstone whose stale delete entry to clean up in the change log. */
	oldTombstone?: Tombstone;
}

/**
 * Diverted out-of-basis straggler changes for one `(schema, table)`, accumulated
 * across the batch before disposition (quarantine / ignore / store-and-forward)
 * and telemetry.
 */
interface UnknownTableGroup {
	schema: string;
	table: string;
	/** Straggler origin: the changeset siteId that first referenced this table. */
	siteId: SiteId;
	changes: Change[];
}

/** Stable `schema.table` map key for batch deltas and diversion groups. */
function tableKey(schema: string, table: string): string {
	return `${schema}.${table}`;
}

/**
 * In-batch table delta from the batch's schema migrations: `create_table` adds a
 * table, `drop_table` removes one. Detection runs at Phase 1 (before any DDL
 * executes in Phase 2), so a referenced table is "known" if it is in the current
 * basis OR created by this batch, AND not dropped by this batch. Computed over the
 * WHOLE batch because admission applies all schema changes before all data.
 */
function computeBatchTableDelta(changes: ChangeSet[]): { created: Set<string>; dropped: Set<string> } {
	const created = new Set<string>();
	const dropped = new Set<string>();
	for (const changeSet of changes) {
		for (const migration of changeSet.schemaMigrations) {
			const key = tableKey(migration.schema, migration.table);
			if (migration.type === 'create_table') {
				created.add(key);
			} else if (migration.type === 'drop_table') {
				dropped.add(key);
			}
		}
	}
	return { created, dropped };
}

/**
 * Apply change sets from a remote peer.
 *
 * Three-phase process:
 *   1. Resolve all changes (no writes); divert out-of-basis straggler changes
 *   2. Apply data to store via callback
 *   3. Commit CRDT metadata (+ durable quarantine of diverted changes)
 *
 * Unknown-table disposition: a change referencing a table outside the local basis
 * (a retired-table straggler delta — see `docs/migration.md` § 4 Contract) is
 * **diverted** during resolution — never resolved, applied, or recorded as CRDT
 * metadata, so the change log stays clean (no survivor-HLC pollution). Diverted
 * changes are held (durably, idempotently — `quarantine`, or `store-and-forward`
 * which additionally marks them forwardable) or ignored per
 * {@link SyncConfig.unknownTableDisposition}, and telemetered either way.
 */
export async function applyChanges(
	ctx: SyncContext,
	changes: ChangeSet[],
): Promise<ApplyResult> {
	let applied = 0;
	let skipped = 0;
	let conflicts = 0;

	const dataChangesToApply: DataChangeToApply[] = [];
	const schemaChangesToApply: SchemaChangeToApply[] = [];
	const appliedChanges: Array<{ change: Change; siteId: SiteId }> = [];
	const resolvedDataChanges: ResolvedChange[] = [];
	const pendingSchemaMigrations: Array<{
		migration: SchemaMigration;
		schemaVersion: number;
	}> = [];
	// Out-of-basis straggler changes diverted out of the resolve/apply/metadata
	// path, grouped per table for disposition + telemetry.
	const unknownByTable = new Map<string, UnknownTableGroup>();

	const { created: batchCreated, dropped: batchDropped } = computeBatchTableDelta(changes);

	// Pre-commit drift validation: reject a batch whose maximum fact HLC is beyond the
	// drift bound BEFORE any resolution, data write, or CRDT metadata commit — so a peer
	// with a badly-wrong clock cannot land far-future LWW winners that then beat every
	// legitimate future write. `cs.hlc` is each transaction's max fact HLC, so the batch
	// max bounds every fact in the batch. This same value is the merge watermark below
	// (one `maxHLC` computation, reused). Throwing here exits before `admitGroup`, so no
	// data and no metadata commit; emit `status:'error'` first for parity with the
	// `applyDataToStore` failure path so the UI reacts identically to a rejected batch.
	const watermarkHLC = maxHLC(changes.map(cs => cs.hlc));
	if (watermarkHLC) {
		try {
			assertWithinDrift(watermarkHLC.wallTime, BigInt(Date.now()));
		} catch (error) {
			ctx.syncEvents.emitSyncStateChange({ status: 'error', error: toError(error) });
			throw error;
		}
	}

	// PHASE 1: Resolve all changes (no writes yet). The clock watermark is merged
	// once after a successful admission (see admitGroup below), not per changeset —
	// resolution reads stored versions via compareHLC, never the live clock.
	for (const changeSet of changes) {
		// Process schema migrations first (DDL before DML)
		for (const migration of changeSet.schemaMigrations) {
			const schemaVersion = migration.schemaVersion ??
				(await ctx.schemaMigrations.getCurrentVersion(migration.schema, migration.table)) + 1;

			const existingMigration = await ctx.schemaMigrations.getMigration(
				migration.schema,
				migration.table,
				schemaVersion,
			);

			if (existingMigration) {
				if (compareHLC(migration.hlc, existingMigration.hlc) <= 0) {
					skipped++;
					continue;
				}
			}

			schemaChangesToApply.push({
				type: migration.type,
				schema: migration.schema,
				table: migration.table,
				ddl: migration.ddl,
			});
			pendingSchemaMigrations.push({ migration, schemaVersion });
			applied++;
		}

		// Resolve data changes
		for (const change of changeSet.changes) {
			// Self-origin echo skip BEFORE unknown-table detection, so a self-change
			// to a retired table is skipped (counted), never quarantined. resolveChange
			// re-checks this defensively for any other caller.
			if (siteIdEquals(change.hlc.siteId, ctx.getSiteId())) {
				skipped++;
				continue;
			}

			// Structural unknown-table detection: in the current basis OR created by
			// this batch, AND not dropped by this batch. Diverted changes never reach
			// resolveChange / dataChangesToApply / commitChangeMetadata, so no CRDT
			// metadata is written for a table the receiver does not have.
			const key = tableKey(change.schema, change.table);
			const inBasis = ctx.isTableInBasis(change.schema, change.table);
			const known = (inBasis || batchCreated.has(key)) && !batchDropped.has(key);
			if (!known) {
				let group = unknownByTable.get(key);
				if (!group) {
					group = { schema: change.schema, table: change.table, siteId: changeSet.siteId, changes: [] };
					unknownByTable.set(key, group);
				}
				group.changes.push(change);
				continue;
			}

			// A table known ONLY via this batch's create_table has no local schema
			// yet (Phase 2 DDL hasn't run) and hence no resolvable pk-identity keying
			// — and, being locally fresh, no local metadata to resolve against either.
			// Resolve it read-free rather than throwing from the keying resolver;
			// Phase 3's metadata commit runs after the DDL, when the keying resolves.
			const freshLocalTable = !inBasis;

			const resolved = await resolveChange(ctx, change, freshLocalTable);
			if (resolved.outcome === 'applied') {
				applied++;
				appliedChanges.push({ change, siteId: changeSet.siteId });
				resolvedDataChanges.push(resolved);
				if (resolved.dataChange) {
					dataChangesToApply.push(resolved.dataChange);
				}
			} else if (resolved.outcome === 'skipped') {
				skipped++;
			} else if (resolved.outcome === 'conflict') {
				conflicts++;
			}
		}
	}

	const disposition = ctx.config.unknownTableDisposition;
	// Single receive timestamp for every quarantine entry this apply (GC horizon).
	const receivedAt = Date.now();

	// Admit the whole resolved batch as one all-or-nothing unit: data first (PHASE
	// 2), then CRDT metadata (PHASE 3), then the merged clock watermark — aborting
	// with no metadata committed on any data-apply failure. The batch is admitted
	// once (not per ChangeSet): the single per-peer lastSyncHLC watermark cannot
	// express a partial commit, so selective commit is intentionally not done.
	await admitGroup(ctx, {
		dataChanges: dataChangesToApply,
		schemaChanges: schemaChangesToApply,
		applyOptions: { remote: true },
		commitMetadata: async () => {
			await commitChangeMetadata(ctx, resolvedDataChanges);

			// Commit schema migration metadata
			for (const { migration, schemaVersion } of pendingSchemaMigrations) {
				await ctx.schemaMigrations.recordMigration(migration.schema, migration.table, {
					type: migration.type,
					ddl: migration.ddl,
					hlc: migration.hlc,
					schemaVersion,
				});
			}

			// Hold diverted changes as part of the admission unit — durable BEFORE
			// the watermark advances below, so a crash never strands a straggler's
			// change with no re-delivery (the batch re-resolves and re-holds
			// idempotently, HLC-keyed). Both `quarantine` and `store-and-forward`
			// hold identically; `store-and-forward` additionally marks each entry
			// forwardable so the relay (sibling ticket) can re-offer it. `ignore`
			// writes nothing.
			if ((disposition === 'quarantine' || disposition === 'store-and-forward') && unknownByTable.size > 0) {
				const forwardable = disposition === 'store-and-forward';
				const qBatch = ctx.kv.batch();
				for (const group of unknownByTable.values()) {
					for (const change of group.changes) {
						ctx.quarantine.put(qBatch, change, receivedAt, forwardable);
					}
				}
				await qBatch.write();
			}

			// Dynamic basis-retirement signal: a remote write to a non-directly-mapped
			// tracked table bumps its `lastDirectlyMappedWriteAt`, deferring eviction
			// (docs/migration.md § 2 Converge). Advisory — never aborts the apply.
			await bumpLastDirectlyMappedWrites(ctx, appliedChanges);
		},
		// Merging the batch max once is equivalent to receiving each changeset's
		// HLC (receive is a monotonic max-merge); on a mid-batch abort the clock
		// does not advance and the batch re-resolves next sync. Computed once at the
		// top (drift-validated there); undefined only for an empty batch, which
		// admitGroup treats as no watermark merge.
		watermarkHLC,
	});

	// Emit remote change events (grouped by the relaying changeset's siteId).
	emitRemoteChanges(ctx, appliedChanges);

	// Reactive low-latency drain (sync-drain-reappear-inbound-ddl): every APPLIED
	// create_table may have revived a previously-retired table that has held
	// out-of-basis changes waiting on it. Replay them NOW — as a SEPARATE post-commit
	// apply unit, after the admitting batch above has fully committed (fresh data lands
	// first, held changes LWW-resolve against it) — instead of waiting up to one
	// periodic-sweep interval. Only applied migrations are in `pendingSchemaMigrations`
	// (an HLC-dominated create_table `continue`s before being pushed), so a losing
	// create never triggers a drain. A create+drop in the same batch leaves the table
	// absent, so its key is skipped to avoid a wasted scoped `quarantine.list`.
	// Advisory: `drainReappearedTables` logs + swallows any failure, so a drain throw
	// never turns this successful apply into an error.
	const reappeared = new Map<string, { schema: string; table: string }>();
	for (const { migration } of pendingSchemaMigrations) {
		if (migration.type !== 'create_table') continue;
		const key = tableKey(migration.schema, migration.table);
		if (batchDropped.has(key)) continue;
		if (!reappeared.has(key)) reappeared.set(key, { schema: migration.schema, table: migration.table });
	}
	await drainReappearedTables(ctx, [...reappeared.values()]);

	// Unknown-table telemetry AFTER successful admission, regardless of disposition
	// (the operator must see straggler traffic even when it is being dropped).
	let unknownTableCount = 0;
	for (const group of unknownByTable.values()) {
		unknownTableCount += group.changes.length;
		ctx.recordUnknownTable(disposition, group.schema, group.table, group.changes.length);
		ctx.syncEvents.emitUnknownTable({
			schema: group.schema,
			table: group.table,
			disposition,
			changeCount: group.changes.length,
			siteId: group.siteId,
			// Group is non-empty by construction, so maxHLC is defined.
			latestHLC: maxHLC(group.changes.map(c => c.hlc))!,
		});
	}

	return {
		applied,
		skipped,
		conflicts,
		transactions: changes.length,
		...(unknownTableCount > 0 ? { unknownTable: unknownTableCount } : {}),
	};
}

/**
 * Emit `onRemoteChange` for applied changes, grouped by a per-change origin site
 * id. Shared by the wire apply (grouping by the relaying changeset's `siteId`) and
 * the drain path (grouping by each held change's original origin `hlc.siteId`), so
 * downstream reactivity — MV maintenance, `Database.watch`, UI — fires identically
 * on a revival as on a fresh remote apply. No-op for an empty set.
 */
function emitRemoteChanges(
	ctx: SyncContext,
	entries: Array<{ change: Change; siteId: SiteId }>,
): void {
	if (entries.length === 0) return;

	const changesBySite = new Map<string, Change[]>();
	for (const { change, siteId } of entries) {
		const siteKey = Array.from(siteId).join(',');
		const siteChanges = changesBySite.get(siteKey);
		if (siteChanges) {
			siteChanges.push(change);
		} else {
			changesBySite.set(siteKey, [change]);
		}
	}

	const appliedAt = ctx.hlcManager.now();
	for (const [siteKey, siteChanges] of changesBySite) {
		const siteIdBytes = new Uint8Array(siteKey.split(',').map(Number));
		ctx.syncEvents.emitRemoteChange({
			siteId: siteIdBytes,
			transactionId: crypto.randomUUID(),
			changes: siteChanges,
			appliedAt,
		});
	}
}

/**
 * Replay held out-of-basis changes (`quarantine` + forwardable `store-and-forward`
 * entries) into tables that have since reappeared in the local basis — the revival
 * half of the unknown-table contract (`docs/migration.md` § 4 Contract). The
 * sibling of {@link applyChanges}' data branch, minus the schema-migration and
 * unknown-table-divert machinery: held changes have no DDL and their table is, by
 * the basis gate, already present.
 *
 * Driven two ways, never interleaved: the host calls {@link SyncManager.drainHeldChanges}
 * from its periodic maintenance sweep, and {@link drainReappearedTables} calls it
 * reactively from {@link applyChanges} the moment an inbound `create_table` revives a
 * held table (gated by {@link SyncConfig.drainOnReappear}). Either way drain runs as a
 * SEPARATE apply, after any re-creating batch has fully committed — fresh data is
 * already in storage and the older held changes simply LWW-resolve against it. The
 * invariant is "never INTERLEAVE drain into the admitting batch", not "never drain
 * inline": a reactive post-commit drain is its own admission unit, distinct from the
 * batch it follows.
 *
 * Scope mirrors {@link QuarantineStore.list}: `(schema, table)` drains one table,
 * `(schema)` drains a schema, `()` sweeps every held entry whose table is back.
 * Bounded by the held set (itself bounded by the retention horizon); zero-cost when
 * nothing is held. With NO basis oracle every group's table reports `undefined`
 * column names ⇒ every group is skipped ⇒ this returns 0 (the relay-only no-op).
 *
 * @returns the number of held entries cleared from the hold (across present tables).
 */
export async function drainHeldChanges(
	ctx: SyncContext,
	schema?: string,
	table?: string,
): Promise<number> {
	const held = await ctx.quarantine.list(schema, table);
	if (held.length === 0) return 0;

	// Group held changes by (schema, table) — drain admits one table at a time.
	const groups = new Map<string, { schema: string; table: string; changes: Change[] }>();
	for (const entry of held) {
		const change = entry.change;
		const key = tableKey(change.schema, change.table);
		let group = groups.get(key);
		if (!group) {
			group = { schema: change.schema, table: change.table, changes: [] };
			groups.set(key, group);
		}
		group.changes.push(change);
	}

	let totalDrained = 0;
	for (const group of groups.values()) {
		totalDrained += await drainTableGroup(ctx, group);
	}
	return totalDrained;
}

/**
 * Drain one `(schema, table)` group of held changes. Returns the number of held
 * entries cleared for this table (0 when the table is still absent).
 */
async function drainTableGroup(
	ctx: SyncContext,
	group: { schema: string; table: string; changes: Change[] },
): Promise<number> {
	// Basis gate: a table not back in the local basis (oracle returns undefined —
	// also the no-oracle case) stays held; skip the whole group, drain nothing.
	const columns = ctx.getTableColumnNames(group.schema, group.table);
	if (columns === undefined) return 0;
	const columnSet = new Set(columns);

	const dataChangesToApply: DataChangeToApply[] = [];
	const resolvedDataChanges: ResolvedChange[] = [];
	const appliedEntries: Array<{ change: Change; siteId: SiteId }> = [];
	let applied = 0;
	let skipped = 0;

	for (const change of group.changes) {
		// Schema-drift filter: a held column change for a column the re-created table
		// no longer has is resolved-and-dropped (never sent to resolveChange or the
		// store), so one stale entry cannot abort the table's whole drain admission.
		// Its held entry is still cleared below. Deletes are never drift-filtered — a
		// delete of an absent pk is a store no-op, not a poison.
		if (change.type === 'column' && !columnSet.has(change.column)) {
			skipped++;
			continue;
		}

		// Identical LWW / tombstone-blocking / allowResurrection semantics as a fresh
		// receive — the held change is just an older inbound change resolved late.
		const resolved = await resolveChange(ctx, change);
		if (resolved.outcome === 'applied') {
			applied++;
			resolvedDataChanges.push(resolved);
			if (resolved.dataChange) dataChangesToApply.push(resolved.dataChange);
			// Group revival events by the held change's ORIGINAL origin (its HLC
			// siteId) — a held change carries no relaying changeset.
			appliedEntries.push({ change, siteId: change.hlc.siteId });
		} else {
			skipped++;
		}
	}

	// One admission unit: data first → CRDT metadata + held-entry deletes second.
	// No watermarkHLC — these HLCs were already merged into the local clock at the
	// original receive (applyChanges merges the batch maxHLC even for diverted
	// changes), so re-merging would be a no-op; omitting it keeps drain a pure replay.
	await admitGroup(ctx, {
		dataChanges: dataChangesToApply,
		schemaChanges: [],
		applyOptions: { remote: true },
		commitMetadata: async () => {
			await commitChangeMetadata(ctx, resolvedDataChanges);
			// Clear every held entry CONSIDERED this drain (applied, LWW-lost, blocked,
			// or drift-dropped) in the SAME unit, so the hold clears atomically with the
			// apply. Once a held change has resolved against the present table, holding
			// it longer changes nothing — a future drain resolves it identically — so a
			// non-applied outcome is cleared too. A data-apply failure aborts before
			// this callback, so on a crash the entries stay held and re-drain next sweep.
			const qBatch = ctx.kv.batch();
			for (const change of group.changes) {
				ctx.quarantine.delete(qBatch, change);
			}
			await qBatch.write();
		},
	});

	// Revival events AFTER the unit commits (so a listener reading back sees the
	// applied data): remote-change per origin, then one drained event for the table.
	emitRemoteChanges(ctx, appliedEntries);
	ctx.syncEvents.emitHeldChangesDrained({
		schema: group.schema,
		table: group.table,
		drained: group.changes.length,
		applied,
		skipped,
	});

	return group.changes.length;
}

/**
 * Best-effort scoped drain of tables that just reappeared in the local basis, run as
 * SEPARATE post-commit apply unit(s) after the re-creating batch committed. Advisory:
 * each table is drained independently and any failure is logged + swallowed (the held
 * entries stay held for the periodic sweep). No-op when {@link SyncConfig.drainOnReappear}
 * is disabled or the list is empty. Each {@link drainHeldChanges} call is cheap when
 * nothing is held (a scoped `quarantine.list` returning `[]`) and a no-op when the table
 * is still absent (the oracle gate in {@link drainTableGroup}).
 */
export async function drainReappearedTables(
	ctx: SyncContext,
	tables: ReadonlyArray<{ schema: string; table: string }>,
): Promise<void> {
	if (!ctx.config.drainOnReappear || tables.length === 0) return;

	// Per-table try/catch so one table's drain failure never aborts the others — and,
	// crucially, never propagates out of applyChanges to turn a committed apply into a
	// throw. The create_table + data are already durable; a swallowed drain leaves the
	// held entries for the next periodic sweep (drain is idempotent — a re-drain of an
	// already-drained table returns 0).
	for (const { schema, table } of tables) {
		try {
			await drainHeldChanges(ctx, schema, table);
		} catch (error) {
			console.warn(
				`[Sync] drainReappearedTables failed for ${schema}.${table} `
					+ `(advisory; held entries stay held for the periodic sweep): `
					+ `${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
}

/**
 * Resolve CRDT conflicts for a single change WITHOUT writing metadata.
 *
 * Phase 1 of the 3-phase apply pattern.
 *
 * `freshLocalTable` marks a table that exists only via the SAME batch's
 * create_table: it has no local schema yet (so no pk-identity keying) and no
 * local metadata, so every read is skipped and the change resolves as a first
 * write. Phase 3 commits its metadata after the DDL has executed.
 */
export async function resolveChange(
	ctx: SyncContext,
	change: Change,
	freshLocalTable = false,
): Promise<ResolvedChange> {
	// Skip changes that originated from ourselves (echo prevention)
	if (siteIdEquals(change.hlc.siteId, ctx.getSiteId())) {
		return { outcome: 'skipped', change };
	}

	if (change.type === 'delete') {
		const existingTombstone = freshLocalTable ? undefined : await ctx.tombstones.getTombstone(
			change.schema,
			change.table,
			change.pk,
		);

		if (existingTombstone && compareHLC(change.hlc, existingTombstone.hlc) <= 0) {
			return { outcome: 'skipped', change };
		}

		return {
			outcome: 'applied',
			change,
			oldTombstone: existingTombstone ?? undefined,
			dataChange: {
				type: 'delete',
				schema: change.schema,
				table: change.table,
				pk: change.pk,
			},
		};
	} else {
		// Column change: single getColumnVersion read, then decide via resolver or HLC
		const localVersion = freshLocalTable ? undefined : await ctx.columnVersions.getColumnVersion(
			change.schema,
			change.table,
			change.pk,
			change.column,
		);

		// Surface the incoming change's before-image to the resolver and conflict
		// events (spread only when present — keeps the no-prior fast path identical).
		const remotePrior = change.priorHlc !== undefined
			? { remotePriorHlc: change.priorHlc, remotePriorValue: change.priorValue }
			: undefined;

		if (localVersion) {
			const remoteWins = ctx.config.conflictResolver
				? ctx.config.conflictResolver({
					schema: change.schema,
					table: change.table,
					pk: change.pk,
					column: change.column,
					localValue: localVersion.value,
					localHlc: localVersion.hlc,
					remoteValue: change.value,
					remoteHlc: change.hlc,
					...remotePrior,
				}) === 'remote'
				: compareHLC(change.hlc, localVersion.hlc) > 0;

			if (!remoteWins) {
				ctx.syncEvents.emitConflictResolved({
					schema: change.schema,
					table: change.table,
					pk: change.pk,
					column: change.column,
					localValue: localVersion.value,
					remoteValue: change.value,
					winner: 'local',
					winningHLC: localVersion.hlc,
					...remotePrior,
				});
				return { outcome: 'conflict', change };
			}
		}

		// Remote wins or no local version — check tombstone blocking
		const isBlocked = freshLocalTable ? false : await ctx.tombstones.isDeletedAndBlocking(
			change.schema,
			change.table,
			change.pk,
			change.hlc,
			ctx.config.allowResurrection,
		);

		if (isBlocked) {
			return { outcome: 'skipped', change };
		}

		if (localVersion) {
			ctx.syncEvents.emitConflictResolved({
				schema: change.schema,
				table: change.table,
				pk: change.pk,
				column: change.column,
				localValue: localVersion.value,
				remoteValue: change.value,
				winner: 'remote',
				winningHLC: change.hlc,
				...remotePrior,
			});
		}

		return {
			outcome: 'applied',
			change,
			oldColumnVersion: localVersion ?? undefined,
			dataChange: {
				type: 'update',
				schema: change.schema,
				table: change.table,
				pk: change.pk,
				columns: { [change.column]: change.value },
			},
		};
	}
}

/**
 * Commit CRDT metadata for resolved changes.
 *
 * Phase 3 of the 3-phase apply pattern: called AFTER data is written to store.
 *
 * In-batch repeats of one key are collapsed to the max-HLC winner before any write.
 * Two versions of the same key can land in a single `applyChanges` batch (e.g.
 * concurrent deletes of the same pk relayed together), and Phase 1 resolved BOTH
 * against the same pre-batch prior version — neither saw the other. Writing both would
 * leave two change-log entries for one key, re-attributing the older entry to the later
 * HLC and breaking {@link SyncManagerImpl}'s `collectChangesSince` LOAD-BEARING
 * INVARIANT (survivor's log HLC == its current version's HLC). So only the winner's
 * metadata + change-log entry are written; losers are never written and the single
 * pre-batch prior entry is deleted once. Mirrors the local write-path dedup in
 * `recordDataEvent` / `recordColumnVersions`, keeping the delete and column paths
 * symmetric.
 */
export async function commitChangeMetadata(
	ctx: SyncContext,
	resolvedChanges: ResolvedChange[],
): Promise<void> {
	if (resolvedChanges.length === 0) return;

	// Collapse in-batch repeats per key, keeping the max-HLC change. Deletes key by
	// (schema, table, pk); columns by (schema, table, pk, column) — distinct change-log
	// entry types that never collide.
	const deleteWinners = new Map<string, ResolvedChange>();
	const columnWinners = new Map<string, ResolvedChange>();
	for (const resolved of resolvedChanges) {
		if (resolved.outcome !== 'applied') continue;
		const change = resolved.change;
		if (change.type === 'delete') {
			keepMaxHLC(deleteWinners, deleteKey(ctx, change), resolved);
		} else {
			keepMaxHLC(columnWinners, columnKey(ctx, change), resolved);
		}
	}

	const batch = ctx.kv.batch();
	for (const resolved of deleteWinners.values()) {
		const change = resolved.change;
		if (change.type !== 'delete') continue; // homogeneous map; narrows the union
		commitDeleteMetadata(ctx, batch, change, resolved.oldTombstone);
	}
	for (const resolved of columnWinners.values()) {
		const change = resolved.change;
		if (change.type !== 'column') continue; // homogeneous map; narrows the union
		commitColumnMetadata(ctx, batch, change, resolved.oldColumnVersion);
	}
	await batch.write();

	// Column-version cleanup for deletes requires async iteration — once per winning
	// delete (losers were never written, so there is nothing of theirs to clean). The
	// row's change-log column entries go in the same batch as its versions: an inbound
	// delete must leave no more index garbage behind than a local one, and this is the
	// path a relay runs almost exclusively.
	for (const resolved of deleteWinners.values()) {
		const change = resolved.change;
		if (change.type !== 'delete') continue;
		await deleteRowVersionsAndLogEntries(ctx, change.schema, change.table, change.pk);
	}
}

// Collapse keys reuse the pk-identity encoding so in-batch grouping matches the canonical
// pk identity of the actual KV keys (buildTombstoneKey / buildColumnVersionKey) — two pks
// collapse here iff they would collide on disk ('apple'/'APPLE' under nocase, 'PT1H'/'PT60M').

/** Stable per-pk key for collapsing repeated delete entries within one batch. */
function deleteKey(ctx: SyncContext, change: RowDeletion): string {
	return `delete:${change.schema}.${change.table}:${encodePkIdentity(change.pk, ctx.getPkKeying(change.schema, change.table))}`;
}

/** Stable per-(pk, column) key for collapsing repeated column entries within one batch. */
function columnKey(ctx: SyncContext, change: ColumnChange): string {
	return `column:${change.schema}.${change.table}:${encodePkIdentity(change.pk, ctx.getPkKeying(change.schema, change.table))}:${change.column}`;
}

/** Keep the max-HLC resolved change per key, collapsing in-batch repeats to one winner. */
function keepMaxHLC(
	winners: Map<string, ResolvedChange>,
	key: string,
	resolved: ResolvedChange,
): void {
	const prev = winners.get(key);
	if (!prev || compareHLC(resolved.change.hlc, prev.change.hlc) > 0) {
		winners.set(key, resolved);
	}
}

/** Write a winning delete's tombstone + change-log entry, deleting any prior delete entry. */
function commitDeleteMetadata(
	ctx: SyncContext,
	batch: WriteBatch,
	change: RowDeletion,
	oldTombstone: Tombstone | undefined,
): void {
	// Dedupe: a newer tombstone overwrites the prior one, leaving its delete change-log
	// entry stale — remove it so at most one survives per pk (mirrors the column dedup
	// and the write path in recordDataEvent).
	if (oldTombstone) {
		ctx.changeLog.deleteEntryBatch(batch, oldTombstone.hlc, 'delete', change.schema, change.table, change.pk);
	}
	// Persist the incoming change's before-image (when present) onto the tombstone so
	// a receiver relaying via getChangesSince re-emits it. Only the winning delete's
	// metadata is written here (in-batch losers never persist), so the surviving
	// priorRow is the latest delete's row image.
	ctx.tombstones.setTombstoneBatch(batch, change.schema, change.table, change.pk, change.hlc, change.priorRow);
	ctx.changeLog.recordDeletionBatch(batch, change.hlc, change.schema, change.table, change.pk);
}

/** Write a winning column's version + change-log entry, deleting any prior column entry. */
function commitColumnMetadata(
	ctx: SyncContext,
	batch: WriteBatch,
	change: ColumnChange,
	oldColumnVersion: ColumnVersion | undefined,
): void {
	// Delete the prior (pk, column) change-log entry if one exists.
	if (oldColumnVersion) {
		ctx.changeLog.deleteEntryBatch(batch, oldColumnVersion.hlc, 'column', change.schema, change.table, change.pk, change.column);
	}
	// Persist the before-image as this replica's local lineage: the version this
	// write replaced here (`oldColumnVersion`). In causal-order delivery that equals
	// the origin's prior, so re-relay forwards the origin's chain (the prior's own
	// origin HLC, never reset to this receiver's clock). A first write here records
	// no prior, matching the local write path in `recordColumnVersions`.
	const prior = oldColumnVersion
		? { priorHlc: oldColumnVersion.hlc, priorValue: oldColumnVersion.value }
		: undefined;
	ctx.columnVersions.setColumnVersionBatch(
		batch,
		change.schema,
		change.table,
		change.pk,
		change.column,
		{ hlc: change.hlc, value: change.value, ...prior },
	);
	ctx.changeLog.recordColumnChangeBatch(batch, change.hlc, change.schema, change.table, change.pk, change.column);
}

/**
 * Bump `lastDirectlyMappedWriteAt` for each non-directly-mapped tracked basis
 * table that received an inbound (remote) write this apply — the dynamic
 * basis-retirement signal (docs/migration.md § 2 Converge). Every `appliedChange`
 * is remote (self-origin is skipped before resolution), so any write to a legacy
 * table is presumed to originate at a peer that still maps it directly: a
 * deliberately conservative over-estimate that errs toward RETAINING storage
 * (under-counting would risk a premature drop). A `directly-mapped` table (the
 * local peer still maps it) is ordinary sync traffic, not a retirement signal —
 * skipped, so the common pre-migration case touches nothing.
 *
 * Cheap in the common case: one bounded `getAll` scan, and an immediate return
 * when no lifecycle records exist. Batched — one KV update per touched table, not
 * per change. Advisory: a failure is logged and swallowed so it can never abort
 * the apply (the next inbound write re-bumps the clock).
 */
async function bumpLastDirectlyMappedWrites(
	ctx: SyncContext,
	appliedChanges: Array<{ change: Change; siteId: SiteId }>,
): Promise<void> {
	if (appliedChanges.length === 0) return;
	try {
		const stored = await ctx.basisLifecycle.getAll();
		if (stored.size === 0) return; // pre-migration: nothing tracked, zero overhead

		// Per-table max inbound wall-time among writes to a NON-directly-mapped record.
		const maxWall = new Map<string, bigint>();
		for (const { change } of appliedChanges) {
			const key = `${change.schema}.${change.table}`.toLowerCase();
			const record = stored.get(key);
			if (!record || record.state === 'directly-mapped') continue;
			const cur = maxWall.get(key);
			if (cur === undefined || change.hlc.wallTime > cur) maxWall.set(key, change.hlc.wallTime);
		}
		if (maxWall.size === 0) return;

		const batch = ctx.kv.batch();
		let wrote = false;
		for (const [key, wall] of maxWall) {
			const record = stored.get(key)!;
			const next = Math.max(record.lastDirectlyMappedWriteAt ?? 0, Number(wall));
			if (next !== (record.lastDirectlyMappedWriteAt ?? 0)) {
				ctx.basisLifecycle.put(batch, { ...record, lastDirectlyMappedWriteAt: next });
				wrote = true;
			}
		}
		if (wrote) await batch.write();
	} catch (error) {
		console.warn(
			`[Sync] bumpLastDirectlyMappedWrites failed (advisory; eviction clock not updated this apply): `
				+ `${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

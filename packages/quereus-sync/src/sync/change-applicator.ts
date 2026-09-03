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
import { encodePkIdentity, joinKeyParts, RAW_PK_KEYING } from '../metadata/keys.js';
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
import { migrationObjectKind, sameVersionLocalDDL, sortMigrationsByHLC, toSchemaChange } from './protocol.js';
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
	/**
	 * For a row's winning in-batch delete under `allowResurrection`: columns of this
	 * row whose same-batch write beat the delete, so the post-commit cleanup keeps
	 * them. Filled by {@link reconcileInBatchDeletes}.
	 */
	keepColumns?: Set<string>;
	/**
	 * For a column change that BEAT a same-batch delete under `allowResurrection`:
	 * the delete erased this cell's local lineage before the write landed, so the
	 * write records no before-image. {@link oldColumnVersion} still travels with it
	 * — its stale `cl:` entry must be dropped, and the delete's cleanup now skips
	 * this column. Filled by {@link reconcileInBatchDeletes}.
	 */
	priorErasedByInBatchDelete?: boolean;
	/**
	 * Table exists only via this same batch's create_table — no local schema (and so
	 * no resolvable pk-identity keying) until Phase 2's DDL runs.
	 */
	freshLocalTable?: boolean;
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

/** What this batch's schema steps leave behind for one `(schema, table)`. */
interface BatchTableFate {
	/** The table exists after this batch's schema steps replay in timestamp order. */
	present: boolean;
	/**
	 * The name this name's surviving table has its sync bookkeeping (`cv:`/`tb:`/`cl:`)
	 * filed under, or `undefined` when it has none — the name ends up empty, or its table
	 * was CREATED by this batch. The bookkeeping is keyed by table name and nothing
	 * re-files it on a rename (`bug-sync-rename-and-pk-change-strand-crdt-metadata`), so
	 * this is the name's own key for a table that stays put and the OLD name for one that
	 * arrives by rename. `historyName !== key` on a PRESENT name therefore means the
	 * bookkeeping stranded there describes a table that is no longer there — exactly the
	 * read-free (`freshLocalTable`) condition at the resolve site.
	 */
	historyName: string | undefined;
}

/**
 * Per-table verdict on what this batch's schema migrations leave behind, keyed
 * `schema.table`. Names no kept migration mentions are absent from the map; the read
 * sites fall back to the current basis for those.
 *
 * The verdict is needed at Phase 1, before any DDL executes at Phase 2, so it is
 * SIMULATED: seed each mentioned name with whether the receiver has it NOW
 * (`isPresentLocally`), then replay the three existence-changing migration kinds in
 * HLC order — `migrations` arrives already ordered by {@link orderMigrationsByHLC},
 * the same order Phase 2 replays them in — applying the same decision each kind's
 * {@link decideSchemaChange} arm will reach against the catalog.
 *
 * Both halves of that are load-bearing:
 *
 * - Seeding from local presence is what keeps this verdict and the catalog-based one
 *   in `decideRenameTable` from disagreeing. A `rename_table` moves the name only when
 *   the receiver still HAS the old one; a rename it declines (the old name was dropped
 *   here, or `fromTable` is missing) leaves the new name as absent as it really will
 *   be, so the batch's rows for that name take the normal unknown-table route instead
 *   of reaching a table that does not exist and throwing the whole batch away.
 * - Replaying only the KEPT migrations (Phase 1a drops the HLC-dominated ones) is what
 *   makes the seed meaningful: a dominated migration means the receiver already
 *   processed that fact, so its effect — and anything it did LATER, like dropping the
 *   table again — is already in the seeded presence. Replaying it a second time would
 *   resurrect a state the receiver has since moved past.
 *
 * The simulation tracks WHICH table ends up at each name, not merely whether one does:
 * {@link BatchTableFate.historyName} follows the table, the sync bookkeeping does not.
 * That is what separates the two ways a name is vacated and refilled — a `drop_table`
 * destroys its occupant, so anything arriving afterwards is a stranger to the
 * bookkeeping left behind, while a rename-away followed by a rename BACK returns the
 * very table the bookkeeping describes.
 */
function computeBatchTableFates(
	migrations: readonly SchemaMigration[],
	isPresentLocally: (schema: string, table: string) => boolean,
): Map<string, BatchTableFate> {
	const fates = new Map<string, BatchTableFate>();
	const fateOf = (schema: string, table: string): BatchTableFate => {
		const key = tableKey(schema, table);
		let fate = fates.get(key);
		if (!fate) {
			// A table the receiver already holds has its bookkeeping under its own name.
			//
			// NOTE: the seed reads the `getTableSchema` basis oracle while Phase 2 decides
			// the DDL against `db.schemaManager` directly. The shipped wiring makes them the
			// same answer; a host whose oracle deliberately hides a table the catalog has
			// would make this simulation predict a decline the store adapter then executes,
			// and the batch's rows for that name would be held rather than applied (the
			// drain recovers them on the next sweep). If a narrowing oracle ever ships,
			// give the simulation a catalog-presence input of its own.
			const present = isPresentLocally(schema, table);
			fate = { present, historyName: present ? key : undefined };
			fates.set(key, fate);
		}
		return fate;
	};

	for (const migration of migrations) {
		switch (migration.type) {
			case 'create_table': {
				const fate = fateOf(migration.schema, migration.table);
				// Already present ⇒ `decideSchemaChange` converges without executing, so the
				// local table, its rows and its bookkeeping all survive untouched; only an
				// absent → present transition leaves a genuinely empty table with no history.
				if (!fate.present) {
					fate.present = true;
					fate.historyName = undefined;
				}
				break;
			}
			case 'drop_table': {
				const fate = fateOf(migration.schema, migration.table);
				fate.present = false;
				fate.historyName = undefined;
				break;
			}
			case 'rename_table': {
				// Mirrors `decideRenameTable`: no `fromTable` (an omitting peer) is
				// undecidable and converges without applying, so neither name moves.
				if (migration.fromTable === undefined) break;
				const from = fateOf(migration.schema, migration.fromTable);
				const to = fateOf(migration.schema, migration.table);
				// Old absent ⇒ the receiver declines (a local drop won, or the rename
				// already happened here). Both present ⇒ `decideRenameTable` throws a
				// collision and the whole admission unit aborts; predict no movement.
				if (!from.present || to.present) break;
				to.present = true;
				// The table moves; its bookkeeping stays where it was filed.
				to.historyName = from.historyName;
				from.present = false;
				from.historyName = undefined;
				break;
			}
		}
	}
	return fates;
}

/**
 * Apply change sets from a remote peer.
 *
 * Three-phase process:
 *   1. Resolve all changes (no writes); divert out-of-basis straggler changes
 *   2. Apply data to store via callback
 *   3. Commit CRDT metadata (+ durable quarantine of diverted changes)
 *
 * ORDER-INDEPENDENT: `changes` may arrive in any order and produces the same
 * committed state as the HLC-ordered array. Callers need not (and do not) preserve
 * timestamp order — the coordinator's `onBeforeApplyChanges` approval hook returns a
 * caller-supplied array, and the REST/WebSocket ingress accepts an arbitrary array
 * from any client. Everything whose outcome depends on order is re-derived from the
 * HLCs here rather than from arrival position: resolution and
 * {@link reconcileInBatchDeletes} already compare HLCs, the store apply list is sorted
 * by {@link orderDataChangesByHLC}, the DDL list by {@link orderMigrationsByHLC}, and
 * the emitted payload by {@link emitRemoteChanges}. Everything else (the counters, the
 * quarantine holds, the watermark max) is order-insensitive by construction. The
 * guarantee covers committed STATE, not the event stream: `onConflictResolved` fires
 * from the resolve loop in arrival order, and an `onUnknownTable` event reports the
 * FIRST changeset that referenced the table as the straggler origin, so a reordered
 * batch can name a different relayer — telemetry only, never a stored fact.
 *
 * Unknown-table disposition: a change referencing a table the batch leaves absent — not
 * in the local basis and not created by this batch's schema steps (a retired-table
 * straggler delta — see `docs/migration.md` § 4 Contract) — is **diverted** during
 * resolution — never resolved, applied, or recorded as CRDT
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

	const schemaChangesToApply: SchemaChangeToApply[] = [];
	const appliedChanges: Array<{ change: Change; siteId: SiteId }> = [];
	const resolvedDataChanges: ResolvedChange[] = [];
	// Every data-change resolution in batch order, with its relaying changeset's
	// siteId. Counters and apply lists are built from these AFTER the in-batch
	// delete reconciliation below, not inside the resolve loop.
	const dataResolutions: Array<{ resolved: ResolvedChange; siteId: SiteId }> = [];
	const pendingSchemaMigrations: Array<{
		migration: SchemaMigration;
		schemaVersion: number;
	}> = [];
	// Out-of-basis straggler changes diverted out of the resolve/apply/metadata
	// path, grouped per table for disposition + telemetry.
	const unknownByTable = new Map<string, UnknownTableGroup>();

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

	// PHASE 1a: Schema migrations, batch-wide and HLC-ordered (DDL before DML — the
	// whole batch's schema changes run before any of its data, see admitGroup). Two
	// migrations for ONE table are order-dependent (a `drop_table` replayed after the
	// `create_table` that should follow it leaves the table absent), and `applyChanges`
	// does not trust arrival order, so sort by HLC rather than walking the changesets in
	// receipt order. For a well-ordered batch the sort is a no-op: per-table HLC order
	// IS schemaVersion order (the origin assigns versions monotonically as it ticks).
	// It also pins the `migration.schemaVersion ?? getCurrentVersion() + 1` fallback
	// below, which reads storage that no migration in this batch has written yet.
	for (const migration of orderMigrationsByHLC(changes)) {
		// NOTE: the `??` fallback reads storage no migration in this batch has written
		// yet, so two migrations of ONE object that BOTH omit `schemaVersion` compute
		// the SAME version and collapse onto one `sm:` key (the later, max-HLC, wins).
		// Unreachable today — `SchemaMigration.schemaVersion` is required, and
		// `collectSchemaMigrations` always carries the stored value; if a wire format
		// ever makes it optional in practice, assign in-batch versions here instead.
		const kind = migrationObjectKind(migration.type);
		const schemaVersion = migration.schemaVersion ??
			(await ctx.schemaMigrations.getCurrentVersion(migration.schema, kind, migration.table)) + 1;

		const existingMigration = await ctx.schemaMigrations.getMigration(
			migration.schema,
			kind,
			migration.table,
			schemaVersion,
		);

		if (existingMigration) {
			if (compareHLC(migration.hlc, existingMigration.hlc) <= 0) {
				skipped++;
				continue;
			}
		}

		// The record fetched above is exactly what the store adapter needs to judge
		// this migration against — what THIS device's own migration at the same
		// version said, not what the object looks like now (a table altered since its
		// create no longer renders as the create that made it). No extra store read.
		schemaChangesToApply.push(toSchemaChange(migration, sameVersionLocalDDL(existingMigration, migration)));
		pendingSchemaMigrations.push({ migration, schemaVersion });
		applied++;
	}

	// What the batch's schema steps leave behind, simulated over the migrations Phase 1a
	// actually KEPT and seeded from what the receiver has now — so the verdict below
	// agrees with the catalog the DDL will be decided against.
	const batchFates = computeBatchTableFates(
		pendingSchemaMigrations.map(({ migration }) => migration),
		(schema, table) => ctx.isTableInBasis(schema, table),
	);

	// PHASE 1b: Resolve all data changes (no writes yet). The clock watermark is merged
	// once after a successful admission (see admitGroup below), not per changeset —
	// resolution reads stored versions via compareHLC, never the live clock.
	for (const changeSet of changes) {
		for (const change of changeSet.changes) {
			// Self-origin echo skip BEFORE unknown-table detection, so a self-change
			// to a retired table is skipped (counted), never quarantined. resolveChange
			// re-checks this defensively for any other caller.
			if (siteIdEquals(change.hlc.siteId, ctx.getSiteId())) {
				skipped++;
				continue;
			}

			// Structural unknown-table detection: a table this batch creates or drops is
			// known iff the batch's schema steps leave it PRESENT (its last create/drop
			// step in timestamp order is a create_table); one the batch does not touch
			// falls back to the current basis. Diverted changes never reach
			// resolveChange / dataChangesToApply / commitChangeMetadata, so no CRDT
			// metadata is written for a table the receiver does not have.
			const key = tableKey(change.schema, change.table);
			const inBasis = ctx.isTableInBasis(change.schema, change.table);
			const fate = batchFates.get(key);
			const known = fate ? fate.present : inBasis;
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
			//
			// A table this batch leaves under a name whose stranded bookkeeping describes
			// some OTHER table counts as fresh too, even when the receiver already has the
			// name: dropping or renaming a table does not move its cell versions and
			// tombstones, so resolving these rows against them would let a stale tombstone
			// silently discard them under the default `allowResurrection: false`. That is
			// `fate.historyName !== key` — a drop-then-re-create, or a swap that renames a
			// different table into the vacated name. A RE-DELIVERED drop/re-create batch —
			// every schema step dominated, no local schema changed, the local table already
			// the post-re-create incarnation — keeps `historyName === key` and resolves
			// normally against that incarnation's own metadata, and so does a name renamed
			// AWAY and BACK in one batch: the same table returns to its own bookkeeping.
			// (The broader question of a re-created table INHERITING that bookkeeping —
			// purge policy, relays, retention horizon — is tracked separately; this only
			// stops the in-batch recreate consulting it.)
			//
			// NOTE: `!inBasis` still resolves read-free for a table that arrives under a
			// name the receiver does NOT currently have, including by rename. That name may
			// carry metadata stranded by an earlier incarnation, which the arriving table's
			// rows then skip. Unavoidable today — an out-of-basis name has no schema and so
			// no resolvable pk keying — and the same for `create_table`; if the stranded
			// bookkeeping is ever purged or re-keyed on drop/rename
			// (`bug-sync-recreated-table-inherits-dropped-table-metadata`), narrow this.
			const freshLocalTable = !inBasis || (fate !== undefined && fate.historyName !== key);

			const resolved = await resolveChange(ctx, change, freshLocalTable);
			if (freshLocalTable) resolved.freshLocalTable = true;
			dataResolutions.push({ resolved, siteId: changeSet.siteId });
		}
	}

	// In-batch delete reconciliation: Phase 1 resolved each change against
	// PRE-batch stored state only, so a delete and a column change for the same
	// row in this one batch never saw each other. Apply the tombstone-blocking
	// rule across the batch BEFORE any data or metadata write, then build the
	// counters, the store apply list, and the emitted-change list from the
	// reconciled outcomes — so `ApplyResult` and `onRemoteChange` reflect what is
	// actually written.
	const reconciled = reconcileInBatchDeletes(ctx, dataResolutions.map(entry => entry.resolved));
	for (let i = 0; i < reconciled.length; i++) {
		const resolved = reconciled[i];
		if (resolved.outcome === 'applied') {
			applied++;
			appliedChanges.push({ change: resolved.change, siteId: dataResolutions[i].siteId });
			resolvedDataChanges.push(resolved);
		} else if (resolved.outcome === 'skipped') {
			skipped++;
		} else {
			conflicts++;
		}
	}

	const dataChangesToApply = orderDataChangesByHLC(resolvedDataChanges);

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
				await ctx.schemaMigrations.recordMigration(
					migration.schema,
					migrationObjectKind(migration.type),
					migration.table,
					{
						type: migration.type,
						// Carry the rename's old name into local storage, or this
						// receiver's own re-relay/snapshot would ship the rename
						// without it — undecidable downstream.
						...(migration.fromTable !== undefined ? { fromTable: migration.fromTable } : {}),
						ddl: migration.ddl,
						hlc: migration.hlc,
						schemaVersion,
					},
				);
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
	// migration that makes a NAME exist — a `create_table`, or a `rename_table` moving a
	// table onto that name — may have revived a previously-retired table that has held
	// out-of-basis changes waiting on it. Replay them NOW — as a SEPARATE post-commit
	// apply unit, after the admitting batch above has fully committed (fresh data lands
	// first, held changes LWW-resolve against it) — instead of waiting up to one
	// periodic-sweep interval. Only applied migrations are in `pendingSchemaMigrations`
	// (an HLC-dominated create_table `continue`s before being pushed), so a losing
	// create never triggers a drain. A batch whose schema steps leave the table ABSENT
	// (a trailing drop_table) has its key skipped to avoid a wasted scoped
	// `quarantine.list` — a drop-then-create batch leaves it PRESENT and does drain.
	// A migration the simulation never modelled has no fate entry (only a
	// `rename_table` with no `fromTable`, which returns before reaching `fateOf`): fall
	// back to the basis, read HERE — post-DDL — so it is the exact post-batch answer.
	// Advisory: `drainReappearedTables` logs + swallows any failure, so a drain throw
	// never turns this successful apply into an error.
	const reappeared = new Map<string, { schema: string; table: string }>();
	for (const { migration } of pendingSchemaMigrations) {
		if (migration.type !== 'create_table' && migration.type !== 'rename_table') continue;
		const key = tableKey(migration.schema, migration.table);
		const fate = batchFates.get(key);
		if (!(fate ? fate.present : ctx.isTableInBasis(migration.schema, migration.table))) continue;
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
 * Order one reconciled batch's store operations by HLC.
 *
 * {@link DataChangeToApply} carries no timestamp, so the store adapter replays each
 * row group in ARRIVAL order (`buildRowOp` in store-adapter.ts) while resolution and
 * {@link reconcileInBatchDeletes} decide by HLC. `applyChanges` takes whatever
 * transaction array its caller hands it — the coordinator's approval hook and the
 * REST/WebSocket ingress neither preserve nor produce timestamp order — so arrival
 * order is not trustworthy. Sorting here, in the one place that still holds the HLCs,
 * makes the table contents follow the same rule as the metadata whatever order the
 * batch arrived in, without threading an HLC through the whole store seam.
 *
 * A GLOBAL sort suffices: the adapter groups by table, then by row, so only the
 * relative order WITHIN one row group is load-bearing. `compareHLC` is a total order
 * over `(wallTime, counter, siteId, opSeq)` and `Array.prototype.sort` is stable, so
 * equal HLCs — the same fact — keep arrival order.
 *
 * It also lands the resurrection case right: {@link reconcileInBatchDeletes} already
 * skipped every column change at or below the winning delete's HLC, so the only column
 * ops left for that row are strictly later than the delete — the sort puts the delete
 * first and `buildRowOp` rebuilds the row from primary key + nulls, which is what the
 * metadata says happened.
 */
function orderDataChangesByHLC(applied: readonly ResolvedChange[]): DataChangeToApply[] {
	const withOps = applied.filter(
		(resolved): resolved is ResolvedChange & { dataChange: DataChangeToApply } =>
			resolved.dataChange !== undefined,
	);
	withOps.sort((a, b) => compareHLC(a.change.hlc, b.change.hlc));
	return withOps.map(resolved => resolved.dataChange);
}

/**
 * Flatten a batch's schema migrations into one HLC-ordered list.
 *
 * Same reason as {@link orderDataChangesByHLC}: the DDL list reaches the store adapter
 * as a plain array replayed in order, so arrival order across changesets must not
 * decide which runs first. Ordering itself is {@link sortMigrationsByHLC}.
 */
function orderMigrationsByHLC(changes: readonly ChangeSet[]): SchemaMigration[] {
	return sortMigrationsByHLC(changes.flatMap(changeSet => [...changeSet.schemaMigrations]));
}

/**
 * Emit `onRemoteChange` for applied changes, grouped by a per-change origin site
 * id. Shared by the wire apply (grouping by the relaying changeset's `siteId`) and
 * the drain path (grouping by each held change's original origin `hlc.siteId`), so
 * downstream reactivity — MV maintenance, `Database.watch`, UI — fires identically
 * on a revival as on a fresh remote apply. No-op for an empty set.
 *
 * The payload is HLC-ordered for the same reason the store apply list is
 * ({@link orderDataChangesByHLC}): it is built from the same reconciled list, so a
 * reordered batch would otherwise hand a listener the batch's facts in an order that
 * contradicts the state just committed. Ordering is per emitted event, and the sort is
 * a total order, so each site's slice stays HLC-ordered too.
 */
function emitRemoteChanges(
	ctx: SyncContext,
	entries: Array<{ change: Change; siteId: SiteId }>,
): void {
	if (entries.length === 0) return;

	const ordered = [...entries].sort((a, b) => compareHLC(a.change.hlc, b.change.hlc));
	const changesBySite = new Map<string, Change[]>();
	for (const { change, siteId } of ordered) {
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

// NOTE: this file is 1204 lines (`wc -l`), second-largest in the package. The drain
// block below (`drainHeldChanges` → `drainReappearedTables`) shares only `resolveChange`,
// `reconcileInBatchDeletes`, `commitChangeMetadata`, and `admitGroup` with the wire-apply
// half above, so it is the natural seam if the file keeps growing.

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

	const resolvedDataChanges: ResolvedChange[] = [];
	const appliedEntries: Array<{ change: Change; siteId: SiteId }> = [];
	let applied = 0;
	let skipped = 0;

	const resolutions: ResolvedChange[] = [];
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
		resolutions.push(await resolveChange(ctx, change));
	}

	// Same in-batch delete reconciliation as applyChanges: a held delete and a held
	// column write for one row drain together and must block each other exactly as
	// they would arriving in one wire batch.
	for (const resolved of reconcileInBatchDeletes(ctx, resolutions)) {
		if (resolved.outcome === 'applied') {
			applied++;
			resolvedDataChanges.push(resolved);
			// Group revival events by the held change's ORIGINAL origin (its HLC
			// siteId) — a held change carries no relaying changeset.
			appliedEntries.push({ change: resolved.change, siteId: resolved.change.hlc.siteId });
		} else {
			skipped++;
		}
	}

	// Held entries already come back HLC-ordered (`buildQuarantineKey` puts the HLC
	// bytes first), so this is order-preserving today — it pins the same contract
	// applyChanges states rather than fixing a live inversion here.
	const dataChangesToApply = orderDataChangesByHLC(resolvedDataChanges);

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
 * Re-resolve column changes against deletes that landed in the SAME batch.
 *
 * Phase 1 compares each change only to PRE-batch stored state, so an in-batch
 * delete is invisible to an in-batch column change for the same row. This pass
 * applies the same tombstone-blocking rule as
 * `TombstoneStore.isDeletedAndBlocking`, with each row's max-HLC in-batch
 * APPLIED delete as the blocker:
 *   - `allowResurrection: false` (default): every same-row column change in the
 *     batch is blocked, whatever its HLC;
 *   - `allowResurrection: true`: a column change at or below the delete's HLC is
 *     blocked; one that beats it survives and is recorded on the winning
 *     delete's {@link ResolvedChange.keepColumns} so `commitChangeMetadata`'s
 *     post-commit cleanup keeps its cell record and change-log entry.
 *
 * Returns a same-length, same-order list with each blocked column change flipped
 * to `'skipped'` (its `dataChange` dropped, so it never reaches the store).
 * Net effect: one apply batch produces the same result as the same changes split
 * across separate applies.
 */
function reconcileInBatchDeletes(
	ctx: SyncContext,
	resolved: ResolvedChange[],
): ResolvedChange[] {
	// Max-HLC applied in-batch delete per row identity. Ties keep the first, the
	// same preference keepMaxHLC applies, so the annotated delete below is the
	// object commitChangeMetadata's deleteWinners collapse keeps.
	const deleteWinnersByRow = new Map<string, ResolvedChange>();
	for (const entry of resolved) {
		if (entry.outcome !== 'applied' || entry.change.type !== 'delete') continue;
		const key = rowIdentityKey(ctx, entry.change, entry.freshLocalTable);
		const prev = deleteWinnersByRow.get(key);
		if (!prev || compareHLC(entry.change.hlc, prev.change.hlc) > 0) {
			deleteWinnersByRow.set(key, entry);
		}
	}
	if (deleteWinnersByRow.size === 0) return resolved;

	return resolved.map(entry => {
		if (entry.outcome !== 'applied' || entry.change.type !== 'column') return entry;
		const winner = deleteWinnersByRow.get(rowIdentityKey(ctx, entry.change, entry.freshLocalTable));
		if (!winner) return entry;
		if (ctx.config.allowResurrection && compareHLC(entry.change.hlc, winner.change.hlc) > 0) {
			(winner.keepColumns ??= new Set()).add(entry.change.column);
			// Phase 1 read this cell's PRE-batch version as the before-image, but the
			// in-batch delete erases that lineage: applied in separate batches the
			// resurrecting write finds no version at all and records no prior (which is
			// also what the ORIGIN recorded past its own delete). Drop the prior so the
			// stored version — and everything getChangesSince relays from it — matches.
			return { ...entry, priorErasedByInBatchDelete: true };
		}
		return { outcome: 'skipped', change: entry.change };
	});
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
 *
 * Cross-type (delete vs column) same-row collisions were already settled upstream by
 * {@link reconcileInBatchDeletes}: every column change still `'applied'` here is one
 * that must be written, and a winning delete's {@link ResolvedChange.keepColumns}
 * names the columns its cleanup must leave alone.
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
		commitColumnMetadata(ctx, batch, change, resolved.oldColumnVersion, resolved.priorErasedByInBatchDelete);
	}
	await batch.write();

	// Column-version cleanup for deletes requires async iteration — once per winning
	// delete (losers were never written, so there is nothing of theirs to clean). The
	// row's change-log column entries go in the same batch as its versions: an inbound
	// delete must leave no more index garbage behind than a local one, and this is the
	// path a relay runs almost exclusively. `keepColumns` spares the cell records this
	// same batch wrote past the delete (allowResurrection winners) — the scan reads
	// committed storage, which by now INCLUDES them (the metadata batch above is
	// already written, so no staged overlay is needed here; each cleanup commits in
	// its own batch).
	for (const resolved of deleteWinners.values()) {
		const change = resolved.change;
		if (change.type !== 'delete') continue;
		const cleanupBatch = ctx.kv.batch();
		await deleteRowVersionsAndLogEntries(ctx, cleanupBatch, change.schema, change.table, change.pk, {
			keepColumns: resolved.keepColumns,
		});
		await cleanupBatch.write();
	}
}

// Grouping keys reuse the pk-identity encoding so in-batch grouping matches the canonical
// pk identity of the actual KV keys (buildTombstoneKey / buildColumnVersionKey) — two pks
// collapse here iff they would collide on disk ('apple'/'APPLE' under nocase, 'PT1H'/'PT60M').

/**
 * Row-identity grouping key shared by the collapse maps and the in-batch delete
 * reconciliation. A fresh-local table (created by this same batch, pre-DDL) has no
 * resolvable keying yet, so its changes group under the raw encoding — internally
 * consistent within the batch, which is all the reconciliation needs. (The Phase-3
 * collapse runs post-DDL with the resolved keying; for a fresh table with
 * collation-variant pk spellings in ONE batch the two groupings can disagree, an
 * edge accepted here.)
 *
 * Components are length-prefixed ({@link joinKeyParts}), not punctuation-joined, for
 * the same reason the on-disk keys are: a table name may contain `:` or `.` and a pk
 * identity contains both, so a `{schema}.{table}:{identity}` join would let two rows
 * of DIFFERENT tables collapse onto one winner and silently drop a change.
 */
function rowIdentityKey(ctx: SyncContext, change: Change, freshLocalTable?: boolean): string {
	const keying = freshLocalTable ? RAW_PK_KEYING : ctx.getPkKeying(change.schema, change.table);
	return joinKeyParts(change.schema, change.table, encodePkIdentity(change.pk, keying));
}

/** Stable per-pk key for collapsing repeated delete entries within one batch. */
function deleteKey(ctx: SyncContext, change: RowDeletion): string {
	return `delete:${rowIdentityKey(ctx, change)}`;
}

/** Stable per-(pk, column) key for collapsing repeated column entries within one batch. */
function columnKey(ctx: SyncContext, change: ColumnChange): string {
	return `column:${rowIdentityKey(ctx, change)}${joinKeyParts(change.column)}`;
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
	priorErasedByInBatchDelete = false,
): void {
	// Delete the prior (pk, column) change-log entry if one exists. Still required
	// when the prior lineage is erased below — the entry is real storage, and the
	// winning delete's cleanup skips this column (see ResolvedChange.keepColumns).
	if (oldColumnVersion) {
		ctx.changeLog.deleteEntryBatch(batch, oldColumnVersion.hlc, 'column', change.schema, change.table, change.pk, change.column);
	}
	// Persist the before-image as this replica's local lineage: the version this
	// write replaced here (`oldColumnVersion`). In causal-order delivery that equals
	// the origin's prior, so re-relay forwards the origin's chain (the prior's own
	// origin HLC, never reset to this receiver's clock). A first write here records
	// no prior, matching the local write path in `recordColumnVersions` — as does a
	// write that resurrected past a same-batch delete, which erased that lineage.
	const prior = oldColumnVersion && !priorErasedByInBatchDelete
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

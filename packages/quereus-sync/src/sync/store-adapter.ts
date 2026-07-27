/**
 * Store adapter for applying remote sync changes.
 *
 * Implements the ApplyToStoreCallback interface over the store module's
 * external row-write entry point (`StoreTable.applyExternalRowChanges` —
 * table-owned key encoding, secondary-index and stats maintenance) plus the
 * engine's batch ingestion seam (`Database.ingestExternalRowChanges` — change
 * capture for `Database.watch` + global assertions, materialized-view
 * maintenance, opt-in parent-side FK actions).
 *
 * Per `applyToStore(dataChanges, schemaChanges, options)` invocation:
 *   1. Schema changes execute first via `db.exec` (DDL before DML), with the
 *      resulting module schema events pre-marked remote. Replicated DDL is
 *      applied IDEMPOTENTLY: an object already in the migration's wanted state
 *      with a matching definition is counted applied without re-exec'ing, so two
 *      peers that independently created the same table converge instead of the
 *      receiver failing "already exists" on every sync (see
 *      {@link decideSchemaChange}).
 *   2. Data changes are grouped per table, then per row; each row group
 *      collapses to ONE `ExternalRowOp` — the group's NET effect in arrival
 *      order (a delete resets the row to absent and later column updates
 *      rebuild it from PK+nulls; updates with no later delete merge onto the
 *      pre-read existing row — UPSERT semantics; see {@link buildRowOp}).
 *   3. `StoreTable.applyExternalRowChanges(ops)` applies the table's ops to
 *      committed storage and returns the EFFECTIVE changes (no-ops — absent
 *      delete, value-identical upsert — are suppressed: no storage write, no
 *      module event, no seam report).
 *   4. Module data events are emitted from the effective changes with
 *      `remote: true` (so the SyncManager never re-records inbound changes),
 *      carrying accurate `oldRow` before-images and derived `changedColumns`.
 *   5. After all tables' storage writes, ONE seam call reports the
 *      accumulated effective changes: `db.ingestExternalRowChanges(batch,
 *      { applyForeignKeyActions, assertionFailureMode: 'report' })` — capture +
 *      MV facets default on, commit-time global assertions in REPORT mode (a
 *      violation is collected into the result and the batch still commits).
 *      Changes recorded in `result.errors` are excluded from the batch.
 *
 * Snapshot bootstrap (per-call, not sticky): a known-complete wholesale load
 * defers MV maintenance and watch capture for the whole transfer and converges
 * once at the end.
 *   - `bootstrap` flush: steps 1–4 run unchanged (storage rows applied, remote
 *     module events emitted) but step 5 — the seam call — is SKIPPED. MV
 *     maintenance + capture are deferred to the finalize and FK actions are off
 *     for a wholesale load, so the only seam facet skipping the call drops
 *     outright is commit-time GLOBAL ASSERTION evaluation over the bootstrapped
 *     rows — deliberate under the seam's trust-the-origin contract. The
 *     incremental path enforces global assertions because it **merges** deltas
 *     from possibly many origins into the receiver's existing state, and a
 *     cross-origin merge can produce a global-invariant violation no single
 *     origin ever saw. Bootstrap does something different: it installs **one**
 *     origin's already-converged state **wholesale (replace, not merge)** — no
 *     merge means no merge-introduced violation, so a complete snapshot already
 *     satisfied the origin's assertions and re-checking is redundant. The
 *     `bootstrapFinalize` therefore does NOT evaluate any global assertion —
 *     not even a no-dependency one. This uniform skip is consistent with the
 *     seam's general trust-the-origin posture for every other constraint type
 *     (see `docs/mv-ingestion.md` § Trust boundary). MV-backed assertions
 *     would see the MV only after `refreshAllMaterializedViews()`; under
 *     trust-the-origin they are not evaluated at finalize at all, so MV-refresh
 *     ordering is moot for assertions. Residual risk (a corrupt/hostile snapshot
 *     installs invariant-violating data) is already unguarded for every other
 *     constraint type; a one-off assertion sweep would be inconsistent
 *     defense-in-depth — a separate integrity layer is the right fix if origins
 *     are ever distrusted. Per-flush evaluation also could not serve bootstrap
 *     correctly: it could spuriously fail a valid snapshot whose cross-table
 *     assertion sees children before parents. The remaining seam work for a
 *     wholesale load is otherwise deferred, so skipping the call also removes
 *     the per-flush transaction/savepoint and the per-flush full-rebuild.
 *   - `bootstrapFinalize` call (empty data/schema): converges every MV in
 *     dependency order via `db.refreshAllMaterializedViews()`, then fires a
 *     coarse `db.notifyExternalChange` per bootstrapped base table and per
 *     refreshed MV — one whole-table watch invalidation instead of per-row
 *     capture. The caller issues it before clearing the snapshot checkpoint, so
 *     a finalize throw leaves the checkpoint in place and the transfer retries.
 *
 * Inbound assertion violations are DETECT-AND-NOTIFY, not throw. Under the
 * seam's trust-the-origin contract the merged data must land regardless, so a
 * **local** commit-time global assertion can only usefully *notify*: the seam
 * runs in report mode, so a violation is collected and RETURNED in
 * `result.assertionViolations` while the batch commits — the derived effects
 * (MV backing deltas, capture entries) for the violating row land on the FIRST
 * attempt, so an incremental MV / `Database.watch` subscriber stays consistent
 * with the base table and there is no divergence and no retry. The consumer
 * (admission.ts) surfaces each returned violation to the host as an
 * `onAssertionViolation` event; the host decides policy.
 *
 * A genuine per-change STORAGE failure is different and still aborts: the
 * adapter collects it in `result.errors` (it keeps applying other tables), and
 * the consumer treats any non-empty `errors` like a whole-batch throw — emit
 * `status:'error'`, leave CRDT metadata uncommitted, re-resolve next sync.
 * Re-application is idempotent (value-identical upserts suppress). "Orthogonal"
 * (above) means the two outcomes are independent facts, NOT that a co-occurring
 * violation is dropped: when ONE batch carries both a per-change error and a
 * reported violation, the violation's row already committed in report mode, so
 * the consumer surfaces the `onAssertionViolation` event BEFORE the per-change
 * abort throws (see admission.ts `applyDataToStore`). The abort still blocks the
 * metadata commit and the batch still re-resolves.
 *
 * Constraints (see docs/mv-ingestion.md § External row-change
 * ingestion): the callback is host-driven — never invoke it from within
 * statement execution or vtab callbacks (exec-mutex deadlock), and hosts
 * should not drive it while holding an open explicit transaction on `db`
 * (the seam would join that transaction, so a later rollback diverges
 * MV/capture state from the already-committed storage rows; recoverable via
 * MV refresh).
 */

import type { BackingRowChange, Database, ExternalRowChange, Row, SqlValue, TableIndexSchema, TableSchema } from '@quereus/quereus';
import { compareSqlValues, generateIndexDDL, generateTableDDL } from '@quereus/quereus';
import type { ExternalRowOp, SchemaChangeEvent, StoreEventEmitter, StoreModule, StoreTable } from '@quereus/store';
import { makePkIdentityEncoder } from '../metadata/pk-identity.js';
import type {
  ApplyToStoreCallback,
  ApplyToStoreOptions,
  ApplyToStoreResult,
  DataChangeToApply,
  SchemaChangeToApply,
} from './protocol.js';
import { toError } from './sync-context.js';

/**
 * Options for creating a SyncStoreAdapter.
 */
export interface SyncStoreAdapterOptions {
  /** The Quereus database: DDL execution + `ingestExternalRowChanges` reporting. */
  db: Database;
  /**
   * The store module owning the synced tables. Each table is resolved per
   * apply via `getTableForExternalWrite`, which owns key encoding (incl.
   * per-PK-column collations), secondary-index maintenance, and per-table
   * store resolution (e.g. IndexedDB's one-database-per-table layout).
   */
  storeModule: StoreModule;
  /** The event emitter for data change events (the adapter emits `remote: true`). */
  events: StoreEventEmitter;
  /**
   * Parent-side FK actions on inbound update/delete (seam facet). Default
   * false — a replication stream usually carries the origin's cascade
   * effects; opt in only when the deployment's stream does not. When on, an
   * inbound parent delete cascades to local children through the full DML
   * pipeline; those cascaded child writes emit module events WITHOUT
   * `remote`, so they are recorded as local changes and propagate outward —
   * correct for the opt-in posture.
   */
  applyForeignKeyActions?: boolean;
}

/**
 * Creates an ApplyToStoreCallback for applying remote sync changes.
 *
 * This adapter handles:
 * - UPSERT semantics for column changes (insert if row doesn't exist, update if it does)
 * - Row deletions by primary key
 * - DDL execution for schema changes
 * - Post-apply reporting through the engine's ingestion seam (MV maintenance,
 *   `Database.watch` capture, opt-in FK actions)
 *
 * All data change events are emitted with `remote: true` to prevent
 * the SyncManager from re-recording CRDT metadata.
 */
export function createStoreAdapter(options: SyncStoreAdapterOptions): ApplyToStoreCallback {
  const { db, storeModule, events, applyForeignKeyActions = false } = options;

  return async (
    dataChanges: DataChangeToApply[],
    schemaChanges: SchemaChangeToApply[],
    applyOptions: ApplyToStoreOptions
  ): Promise<ApplyToStoreResult> => {
    // Bootstrap finalize carries no data/schema changes: converge the MVs whose
    // per-flush maintenance was deferred, then coarse-notify the watchers.
    if (applyOptions.bootstrapFinalize) {
      return finalizeBootstrap(db, applyOptions);
    }

    const result: ApplyToStoreResult = {
      dataChangesApplied: 0,
      schemaChangesApplied: 0,
      errors: [],
    };

    // Apply schema changes first (DDL before DML)
    for (const schemaChange of schemaChanges) {
      try {
        await applySchemaChange(db, events, schemaChange, applyOptions);
        result.schemaChangesApplied++;
      } catch (error) {
        result.errors.push({
          change: schemaChange,
          error: toError(error),
        });
      }
    }

    // Effective changes accumulated across all tables, in apply order,
    // for the single end-of-invocation seam call. The order here is
    // table-grouped (first-appearance opSeq); it is NOT a dependency
    // order and the FK-actions facet does not require one — both FK
    // helpers re-read post-write storage applied above.
    const seamBatch: ExternalRowChange[] = [];

    // Apply data changes per table; the resolved StoreTable owns key
    // encoding, store resolution, and secondary-index maintenance.
    const changesByTable = groupChangesByTable(dataChanges);
    for (const [, tableChanges] of changesByTable) {
      const { schema: schemaName, table: tableName } = tableChanges[0];
      try {
        const table = storeModule.getTableForExternalWrite(db, schemaName, tableName);
        if (!table) {
          throw new Error(`Table not found for external write: ${schemaName}.${tableName}`);
        }

        // One ExternalRowOp per row group: multiple same-row changes collapse
        // to a single effective op, so the seam's same-row before-image
        // chaining rule is satisfied trivially (oldRow = true pre-batch image).
        // Rows group by pk IDENTITY (key collation + semantic transform), so two
        // spellings of one row ('apple'/'APPLE' under nocase) collapse to ONE op
        // — matching how the store itself keys them.
        // NOTE: resolves the keying fresh per table per apply invocation; if apply
        // batches ever get hot enough for this to show up, cache per TableSchema
        // object like metadata/pk-identity.ts's resolver does.
        const pkIdentity = makePkIdentityEncoder(table.getSchema(), db.getKeyNormalizerResolver());
        const ops: ExternalRowOp[] = [];
        for (const rowChanges of groupChangesByRow(tableChanges, pkIdentity).values()) {
          ops.push(await buildRowOp(table, rowChanges));
        }

        const effective = await table.applyExternalRowChanges(ops);
        emitEffectiveChanges(events, table.getSchema(), effective);
        // On a bootstrap flush the seam is skipped (deferred to finalize), so
        // there is no batch to accumulate — don't build one.
        if (!applyOptions.bootstrap) {
          for (const change of effective) {
            seamBatch.push({ schemaName, tableName, change });
          }
        }
        result.dataChangesApplied += tableChanges.length;
      } catch (error) {
        // Errored changes are excluded from the seam batch; earlier tables'
        // applied changes still report below.
        for (const change of tableChanges) {
          result.errors.push({
            change,
            error: toError(error),
          });
        }
      }
    }

    // One seam call per invocation, after all storage writes. Driven in
    // assertion REPORT mode: a commit-time global-assertion violation over the
    // inbound batch is COLLECTED and returned (not thrown), and the batch still
    // commits — derived effects (MV deltas, watch capture) for the violating row
    // land on this FIRST attempt, so there is no divergence and no retry. The
    // returned violations are copied into the result for the consumer to surface
    // to the host (see admission.ts). Empty on a bootstrap flush (the batch was
    // never built — maintenance is deferred to the end-of-snapshot
    // `bootstrapFinalize` convergence). A genuine per-change storage failure
    // (collected in `result.errors`) still aborts the apply — that path is
    // orthogonal.
    if (seamBatch.length > 0) {
      const seamResult = await db.ingestExternalRowChanges(seamBatch, {
        applyForeignKeyActions,
        assertionFailureMode: 'report',
      });
      if (seamResult.assertionViolations.length > 0) {
        result.assertionViolations = seamResult.assertionViolations;
      }
    }

    return result;
  };
}

/**
 * Finalize a snapshot bootstrap: the per-flush MV maintenance and watch capture
 * were deferred (each bootstrap flush skipped the seam), so converge every MV
 * in dependency order and fire a coarse whole-table watch invalidation for each
 * bootstrapped base table and each refreshed MV — base-table and MV watchers
 * re-read once instead of seeing per-row capture.
 *
 * A throw from `refreshAllMaterializedViews` propagates to the caller, which
 * runs the finalize before clearing the snapshot checkpoint — so the checkpoint
 * survives and the transfer retries (the storage rows are already correct, so
 * the retry's finalize rebuilds cleanly).
 */
async function finalizeBootstrap(
  db: Database,
  options: ApplyToStoreOptions,
): Promise<ApplyToStoreResult> {
  const refreshed = await db.refreshAllMaterializedViews();

  // Coarse base-table invalidation per bootstrapped table (note the
  // table-then-schema argument order of `notifyExternalChange`)...
  for (const { schema, table } of options.bootstrapTables ?? []) {
    await db.notifyExternalChange(table, schema);
  }
  // ...and per refreshed MV, so MV watchers re-read.
  for (const { schemaName, name } of refreshed) {
    await db.notifyExternalChange(name, schemaName);
  }

  return { dataChangesApplied: 0, schemaChangesApplied: 0, errors: [] };
}

/**
 * Group data changes by table (schema.table).
 *
 * NOTE: the joined key is ambiguous if a SCHEMA name contains a dot — schema
 * `"main.a"` table `b` collides with schema `main` table `"a.b"`, merging two
 * tables' changes into one group. Consumers must read `(schema, table)` off a
 * grouped change (never re-split the key), so today the only cost is a
 * misgrouped write when both dotted-schema tables exist. If dotted schema names
 * ever become reachable, key on a delimiter that identifiers cannot contain
 * (e.g. length-prefixed, or ` `).
 */
function groupChangesByTable(
  changes: DataChangeToApply[]
): Map<string, DataChangeToApply[]> {
  const grouped = new Map<string, DataChangeToApply[]>();

  for (const change of changes) {
    const tableKey = `${change.schema}.${change.table}`;
    const existing = grouped.get(tableKey);
    if (existing) {
      existing.push(change);
    } else {
      grouped.set(tableKey, [change]);
    }
  }

  return grouped;
}

/**
 * Group one table's data changes by row, keyed on the pk IDENTITY (the caller's
 * `pkIdentity` encoder — key collation + semantic transform), so all spellings
 * of one row land in one group. Only ever called with a single table's changes,
 * so the identity alone is a sufficient key.
 */
function groupChangesByRow(
  changes: DataChangeToApply[],
  pkIdentity: (pk: SqlValue[]) => string
): Map<string, DataChangeToApply[]> {
  const grouped = new Map<string, DataChangeToApply[]>();

  for (const change of changes) {
    const rowKey = pkIdentity(change.pk);
    const existing = grouped.get(rowKey);
    if (existing) {
      existing.push(change);
    } else {
      grouped.set(rowKey, [change]);
    }
  }

  return grouped;
}

/**
 * What to do with one replicated DDL statement, decided BEFORE any database or
 * event-expectation state is touched.
 */
type SchemaChangeAction =
  /** Run the DDL as-is. */
  | 'execute'
  /** The object is already in the migration's wanted state — count it applied, exec nothing. */
  | 'already-applied';

/**
 * Normalize a DDL string for definition comparison: trim, drop a trailing `;`,
 * collapse whitespace runs to a single space, lowercase.
 *
 * Case-insensitive is deliberate — Quereus identifiers are already
 * case-insensitive (`SchemaManager.getTable` lowercases), and a peer whose table
 * was created through a different module may emit different keyword casing.
 *
 * NOTE: the whitespace collapse and the lowercase both reach inside string
 * literals, so two definitions differing ONLY inside a literal (e.g.
 * `default 'a  b'` vs `default 'a b'`, or `default 'X'` vs `default 'x'`) compare
 * equal and the duplicate create is treated as converged. Harmless for the shapes
 * canonical DDL emits today; if literal-sensitive column defaults ever matter
 * here, compare the parsed schemas instead of their rendered strings.
 */
function normalizeDDL(ddl: string): string {
  // Strip the trailing `;` (with any whitespace after it) BEFORE collapsing, then
  // trim again — collapsing first would leave the `;`-adjacent space behind.
  return ddl.replace(/;\s*$/, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Locate the table owning `indexName` in `schemaName`, case-insensitively.
 *
 * There is no direct index accessor on the schema manager, so this mirrors the
 * owner scan `SchemaManager.dropIndex` performs.
 */
function findIndexOwner(
  db: Database,
  schemaName: string,
  indexName: string,
): { table: TableSchema; index: TableIndexSchema } | undefined {
  const schema = db.schemaManager.getSchema(schemaName);
  if (!schema) return undefined;

  const lowerIndexName = indexName.toLowerCase();
  for (const table of schema.getAllTables()) {
    const index = table.indexes?.find(idx => idx.name.toLowerCase() === lowerIndexName);
    if (index) return { table, index };
  }
  return undefined;
}

/**
 * The object named by the migration already exists locally: converge silently if
 * its definition matches the replicated one, otherwise throw a conflict naming
 * both definitions.
 *
 * NOTE: a genuinely DIVERGENT concurrent `create_table` (same name, different
 * shape on two peers) has no automatic convergence path — this throw aborts the
 * batch's metadata commit, so the batch re-resolves and re-fails until an
 * operator intervenes. Resolving it automatically would need last-writer-wins
 * over schema definitions (apply the higher-HLC shape as a migration, rewriting
 * the local table), which is a much larger change. If divergent concurrent
 * creates start showing up in practice, that is the work to do.
 */
function assertDefinitionMatches(
  change: SchemaChangeToApply,
  localDDL: string,
): void {
  if (normalizeDDL(localDDL) === normalizeDDL(change.ddl)) return;

  throw new Error(
    `Schema conflict applying remote ${change.type} for ${change.schema}.${change.table}: ` +
    `a different definition already exists locally.\n` +
    `  local:  ${localDDL}\n` +
    `  remote: ${change.ddl}`
  );
}

/**
 * Decide whether a replicated DDL statement still needs to run. Never called
 * with a blank `ddl` — {@link applySchemaChange} short-circuits that first.
 *
 * Replication delivers a migration to peers that may already be in its wanted
 * state — two offline peers can each `create table orders`, and whichever
 * migration wins the HLC comparison is then admitted at a peer that already has
 * the table. Re-exec'ing raw DDL there throws ("Table main.orders already
 * exists"), which aborts the whole admission unit and permanently blocks that
 * peer's metadata commit. So decide first, and only execute when the object is
 * NOT already in the wanted state.
 *
 * Throws on a same-name/different-definition collision — silently keeping the
 * local shape and committing the metadata would record "converged" for a
 * divergence that is not converged (see {@link assertDefinitionMatches}).
 *
 * NOTE: presence is read from the in-memory catalog (`db.schemaManager`), which
 * is assumed to reflect what is persisted — true once a database has finished
 * `rehydrateCatalog`. If a peer ever drives sync against a half-rehydrated
 * catalog, a table present in storage but absent from the catalog decides
 * `execute` and the underlying "already exists" throw returns.
 */
function decideSchemaChange(db: Database, change: SchemaChangeToApply): SchemaChangeAction {
  switch (change.type) {
    case 'create_table': {
      const local = db.schemaManager.getTable(change.schema, change.table);
      if (!local) return 'execute';
      // Both sides render through `generateTableDDL` with no `db` argument, so
      // the strings are fully qualified and session-independent — directly
      // comparable against the DDL the origin put on the wire.
      // NOTE: that symmetry is a property of the store module (it is the only
      // module that puts DDL on the wire today). A second DDL-emitting module
      // rendering the same table some other way would be reported as a conflict
      // rather than converging; the comparison would then need to be over parsed
      // schemas, not rendered strings.
      assertDefinitionMatches(change, generateTableDDL(local));
      return 'already-applied';
    }
    case 'drop_table':
      return db.schemaManager.getTable(change.schema, change.table) ? 'execute' : 'already-applied';
    case 'add_index': {
      // For an index migration `change.table` holds the INDEX name, not the
      // table name (see `mapSchemaMigrationType` / `recordSchemaMigration`).
      const owner = findIndexOwner(db, change.schema, change.table);
      if (!owner) return 'execute';
      assertDefinitionMatches(change, generateIndexDDL(owner.index, owner.table));
      return 'already-applied';
    }
    case 'drop_index':
      return findIndexOwner(db, change.schema, change.table) ? 'execute' : 'already-applied';
    default:
      // Column-level migrations (add_column / drop_column / alter_column) carry
      // no object-lifecycle state to compare; run them as before.
      return 'execute';
  }
}

/**
 * The module schema-event signature the migration's DDL will produce — the exact
 * inverse of `mapSchemaMigrationType` (sync-manager-impl.ts), which is what
 * recorded the migration on the origin in the first place.
 *
 * Keeping the two inverse is load-bearing: the signature is what pre-marks the
 * emitted event remote, and a signature that never matches means the receiver
 * records the replicated DDL as its OWN local migration and broadcasts it back
 * out. Deriving it from the migration type by string-shape (`startsWith('drop')`,
 * `includes('table')`) does not survive the `add_index` / `*_column` names, so
 * map explicitly.
 */
function schemaEventSignature(
  type: SchemaChangeToApply['type'],
): { type: SchemaChangeEvent['type']; objectType: SchemaChangeEvent['objectType'] } {
  switch (type) {
    case 'create_table': return { type: 'create', objectType: 'table' };
    case 'drop_table': return { type: 'drop', objectType: 'table' };
    case 'add_index': return { type: 'create', objectType: 'index' };
    case 'drop_index': return { type: 'drop', objectType: 'index' };
    // Column-level migrations replay as an ALTER of the owning table — matching
    // the `'table' alter → alter_column` direction of mapSchemaMigrationType.
    case 'add_column':
    case 'drop_column':
    case 'alter_column':
      return { type: 'alter', objectType: 'table' };
  }
}

/**
 * Apply one schema change (DDL) to the database, idempotently.
 */
async function applySchemaChange(
  db: Database,
  events: StoreEventEmitter,
  change: SchemaChangeToApply,
  _options: ApplyToStoreOptions
): Promise<void> {
  // A blank `ddl` still reaches here: the four object-lifecycle migrations
  // (create/drop table, add/drop index) now carry canonical text, but the
  // `*_column` migrations do not, and a peer on an older build still sends blank
  // drop/index migrations. Such a migration runs nothing, so it also EMITS
  // nothing — registering a remote-event expectation for it would leave that
  // expectation pending forever (the emitter refcounts expectations and never
  // expires them), and the next genuine LOCAL DDL of the same signature would be
  // consumed by it, marked remote, and dropped from the SyncManager's local-fact
  // capture — silently never replicated.
  if (change.ddl.trim() === '') return;

  // Decide BEFORE registering the remote-event expectation, for the same reason:
  // an expectation for DDL that is then not executed would linger and mis-mark a
  // later genuine LOCAL DDL of the same signature as remote.
  if (decideSchemaChange(db, change) === 'already-applied') {
    console.debug(
      `[Sync] Remote ${change.type} for ${change.schema}.${change.table} already applied locally — converging without re-executing DDL`
    );
    return;
  }

  const { type: eventType, objectType } = schemaEventSignature(change.type);

  // Register this as an expected remote event BEFORE executing DDL.
  // When the module emits the event, it will be automatically marked as
  // remote, so SyncManager won't re-record it.
  // This approach avoids race conditions with concurrent local DDL.
  events.expectRemoteSchemaEvent({
    type: eventType,
    objectType,
    schemaName: change.schema,
    objectName: change.table,
  });

  try {
    // Execute the DDL statement
    // The module will emit a schema event, which will be marked as remote
    await db.exec(change.ddl);
  } catch (e) {
    // Clear the expectation if DDL failed
    events.clearExpectedRemoteSchemaEvent({
      type: eventType,
      objectType,
      schemaName: change.schema,
      objectName: change.table,
    });
    throw e;
  }
  // Note: We don't emit a separate event here anymore.
  // The module's event is automatically marked as remote.
}

/**
 * Collapse one row group's changes into a single ExternalRowOp — the group's NET
 * effect in arrival (batch) order. A delete resets the row to absent: column
 * updates BEFORE it are discarded (the delete already erased their effect) and
 * updates AFTER it rebuild the row from a PK+nulls base — the same state the
 * changes would leave applied one at a time (a re-creation after a same-batch
 * delete must not resurrect the pre-delete image of columns it does not set).
 * A group whose net effect is the delete collapses to a delete op; updates with
 * no later delete merge onto the pre-read existing row (UPSERT semantics).
 *
 * NOTE: "net effect in order" assumes the batch arrives in HLC order, which
 * `getChangesSince` guarantees (`DataChangeToApply` carries no HLC to re-sort
 * by). The change-applicator's in-batch delete reconciliation decides the SAME
 * question by HLC instead, so on a batch whose changesets were reordered the two
 * disagree: under `allowResurrection` a resurrected row keeps its cell records
 * and change-log entries while this collapse deletes it from the table, leaving
 * the replica relaying a row it does not have. Tracked as
 * `bug-sync-apply-order-splits-data-from-metadata`.
 */
async function buildRowOp(
  table: StoreTable,
  changes: DataChangeToApply[]
): Promise<ExternalRowOp> {
  const { pk } = changes[0];

  let deleted = false;
  let updates: DataChangeToApply[] = [];
  for (const change of changes) {
    if (change.type === 'delete') {
      deleted = true;
      updates = [];
    } else {
      updates.push(change);
    }
  }

  if (deleted && updates.length === 0) {
    return { op: 'delete', pk };
  }

  return { op: 'upsert', row: await mergeColumnUpdates(table, pk, updates, deleted) };
}

/**
 * Merge column updates onto the row's current image (UPSERT semantics):
 * pre-read the existing row by PK, or build a PK+nulls partial row when
 * absent (column changes may arrive before the rest of the row). When
 * `rowDeletedInGroup` is set, a delete earlier in the same row group already
 * erased the stored image — the merge base is PK+nulls, never the pre-read row.
 */
async function mergeColumnUpdates(
  table: StoreTable,
  pk: SqlValue[],
  changes: DataChangeToApply[],
  rowDeletedInGroup = false
): Promise<Row> {
  const tableSchema = table.getSchema();
  const existing = rowDeletedInGroup ? undefined : await table.readRowByPk(pk);

  let row: Row;
  if (existing) {
    row = [...existing];
  } else {
    row = new Array<SqlValue>(tableSchema.columns.length).fill(null);
    for (let i = 0; i < tableSchema.primaryKeyDefinition.length; i++) {
      row[tableSchema.primaryKeyDefinition[i].index] = pk[i];
    }
  }

  let columnsApplied = 0;
  for (const change of changes) {
    if (!change.columns) continue;
    for (const [colName, value] of Object.entries(change.columns)) {
      const colIndex = tableSchema.columnIndexMap.get(colName.toLowerCase());
      if (colIndex !== undefined) {
        row[colIndex] = value;
        columnsApplied++;
      } else {
        // Column name not found in schema - this could be a sync bug
        console.warn(
          `[Sync] Column '${colName}' not found in ${tableSchema.schemaName}.${tableSchema.name}. ` +
          `Available columns: ${[...tableSchema.columnIndexMap.keys()].join(', ')}`
        );
      }
    }
  }

  if (columnsApplied === 0 && existing) {
    console.warn(
      `[Sync] No columns were applied for ${tableSchema.schemaName}.${tableSchema.name} pk=${JSON.stringify(pk)}. ` +
      `This may indicate a column name mismatch between source and destination.`
    );
  }

  return row;
}

/**
 * Emit module data change events for the effective changes, with
 * `remote: true` so the SyncManager never re-records them. Suppressed no-ops
 * (absent delete, value-identical upsert) were never reported by the store,
 * so they emit nothing — deliberate.
 */
function emitEffectiveChanges(
  events: StoreEventEmitter,
  tableSchema: TableSchema,
  effective: readonly BackingRowChange[]
): void {
  for (const change of effective) {
    const row = change.newRow ?? change.oldRow;
    const pk = tableSchema.primaryKeyDefinition.map(p => row[p.index]);
    events.emitDataChange({
      type: change.op,
      schemaName: tableSchema.schemaName,
      tableName: tableSchema.name,
      key: pk,
      oldRow: change.oldRow,
      newRow: change.newRow,
      changedColumns: change.op === 'update'
        ? diffChangedColumns(tableSchema, change.oldRow, change.newRow)
        : undefined,
      remote: true,
    });
  }
}

/** Column names whose values differ between the effective before/after images. */
function diffChangedColumns(tableSchema: TableSchema, oldRow: Row, newRow: Row): string[] {
  const changed: string[] = [];
  for (let i = 0; i < tableSchema.columns.length; i++) {
    if (compareSqlValues(oldRow[i], newRow[i]) !== 0) {
      changed.push(tableSchema.columns[i].name);
    }
  }
  return changed;
}

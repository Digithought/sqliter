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
 *   1. Schema changes execute via `db.exec`, with the resulting module schema
 *      events pre-marked remote. Replicated DDL is applied IDEMPOTENTLY: an
 *      object already in the migration's wanted state with a matching definition
 *      is counted applied without re-exec'ing, so two peers that independently
 *      created the same table converge instead of the receiver failing "already
 *      exists" on every sync (see {@link decideSchemaChange}).
 *
 *      Most DDL runs BEFORE the data (the batch's rows need the new shape to land
 *      in), but a migration that VALIDATES the rows the table already holds — `set
 *      not null`, `add constraint`, a UNIQUE index create — is legal only against a
 *      row set this batch may still be delivering, so it runs AFTER the row writes
 *      instead. {@link partitionSchemaChanges} splits the batch into those two
 *      phases; {@link validatesExistingRows} is the classifier.
 *   2. Data changes are grouped per table, then per row; each row group
 *      collapses to ONE `ExternalRowOp` — the group's NET effect in list
 *      order, which the caller delivers HLC-ordered (a delete resets the row to
 *      absent and later column updates rebuild it from PK+nulls; updates with no
 *      later delete merge onto the pre-read existing row — UPSERT semantics; see
 *      {@link buildRowOp}).
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

import type { BackingRowChange, ColumnSchema, Database, ExternalRowChange, Row, SqlValue, TableSchema } from '@quereus/quereus';
import { compareSqlValues, expressionToString, generateIndexDDL, generateTableDDL, inferType, namedConstraintExists, Parser } from '@quereus/quereus';
import type { ExternalRowOp, StoreEventEmitter, StoreModule, StoreTable } from '@quereus/store';
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

    // Both phases share one accounting path, so a validating alteration's failure
    // reaches `result.errors` exactly as a pre-data one always did.
    const applySchemaPhase = async (phase: readonly SchemaChangeToApply[]): Promise<void> => {
      for (const schemaChange of phase) {
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
    };

    // DDL the batch's rows may depend on runs first; DDL that validates existing
    // rows runs after them (see partitionSchemaChanges).
    const { beforeData, afterData } = partitionSchemaChanges(schemaChanges);
    await applySchemaPhase(beforeData);

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

    // Row-validating DDL runs here, against the rows this batch just landed —
    // the whole point of the split. It precedes the seam call so the seam
    // observes the batch's FINAL schema.
    await applySchemaPhase(afterData);

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
 * (e.g. length-prefixed, or a NUL byte).
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
 * The object named by the migration already exists locally: converge silently if
 * `localDDL` matches the replicated definition, otherwise throw a conflict naming
 * both.
 *
 * `localDDL` is what the CALLER decided this migration should be judged against —
 * for a `create_table` with a same-version local migration record, that record's
 * own CREATE; otherwise the object's current shape regenerated from the catalog
 * (see {@link decideSchemaChange}). `localOrigin` names which one, so an operator
 * reading the conflict is not left guessing what `local:` is.
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
  /** What `localDDL` is, named in the conflict message; omitted for the current shape. */
  localOrigin?: string,
): void {
  if (normalizeDDL(localDDL) === normalizeDDL(change.ddl)) return;

  throw new Error(
    `Schema conflict applying remote ${change.type} for ${change.schema}.${change.table}: ` +
    `a different definition already exists locally.\n` +
    `  local:  ${localDDL}\n` +
    `  remote: ${change.ddl}` +
    (localOrigin ? `\n  (local is ${localOrigin})` : '')
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
 * The invariant the `create_table` arm holds: a replicated migration is judged
 * against the state it was MEANT to produce — `change.localDDLAtVersion`, what
 * this device's own migration at the same schema version recorded — never against
 * whatever the local object happens to look like now. The other arms read the
 * catalog because their question is about presence (does the object exist?) or
 * about one alteration's effect, neither of which a later local migration
 * invalidates.
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

      // | incoming create | local record at the same version | verdict |
      // |---|---|---|
      // | —                | absent  | fall back to the current-shape comparison |
      // | matches          | present | already applied — converge |
      // | differs          | present | genuine divergence — throw, create vs create |
      //
      // The record is the RIGHT comparison: a table that has been altered since its
      // own create no longer renders as the create that made it, so comparing the
      // incoming create against the current shape reports a divergence the moment
      // the receiver alters its own table — permanently, since the throw aborts the
      // batch before its metadata commits. Both peers' duplicate creates are
      // version 1 and record byte-identical canonical DDL, so the record keeps the
      // question decidable however much either table is altered afterwards.
      if (change.localDDLAtVersion !== undefined) {
        assertDefinitionMatches(
          change,
          change.localDDLAtVersion,
          `this device's own ${change.type} recorded at the same schema version, not the table's current shape`,
        );
        return 'already-applied';
      }

      // No same-version, same-TYPE record — a table created before sync was
      // attached, or a version whose record is some other migration type: compare
      // the current shape, as this always did.
      //
      // NOTE: a local drop + re-create does NOT land here. Migration records are
      // never deleted, so the original `create_table` still sits at version 1 while
      // the live table is the re-created one at a later version; an incoming create
      // matching that ORIGINAL record converges silently against a table that no
      // longer has its shape. Benign today — the peer's create is genuinely stale
      // and the drop/re-create replicates behind it — and strictly better than the
      // permanent block the current-shape comparison gave. If drop/re-create of a
      // replicated table becomes common, key the lookup on the CURRENT version's
      // create rather than the incoming migration's version.
      // Both sides render through `generateTableDDL` with no `db` argument, so
      // the strings are fully qualified and session-independent — directly
      // comparable against the DDL the origin put on the wire.
      // NOTE: that symmetry is a property of the store module (it is the only
      // module that puts DDL on the wire today). A second DDL-emitting module
      // rendering the same table some other way would be reported as a conflict
      // rather than converging; the comparison would then need to be over parsed
      // schemas, not rendered strings.
      // NOTE: this fallback keeps the pre-record failure mode — a table altered
      // locally since a create that was never recorded still reads as a divergence.
      // Only reachable for the two cases above; if either becomes common, record a
      // migration for the pre-sync create rather than widening the comparison.
      assertDefinitionMatches(change, generateTableDDL(local));
      return 'already-applied';
    }
    case 'drop_table':
      return db.schemaManager.getTable(change.schema, change.table) ? 'execute' : 'already-applied';
    case 'rename_table':
      return decideRenameTable(db, change);
    case 'add_index': {
      // For an index migration `change.table` holds the INDEX name, not the
      // table name (see `mapSchemaMigrationType` / `recordSchemaMigration`).
      // `findIndexOwner` is the engine's own by-name owner resolver — the same one
      // `DROP INDEX` uses, at the same default scope — so the receiver's verdict
      // here can never disagree with what the replicated DDL would then resolve to.
      const owner = db.schemaManager.findIndexOwner(change.schema, change.table);
      if (!owner) return 'execute';
      // NOTE: still compares the index's CURRENT shape, which is safe only because
      // no ALTER form modifies an index in place — a live index always renders as
      // the create that made it. If in-place index alteration ever lands, this arm
      // acquires the same stale-comparison bug the create_table arm above fixed;
      // give it `localDDLAtVersion` too (the field is already populated for every
      // migration type, index migrations included).
      assertDefinitionMatches(change, generateIndexDDL(owner.index, owner.table));
      return 'already-applied';
    }
    case 'drop_index':
      // No owner in the default scope ⇒ nothing a `DROP INDEX` could remove, so
      // converge silently rather than exec a statement that would throw
      // `no such index` and abort the admission unit.
      return db.schemaManager.findIndexOwner(change.schema, change.table) ? 'execute' : 'already-applied';
    case 'alter_column':
      // A table alteration (the coarse "table definition changed" migration the
      // origin records for every ALTER TABLE form). Parse the statement and decide
      // per alteration arm whether the local table is already in the wanted state.
      return decideAlterTable(db, change);
    default:
      // add_column / drop_column are legacy wire types no current origin records
      // (mapSchemaMigrationType folds every table alter into alter_column); run
      // them as before.
      return 'execute';
  }
}

/**
 * Idempotency / conflict decision for a replicated `rename_table` migration,
 * read from the local catalog for BOTH names:
 *
 * | old present | new present | verdict |
 * |---|---|---|
 * | yes | no  | execute |
 * | no  | yes | already-applied — the rename already happened here |
 * | yes | yes | THROW a conflict naming both tables (see below) |
 * | no  | no  | converge with a warning — nothing to rename (drop won) |
 *
 * A missing `fromTable` (a peer that omitted it) makes the migration
 * undecidable: converge with a warning rather than exec a statement whose
 * outcome we cannot predict.
 *
 * The yes/yes row throws rather than picking a side: renaming would collide
 * with a table that already exists, and silently keeping either shape would
 * record "converged" for a divergence that is not — the same posture as a
 * divergent `create_table` (see {@link assertDefinitionMatches}'s NOTE).
 *
 * NOTE: sync's per-row bookkeeping (`cv:`/`tb:`/`cl:`) is keyed by table name,
 * so both origin and receiver strand it at the old name and start empty at the
 * new one — later conflict resolution and tombstone blocking lose their history
 * for the renamed table (an old delete no longer blocks a replayed insert).
 * Pre-existing for a purely local rename; replicating the rename makes it
 * happen on every peer. Tracked as
 * `bug-sync-rename-and-pk-change-strand-crdt-metadata` (tickets/backlog).
 */
function decideRenameTable(db: Database, change: SchemaChangeToApply): SchemaChangeAction {
  if (change.fromTable === undefined) {
    console.warn(
      `[Sync] Remote ${change.type} for ${change.schema}.${change.table} carries no old table name — `
        + `undecidable; converging without applying: ${change.ddl}`,
    );
    return 'already-applied';
  }
  const oldPresent = db.schemaManager.getTable(change.schema, change.fromTable) !== undefined;
  const newPresent = db.schemaManager.getTable(change.schema, change.table) !== undefined;
  if (oldPresent && newPresent) {
    throw new Error(
      `Schema conflict applying remote ${change.type} for ${change.schema}.${change.fromTable}: ` +
      `renaming to ${change.schema}.${change.table} would collide with a table that already exists locally.\n` +
      `  remote: ${change.ddl}`
    );
  }
  if (oldPresent) return 'execute';
  if (newPresent) return 'already-applied';
  console.warn(
    `[Sync] Remote ${change.type} for ${change.schema}.${change.table}: neither `
      + `'${change.fromTable}' nor '${change.table}' exists locally — converging without applying: ${change.ddl}`,
  );
  return 'already-applied';
}

/**
 * The ALTER TABLE statement / ADD COLUMN definition AST shapes, derived
 * structurally from the parser's return type: the NAMED AST types live in the
 * `@quereus/quereus/parser` subpath export, which this package's test tsconfig
 * (node10 module resolution) cannot resolve.
 */
type AlterTableStmt = Extract<ReturnType<Parser['parse']>, { type: 'alterTable' }>;
type ColumnDef = Extract<AlterTableStmt['action'], { type: 'addColumn' }>['column'];

/**
 * Parse one replicated migration's DDL with the engine's own parser, returning
 * either the statement or the parse failure — never throwing, and never deciding
 * what a failure means: each caller does that for itself ({@link decideAlterTable}
 * logs it and executes the text as-is; {@link validatesExistingRows} treats an
 * unparseable migration as non-validating). Shared so the idempotency decision and
 * the apply-phase classifier read one migration the same way.
 */
function parseMigrationDDL(ddl: string): {
  stmt?: ReturnType<Parser['parse']>;
  parseError?: Error;
} {
  try {
    return { stmt: new Parser().parse(ddl) };
  } catch (e) {
    return { parseError: toError(e) };
  }
}

/**
 * Does this migration VALIDATE the rows the receiver already holds — i.e. is it
 * legal only against a row set the same batch may still be delivering?
 *
 * A tightening alteration is recorded by the origin AFTER the rows that make it
 * hold, so replaying it ahead of those rows fails on the batch that carries them
 * (fill a column's NULLs, then `set not null`, in one relay). Everything answered
 * true here is therefore applied AFTER the batch's row writes; everything else
 * keeps its pre-data position, because the batch's rows may need the new shape to
 * land in. See {@link partitionSchemaChanges} for how the answer is used.
 *
 * The validating set is deliberately narrow — only alterations that INSPECT
 * existing rows without changing how those rows are stored or addressed:
 *
 * - `alter column … set not null` (`drop not null` loosens, so it stays early)
 * - `add constraint` — the `unique`, `check` and foreign-key forms all validate
 * - a UNIQUE `add_index` — verified to throw `UNIQUE constraint failed` against
 *   pre-existing duplicates, the same failure mode as `set not null`. A NON-unique
 *   index create inspects nothing, so it stays early.
 *
 * Two alterations look like they belong here and deliberately do NOT:
 *
 * - `alter primary key` — re-keying is not merely validating. The batch's row
 *   changes carry primary-key values and the key definition in force decides how
 *   those rows are ADDRESSED, so applying it after the rows would file them under
 *   the old key. It stays early, and its own tightening failure mode (duplicate
 *   values under the new key, arriving with the rows that resolve them) therefore
 *   remains.
 * - `alter column … set data type` — a type change rewrites stored values, so
 *   rows applied before it would be stored under the OLD type and then converted,
 *   which is not the same history the origin has. Stays early, same tradeoff.
 *
 * A migration whose DDL does not parse classifies non-validating: it keeps
 * today's position, and {@link decideAlterTable} logs the parse failure when it
 * reaches the same text.
 */
function validatesExistingRows(change: SchemaChangeToApply): boolean {
  // Only these two migration types can carry a validating statement; skip the
  // parse for every other one.
  if (change.type !== 'add_index' && change.type !== 'alter_column') return false;

  const { stmt } = parseMigrationDDL(change.ddl);
  if (change.type === 'add_index') {
    // A partial (`where`-carrying) unique index still validates the rows inside
    // its predicate, so it belongs here too.
    return stmt?.type === 'createIndex' && stmt.isUnique === true;
  }
  if (stmt?.type !== 'alterTable') return false;
  const action = stmt.action;
  if (action.type === 'addConstraint') return true;
  if (action.type === 'alterColumn') return action.setNotNull === true;
  return false;
}

/**
 * The `(schema, object)` key a migration is ordered under within one batch.
 *
 * For a table migration that is the table; for an index migration `change.table`
 * holds the INDEX name (see `mapSchemaMigrationType`), so a create/drop pair for
 * one index keys together while an index and its owner table key apart. Keying an
 * index by its owner instead would need the owner resolved before the create has
 * run, and the only cost of the split is the ordering caveat in
 * {@link partitionSchemaChanges}.
 */
function migrationOrderKey(change: SchemaChangeToApply): string {
  return `${change.schema}.${change.table}`;
}

/**
 * Split one batch's schema changes into the phase that runs BEFORE the row writes
 * and the phase that runs AFTER them, preserving each phase's relative order.
 *
 * A change moves to the after-data phase only when BOTH hold:
 *
 * - it validates existing rows ({@link validatesExistingRows}), and
 * - every LATER change on the same object in this batch also moves.
 *
 * The second condition is what keeps the split from reordering DDL against DDL.
 * A batch is a whole resolved `ChangeSet[]` — many source transactions — so it can
 * legitimately carry `add constraint u1` and, from a later transaction, `drop
 * constraint u1`. Deferring only the add would run the drop first (against a
 * constraint that does not exist yet, which converges silently) and then install
 * the constraint the origin no longer has. Holding a validating change in place
 * as soon as anything later on the same object stays put means per-object DDL
 * order is never rearranged: the batch simply keeps today's behaviour for that
 * object, which is the pre-existing spurious-error case and not a new divergence.
 *
 * Consequences worth knowing:
 *
 * - A tightening followed by another ALTERATION of the same table in one batch
 *   (`set not null`, then `add column`) keeps today's pre-data position and
 *   today's outcome. Only the trailing run of validating changes per object moves,
 *   where a trailing `drop_table` does not count as a blocker (see below).
 * - NOTE: an index migration keys by index name, not by its owner table, so a
 *   unique index create followed in the same batch by an alteration of its OWNER
 *   (e.g. dropping the indexed column) is not held back by that alteration and the
 *   two can be reordered. Both statements would have to arrive in one batch AND
 *   touch the same column; if that combination ever shows up, resolve the create's
 *   owner from its parsed DDL in {@link migrationOrderKey}.
 */
function partitionSchemaChanges(changes: readonly SchemaChangeToApply[]): {
  beforeData: SchemaChangeToApply[];
  afterData: SchemaChangeToApply[];
} {
  // Walk backwards so "is everything later on this object also deferred?" is a
  // single set membership: an object lands in `pinned` the first time (from the
  // end) a change on it stays put, and every earlier change on it then stays too.
  const pinned = new Set<string>();
  const deferred = new Set<number>();
  for (let i = changes.length - 1; i >= 0; i--) {
    const change = changes[i];
    // A `drop_table` discards the object, so nothing earlier on that table can be
    // reordered INTO a wrong end state by moving past it — the table is gone
    // either way. Letting it pin would hold an earlier tightening in the pre-data
    // phase, where it fails against rows the batch has not delivered yet and
    // aborts a batch whose own last word is "this table is gone". Deferred
    // instead, it meets an absent table and converges with a warning
    // ({@link decideAlterTable}'s absent-table arm).
    if (change.type === 'drop_table') continue;
    const key = migrationOrderKey(change);
    if (!pinned.has(key) && validatesExistingRows(change)) {
      deferred.add(i);
    } else {
      pinned.add(key);
    }
  }

  const beforeData: SchemaChangeToApply[] = [];
  const afterData: SchemaChangeToApply[] = [];
  changes.forEach((change, i) => (deferred.has(i) ? afterData : beforeData).push(change));
  return { beforeData, afterData };
}

/**
 * Idempotency decision for a replicated `alter_column` migration. The migration
 * carries only the statement text, so parse it with the engine's own parser and
 * compare the parsed alteration against the local {@link TableSchema}.
 *
 * Two peers offline can each run `alter table orders add column sku text`;
 * whichever migration wins the HLC comparison is then delivered to a peer that
 * already has `sku`. Re-executing the raw DDL there throws, aborting the whole
 * admission unit before its CRDT metadata commits — the same permanent re-fail
 * loop `create_table` idempotency exists to prevent.
 */
function decideAlterTable(db: Database, change: SchemaChangeToApply): SchemaChangeAction {
  const { stmt, parseError } = parseMigrationDDL(change.ddl);
  if (parseError) {
    // A parse failure must not be swallowed into a skip: execute the DDL so the
    // underlying engine error is what the operator sees, not a parser message.
    console.error(
      `[Sync] Could not parse replicated ${change.type} DDL for ${change.schema}.${change.table} — executing as-is:`,
      parseError,
    );
    return 'execute';
  }
  if (stmt?.type !== 'alterTable') return 'execute';
  // NOTE: the decision reads the migration's `(schema, table)` envelope, never
  // `stmt.table` — the origin filed the envelope from the same event that carried
  // this text, so the two agree for anything the pipeline produces. A hand-crafted
  // migration whose DDL names a different table would be decided against the wrong
  // local table; if migrations ever arrive from outside the capture path, compare
  // the two here first.
  const action = stmt.action;

  // The tag/maintained arms have no idempotency arm — execute as before. A
  // renameTable action under `alter_column` can only come from a peer on an older
  // build (a current origin records it as `rename_table`, decided by
  // decideRenameTable above); execute it as those builds always did.
  if (action.type === 'renameTable' || action.type === 'setTags' || action.type === 'dropTags'
    || action.type === 'setMaintained' || action.type === 'dropMaintained') {
    return 'execute';
  }

  const local = db.schemaManager.getTable(change.schema, change.table);
  if (!local) {
    // Nothing to alter: the receiver dropped the table (drop is the more
    // destructive migration and wins). Converge with a warning rather than exec a
    // statement that would throw `no such table` and abort the admission unit —
    // consistent with drop_index's absent-owner arm.
    console.warn(
      `[Sync] Remote ${change.type} for ${change.schema}.${change.table} names a table this peer does not have — `
        + `converging without applying: ${change.ddl}`,
    );
    return 'already-applied';
  }

  switch (action.type) {
    case 'addColumn':
      return decideAddColumn(local, action.column, change);
    case 'dropColumn':
      return localColumn(local, action.name) ? 'execute' : 'already-applied';
    case 'renameColumn': {
      // Old name still present ⇒ the rename has not happened here (if the new name
      // ALSO exists the exec surfaces the engine's own duplicate-name error — a
      // genuine divergence, not one to paper over).
      if (localColumn(local, action.oldName)) return 'execute';
      if (localColumn(local, action.newName)) return 'already-applied';
      console.warn(
        `[Sync] Remote ${change.type} for ${change.schema}.${change.table}: neither column `
          + `'${action.oldName}' nor '${action.newName}' exists locally — converging without applying`,
      );
      return 'already-applied';
    }
    case 'addConstraint': {
      const constraint = action.constraint;
      // Named: presence of the name is the whole check — see the NOTE on
      // decideAddColumn for why no definition comparison is attempted.
      if (constraint.name) {
        return namedConstraintExists(local, constraint.name) ? 'already-applied' : 'execute';
      }
      // Unnamed UNIQUE: an equivalent UNIQUE over the same column set converges.
      if (constraint.type === 'unique' && constraint.columns) {
        return equivalentUniqueExists(local, constraint.columns.map(c => c.name)) ? 'already-applied' : 'execute';
      }
      // Unnamed CHECK (or other forms): no identity to compare against — execute.
      // NOTE: two peers that concurrently add the SAME unnamed CHECK therefore end
      // up enforcing it twice (the engine auto-names each install separately), which
      // is semantically harmless — same predicate, evaluated twice. If the duplicate
      // ever matters (per-row cost, or a confusing `table_info`), the identity to
      // compare on is the rendered predicate expression, not the constraint name.
      return 'execute';
    }
    case 'dropConstraint':
      return namedConstraintExists(local, action.name) ? 'execute' : 'already-applied';
    case 'renameConstraint': {
      if (namedConstraintExists(local, action.oldName)) return 'execute';
      if (namedConstraintExists(local, action.newName)) return 'already-applied';
      console.warn(
        `[Sync] Remote ${change.type} for ${change.schema}.${change.table}: neither constraint `
          + `'${action.oldName}' nor '${action.newName}' exists locally — converging without applying`,
      );
      return 'already-applied';
    }
    case 'alterColumn': {
      const col = localColumn(local, action.columnName);
      if (!col) {
        // Most-destructive-wins (docs/sync-schema.md § Conflict Resolution): a
        // concurrent local DROP COLUMN beats the alteration, so converge.
        console.warn(
          `[Sync] Remote ${change.type} for ${change.schema}.${change.table}: column `
            + `'${action.columnName}' does not exist locally — converging without applying: ${change.ddl}`,
        );
        return 'already-applied';
      }
      if (action.setDataType !== undefined) {
        return inferType(action.setDataType).name === col.logicalType.name ? 'already-applied' : 'execute';
      }
      if (action.setNotNull !== undefined) {
        // A `set not null` executes against the rows this peer currently holds, so
        // it is applied AFTER the batch's row writes rather than ahead of them —
        // the batch that fills the NULLs satisfies its own DDL on the first round.
        // `drop not null` loosens and keeps its pre-data position. See
        // {@link validatesExistingRows}.
        return col.notNull === action.setNotNull ? 'already-applied' : 'execute';
      }
      if (action.setDefault !== undefined) {
        if (action.setDefault === null) {
          return col.defaultValue === null ? 'already-applied' : 'execute';
        }
        return col.defaultValue !== null
          && expressionToString(col.defaultValue) === expressionToString(action.setDefault)
          ? 'already-applied' : 'execute';
      }
      if (action.setCollation !== undefined) {
        return col.collation.toLowerCase() === action.setCollation.toLowerCase() ? 'already-applied' : 'execute';
      }
      return 'execute';
    }
    case 'alterPrimaryKey': {
      // NOTE: replicating a PK change re-keys the table on EVERY peer, and sync's
      // cv:/tb:/cl: metadata is filed under the row's old pk identity — so conflict
      // resolution for existing rows silently restarts from empty. Pre-existing for
      // a local PK change; tracked as
      // `bug-sync-rename-and-pk-change-strand-crdt-metadata` (tickets/backlog).
      const wanted = action.columns;
      const current = local.primaryKeyDefinition;
      const same = wanted.length === current.length && wanted.every((w, i) => {
        const def = current[i];
        const col = local.columns[def.index];
        return col.name.toLowerCase() === w.name.toLowerCase()
          && (def.desc === true) === (w.direction === 'desc');
      });
      return same ? 'already-applied' : 'execute';
    }
    default:
      return 'execute';
  }
}

/** Position of the local column named `name`, or undefined. */
function localColumnIndex(table: TableSchema, name: string): number | undefined {
  return table.columnIndexMap.get(name.toLowerCase());
}

/** The local column named `name`, or undefined. */
function localColumn(table: TableSchema, name: string): ColumnSchema | undefined {
  const idx = localColumnIndex(table, name);
  return idx === undefined ? undefined : table.columns[idx];
}

/**
 * ADD COLUMN idempotency: absent ⇒ execute; present with the same LOGICAL TYPE ⇒
 * converged; present with a different type ⇒ conflict.
 *
 * NOTE: only the logical type is compared, deliberately. A type difference is the
 * dangerous divergence — two peers would interpret the same rows under different
 * shapes, exactly what the create_table arm refuses to paper over. Anything
 * richer would compare an AST column definition (rendered from the origin's
 * statement) against a ColumnSchema (rendered from the receiver's catalog), and
 * those do not round-trip: an unnamed inline CHECK is auto-named `_check_<col>`
 * on the way into the catalog, session `default_column_nullability` decides
 * whether `not null` is even spelled, and so on. A false conflict permanently
 * blocks the peer — strictly worse than converging on a constraint-level
 * difference. So constraint-level drift between two same-named, same-typed
 * columns converges silently; if that ever bites, the fix is to compare parsed
 * schemas, not rendered text.
 */
function decideAddColumn(
  local: TableSchema,
  column: ColumnDef,
  change: SchemaChangeToApply,
): SchemaChangeAction {
  const existing = localColumn(local, column.name);
  if (!existing) return 'execute';
  const wanted = inferType(column.dataType);
  if (wanted.name === existing.logicalType.name) return 'already-applied';
  throw new Error(
    `Schema conflict applying remote ${change.type} for ${change.schema}.${change.table}: ` +
    `column '${column.name}' already exists with type ${existing.logicalType.name}, ` +
    `but the remote alteration adds it as ${wanted.name}.\n` +
    `  remote: ${change.ddl}`
  );
}

/**
 * True when the table already has a UNIQUE constraint over exactly this column
 * set (order-insensitive — `unique (a, b)` and `unique (b, a)` enforce the same
 * predicate). A column name the local table lacks ⇒ false, and the exec surfaces
 * the engine's own error.
 *
 * PARTIAL constraints do not count. A table-level `unique (a)` is unconditional,
 * while a `predicate`-carrying constraint (only ever synthesized from a
 * `create unique index … where …`) enforces over a subset of the rows — treating
 * it as equivalent would converge the peer onto WEAKER enforcement than the
 * alteration asked for, and duplicate-but-outside-the-predicate rows would then
 * replicate here and be rejected on the origin.
 */
function equivalentUniqueExists(table: TableSchema, columnNames: readonly string[]): boolean {
  const wanted: number[] = [];
  for (const name of columnNames) {
    const idx = localColumnIndex(table, name);
    if (idx === undefined) return false;
    wanted.push(idx);
  }
  const wantedKey = sortedIndexKey(wanted);
  return (table.uniqueConstraints ?? []).some(uc =>
    uc.predicate === undefined && sortedIndexKey(uc.columns) === wantedKey);
}

/** Order-insensitive identity of a column-index set. */
function sortedIndexKey(columns: readonly number[]): string {
  return [...columns].sort((a, b) => a - b).join(',');
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
  // A blank `ddl` can still reach here from a peer on an older build (blank
  // drop/index/alter migrations). Such a migration runs nothing; skip it before
  // deciding anything (an empty string is not a parseable statement).
  if (change.ddl.trim() === '') {
    // Deliberately NOT scoped to `alter_column`, unlike the origin-side warning in
    // `recordSchemaMigration` (sync-manager-impl.ts): a peer on an older build can
    // still send a blank drop/index migration, and that is equally worth hearing.
    // The migration still counts applied — it just runs nothing — so an operator
    // watching this peer needs to see that a schema change arrived and did nothing.
    // NOTE: this returns before the `already-applied` check below, so a peer
    // re-bootstrapping from zero re-warns for every blank migration it replays.
    // Fine while alterations are rare; if it ever floods a log, dedupe per
    // (schema, table, type) for the duration of one apply.
    console.warn(
      `[Sync] Received ${change.type} for ${change.schema}.${change.table} with no DDL — `
        + `not applied; this peer's schema is unchanged`,
    );
    return;
  }

  if (decideSchemaChange(db, change) === 'already-applied') {
    console.debug(
      `[Sync] Remote ${change.type} for ${change.schema}.${change.table} already applied locally — converging without re-executing DDL`
    );
    return;
  }

  // Mark every schema event the replicated DDL emits as remote, so the
  // SyncManager doesn't re-record it as a local change and broadcast it back
  // out. The scope covers zero, one, or several events, and the `finally`
  // releases it whether the exec succeeds or throws — so a statement that emits
  // nothing leaves no residue to swallow the next genuine local DDL. (See
  // `StoreEventEmitter.beginRemoteSchemaScope` for the concurrency tradeoff.)
  //
  // A rename_table scopes BOTH names: the store module's renameTable announces
  // under the NEW name (`change.table`), but scoping the old one too costs
  // nothing and protects against a module that announces under the pre-rename
  // name.
  const scopeNames = change.type === 'rename_table' && change.fromTable !== undefined
    ? [change.table, change.fromTable]
    : [change.table];
  for (const name of scopeNames) events.beginRemoteSchemaScope(change.schema, name);
  try {
    await db.exec(change.ddl);
  } finally {
    for (const name of scopeNames) events.endRemoteSchemaScope(change.schema, name);
  }
}

/**
 * Collapse one row group's changes into a single ExternalRowOp — the group's NET
 * effect in list order. A delete resets the row to absent: column updates BEFORE
 * it are discarded (the delete already erased their effect) and updates AFTER it
 * rebuild the row from a PK+nulls base — the same state the changes would leave
 * applied one at a time (a re-creation after a same-batch delete must not
 * resurrect the pre-delete image of columns it does not set). A group whose net
 * effect is the delete collapses to a delete op; updates with no later delete
 * merge onto the pre-read existing row (UPSERT semantics).
 *
 * "Net effect in order" is only correct on an HLC-ORDERED list, and
 * `DataChangeToApply` carries no HLC for this function to re-sort by. The CALLER
 * establishes that order: `change-applicator.ts`'s `orderDataChangesByHLC` sorts the
 * reconciled batch by HLC — in the one place that still holds the HLCs — before
 * handing it to `applyToStore`, so this collapse decides the same question by the
 * same rule as resolution and the in-batch delete reconciliation, whatever order the
 * batch arrived in. Anything else driving this callback owes it the same ordering.
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
        // Now that DROP COLUMN and RENAME COLUMN replicate, the ordinary cause is a
        // change-log fact recorded before the alteration reached this peer — the value
        // is correctly discarded. A name that is neither dropped nor renamed still
        // indicates a genuine source/destination mismatch, so this stays a warning.
        // NOTE: one line per unknown column per change. If a wide table's drop ever
        // makes this drown the log, aggregate per (table, column) instead of demoting.
        console.warn(
          `[Sync] Column '${colName}' not found in ${tableSchema.schemaName}.${tableSchema.name} — ` +
          `discarding its value (expected if a replicated ALTER TABLE dropped or renamed it). ` +
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

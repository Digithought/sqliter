/**
 * `quereus_basis_lifecycle()` — in-SQL introspection of the durable per-basis-table
 * lifecycle records the sync layer maintains on each lens deploy
 * (`docs/migration.md` § 2 Converge). A zero-argument table-valued function listing
 * every stored {@link BasisTableLifecycleRecord}, one row per record, so a developer
 * can surface legacy / retirement-candidate tables without writing host code:
 *
 * ```sql
 * select "table", state, "unmappedSince"
 * from quereus_basis_lifecycle()
 * where state = 'derivation-source-only'
 * order by "unmappedSince";
 * ```
 *
 * Pure convenience over {@link SyncManager.getBasisTableLifecycle} — no engine change.
 * The TVF closes over the `SyncManager` (the host's smallest registration seam), and
 * the records are read programmatically from KV, so the rows survive a restart and a
 * fresh `Database` over the same store reflects the prior deploy's classification.
 */

import type { Database, Row, LogicalType } from '@quereus/quereus';
import { createTableValuedFunction, INTEGER_TYPE, TEXT_TYPE } from '@quereus/quereus';
import type { SyncManager } from '../sync/manager.js';
import type { BasisTableLifecycleRecord } from '../metadata/basis-lifecycle.js';

/** A read-only generated column spec for the TVF's relation return type. */
function col(name: string, logicalType: LogicalType, nullable: boolean) {
  return {
    name,
    type: { typeClass: 'scalar' as const, logicalType, nullable, isReadOnly: true },
    generated: true,
  };
}

/**
 * Project one lifecycle record onto its ordered SQL row. Column order MUST match
 * the `returnType.columns` list below. Optional record fields coalesce to `null`
 * (a `Row` cannot hold `undefined`); booleans emit as INTEGER 0/1 (engine
 * convention, mirroring `table_info`'s `notnull`/`pk`); `mappedBy` renders as a
 * JSON array string (empty ⇒ `"[]"`, never null); the `evictPolicy` union
 * (`'never'` | `'immediate'` | a numeric ms horizon) collapses to its string form.
 */
function rowFromRecord(r: BasisTableLifecycleRecord): Row {
  return [
    r.schema,
    r.table,
    r.state,
    JSON.stringify(r.mappedBy ?? []),
    r.derivationSource ? 1 : 0,
    r.inBasis ? 1 : 0,
    r.mappedSince ?? null,
    r.unmappedSince ?? null,
    r.detachedAt ?? null,
    r.lastDirectlyMappedWriteAt ?? null,
    r.evictPolicy == null ? null : String(r.evictPolicy),
  ];
}

/**
 * Register the `quereus_basis_lifecycle()` introspection TVF against `db`, reading
 * from `syncManager`. Opt-in: the host calls this once after `createSyncModule(...)`
 * (no auto-registration — `createSyncModule` takes no `Database`, and relay-only
 * deployments need no SQL surface). The `quereus_`-prefixed name avoids collision
 * with user tables/functions.
 *
 * Safe to call once per `Database`; a repeat call (same name/arity) **replaces** the
 * prior registration rather than erroring or corrupting state (engine
 * `registerFunction` → `Schema.addFunction` is a keyed overwrite).
 */
export function registerBasisLifecycleTvf(db: Database, syncManager: SyncManager): void {
  const schema = createTableValuedFunction(
    {
      name: 'quereus_basis_lifecycle',
      numArgs: 0,
      // Records change across deploys (and across restarts), so the result is not
      // a pure function of its (empty) argument list.
      deterministic: false,
      returnType: {
        typeClass: 'relation',
        isReadOnly: true,
        isSet: false,
        columns: [
          col('schema', TEXT_TYPE, false),
          col('table', TEXT_TYPE, false),
          col('state', TEXT_TYPE, false),
          col('mappedBy', TEXT_TYPE, false),
          col('derivationSource', INTEGER_TYPE, false),
          col('inBasis', INTEGER_TYPE, false),
          col('mappedSince', INTEGER_TYPE, true),
          col('unmappedSince', INTEGER_TYPE, true),
          col('detachedAt', INTEGER_TYPE, true),
          col('lastDirectlyMappedWriteAt', INTEGER_TYPE, true),
          col('evictPolicy', TEXT_TYPE, true),
        ],
        keys: [],
        rowConstraints: [],
      },
    },
    // Snapshot the full record array once, then yield — iteration is over a stable
    // array, immune to a concurrent deploy mutating records mid-scan.
    async function* (): AsyncIterable<Row> {
      const records = await syncManager.getBasisTableLifecycle();
      for (const record of records) {
        yield rowFromRecord(record);
      }
    },
  );

  db.registerFunction(schema);
}

# Module Capability Negotiation

> **Stability: Stable** — see [Stability Tiers](stability.md#tiers).

The single inventory of every capability-negotiation surface on the `VirtualTableModule`
contract: how each one is signaled, what the engine substitutes when a module omits it, and
which built-in modules implement it. Module authors and reviewers should treat it as the
reference for "what happens if my module doesn't do X"; the surrounding implementation guide
is [module-authoring.md](module-authoring.md).

The contract signals capability three different ways, and the behavior when a module does
*not* implement a surface ranges from a clean negotiated rejection to **silent divergence**.

## Signaling styles

| Signaling | Members | Engine consults it? |
| --- | --- | --- |
| **Method presence** | `supports` / `executePlan`, `getBestAccessPlan`, `getMappingAdvertisements`, `getBackingHost`, `normalizeCreateSchema`, `createIndex` / `dropIndex`, `alterTable`, `renameTable`, `finalizeRename`, `beginSchemaBatch` / `endSchemaBatch`, `notifyLensDeployment`, `onRegister`, `assertCatalogObjectPersistable` | yes, per call site (varies) |
| **Static field** | `concurrencyMode`, `expectedLatencyMs` | yes, before dispatch (the clean model) |
| **`getCapabilities()` flag** | `delegatesNotNullBackfill`, `permitsGrandfatheredCheckViolators`, `permitsOrphanedForeignKeyRows`, `permitsGrandfatheredNotNullViolators`, `ddlTransactionality` (live); `isolation`, `savepoints`, `persistent`, `secondaryIndexes`, `rangeScans` (informational) | only the first five |

The static-field model (`concurrencyMode`, see [Concurrency Mode](module-authoring.md#3-concurrency-mode-parallel-runtime)) is the clean exemplar: a defaulted, queryable value the engine reads *before* it dispatches, to choose its path. The [recommended pattern](#recommended-capability-negotiation-pattern) generalizes toward it.

## Classification legend

Each surface below is tagged by how its **unsupported path** behaves:

- **Negotiated rejection** — the engine consults presence (or catches a thrown `UNSUPPORTED`) and turns the unsupported case into a clean, sited error before / at dispatch.
- **Engine-side fallback** — absence has a defined behavior the engine substitutes.
- **Silent divergence** — the module no-ops a mandate it cannot meet, and the engine never learns. This is the bug class this inventory exists to surface.
- **Data-dependent throw** — the module throws `CONSTRAINT` / `MISMATCH` per the arm's contract (correct — not a gap).

## Surface inventory

| Surface | Signaling | Unsupported-path | memory | store | isolation | leveldb / indexeddb |
| --- | --- | --- | --- | --- | --- | --- |
| `create` / `connect` / `destroy` | required | n/a | ✓ | ✓ | wraps underlying | via store |
| `getBestAccessPlan` | presence | engine-side fallback (default full-scan; isolation returns a default plan when the underlying lacks it) | ✓ | ✓ | forwards | via store |
| `supports` / `executePlan` | presence (pair) | engine-side fallback (index path) — isolation **deliberately suppresses** it so the overlay sees every row | — | — | suppressed | — |
| `getMappingAdvertisements` | presence | engine-side fallback (name-match only) | ✓ tags | ✓ tags | forwards | via store |
| `getBackingHost` | presence | negotiated rejection (`create materialized view … using <module>` and catalog import both reject a capability-less module with a sited `UNSUPPORTED`; resolving a host on an already-created backing without the capability is a sited `INTERNAL` — engine bug) | ✓ | ✓ (`StoreBackingHost` — coordinator-pending) | conditional forward (constructor-assigned **only when the underlying implements it**, so method presence mirrors the underlying — a wrapper around a capability-less module must not advertise) | via store |
| `normalizeCreateSchema` | presence | engine-side fallback (identity — the module is taken to create schemas verbatim) | n/a | ✓ supplies the table-level key collation `K` to an implicit-collation text primary-key column (`reconcilePkCollations`; `create` routes through the hook so the rewrite has one owner) | conditional forward (constructor-assigned **only when the underlying implements it** — a wrapper that delegates `create` but hides the hook makes the engine's probe disagree with the actual create) | via store |
| `createIndex` / `dropIndex` | presence | negotiated rejection (`SchemaManager.createIndex` — "does not support CREATE INDEX") | ✓ | ✓ | forwards (instance-level preferred) | via store |
| `alterTable` (method present) | presence | negotiated rejection (each data-affecting `run*` in `runtime/emit/alter-table.ts` throws a sited `UNSUPPORTED` if absent — except `renameColumn`, which degrades to an engine-side schema-only rename) | ✓ | ✓ | forwards (throws if underlying lacks) | via store |
| `renameTable` | presence | engine-side fallback (schema-only rename) | ✓ | ✓ physical move | forwards + rekeys maps | via store |
| `finalizeRename` | presence | engine-side fallback (no-op — `renameTable` did all the work) | n/a | ✓ deletes old catalog entry after dependents persist (two-phase, see [schema.md](schema.md)) | forwards | via store |
| `beginSchemaBatch` / `endSchemaBatch` | presence | engine-side fallback (per-DDL commits) | n/a | ✓ | forwards | via store |
| `notifyLensDeployment` | presence | engine-side fallback (no-op) | n/a | n/a | forwards | n/a |
| `onRegister` | presence | engine-side fallback (no-op — the module first sees its `Database` in a table hook) | n/a | ✓ subscribes to the schema-change notifier at `registerModule`, so a view created before the first store table is still persisted (and still vetoed) | forwards | via store |
| `assertCatalogObjectPersistable` | presence | engine-side fallback (no-op — the object is registered and its catalog write, if any, stays fire-and-forget) | n/a | ✓ refuses a view / MV / rename-rewritten table whose key or generated DDL it could not encode (tables self-filtered on ownership) | forwards | via store |
| `concurrencyMode` | static field | engine-side fallback (`'serial'`) | `reentrant-reads` | `serial` (default) | computed: `weaker(underlying, overlay)`, capped at `reentrant-reads` | via store |
| `expectedLatencyMs` | static field | engine-side fallback (`0`) | 0 | 0 | forwards underlying | via store |
| `readCommittedSnapshot` | static field | engine-side fallback (`false` — the read keeps the serialized path) | `true` (immutable layers; single-pointer commit publish; pinned unregistered read connection) | `false` (shared cached table per key drops the option; `query` merges pending ops over the committed store) | mirrors underlying — a `_readCommitted` connect opens its OWN underlying handle (never the memoized writer handle) and the read bypasses the overlay, so the wrapper adds no tearing window; it still cannot promise more than the underlying delivers | via store (`false`) |
| `getCapabilities().delegatesNotNullBackfill` | flag (live) | engine-side gate (ADD COLUMN skips `validateNotNullBackfill`) | off | off | inherits underlying | off |
| `getCapabilities().permitsGrandfatheredCheckViolators` | flag (live) | engine-side gate (`getTrustedCheckExtraction` returns the empty extraction, so `TableReferenceNode` skips the CHECK lift and the lens prover refuses the table's CHECK-derived enum domains) | off | off | inherits underlying | off |
| `getCapabilities().permitsOrphanedForeignKeyRows` | flag (live) | engine-side gate (the planner's two FK-existence producers — `lookupCoveringFK` and `seedTableForeignKeyInds`, `planner/util/ind-utils.ts` — return the empty answer when the child's **or** the parent's owning module declares it, so INNER join elimination, the semi/anti-join FK folds, `atMostOne-inner` fan-out, and the coverage prover's no-row-loss proof all decline; the at-most-one claim (`checkFkPkAlignment`) and write-time FK enforcement are unaffected — invariant OPT-059) | off | off | inherits underlying | off |
| `getCapabilities().permitsGrandfatheredNotNullViolators` | flag (live) | engine-side gate (the lens prover demotes `lens.nullability-mismatch` from deploy-blocking error to acknowledgeable advisory when **every** basis table the compiled body reads belongs to a declaring module — the declarant may hold rows lacking a value for a declared NOT NULL column, grandfathered by a structurally-total schema change or replicated from an older schema epoch; a read-side demotion only — it changes no write behavior, and note the lens enforcement rewrite does not attach a logical NOT NULL to the basis write in the first place) | off | off | inherits underlying | off |
| `getCapabilities().ddlTransactionality` | flag (live) | engine-side gate (`ddl_transaction_policy = strict` refuses module-dispatching DDL inside an explicit transaction unless the tier is `transactional`; default `permissive` never consults it — see [DDL transactionality tiers](#ddl-transactionality-tiers)) | `non-transactional` | `auto-commit` | **forwards underlying verbatim, never upgrades** | via store |
| `getCapabilities().{isolation,savepoints,persistent,secondaryIndexes,rangeScans}` | flag (informational) | **never consulted by engine** — asserted only in tests; isolation augments `isolation` / `savepoints` but nothing reads them | varies | varies | augments | varies |

> **Isolation wrapper asymmetry is intentional.** `IsolationModule` forwards the isolation-transparent hooks (`getBestAccessPlan`, `getMappingAdvertisements`, the batch + lens lifecycle hooks, `onRegister`, `assertCatalogObjectPersistable`, `renameTable`, `finalizeRename`, `alterTable`) but **suppresses** `supports` (so the overlay always sees every row to merge), computes a conservative `concurrencyMode` (the weaker of the underlying and overlay modes, capped at `reentrant-reads` because its own write path is never fully-reentrant), and forwards the underlying's `expectedLatencyMs`. See the **Transparent hook forwarding** paragraph in [`packages/quereus-isolation/README.md`](../packages/quereus-isolation/README.md) for the full rationale — do not restate it divergently here.

## DDL transactionality tiers

`getCapabilities().ddlTransactionality` declares how a module's DDL (schema-change)
statements behave with respect to the enclosing transaction. It is a single
**worst-case summary** across every DDL statement the module can execute — per-statement
detail belongs in the backend docs, not the flag. Three tiers, in severity order:

- **`transactional`** — the reference semantics. A schema change is part of the enclosing
  transaction: the catalog entry and physical structures (index trees, migrated rows,
  moved storage) are buffered with the transaction, visible to later statements inside it,
  made durable atomically with the DML at commit, and discarded whole on `rollback` /
  `rollback to savepoint`. **No built-in module reaches this tier today** — it needs a
  transaction-scoped catalog, which `SchemaManager` does not have (tracked by the backlog
  ticket `feat-transactional-ddl-native-backends`).
- **`non-transactional`** — the schema change escapes the transaction (it survives
  `rollback`) but buffered DML still rolls back normally. This is the **memory** module,
  and the store's non-committing DDL statements (`create index`, `add constraint`,
  schema-only arms).
- **`auto-commit`** — executing certain DDL commits the module's buffered transaction at
  DDL time: the schema change **and every buffered write** become durable immediately, and
  a later `rollback` undoes nothing. This is the **store** module (its row-rewriting ALTER
  arms and `renameTable` flush pending ops); because a module declares its worst case, the
  store declares `auto-commit` even though much of its DDL is only non-transactional.

**Default when absent: `non-transactional`.** A module must EXPLICITLY claim
`transactional`; defaulting to the clean semantics would let every existing module
silently over-promise.

**The gate.** The `ddl_transaction_policy` option / pragma governs enforcement:

- `permissive` (default) — today's behavior, unchanged; the flag is not consulted.
- `strict` — a statement that dispatches to a module DDL surface (`create table … using`,
  `drop table`, `create index`, `drop index`, any `alter table` arm, `rename table`,
  `create`/`drop`/`refresh materialized view`) while an **explicit** transaction is open on
  a module whose tier is not `transactional` raises a sited `QuereusError` before any
  dispatch or catalog mutation. The transaction stays open and usable. Autocommit-mode DDL
  (the normal case) is never gated — only an explicit `BEGIN` trips it.

  The materialized-view verbs consult the **backing-host** module — the `using <module>(…)`
  host, else the `memory` default, *not* the session default module. `refresh` is gated
  even though it mostly rewrites rows: its reshape arm reconciles a shifted body shape with
  module `alterTable` ops, and both of its arms commit the contents swap (a `begin; refresh;
  rollback` does not undo the refresh), so its effect escapes the enclosing transaction the
  same way the schema statements' do.

Engine-only schema objects (`create view`, `create assertion`, `declare schema`) are out
of the gate's scope: they touch no module, and the engine's own schema is transient by
design (see [architecture.md § Transient Schema](architecture.md)). Tag-only edits
(`alter view/index/materialized view … set tags`) are likewise ungated — they dispatch to
no module either. The one inconsistency: `alter table … set tags` *is* refused, because
the `ALTER TABLE` emitter gates all of its arms uniformly rather than per-arm.

`apply schema` runs its generated migration DDL through the engine's *implicit*
transaction, so the gate does not fire statement-by-statement inside a migration. It does
fire — on the first gated statement the migration emits — if the caller wrapped the
`apply schema` in an explicit `begin`.

The isolation wrapper **forwards the underlying's declared tier verbatim and never
upgrades it**: the overlay stages DML outside the underlying module, so an underlying
DDL-commit flushes only module-side ops — forwarding the pessimistic underlying value is
the honest choice.

## `alterTable` sub-arms — the fine-grained mandate layer

> **Invariant:** [SCH-004](invariants.md#sch-004--a-module-never-silently-no-ops-an-altertable-arm)

`alterTable` presence is **one bit covering ~12 `SchemaChangeInfo` arms** (see [Schema Changes](module-authoring-schema-changes.md)), each with its own mandate. This mismatch is the divergence hazard: a module can be "ALTER-capable" (the method is present) yet silently fail one arm it cannot honor. The `alterPrimaryKey` row is the model the [recommended pattern](#recommended-capability-negotiation-pattern) promotes to a universal rule: **try native → on `UNSUPPORTED` apply a defined fallback**.

| Arm | Mandate | memory | store |
| --- | --- | --- | --- |
| `addColumn` | append column; backfill; NOT-NULL gated by `delegatesNotNullBackfill`; honor `insertAtIndex` **or throw `UNSUPPORTED`** | ✓ (honors a position) | ✓ (append only — rejects a position) |
| `dropColumn` | remove slot + reindex | ✓ | ✓ |
| `renameColumn` | schema-only | ✓ | ✓ |
| `alterPrimaryKey` | re-key in place **or throw `UNSUPPORTED`** | in-place re-key (open-transaction pending layers and their change events re-keyed too) | in-place re-key |
| `addConstraint` | materialize + validate (unique / fk) | ✓ | ✓ unique / fk; throws `UNSUPPORTED` for others |
| `dropConstraint` / `renameConstraint` | schema rewrite | ✓ | ✓ |
| `alterColumn.setNotNull` | backfill from default or throw `CONSTRAINT` | ✓ | ✓ |
| `alterColumn.setDataType` | physical convert or throw `MISMATCH` | ✓ | ✓ |
| `alterColumn.setDefault` | schema-only | ✓ | ✓ |
| `alterColumn.setCollation` (non-PK UNIQUE) | re-validate uniqueness under new collation | ✓ | ✓ |
| `alterColumn.setCollation` (**PK column**) | re-key / re-validate PK under new collation (`module.ts` setCollation contract) | ✓ re-keys | ✓ re-keys (physical re-key + secondary-index rebuild; `CONSTRAINT` on a collision under the new collation) |

> The PK-column `setCollation` cell is **honored by a physical re-key** on both modules. The store keys each PK column under its own declared collation (`StoreTable.pkKeyCollations`), so a PK `SET COLLATE` re-encodes every data-store key under the new collation (`StoreTable.rekeyRows`) and rebuilds each secondary index (whose keys embed the PK suffix). A re-key that would collide under the new collation throws a sited `CONSTRAINT` in the validation pass **without mutating the store** (all-or-nothing, mirroring `ALTER PRIMARY KEY`); a target equal to the column's current collation is a schema-only no-op. This is the `store-pk-collate-physical-rekey` follow-up to the earlier negotiated-rejection stopgap — the store now reaches full memory parity, so neither the engine-side logical-enforce scan nor the `UNSUPPORTED` reject is needed.

> **CREATE honors any declared PK collation too.** `StoreModule.create` keys an *explicit* per-column PK collation natively (`create table t (x text collate binary primary key)` is keyed under BINARY), and only applies the store's table-level default K (`config.collation || 'NOCASE'`) to an *implicit*-default text PK column (so an undecorated text PK keeps the store's historical NOCASE-keyed behavior rather than the engine's BINARY column default). The implicit-vs-explicit distinction is carried by `ColumnSchema.collationExplicit` (set by `columnDefToSchema` only on a `COLLATE` clause — purely additive; every other consumer ignores it). The per-column key collation round-trips through the column's (BINARY-elided) `COLLATE` clause, so the load path (`connect` / rehydrate) needs no reconciliation. Non-text PK columns keep their declared collation — collation governs key bytes only for text. See [`docs/schema.md` § Per-column PK key collation](schema.md) for the store-side detail.

## Recommended capability-negotiation pattern

These are the rules new modules and new contract points should follow. They generalize the clean models already in the tree (`concurrencyMode`, the `alterPrimaryKey` protocol) and retire the failure mode the inventory above flags.

1. **Presence-signaling is reserved for purely-additive optional hooks** whose absence is already a clean engine-side fallback (`getMappingAdvertisements`, the batch / lens lifecycle notifications). Absence there means a documented no-op — it can never diverge.

2. **Any contract point where the engine assumes a behavior must be declared and consulted before dispatch.** `concurrencyMode` is the template: a defaulted, queryable value the engine reads to choose its path. Generalize toward this, not toward more presence bits.

3. **`getCapabilities()` is the single home for binding capability gates.** Four flags are **live gates** the engine consults before/at dispatch — `delegatesNotNullBackfill`, `permitsGrandfatheredCheckViolators`, `permitsOrphanedForeignKeyRows` (see [OPT-059](invariants.md#opt-059--fk-derived-existence-is-capability-gated)), and `ddlTransactionality` (see [DDL transactionality tiers](#ddl-transactionality-tiers)) — and this is where new binding gates belong. The five informational flags — `isolation`, `savepoints`, `persistent`, `secondaryIndexes`, `rangeScans` — are **advisory / non-binding**: the engine does not consult them, so toggling them changes nothing about engine behavior (they are asserted only in tests, and isolation augments `isolation` / `savepoints` for its own bookkeeping). Do not be misled into treating them as gates, and do not grow that advisory set. (Their removal / relocation is a separate code ticket; the distinction is documented here, not yet acted on.)

4. **Hard contract — no silent divergence**, stated by [SCH-004](invariants.md#sch-004--a-module-never-silently-no-ops-an-altertable-arm). It promotes the existing `alterPrimaryKey` protocol to a universal rule.

5. **Fine-grained ALTER negotiation.** Because `alterTable` presence is one coarse bit, per-arm support is negotiated at the relevant `run*` call site. The negotiation does **not** have to be a static capability flag or an engine routing branch: when the accept/reject decision is intrinsically module-internal — depending on per-table physical state the engine neither owns nor tracks — the **behavioral `throw UNSUPPORTED` contract** (rule 4) *is* the negotiation. The store's PK-column `setCollation` is the worked example: the accept/reject call hinges on the table's fixed physical key collation K (`config.collation`), so the store resolves it by applying a consistent change (target == K) schema-only and throwing a sited `UNSUPPORTED` on a divergent one — `runAlterColumn` propagates the throw cleanly with no engine change. The `native | logical-enforce | reject` trichotomy the work explored collapses, for the store, to `reject` (the consistent case being plain schema-only, not a special mode); logical-enforce and physical re-key remain documented future enhancements. New arms adopt whichever shape fits — a queryable value when the engine must choose its path *before* dispatch (à la `concurrencyMode`), or the behavioral contract when the decision is module-internal — incremental, not a giant up-front descriptor.

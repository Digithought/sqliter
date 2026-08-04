---
description: Make column and constraint changes — adding or dropping a column, renaming one, adding or dropping a constraint, changing the primary key — actually reach the other synced devices instead of stopping at the device that made them.
prereq: sync-alter-table-event-carries-ddl
files:
  - packages/quereus-sync/src/sync/store-adapter.ts                # applySchemaChange, decideSchemaChange, schemaEventSignature
  - packages/quereus-sync/src/sync/sync-manager-impl.ts            # recordSchemaMigration (~857) — the blank-DDL warning
  - packages/quereus-store/src/common/events.ts                    # StoreEventEmitter — the remote-event expectation registry
  - packages/quereus-store/test/events.spec.ts                     # covers that registry directly
  - packages/quereus-sync/test/sync/_peer-harness.ts               # relayAll — two real store-backed peers
  - packages/quereus-sync/test/sync/schema-ddl-replication.spec.ts # the create/drop/index forms that already replicate
  - packages/quereus-sync/test/sync/schema-alter-table-warnings.spec.ts # asserts the warnings this ticket makes unreachable
  - packages/quereus-sync/test/sync/schema-replication-idempotency.spec.ts # synthetic-migration coverage of decideSchemaChange
  - docs/sync-schema.md                                            # § What replicates, § Idempotent DDL application
difficulty: hard
---

# Replicate table alterations

`RENAME TO` is deliberately excluded — it needs the old name on the wire and a
data-routing fix, and lands in `sync-replicate-rename-table`.

## Why

With ticket 1 landed, an alteration records an `alter_column` migration carrying real
SQL, and the receiver's existing `applySchemaChange` will execute it. Two things then
have to be right, and neither is today:

1. **The receiver must not mistake the replicated change for one of its own.** Before
   running replicated DDL the adapter registers a *remote-event expectation* — a marker
   meaning "the event this is about to emit came from sync; don't re-record it as a
   local change". Markers are matched **one for one** and never expire. Any statement
   that emits a different number of events than expected either leaks a phantom local
   change back onto the wire, or strands a marker that swallows the next genuine local
   change of the same shape. Ticket 1 makes ALTER emit exactly one event, which
   happens to fit — but the coupling itself is what produced this class of bug twice
   already (once for `drop table` over an indexed table). Replace it.

2. **Applying the same alteration twice must converge.** Two peers offline can each run
   `alter table orders add column sku text`; whichever migration wins the HLC comparison
   is then delivered to a peer that already has `sku`. Re-executing raw DDL there throws,
   the throw lands in `ApplyToStoreResult.errors`, and a non-empty `errors` aborts the
   whole admission unit *before* its CRDT metadata commits — so the peer's watermark
   never advances and it re-applies and re-fails the same batch forever. This is exactly
   the failure `bug-sync-create-table-replication-not-idempotent` fixed for
   `create table`; alterations need the same treatment.

## Design

### A. Scoped remote-event marking, replacing one-for-one expectations

Change `StoreEventEmitter`'s expectation registry from *consume-on-match* keyed by
`(type, objectType, schema, object)` to a *scope* keyed by `(schema, object)` only:

```ts
/** While a scope is open for (schema, object), every schema event naming it is marked remote. */
beginRemoteSchemaScope(schemaName: string, objectName: string): void;
endRemoteSchemaScope(schemaName: string, objectName: string): void;
```

Implementation is a refcounted `Map<string, number>` — the shape already there — with
two differences that carry the whole fix:

- **Matching does not decrement.** A scope covers *every* event emitted while it is
  open, whether that is zero, one, or several.
- **The count is released by the caller's `finally`,** never by an event arriving. A
  statement that emits nothing therefore leaves nothing behind.

Delete `expectRemoteSchemaEvent` / `clearExpectedRemoteSchemaEvent` and rewrite the two
specs in `packages/quereus-store/test/events.spec.ts` against the new API
(backwards compatibility is explicitly not a concern in this repo yet).

`applySchemaChange` then becomes:

```ts
events.beginRemoteSchemaScope(change.schema, change.table);
try {
  await db.exec(change.ddl);
} finally {
  events.endRemoteSchemaScope(change.schema, change.table);
}
```

`schemaEventSignature` is no longer needed — drop it, and with it the requirement that
it stay the exact inverse of `mapSchemaMigrationType`.

Scoping is time-bounded rather than signature-matched, so state the tradeoff in the
doc comment: a *concurrent* local DDL on the **same** `(schema, object)`, issued while
the adapter's `db.exec` is in flight, would be mis-marked remote. `Database` serializes
statements behind its execution mutex, so it can only be a host issuing local DDL on the
very table being replicated at that moment. The old scheme had the mirror-image hazard
(a concurrent local DDL of the same *signature* consumed the marker) and additionally
broke on any statement whose event count was not exactly one.

### B. Per-arm idempotency in `decideSchemaChange`

`alter_column` migrations currently fall through to `default: return 'execute'`. Give
them a real arm. The migration carries only text, so parse it with the engine's own
parser (`Parser` is exported from `@quereus/quereus`; the AST types come from
`@quereus/quereus/parser`) and decide against the local `TableSchema`:

| Action | `already-applied` when | else |
|---|---|---|
| `addColumn` | column present locally **and** its logical type equals the declared one | absent → `execute`; present with a **different** type → throw a conflict naming both |
| `dropColumn` | column absent | `execute` |
| `renameColumn` | new name present **and** old name absent | old present → `execute`; both absent → converge with a warning |
| `addConstraint` | a constraint of that name exists (named), or an equivalent UNIQUE over the same column set exists (unnamed) | `execute` |
| `dropConstraint` | no constraint of that name | `execute` |
| `renameConstraint` | new name present and old absent | old present → `execute`; both absent → converge with a warning |
| `alterColumn … set data type` | local column's logical type already equals the target | `execute` |
| `alterColumn … set/drop not null` | local `notNull` already equals the target | `execute` |
| `alterColumn … set/drop default` | rendered local default equals the target's rendered expression | `execute` |
| `alterColumn … set collate` | local collation name equals the target, case-insensitively | `execute` |
| `alterPrimaryKey` | local PK column names **and** directions already equal the target list | `execute` |
| anything else (tags, maintained, rename to) | — | `execute`, as today |

A parse failure must not be swallowed: log it and `execute`, so the underlying DDL error
is what the operator sees rather than a parser message.

**Only `addColumn` compares a definition, and only its logical type.** That is
deliberate, and the reasoning belongs in the code:

- A type difference is the dangerous divergence — two peers would interpret the same
  rows under different shapes, which is exactly the case `create_table` refuses to
  paper over.
- Comparing anything richer means comparing an AST column definition (rendered from the
  origin's statement) against a `ColumnSchema` (rendered from the receiver's catalog),
  and those two do not round-trip: an unnamed inline CHECK is auto-named `_check_<col>`
  on the way into the catalog, session `default_column_nullability` decides whether
  `not null` is even spelled, and so on. A false conflict permanently blocks the peer,
  which is strictly worse than converging on a constraint-level difference.
- So: constraint-level drift between two same-named, same-typed columns converges
  silently. Record that as a `NOTE:` at the comparison site — if it ever bites, the fix
  is to compare parsed schemas, not rendered text.

### C. The origin-side warning stops firing

`recordSchemaMigration`'s blank-DDL warning becomes unreachable for store-backed tables
(every alter arm now carries text). Keep the warning — a third-party module emitting an
`alter` event without `ddl` still deserves it — but rewrite
`schema-alter-table-warnings.spec.ts`, which currently proves the *gap*: drive the
warning from a synthetic DDL-less schema event instead of from a real `ALTER TABLE`, and
assert that a real `ALTER TABLE` now warns at **neither** end.

## Edge cases & interactions

- **Zero-event statements.** With scoped marking, a replicated statement that emits no
  event (a future arm, or a third-party module) leaves no residue. Pin it: relay a
  migration whose DDL is a no-op ALTER form and assert the next genuine local DDL is
  still captured and replicated.
- **Multi-event statements.** Even though ticket 1 makes ALTER single-event, the scope
  must survive several. Pin it directly at the `StoreEventEmitter` level (emit three
  events inside one scope, all marked remote, nothing left over) rather than relying on
  an ALTER form that happens to produce them.
- **DDL failure inside the scope.** `db.exec` throws → `finally` closes the scope → the
  next local DDL of that shape is captured normally. This is the case the old
  `clearExpectedRemoteSchemaEvent` existed to handle; it must keep working.
- **Backfilled values are not data facts.** `add column sku text default 'x'` writes
  every existing row inside `module.alterTable` (`migrateRows`), which emits no data
  events — so nothing is recorded in the change log and each peer computes its own
  backfill when it replays the statement. That converges only because non-deterministic
  defaults are already rejected at plan-build time, and because a per-row backfill is a
  function of the row it fills. State this in `docs/sync-schema.md`; a reader will
  otherwise assume the values replicated.
- **Rows for a dropped column.** After `drop column note` replicates, the origin's
  change log may still hold facts naming `note`. `mergeColumnUpdates` (store-adapter)
  logs `Column 'note' not found in main.orders` per change and skips it. Correct but
  noisy — assert the rows for surviving columns still land, and consider whether the
  warning should be demoted for a column the batch's own DDL just dropped.
- **`alter primary key` strands CRDT metadata.** Sync's `cv:` / `tb:` / `cl:` keys are
  filed under the row's primary-key identity, so re-keying a table abandons all of it
  and later conflict resolution silently starts from empty. Pre-existing for a *local*
  primary-key change; replicating the statement makes it happen on every peer. Do **not**
  fix it here — it is filed as `bug-sync-rename-and-pk-change-strand-crdt-metadata`.
  Reference that slug in a `NOTE:` at the `alterPrimaryKey` arm of `decideSchemaChange`.
- **Ordering within a batch.** Two alterations of one table in one batch replay in HLC
  order (`orderMigrationsByHLC`), and their schema versions are monotonic per table, so
  the version guard admits them in order. Pin `add column a` then `add column b` in one
  relay.
- **Re-delivered batch.** The `change-applicator` version guard absorbs it before the
  adapter is reached; `decideSchemaChange` never sees it. Pin both anyway — the guard
  and the adapter are independent gates and each has its own regression risk.
- **A migration whose table no longer exists locally** (the receiver dropped it): the
  DDL throws `no such table`, aborting the batch. Decide explicitly — converge with a
  warning when the named table is absent, consistent with `drop_index`'s absent-owner
  arm — and pin it.
- **Multi-alteration `apply schema`.** The declarative differ emits one `ALTER TABLE`
  statement per alteration into one transaction, so one commit yields several migrations
  for one table, each with its own version and DDL. Pin an `apply schema` that adds and
  drops a column in one round.

## Tests

New spec `packages/quereus-sync/test/sync/schema-alter-replication.spec.ts`, modelled on
`schema-ddl-replication.spec.ts` (two real peers, `relayAll`):

- Each arm replicates: after `relayAll(a, b)`, `b`'s `TableSchema` matches `a`'s for
  add column, drop column, rename column, add constraint, drop constraint, rename
  constraint, each `alter column` sub-form, and alter primary key. Assert against
  `generateTableDDL(local)` on both peers — one comparison that covers shape, order,
  types, nullability, collation, defaults and constraints at once.
- **Data keeps flowing across each alteration**: insert on `a` after the alter, relay,
  and read the row back on `b` — including a value in the newly added column.
- A replicated constraint still **enforces** on the receiver (insert a violating row on
  `b` and expect a throw), mirroring the unique-partial-index spec that already exists
  for indexes.
- Convergence: both peers independently run the identical alteration, relay in **both**
  HLC directions (the existing index specs show why both are needed — one direction is
  absorbed by the version guard, the other reaches `decideSchemaChange`), and neither
  errors.
- Divergence: `a` adds `sku text`, `b` adds `sku integer`; relaying the later-HLC side
  throws a conflict naming the column and printing both types.
- The same batch applied twice converges.
- No expectation leak: after relaying an alteration, a genuine **local** `ALTER TABLE`
  on the receiver is still captured (`getChangesSince` shows its migration) — the
  regression the old refcounted registry produced.
- `packages/quereus-store/test/events.spec.ts` rewritten for the scope API, including
  the zero-event and multi-event cases above.
- `schema-replication-idempotency.spec.ts` extended with synthetic `alter_column`
  migrations hitting each row of the decision table, including the parse-failure path.

## TODO

- Replace the expectation registry in `StoreEventEmitter` with
  `beginRemoteSchemaScope` / `endRemoteSchemaScope`; document the concurrency tradeoff.
- Rewrite `applySchemaChange` to scope `db.exec`; delete `schemaEventSignature`.
- Add the `alter_column` arm to `decideSchemaChange`, parsing with `Parser`; implement
  the decision table; `NOTE:` the constraint-drift and PK-metadata limitations.
- Keep the blank-DDL warnings but rewrite `schema-alter-table-warnings.spec.ts` to drive
  them synthetically, and assert a real ALTER now warns at neither end.
- New `schema-alter-replication.spec.ts`; rewrite `events.spec.ts`; extend
  `schema-replication-idempotency.spec.ts`.
- `docs/sync-schema.md`: rewrite § What replicates (alterations now do; `RENAME TO` and
  tag/maintained arms still do not, with the reason and the follow-on slug), and add the
  alteration rows to the § Idempotent DDL application table.
- `yarn build`, `yarn test`, `yarn lint`.

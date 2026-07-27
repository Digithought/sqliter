description: Sync used to throw away an entire transaction's worth of changes when that transaction also dropped one of the tables it wrote to; now it skips only the dropped table's rows and syncs everything else.
prereq:
files:
  - packages/quereus-sync/src/sync/sync-manager-impl.ts        # handleTransactionCommit, filterCapturableDataEvents, isPkKeyingResolvable, recordColumnVersions
  - packages/quereus-sync/test/sync/transaction-commit.spec.ts # four new tests
  - packages/quereus-sync/test/sync/sync-manager.spec.ts       # rewritten skip-contract test (~line 1927)
  - packages/quereus-sync/test/sync/_peer-harness.ts           # makePeer / relayAll / collect (unchanged, used by new tests)
  - docs/sync.md                                               # § Write side: one tick per commit
difficulty: medium
----

## What changed

`SyncManagerImpl.handleTransactionCommit` records a committed local transaction's
CRDT metadata. Every per-row record it writes is filed under the row's *pk identity*,
which is resolved from the table's schema by `createPkKeyingResolver`
(`metadata/pk-identity.ts`). That resolver deliberately **throws** when a schema
oracle is wired but the table is unknown — there is no sound identity for a
schemaless table.

The whole handler sat inside one `try`/`catch`. So a transaction that both wrote rows
to a table *and* dropped that table hit the throw (the schema is gone by the time the
commit group is delivered), the catch swallowed it, and **nothing** of that
transaction was recorded — not the other tables' rows, not the schema migrations.

Now the handler filters its local data events **before** the HLC tick:

```ts
const localSchema = batch.schemaEvents.filter(e => !e.remote);
const localData = this.filterCapturableDataEvents(
    batch.dataEvents.filter(e => !e.remote),
    localSchema,
);
if (localSchema.length === 0 && localData.length === 0) return;   // unchanged early-out
```

`filterCapturableDataEvents` probes each distinct table once (`isPkKeyingResolvable`,
a try/catch around `this.pkKeying(schema, table)`), keeps the events of resolvable
tables, and counts the skipped ones per table. `localSchema` is consulted **only** to
classify the log line — a table dropped by this same transaction logs
`console.log(...— table dropped by the same transaction)`, anything else logs
`console.warn(...— sync pk identity is unresolvable ...)`. One line per skipped table
with its change count, never one per row.

The gate is **resolvability**, not "this transaction contains a drop for this table":
`drop t; create t; insert into t` in one transaction carries a drop event for `t` yet
resolves fine, so its rows must still be captured.

Running before the tick is load-bearing three ways:
- a fully-skipped transaction with no schema events consumes no HLC and emits no
  `localChange` (mirrors the all-remote-echo early-out directly above);
- nothing is ever half-staged — the old throw could fire *after* a tombstone had
  already been written into the shared `WriteBatch`;
- `opSeq` stays contiguous from 0, because opSeq is only allocated for facts that
  actually record.

Also removed: the now-unreachable `No table schema found for … - using fallback column
names` warn branch in `recordColumnVersions`. An oracle-wired manager can no longer
reach that method for a table the oracle doesn't know. The `col_${i}` fallback itself
stays — it is the live path for a relay-only manager with no oracle at all.

## Use cases / how to exercise it

**The original bug (now fixed).** Against a real `Database` + `StoreModule`:

```sql
create table a (id integer primary key, v text) using store;
create table b (id integer primary key, v text) using store;
insert into a values (1, 'a1'); insert into b values (1, 'b1');

begin;
  update a set v = 'a2' where id = 1;
  update b set v = 'b2' where id = 1;
  drop table a;
commit;
```

Before: `[Sync] Error handling transaction commit: Error: No table schema for main.a …`
and `getChangesSince` returned neither b's `'b2'` nor the `drop_table` migration.
After: `getChangesSince` returns b's `v='b2'` column change **and** the `drop_table`
migration for `a`; one informational log line names `main.a` and its skipped count.

**Relay-only deployment (no `getTableSchema`, e.g. the coordinator).** Every table
resolves to `RAW_PK_KEYING` and never throws, so nothing is ever skipped — no
behavior change. Covered by the untouched sibling test `'should not warn about
missing table schema when getTableSchema is not provided'`.

**Manual poke.** `packages/quereus-sync/test/sync/transaction-commit.spec.ts`, describe
block `capture skips an unresolvable table, not the whole transaction (real Database)`
— its `makeAB` / `writeBothThenDropA` helpers are the reproduction verbatim.

## Tests added / changed

New, in `test/sync/transaction-commit.spec.ts`:

- **`records the sibling table and the drop migration; skips only the dropped table
  rows`** — the reproduction above, real `Database` via `makePeer`. Asserts b's `'b2'`
  present, `drop_table` migration for `a` present, and `a`'s in-transaction update
  absent.
- **`relays the surviving sibling rows and the drop migration to a peer`** — asserts
  the `drop_table` migration is on the wire payload `src.getChangesSince(dst)` returns,
  then `relayAll` and `select v from b where id = 1` → `'b2'` on the peer.
- **`drop-then-recreate in one transaction still captures the post-recreate rows`** —
  `begin; drop table a; create table a (…); insert into a values (2,'fresh'); commit`.
  This is the case a naive drop-name skip would break.
- **`skip is table-scoped, not transaction-scoped: the known table still records`** —
  `FakeTransactionSource`, oracle knows `users` but not `ghost`, `ghost` listed FIRST.
  Asserts only `users` facts record, opSeq is `[0, 1]` (proving the skip happened
  before the tick), exactly one warning names `main.ghost`, and **no** `error`
  sync-state event fires.

Rewritten, `test/sync/sync-manager.spec.ts` ~line 1927 (was
`'should warn about missing table schema when getTableSchema is provided but returns
undefined'`, which asserted exactly the behavior being replaced) → **`'should skip
changes for a table whose schema the oracle does not know'`**: exactly one skip
warning naming `main.test`, and no `cv:main.test…` key in the KV store.

## Validation run

- `yarn workspace @quereus/sync run test` → **539 passing, 0 failing**
- `yarn test` (whole workspace) → all suites green, 0 failing
- `yarn build` → clean
- `yarn workspace @quereus/sync run typecheck` → clean. (Note: that tsconfig excludes
  `test/`; test files *are* type-checked, but by `ts-node` at mocha load time via
  `tsconfig.test.json` — which is not transpile-only, so a type error there fails the
  run.)

No pre-existing failures surfaced; `tickets/.pre-existing-error.md` was not written.

## Known gaps / things a reviewer should push on

- **The peer-side test does not assert the peer's table actually disappears**, only
  that the `drop_table` migration reaches the wire payload. That is deliberate and
  documented in the test's comment: the store module emits its drop-table schema event
  with no DDL (`store-module.ts` ~line 829), so it replicates as `ddl: ''` and
  `applySchemaChange` short-circuits blank DDL. A plain `drop table` in its own
  transaction already fails to remove the table on a peer today, independent of this
  bug — tracked by the in-flight ticket `sync-schema-migrations-replicate-empty-ddl`.
  Worth confirming the reviewer agrees this stays out of scope here.
- **A dropped table's `cv:`/`tb:`/`cl:` records are still left in the sync KV forever.**
  Deliberately out of scope (retention of a retired table's metadata is load-bearing
  for the store-and-forward relay and for detached basis tables). The concrete defect
  it enables — a re-created table inheriting the previous incarnation's tombstones —
  is filed as `bug-sync-recreated-table-inherits-dropped-table-metadata`. Note this
  means the first new test's assertion is narrower than it might look: `a`'s
  *pre-transaction* insert facts still appear in `getChangesSince` (they were captured
  while the table resolved), so the test asserts "no fact carries the value `'a2'`",
  not "no facts for `a` at all". The comment says so; a reviewer should sanity-check
  that framing.
- **`isPkKeyingResolvable` swallows an exception**, which cuts against the project's
  "don't eat exceptions silently" rule. It is a deliberate probe — the resolver's throw
  IS its documented "no sound identity" signal, and the sole caller always reports the
  skip, so the condition is never silent. Documented in the method's doc comment.
  Reviewer may prefer a non-throwing `tryPkKeying` on the resolver instead; that would
  be a wider change to `metadata/pk-identity.ts`.
- **`console.log` for the expected-skip line introduces a level not previously used in
  `packages/quereus-sync/src`** (which only had `console.warn` / `console.error`). The
  ticket asked for the expected case to be informational rather than a warning. If the
  package wants a real logger abstraction that is a separate concern.
- **No test covers the multi-table skip case** (two different unresolvable tables in
  one transaction → two distinct log lines). The per-table counting and the
  `Map`-keyed dedup are covered only by the single-table cases.
- **No test covers a skipped table whose events are `delete`s** rather than
  inserts/updates. Deletes take a different path in `recordDataEvent` (tombstone +
  `deleteRowVersionsAndLogEntries`), and that path was where a half-staged write could
  previously occur. The filter is type-agnostic so it should be fine, but it is
  asserted only by construction, not by a test.
- No new tripwires were parked in code beyond the doc comments described above; the
  `docs/sync.md` § *Write side: one tick per commit* paragraph is the architectural
  record of the best-effort-at-table-granularity contract.

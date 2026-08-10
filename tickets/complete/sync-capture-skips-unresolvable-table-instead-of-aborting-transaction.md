description: Sync used to throw away an entire transaction's worth of changes when that transaction also dropped one of the tables it wrote to; now it skips only the dropped table's rows and syncs everything else.
prereq:
files:
  - packages/quereus-sync/src/sync/sync-manager-impl.ts        # handleTransactionCommit, filterCapturableDataEvents, logSkippedTables, recordColumnVersions
  - packages/quereus-sync/src/metadata/pk-identity.ts          # createPkKeyingResolver — the throw this filter routes around (unchanged)
  - packages/quereus-sync/test/sync/transaction-commit.spec.ts # skip tests + captureConsole helper
  - packages/quereus-sync/test/sync/sync-manager.spec.ts       # relay-only + unknown-oracle-table tests (~line 1902/1932)
  - docs/sync.md                                               # § Write side: one tick per commit
difficulty: medium
----

## What shipped

`SyncManagerImpl.handleTransactionCommit` records a committed local transaction's CRDT
metadata. Each per-row record is filed under the row's *pk identity*, resolved from the
table's schema; that resolver deliberately **throws** when a schema oracle is wired but
the table is unknown, because there is no sound identity for a schemaless table.

The whole handler sat inside one `try`/`catch`, so a transaction that wrote rows to a
table *and* dropped that table hit the throw (the schema is gone by the time the commit
group is delivered), the catch swallowed it, and **nothing** of that transaction was
recorded — not the other tables' rows, not the schema migrations.

Now the handler filters its local data events **before** the HLC tick:

```ts
const localSchema = batch.schemaEvents.filter(e => !e.remote);
const localData = this.filterCapturableDataEvents(
    batch.dataEvents.filter(e => !e.remote),
    localSchema,
);
if (localSchema.length === 0 && localData.length === 0) return;   // unchanged early-out
```

`filterCapturableDataEvents` drops the events of any table that is **out of basis**
(`isTableInBasis` — the oracle no longer knows its schema) and counts the skips per
table. `logSkippedTables` then emits ONE line per skipped table with its change count,
never one per row: `console.log(… — table dropped by the same transaction)` when this
same transaction dropped it, `console.warn(… — table is outside the local basis, so
sync pk identity is unresolvable)` otherwise.

The gate is basis **membership**, not "this transaction contains a drop for this table":
`drop t; create t; insert into t` in one transaction carries a drop event for `t` yet
leaves it in basis, so its rows are still captured.

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

## Behavior

**The original bug (fixed).** Against a real `Database` + `StoreModule`:

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
reports in basis, so nothing is ever skipped — no behavior change.

**Misconfiguration still fails loudly.** A pk column whose collation the wired
`keyNormalizerResolver` does not know still throws out of `recordDataEvent` and errors
the transaction — it is not quietly swallowed as a skip (see finding 1).

## Tests

In `test/sync/transaction-commit.spec.ts`:

- **`records the sibling table and the drop migration; skips only the dropped table
  rows`** — the reproduction above, real `Database` via `makePeer`.
- **`relays the surviving sibling rows and the drop migration to a peer`** — the
  `drop_table` migration is on the wire payload, then `relayAll` and `select v from b`
  → `'b2'` on the peer.
- **`drop-then-recreate in one transaction still captures the post-recreate rows`** —
  the case a naive drop-name skip would break.
- **`skip is table-scoped, not transaction-scoped: the known table still records`** —
  `FakeTransactionSource`, oracle knows `users` but not `ghost`, `ghost` FIRST. Asserts
  opSeq is `[0, 1]` (proving the skip preceded the tick) and no `error` sync state.
- **`logs one line per skipped table, counting deletes too`** *(added in review)* — two
  unknown tables in one transaction, one carrying a `delete`; asserts exactly one line
  per table with the right counts.
- **`a table dropped by the same transaction skips informationally, not as a warning`**
  *(added in review)* — covers the `console.log`-vs-`console.warn` classification.
- Shared `captureConsole` helper; the pre-existing warning-capture boilerplate was
  folded onto it.

In `test/sync/sync-manager.spec.ts` (~1902 / ~1932):

- **`should skip changes for a table whose schema the oracle does not know`** —
  exactly one skip warning naming `main.test`, no `cv:main.test…` key in the KV store.
- **`should capture every table when getTableSchema is not provided (relay-only)`**
  *(rewritten in review)* — asserts zero skips and that the `cv:` record actually lands.

## Validation

- `yarn workspace @quereus/sync run test` → **541 passing, 0 failing**
- `yarn test` (whole workspace) → all suites green, 0 failing
- `yarn build` → clean
- `yarn lint` → clean

No pre-existing failures surfaced; `tickets/.pre-existing-error.md` was not written.

## Review findings

### Fixed in this pass

1. **The skip probe swallowed the wrong exceptions (correctness / project rule).** The
   implementation probed capturability with `isPkKeyingResolvable` — a `try`/`catch`
   around the pk-keying resolver that treated **any** throw as "skip this table". The
   resolver has a second, unrelated throw path: `BUILTIN_KEY_NORMALIZER_RESOLVER`
   (`packages/quereus-store/src/common/encoding.ts:48`) throws `no such collation
   sequence: X` for a pk column with a custom collation when the host wired
   `getTableSchema` but not `keyNormalizerResolver` (both are independently optional in
   `createSyncModule`). That table's rows would then be discarded *forever*, with no
   error sync-state event and under a warning that misdescribed the cause ("table
   schema unavailable at capture time" — the schema was right there). That inverts the
   deliberate fail-loud design of the builtin resolver.
   **Fix:** gate on the existing non-throwing `isTableInBasis` (`getTableSchema(s,t)
   !== undefined`), which is exactly the unknown-table predicate the resolver's
   intended throw encodes. Collation failures now propagate to the handler's catch and
   fail the transaction loudly, as before. This also removes the swallowed exception
   the implementer flagged as cutting against the project's "don't eat exceptions"
   rule — no `catch {}` remains — and drops `isPkKeyingResolvable` entirely.
   Log wording corrected to name basis membership. Doc and doc-comments updated.

2. **A sibling test went vacuous (test coverage).** `'should not warn about missing
   table schema when getTableSchema is not provided'` asserted that the string
   `'No table schema found'` never appears — but the diff deleted the only code that
   emitted it, so the assertion became trivially true and the relay-only path lost its
   guard. Rewritten as `'should capture every table when getTableSchema is not
   provided (relay-only)'`: asserts zero skip warnings **and** that the `cv:` record
   lands. Also swapped its `setTimeout(10)` for `whenCommitsSettled()`.

3. **Two coverage gaps the implementer flagged, plus one they missed.** Added the
   multi-table-skip case (two distinct log lines, correct per-table counts) and the
   `delete`-event case (deletes take the tombstone path where a half-staged write could
   previously occur) in one test. Also added coverage for the `droppedHere`
   classification branch (informational `console.log` vs `console.warn`), which had no
   test at all — the real-`Database` tests exercised it but asserted nothing about it.

4. **`filterCapturableDataEvents` decomposed.** The log-emitting tail split into
   `logSkippedTables`; the per-table memo Map was dropped as dead weight once the probe
   stopped constructing an `Error` per call (see tripwire).

### Checked, no finding

- **opSeq / HLC contiguity.** Skip-before-tick verified by the `[0, 1]` assertion; a
  fully-skipped, schema-less transaction correctly consumes no clock and emits nothing.
- **`recordColumnVersions` fallback removal.** Correct under both the original and the
  revised gate — an oracle-wired manager cannot reach it for a table the oracle does
  not know, and the `col_${i}` path stays live for relay-only managers.
- **Read side.** `getChangesSince` over a dropped table's leftover `cv:`/`tb:` records
  does not re-resolve keying and does not throw; exercised by the real-`Database` test.
- **Docs.** `docs/sync.md` § *Write side: one tick per commit* was the only doc
  describing this path; both its pseudocode line and its prose paragraph were checked
  and corrected to the basis-membership wording plus the fail-loud carve-out. No other
  doc or README mentions capture-time schema resolution.

### Out of scope — confirmed, not re-filed

- **The peer's table does not actually disappear** on a replicated `drop_table`: the
  store module emits its drop-table schema event with no DDL, so it replicates as
  `ddl: ''` and applies as a no-op. Pre-existing and independent of this bug; already
  tracked by the in-flight ticket `sync-schema-migrations-replicate-empty-ddl`. Agreed
  it stays out of this ticket, and the peer test's narrower assertion (migration
  reaches the wire) is the right one to make today.
- **A dropped table's `cv:`/`tb:`/`cl:` records are retained forever.** Deliberate —
  retention is load-bearing for the store-and-forward relay and for detached basis
  tables. The concrete defect it enables is already filed as
  `bug-sync-recreated-table-inherits-dropped-table-metadata`. This is also why the
  first test asserts "no fact carries the value `'a2'`" rather than "no facts for `a`":
  `a`'s pre-transaction insert facts were captured while it still resolved and remain.
  That framing was re-checked and is correct.

### Tripwires parked (not tickets)

- `sync-manager-impl.ts` — `filterCapturableDataEvents`: `NOTE:` that the basis check
  is now one oracle lookup per row rather than per table; memoize per transaction only
  if `getTableSchema` ever stops being a cheap map hit.
- `sync-manager-impl.ts` — `logSkippedTables`: `NOTE:` that this is the package's only
  `console.log` (everything else is `warn`/`error`), and is the call site that would
  want an `info` level if the package ever grows a real logger abstraction.

### Not filed

No new fix/plan/backlog tickets. The one substantive defect found (finding 1) was a
few lines and is fixed here; everything else was test or doc work, or already tracked.

### Noted, no action

`sync-manager-impl.ts` is ~1470 lines — large for one file. Pre-existing; this diff
added ~65 net lines of a cohesive concern and split it into two small methods rather
than growing an existing one. Not worth a speculative split ticket without a concrete
seam.

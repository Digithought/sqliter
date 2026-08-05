description: When a table is stored directly through the key-value storage adapter without the isolation wrapper, asking for a table's "committed" pre-transaction view inside a transaction wrongly returns the rows that transaction has written but not yet saved.
prereq:
files: packages/quereus-store/src/common/store-module.ts, packages/quereus-store/src/common/store-table-scan.ts, packages/quereus/src/runtime/emit/scan.ts
difficulty: medium
repro: static
severity: wrong-result
likelihood: unusual
tradeoffs: Only reachable on a raw store table without the isolation wrapper, and the same shared-connect caching is the first blocker listed in feat-store-committed-snapshot-reads - so a maintainer may prefer to fix both there rather than patch connect twice.
----

# `committed.<table>` on a raw store table returns uncommitted rows

## What the qualifier promises

`committed.<table>` is documented (`docs/architecture.md` ~line 141) as
"read-only access to the pre-transaction (committed) state of any table … pinned
to the transaction-start snapshot". It is the mechanism transition constraints
use to compare current against pre-transaction state, e.g.

```sql
create assertion no_decrease check (
  not exists (select 1 from t join committed.t ct on t.id = ct.id where t.val < ct.val)
);
```

The planner stamps the reference and `runtime/emit/scan.ts` (~line 105) passes
`_readCommitted: true` into the module's `connect`.

## Why a raw store table does not honour it

Two things, both in `packages/quereus-store/src/common/`:

- `StoreModule.connect` (~line 365) returns a **shared cached** `StoreTable` per
  table key (`this.tables.get(tableKey)`, ~line 378) and never reads
  `_readCommitted` at all — the option is silently dropped.
- `StoreTable`'s scan merges the table coordinator's pending ops over the
  committed store whenever a transaction is open (read-your-own-writes — see the
  `getCapabilities` doc comment ~line 124 and `store-table-scan.ts` ~line 59).
  There is no committed-only branch.

So inside a transaction, a `committed.<table>` reference on a raw store table
returns the transaction's own uncommitted rows — the exact opposite of what the
qualifier means. The comparison in the assertion above compares a row against
itself, and a transition constraint that should fire silently passes.

## Scope: raw `StoreModule` only

The four platform plugins (leveldb, indexeddb, nativescript-sqlite,
react-native-leveldb) wrap `StoreModule` behind `IsolationModule`, whose
`connect` does read the flag and whose `IsolatedTable` bypasses the overlay —
and under isolation the underlying store holds only committed rows during a
transaction, because the overlay is what stages the writes. Those configurations
are correct today.

The exposure is a `StoreModule` registered directly, which is a documented
supported usage (its own doc comment describes the unwrapped mode and only
*recommends* the isolation wrapper).

## Repro status

`static` — read from the code, not executed. What would confirm it: register a
bare `StoreModule` over the in-memory KV provider, `begin`, `insert` a row,
then `select` from both `t` and `committed.t` inside the transaction. Expected:
`committed.t` omits the new row. Suspected actual: it includes it.

## Fix directions (not yet decided)

Either honour the flag — `StoreModule.connect` returns a committed-only
`StoreTable` view when `_readCommitted` is set, which needs a scan path that
skips the coordinator's pending-op merge, and cannot use the shared cached
instance as-is — or reject it: throw at `connect` when `_readCommitted` is set,
so a `committed.<table>` reference against a raw store table fails loudly
instead of answering wrongly. The second is small and honest; the first is what
a user of transition constraints on raw store tables actually wants.

Related but distinct: `backlog/feat-store-committed-snapshot-reads` covers
making the store stack serve a *concurrent* committed snapshot. That is a
stronger guarantee than this ticket needs — fixing this one does not deliver it.

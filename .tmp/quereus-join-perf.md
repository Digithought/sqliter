# Quereus feedback: equi-join ignores the secondary index on the join key (super-linear joins)

**Stack:** `@quereus/quereus` **4.4.1** + `@quereus/plugin-indexeddb` 4.4.1 (store vtable module), browser
(SvelteKit/Vite, headless Chromium). Single standalone `Database` (no Optimystic), `pragma
default_vtab_module='store'`. All numbers below are freshly measured on the **4.4.1 baseline**.

**TL;DR:** A two-table equi-join on an indexed foreign key runs as a **super-linear nested loop that does
not use the secondary index on the join key** — even though that exact index answers a direct
`WHERE join_key = ?` in a **flat ~1.2 ms regardless of table size**. Joins become unusable past a few
thousand rows (a 4-way report join takes ~1.9 s at 2 k entries and **does not complete within 8 minutes at
10 k entries**). Issuing the same work as single-table reads joined in application (JS) code is ~20× faster
and scales roughly linearly, so we ship that workaround — but the join planner looks like a real gap.

> History: this was first filed against 4.3.2. **4.4.0** cut the join's constant factor ~15–20× (very
> welcome), and **4.4.1** added a general ~10–20% throughput gain — but neither changed the *shape*: the
> join is still super-linear and still ignores the join-key index. This report re-states the problem cleanly
> from the current 4.4.1 baseline.

---

## Schema (relevant part)

```sql
create table txn (
  id text primary key,
  entity_id text,
  date text,
  ...
);
create table account_group ( id text primary key, account_type text, ... );
create table account (
  id text primary key,
  entity_id text,
  account_group_id text not null,   -- FK → account_group(id)
  ...
);
create table entry (
  id text primary key,
  txn_id text,        -- FK → txn(id)
  account_id text,    -- FK → account(id)
  amount integer,
  ...
);
-- Secondary indexes (FKs are not auto-indexed; PK is):
create index idx_txn_entity_date  on txn(entity_id, date);
create index idx_entry_txn        on entry(txn_id);
create index idx_entry_account    on entry(account_id);
create index idx_account_entity   on account(entity_id);
```

Data: one entity with **N** transactions and **2N** entries (2 entries per txn).

---

## Measurements (4.4.1, same DB, warm; freshly-seeded entity per size)

Two representative report joins vs. the single-table queries that should be their building blocks:

| query | N=100 (201 entries) | N=1000 (2001 entries) | growth for 10× data |
|---|---|---|---|
| **JOIN 4-way** `entry ⋈ txn ⋈ account ⋈ account_group`, `WHERE a.entity_id=? AND t.date<=?` GROUP BY type | **87 ms** | **1,924 ms** | **22×**  (≈ O(n¹·³⁵)) |
| **JOIN 2-way** `entry ⋈ txn` `WHERE e.account_id=?` ORDER BY date | **36 ms** | **1,679 ms** | **47×**  (≈ O(n¹·⁷)) |
| control: `SELECT … FROM entry WHERE txn_id=?` (~2 rows) | **1.30 ms** | **1.20 ms** | **flat (O(1) seek)** |
| control: `SELECT … FROM entry WHERE account_id=?` | 2.5 ms (55 rows) | 15.3 ms (526 rows) | linear in rows |
| control: `SELECT … FROM txn WHERE entity_id=? AND date<=?` | 3.8 ms (100 rows) | 27.7 ms (1000 rows) | linear in rows |
| control: `SELECT COUNT(*) FROM entry` (full scan) | 6.1 ms | 59.5 ms | linear (~0.03 ms/row) |

At **N=5000 (10 k entries)** the 4-way join **did not complete within an 8-minute cap**, while the same
report computed with single-table reads + a JS-side join returns in **~1.0 s**.

---

## The smoking gun

`SELECT … FROM entry WHERE txn_id = ?` is **flat at ~1.2 ms whether the table holds 200 or 2 000 rows** —
i.e. `idx_entry_txn` gives an O(1) seek on exactly the column the join predicate needs (`t.id = e.txn_id`).
Yet the join grows **22–47× for 10× the data**. So:

- The seekable index **exists and is used for a direct equality predicate** (the plugin advertises the
  seekable constraint), but the **planner does not use it to satisfy the join** — it runs a nested loop
  whose inner side is an un-indexed scan (for each `txn`, effectively re-scan `entry`), which is why doubling
  N more than doubles the time.
- Every single-table read (seek, range, or full scan) is **flat or linear** — the store itself is fine. The
  cost is entirely the join strategy.

Driving the join from either side, or as a 3-/4-way, gives the same super-linear behavior.

**What we'd hope the optimizer did:** an index-nested-loop (outer = `txn` via `idx_txn_entity_date`, inner =
seek `entry` via `idx_entry_txn`) **or** a hash join building on the smaller side. Both are linear-ish; the
current plan is quadratic-ish.

---

## Workaround we ship (for contrast)

Replacing each join with single-table indexed reads joined/aggregated in JS:

| report | in-engine JOIN (4.4.1) | single-table reads + JS join (4.4.1) | ratio |
|---|---|---|---|
| balance sheet @ 2 k entries | 1,924 ms | ~96 ms | ~20× |
| ledger (one account) @ 2 k entries | 1,679 ms | ~80 ms | ~21× |

The JS version is linear-ish and completes at 10 k entries in ~1 s, so this is not blocking us — but it
means we cannot express reporting as SQL joins, which is the natural form.

---

## Secondary notes

- **No query-plan visibility.** We could find no `EXPLAIN` / `EXPLAIN QUERY PLAN`, so diagnosing this meant
  bisecting query shapes and timing them. A dump of the chosen join strategy and which vtable
  constraints/indexes were pushed down (the `xBestIndex`-style negotiation) would turn this from guesswork
  into a one-liner.
- **Per-row store overhead (context, likely not an optimizer bug).** Even with joins avoided, single-table
  access carries a fixed ~0.03–0.1 ms/row read and ~2 ms/row write on the IndexedDB store (10 k-entry
  restore ≈ 22.8 s; 10 k-entry balance sheet ≈ 1 s). This is the ceiling once joins are worked around; a
  bulk/cursor read path that materializes many rows per IndexedDB transaction would raise it.

---

## Minimal repro

1. Create the tables + indexes above on the store vtable.
2. Seed one entity with N = 100 and N = 1000 txns (2 entries/txn, batched inserts).
3. Time the 4-way join vs. the `WHERE txn_id = ?` control. The control is flat ~1.2 ms at both sizes; the
   join grows ~22× for the 10× data increase, and does not complete at N = 5000.

(Driven from a browser page booting the same `@quereus/plugin-indexeddb` stack; happy to share the exact
harness.)

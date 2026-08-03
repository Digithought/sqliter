# Quereus 4.6.0 — CORRECTNESS regression: GROUP BY over a 4+ table join with a WHERE clause returns one bogus row

**Severity:** high (silent wrong results, no error raised).
**Stack:** `@quereus/quereus` **4.6.0** + `@quereus/plugin-indexeddb` 4.6.0 (store vtable module), browser,
single standalone `Database`, `pragma default_vtab_module='store'`. **Regression vs 4.5.0** (which returned
correct results for the same query).

## TL;DR

On 4.6.0, a `SELECT groupcol, <aggregate> FROM t1 JOIN t2 JOIN t3 JOIN t4 WHERE … GROUP BY groupcol` over a
**4-table join** silently returns a **single wrong row** — the grouping key comes back as the integer `1`
and the aggregate as `NULL`, with every input row folded into that one group — instead of the correct
per-group rows. No error is raised.

It is triggered by the **combination** of (a) a join of **4+ tables** and (b) a **`WHERE` clause**:

| query shape (same data, books-1000 / 2001 entries) | 4.6.0 result |
|---|---|
| 1 table + `WHERE` + `GROUP BY` | ✅ correct (6 groups) |
| 2-table join + `WHERE` + `GROUP BY` | ✅ correct (6 groups) |
| 3-table join + `WHERE` + `GROUP BY` (grouped on a joined column) | ✅ correct (5 groups) |
| **4-table join + `WHERE` + `GROUP BY`** | ❌ **1 row: `{group: 1, sum: null}`** |
| 4-table join, **no `WHERE`** + `GROUP BY` | ✅ correct (5 groups) |

- Removing the `WHERE` makes the 4-table join correct again.
- A **literal** `WHERE a.entity_id = '…'` breaks it exactly as a **bound parameter** `WHERE a.entity_id = ?`
  does — so it is not a parameter-binding issue.
- Deterministic (repeated runs identical). Returned **correct** results on 4.5.0 for the same query.

## Minimal repro

Schema (store vtable):
```sql
create table txn        (id text primary key, entity_id text, date text);
create table account_group (id text primary key, account_type text);
create table account    (id text primary key, entity_id text, account_group_id text);
create table entry      (id text primary key, txn_id text, account_id text, amount integer);
```
Seed one entity with a few account groups of different `account_type`, some accounts, and a few thousand
entries.

**Broken (4-table join + WHERE + GROUP BY):**
```sql
SELECT ag.account_type AS type, SUM(e.amount) AS tot
FROM entry e
JOIN txn t            ON t.id  = e.txn_id
JOIN account a        ON a.id  = e.account_id
JOIN account_group ag ON ag.id = a.account_group_id
WHERE a.entity_id = ?           -- literal or bound param, same result
GROUP BY ag.account_type;
-- 4.6.0 → [{ type: 1, tot: null }]           (WRONG: 1 group, key is the integer 1, sum is null)
-- 4.5.0 → [{type:'EXPENSE',tot:…}, {type:'ASSET',tot:…}, … 5 rows]   (correct)
```

**Correct on 4.6.0 (drop the WHERE, otherwise identical):**
```sql
SELECT ag.account_type AS type, SUM(e.amount) AS tot
FROM entry e
JOIN txn t            ON t.id  = e.txn_id
JOIN account a        ON a.id  = e.account_id
JOIN account_group ag ON ag.id = a.account_group_id
GROUP BY ag.account_type;
-- 4.6.0 → 5 correct rows
```

**Also correct on 4.6.0 (same WHERE, one fewer joined table — drop `txn`):**
```sql
SELECT ag.account_type AS type, SUM(e.amount) AS tot
FROM entry e
JOIN account a        ON a.id  = e.account_id
JOIN account_group ag ON ag.id = a.account_group_id
WHERE a.entity_id = ?
GROUP BY ag.account_type;
-- 4.6.0 → 5 correct rows
```

## Observations that may help localize it

- The grouping key in the broken result is the **integer `1`**, not a value from `ag.account_type` — as if
  the GROUP BY expression were replaced by a constant (and the aggregate then evaluated over the single
  resulting group as `NULL`).
- The **same 4-table join without GROUP BY** returns the correct full result set (`COUNT(*) = 2001`,
  `SUM = 0`), so the join itself is fine; the fault is in the **GROUP BY / aggregate planning when a WHERE
  is present on a 4-table join**.
- Threshold is between **3 and 4 joined tables**; 3-table + WHERE + GROUP BY is correct.
- Grouping on a **base-table** column (e.g. `GROUP BY e.account_id`) in a 3-table join + WHERE is correct;
  we did not find a passing 4-table variant.

## Context (why we noticed, and impact)

We hit this while re-evaluating 4.6.0 with a perf harness that also runs an in-engine "balance sheet" join
(`entry ⋈ txn ⋈ account ⋈ account_group`, `WHERE entity_id = ?`, `GROUP BY account_type`) — exactly the
broken shape. Our shipped app is **unaffected** because it reads single tables and groups in application
code (a workaround originally adopted for the earlier super-linear-join issue), so it never issues
GROUP-BY-over-a-multi-join. But this is precisely the query we would write if we moved reporting back to
SQL joins (which 4.5.0's join fix had made attractive) — so for us it blocks that migration, and more
generally any grouped multi-table report on 4.6.0 will **silently return wrong totals**.

## Ask

This looks like a planner bug in GROUP-BY/aggregate handling once a WHERE is present on a ≥4-table join
(grouping expression collapsing to a constant). An `EXPLAIN` / plan dump would let us confirm where the
grouping key is lost. Happy to share the exact browser harness and a seed fixture.

---

### Appendix: performance side-note (4.4.1 → 4.5.0 → 4.6.0, quereus-local, same machine)

Separate from the bug above, tracking the earlier join/read perf story:
- **Join planner** (fixed in 4.5.0) still executes well in 4.6.0 for *correct* shapes (e.g. the 2-table
  `entry ⋈ txn` ledger join: ~44 ms @2k, ~0.8 s @10k entries — linear).
- **4.5.0's broad single-table read + write regression is mostly reclaimed in 4.6.0**: bulk restore back to
  ~4.4.1 levels (2.9 s @2k vs 4.5.0's 3.9 s), and simple reads (ledger, cross-entity list, account balance)
  back to ~1.1× of 4.4.1 (were ~1.6–1.9× on 4.5.0).
- **Still regressed vs 4.4.1:** our JS-join balance sheet / income statement are ~2.4–3.7× (down from 4.5.0's
  3–6×, but not yet at parity): balance sheet 96 ms → 356 ms @2k, 1.02 s → 2.62 s @10k entries.

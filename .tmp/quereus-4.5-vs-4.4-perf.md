# Quereus 4.5.0 vs 4.4.1: JOIN planner fixed (thank you!), but single-table reads + writes regressed ~1.6–1.9×

**Stack:** `@quereus/quereus` + `@quereus/plugin-indexeddb` (store vtable module), browser
(SvelteKit/Vite, headless Chromium), single standalone `Database`, `pragma default_vtab_module='store'`.
Comparison is **4.4.1 → 4.5.0**, same machine, same fixtures, median of warm runs.

## TL;DR

- ✅ **The super-linear equi-join is fixed.** The multi-table report join that was ~O(n¹·⁴⁻¹·⁷) and
  **did not complete in 8 minutes at 10 k entries** on 4.4.1 is now **linear and fast** on 4.5.0 (2 k-entry
  4-way join **1,924 ms → 288 ms**; 10 k-entry join now **~1.4 s**). This resolves the earlier filed issue —
  in-engine joins are now *faster* than the single-table-reads-joined-in-JS workaround we ship. 🎉
- ⚠️ **But every single-table read got ~1.6–1.9× slower**, including a 2-row point seek, and bulk writes
  ~1.5×. Because our reporting code had been rewritten to *avoid* joins (single-table reads + JS join, per
  the old advice), 4.5.0 is a **net regression for our workload** despite the join fix — our balance-sheet
  path went **96 ms → 607 ms** at 2 k entries.
- ⚠️ **A cold-start "backend not initialized" appeared** — a query issued immediately after page load now
  races an unfinished init (init is slower in 4.5.0). Likely partly our side, but 4.5.0's slower init is the
  trigger.

---

## 1. Improvement: the equi-join is fixed and now scales linearly

Micro-benchmark, freshly-seeded entity (N txns, 2N entries), median wall-clock:

| query | 4.4.1 (201 / 2,001 entries) | 4.5.0 (201 / 2,001 entries) | Δ @2,001 |
|---|---|---|---|
| **JOIN 4-way** `entry ⋈ txn ⋈ account ⋈ account_group`, `WHERE entity_id=? AND date<=?` GROUP BY type | 87 ms / **1,924 ms** | 63 ms / **288 ms** | **0.15× (6.7× faster)** |
| **JOIN 2-way** `entry ⋈ txn`, `WHERE account_id=?` ORDER BY date | 36 ms / **1,679 ms** | 17 ms / **134 ms** | **0.08× (12.5× faster)** |

- **Scaling** (from the app harness, same query at 10 k entries): 4.4.1 **did not complete within 8 min**;
  4.5.0 returns in **~1.39 s**. Across 201 → 2 k → 10 k entries the 4.5.0 join is ~linear
  (63 ms → 288 ms → ~1.4 s), versus 4.4.1's super-linear blow-up. The planner now clearly uses the join-key
  index (index-nested-loop / hash join). This is exactly the fix we hoped for — thank you.

---

## 2. Regression: single-table read/write path ~1.6–1.9× slower

The same micro-benchmark's control queries (single-table seeks, ranges, scans) all regressed uniformly:

| control query | 4.4.1 (201 / 2,001 entries) | 4.5.0 (201 / 2,001 entries) | Δ @2,001 |
|---|---|---|---|
| `entry WHERE txn_id=?` (~2 rows — index point seek) | 1.30 / **1.20 ms** | 2.00 / **2.30 ms** | **1.9× slower** |
| `entry WHERE account_id=?` (55 / 526 rows) | 2.5 / **15.3 ms** | 4.3 / **25.1 ms** | **1.6× slower** |
| `txn WHERE entity_id=? AND date<=?` (100 / 1000 rows) | 3.8 / **27.7 ms** | 7.1 / **49.1 ms** | **1.8× slower** |
| `SELECT COUNT(*) FROM entry` (full scan) | 6.1 / **59.5 ms** | 11.2 / **97.0 ms** | **1.6× slower** |

**Reading:** the regression is uniform and independent of result size — a **2-row point seek nearly doubled**
(1.2 → 2.3 ms), a 526-row indexed read rose 1.6×, and a 10 k-row full scan rose 1.6×. That points to a
**per-statement / per-row overhead increase in the store read path**, not a planner change (the planner got
better). It looks like the join rewrite may have added fixed cost to the base read execution path.

### App-level impact (our DataService over the store)

| op | 4.4.1 @1 k txns | 4.5.0 @1 k | 4.4.1 @5 k txns | 4.5.0 @5 k |
|---|---|---|---|---|
| balance sheet (single-table reads + JS join) | **96 ms** | **607 ms (6.3×)** | **1.02 s** | **3.56 s (3.5×)** |
| income statement | ~90 ms | 518 ms (5.8×) | ~1.1 s | 3.54 s |
| ledger / cross-entity list / search / account-balance | — | **~1.5–1.9×** | — | ~1.5× |
| bulk restore (batched multi-row INSERT) | 2.5 s | **3.94 s (1.6×)** | 22.8 s | **34.3 s (1.5×)** |

The simple ops track the ~1.5–1.9× primitive regression. The **balance sheet / income statement regress more
(3–6×)** because they materialize full single-table result sets (`SELECT *` over the entity's entries + txns)
and join in JS — the row-materialization path seems penalized beyond the `COUNT(*)`/seek primitives.

**Net for a codebase that avoids joins (as the prior join issue forced):** 4.5.0 is slower than 4.4.1. Even
switching our reporting back to in-engine joins (now the fast path at 288 ms/2 k) is ~2.8× our 4.4.1 JS-join
(96 ms/2 k) — the base-read regression outweighs the join win at current data sizes, though 4.5.0's linear
joins should win at larger scale.

---

## 3. Cold-start "backend not initialized"

On 4.5.0, a query issued immediately after page load intermittently throws `Quereus backend not
initialized` (our singleton returns before `initialize()` resolves). This did not reproduce on 4.4.1 with
the same code and timing — 4.5.0's **slower init** widens the race. Probably fixable on our side (await a
readiness probe), but flagging that init latency increased noticeably.

---

## Environment / method

- Fixtures: one entity with 100 / 1,000 / 5,000 txns (2 entries each → 201 / 2,001 / 10,001 entries),
  restored via batched multi-row `INSERT`.
- Schema (relevant): `entry(id pk, txn_id, account_id, amount)`, `txn(id pk, entity_id, date)`,
  `account(id pk, entity_id, account_group_id)`, `account_group(id pk, account_type)`; indexes
  `idx_entry_txn(txn_id)`, `idx_entry_account(account_id)`, `idx_txn_entity_date(entity_id,date)`,
  `idx_account_entity(entity_id)`.
- Each query timed single-shot (joins) or median-of-many (fast controls); warm DB; same machine back-to-back
  on 4.4.1 then 4.5.0. Numbers are wall-clock and machine-relative — the **ratios** are the signal.

## Ask

The join fix is excellent and unblocks expressing reporting as SQL again. The open question is the
**~1.6–1.9× base single-table read regression** (and the larger hit to `SELECT *` materialization): is that a
known/expected cost of the 4.5.0 execution changes, and is some of it reclaimable? An `EXPLAIN` /
plan-and-cost dump would also help us tell index-nested-loop vs hash vs scan apart going forward.

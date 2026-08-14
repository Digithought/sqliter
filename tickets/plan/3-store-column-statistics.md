----
description: Track how many distinct values each indexed column holds so the query planner can estimate how many rows a lookup will actually match, replacing fixed guesses that stop discriminating between queries.
prereq: store-backend-cost-profile
files:
  - packages/quereus-store/src/common/store-module-access-plan.ts (ARM_SELECTIVITY, the multi-seek multiRows clamp, the seek-vs-scan comparison)
  - packages/quereus-store/src/common/store-table-stats.ts / the __stats__ store plumbing (row counts live there today; distinct counts join them)
  - packages/quereus/src/planner/rules/access/rule-key-set-seek.ts (cost-probe consumer)
  - packages/quereus/src/planner/stats/ (engine-side statistics surface — decide whether the module feeds it or stays self-contained)
----

# Problem

The store estimates selectivity with fixed fractions of table size: an indexed equality is
assumed to match 10% of the table, a range 30%. With no per-column information, every cost
decision is per-*arm* rather than per-*query* — a unique-ish column and a two-valued flag
column price identically. This is the root blocker called out (as an accepted limitation) in
the comments at `ARM_SELECTIVITY` and at the `vetoCost` clamp, and it is what stops the
backend cost profile (`store-backend-cost-profile`, the prereq) from being able to
discriminate seek-vs-scan honestly instead of enabling/disabling whole arms.

## Folded in: the multi-seek row estimate is a clamp, not an estimate

(This section absorbs and replaces `backlog/debt-store-multi-seek-union-row-estimate` — same
site, same fix.)

For `where col in (v1 … vK)` the store multiplies: K seeks × 10% each, capped at the table.
The cap is reached at K = 10 for any table size — from there the answer is a constant
"returns every row" whatever the list matches. Because charging a per-row resolution cost
against that clamp prices the artifact rather than the work, the multi-seek arm was
deliberately exempted from both the per-row charge and the seek-vs-scan comparison (measured:
without the exemption, 16 failing tests in `key-set-seek-store.spec.ts`, and the engine's
key-set rewrite would cap at ~710 keys on a table of any size). Real estimates should let both
exemptions come back out, with the arithmetic in the comments at those sites re-checked.

# Spec (for the plan pass to settle into implement tickets)

- Per-column **distinct-value counts** for indexed columns (including PK columns' leading
  prefixes if cheap), stored alongside the row counts already kept in the `__stats__` store.
- Estimation: equality on a column with D distinct values ≈ N/D rows; an IN of K values ≈
  K × N/D, naturally staying below N until K approaches D. A single equality and one member of
  a list must agree (today an equality is priced 10× one list member).
- The access-plan request path must *carry* the stats to `computeBestAccessPlan` — today it
  carries table size and predicates only, so an analyzed table plans identically to an
  un-analyzed one.
- Un-exempt the multi-seek arm: restore the per-row resolution charge and the seek-vs-scan
  comparison for it, and re-verify `rule-key-set-seek`'s 2-and-1000-key probe interpolation
  still lands sensible break-evens (cost stays linear in K under N/D estimation — confirm).
- Absent stats (fresh table, pre-existing database) ⇒ fall back to today's fractions; behavior
  must degrade to current, not to nonsense.
- **Remove the parity-priced veto that `store-backend-cost-profile` leaves behind.** That
  ticket lets a backend declare its point-read cost but deliberately keeps the seek-vs-scan
  comparison priced at the parity default (`IndexPlanCandidate.vetoCost` in
  `store-module-access-plan.ts`), because with `ARM_SELECTIVITY` a fixed fraction a
  declared cost decides an arm's availability for EVERY query rather than per query — and
  IndexedDB's measured value (2.8–3.4) straddles the range arm's 2.83 flip point exactly.
  Once selectivity is estimated per predicate, the veto should price with the declared
  profile and `vetoCost` should go away. Expected effect on IndexedDB: a range seek at a
  measured 30%-of-table selectivity loses to a scan (which the benchmark confirms), while a
  selective one keeps seeking.

# Open questions the plan pass must resolve (not the implementer)

- **Maintenance strategy.** Exact distinct counts are easy to increment and hard to decrement
  (removing a value requires knowing whether another row still holds it — the secondary index
  itself can answer that with one bounded probe, since entries are grouped by value). Weigh:
  exact-via-index-probe on delete/update, versus a probabilistic sketch, versus periodic
  recount (the store already sweeps stats on some paths). Pick one; document the error model.
- **Scope of consumers.** Module-local first (fix the store's own arm pricing), or also feed
  the engine's `planner/stats/` surface so join ordering and the key-set rewrite see the same
  numbers? Module-local is the smaller, safer first ticket; say explicitly what is deferred.
- **Skew.** N/D assumes uniformity; a two-valued column that is 99/1 will still misprice. A
  distinct count is strictly better than a fixed fraction, but note where skew shows up
  (`bug-store-pk-range-preempts-cheaper-index` interplay) and leave histograms as a named
  non-goal rather than silently pretending N/D is exact.

# Key tests to expect in later phases

- IN-list estimates grow with K and match K× the single-equality estimate on the same column.
- Seek-vs-scan flips with actual column cardinality: unique-ish column seeks, two-valued
  column scans — same schema, different data.
- Stats survive reopen (they persist in `__stats__`) and dropping an index drops its counts.
- `key-set-seek-store.spec.ts` green with the exemptions removed.

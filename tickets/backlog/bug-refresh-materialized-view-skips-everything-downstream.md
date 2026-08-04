---
description: Rebuilding a stored view's contents by hand does not tell anything downstream about it, so views built on top of it keep serving old data and integrity rules never get a chance to object.
files:
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts   # rebuildBacking (~1537) — discards the change list applyMaintenance returns
  - packages/quereus/src/runtime/emit/materialized-view.ts           # refreshMaintainedTable (~164) — the refresh core, never cascades
  - packages/quereus/src/core/database-materialized-views.ts         # postApplyBackingChanges / recordMaintenanceChanges — the path a refresh does NOT take
  - docs/incremental-maintenance.md                                  # § Recording changes — the carve-out this would remove
  - docs/mv-maintenance.md
repro: static
---

# What is wrong

A **materialized view** is a query whose answer the engine stores in a real table and keeps
up to date automatically as the underlying data changes. Users can also rebuild one by hand
with `refresh materialized view <name>` — normally after something drifted.

Everywhere *else* in the engine, a write to a materialized view's stored contents is
announced: consumers built on top of that view are updated, watchers are notified, and
integrity rules (`create assertion`) get a chance to reject the transaction. The hand-driven
refresh is the one path that stays silent. It recomputes the contents, swaps them in, and
throws away the list of rows that actually changed.

Two things break as a result. They are two symptoms of one omission, at one place in the
code, and should be fixed together.

## Arm 1 — a view built on another view keeps serving stale data

Materialized views can be chained: `mv2` can be defined over `mv1`, which is defined over a
plain table. Ordinary writes propagate all the way down the chain.

`refresh materialized view mv1` does not. `mv1`'s contents are replaced, and `mv2` is never
told, so `mv2` keeps whatever it had. Nothing marks `mv2` as suspect, so there is no
warning; a later read just returns the older answer. It stays wrong until something else
happens to touch `mv2`.

Note the contrast with the sibling code path: `alter table … set maintained as …`
(`attachMaintainedDerivation`) does exactly the right thing here — it takes the change list
back from the write and pushes it down to consumers, with a comment explaining why. The
refresh path was simply never given the same treatment.

## Arm 2 — integrity rules cannot see a refresh

An assertion is a rule that must hold when a transaction commits, e.g. "no row in this view
may have a negative amount". The engine decides which rules to check by looking at which
tables the transaction changed. Because a refresh records no change, a refresh that pulls in
rule-violating content commits cleanly and the rule never runs. The same rule *is* enforced
for every ordinary write to the same view.

This carve-out is currently written down as a known limitation in
`docs/incremental-maintenance.md` § Recording changes and in a comment in the assertions
test file. Fixing this ticket should delete both.

# How this was found

Read, not run. `rebuildBacking` calls the storage layer's `applyMaintenance` (which returns
the list of rows it actually changed) and drops the return value on the floor; on its faster
branch it calls `replaceContents`, which reports nothing at all. `refreshMaintainedTable`,
the function wrapping it, never calls the "a row in this table changed" entry point that
every other write path goes through.

**To confirm it directly**, a test needs a refresh whose recomputed contents genuinely
*differ* from what the view currently holds — a refresh that reproduces identical contents
correctly produces no changes and so looks fine. The natural setup is a view that has been
allowed to drift out of date (the engine marks a view "stale" when a schema change under it
invalidates its query), then refreshed, then read through a chained consumer.

# Expected behaviour

- After `refresh materialized view mv1`, any materialized view defined over `mv1` reflects
  `mv1`'s new contents in the same statement.
- After a refresh that introduces content violating an assertion over the refreshed view (or
  over anything downstream of it), the commit fails with that assertion's error, exactly as
  an ordinary write would.
- A refresh that reproduces identical contents stays a no-op — no downstream work, no
  notifications, no cost.

# Worth deciding while designing

A refresh is a whole-table swap, so the change list can be as large as the table. Every
downstream effect is therefore proportional to the refreshed view's size, in one
transaction. Whether that is acceptable as-is, or whether a refresh should announce itself
once at table granularity rather than row by row, is the main open question — the row-level
path already has an escape hatch noted at
`packages/quereus/src/core/database-materialized-views.ts` (the `NOTE:` above
`recordMaintenanceChanges`) for the same concern on a different path.

There is also a transactional wrinkle to check rather than assume: the fast refresh branch
swaps *committed* contents immediately (`begin; refresh; rollback` does not undo it today),
while change records live in the transaction's own layer and are discarded on rollback. The
two need to agree about what a rolled-back refresh means.

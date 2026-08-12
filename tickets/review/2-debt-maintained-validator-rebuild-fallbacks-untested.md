description: Added unit tests for two recovery behaviors of maintained-table constraint validators (degrade-to-poisoned-validator, self-heal) that SQL can no longer trigger now that the relevant DROP TABLE is refused, plus one doc sentence explaining why.
files:
  - packages/quereus/test/maintained-table-declared-constraints.spec.ts   # new tests, ~line 296 onward
  - docs/mv-constraints.md                                                # line 27 area — added reachability sentence
difficulty: easy
---

# What was done

`packages/quereus/test/maintained-table-declared-constraints.spec.ts`, inside
`constraint-dependency DDL invalidation`:

- New describe **`subquery-CHECK target dropped out of band (poisoned validator)`**,
  placed right after `subquery-CHECK target drop`. Uses the same `quota`/`qsrc`/`mq`
  fixture, but drives the drop via `db.schemaManager.dropTable('main', 'quota')`
  directly instead of `drop table quota` (SQL refuses that drop; the internal drop
  paths — transaction rollback, catalog import on store reopen — bypass the emitter
  the same way). Four tests:
  - baseline: a healthy subquery-CHECK auto-defers (1 `_queueDeferredConstraintRow`
    call per written image);
  - the out-of-band drop resolves `true` without throwing, and an unrelated statement
    afterwards still succeeds (the schema-change listener swallowed the rebuild
    failure);
  - a **conforming** source write (`n=5 <= 100`) is rejected by the poisoned validator
    with the sited `Table 'quota' not found in schema path: main` error — not the
    stale-validator `connect failed` internal error — and enqueues **zero** deferred
    checks (it throws inline, before reaching the deferred queue) — that's the
    discriminator that proves the *poisoned* validator fired, not just some unrelated
    failure; `qsrc`/`mq` are left unchanged;
  - a `delete` after poisoning still succeeds (no row image → no CHECK evaluated —
    pins the poison's blast radius).

- Restored the CHECK-target arm inside **`self-heal on dependency re-create`**
  (previously FK-parent-only, with a comment explaining the CHECK arm was
  unreachable from SQL). New test drops `quota` the same out-of-band way, re-creates
  it, and asserts: a conforming write flows into `mq` again and auto-defers (1
  enqueue — proves the validator, not just some ad-hoc fallback, healed); a violating
  write is rejected with the `main.mq` attribution. Replaced the stale comment
  explaining the old absence with one explaining the out-of-band technique.

`docs/mv-constraints.md` line 27: appended a sentence noting the SQL-level `drop
table` refusal, and that this arm's coverage is therefore unit-level via
`SchemaManager.dropTable`, not `.sqllogic`.

# Validation

- `packages/quereus/test/maintained-table-declared-constraints.spec.ts` alone: 24
  passing (was 19 before this ticket; +5 new tests — 4 in the poisoned-validator
  describe, 1 restored in self-heal).
- `yarn workspace @quereus/quereus run lint` (eslint + test-file `tsc` pass): clean.
- `yarn test` from repo root (all workspaces): all green, no failures. `packages/quereus`
  reports 9513 passing.

# For the reviewer

- The two new/restored behaviors are exercised by calling `db.schemaManager.dropTable`
  directly rather than through SQL — this is deliberate and matches established
  practice (`test/schema-manager.spec.ts` already drives the manager directly) and is
  called out in a comment at each new describe block, specifically to stop a future
  reader from "fixing" the test back to `drop table` and silently losing the coverage
  again (that was the whole reason this ticket existed).
- The "zero deferred enqueues" assertion is the load-bearing discriminator between
  "poisoned validator fired" and "some other failure happened to reject the write" —
  a conforming value (5 ≤ 100) plus a specific error-message substring plus a
  zero-enqueue count together pin the exact code path
  (`rebuildConstraintValidatorsFor`'s catch → `makePoisonedDerivedRowValidator`).
  Worth double-checking that reasoning holds if you touch the validator internals.
- Did not touch `test/logic/51.8-maintained-table-declared-constraints.sqllogic` —
  ticket scoped this to the two unreachable-from-SQL arms only.
- No known gaps beyond what's in scope. Did not add a test for the FK-parent arm's
  analogous "out of band" drive since that arm is already fully reachable from SQL
  (covered by the pre-existing `FK parent drop` describe) — only the CHECK-target arm
  lost SQL reachability.

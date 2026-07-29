---
description: When an update changes the value of a row's primary key, the three storage backends disagree about which key the resulting change notification carries — the old one or the new one — so a listener or a synced device can file the updated row under an identity that no longer exists.
prereq:
files:
  - packages/quereus/src/runtime/emit/dml-executor.ts              # ~line 1062 — auto-event path takes the key from the OLD row
  - packages/quereus-store/src/common/store-table.ts               # ~line 505 — store takes it from the NEW row
  - packages/quereus/src/vtab/memory/layer/manager.ts              # ~line 620 — memory emits a delete+insert pair instead
  - packages/quereus-sync/src/sync/sync-manager-impl.ts            # recordDataEvent — consumes `key` as the row identity
  - docs/usage.md                                                  # § Subscribing to Data Changes — the `key` field's contract
difficulty: medium
---

# What happens

A change-notification event carries a `key`: the primary-key values identifying the row it
describes. When an `update` *changes* one of those values, the three backends produce three
different answers for the same statement.

`update t set a = 2 where a = 1` on a table keyed by `a`, with `t` holding `(1, 'x')`:

- **Default in-memory tables** (a plain `new Database()`) deliver one `update` event with
  `key: [1]` — the key the row had *before* — and `newRow: [2, 'x']`.
- **Store-backed tables** deliver one `update` event with `key: [2]` — the key the row has
  *after*.
- **The memory module driven by its own event emitter** delivers a pair instead: a `delete`
  with `key: [1]` and an `insert` with `key: [2]`. Self-consistent, and arguably the
  clearest of the three.

# Why it matters

`key` is how a consumer addresses the row. The sync engine records it as the row identity in
its change log (`recordDataEvent`) and then records the changed column values from `newRow`
against it. On the default in-memory path that writes the *new* row's values under the *old*
identity — a row `(2, 'x')` filed as if it were row `1`, while no event ever announces
identity `2`. A cache keyed by `key` has the same problem in miniature.

Because the backends disagree, an application cannot write one correct listener: the same
SQL against two storage backends needs two different interpretations of the same field.

# Expected

A single documented rule, upheld by every producer. `docs/usage.md` currently describes
`key` only as "Primary key values (if available)", which does not say whether an update's
key is the pre-image's or the post-image's — the ambiguity is what let the three paths
drift.

Deciding the rule is part of this ticket. The two coherent options:

- **Post-image key** — `key` always identifies the row as it exists after the change (and
  for a delete, as it existed before it was removed). Matches the store backend and the
  "as-of-delivery" framing the rest of the event contract already uses; costs consumers the
  ability to find the row they should retire, unless `oldRow` is present.
- **Split the event** — a primary-key-changing update is not an update, it is a delete plus
  an insert, as the memory module's native path already emits. Unambiguous, at the cost of
  one extra event and of losing the "these are the same row" relationship.

Whichever is chosen, the contract belongs in `docs/usage.md` and
`docs/module-authoring.md` (the module-authoring section already spells out who upholds the
other as-of-delivery guarantees), and all three producers must match it.

# Scope note

Found while reproducing `bug-alter-primary-key-leaves-stale-event-key` (now in
`implement/`). That ticket re-derives a batched event's `key` after a mid-transaction
`ALTER PRIMARY KEY`, and deliberately picks the row image the event's own producer used, so
it is neutral to whichever rule this ticket settles on — it does not need to land first, and
does not constrain the answer.

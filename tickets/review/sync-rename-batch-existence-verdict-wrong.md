---
description: A sync batch that both renamed a table and carried rows for it could jam a device into an endless retry, or bring back a row the device had deleted. The fix shipped earlier; this adds the regression tests that stop both failures coming back.
files:
  - packages/quereus-sync/src/sync/change-applicator.ts               # computeBatchTableFates (~line 126) + read sites (~line 324, ~line 364, ~line 481)
  - packages/quereus-sync/src/sync/store-adapter.ts                   # decideRenameTable (~line 517) — the catalog verdict the simulation mirrors; UNCHANGED
  - packages/quereus-sync/test/sync/drop-recreate-batch.spec.ts       # 2 new cases + 1 new helper
  - packages/quereus-sync/test/sync/schema-alter-replication.spec.ts  # new `rename to, carrying rows for the new name` describe (2 cases)
  - docs/sync-schema.md                                               # `RENAME TO` section
difficulty: medium
---

# What shipped

The behaviour fix landed in the previous commit (`230687ac`). This stage added the four
regression tests that were missing, plus one small correction to the fix itself.

## Code change in this stage (one, small)

`change-applicator.ts`, the reactive-drain site (~line 481). The loop over applied
`create_table` / `rename_table` migrations used `if (fate && !fate.present) continue;` —
but a `rename_table` with no `fromTable` returns from the simulation *before* it seeds
either name, so that migration has **no** fate entry at all and the guard skipped
nothing. Result: the receiver kicked off a scoped held-change drain for a name that does
not exist (harmless — the drain's own basis gate returns 0 — but exactly the wasted
`quarantine.list` the comment says the guard avoids). Now falls back to
`ctx.isTableInBasis`, read at that point *after* Phase 2's DDL, so it is the exact
post-batch answer. Same 3-line shape, comment updated to match.

`docs/sync-schema.md` § `RENAME TO`: one clause tightened from "an applied
`rename_table` also triggers the reactive drain" to "a `rename_table` that leaves the new
name PRESENT does; a declined one does not". Everything else in that section was already
rewritten by the fix stage and re-read here against the final code — it is accurate.

## Review of the landed diff (the ticket's first TODO)

Re-read `computeBatchTableFates` against `decideSchemaChange` / `decideRenameTable`.
The `rename_table` arm's no-op conditions line up one-for-one with `decideRenameTable`'s
table:

| receiver has old | receiver has new | `decideRenameTable` | simulation |
|---|---|---|---|
| — (`fromTable` absent) | — | already-applied (warn) | returns, seeds neither name |
| yes | no  | execute | moves the name |
| no  | yes | already-applied | no move; new name stays present |
| yes | yes | THROW (batch aborts) | no move — the fate is then moot |
| no  | no  | already-applied (warn) | no move; both stay absent |

`create_table` (present ⇒ already-applied ⇒ no-op; absent ⇒ execute ⇒ present +
`recreated`) and `drop_table` (⇒ absent, `recreated` cleared) also match. No defect
found; no further change made.

# Use cases to exercise

Every case below runs on real `Database` + `StoreModule` peers via `_peer-harness.ts`,
so it asserts what `select` returns, not what the metadata believes.

**Arm 1 — the receiver gets wedged.** Three shapes, all with rows for a name the
receiver will not end up having, in the same batch as the schema step. Pre-fix each one
threw `Table not found for external write: main.<name>` out of the store adapter,
aborting the batch with its watermark unadvanced — so the same batch re-threw on every
later sync and all subsequent changes from that peer stacked up behind it.

- `schema-alter-replication.spec.ts` → `rename to, carrying rows for the new name` →
  *a rename of a table the receiver dropped …* — receiver drops `orders` locally, origin
  renames `orders` → `orders2` and inserts into `orders2`.
- same describe → *a rename_table without fromTable …* — `fromTable` stripped from the
  migration (an omitting peer); receiver keeps `orders`.
- `drop-recreate-batch.spec.ts` → `a dominated create_table does not resurrect a
  locally-dropped table` — **no rename anywhere**: receiver takes `orders` by
  replication then drops it locally, the origin's `create_table` is HLC-dominated and
  skipped, the batch still carries rows. Shows the defect was never rename-specific.

Each asserts positively: the apply does not throw, the target name does not exist on the
receiver, the rows land in the unknown-table disposition (`result.unknownTable`, and the
matching `quarantine.list` length), and **a second delivery of the same batch is a clean
no-op**. That second delivery is the real regression guard — the user-visible symptom was
the endless retry, not the single throw.

Exact counters are asserted (`applied` / `skipped` / `unknownTable`), so a future change
that silently starts routing these rows somewhere else fails loudly rather than drifting.

**Arm 2 — a deleted row comes back.** `drop-recreate-batch.spec.ts` → *a name renamed
AWAY and BACK in one batch is not fresh: a stored tombstone still blocks its rows*. Both
peers hold `widgets` rows 1 and 9; the receiver deletes row 9 locally; the origin updates
row 9 and renames `widgets` → `widgets2` → `widgets` in the same relay window. Under the
default `allowResurrection: false` the delete must win. The spec runs the **control**
(byte-identical minus the two renames) in the same `it` and asserts the two outcomes are
equal, so the claim is a comparison rather than a bare expectation. Pre-fix, the renamed
version came back holding `{ id: 9, w: 'updated' }`.

Its deliberate contrast, `a name RENAMED away and re-created in one batch resolves
read-free too`, is unchanged and still passes: a `create_table` under a vacated name IS
fresh, a rename back into it is NOT.

**Determinism note worth preserving.** Every new case builds the receiver *without*
`createOrders` and lets it take the table by replication. Two peers that each run the
same `create table` locally file competing `create_table` migrations at schemaVersion 1,
and which one is HLC-dominated turns on the random site-id tie-break — so whether the
receiver still has the table would flip between runs. The fix stage hit exactly this and
got a spurious pass. Both new describes say so in a comment; don't "simplify" them onto
`makeSyncedPair`.

# Validation run

- `yarn workspace @quereus/sync run test` — **723 passing, 0 failing** (~32s).
- Same suite with `change-applicator.ts` restored to `HEAD^` — **719 passing, 4
  failing**, and the four are exactly the new cases: three abort with `apply-to-store
  failed … Table not found for external write`, one with the resurrected row 9 in the
  diff. So each test is measured against the defect, not merely green.
- `yarn workspace @quereus/sync run typecheck` — clean.
- `yarn test` (whole workspace) — all green, no failures anywhere.

# Known gaps (the reviewer's starting points, not a finished floor)

- **Placement deviation.** The ticket said to put the no-rename wedge "where the
  straggler-disposition specs live" — that is `unknown-table-disposition.spec.ts`, which
  is built entirely on a fake `applyToStore` stub and therefore *cannot* surface the
  store adapter's throw, the actual symptom. It went into `drop-recreate-batch.spec.ts`
  instead (its own top-level describe), which is where real-peer `computeBatchTableFates`
  coverage already lives; that file's header was extended to say so. Reasonable people
  could move it back and settle for asserting the routing only.
- **Only the default disposition is covered.** All three wedge cases run under
  `quarantine`. Nothing pins what `ignore` (rows dropped permanently) or
  `store-and-forward` do with a declined rename's rows.
- **Only `allowResurrection: false` is covered** in arm 2. The `true` branch of
  `isDeletedAndBlocking` compares HLCs, and the origin's update vs the receiver's delete
  have no enforced ordering in the harness, so a naive `allowResurrection: true` variant
  would be timing-dependent. Left out rather than written flaky.
- **The rename-collision shape is untested with rows.** Both names present locally still
  throws and retries forever — deliberately, as a divergence alarm — and only the
  DDL-only `rename onto an independently created table throws naming both …` covers it.
  Adding rows to that batch would assert nothing new about the fate verdict.
- **A declined rename's rows under the OLD name** (rather than the new one) are not
  exercised. Believed uninteresting — the old name is in basis, so it is the ordinary
  path — but unverified.
- **No perf measurement.** The simulation replays kept migrations once per apply
  (previously one pass over all migrations); the difference was not measured and no claim
  is made about it.

# Review findings (carried forward from the fix stage)

- The `NOTE:` at the `freshLocalTable` site (`change-applicator.ts` ~line 357) records
  the one place this work leaves imperfect: a table arriving under a name the receiver
  does not currently hold still resolves read-free, because an out-of-basis name has no
  schema and so no resolvable primary-key keying — which skips whatever an earlier
  incarnation stranded under that name. Tracked as
  `bug-sync-recreated-table-inherits-dropped-table-metadata`; parked as a code comment,
  not re-filed.
- Renaming a table stranding its per-row history at the old name is unchanged and out of
  scope — `bug-sync-rename-and-pk-change-strand-crdt-metadata`.

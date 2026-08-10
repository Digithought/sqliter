description: Rewriting a foreign-key-referenced value with an equivalent but differently-typed spelling (the number 1 written as the text '1') was wrongly treated as a real change and rejected; the fix and its regression tests are done.
files:
  - packages/quereus/src/runtime/foreign-key-actions.ts             # anyReferencedColumnChanged + its 4 call sites (fix)
  - packages/quereus/src/runtime/emit/dml-executor.ts               # passes tableSchema into accumulateParentRestrictKeys
  - packages/quereus/test/logic/41-foreign-keys.sqllogic            # un-batched (mixed restrict+cascade parent) cases
  - packages/quereus/test/logic/41.9-fk-restrict-batched.sqllogic   # batched-path cases + collation case (added in review)
  - packages/quereus/test/lens-enforcement.spec.ts                  # lens-routed case
  - docs/runtime.md                                                 # § Batched RESTRICT — coercion note
---

# Foreign-key RESTRICT change detection now compares the value that will be stored

## What shipped

`anyReferencedColumnChanged` (`runtime/foreign-key-actions.ts:100`) is the single answer to
"did this UPDATE actually change a value some child's foreign key points at?". It used to
compare the stored OLD value against the raw NEW value straight off the UPDATE, so writing
the integer `1` as the text `'1'`, or a JSON object with its keys in a different order, read
as a change and ran (and failed) the RESTRICT enforcement scan for a rewrite that stores the
same value. It now re-coerces a non-identical NEW value through the column's logical type —
the same conversion the storage layer applies moments later — and compares again. All four
enforcement sites (batched accumulator, per-row transitive pre-walk, per-row direct
pre-check, lens pre-check) call it, so they cannot drift.

Deliberate choices, both erring toward a spurious "changed" (costs one redundant probe)
rather than a spurious "unchanged" (would skip enforcement): the comparison is BINARY
rather than the column's collation, and both fallbacks (no declared type, coercion throws)
report "changed".

## Review findings

**Checked:** the production diff (fix commit) read before the handoff summary; all four call
sites verified to index the right table's columns (in particular the lens path's basis
indices against the basis table); `sqlValueIdentical`'s JSON semantics traced to confirm
reorder-equal objects are genuinely the same key everywhere it matters (canonical form backs
both the runtime hash key and the persisted byte key, so a reordered parent key still matches
the child rows — the short-circuit is not skipping a real change); the transitive recursion's
use of raw NEW values checked (they are re-coerced against the *child's* column type one level
down, which is the right type); every other old-vs-new comparison in the runtime and planner
audited for the same defect (`constraint-check.ts` reads both sides from the coerced row;
`dml-executor.ts` compares against the post-storage row — both already correct); lint and the
full workspace test suite run.

**Fixed in this pass (minor):**
- Added a collation regression case to `41.9-fk-restrict-batched.sqllogic`: a case-only
  rewrite of a `collate nocase` key must still count as a change and trip RESTRICT. The
  BINARY-not-collation choice was documented but nothing pinned it, so a future switch to a
  collation-aware compare would have silently disabled enforcement for that shape.
- Tightened the `docs/runtime.md` paragraph (it restated the code's reasoning at length) and
  stated there that the helper is shared with the per-row pre-walk and the lens pre-check —
  previously the note read as if it only governed the batched path.

**Filed as a new ticket (major):** `tickets/fix/fk-update-actions-fire-when-key-unchanged.md`.
The implement handoff flagged that the FK *action* executor has no change gate at all and
parked it as "nothing is currently wrong". That is not the case — probing it empirically
found silent data loss, not just wasted work: with `on update set default`, an UPDATE that
touches only a non-referenced parent column re-points the child row at the default value's
parent (`update p set other = 200` moved `c.p_id` from 1 to 99). `on update set null` nulls
the child link, or fails with a confusing `NOT NULL constraint failed` on a table the
statement never named. `on update cascade` survives value-wise but emits a phantom child
data-change event with an empty changed-column list, which the change feed and sync engine
would replicate. Pre-existing and outside this ticket's diff, hence a ticket rather than an
inline fix.

**Tripwires:** none recorded. The one candidate — the redundant cascade write — turned out to
be a reachable defect today, so it became the ticket above rather than a note.

**Not pursued:** the error-message divergence the handoff noted (a genuine key change reports
`violates RESTRICT from '<child>'` on batchable schemas but `CHECK constraint failed:
_fk_<child>_<col>` on non-batchable ones). Confirmed real and pre-existing — the plan-time
synthesized parent-side check fires before the runtime pre-walk gets a chance. Both are
correct rejections and the tests assert each path's actual message, so nothing is wrong; a
consistency pass across enforcement paths is a separate concern nobody has asked for.

## Validation

- `yarn workspace @quereus/quereus run lint` — clean.
- `yarn test` (full workspace) — all green; 7188 passing in `@quereus/quereus`, 0 failing
  anywhere.
- `41.9-fk-restrict-batched.sqllogic` re-run in isolation after adding the collation case, to
  confirm the new expected-error assertion actually executes (the harness fails a block that
  expects an error and gets none, so a passing run is a real assertion).
- `yarn test:store` not re-run in this pass — the implement stage ran it green and the review's
  only code-affecting change is one added sqllogic case in a file the store suite also covers,
  under the memory-vs-store-agnostic FK path.

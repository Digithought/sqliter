---
description: Fixed and locked in with tests a bug where updating any column of a parent row wrongly rewrote or deleted its child rows, even when the column the children actually point at never changed.
files:
  - packages/quereus/src/runtime/foreign-key-actions.ts        # the gate (~line 280); tripwire NOTE (~line 640)
  - packages/quereus/test/logic/41-foreign-keys.sqllogic       # value-level regression blocks (fkgd_/fkgn_/fkgnn_/fkgc_/fkgmc_)
  - packages/quereus/test/runtime/fk-action-key-change-gate.spec.ts   # event-level regression spec
  - docs/sql-ddl.md                                            # FK enforcement section
difficulty: easy
---

# ON UPDATE foreign-key actions no longer fire when the referenced key is unchanged

## What landed

`executeForeignKeyActions` (`packages/quereus/src/runtime/foreign-key-actions.ts`) now
skips an `ON UPDATE` action — CASCADE, SET NULL, or SET DEFAULT — when the parent columns
the foreign key references did not change value, using the same
`anyReferencedColumnChanged` short-circuit the RESTRICT probe, the batched RESTRICT
accumulator, the transitive pre-walk, and the lens walker all already applied.

Before the fix, an update to *any* parent column re-issued the child DML: SET NULL and
SET DEFAULT silently re-pointed or nulled child rows (and raised
`NOT NULL constraint failed` when the child column was non-nullable), and CASCADE
performed a phantom rewrite of the child to the value it already held — a real storage
write plus a spurious data-change event.

Regression coverage in two modalities:

- **Value-level** (`test/logic/41-foreign-keys.sqllogic`): five table groups —
  `fkgd_` (SET DEFAULT), `fkgn_` (SET NULL, nullable child), `fkgnn_` (SET NULL,
  NOT NULL child — untouched case must succeed as a no-op), `fkgc_` (CASCADE), and
  `fkgmc_` (composite two-column CASCADE, added in review). Each asserts both
  directions: untouched referenced column ⇒ child unchanged, genuine re-key ⇒ action
  still fires.
- **Event-level** (`test/runtime/fk-action-key-change-gate.spec.ts`, 4 tests): subscribes
  via `db.onDataChange` and asserts zero child events for an unrelated-column update, and
  exactly one `type: 'update'` / `changedColumns: ['p_id']` event for a real re-key. This
  is the only modality that catches the CASCADE phantom write, since a value check sees no
  difference before and after the fix.

Documented in `docs/sql-ddl.md` § foreign-key enforcement: the propagating actions carry
the same unchanged-key short-circuit the RESTRICT bullet already described.

## Review findings

**Verified the fix itself.** Read the gate in context alongside the four sibling call
sites of `anyReferencedColumnChanged` (lines ~125, ~438, ~570, ~799). The new gate is
byte-for-byte the same guard shape (`operation === 'update' && newRow !== undefined`) as
the batched accumulator and the transitive pre-walk, so runtime and pre-walk cannot
disagree about which parent updates propagate — the failure mode where the pre-walk
asserts RESTRICT for a cascade that runtime then skips (or vice versa) is closed by
construction. Comparison uses `sqlValueIdentical`, which errs toward "changed" — the safe
direction. No finding.

**Verified the tests actually fail without the fix.** Temporarily neutered the gate and
re-ran; both modalities failed (sqllogic: child `p_id` came back 99 instead of 1 for SET
DEFAULT; spec: a full phantom child update event with `changedColumns: ['p_id']`,
`oldRow: [10, 1]`, `newRow: [10, 99]`). Gate restored; `git diff` on the source file is
empty. The tests are load-bearing, not tautological.

**Minor findings, fixed in this pass:**

- The non-nullable-child cases (sqllogic `fkgnn_child`, spec test 3) relied on Quereus's
  implicit NOT NULL column default. That is the whole point of those two cases, so leaning
  on a global default meant they would silently degrade into duplicates of the nullable
  cases if the default ever flipped. Both now spell out `not null`.
- No composite-key coverage existed for the gate. The guard is *any*-of-N semantics; an
  all-of-N regression would have gone unnoticed. Added the `fkgmc_` block: a two-column
  FK where only the second referenced column moves must still cascade, and where neither
  moves must not fire.
- `docs/sql-ddl.md` documented the unchanged-key short-circuit for the RESTRICT bullet
  only; the CASCADE / SET NULL / SET DEFAULT bullets read as unconditional, which is the
  pre-fix behavior. Added a paragraph stating the rule for all three.

**Major findings: none.** No new tickets filed. The implementer flagged three "push on
this" items; all three were examined and none rose to a defect:

- *Batched-RESTRICT interaction.* The gate lives in `executeForeignKeyActions`, upstream
  of the batched-vs-per-row RESTRICT split, and the batch accumulator applies the
  identical short-circuit at line ~125. The paths cannot diverge on this predicate.
- *`newRow` asserted as a bare array.* Matches `DatabaseDataChangeEvent.newRow: Row` and
  the existing `database-events.spec.ts` usage; the disabled-gate run printed the real
  event shape and confirmed it.
- *Lens / logical-FK coverage.* `resolveLensFkParentReferencedValues` calls the same
  helper (line ~799). A lens-level event test would be duplicate coverage of a shared
  predicate; not added, and not treated as a gap.

**Tripwires (recorded, not ticketed):**

- `packages/quereus/src/runtime/foreign-key-actions.ts` ~line 640 — `NOTE:` above
  `case 'cascade':` in `executeSingleFKAction`: the DELETE-vs-UPDATE decision rides
  `newRow === undefined` alone. Dormant today (every caller in `emit/dml-executor.ts`
  passes a defined `newRow` on the update path); would misfire as a child DELETE only if a
  future caller passed `operation: 'update'` with no `newRow`. Left as a comment rather
  than an unreachable-path guard, per AGENTS.md's stance on validating impossible states.
  Carried forward from the implement stage; re-read and confirmed accurate.

**Validation.** `yarn workspace @quereus/quereus run lint` clean (includes the
`tsconfig.test.json` type pass over spec files). `yarn workspace @quereus/quereus run test`
— **7347 passing / 13 pending / 0 failing**, unchanged from the implement-stage count (the
new composite sqllogic block lives inside the single existing `it()` for that file, so it
does not move the flat total). `yarn test:store` not run: the gate operates on in-memory
`Row` arrays before any vtab call, so it is backend-agnostic. No pre-existing failures
surfaced.

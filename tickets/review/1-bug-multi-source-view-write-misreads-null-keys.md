---
description: Writing through a view that joins two tables no longer misfires when a row's key column holds no value — updates land on the right row, deletes reach every side, and RETURNING reports the rows that actually changed.
files:
  - packages/quereus/src/planner/mutation/capture-correlation.ts   # NEW — shared per-key-column NULL-safe equality (KeyColumnInfo, captureKeyEquality)
  - packages/quereus/src/planner/mutation/multi-source.ts          # both invariants: match markers + NULL-safe correlation
  - packages/quereus/src/planner/mutation/set-op.ts                # private nullSafeEqual retired into the shared helper
  - packages/quereus/src/planner/mutation/decomposition.ts         # capturedValueSubquery call sites carry key nullability (keyColumnInfo helper)
  - packages/quereus/test/logic/93.4-view-mutation.sqllogic        # § "NULL key columns through a writable join view" — all five arms + extras
  - packages/quereus/test/logic/43.3-nullable-primary-key.sqllogic # § 13 — same shapes from the nullable-key corpus's side
  - packages/quereus/test/lens-put-fanout.spec.ts                  # § "captured read-back over a NULLABLE anchor key"
  - docs/view-updateability.md                                     # § returning — "Known hole" retired, marker semantics documented
  - docs/vu-operators.md                                           # § Outer Joins — partition restated in marker terms; stale RETURNING-reject paragraph corrected
---

# Review: join-view writes with NULL key columns

Implements `bug-multi-source-view-write-misreads-null-keys`. A primary key column may be
nullable and NULL is a self-equal key value, but the multi-source view-write substrate's
identity capture (`__vmupd_keys`) correlated on captured keys with plain `=` (which never
matches NULL) and read "all of a side's captured key columns are NULL" as "that side had
no join partner". Every write through a join view touching a NULL-keyed row silently
no-op'd, half-fired, duplicated a partner row, or returned nothing from RETURNING.

## What was built

Both invariants from the ticket, landed together (the ticket's ordering constraint —
NULL-safe correlation without the marker would misroute the outer-join matched branch):

1. **Explicit match marker** (`m<side>`, `matchFlagName`). `buildMultiSourceKeyCapture`
   rebuilds the capture's join tree with one synthetic `ExistenceColumnSpec` per
   captured non-preserved side, appended at the nearest enclosing join that
   null-extends that side (`rebuildJoinWithMatchFlags`), and projects the flag as a
   capture column. The flag is the join runtime's actual null-extension decision — no
   runtime change was needed. Every "no partner" test now reads the marker
   (`matchFlagIsFalse` — NULL reads as false): the null-extended materialization
   INSERT's WHERE, the RETURNING re-query's no-partner disjunct, and (as a positive
   conjunct) the matched non-preserved UPDATE, the existence-flip DELETE, and the
   matched value read-back. Only the capture reads the rebuilt join; the RETURNING
   re-query still reads `analysis.joinNode` unchanged. Inner-join captures build no
   flags — byte-identical shape to before.
2. **NULL-safe correlation per nullable key column** (`captureKeyEquality` in the new
   `capture-correlation.ts`): `left = right` for a NOT NULL column (index-friendly),
   `left = right or (left is null and right is null)` for a declared-nullable one.
   `requireKeyColumns` now returns `{name, nullable}` (`KeyColumnInfo`);
   `capturedValueSubquery`'s `owningPk` carries nullability, and it grew a
   `matchedOnly` flag for the non-preserved read-back. All six call sites updated
   (`multi-source.ts` ×2, `decomposition.ts` ×4, via a schema-driven `keyColumnInfo`
   helper there). `set-op.ts`'s private `nullSafeEqual` retired into the shared helper
   (data columns pass `nullable: true` unconditionally — set-op semantics).

## Validation run

- `yarn workspace @quereus/quereus test` — 9639 passing, 0 failing (25 pending are
  pre-existing skips).
- `yarn workspace @quereus/quereus lint` — clean (eslint + tsc over test files).
- `yarn workspace @quereus/quereus typecheck` — clean.

## Test coverage added (the review floor)

`93.4-view-mutation.sqllogic` § "NULL key columns through a writable join view": all
five ticket arms asserting post-write **base** state — inner-join update of a NULL-keyed
side (arm 1), UPDATE…RETURNING through the child with a NULL-keyed parent (arm 5),
inner-join both-sides delete incl. DELETE…RETURNING (arm 3), composite key with NULL in
only some members for inner and left shapes (arm 4), left-join matched partner keyed
NULL updated in place instead of duplicated (arm 2), plus: genuine null-extension still
materializing (the regression Phase 1 was most exposed to), left-join delete routing,
and an existence-flip `set hasP = false` deleting a NULL-keyed matched partner.
`43.3-nullable-primary-key.sqllogic` § 13 pins the same shapes from the nullable-key
corpus. `lens-put-fanout.spec.ts` pins the decomposition captured read-back over a
nullable anchor key (materialize branch).

## Known gaps / notes for the reviewer

- **Decomposition lens NULL stitch-key is still broken beyond this ticket's scope** —
  filed `fix/bug-lens-decomposition-null-stitch-key` (repro: verified, both arms). The
  lens GET body joins members with plain `=` (`buildKeyEquiJoin`, lens-compiler.ts) and
  `decomposition.ts` correlates member ops with `key in (select anchorKey …)`
  (`NULL IN` is never true), so a NULL-keyed logical row neither reads whole nor
  accepts a matched-member write. This ticket's `capturedValueSubquery` fix is
  necessary but not sufficient there; the new spec test pins exactly the arm it fixes
  and its comment names the follow-up ticket.
- **Tripwire (recorded as a `NOTE:` at `rebuildJoinWithMatchFlags`)**: a flag-bearing
  join is pinned to the nested-loop emitter (existence guards disable physical join
  selection), so an outer-join write's capture forgoes hash/merge join. Once per
  statement; revisit only if outer-join view writes over large bodies show up as slow.
- The RETURNING re-query's non-preserved matched branch relies on the NULL-safe exact
  equalities alone (no marker conjunct) — the no-partner disjunct makes a marker
  conjunct redundant there; reasoning is in the `buildMultiSourceUpdateReturning`
  comment. Worth a skeptical read.
- `matchFlagIsFalse` spells "not true" as `is null or NOT flag` because the flag can be
  NULL when itself null-extended by an enclosing outer join in an n-way body. No test
  exercises a *nested* outer join capture (3-way body with the non-preserved side under
  a nested join) — the rebuild handles it by construction (post-order claiming,
  ancestors rebuilt via `new JoinNode` with children reused), but coverage is thin
  there.
- `docs/vu-operators.md` § Outer Joins carried a stale "RETURNING rejects
  `returning-through-view`" boundary paragraph contradicting the shipped
  non-preserved RETURNING support; corrected in passing while editing the adjacent
  ticket-mandated text.
- FULL-outer bodies never reach the flag machinery (writes through FULL reject
  earlier); `rebuildJoinWithMatchFlags` handles a `full` child defensively and raises
  an internal diagnostic if a non-preserved side resolves to no null-extending join.

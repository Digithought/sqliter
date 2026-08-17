description: Writing through a view that joins two tables no longer misfires when a row's key column holds no value — updates land on the right row, deletes reach every side, and RETURNING reports the rows that actually changed.
files:
  - packages/quereus/src/planner/mutation/capture-correlation.ts   # NEW — shared per-key-column NULL-safe equality
  - packages/quereus/src/planner/mutation/multi-source.ts          # match markers + NULL-safe correlation
  - packages/quereus/src/planner/mutation/set-op.ts                # private nullSafeEqual retired into the shared helper
  - packages/quereus/src/planner/mutation/decomposition.ts         # capturedValueSubquery call sites carry key nullability
  - packages/quereus/test/logic/93.4-view-mutation.sqllogic        # § "NULL key columns through a writable join view"
  - packages/quereus/test/logic/43.3-nullable-primary-key.sqllogic # § 13
  - packages/quereus/test/lens-put-fanout.spec.ts                  # § "captured read-back over a NULLABLE anchor key"
  - docs/view-updateability.md
  - docs/vu-operators.md
----

# Join-view writes with NULL key columns — shipped

A primary key column may be declared nullable, and NULL is an ordinary, self-equal key
value. The multi-source view-write substrate's identity capture (`__vmupd_keys`) had two
assumptions that both broke on such a row: it correlated captured keys with plain `=`
(never true for NULL), and it read "all of a side's captured key columns are NULL" as
"that side had no join partner". Every write through a join view touching a NULL-keyed row
silently no-op'd, half-fired, duplicated a partner row, or returned nothing from RETURNING.

## What shipped

Two invariants, landed together:

1. **Explicit match marker.** For each captured non-preserved (outer-join) side the
   capture projects a boolean `m<side>` column — a synthetic existence flag the join
   runtime sets from its actual null-extension decision. Every "did this side have a
   partner" test reads the marker instead of inspecting key columns: the materialization
   INSERT's WHERE, the RETURNING re-query's no-partner disjunct, and (as a positive
   conjunct) the matched non-preserved UPDATE, the existence-flip DELETE, and the matched
   value read-back. Inner-join captures build no flags and keep their exact prior shape.
2. **NULL-safe correlation per nullable key column.** `captureKeyEquality` emits
   `left = right` for a column declared NOT NULL (index-friendly) and
   `left = right or (left is null and right is null)` for a declared-nullable one. Applied
   at every capture-correlation site across `multi-source.ts`, `decomposition.ts` and
   `set-op.ts` (whose private `nullSafeEqual` was retired into the shared helper).

## Review findings

Reviewed the implement diff (`606de210f`) fresh before reading its handoff, then read every
touched file plus the sites it should have touched (`view-mutation-builder.ts`,
`rules/join/*`, `runtime/emit/join.ts`, `analysis/key-filter.ts`, `docs/vu-*`,
`docs/view-updateability.md`, `docs/sql-constraints.md`).

### Correctness — no defects found

Traced each reader against the capture it reads and could not construct a failing case:

- **Marker availability.** Every site that emits `k.m<side>` is reachable only when that
  side is in the capture's side set. Verified all four routes: base ops derive the set
  from themselves (`capturedSideIndices`), the RETURNING path captures *all* sides,
  `decomposeDelete` only ever targets **preserved** sides (so it never names a marker),
  and the set-op nested capture derives its set the same way as the standalone path.
- **The RETURNING matched branch without a marker conjunct** (the implementer asked for a
  skeptical read) holds. Over-selection is blocked by the preserved-side equalities, which
  are stable and unique; the no-partner disjunct already admits every marker-false row, so
  adding a marker conjunct to the matched branch would change nothing. Worked the
  fan-out case (N preserved rows sharing one partner, one of them keyed NULL) explicitly —
  it is the case the *old* code got wrong and the new code gets right.
- **Declared vs announced nullability.** The gate reads declared (`ColumnSchema.notNull`)
  nullability while the sibling `analysis/key-filter.ts` reads announced
  (`type.nullable`). Checked both directions for under-match: every target-side operand is
  either a real base row (NULL only if declared nullable) or, in the RETURNING re-query, a
  side that is preserved by construction and so never null-extended. No under-match exists.
- **Join-tree rebuild.** `rebuildJoinWithMatchFlags` claims each side at the nearest
  null-extending join, post-order, reusing children verbatim. Confirmed the flag semantics
  against `runtime/emit/join.ts` (`spec.side` is the *dropped* side; the flag is the real
  match bit, not a re-evaluated ON predicate) and confirmed the tripwire's premise —
  `hasExistenceColumns` does guard physical join selection, merge join, lookup join, and
  join elimination.

### Coverage gaps found and closed

The implementer's tests covered the five ticket arms well but left four paths that the fix
changed and nothing exercised. Added to `93.4-view-mutation.sqllogic`:

- **Cross-source SET whose owning side is the NULL-keyed one** (`set pv = cv` through an
  inner join). This is a *different* correlation site from the identifying EXISTS — the
  `capturedValueSubquery` read-back — and it was equally broken before the fix (the parent
  read back NULL and the write silently blanked the column). Nothing covered it.
- **RIGHT join mirror.** The marker's `side` must be minted on the left child for RIGHT;
  every prior arm was LEFT.
- **Two non-preserved sides in one capture with markers disagreeing** (3-way left-join
  chain: one partner real but keyed NULL, one genuinely absent). Reading "captured key is
  all NULL" would have routed both to materialize.
- **A marker that is itself NULL**, via `(x left join b) right join a` — the RIGHT join
  null-extends the left child, where `b`'s marker lives. This closes the "coverage is thin
  there" gap the handoff flagged; it turned out to be reachable and expressible after all.
  (A nested join *under* the null-extending child — `x left join (p join q)` — is not
  expressible: the parser rejects a parenthesized join source. Worth knowing before anyone
  else goes looking for that shape.)

Also probed and *not* added: a non-preserved column update through that RIGHT-over-LEFT
body rejects at plan time (`the non-preserved side is not related to a preserved side by an
equi-join key`), so it is a pre-existing boundary, not a marker gap.

### Fixed inline (minor)

- `decomposition.ts` — the new `keyColumnInfo` helper was inserted *between*
  `singleKeyColumn`'s doc comment and `singleKeyColumn`, orphaning the comment onto the
  wrong function. Reordered.
- `multi-source.ts` — `capturedValueSubquery` had grown to seven positional parameters
  ending in a bare `true`. Converted the four optional trailing parameters to a
  `CapturedValueOptions` object; the four `decomposition.ts` call sites pass three
  arguments and are unchanged.
- `multi-source.ts` — the match-marker attribute lookup indexed `captureAttrs[columnIndex]`
  without checking `findIndex`'s `-1`. Unreachable by construction, but it would have
  failed as an undefined-property TypeError; now raises a named internal diagnostic.
- `docs/vu-operators.md` § Multi-Base-Table Mutations still described the per-side base-op
  EXISTS as plain `=` — the one place that documents `buildCapturedKeyPredicate`, and the
  implement pass only updated the § Outer Joins text below it. Restated with the NULL-safe
  form and the non-preserved marker conjunct.

### Tripwires (recorded at the site, not filed)

- `capture-correlation.ts` — under `pragma default_column_nullability = nullable` **every**
  key column is declared nullable, so every correlation takes the disjunction, including
  ones a NOT NULL default would have left seekable. Correct either way; the NOTE names the
  narrowing (gate on *reachable* rather than declared nullability) to reach for if view
  writes under that pragma ever profile slow.
- The implementer's existing NOTE at `rebuildJoinWithMatchFlags` (flag-bearing joins pin to
  the nested-loop emitter) was verified against the five `hasExistenceColumns` rule guards
  and left as written.

### Filed as evidence on an existing ticket

`packages/quereus/src/planner/mutation/multi-source.ts` is **3,541 lines** (`wc -l`,
2026-08-17) — the second-largest non-test source file in the repo, behind only
`schema/manager.ts`, and it had never been listed in the size-debt theme. Its siblings
`decomposition.ts` (2,262) and `set-op.ts` (2,058) are over too. Appended all three to
`tickets/backlog/debt-oversized-source-files.md` with the named seams inside
`multi-source.ts`, rather than filing a fourth point ticket for the same class.

### Out-of-diff breakage fixed in passing

`node scripts/check-docs.mjs` failed at HEAD on a dead same-page anchor in
`docs/sql-constraints.md:19` (`#72-unique-constraint`; UNIQUE is § 7.3, not § 7.2),
introduced by the earlier `feat-relax-declared-primary-key-not-null` implement commit. One
character, same subject area as this ticket's doc edits, so it was corrected here rather
than filed. The gate is green again.

Two non-failing warnings the same gate prints are **not** from this work and were left
alone: `docs/lens.md` is 471 words over its ratchet with 29 words of grace left, and
`docs/module-authoring.md` is 7 words from a hard 12,000-word cap. The next edit to either
will fail the build.

### Not addressed — out of scope, already tracked

The decomposition lens NULL stitch-key defect (`fix/bug-lens-decomposition-null-stitch-key`,
filed by the implement pass, repro verified on both arms) is genuinely separate: the lens
GET body joins members with plain `=` and `decomposition.ts` correlates member ops with
`key in (select anchorKey …)`, which `NULL IN` never satisfies. This ticket's fix is
necessary but not sufficient there, and the spec test added by the implement pass pins
exactly the arm it does fix.

## Validation

- `yarn workspace @quereus/quereus test` — **9639 passing, 0 failing** (25 pending are
  pre-existing skips).
- `yarn workspace @quereus/quereus lint` — clean (eslint + `tsc` over test files).
- `yarn workspace @quereus/quereus typecheck` — clean.
- `node scripts/check-docs.mjs` — green (after the anchor fix above).

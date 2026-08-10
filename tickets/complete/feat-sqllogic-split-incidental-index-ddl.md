---
description: |
  Shared SQL test files that created an index only as scenery for testing something else have been split,
  so a database backend with no index-creation feature can still run the parts that never needed one.
files:
  - packages/quereus/test/logic/                 # 35 new fixtures, 37 edited parents
  - packages/quereus/test/logic.spec.ts          # MEMORY_ONLY_FILES gained two split children
  - packages/quereus/test/logic-capabilities.ts  # near-miss-guard NOTE updated (tripwire)
  - packages/quereus/test/README.md              # § requires-capability directive — unchanged, still accurate
  - docs/invariants.md, docs/sqlite-test-crosscheck.md  # guard / corpus pointers refreshed
---

# Split incidental index DDL out of fixtures whose subject is something else

## What landed

The 33 fixtures the ticket listed as "index DDL is incidental scaffolding" no longer run
`create index` / `create unique index` / `drop index`. Their index-dependent scenarios moved into
sibling fixtures carrying `-- requires-capability: standalone-index-ddl` plus a header comment saying
what was carved out, from where, and why. The two annotated files the ticket named as carrying a
non-index tail (`06.3-schema`, `10.1.3-ddl-drop-in-transaction`) were carved the other direction — their
index-free sections moved into siblings with *no* directive, so a backend skipping the parent still runs
them. Review added a third such carve (see findings). Parents keep a pointer comment where each moved
scenario used to be, and section numbering is preserved across the move.

Final corpus state, mechanically verified: every file that executes standalone index DDL carries the
directive, and every file carrying the directive executes standalone index DDL. 320 fixtures, 45 annotated.

## Validation

- `yarn test` — 7822 passing, 13 pending, 0 failing.
- `yarn test:store` — 7813 passing, 22 pending, 0 failing (22 = the same 13 + 9 memory-only files).
- `yarn workspace @quereus/quereus run lint` — clean (eslint + `tsc -p tsconfig.test.json --noEmit`).
- Neither run emitted a `skipped: backend lacks capability` line. That is the README's own health check:
  both quereus backends declare the full capability set, so a local skip would mean a wrong directive.

Counts are +1 against the implement stage's numbers on both legs — the one new fixture this review added.

## Review findings

### Checked and clean

- **Scenario preservation.** Every SQL line removed from a parent was matched against the whole current
  corpus. 46 lines did not match verbatim; each was accounted for by a change the handoff already
  declared — the four documented "vehicle substitutions" (`create unique index X on t (v)` replaced by a
  table-level `unique (v)` in `41.7.3`, `41.7.4`, `41.7.3.1`, and verb substitution in `10.1.4`), the two
  forced expected-result changes, and three per-file teardown `drop table` lines for tables that moved
  out. Nothing was silently dropped.
- **Section conservation on the surgical splits.** `105-vtab-memory-mutation-kills` (split
  programmatically by section header, 17 of 40 sections moved) was diffed section-by-section against its
  pre-split content: 0 sections lost, 17 pointer comments added, no section duplicated across parent and
  child. `102.2-unique-collation` split cleanly at §1–8 / §9–13; `06.4.2-collation-extras` likewise.
- **Vehicle substitutions.** Read all four. Each substituted constraint reaches the same enforcement path
  the scenario is about, and in the two largest cases (`41.7.3`, `41.7.4`) the parent already contained a
  table-level twin of the moved section, which is what makes the substitution safe rather than merely
  plausible. `10.1.4`'s `ddl_transaction_policy` gate is verb-agnostic and its §2/§3/§5 read coherently
  with ADD COLUMN / DROP TABLE in place of the index verbs.
- **`08.4-key-set-semi-join`'s whole-file directive** (the file the implementer found outside the ticket's
  list). Read in full: every table under test is created with a secondary index, and the KeySetSemiJoin
  rewrite only plans over a secondary-indexed column. There is genuinely no index-free remainder. Call
  confirmed.
- **`50-metadata-tags`'s surviving `ALTER INDEX` statements** — the implementer flagged these as an open
  question about the capability vocabulary. Resolved, no action needed: all eight target either a
  deliberately-nonexistent index (expecting `-- error: not found`) or an implicit covering index derived
  from an inline / table-level `UNIQUE` constraint — including the `quereus.expose_implicit_index` case in
  Phase 38, the only two that expect success. None requires standalone index DDL, so the file correctly
  carries no directive.
- **Memory-only bookkeeping.** Both children of memory-only parents (`05.0.1`, `105.1`) were added to
  `MEMORY_ONLY_FILES`; no other split parent is an active member of that set.
- **Directive parsing.** The carve-out headers mention `requires-capability:` in prose. Verified against
  `logic-capabilities.ts` that neither `DIRECTIVE_RE` nor `NEAR_MISS_RE` matches them (both anchor on
  `^--\s*require…`; the prose is backtick-quoted). See the tripwire below.
- **Numbering.** No new fixture collides with an existing decimal sub-number, and `41.7.3.2` correctly
  skips the taken `.1` slot.

### Found and fixed in this pass

- **A third annotated file carries a non-index tail.** `10.1.2-ddl-in-transaction` §3 and §5 exercise
  `alter table … add constraint … unique` inside a transaction with no index DDL at all — the exact
  constraint-side twins of the sections the implementer carved out of `10.1.3`. The ticket named only two
  such files, so this was missed the same way `08.4` was. Carved to
  `10.1.2.1-add-constraint-in-transaction.sqllogic` (no directive), parent pointers and the file's cleanup
  block updated. The parent's header had a prior NOTE arguing these sections should ride along under the
  index-DDL token; that NOTE was about whether to mint a *second* capability token, which this split does
  not do, so it was rewritten rather than overridden. This fixture is the +1 in both test counts.
- **Companion pointers naming a parent for coverage that moved.** Three spec headers and two docs pointed
  at a parent fixture as the home of behaviour now living in a child. Updated:
  `test/vtab/null-bound-seek.spec.ts` (secondary-index NULL bounds → `21.1.1`),
  `test/optimizer/in-multiseek-incount.spec.ts` (composite-index IN cross-product → `07.9.1`),
  `test/unique-enforcement-comparators.spec.ts` (index-derived halves → `15.1.2` / `102.2.1`),
  `docs/invariants.md` MV-019 (added `51.9.1` as a second guard for the partial-UNIQUE scope case),
  `docs/sqlite-test-crosscheck.md` (mutation-kill inventory gained `105.1` / `110.1`).
  Eight other cross-references were checked and left alone because the behaviour they name stayed in the
  parent: `covering-structure.spec.ts`, `runtime/case-comparison-collation.spec.ts`,
  `vtab/memory-collation-per-database.spec.ts`, `json-parameter-equality.spec.ts`,
  `alter-drop-rename-constraint.spec.ts`, `plan/mixed-semantic-equi-key.spec.ts`,
  `planner/equi-pair-semantic-gate.spec.ts`, `plan/cte-dml-plan-shape.spec.ts`.
- **Comment-style regressions.** The split rewrote two existing header comments from `→` to `->` and from
  `§N` to `section N`, and used the ASCII forms in four new prose lines. The corpus uses `→` and `§` in
  128 files; restored in `50.2-declare-schema-renames` and `41.7.4-alter-column-retype-semantic-memory`.

### Recorded as a tripwire, not a ticket

- The carve-out headers (`06.3.6`, `10.1.2.1`, `10.1.3.1`) name `requires-capability:` in prose and stay
  clear of the deliberately-loose near-miss guard only because they backtick-quote it. Dropping the
  backticks in a later edit would hard-error the file. `NEAR_MISS_RE`'s own comment in
  `test/logic-capabilities.ts` asserted "no corpus file does that today"; that comment now names the three
  files and the dependency, per its own instruction to rephrase prose rather than narrow the regex.

### Deliberately not acted on

- `docs/zero-bug-plan.md` records `105-vtab-memory-mutation-kills.sqllogic | ~164 assertions` under a
  dated 2026-04-15 coverage-improvement entry. That number is now low, but the entry is a historical
  snapshot of a Stryker run, not a live inventory — rewriting it would falsify the record.
- Header prose in a few converted parents says "index" where it now means the covering index an inline
  UNIQUE auto-builds. Accurate but ambiguous; the implementer flagged it rather than mass-editing and
  that judgment stands — a mechanical sweep over that wording would touch many files for no behavioural
  gain.
- `10.4.1-schema-scale-indexes` duplicates its parent's 20-table rig rather than sharing it. Fixtures run
  as independent databases, so sharing is not available; duplication is the only option.

### Not verifiable here

The payoff of this work lands on backends that lack standalone index DDL. Both quereus backends have it,
so every new fixture runs locally rather than skipping, and the split is verified here only as a pure
reorganization — correct, complete, and count-neutral. Whether it actually recovers coverage downstream
cannot be observed from this repo.

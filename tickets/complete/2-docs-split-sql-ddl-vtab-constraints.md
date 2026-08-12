---
description: The SQL reference page about creating tables was about to blow past the size limit the docs checker enforces, so its virtual-table and constraint chapters were moved into two new sibling pages and every link pointing at them was updated.
files:
  - docs/sql-ddl.md           # 11,750 → 7,531 words
  - docs/sql-vtab.md          # NEW — § 6 Virtual Tables
  - docs/sql-constraints.md   # NEW — § 7 Constraints and Indexes
  - docs/sql.md               # topic table + 2 "Moved to" stubs
  - docs/functions.md, docs/invariants.md, docs/runtime.md, docs/schema.md, docs/sql-alter.md   # inbound anchors
  - docs/.stability.json      # 2 new Stable entries
  - packages/quereus/src/schema/manager.ts, packages/quereus/src/schema/schema-differ.ts        # comment-only markers
  - packages/quereus/src/planner/building/foreign-key-builder.ts                                # comment-only marker (review)
  - packages/quereus/test/logic/10.5.5-index-name-uniqueness.sqllogic                           # comment-only marker (review)
  - packages/quereus/test/logic/41.16-fk-unenforceable.sqllogic                                 # comment-only marker (review)
difficulty: easy
---

Documentation move plus comment-only TypeScript / test-fixture edits. No runtime behaviour touched.

## What landed

`docs/sql-ddl.md` was 11,750 words against a hard 12,000-word cap with no grace band. Two whole
top-level chapters moved out into new siblings of the `sql.md` family:

| New document | Content | Words |
| --- | --- | --- |
| `docs/sql-vtab.md` | `## 6. Virtual Tables` (6.1–6.3) | 1,988 |
| `docs/sql-constraints.md` | `## 7. Constraints and Indexes` (7.1–7.8) | 2,282 |

`docs/sql-ddl.md` is now 7,531 words. Section numbering and every heading kept verbatim; only the
*file* half of each inbound link changed. Both new documents open with the H1 / stability banner /
`Part of the [Quereus SQL Reference](sql.md) …` line that five of the six sibling `sql-*.md`
documents use. `docs/.stability.json` gained two `Stable` entries; `docs/.doc-budget.json`
untouched. `docs/sql.md` carries the two "Moved to …" stubs, repointed, plus two new topic-table
rows.

## Review findings

**Checked:** the whole implement diff read before the handoff summary; verbatim-move claim
re-verified independently; every link and anchor into and out of the three documents; every prose
section marker (`§ …`) across `docs/`, `packages/*/src` and `packages/*/test`; the two newly written
`sql.md` row descriptions against the actual heading lists; family-document opening convention;
`node scripts/check-docs.mjs`, `yarn lint`, `yarn test`.

**Verbatim move — confirmed independently.** Extracted lines 654–833, 835–1176 and 1–651 from
`git show c2b973e0:docs/sql-ddl.md` and `diff`ed each against `tail -n +7 docs/sql-vtab.md`,
`tail -n +7 docs/sql-constraints.md` and the current `docs/sql-ddl.md`. All three diffs empty. The
handoff's claim holds exactly as written.

**Links — no breakage found.** Every link out of the two new documents resolves
(`stability.md#tiers`, `sql.md`, `sql.md#topic-documents`, `sql-alter.md`,
`sql-alter.md#27-alter-table-statement`, and two intra-file `#71-…` / `#76-…` anchors that stayed in
the same file with their targets). No `sql-ddl.md#6…` / `#7…` reference survives anywhere. Every
remaining `sql-ddl.md#…` reference points at § 2.0 / § 2.6.x / `#declaration-syntax`, all of which
stayed. `check-docs.mjs` (which validates anchors, not just files) is green.

**Minor — fixed in this pass (7 stale prose section markers the implement sweep missed).** The
implement sweep grepped `sql-ddl.md §`, a *file-name-anchored* pattern over `packages/quereus/src`
and `docs`. That pattern cannot see a marker with no file name in it, and does not reach test
fixtures. Seven markers were left naming a section that had moved:

| Site | Was | Now |
| --- | --- | --- |
| `docs/sql-ddl.md:175` | `(unique per schema — see §6.3)` | linked `sql-vtab.md §6.3` |
| `docs/sql-ddl.md:379` | `rejected the same way — see §7.6.` | linked `sql-constraints.md §7.6` |
| `docs/sql-vtab.md:186` | `see §2.0 *Declaration Syntax*` | linked `sql-ddl.md §2.0` |
| `docs/sql-constraints.md:271` | `forward references (§ *Order Independence*)` | linked `sql-ddl.md`'s *Order Independence* |
| `packages/quereus/src/planner/building/foreign-key-builder.ts:240` | `docs/sql-ddl.md § FOREIGN KEY` | `docs/sql-constraints.md §7.6` |
| `packages/quereus/test/logic/41.16-fk-unenforceable.sqllogic:147` | `docs/sql-ddl.md § FOREIGN KEY` | `docs/sql-constraints.md §7.6` |
| `packages/quereus/test/logic/10.5.5-index-name-uniqueness.sqllogic:5` | `docs/sql-ddl.md §6.3` | `docs/sql-vtab.md §6.3` |

**Major — none filed; the class already has a ticket, and it gained an arm.** These seven are the
fifth instance of the class covered by `backlog/debt-check-docs-validate-section-markers`
(`bareDocRefs()` in `scripts/check-docs.mjs` validates the file half of a prose marker and ignores
the `§ Section` half). Per *architecture first*, the theme ticket is the right rung — a point ticket
per split would never end. A "Fifth data point" section was appended to it with the corpus above and
two design consequences the earlier four instances did not surface: (a) a marker with **no file half
at all** — four of the seven are bare `§6.3` / `§7.6` / `§2.0` / `§ *Order Independence*` markers
that were correct until the section left the containing document, so no file-anchored grep and no
`.md`-rooted extractor can see them; (b) markers live in **`.sqllogic` test fixtures**, outside the
`--include=*.md --include=*.ts` corpus every sweep (and that ticket's own corpus grep) has used.

**Handoff claims that did not hold up, and what they turned out to be.** The handoff said both new
documents "carry the `docs/sql-alter.md` opening exactly". They do not — `sql-alter.md` has a
two-sentence orientation blurb and **no** `Part of the [Quereus SQL Reference]` map line, while the
new documents have the map line and no blurb. Checked against the whole family: the map line is the
convention in `sql-select.md`, `sql-dml.md`, `sql-views.md`, `sql-txn.md` and `sql-functions.md`, and
`sql-alter.md` is the lone outlier. So the new documents are right and the handoff's listed gap
("no introductory paragraph — reviewer may want parity with `sql-alter.md`") is **declined**: parity
with the outlier would be the regression. `sql-alter.md`'s missing map line is pre-existing and not
touched here.

**Newly written prose — verified.** The two new `sql.md` topic rows are the only non-verbatim text
in the diff. `Constraints & indexes | PRIMARY KEY, NOT NULL, UNIQUE, CHECK, FOREIGN KEY, DEFAULT, and
CREATE / DROP INDEX` matches §§ 7.1–7.8 exactly (7.1 PRIMARY KEY, 7.2 NOT NULL, 7.3 UNIQUE, 7.4
CHECK, 7.5 DEFAULT, 7.6 FOREIGN KEY, 7.7 Creating Indexes, 7.8 Dropping Indexes). `Virtual tables |
CREATE VIRTUAL TABLE, the built-in modules, and indexes on virtual tables` matches §§ 6.1–6.3. The
shortened `sql-ddl.md` row matches what remains (§ 2.0, 2.6, 2.6.1, 2.6.2, 2.6.3). Row placement
after ALTER and before Views groups the four schema documents together and reads correctly.

**Tripwires — none recorded.** Nothing here is conditional-on-a-future-event; the one live risk
(stale prose markers) is an existing tracked defect class, not a "fine now" concern, so it went to
the theme ticket rather than a `NOTE:`.

**Blocked / decisions for a human — none.** No question in this diff needed a human call.

**Accepted tradeoffs — none encountered.** No `NOTE:` at any site this review touched.

**Not re-flagged.** `docs/.stability.json` is shared with sibling ticket
`3-docs-split-isolation-design`; both entries here sit at their sort positions and merge cleanly.
The two `check-docs.mjs` notices (`design-isolation-layer.md` 127 from the cap, `lens.md` 471 over
ratchet inside the grace band) are pre-existing at baseline and are ticket 3's / their own business.

## Validation

- `node scripts/check-docs.mjs` — exits 0, `Docs OK: links resolve, invariants well-formed, sizes
  within ratchet, doc and package tiers declared.` Prints no line for `sql-ddl.md`, `sql-vtab.md` or
  `sql-constraints.md`.
- `yarn lint` — passes (54s).
- `yarn workspace @quereus/quereus run test:single packages/quereus/test/documentation.spec.ts` —
  10 passing, including "should have all relative doc links resolve to existing files".
- `yarn test` — full suite run in this review pass (the implement stage skipped it): green,
  `Done in 5m 14s`, no failing specs. The one `AssertionError` string in the log is inside a
  deliberately-failing-KV fixture in `packages/quereus-sync/test/sync/sync-manager.spec.ts` and that
  test passes.
- `git diff docs/.doc-budget.json` — empty.

---
description: |
  Went through every shared SQL test file that creates or drops an index and marked the ones whose whole
  point is index creation, so a database backend without that feature can skip exactly those files and keep
  running everything else — instead of failing outright or silently losing coverage.
files:
  - packages/quereus/test/logic/06.3-schema.sqllogic                                  # annotated
  - packages/quereus/test/logic/06.9.3-json-index-range-seek.sqllogic                 # annotated
  - packages/quereus/test/logic/10.1.3-ddl-drop-in-transaction.sqllogic               # annotated
  - packages/quereus/test/logic/10.5-indexes.sqllogic                                 # annotated
  - packages/quereus/test/logic/10.5.1-partial-indexes.sqllogic                       # annotated
  - packages/quereus/test/logic/10.5.2-expression-indexes.sqllogic                    # annotated
  - packages/quereus/test/logic/10.5.3-desc-index-ordering.sqllogic                   # annotated
  - packages/quereus/test/logic/10.5.4-composite-pk-index-update-phantom.sqllogic     # annotated
  - packages/quereus/test/logic/10.5.5-index-name-uniqueness.sqllogic                 # annotated
  - packages/quereus/test/logic/47.3.1-upsert-conflict-index-derived-collation.sqllogic # annotated
  - packages/quereus/test/logic/drop-unique-index.sqllogic                            # annotated
  - packages/quereus/test/logic-capabilities.spec.ts                                  # spot-assert
  - tickets/backlog/feat-sqllogic-split-incidental-index-ddl.md                       # 33-file leave-alone list
difficulty: easy
---

# Sqllogic capability corpus sweep — complete

## What landed

Every `.sqllogic` file in `packages/quereus/test/logic/` that runs a standalone `create index` /
`create unique index` / `drop index` statement (45 of 281) was classified: does the index DDL *make* the
file, or is it scaffolding to reach some other code path?

**12 files now carry `-- requires-capability: standalone-index-ddl`** (11 added by this ticket, 1 by the
prereq). A downstream harness whose storage engine has no standalone index DDL skips exactly those and keeps
running the other 269 files.

**33 files were deliberately left un-annotated.** Annotating them would trade a loud failure for a silent
coverage hole — the index is incidental and the rest of each file is worth running. They are listed with
per-scenario line ranges in `tickets/backlog/feat-sqllogic-split-incidental-index-ddl.md`, which is the input
for the eventual split work.

`packages/quereus/test/logic-capabilities.spec.ts` gained a test that reads all 11 newly annotated files and
asserts each declares the capability, so a lost annotation or an un-updated rename fails loudly.

## Review findings

### Verified independently (not taken from the handoff)

- **Annotation set matches reality.** Re-derived the candidate list from the corpus directly: 45 files with
  standalone index DDL, 12 annotated, 33 not. Matches the handoff's counts exactly.
- **The backlog ticket's 33-file list is exactly the un-annotated set** — machine-diffed against a fresh
  grep of the corpus, byte-identical, no file listed twice or omitted.
- **Line ranges in the backlog ticket are real, not hallucinated.** Spot-checked six files against actual
  content, including the three most falsifiable claims: `93.4-view-mutation` ("the file's *only* index-DDL
  statement" in a 4429-line file — confirmed, line 674), `41.7.3.1` (single statement, line 13 — confirmed),
  `102.2-unique-collation` (§§9-13 index DDL starting ~line 204 — confirmed, first at 204, last at 456).
- **Independent re-read of 5 leave-alone files** (`10.1-ddl-lifecycle`, `10.1.4-ddl-transaction-policy`,
  `06.3.3-introspection-tags`, `51.9-maintained-table-secondary-unique`, `10.4-schema-scale`) — chosen because
  they sit next to annotated siblings in the numbering and so are the likeliest misclassifications. All five
  are correct leave-alones: each file's subject is the DDL lifecycle, the pragma gate, tag metadata, maintained
  -table derivation, and schema scale respectively; the index DDL is one vehicle among several.
- **`41.7.4-alter-column-retype-semantic-memory`, flagged borderline by the implementer, re-litigated and
  upheld as leave-alone.** Most of its sections do create an index, but as a witness that a retype re-sorted
  correctly — there is no partial/expression/DESC/naming coverage, so index-DDL mechanics are not the subject.
  Annotating it would cost a downstream backend the entire retype-semantics file. Left alone.
- **`102.2-unique-collation` re-checked** for the opposite error: its index DDL spans lines 204-456, a large
  share of the file, and *is* about index-derived collation. Still correctly left alone — §§1-8 cover the same
  collation ground through inline `unique` and would be lost with the file.
- **Docs.** `packages/quereus/test/README.md` § `-- requires-capability:` directive is the cross-repo format
  spec; it deliberately carries no per-file list (the whole point is that consumers don't maintain one), so
  this sweep required no doc change. Confirmed by reading it rather than assuming. No other doc in the repo
  mentions the directive.
- **Lint + tests.** `yarn lint` from repo root: clean. `yarn workspace @quereus/quereus run test`:
  **7551 passing, 13 pending, 0 failing** — the same pass/pending shape the implementer reported, confirming
  the sweep introduced no local skip. `yarn test` across all workspaces: clean.

### Fixed in this pass (minor)

- **`logic-capabilities.spec.ts` failed opaquely on a rename.** The new test read each of the 11 filenames
  with `fs.readFileSync`, so a renamed corpus file surfaced as a bare `ENOENT` — the one failure mode the
  test's own comment claims to catch, reported as an unrelated-looking I/O error. Now asserts the filename is
  present in the directory listing first, with a message saying to update the list.
- **The backlog ticket only covered one direction of the split problem.** It listed 33 leave-alone files whose
  index DDL should be carved *out*, but not the reverse case: an annotated file with a short non-index tail a
  skipping backend also loses. Two exist and are now recorded there with line ranges — `06.3-schema` lines
  45-58 (three `schema()` queries about views) and `10.1.3-ddl-drop-in-transaction` lines 51-78 (§2,
  `alter table … drop constraint unique`, the constraint-side twin of §1, no index DDL). Both are small enough
  that whole-file annotation remains the right call today; the note exists so the eventual split pass handles
  the asymmetry instead of rediscovering it.

### New tickets filed

None. No finding in this pass was major — the classification held everywhere it was probed, and both defects
found were small enough to fix inline. The genuinely large follow-on work (splitting the 33 incidental files)
was already filed by the prereq ticket as `feat-sqllogic-split-incidental-index-ddl` and is unchanged in scope
by this review beyond the two additions noted above.

### Tripwires

None recorded. The reviewed change is comment lines in test fixtures plus one assertion loop — there is no
runtime path, no allocation, and no data structure that could degrade under future growth, so no
"fine now, matters if X" condition exists to park.

### Not done

- **`yarn test:store` (LevelDB backend) was not run.** Structurally it cannot regress here:
  `STORE_BACKEND_CAPABILITIES` in `test/logic-capabilities.ts` is the full vocabulary set — verified by the
  existing test at `logic-capabilities.spec.ts:188` that asserts both backend sets equal
  `Object.keys(SQLLOGIC_CAPABILITIES)` — so a store-mode skip is impossible regardless of which files carry
  the directive. Skipped as ~unbounded runtime for zero reachable risk, not as an oversight.
- **The 33 leave-alone files were sampled, not exhaustively re-read.** 5 of 33 re-read in full plus 6 files'
  line-range claims verified against source; the implementer's per-file reasoning was checked for internal
  consistency on the rest. Exhaustive re-reading would re-do the sweep rather than review it, and every probe
  landed correct. The residual risk is a misclassification in the unsampled 22 — bounded in blast radius: the
  failure mode is a file staying un-annotated that could have been annotated, which changes nothing locally
  and leaves a downstream backend exactly as red as it is today.

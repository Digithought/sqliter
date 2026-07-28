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
  - packages/quereus/test/logic-capabilities.spec.ts                                  # new spot-assert
  - tickets/backlog/feat-sqllogic-split-incidental-index-ddl.md                       # filled in with the 33-file leave-alone list + line ranges
difficulty: easy
---

# Sqllogic capability corpus sweep — done

## What was done

Read all 44 remaining candidate files (the 45th, `10.1.2-ddl-in-transaction.sqllogic`, was already annotated
by the prereq ticket) that execute a standalone `create index` / `create unique index` / `drop index`
statement. Classified each per the ticket's rule (annotate only when the index DDL *is* the file's subject or
threads through the whole file; leave alone when it's incidental scaffolding to reach a different code path).

Used 4 parallel research agents to do the first-pass read + classify (11 files each), then personally
re-read the source for every file the agents recommended annotating (11 files) plus a couple of the
`10.5.*` family, to verify against the actual file content rather than trusting agent output blind.

**Result: 11 new annotations** (12 total in the corpus including the prereq's one). That's slightly above the
ticket's "roughly ten" estimate but in the same ballpark — no rebalancing needed, the extra one
(`06.3-schema.sqllogic`) is an unambiguous case (the entire file is `schema()` introspection of index rows).

Annotated (all already had a leading comment block, so no file needed one added from scratch):

- `06.3-schema.sqllogic` — whole file is `schema()` introspection of `CREATE INDEX` (simple/composite/DESC),
  only a small unrelated view-listing tail at the end.
- `06.9.3-json-index-range-seek.sqllogic` — every section pairs an indexed table against an unindexed oracle;
  removing the indexes removes the comparison the file exists to make.
- `10.1.3-ddl-drop-in-transaction.sqllogic` — all 4 sections are about `DROP INDEX` mid-transaction semantics.
- `10.5-indexes.sqllogic`, `10.5.1-partial-indexes.sqllogic`, `10.5.2-expression-indexes.sqllogic`,
  `10.5.3-desc-index-ordering.sqllogic`, `10.5.4-composite-pk-index-update-phantom.sqllogic`,
  `10.5.5-index-name-uniqueness.sqllogic` — the whole `10.5.*` index family; each file's entire content is
  index-DDL mechanics (creation, partial, expression-rejection, DESC ordering, a PK-phantom regression,
  name-uniqueness).
- `47.3.1-upsert-conflict-index-derived-collation.sqllogic` — file's own header states it was carved out of
  `47.3` specifically to keep the index-derived-collation upsert path testable on backends without index DDL.
- `drop-unique-index.sqllogic` — despite the generic filename, every scenario is specifically about `DROP
  INDEX` failing to clear a synthesized unique constraint.

**33 files classified leave-alone.** `tickets/backlog/feat-sqllogic-split-incidental-index-ddl.md` now has the
concrete list with line ranges for the index-dependent scenario(s) in each — that's the input for whoever
picks up the actual splitting work later. Highlights of what's incidental-but-substantial (worth the reviewer
skimming, since these are the closest calls):

- `105-vtab-memory-mutation-kills.sqllogic` — ~15 of ~40 sections use an index to target a specific
  `module.ts`/`table.ts` mutation-kill function. Large severable subset, still incidental to the file's actual
  subject (mutation-killing the memory vtab broadly).
- `102.2-unique-collation.sqllogic` — sections 9-13 (of 13) use explicit `create unique index ... collate` for
  index-derived collation resolution, while sections 1-8 cover the same ground via inline `unique` alone.
- `06.4.2-collation-extras.sqllogic` — 3 separate index-collation blocks inside a ~580-line file whose
  majority subject is collation propagation through ORDER BY/JOIN/DISTINCT/set-ops, unrelated to indexes.
- `41.7.4-alter-column-retype-semantic-memory.sqllogic` — flagged by the classifying agent as genuinely
  borderline (most of its sections do use an index, as a witness/oracle for retype-triggered re-sorting, not
  as the tested mechanism). Left alone per the ticket's "prefer leave-alone when borderline" tie-break. If a
  future pass disagrees, this is the one file to re-litigate first.

## Validation

- **True before/after comparison**, not just an assumption: stashed all edits, ran `yarn test` in
  `packages/quereus` on the pre-edit tree (7550 passing, 13 pending, 0 failing), popped the stash, re-ran
  (7551 passing, 13 pending, 0 failing). The +1 is the new spot-assert test added below — zero change to the
  corpus's own pass/fail/skip shape, confirming the sweep didn't create any local skips or drop coverage.
- `yarn lint` from repo root — clean (quereus's real eslint + `tsc -p tsconfig.test.json --noEmit` pass
  silently; every other workspace's lint is the intentional no-op).
- Extended `logic-capabilities.spec.ts` with a new spot-assert (`declares standalone-index-ddl on every file
  whose subject is index DDL`) that iterates all 11 newly annotated files and asserts each declares the
  capability — pins the sweep's actual output, not just the mechanism the prereq ticket already covers.

## Known gaps for the reviewer

- Did not run `yarn test:store` (LevelDB backend). Not required by the ticket, and structurally this sweep
  can't cause a store-mode skip either — `STORE_BACKEND_CAPABILITIES` is also the full vocabulary set (see
  `logic-capabilities.ts`), so a store-mode skip is impossible regardless of which files carry the directive.
  Still, if the reviewer wants empirical rather than structural confidence, `yarn test:store` is the check.
- Classification was ultimately my judgment call on each of the 11 annotated + 33 left-alone files, informed
  by (but not blindly trusting) 4 parallel research agents' first-pass reads. I re-read every ANNOTATE
  candidate's actual source myself before editing; I did not re-read all 33 LEAVE files myself line-by-line —
  I spot-checked the agents' stated reasoning for internal consistency instead. If the reviewer wants to
  re-verify, the backlog ticket's per-file notes make that fast (line ranges are given).
- No new "leave alone" file was reclassified to "annotate" during my review pass — all 11 annotations came
  from the first-pass agent output, confirmed by me reading the source. This means there's some correlated
  risk if an agent and I both missed the same thing; the reviewer re-reading a small independent sample of the
  33 leave-alone files (say, 3-5) would be the cheapest way to catch that.

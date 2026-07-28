---
description: |
  Several shared SQL test files create an index only as scenery for testing something else, which means a
  database backend that has no index-creation feature can't run those files at all and loses the coverage
  they were really there for. Split the index-dependent parts out into their own files.
files:
  - packages/quereus/test/logic/                 # the affected fixtures live here
  - packages/quereus/test/README.md              # § Logic-test conventions — file naming and decimal sub-numbering
---

# Split incidental index DDL out of fixtures whose subject is something else

## What's going on

`packages/quereus/test/logic/*.sqllogic` is a shared corpus — other projects run the same files against their
own storage engine. 45 of the 281 files execute `create index` / `create unique index` / `drop index`. For about
ten of them that DDL *is* the subject; those are marked with a `-- requires-capability: standalone-index-ddl`
directive so a backend without the feature skips them cleanly (see `test/README.md` § capability directives).

The rest are the problem. Their subject is a predicate, a plan shape, a scan path, or an `alter table` behavior —
the index is there only to steer the engine down a particular code path. On a backend with no standalone index
DDL those files fail outright, so that backend loses the *whole* file's coverage, including all the scenarios that
have nothing to do with indexes. Marking them with the capability directive would be no better: it converts a
loud failure into a silent coverage hole.

The fix is to split: move the index-dependent scenarios into a sibling fixture that carries the directive, and
leave the rest of the file runnable everywhere. Decimal sub-numbering (`06.9.2` → `06.9.2.1`) already exists for
exactly this, and `47.3.1-upsert-conflict-index-derived-collation.sqllogic` is a worked precedent — it was carved
out of `47.3` for the same reason.

## Why it's backlog and not urgent

Nothing is red that isn't red today. Downstream consumers hold these files green through their own known-failure
lists, which self-retire the moment a file starts passing. This is a coverage-quality improvement for backends
that differ from quereus, not a correctness fix. It also wants doing in one deliberate pass rather than
opportunistically, so the split fixtures stay coherent and the run-order numbering stays sane.

## Expected shape of the work

- For each affected file: identify which scenarios need index DDL, move them to a sibling file with the next
  free decimal sub-number, add the capability directive plus a header comment saying what was carved out and
  from where, and confirm the parent file no longer executes index DDL.
- Keep scenarios ordered mundane → exotic within each resulting file, per `test/README.md`.
- Local pass/fail counts must not change: quereus's own backends run everything either way, so a split is a pure
  reorganization and any count change means a scenario was dropped or duplicated.
- Some files may resist splitting — an index created in setup that every later scenario depends on. Those stay
  as they are; record why in the file's header comment rather than forcing an awkward split.

## Affected files

To be filled in by the corpus-sweep ticket (`sqllogic-capability-corpus-sweep`), which classifies all 45
candidates and lands the concrete leave-alone list here. Initial expectation from filenames, unverified:
`03.9-is-bool-predicate`, `21.1-where-null-comparisons`, `100.1-where-extras`, `12-join_padding_order`,
`15.1-semantic-ordering`, `07.9-in-value-list`, `05.1-composite-pk-range-scan`, `06.3-schema`,
`06.4.2-collation-extras`, `06.9.2-json-structural-equality`, `10.4-schema-scale`, `102.1-unique-edge-cases`,
`102.2-unique-collation`, `102-schema-catalog-edge-cases`, `99-conversion-edge-cases`, `93.4-view-mutation`,
`50-metadata-tags`, `50.2-declare-schema-renames`, and the `41.*` alter-table family.

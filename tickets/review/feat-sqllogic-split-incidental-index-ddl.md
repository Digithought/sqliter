---
description: |
  Shared SQL test files that created an index only as scenery for testing something else have been split,
  so a database backend with no index-creation feature can still run the parts that never needed one.
files:
  - packages/quereus/test/logic/                 # 34 new fixtures, 36 edited parents
  - packages/quereus/test/logic.spec.ts          # MEMORY_ONLY_FILES gained two split children
  - packages/quereus/test/README.md              # § requires-capability directive — unchanged, still accurate
---

# Review: split incidental index DDL out of fixtures whose subject is something else

## What landed

Every one of the 33 fixtures the ticket listed as "index DDL is incidental scaffolding" now runs without
`create index` / `create unique index` / `drop index`. The index-dependent scenarios moved into 32 new
sibling fixtures, each carrying `-- requires-capability: standalone-index-ddl` plus a header comment saying
what was carved out, from where, and why. The 33rd file needed no sibling (see *Vehicle substitutions*).
The two annotated files that carried a non-index tail were also carved, per the ticket's second half.

New fixtures (34 total = 32 splits + 2 carve-outs from annotated files):

| Parent | New sibling |
|---|---|
| 03.9-is-bool-predicate | 03.9.1-is-bool-predicate-partial-index |
| 05-vtab_memory | 05.0.1-vtab-memory-unique-index-collation |
| 05.1-composite-pk-range-scan | 05.1.1-secondary-index-range-scan |
| 06.3-schema *(annotated; tail carved out)* | 06.3.6-schema-views |
| 06.3.3-introspection-tags | 06.3.3.1-introspection-tags-index |
| 06.4.2-collation-extras | 06.4.2.1-collation-index-access-paths |
| 06.9.2-json-structural-equality | 06.9.2.1-json-structural-equality-index |
| 07.9-in-value-list | 07.9.1-in-value-list-composite-index |
| 10.1-ddl-lifecycle | 10.1.5-create-index-lifecycle |
| 10.1.3-ddl-drop-in-transaction *(annotated; tail carved out)* | 10.1.3.1-drop-constraint-in-transaction |
| 10.1.4-ddl-transaction-policy | 10.1.6-ddl-transaction-policy-index |
| 10.4-schema-scale | 10.4.1-schema-scale-indexes |
| 12-join_padding_order | 12.1-orderby-index-consumption |
| 15.1-semantic-ordering | 15.1.2-semantic-ordering-index |
| 21.1-where-null-comparisons | 21.1.1-where-null-comparisons-secondary-index |
| 41.2-alter-column | 41.2.2-alter-column-retype-index-rebuild |
| 41.3-alter-rename-propagation | 41.3.1-alter-rename-index-propagation |
| 41.6-alter-drop-rename-constraint | 41.6.1-alter-drop-constraint-index-derived |
| 41.7.2-alter-column-collate-unique-store | 41.7.2.1-alter-column-collate-unique-index-store |
| 41.7.3-alter-column-retype-unique | 41.7.3.2-alter-column-retype-unique-index |
| 41.7.4-alter-column-retype-semantic-memory | 41.7.4.1-alter-column-retype-semantic-index-memory |
| 50-metadata-tags | 50.0.1-metadata-tags-index |
| 50.2-declare-schema-renames | 50.2.1-declare-schema-index-renames |
| 51.9-maintained-table-secondary-unique | 51.9.1-maintained-table-partial-unique |
| 53.3-materialized-view-constraint-only-ddl | 53.3.1-materialized-view-index-ddl-irrelevance |
| 54-covering-mv-enforcement | 54.1-covering-mv-partial-enforcement |
| 93.4-view-mutation | 93.4.1-view-mutation-partial-unique-cardinality |
| 99-conversion-edge-cases | 99.0.1-schema-index-listing |
| 100.1-where-extras | 100.1.1-where-join-on-order-indexed |
| 102-schema-catalog-edge-cases | 102.0.1-schema-catalog-indexed-table |
| 102.1-unique-edge-cases | 102.1.1-unique-index-creation-edge-cases |
| 102.2-unique-collation | 102.2.1-unique-collation-index-derived |
| 105-vtab-memory-mutation-kills | 105.1-vtab-memory-index-mutation-kills |
| 110-scan-emitter-mutation-kills | 110.1-scan-emitter-index-scan-kills |

Every parent got a short pointer comment where the scenarios used to be, so a reader following a section
number lands on a signpost rather than a hole. Section numbering was preserved (a moved "§ 6" is still
labelled 6 in the sibling) wherever cross-references existed.

`logic.spec.ts`'s `MEMORY_ONLY_FILES` gained `05.0.1-vtab-memory-unique-index-collation.sqllogic` and
`105.1-vtab-memory-index-mutation-kills.sqllogic` — both children of memory-only parents, memory-only for
the same reason.

## Validation

- `yarn test` — 7821 passing, 13 pending, 0 failing (the 13 pending are pre-existing skips elsewhere in
  the suite, unrelated to logic fixtures).
- `yarn test:store` — 7812 passing, 22 pending, 0 failing. 22 = the same 13 + the 9 memory-only files
  (7 pre-existing + the 2 added here). No `skipped: backend lacks capability` lines in either run, which
  is the README's own health check: a local capability skip would mean a wrong directive.
- `yarn workspace @quereus/quereus run lint` — clean (eslint + `tsc -p tsconfig.test.json --noEmit`).

## What a reviewer should look hardest at

**1. Vehicle substitutions — the judgment calls, in rough order of risk.** In four files the index was not
a separable scenario but an interchangeable way of *establishing uniqueness*, so instead of leaving the
parent gutted, the parent's tables were re-declared with an inline / table-level `unique (...)` and the
index-derived path moved to (or stayed in) the sibling. Worth confirming the substituted constraint really
exercises the same code path the scenario is about:

- `41.7.4-alter-column-retype-semantic-memory` — 12 `create unique index` → table-level `unique (v)`.
  Largest substitution. Its §1 (index-derived collision) and §4/§4c (a NON-unique index as an ordering
  witness, which has no declarative spelling at all) moved to the sibling; §4b, the unindexed leg, stayed
  as the answer the moved legs must match.
- `41.7.3-alter-column-retype-unique` — 8 `create unique index` → table-level `unique (v)`. §1 moved to
  the sibling; the parent's §2 was already the table-level twin of §1, which is what makes this safe.
- `10.1.4-ddl-transaction-policy` — the `ddl_transaction_policy` gate is verb-agnostic, so the parent's
  five index-verb cases were re-expressed with `alter table … add/drop column`, `create/drop table`, and
  the CREATE/DROP INDEX instance of all of them moved to `10.1.6`. Check §2/§3 still read coherently: they
  now use ADD COLUMN where they used CREATE INDEX.
- `41.7.3.1-alter-column-retype-staged-rows-memory` — its single `create unique index` became an inline
  `v text unique`; no sibling file. The ticket called this an arbitrary syntax choice and the file's
  subject (staged-row conversion on retype) is unchanged. This is the one listed file with no split.

**2. `10.4.1-schema-scale-indexes` duplicates its rig.** The 20-table stress rig is rebuilt in the child
rather than shared (the two files run as separate databases). Only t01/t02/t03 are populated there, since
only they are read. The parent lost its `index_count = 22` assertion; the child asserts it, plus an
`index_count = 0` after the bulk drop.

**3. One file was found outside the ticket's list.** `08.4-key-set-semi-join` executes index DDL and was
not among the 45 the corpus sweep classified — it presumably landed after that sweep. Its subject is the
KeySetSemiJoin rewrite, which only plans over a secondary-indexed column, so *every* scenario depends on
the index and there is no index-free remainder. It got a whole-file `requires-capability` directive with a
header comment explaining why splitting was impossible. Reviewer should sanity-check that call.

**4. `50-metadata-tags` still contains `ALTER INDEX` statements.** They target implicit covering indexes
(`uq_email`, `uq_expo_vin`, from inline UNIQUE constraints) and deliberately-nonexistent names — no
`create index` remains. The capability token is defined in `test/README.md` as "accepts `create index`,
`create unique index`, and `drop index` as standalone statements", so `ALTER INDEX … SET/ADD/DROP TAGS` is
outside its wording, and the ticket's classification listed only the `create index` lines. If a backend
without index DDL also cannot *parse* `ALTER INDEX`, those phases would still fail there — worth a
decision, but it is a question about the capability vocabulary, not about this split.

**5. Expected-result changes.** Two, both forced:
- `06.3.6-schema-views` asserts `SELECT DISTINCT type FROM schema()` = function/table/view. The original
  in `06.3-schema` included `index`; the carved file creates no index, so the row is genuinely absent.
  The `index` member is still asserted in `06.3-schema` itself.
- `06.3.3-introspection-tags` lost `DROP TABLE PuTable` / `DROP TABLE IdxTable` from its cleanup block
  (those tables moved out); `10.1.3-ddl-drop-in-transaction` lost `drop table drop_tx_b` likewise.
  Both were caught by the suite, not by inspection — a reminder that per-file teardown is load-bearing.

**6. Scenario-preservation spot checks.** No scenario should have been dropped or silently duplicated. The
mechanical check used was "parent no longer matches `^\s*(create (unique )?index|drop index|alter index)`,
child passes, both counts green" — which does not prove nothing was lost in the middle. The highest-value
manual diff targets are the three files split with line-range surgery rather than exact-string edits:
`06.4.2-collation-extras`, `102.2-unique-collation`, `105-vtab-memory-mutation-kills` (the last split
programmatically by section header — 17 of 40 sections moved).

## Known gaps

- Two parents kept a *slightly* reduced version of a moved scenario rather than a pointer, so that the
  index-free half stays asserted: `41.2-alter-column` §7 and §16 (the index line was removed; the inline
  UNIQUE and the value-rewrite assertions stay) and `50.2-declare-schema-renames` §21 (rewritten to the
  view-only rename; the view+index variant is in the sibling). Each is a small deliberate divergence from
  "move the whole section", noted in the file.
- Header prose in a few converted parents still says "index" where it now means the auto-built covering
  index of an inline UNIQUE. That is accurate (a UNIQUE does have a backing structure) but reads as
  ambiguous; flagged rather than mass-edited.
- No downstream consumer was exercised — the payoff of this work is on backends that lack standalone index
  DDL, and quereus's own two backends both have it, so locally every new file runs rather than skips. The
  split is verified as a pure reorganization here; whether it actually recovers coverage downstream is
  unverifiable from this repo.

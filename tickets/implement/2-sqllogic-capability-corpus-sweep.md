---
description: |
  Go through the shared SQL test files that create or drop indexes and mark the ones whose whole point is
  index creation, so a database backend without that feature skips exactly those files and keeps running
  everything else.
prereq: sqllogic-capability-directive
files:
  - packages/quereus/test/logic/                       # 45 of 281 files execute index DDL; classify them
  - packages/quereus/test/README.md                    # directive spec landed by the prereq ticket
  - tickets/backlog/feat-sqllogic-split-incidental-index-ddl.md  # update its list; do not create a second one
difficulty: easy
---

# Annotate the index-DDL-subject files with `requires-capability: standalone-index-ddl`

## Background

The prereq ticket adds the `-- requires-capability:` directive and annotates one file
(`10.1.2-ddl-in-transaction.sqllogic`). This ticket applies it to the rest of the corpus for the one capability
in the vocabulary, `standalone-index-ddl` (`create index` / `create unique index` / `drop index` as standalone
statements).

45 of the 281 files in `packages/quereus/test/logic/` execute at least one such statement. **Do not blanket-annotate
all 45** — that would skip 16% of the corpus on a backend lacking the feature, when most of those files' subjects
are something else entirely and only reach for an index as scenario setup. Blanket-annotating trades a precise
failure for a silent coverage hole, which is worse than what downstream consumers have today.

## Classification rule

Read each candidate file's header comment and its use of index DDL, then sort it into one of two buckets.

**Annotate** when either holds:

- Removing the index DDL would remove the file's reason to exist — the DDL *is* the subject (index creation,
  drop, partial/expression/desc indexes, index naming, index-derived constraints).
- The index DDL threads through the whole file such that no useful subset survives without it.

**Leave alone** when the index DDL is incidental — the file's subject is a predicate, a plan shape, a scan path,
or an ALTER behavior, and the index is only there to put the engine on a particular code path. These files stay
unannotated, keep failing on a backend that lacks the feature (exactly as they do today — no regression), and
their scenarios are candidates for splitting. Record each one in
`tickets/backlog/feat-sqllogic-split-incidental-index-ddl.md` — **update that existing file's list, do not create
a second backlog ticket.**

When a file is genuinely borderline, prefer **leave alone**: a wrongly-annotated file silently loses downstream
coverage, while a wrongly-unannotated file merely stays visibly red.

## Candidate set

All 45 files under `packages/quereus/test/logic/` matching `^\s*create (unique )?index` or `^\s*drop index`:

```
03.9-is-bool-predicate            05.1-composite-pk-range-scan        05-vtab_memory
06.3.3-introspection-tags         06.3-schema                         06.4.2-collation-extras
06.9.2-json-structural-equality   06.9.3-json-index-range-seek        07.9-in-value-list
10.1.2-ddl-in-transaction         10.1.3-ddl-drop-in-transaction      10.1.4-ddl-transaction-policy
10.1-ddl-lifecycle                10.4-schema-scale                   10.5.1-partial-indexes
10.5.2-expression-indexes         10.5.3-desc-index-ordering          10.5.4-composite-pk-index-update-phantom
10.5.5-index-name-uniqueness      10.5-indexes                        100.1-where-extras
102.1-unique-edge-cases           102.2-unique-collation              102-schema-catalog-edge-cases
105-vtab-memory-mutation-kills    110-scan-emitter-mutation-kills     12-join_padding_order
15.1-semantic-ordering            21.1-where-null-comparisons         41.2-alter-column
41.3-alter-rename-propagation     41.6-alter-drop-rename-constraint   41.7.2-alter-column-collate-unique-store
41.7.3.1-alter-column-retype-staged-rows-memory                       41.7.3-alter-column-retype-unique
41.7.4-alter-column-retype-semantic-memory                            47.3.1-upsert-conflict-index-derived-collation
50.2-declare-schema-renames       50-metadata-tags                    51.9-maintained-table-secondary-unique
53.3-materialized-view-constraint-only-ddl                            54-covering-mv-enforcement
93.4-view-mutation                99-conversion-edge-cases            drop-unique-index
```

`10.1.2-ddl-in-transaction` is already annotated by the prereq — leave it.

Starting hypothesis from filenames only, **to be verified by reading each file, not trusted**:

- Likely annotate: the `10.5*` family (`10.5-indexes`, `10.5.1-partial-indexes`, `10.5.2-expression-indexes`,
  `10.5.3-desc-index-ordering`, `10.5.4-composite-pk-index-update-phantom`, `10.5.5-index-name-uniqueness`),
  `drop-unique-index`, `06.9.3-json-index-range-seek`, `47.3.1-upsert-conflict-index-derived-collation`,
  `10.1.3-ddl-drop-in-transaction`.
- Likely leave alone: predicate/plan/scan files (`03.9-is-bool-predicate`, `21.1-where-null-comparisons`,
  `100.1-where-extras`, `12-join_padding_order`, `15.1-semantic-ordering`, `07.9-in-value-list`,
  `05.1-composite-pk-range-scan`), the `41.*` ALTER family, and the mutation-kill files.

Roughly ten annotations is the expected shape of this change. A result far from that means the rule is being
applied too loosely or too tightly — say which in the handoff.

## Edge cases & interactions

- **Files already in `MEMORY_ONLY_FILES`** (`05-vtab_memory`, `105-vtab-memory-mutation-kills`,
  `41.7.3.1-…-memory`, `41.7.4-…-memory`) may also carry a capability directive; the two mechanisms are
  independent and the harness handles both. Judge them by the same rule; don't skip them because they're already
  in the set.
- **Files whose name ends `-memory` or `-store`** are already backend-scoped. A capability directive on one is
  usually redundant — note the reasoning rather than annotating reflexively.
- **Directive placement** must be in the leading comment block. Several corpus files open with SQL on line 1 with
  no header comment; those need a header block added above it, which is fine and should carry a one-line reason.
- **Zero local behavior change is the acceptance bar.** Both quereus backends have `standalone-index-ddl`, so
  after this sweep `yarn test` must show exactly the same pass/fail/skip counts as before. Any newly skipped file
  means the capability set or the directive placement is wrong.
- The corpus-wide parse guard added by the prereq ticket covers every file touched here — a typo in any new
  directive fails that guard rather than silently disabling a file.

## Key tests

- `yarn test` — pass/fail/skip counts identical to pre-sweep. Capture both numbers in the handoff.
- The prereq's corpus guard test passes (it now parses ~10 more directives).
- Spot-assert in `logic-capabilities.spec.ts`: at least one newly annotated file (e.g.
  `10.5.1-partial-indexes.sqllogic`) declares `standalone-index-ddl`, so the sweep is pinned by a test rather
  than only by grep.

## TODO

- Read each of the 44 remaining candidate files; classify annotate / leave-alone per the rule.
- Add `-- requires-capability: standalone-index-ddl` to each annotated file's leading comment block, with a
  one-line reason in the same block.
- Update `tickets/backlog/feat-sqllogic-split-incidental-index-ddl.md` with the concrete leave-alone list and,
  where obvious, which scenarios inside each file are the index-dependent ones.
- Extend `logic-capabilities.spec.ts` with the spot-assert.
- Run `yarn test` and `yarn lint`; report before/after counts explicitly.

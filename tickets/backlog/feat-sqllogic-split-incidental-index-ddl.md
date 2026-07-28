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

The corpus-sweep ticket (`sqllogic-capability-corpus-sweep`) classified all 45 candidates that execute
standalone index DDL. 11 (plus one landed earlier) had index DDL *as their subject* and got the
`-- requires-capability: standalone-index-ddl` directive instead of a split — those are done and are not
part of this ticket. The 33 below are the leave-alone list: index DDL is incidental scaffolding, the rest of
each file is unrelated and currently unsplit. For each, the index-dependent scenario(s) are noted so the
split work doesn't have to re-discover them.

- `03.9-is-bool-predicate` — lines ~125-143: a "partial-index smoke" block (4 `create index ... where` +
  requery + drop) proving the `IS [NOT] TRUE/FALSE` predicate compiles inside a partial-index WHERE clause.
- `05.1-composite-pk-range-scan` — lines 64-80 and 82-103: two scenarios build a secondary index (one with a
  DESC leading column) purely to force a multi-column secondary-index scan path as a comparison point against
  the file's real subject (composite/DESC PK range scans).
- `05-vtab_memory` — lines 49-73: a single appended `create unique index ... collate nocase` scenario testing
  index-collation enforcement, self-contained and severable from the rest of the file (PK point/range/full-scan
  behavior).
- `06.3.3-introspection-tags` — lines 22-25 (`schema()` index tags), 120-143 (`index_info()` column-layout
  section, the heaviest index-DDL block), 183-192 (partial unique index deriving a partial unique constraint).
  Rest of file covers table/view/column/FK/check/assertion introspection tags with no index DDL.
- `06.4.2-collation-extras` — lines 140-199 (indexes with explicit per-column COLLATE, plus an expression-index
  rejection), 356-390 (COLLATE on a BETWEEN bound over an index), 458-477 (NOCASE/RTRIM secondary-index range).
  Majority of the ~580-line file (ORDER BY/JOIN/DISTINCT/set-op/MIN-MAX/CASE/BETWEEN collation) needs none.
- `06.9.2-json-structural-equality` — lines 130-172 (§6, unique index on the JSON column) and 190-206 (§8,
  retyped column + unique index), out of 12 sections total; the rest is unindexed JSON-equality coercion.
- `07.9-in-value-list` — lines 104-126: scenario (e), the one composite-index IN-list cross-product case;
  every other scenario relies on inline PK/UNIQUE (auto-indexed), not standalone `create index`.
- `10.1.4-ddl-transaction-policy` — sections 1, 2, 3, 5, 6b use `create`/`drop index` as one of several
  interchangeable "module-dispatching DDL statement" examples exercising the `ddl_transaction_policy` pragma
  gate; sections 4, 6c-6e, 7, 8 (table/alter/materialized-view/apply-schema gating) need no index DDL.
- `10.1-ddl-lifecycle` — lines 72-101 ("CREATE INDEX Lifecycle": create, `if not exists` no-op, second index,
  `schema()` visibility) and error cases at 183-201 (bad table/column, duplicate name). Rest is generic
  table/transaction DDL lifecycle.
- `10.4-schema-scale` — lines 58-79 (22 `create index` statements across a 20-table stress rig), plus index
  point-lookups at 148-152 and an `index_count` assertion at 164. The table-scale/join stress-test core needs
  none of it.
- `100.1-where-extras` — lines 126-131: one create/drop index pair proving index presence doesn't change a
  reordered-ON-clause join result (a robustness check, not index behavior). Rest is WHERE-predicate shapes.
- `102.1-unique-edge-cases` — lines 94-137 (§3, `create unique index` rejected when data already has
  duplicates) and 153-157 (one bad-case variant). Rest of the file uses inline/table-level `unique`.
- `102.2-unique-collation` — lines ~200-463 (§§9-13: explicit `create unique index` with per-column COLLATE,
  testing index-derived/multi-index collation resolution). §§1-8 (lines 33-189) cover the same collation
  ground via inline `unique` with zero index DDL and are a complete, self-sufficient subset already.
- `102-schema-catalog-edge-cases` — lines 50-68 ("Table with indexes": create/drop `idx_name`/`idx_cat`, point
  lookups). Rest is DDL round-trip, multi-schema search-path, `table_info()`, views, assertions, windows.
- `105-vtab-memory-mutation-kills` — a large mutation-kill suite; roughly 15 of ~40 sections use index DDL to
  target specific `module.ts`/`table.ts` functions: §5 index equality/prefix (99-130), §6 index range (132-176),
  §7 prefix+range composite (178-198), §8 ordering from index (200-232), §11 DESC secondary indexes (291-321),
  §16 index CRUD on populated table (506-550), §21 transaction with index modifications (656-688), §24 unique
  index enforcement (743-774), §25 savepoint + indexed table (776-809), §26 large-dataset index effectiveness
  (811-836), §31 index on non-integer types (945-965), §32 index on text column (967-983), §33 ALTER TABLE +
  index interaction (985-1013), §35 multiple secondary indexes (1043-1066), §38 DELETE with index (1114-1145),
  §39 UPDATE affecting indexed columns (1147-1174). The other ~25 sections (NULL handling, PK ordering, full-scan
  fallback, savepoints, transaction isolation, ALTER/RENAME TABLE, connection lifecycle, upsert, composite PK)
  stand alone.
- `110-scan-emitter-mutation-kills` — lines 49-65 and 118-134: two `IndexScan` sections use `create index` only
  to route onto that access-path shape, alongside the file's other `SeqScan`/`IndexSeek` sections which don't.
- `12-join_padding_order` — setup at lines 11-14 plus the "ORDER BY Consumption Tests" block (54-67): an indexed
  table forces an index-backed scan so the planner elides the Sort node. Rest is LEFT JOIN NULL-padding.
- `15.1-semantic-ordering` — lines 84-98 (secondary-index seek/range/ordering check) and 519-528 (`create unique
  index` variant of a UNIQUE-identity check already covered by a PK variant). ~20 other scenario blocks
  (TIMESPAN/JSON ordering, comparisons, PK scans, DISTINCT/GROUP BY/set-ops, windows, joins) need none.
- `21.1-where-null-comparisons` — lines 120-161: extends a "NULL must not become a seek bound" check from the PK
  column to a secondary-indexed column, reusing assertions already made against `id`.
- `41.2-alter-column` — lines 98-114 (§7, SET DATA TYPE physically rewrites + index still finds rows) and
  289-340 (§16/16b, structures keyed by the column follow the rewrite). 14 of 17 scenarios use no index DDL.
- `41.3-alter-rename-propagation` — lines 21-35, 37-53, 55-71 (§2/2b/2c, RENAME TABLE/COLUMN + partial-index
  WHERE) and 486-494 (§7, RENAME COLUMN + index expression, expected error). The CTE-shadowing matrix (§§6a-6p,
  12-14) and CHECK/FK/view propagation sections are the dominant, fully self-sufficient bulk.
- `41.6-alter-drop-rename-constraint` — lines 204-212: one negative-control case, a UNIQUE derived from
  `create unique index` cannot be targeted by `drop constraint`. The other 7 sections cover named
  CHECK/UNIQUE/FOREIGN KEY drop/rename with no index DDL.
- `41.7.2-alter-column-collate-unique-store` — lines 81-107, 109-128, 181-198, 200-212 (§3/4/6a/6b, explicit
  unique-index and partial-unique-index variants). Sections 1, 2, 5, 7, 8, 9 (the majority) use only inline
  `unique` and fully cover the collision/no-collision/composite/NULL/no-op/PK-rekey scenarios already.
- `41.7.3.1-alter-column-retype-staged-rows-memory` — line 13: the file's one UNIQUE constraint happens to be
  declared via `create unique index`, but an inline `unique` column would exercise identical staged-row/retype
  logic — an arbitrary syntax choice, not a dependency.
- `41.7.3-alter-column-retype-unique` — sections use index DDL as one of two interchangeable vehicles for
  establishing uniqueness (sections 2/3/7/7b prove the same behavior via inline/table-level `unique` with none).
- `41.7.4-alter-column-retype-semantic-memory` — indexes (unique and plain) are used throughout as
  oracles/witnesses that a column retype re-sorts correctly; no partial/expression/desc/naming coverage, so
  the tested mechanism is retype semantics, not index-DDL mechanics. Borderline — most sections do use an index.
- `50.2-declare-schema-renames` — lines 582-614, 693-728, 729-770, 771-816 (§17/20/21/22): index rename hints
  are one of three parallel object kinds (table/view/index) exercising the same rename/diff engine; no
  index-specific naming/partial/expression mechanics are tested.
- `50-metadata-tags` — lines ~95-112, ~420-568, ~945-975: `create index` only creates an object so
  `alter index ... tags` round-trips can be exercised, across the `with tags` system for every schema-object
  kind.
- `51.9-maintained-table-secondary-unique` — lines 97-120 (§5): a partial `create unique index` is incidental
  setup because a partial UNIQUE requires explicit index syntax in this engine; the scenario is about
  `maintained as` derivation-table scoping.
- `53.3-materialized-view-constraint-only-ddl` — lines 181-206 (§7b): CREATE/DROP INDEX is one example event
  in a list (alongside DROP/RENAME/ADD CONSTRAINT, ANALYZE) proving equal body-irrelevance for MV recompile
  classification.
- `54-covering-mv-enforcement` — lines 113-134 (§5): a partial `create unique index` declares the partial
  UNIQUE the partial covering materialized view proves against; not about the index itself.
- `93.4-view-mutation` — lines ~666-683: the file's *only* index-DDL statement (confirmed by whole-file grep,
  file is 4430 lines), a partial unique index used in one adversarial cross-source-SET cardinality-proof block.
  Everything else is multi-source view write-through with no index DDL.
- `99-conversion-edge-cases` — lines 253-264 ("Schema: tables with indexes"): one `create index` so `schema()`
  can list an index row alongside a table row. Rest is type-conversion edge cases and introspection functions.

Zero-behavior-change note: annotating none of these 33 keeps them exactly as red/green as they are today on a
backend without `standalone-index-ddl` — that is the whole point (see "Why it's backlog and not urgent" above).

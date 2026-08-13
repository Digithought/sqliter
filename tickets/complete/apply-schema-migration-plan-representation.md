----
description: Applying a declarative schema used to convert the schema into SQL text and then immediately read that text back again; it now carries the already-parsed form alongside the text and skips the re-read, while the human-readable preview is unchanged.
files: packages/quereus/src/schema/schema-differ.ts, packages/quereus/src/runtime/emit/schema-declarative.ts, packages/quereus/src/core/database.ts, packages/quereus/src/util/ast-spine-clone.ts, packages/quereus/bench/apply-schema-split.mjs, packages/quereus/test/schema-differ.spec.ts, packages/quereus/test/declarative-equivalence.spec.ts, packages/quereus/test/index-ddl-roundtrip.spec.ts, packages/quereus/test/covering-structure.spec.ts, docs/schema.md, docs/schema-rename-detection.md, docs/materialized-views.md
----

# What landed

`computeSchemaDiff`'s four create buckets changed element type from `string` to
`MigrationCreate` (`{ sql, ast }`), and `generateMigrationDDL`'s body moved to a new
exported `generateMigrationPlan(diff, schemaName): MigrationStep[]` — the single ordering
authority. `generateMigrationDDL` keeps its exact signature as `plan.map(s => s.sql)`, so
`diff schema` and all ~30 existing call sites are untouched. Creates and the
`set maintained as` re-attach carry the statement they were rendered from; renames, drops,
column/constraint alters and `SET TAGS` stay text-only. The pairing helpers
(`freshTableCreate` / `viewCreate` / `indexCreate` / `assertionCreate`) each render their
own text from the statement they are given, so text and AST cannot disagree by
construction.

`apply schema` walks the plan and executes a create's statement instead of re-lexing the
DDL it just produced (`Database._execAstWithinTransaction`, the AST-taking twin of
`_execWithinTransaction`). Both branches log and report `step.sql`, so error text is
byte-identical either way.

Review added the one thing that made that swap safe: the executed statement is a **spine
clone**. See *Review findings*.

# Review findings

Reviewed the implement commit `b9a3a5f0` diff first, then the work a rate-limited prior
review run had already landed (swept into `b25906d5`: doc retargeting of eight stale
`generateMigrationDDL` references in `docs/materialized-views.md` and
`docs/schema-rename-detection.md`, DRY-ing `_execWithinTransaction` onto
`_execAstWithinTransaction`, lifting a 15-line comment out of the loop body, and a
property test that re-parsing each create's own `sql` reproduces its `ast`). All of that
was re-read and kept.

## Major — found and fixed in this pass

**`apply schema` let the catalog alias the stored declaration, so a later rename silently
rewrote the declaration.** Two pre-existing facts combined badly with the new AST path:
`emitCreateView` stores the `select` subtree it is handed as `ViewSchema.selectAst` (the
assertion and maintained-table paths do the same), and `ALTER TABLE … RENAME TO` /
`RENAME COLUMN` rewrite those catalog bodies **in place**. The schema qualifiers in the
differ spread only the outermost node, so a step's body subtree is the declaration's own
on *every* target schema, not only `main` — the implement handoff's `NOTE` understated
the sharing and asserted "the planner/builder treat statement ASTs as read-only", which
is false.

Reproduced, then isolated to this change: declare a table and a view over it, apply, then
`alter table t rename column qty to amount`. Before the fix, the stored declaration's view
body was rewritten to `amount` and `diff schema` reported only the column drift; the
pre-change text path (reproduced in-process by executing `generateMigrationDDL`'s strings)
correctly reported `DROP VIEW v` + recreate as well. Fixed by spine-cloning each step's
AST at the execution seam (`spineCloneAst`, the existing helper written for exactly this —
"a caller that wants to compute what a rewrite would produce without touching the live
catalog AST must rewrite a copy"). One site, `runBatchedMigrationLoop`.

Two regression tests added to `declarative-equivalence.spec.ts` § *apply executes the plan
AST*, one per rename kind: after an apply, an imperative rename leaves the declaration
deep-equal to a pre-rename `structuredClone`, **and** the drift is still visible in a
re-diff. Both were confirmed to fail with the clone removed and pass with it.

## Major — measurement corrected, follow-up filed

**The headline speedup in the implement handoff was measured without the clone the
correctness fix requires, and most of it does not survive.** `spineCloneAst` copies the
whole statement to protect the few subtrees the catalog keeps, so it costs about what the
parse it replaced cost. Measured over the 68 creates of `bench/apply-schema-split.mjs`
(median of 15, one process, warm): clone 0.91 ms vs parse 1.07 ms on the 20.4 KB
declaration; clone **3.57 ms vs parse 3.13 ms** on the 112.7 KB one — i.e. net negative on
the large case in isolation. Re-running the harness's own A/B with the clone included:

| declaration | text path (pre-change) | AST path (current) | delta |
|---|---|---|---|
| 20.4 KB | 4.37 ms | 4.25 ms | 0.11 ms (2.6% of the loop) |
| 112.7 KB | 9.94 ms | 9.17 ms | 0.77 ms (7.8% of the loop) |

Previously reported as 25.9% / 37.6%. The in-apply parse leg is still genuinely zero (the
only parse call left in an `apply schema` is the `apply schema main` statement itself), so
the ticket's stated acceptance target is met — it is the *net* that shrank. Numbers
corrected in `docs/schema.md` and in a `NOTE:` at the clone site. Filed
`backlog/debt-catalog-aliases-caller-ast` for the fix that reclaims it: move ownership
into the create emitters so each copies only what it retains, then drop the blunt clone.
Not fixed here — it touches several emitters and changes the cost of imperative DDL too,
which is a scope call, not a review edit.

## Minor — fixed in this pass

- `bench/apply-schema-split.mjs`'s `ast` arm bypassed the loop and so would have measured
  a path that no longer exists; it now spine-clones exactly as `runBatchedMigrationLoop`
  does. Its header also said "delete after the numbers are recorded" while the sibling
  ticket `apply-schema-unchanged-fast-path` still needs it — retargeted to say so.
- `docs/schema.md` claimed a create's execution error "carries the source location of the
  declaration" without saying where a caller sees it. The `Failed to execute DDL: …`
  wrapper passes no line/column of its own, so the declaration-sited location is on the
  *cause*. Clause added.

## Checked, nothing to do

- **`serializeSchemaDiff`'s output shape changed** (creates now serialize as `{ sql, ast }`
  objects). The implementer flagged this as a judgment call. It is not re-exported from
  `packages/quereus/src/index.ts` and no other workspace imports `schema-differ`, so the
  blast radius is in-repo and currently zero callers. The doc comment the implementer
  added is the right weight; no ticket.
- **Error text and log parity** — both branches read `step.sql`; verified by reading, and
  `test/logic/50-declarative-schema.sqllogic` and `test/schema/catalog.spec.ts` pass
  unmodified (neither appears in the diff), which is what pins `diff schema` preview text.
- **The two round-trip deltas the implementer could not prove** (collation-name case,
  `moduleArgs: {}` vs absent) are now covered by the prior review run's property test over
  every create form, which whitelists exactly those two and fails on a third.
- **Source size** — `schema-differ.ts` is 3,112 lines (`wc -l`), up from the 3,013 already
  recorded on `backlog/debt-oversized-source-files`; that ticket owns the theme, and ~50
  lines of this change is not a new arm worth adding. `schema-declarative.ts` is 571.
- **Logical (lens) schemas** emit no plan and never enter the loop — unchanged by
  construction, lens tests green.

## Empty categories

- **No new `fix/` or `plan/` tickets.** The one correctness finding was a regression of
  the change under review, reachable in a single line at a single site, so it belonged in
  this pass rather than a queue.
- **No accepted-tradeoff `NOTE:`s were overridden** — grepped the touched sites; none
  carried one.

## Tripwires parked in code

- `runtime/emit/schema-declarative.ts`, above `runBatchedMigrationLoop` — `NOTE:` with the
  measured clone-vs-parse numbers and the condition that makes it worth acting on ("if
  apply latency ever matters"), pointing at `debt-catalog-aliases-caller-ast`.
- The implement stage's `NOTE:` at the same site was **removed, not kept**: it recorded the
  aliasing as safe-because-builders-are-read-only, which this review disproved.

# Validation

- `yarn test` — green, 0 failing (9567 + 387 + 156 + 89 + 78 + 89 + 1710 + 725 + 85 + 31 +
  34 + 134 + 22 passing across workspaces; +10 over the implement handoff: 8 from the prior
  review run's property test, 2 from this pass's rename regressions).
- `yarn lint` — clean, including the `tsc -p tsconfig.test.json --noEmit` pass over the
  spec files.
- `yarn docs:check` — links, invariants, size ratchets and tier declarations all OK.
- `yarn build` — clean (needed for the bench harness, which runs against `dist/`).

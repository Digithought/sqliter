---
description: Re-applying a declarative schema that has not changed now remembers what both sides looked like last time and skips the comparison, cutting a no-op re-apply by well over half.
files: packages/quereus/src/schema/catalog-rendering.ts, packages/quereus/src/schema/declared-schema-manager.ts, packages/quereus/src/schema/schema-hasher.ts, packages/quereus/src/schema/catalog.ts, packages/quereus/src/runtime/emit/schema-declarative.ts, packages/quereus/test/apply-schema-unchanged-fast-path.spec.ts, packages/quereus/bench/apply-schema-unchanged.mjs, docs/schema.md
difficulty: medium
---

Implemented from `tickets/implement/apply-schema-unchanged-fast-path.md`, itself split from
[issue #29](https://github.com/gotchoices/quereus/issues/29). Read this handoff as a starting
point — the tests below are a floor, and § *Known gaps* is honest about what is not covered.

## What landed

`apply schema` (physical branch only) now keeps, per `Database` and per lowercased schema name,
an **applied-state snapshot**: what the declaration rendered to, what the live catalog rendered
to, and the effective `default_collation`, as of the end of the last successful apply whose
migration plan came out **empty**. On the next apply both sides are re-rendered and compared; on
a three-way match `computeSchemaDiff` and `generateMigrationPlan` are skipped. Nothing else
changes — the seed loop, the empty-plan hook behaviour, and schema events are untouched.

New / changed pieces:

- **`src/schema/catalog-rendering.ts` (new)** — `renderCatalogForComparison(catalog)`. One arm per
  catalog interface, each destructuring **every** field and passing the rest to a
  `Record<string, never>` guard, so a new field on `CatalogTable` / `CatalogView` / `CatalogIndex` /
  `CatalogAssertion` fails the build until someone decides whether it belongs. (Verified by
  temporarily adding a field: `tsc` errors at the guard.) Categories are rendered then sorted, so
  live `Map` insertion order cannot matter. `CatalogView.select`, `CatalogAssertion.check` and
  `CatalogTable.maintained.select` are deliberately **not** rendered — the differ consults those
  ASTs only when the corresponding `definition` / `bodyHash` comparison already failed, which the
  fast path can never reach.
- **`src/schema/schema-hasher.ts`** — extracted `renderDeclaredSchemaCanonical`, tags-**inclusive**.
  `computeSchemaHash` now calls it on the tag-stripped copy, so the version hash is unchanged.
  Both sites carry a comment on why they differ.
- **`src/schema/declared-schema-manager.ts`** — `AppliedSchemaSnapshot`, `getDeclaredRendering`
  (memoized), `getAppliedSnapshot`, `setAppliedSnapshot`.
- **`src/schema/catalog.ts`** — a pointer comment on each `Catalog*` interface saying a new field
  needs an arm in the renderer, and that the compiler enforces it.
- **`src/runtime/emit/schema-declarative.ts`** — the check and the record, with the rollback
  tripwire `NOTE:` at the write site.
- **`bench/apply-schema-unchanged.mjs`** — rewritten as the acceptance harness (below).
  `bench/apply-schema-split.mjs` deleted per the ticket.

## Measured result (acceptance)

`node bench/apply-schema-unchanged.mjs [0|14|30]`, median of 9, one Windows box. The harness now
times both shapes **in the same warm process**, forcing the full-diff path by poisoning the
snapshot before each timed run — timing the genuine first re-apply instead compared a cold sample
against a warm median and reported a flattering 88%.

| declaration | full-diff no-op | fast-pathed no-op | |
|---|---|---|---|
| 20.4 KB | 1.52 ms | 0.64 ms | 58% off |
| 62.9 KB | 3.13 ms | 1.14 ms | 64% off |
| 112.7 KB | 5.64 ms | 1.52 ms | 73% off |

Acceptance was "`computeSchemaDiff` no longer appears in a fast-pathed apply and the total drops by
at least half at every size" — met. `computeSchemaDiff` (0.86 / 2.30 / 4.35 ms) is replaced by a
catalog render (0.17 / 0.40 / 0.56 ms) plus a string compare (0.004 / 0.012 / 0.017 ms);
`collectSchemaCatalog` (0.26 / 0.46 / 0.67 ms) is still paid on both paths.

`renderDeclaredSchemaCanonical` alone — the number the persisted-snapshot backlog ticket's ceiling
depends on — measures **0.19 / 0.53 / 0.88 ms**. (The plan stage had inferred ≈1.26 ms at the top
size from `computeSchemaHash` minus its FNV leg; the real figure is lower.)

## Two deliberate deviations from the implement ticket

Both are worth a reviewer's attention because they contradict a literal line of the spec.

**1. `setDeclaredSchema` invalidates the memoized rendering but NOT the snapshot.** The ticket's
TODO said to invalidate both; its own edge-case list said a byte-identical re-`declare schema`
must still hit the fast path. Those conflict — clearing the snapshot on redeclare makes the
byte-identical case impossible. Kept the edge case: a snapshot is a claim about a *pair* of
renderings ("these two were once verified equal"), and the next apply re-renders the new
declaration and compares, so a real edit fails the compare on its own. `removeDeclaredSchema`
still clears both.

**2. A migrating apply neither refreshes nor clears the snapshot.** Same reasoning: the pair-fact
stays true. The practical effect is good — after `drop table x` + a repairing apply, the catalog
renders back to what the snapshot recorded, so the *next* apply is fast immediately rather than
paying one more full diff. Pinned by *"a repair restores the catalog the surviving snapshot
describes"*, which asserts the post-repair rendering equals the recorded one.

If a reviewer disagrees with either, the change is one line each in
`declared-schema-manager.ts` / `schema-declarative.ts` — but the tests above would need updating,
so please read their rationale first.

## Use cases to exercise

- **The intended win.** A long-running or multi-tenant host, a test suite, or any code calling
  `apply schema` defensively, several times per process against an unchanged declaration.
- **NOT the reopen case.** One apply per process still pays the full diff — the snapshot is
  in-memory and empty on the first apply. That remains
  `backlog/feat-apply-schema-persisted-catalog-fingerprint`.
- **Anything that drifts the catalog out of band** must still be reconciled: `drop table` / `view`
  / `index` / `assertion`, `alter table … add / drop / rename column`, `rename to`, `set tags`.
- **Tag-only edits on either side** — the case a tag-stripped version hash would silently skip.
- **`apply schema … with seed`** after rows were deleted: the seeds must come back.

## How to validate

```
yarn build && yarn test && yarn lint      # all green: 9597 passing in packages/quereus, 0 failing
node packages/quereus/bench/apply-schema-unchanged.mjs 30
```

`packages/quereus/test/apply-schema-unchanged-fast-path.spec.ts` — 30 tests. Two kinds:

- **Behavioural**, driving only public SQL/API surface (drift reconciles, seeds re-run, hooks and
  events stay silent, `diff schema` still reports drift, a stricter `rename_policy` is a no-op).
- **White-box**, because a skipped diff and an empty diff are by design indistinguishable. The
  helper `plantSnapshot` records a *lying* snapshot claiming the currently-drifted catalog was the
  verified-equal one; an apply that repairs the drift did a full diff, one that leaves it did not.
  Every "the diff really is skipped" test rests on that helper, and there is a negative control
  next to it. **A reviewer should sanity-check this device before trusting the tests that use it.**

Also verified by hand, not by an automated test: adding a field to `CatalogAssertion` makes
`tsc -p tsconfig.json --noEmit` fail inside `catalog-rendering.ts` at the exhaustiveness guard.

## Known gaps

- **No test drives the `CatalogIndex.implicit` arm** — that needs a UNIQUE constraint tagged
  `quereus.expose_implicit_index`. The field is rendered; nothing pins that it is.
- **No store-backend run.** `yarn test:store` was not run (slow). The renderer reads only catalog
  structures, but `collectSchemaCatalog` surfaces exposed implicit indexes differently on
  memory vs store, so the store path renders a shape memory never produces. Worth one run.
- **The exhaustiveness guard is compile-time only, and covers fields, not semantics.** A field
  added *and* rendered but rendered in a way that loses information (say, a new AST field summarised
  by an already-present hash) would compile and could produce a wrong skip. The guard forces the
  decision; it cannot check it.
- **The declared-side memo assumes nothing mutates a stored declaration AST in place.** That
  invariant is why `runBatchedMigrationLoop` spine-clones create steps and is pinned by
  `declarative-equivalence.spec.ts` § "apply executes the plan AST" — but the memo now depends on
  it too, and nothing says so at the clone site.
- **Logical schemas are untested against this change.** They return before catalog collection, so
  they are trivially unaffected, but no test asserts that no snapshot is ever recorded for one.
- **Memory cost is larger than the plan predicted.** The rendered catalog is 309 KB at the 112.7 KB
  declaration size (the plan estimated ~120 KB) because the rendering keeps `ddl` *and* the
  structured fields, deliberately. Recorded as a tripwire on `AppliedSchemaSnapshot` with the
  revisit condition (hash instead of store, at 3× the compare cost) — see below.
- **`bench/apply-schema-split.mjs` is gone**, as the ticket required. Its clone-vs-parse numbers
  survive in `docs/schema.md` § Migration Order and in the comment above `runBatchedMigrationLoop`,
  but the harness that produced them does not, so they cannot be re-derived exactly. The comment
  now says so.

## Tripwires recorded (not tickets)

- `src/schema/declared-schema-manager.ts`, on `AppliedSchemaSnapshot` — the two renderings are held
  per schema for as long as the declaration lives (309 KB + 109 KB measured at the top bench size,
  ~4× the declaration's DDL). If many large schemas ever show up in a heap profile, the trade to
  revisit is hashing the catalog rendering instead: FNV-1a over 119 KB measured 1.46 ms, three
  times the string compare it would replace, plus a small collision risk.
- `src/runtime/emit/schema-declarative.ts`, at the snapshot write site — catalog DDL is not rolled
  back today, so a transaction unwinding after an apply cannot leave the snapshot describing a
  state the catalog is not in. If catalog DDL ever becomes rollback-able, the snapshot must be
  invalidated on rollback.

## Filed separately

`tickets/backlog/bug-declare-table-tags-example-does-not-parse.md` — found while writing the
tag-drift test: the `docs/sql-ddl.md` example showing `table customer with tags (…) { … }` does not
parse (the tag list has to follow the body). Unrelated to this change; not fixed here.

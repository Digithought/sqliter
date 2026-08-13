---
description: Re-applying a declarative schema that has not changed still compares the whole declaration against the database every time; remember what both sides looked like at the end of the last successful apply and skip the comparison when neither has moved.
files: packages/quereus/src/runtime/emit/schema-declarative.ts, packages/quereus/src/schema/catalog.ts, packages/quereus/src/schema/catalog-rendering.ts (new), packages/quereus/src/schema/schema-hasher.ts, packages/quereus/src/schema/declared-schema-manager.ts, packages/quereus/src/schema/schema-differ.ts, packages/quereus/bench/apply-schema-unchanged.mjs, docs/schema.md
difficulty: medium
---

Split out of `tickets/plan/apply-schema-unchanged-fast-path.md`, itself split from
[issue #29](https://github.com/gotchoices/quereus/issues/29) § *Related, lower priority*.
The plan stage measured the candidate signals and settled the design; this ticket builds it.

## What happens today

`emitApplySchema` (`runtime/emit/schema-declarative.ts:218`) always walks the full path for a
physical schema: resolve the declaration, `collectSchemaCatalog(db, schemaName)`,
`computeSchemaDiff(...)`, `generateMigrationPlan(...)`. Only *after* the diff does a fast path
exist — an empty plan skips `runBatchedMigrationLoop`, so no module batch hooks fire. The diff
itself is never skipped, so an application that re-applies an unchanged declaration pays for a
full comparison to be told nothing changed.

## Measurement (this is what decided the design)

`packages/quereus/bench/apply-schema-unchanged.mjs` (written during the plan stage, in the tree)
times a **no-op** `apply schema main` — one where the catalog already matches — on a synthetic
54-table / 14-view declaration at three sizes. Median of 9, Node on the plan author's Windows
box; treat the ratios as the finding and the absolute numbers as one machine's.

| declaration | no-op apply total | `collectSchemaCatalog` | `computeSchemaDiff` | statement floor (parse+plan+emit) |
|---|---|---|---|---|
| 20.4 KB | 1.35 ms | 0.27 ms (20%) | 0.91 ms (67%) | 0.17 ms |
| 62.9 KB | 3.40 ms | 0.55 ms (16%) | 2.29 ms (67%) | 0.56 ms |
| 112.7 KB | 5.21 ms | 0.72 ms (14%) | 3.93 ms (76%) | 0.56 ms |

The diff is two thirds to three quarters of the cost and grows with declaration size; collecting
the catalog is a small, slowly-growing minority. So the prize is **skipping the diff**, and
paying for another catalog collection to do it safely is a good trade.

Candidate "nothing changed" signals, priced at the same three sizes:

| signal | 20.4 KB | 62.9 KB | 112.7 KB | notes |
|---|---|---|---|---|
| `computeSchemaHash(declared)` | 0.55 | 1.11 | 2.72 ms | uncached; memoizable at `declare schema` time |
| catalog collect + render + FNV-1a hash | 0.50 | 0.95 | 2.24 ms | hashing 119 KB of text in JS costs 1.46 ms at the top size |
| **catalog collect + render + exact string compare** | **0.32** | **0.62** | **0.79** | render 0.05–0.07 ms; compare 0.003–0.008 ms |
| live-object identity snapshot | 0.005 | 0.010 | 0.012 ms | reference-equality over the 68 live schema objects |
| epoch counter | ~0 | ~0 | ~0 ms | integer compare |

## The design

Keep, per `Database` and per schema name, an **applied-state snapshot**: what the declaration
rendered to and what the live catalog rendered to at the end of the last successful apply whose
migration plan came out empty. On the next apply, re-render both; if both strings and the
effective `default_collation` are unchanged, skip `computeSchemaDiff` and `generateMigrationPlan`.

Expected no-op apply after the change: **~0.5 / ~1.2 / ~1.4 ms** at the three sizes — 63% / 65% /
74% off, with `computeSchemaDiff` gone from the profile entirely.

### Why this and not the alternatives

- **Epoch counter on `SchemaManager` (what the plan ticket tentatively favoured) — rejected.**
  Free to check, but every catalog mutation site must remember to bump it, and a missed site is a
  silent wrong-skip. There are 25+ `notifyChange` sites across `schema/manager.ts`,
  `runtime/emit/alter-table.ts`, `runtime/emit/materialized-view-helpers.ts`,
  `runtime/emit/create-view.ts`, `runtime/emit/drop-view.ts` and `runtime/emit/analyze.ts`. The
  measurement says the counter buys 0.32–0.79 ms over the chosen design — single-digit
  milliseconds, once per repeated apply — which does not pay for a permanent
  remember-to-call-this obligation on six files.
- **Live-object identity snapshot — rejected, same reason, smaller.** Comparing the *references* of
  the live `TableSchema` / `IndexSchema` / `ViewSchema` / assertion objects is nearly free
  (0.005–0.012 ms) and the references were verified stable across nine consecutive no-op applies.
  Its soundness rests on "no live schema object's content is ever mutated in place", and the engine
  deliberately *does* mutate view / maintained-table body ASTs in place during rename propagation
  (`renameTableInAst` / `renameColumnInAst`; see `catalog-persistability.ts:39`). Every such site
  today also swaps the owning record, so the invariant currently holds — but it is an invariant
  nobody is currently required to maintain, and breaking it is invisible until a schema change is
  silently skipped.
- **Hashing the rendered catalog instead of storing it — rejected.** FNV-1a over 119 KB in JS costs
  1.46 ms, three times the string compare it replaces, and buys a (tiny) collision risk. Storing
  the rendered string costs memory proportional to the schema's DDL (~120 KB per schema at the top
  size measured) and makes the comparison exact.
- **`options (assume_unchanged = true)` — rejected.** The caller asserts a precondition the engine
  cannot check, and it breaks the first apply on a fresh database (which must actually create
  everything). An embedder who genuinely knows nothing changed can already achieve this by not
  calling `apply schema`.
- **Reusing `computeSchemaHash` for the declared side — rejected, and this is a trap worth naming.**
  That function *strips tags* before hashing, deliberately, because tags must not affect schema
  versioning (`schema-hasher.ts:10`). But the differ **does** diff tags and emits `SET TAGS` steps
  for them. A tag-only edit to a declaration leaves `computeSchemaHash` unchanged, so reusing it
  would produce a wrong skip. The fast path needs a tags-**inclusive** rendering.

### What gets skipped, and why that is sound

The snapshot is written **only** when the just-finished apply (a) did not throw, and (b) produced
an empty migration plan — i.e. this process observed, via a real diff, that the catalog matches the
declaration. So at write time `catalog ≡ declaration`.

`computeSchemaDiff(declared, catalog, renamePolicy, defaultCollation)` reads nothing but its four
arguments. On a hit, `declared` and `catalog` render identically to the recorded strings and
`defaultCollation` is equal, so the only free input is `renamePolicy` — which is inert when there
are no differences (no name-change pairs for a policy to police). `allow_destructive` likewise only
gates a non-empty `diff.maintainedModuleMigrations`. Therefore the diff would again be empty, and
skipping it is behaviour-preserving.

Two consequences of "only record after a verified-empty plan" that are features, not accidents:

- The very first apply on a fresh database migrates, so it records nothing; the *second* apply does
  a full diff, finds it empty, and records. The third and later applies are fast. This preserves
  `apply schema`'s self-healing property — if DDL generation were ever imperfect, a repeat apply
  still re-diffs rather than being told by a cache that everything is fine.
- A failed apply (a mid-migration DDL failure, a seed failure) records nothing, so the next apply
  reconciles in full.

### Pieces to build

**`src/schema/catalog-rendering.ts` (new)** — `renderCatalogForComparison(catalog: SchemaCatalog):
string`. One arm per catalog interface, each destructuring **every** field and passing the rest to a
compile-time exhaustiveness guard, so a new field on `CatalogTable` / `CatalogView` / `CatalogIndex`
/ `CatalogAssertion` fails the build until someone decides whether it belongs in the rendering:

```ts
/** Compile error if a catalog interface grows a field this renderer does not consider. */
function assertEveryFieldConsidered(_leftover: Record<string, never>): void {}

function renderTable(t: CatalogTable): string {
	const { name, ddl, columns, primaryKey, referencedTables, tags, namedConstraints, maintained, ...rest } = t;
	assertEveryFieldConsidered(rest);
	// ...
}
```

Three fields are deliberately rendered **via their canonical string rather than their AST**, and
each needs the argument written at the site: `CatalogView.select`, `CatalogAssertion.check` and
`CatalogTable.maintained.select`. The differ compares `definition` (respectively `bodyHash`) first
and only consults the AST when that comparison *fails*, to tolerate rename artifacts —
`schema-differ.ts:750`, `:950`, `:2292`. Since the fast path fires only when every `definition`
matches, the AST-tolerant path is unreachable, so the canonical strings fully determine the outcome.

Sort each category by lowercased name before joining, so a drop+recreate that only changes the live
`Map` insertion order does not produce a spurious miss.

`ddl` is already computed by `collectSchemaCatalog` and is included, alongside the structured
fields, deliberately redundantly — the redundancy is free and removes any need to argue about what
`generateTableDDL` does or does not render. `CatalogTable.columns[].defaultValue` is an
`AST.Expression`; render it with `expressionToString` (the same function `catalog.ts` uses). If that
turns out to cost meaningfully at the 112.7 KB size, dropping it and relying on `ddl` (which renders
defaults) is acceptable — but then say so in a comment, with the number.

**`src/schema/schema-hasher.ts`** — extract `renderDeclaredSchemaCanonical(declaredSchema):
string`: the `isLogical` prefix plus `generateDeclaredDDL(declaredSchema).join('\n')`, with **no**
tag stripping. `computeSchemaHash` keeps its current behaviour by calling it on the tag-stripped
copy. One renderer, two callers; the strip stays only on the version-hash path. Leave a comment on
each explaining why they differ (versioning ignores tags; reconciliation does not).

**`src/schema/declared-schema-manager.ts`** — two additions, both per lowercased schema name:

```ts
/** What both sides rendered to at the end of the last successful, no-op apply. */
interface AppliedSchemaSnapshot {
	/** `renderDeclaredSchemaCanonical` of the declaration that was applied. */
	declaredRendering: string;
	/** `renderCatalogForComparison` of the live catalog after the apply completed. */
	catalogRendering: string;
	/** The effective `default_collation` — a differ input outside both renderings. */
	defaultCollation: string;
}
```

- `getDeclaredRendering(schemaName)` — lazily computes and memoizes
  `renderDeclaredSchemaCanonical` for the stored declaration. Paid once per `declare schema`, on the
  first apply after it — the apply that is going to do real work anyway.
- `getAppliedSnapshot` / `setAppliedSnapshot` / and invalidation of **both** the memoized rendering
  and the snapshot in `setDeclaredSchema` and `removeDeclaredSchema`.

**`src/runtime/emit/schema-declarative.ts`** — wire it into `emitApplySchema`, physical branch only:

1. resolve declaration, logical branch, ensure schema exists — unchanged;
2. `collectSchemaCatalog` — unchanged;
3. render the catalog, read the memoized declared rendering and the snapshot; on a three-way match,
   skip steps 4–6;
4. `computeSchemaDiff`;
5. destructive-acknowledgement gate;
6. `generateMigrationPlan` + `runBatchedMigrationLoop` (still guarded by the existing empty-plan
   check, so batch hooks keep their current behaviour);
7. seed step — **unchanged, runs on both paths** (see below);
8. on success: if the plan was empty (or the fast path fired), record the snapshot using the
   catalog rendering already in hand. If the plan was non-empty, record nothing — the next apply
   re-diffs and records then.

### `with seed`: seeds always run

The fast path elides the diff and the plan, nothing else. `apply schema … with seed` runs its seed
loop exactly as it does today, so a table emptied since the last apply gets its seed rows back —
the behaviour a user relies on and the only reading consistent with "observably indistinguishable
from a full apply whose diff came out empty". Seeding is already idempotent
(`ON CONFLICT (<pk>) DO NOTHING`), so the repeat costs no correctness. Document in
`docs/schema.md` § Seed Data.

### What is deliberately untouched

- `diff schema` — a preview; no cache read, no cache write, ever.
- `explain schema` — keeps returning the tag-stripped version hash. The two renderings answer
  different questions and must not be conflated.
- Logical schemas / lenses — the `declaredSchema.isLogical` branch returns before catalog
  collection and has real side effects on every apply (lens compile, snapshot rotation,
  `notifyLensDeployment`). No fast path there.
- Reserved-tag **advisories**. `computeSchemaDiff` raises tag diagnostics; the `severity:'error'`
  ones throw, so an apply that recorded a snapshot never had one. The `severity:'warning'` ones go
  to a debug logger (`schema-differ.ts:500`) and are not re-logged on a fast-pathed apply. Note this
  in the doc; it is the one observable difference and it is debug-log-only.

## Edge cases & interactions

Each of these wants a test; the parenthetical is the expected outcome.

- **Out-of-band `drop table` between two applies** (catalog rendering differs → full reconcile
  recreates the table). Same for `drop view`, `drop index`, `drop assertion`.
- **Out-of-band `alter table … add column` / `drop column` / `rename column` / `rename to`** (full
  reconcile; the declared shape is restored).
- **Tag-only drift on either side.** `alter table t set tags (…)` out of band → catalog rendering
  differs → reconcile emits the `SET TAGS` step. A re-`declare schema` differing *only* in a tag →
  declared rendering differs → reconcile. This second case is the one `computeSchemaHash` would get
  wrong; test it explicitly.
- **Re-`declare schema` with byte-identical text** → renderings equal → fast path still fires.
- **`default_collation` changed between applies** → snapshot mismatch → full reconcile.
- **`rename_policy` / `allow_destructive` differing between applies** → argued inert; assert an
  apply with `options (rename_policy = 'error')` after a fast-path-eligible apply behaves exactly as
  it does today.
- **A second `Database` over the same store** — its own `DeclaredSchemaManager`, empty snapshot map,
  so it always reconciles first. The fast path does not change what one connection can see of
  another's changes; it inherits whatever this connection's catalog shows.
- **Store reopen against persisted state changed out of band** — new `Database`, no snapshot, full
  reconcile. This is also why the fast path does *not* help the once-per-process-start case; see the
  scope note below.
- **`with seed`**: apply with seed → `delete from` a seeded table → apply with seed again on the
  fast path → the seed rows are back.
- **Module batch hooks**: register a module recording `beginSchemaBatch` / `endSchemaBatch`; a
  fast-pathed apply must fire **neither**, matching today's empty-plan behaviour.
- **Schema events**: subscribe via `db.onSchemaChange`; a fast-pathed apply must emit nothing,
  matching today's empty-plan behaviour.
- **`diff schema` after a fast-pathed apply** still reports real drift (introduce drift, run
  `diff schema`, expect the DDL rows).
- **Failed apply records nothing**: force a mid-migration failure (a module that rejects one DDL),
  then a subsequent apply must do a full reconcile.
- **Per-schema keying and case-insensitivity**: `apply schema MyApp` then `apply schema myapp` share
  one entry; two different attached schemas keep independent entries and do not cross-contaminate.
- **`analyze`** swaps the table schema to carry new statistics. If that leaves the rendering
  unchanged the fast path still fires — correct, since statistics are not diffed. If it changes the
  rendering, the result is one extra full diff. Either is acceptable; assert whichever holds so the
  behaviour is pinned rather than accidental.
- **Rollback.** Catalog DDL is not rolled back today (see the comment above `emitApplySchema`), so a
  transaction that unwinds after an apply cannot leave the snapshot describing a state the catalog
  is not in. Put a `NOTE:` tripwire at the snapshot write site: *if catalog DDL ever becomes
  rollback-able, this snapshot must be invalidated on rollback.*

## Scope note: this does not help the once-per-process reopen

The motivating scenario in issue #29 is an application that declares and applies the same schema
once at every start. That is **one apply per process**, and an in-memory snapshot is necessarily
empty on the first one — so that case keeps paying the full diff. What this ticket buys is cheap
*repeated* applies within a process: long-running or multi-tenant hosts, test suites, and any code
that wants to call `apply schema` defensively.

Serving the reopen case needs the snapshot persisted alongside the catalog; that is filed as
`backlog/feat-apply-schema-persisted-catalog-fingerprint`, with the measured ceiling. Do not
half-build it here.

## TODO

- Add `src/schema/catalog-rendering.ts` with `renderCatalogForComparison` and the compile-time
  exhaustiveness guard; add a one-line pointer comment on each catalog interface in `catalog.ts`
  saying that adding a field requires an arm there (and that the compiler enforces it).
- Extract `renderDeclaredSchemaCanonical` in `schema-hasher.ts`; re-express `computeSchemaHash` in
  terms of it over the tag-stripped copy; comment why the two differ.
- Add `AppliedSchemaSnapshot`, `getDeclaredRendering`, `getAppliedSnapshot`, `setAppliedSnapshot` to
  `DeclaredSchemaManager`, invalidating both on `setDeclaredSchema` / `removeDeclaredSchema`.
- Wire the check and the record into `emitApplySchema` per the eight steps above; keep the seed loop
  on both paths.
- Add the `NOTE:` rollback tripwire at the snapshot write site.
- Write the tests for every bullet under *Edge cases & interactions*. A table-driven spec over the
  out-of-band-mutation cases (statement → expect full reconcile) keeps it extensible; the plan's
  best guess is `test/declarative-*.spec.ts` as the home — check what is already there before adding
  a new file.
- Verify a fast-pathed apply is silent: no module batch hooks, no schema-change events.
- Extend `bench/apply-schema-unchanged.mjs` to report the in-apply total for a *second* no-op apply
  (the fast-pathed one) and record before/after at `0`, `14` and `30` extra columns. Acceptance:
  `computeSchemaDiff` no longer appears in a fast-pathed apply and the total drops by at least half
  at every size.
- Record the measured cost of `renderDeclaredSchemaCanonical` alone (the plan stage only has it
  inferred, as `computeSchemaHash` minus its FNV leg ≈ 1.26 ms at 112.7 KB) — the persisted-snapshot
  backlog ticket's ceiling depends on it.
- Document in `docs/schema.md`: a subsection under § Declarative Schema for the applied-state
  snapshot (what is compared, when it is recorded, what is deliberately not covered), the `with
  seed` decision under § Seed Data, and the version-hash-vs-reconciliation-rendering distinction
  under § Schema Hashing. Add `getDeclaredRendering` / `getAppliedSnapshot` / `setAppliedSnapshot`
  to the § DeclaredSchemaManager API table.
- `bench/apply-schema-split.mjs` says in its own header: *"the sibling ticket
  apply-schema-unchanged-fast-path measures against it too; delete once that one lands and its
  numbers are recorded."* Its numbers are already recorded in `docs/schema.md` § Migration Order —
  delete it. Keep `bench/apply-schema-unchanged.mjs`; it is this feature's acceptance harness.
- `yarn build`, `yarn test`, `yarn lint`.

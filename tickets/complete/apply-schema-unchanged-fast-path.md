---
description: Re-applying a declarative schema that has not changed now remembers what both sides looked like last time and skips the comparison, cutting a no-op re-apply by well over half.
files: packages/quereus/src/schema/catalog-rendering.ts, packages/quereus/src/schema/declared-schema-manager.ts, packages/quereus/src/schema/schema-hasher.ts, packages/quereus/src/schema/catalog.ts, packages/quereus/src/runtime/emit/schema-declarative.ts, packages/quereus/test/apply-schema-unchanged-fast-path.spec.ts, packages/quereus/bench/apply-schema-unchanged.mjs, docs/schema.md, docs/invariants.md
difficulty: medium
---

From [issue #29](https://github.com/gotchoices/quereus/issues/29), via plan → implement → review.

## What landed

`apply schema` (physical branch only) keeps, per `Database` and per lowercased schema name, an
**applied-state snapshot**: what the declaration rendered to, what the live catalog rendered to,
and the effective `default_collation`, as of the end of the last successful apply whose migration
plan came out **empty**. On the next apply both sides are re-rendered and compared; on a three-way
match `computeSchemaDiff` and `generateMigrationPlan` are skipped. The seed loop, the empty-plan
hook behaviour, and schema events are untouched.

- **`src/schema/catalog-rendering.ts`** (new) — `renderCatalogForComparison`, one arm per catalog
  interface, each destructuring every field and passing the rest to a `Record<string, never>` guard
  so a new catalog field fails the build until someone decides whether it belongs.
- **`src/schema/schema-hasher.ts`** — `renderDeclaredSchemaCanonical` extracted, tags-inclusive;
  `computeSchemaHash` calls it on a tag-stripped copy, so the version hash is unchanged.
- **`src/schema/declared-schema-manager.ts`** — `AppliedSchemaSnapshot`, `getDeclaredRendering`
  (memoized), `getAppliedSnapshot`, `setAppliedSnapshot`.
- **`src/runtime/emit/schema-declarative.ts`** — the check and the record.
- **`bench/apply-schema-unchanged.mjs`** — the acceptance harness. `bench/apply-schema-split.mjs`
  deleted per the ticket.

Two deliberate deviations from the implement ticket, both reviewed and kept: `setDeclaredSchema`
invalidates the memoized rendering but **not** the snapshot, and a migrating apply neither
refreshes nor clears it. Both rest on the same reading — a snapshot is a claim about a *pair* of
renderings ("these two were once verified equal"), not about a moment in time — and both are
sound, because the next apply re-renders each side and compares. See § *What was checked*.

## Measured result

`node bench/apply-schema-unchanged.mjs [0|14|30]`, median of 9, one Windows box. Re-run at review;
reproduces the implement-stage numbers.

| declaration | full-diff no-op | fast-pathed no-op | |
|---|---|---|---|
| 20.4 KB | 1.52 ms | 0.64 ms | 58% off |
| 62.9 KB | 3.13 ms | 1.14 ms | 64% off |
| 112.7 KB | 5.49 ms | 1.50 ms | 73% off |

Acceptance ("`computeSchemaDiff` no longer appears in a fast-pathed apply and the total drops by at
least half at every size") — met.

## Validation

| | result |
|---|---|
| `yarn build` | clean |
| `yarn test` (memory) | 9600 passing, 0 failing, 25 pending |
| `yarn test:store` (LevelDB) | 9592 passing, 0 failing, 33 pending — 2m25s |
| `yarn lint` | clean |
| `node bench/apply-schema-unchanged.mjs 30` | table above |

`packages/quereus/test/apply-schema-unchanged-fast-path.spec.ts` — **33** tests (30 from implement,
3 added at review).

## Review findings

### Checked and sound — no action

- **The soundness argument for skipping.** `computeSchemaDiff(declared, catalog, renamePolicy,
  defaultCollation)` reads nothing but its four arguments (verified by reading it); two are compared
  by rendering, one directly, and `renamePolicy` is genuinely inert with no differences. Confirmed.
- **The `plantSnapshot` white-box device**, which the implement handoff explicitly asked a reviewer
  to sanity-check. It records the *currently drifted* catalog's rendering as the verified-equal one,
  so the next apply's freshly-rendered catalog matches and the fast path fires; an apply that
  repairs the drift therefore proves a full diff ran. The negative control next to it fails exactly
  as it must. The device is valid and the tests resting on it mean what they claim.
- **Both deliberate deviations.** Worked through the state machine for redeclare-then-apply,
  migrate-then-revert, and drift-then-repair. In every case a stale snapshot is defeated by one of
  the two renderings differing. The deviations are correct and better than the ticket's literal text.
- **Declaration fields the rendering drops.** `declare schema … using (default_vtab_module/args)` is
  absent from `generateDeclaredDDL` and *is* read by the differ — but only by `freshTableCreate`,
  i.e. only for tables being created. A fast-pathed apply creates nothing, so the omission cannot
  hide a change. Checked rather than assumed.
- **Catalog fields the rendering drops** (`CatalogView.select`, `CatalogAssertion.check`,
  `CatalogTable.maintained.select`). Confirmed at each differ call site that these are consulted
  only *after* the corresponding `definition` / `bodyHash` compare has already failed — which a
  fast-pathed apply never reaches.
- **The compile-time exhaustiveness guard.** Re-derived the type argument: an exhaustive destructure
  leaves `{}`, which satisfies `Record<string, never>`; one unconsidered field of any other type does
  not, including an optional one.
- **SCH-003 / SCH-001 declaration guards**, which live inside the now-skippable `computeSchemaDiff`.
  Safe: a snapshot only exists after a diff that succeeded, and adding a duplicate emits a second
  DDL statement into the declared rendering, so the fast path misses. Recorded in `docs/invariants.md`
  rather than left as an unwritten argument.
- **Store backend.** The implement handoff flagged `yarn test:store` as not run. Run at review:
  9592 passing, 0 failing, 2m25s — comfortably agent-runnable, and the declarative-schema sqllogic
  tests exercise `apply schema` through the store with the fast path active. Note that the
  fast-path spec itself is memory-only by construction (it builds `new Database()` directly and
  `QUEREUS_TEST_STORE` is honoured only by `logic.spec.ts` / `numeric-canonical.spec.ts`), so the
  store coverage here is the sqllogic path, not that spec.

### Fixed in this pass

- **Overstated correctness claim.** `renderCatalogForComparison`'s doc comment called the string
  compare "collision-free", and `docs/schema.md` said storing strings "is what makes the comparison
  exact". Both are true of *hash* collisions and false of the encoding — see below. Reworded at both
  sites to say what actually holds.
- **Two test gaps the handoff listed as known.** Added: the `CatalogIndex.implicit` arm (a UNIQUE
  constraint tagged `quereus.expose_implicit_index` — two tests: the marker reaches the rendering,
  and an exposed implicit index is not treated as drift), and logical schemas (no snapshot is ever
  recorded, since the logical branch returns before catalog collection). 30 → 33 tests, all passing.
- **An unstated dependency.** The declared-side memo assumes nothing edits a stored declaration AST
  in place — the same invariant the `spineCloneAst` call in `runBatchedMigrationLoop` exists to
  protect, but nothing at that site said the memo now depends on it too. Added.
- **A stale estimate in a downstream ticket.** `backlog/feat-apply-schema-persisted-catalog-fingerprint`
  sized its cost ceiling off an inferred ~1.26 ms for `renderDeclaredSchemaCanonical`; the measured
  figure is 0.84 ms. Updated in place.

### Filed as tickets

- **`backlog/debt-catalog-rendering-injective-encoding`** — the rendering separates fields and items
  with literal spaces / tabs / newlines and escapes nothing, while several rendered values are
  free-form user text (tag values, string `DEFAULT`s, and the `ddl` that embeds them). Confirmed by
  running the renderer that a raw newline in a tag or default reaches the output verbatim. So text
  crafted to imitate another item's rendering can make two distinct catalogs render alike, and a
  change between exactly those two states would be skipped. Filed at the class-retiring rung — a
  uniquely-decodable encoding — not as a point escape of newlines, with the measured cost (~+0.25 ms
  per encoding level on a 308.8 KB rendering, against a 1.50 ms fast-pathed apply) so the tradeoff is
  decidable. `likelihood: contrived`; it takes hostile input to build one.
- **`backlog/bug-apply-schema-dry-run-option-ignored`** — found while auditing which
  `ApplySchemaStmt.options` the fast path had to account for. `dry_run` and `validate_only` parse
  and are then never read: `apply schema main options (dry_run = true)` performs a real migration
  (verified). Pre-existing, unrelated to this change, and dangerous in the way that matters — the
  option exists for people who are unsure.

### Recorded as tripwires, not tickets

- `src/schema/catalog-rendering.ts`, on `renderCatalogForComparison` — the encoding gap above, with
  its exploitability bar, the fix, and a pointer to the ticket. (Both, deliberately: the note is
  what stops a future reader from trusting the old "collision-free" phrasing even if the ticket is
  declined.)
- `src/schema/declared-schema-manager.ts`, on `AppliedSchemaSnapshot` (from implement) — the two
  renderings are held per schema for as long as the declaration lives, 309 KB + 109 KB at the top
  bench size. Revisit condition: many large schemas showing up in a heap profile; the trade is
  hashing the catalog rendering instead (FNV-1a over 119 KB measured 1.46 ms, three times the string
  compare it would replace).
- `src/runtime/emit/schema-declarative.ts`, at the snapshot write site (from implement) — catalog
  DDL is not rolled back today, so a transaction unwinding after an apply cannot strand the
  snapshot. If catalog DDL ever becomes rollback-able, the snapshot must be invalidated on rollback.

### Empty categories

- **No performance findings.** The one candidate — `renderCatalogForComparison` is computed
  unconditionally, so a *migrating* apply pays 0.57 ms rendering a string it discards — is noise
  against a migration that runs DDL, and making it lazy would complicate the record-at-the-end path
  for nothing measurable.
- **No source-hygiene findings.** `catalog-rendering.ts` is 169 lines of one-purpose functions;
  the emitter's `run` grew ~20 lines and its longest new block is the fast-path check. Comment
  density is high but each comment carries a measurement or a reason, not a restatement.
- **No resource-cleanup or error-handling findings.** The change allocates two strings per schema
  into maps already keyed and cleared by `removeDeclaredSchema`, and adds no I/O, no async
  boundary, and no catch.
- **No accepted-tradeoff `NOTE:`s were overridden.** Checked the sites this review touched; the two
  tripwires present are the implement stage's own and neither has a tripped revisit condition.

## Not covered, deliberately

- **One apply per process still pays the full diff** — the snapshot is in-memory and empty on the
  first apply. That is `backlog/feat-apply-schema-persisted-catalog-fingerprint`.
- **`diff schema`** never reads or writes the snapshot; **`explain schema`** still returns the
  tag-stripped version hash; **logical schemas / lenses** have no fast path.

## Also filed during implement

`tickets/backlog/bug-declare-table-tags-example-does-not-parse.md` — the `docs/sql-ddl.md` example
showing `table customer with tags (…) { … }` does not parse (the tag list has to follow the body).
Unrelated to this change.

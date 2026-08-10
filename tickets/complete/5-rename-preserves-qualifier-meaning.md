---
description: Renaming a table onto a name a saved query already used for another data source no longer makes the query silently read the wrong table — the rename pins the old spelling as an alias, and the declarative differ recognizes those pins instead of undoing them.
files:
  - packages/quereus/src/schema/rename/table-rename.ts      # qualifierCollides/aliasAs/cteShadows on TableRef; qualifierCollidesAt + collectIntroducedQualifierNames; frame subtreeRoot/introduced
  - packages/quereus/src/schema/schema-differ.ts            # absorbRenameArtifacts + the three per-sink wrappers
  - packages/quereus/src/schema/catalog.ts                  # CatalogView.select, CatalogAssertion.check, CatalogTable.maintained.select
  - packages/quereus/src/util/ast-spine-clone.ts            # doc field list gains .alias
  - packages/quereus/test/schema/table-rename-scope.spec.ts
  - packages/quereus/test/schema/rename-cross-schema.spec.ts
  - packages/quereus/test/schema-differ.spec.ts
  - packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic  # § 67
  - packages/quereus/test/logic/50.2-declare-schema-renames.sqllogic    # §§ 26–27
  - docs/sql-alter.md
  - docs/schema-rename-detection.md
---

# Rename preserves qualifier meaning — complete

## What shipped

**Walker.** When `ALTER TABLE … RENAME` would give an unaliased FROM source a bare
name already live as a column qualifier where that source sits, the source takes the
new name but pins its pre-rename spelling as an explicit alias (`from t` →
`from t2 as t`), and every column qualifier bound through it keeps the old spelling.
The collision predicate covers a sibling source, a sibling's alias, a CTE in scope, an
enclosing frame's binding, and — beyond the ticket's spec — any qualifier-capturing
name the binding select's subtree can introduce (an inner alias inside a correlated
subquery would otherwise capture the rewritten correlation). When the colliding name
is a CTE, the source is schema-qualified as well, since a bare source spelling a CTE's
name binds the CTE; a DML target renamed onto its own statement's WITH member gets the
same treatment.

**Differ.** A last-resort compare (`absorbRenameArtifacts`) walks the declared and live
body ASTs in structural lockstep and normalizes the declared side toward the live
spelling exactly where the two are equivalent — accepting a live-side pin qualifier
over a bare declared reference, a declared qualifier naming the diff's own schema over
a bare live one, and dropping a declared FROM alias equal to its source's post-inverse
bare name. All three body sinks (plain views, maintained tables/MVs, assertions) share
it, so a pinning rename converges in one `apply schema` pass instead of churning a
recreate that would undo the pin.

## Review findings

### Verified clean (checked, nothing to do)

- **Three-part column refs under a collision** (the implementer's top flagged probe).
  Measured, not reasoned: `select main.t.x from main.t` fails at plan time with
  `main.t.x isn't a column`, aliased source or not. The `col.schema !== undefined`
  branch can therefore only ever rewrite references that never planned in the first
  place, so the new alias cannot interact with it. Not a defect.
- **Store backend parity** (the implementer's second flagged probe). Ran
  `QUEREUS_TEST_STORE=true` over `41.3-alter-rename-propagation`,
  `41.3.1-alter-rename-index-propagation`, `50.2-declare-schema-renames` and
  `50.2.1-declare-schema-index-renames`: all pass, including the cases added in this
  review. The alias-writing path holds on the LevelDB store.
- **`absorbRenameArtifacts` soundness.** The lockstep recursion is key-name-based and
  can pair unrelated nodes, but it only ever writes `.schema` and clears `.alias`, only
  at `table` / `insert|update|delete` / `column` nodes, and every caller compares the
  full canonical render afterwards — so a mispaired node can fail to mask a real
  difference but can never manufacture equality. Confirmed the walk never writes to the
  `actual` side (the live catalog's own AST).
- **No declared-AST mutation.** `inverseRenamedViewParts` clones unconditionally on its
  first line and the assertion path clones explicitly, so no absorb can reach the
  declared statement that a recreate renders from. The "recreate DDL never absorbs"
  claim holds.
- **Order-independence of the collision predicate.** Frame `bound`/`ctes` are filled
  before the frame's subtree is visited (and the WITH frame's `ctes` grows in exactly
  the planner's visibility order), and the subtree name set is memoized per frame — so
  the source emit and every bound-qualifier emit for one frame always agree. Walked the
  emit sites that mutate without consulting (aliased sources, three-part refs, seedless
  column qualifiers, DML targets) and confirmed none of them changes what
  `collectIntroducedQualifierNames` collects.
- **Idempotence.** After a pin the old name survives only as an alias, which
  `collectFromBindings` maps to `null`, so a second identical rename emits nothing.
- **The same capture class in seedless bodies** (a CHECK / index-predicate self-qualifier
  inside a subquery whose alias spells the new name) is *not* a latent defect: measured,
  `check (exists (select 1 from other as t2 where t2.id = t.id))` already fails at write
  time with `t.id isn't a column`, so such bodies are unevaluable before any rename —
  matching the claim the existing comment at that emit site makes. No ticket filed.
- **Catalog blast radius.** `CatalogView` / `CatalogAssertion` / `CatalogTable.maintained`
  are referenced only by `catalog.ts`, `schema-differ.ts` and their spec, and
  `collectSchemaCatalog` feeds only the declarative diff/apply emitters — the new AST
  fields are not serialized anywhere.
- **Docs.** Read every doc the change touched and the ones it should have: the
  known-limitation paragraph in `docs/sql-alter.md` and the residual-hazard paragraph in
  `docs/schema-rename-detection.md` are both replaced with the positive invariant, and
  no other doc carries a stale field list for the catalog descriptors. `yarn docs:check`
  passes.

### Minor — fixed in this pass

- **`schema-differ.ts`: the assertion compare was an inline IIFE embedded inside a
  boolean expression.** Extracted to a named
  `declaredCheckMatchesModuloRenameArtifacts`, the twin of the existing
  `declaredViewMatchesModuloRenameArtifacts` — the project's rule is decomposed
  sub-functions over grouped sections.
- **Test coverage: `41.3` § 67 exercised plain views only.** The pin also has to survive
  two different downstream machineries — a maintained body's re-hash and refresh
  re-plan, and an assertion's stored CHECK. Added both cases (a materialized view whose
  source collides with a sibling's alias, refreshed and re-read; an assertion whose
  CHECK body collides the same way, then verified to still watch the renamed table and
  not the sibling whose alias it now spells). Both pass on memory and store backends.

### Major — none

No finding warranted a new ticket. The two probes the handoff flagged as unknown both
resolved clean under measurement, and the differ's tolerance rules are bounded by the
post-walk full-string compare.

### Conditional / speculative — parked as tripwires, not tickets

- **Conservative pinning costs a maintained body a re-hash.** The predicate pins whenever
  the new name is visible in scope *or* introducible anywhere in the select's subtree,
  even when nothing spells it — harmless for a plain view, but for an MV it changes the
  body text and therefore the `bodyHash`, forcing a re-hash/regenerate on a view whose
  meaning did not change. Recorded as a `NOTE:` on the existing conservativeness comment
  in `renameTableInAst`'s sink, with the narrowing to apply if it ever shows up as churn.

### Accepted tradeoffs left alone

- The `NOTE: accepted tradeoff` on `absorbRenameArtifacts` (a declaration that merely
  *un-qualifies* a reference the live side carries qualified reads as unchanged, so the
  pin survives) states its revisit condition — pins gaining durable provenance metadata
  — which has not tripped. Not re-filed. The reverse direction (a declared qualifier
  naming the diff's own schema absorbed against a bare live reference) is sound under
  the rename series' established "a home schema leads its own path" rule and is covered
  by a test asserting a foreign-schema qualifier still recreates.

### Size

`table-rename.ts` reached 1,063 lines and `schema-differ.ts` 3,013. Both appended to
`backlog/debt-oversized-source-files` with the `wc -l` measurements and the date; the
absorb helpers are named there as an extraction seam.

## Validation

- `yarn build`, `yarn lint`, `yarn docs:check`: green.
- `yarn test` (whole workspace): 9020 passing / 0 failing / 16 pre-existing pending in
  quereus; every other workspace suite passes.
- `QUEREUS_TEST_STORE=true` over the four rename-related sqllogic files: green.

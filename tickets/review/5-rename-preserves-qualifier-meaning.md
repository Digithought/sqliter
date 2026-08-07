---
description: Renaming a table onto a name a saved query already used for another data source no longer makes the query silently read the wrong table — the rename now pins the old spelling as an alias, and the declarative differ recognizes those pins instead of undoing them.
files:
  - packages/quereus/src/schema/rename/table-rename.ts      # qualifierCollides/aliasAs/cteShadows on TableRef; sink collision branch; qualifierCollidesAt + collectIntroducedQualifierNames; frame subtreeRoot/introduced
  - packages/quereus/src/schema/schema-differ.ts            # absorbRenameArtifacts + declaredViewMatchesModuloRenameArtifacts; view/assertion/maintained compare fallbacks; rewritten NOTE in inverseRenamedViewParts
  - packages/quereus/src/schema/catalog.ts                  # CatalogView.select, CatalogAssertion.check, CatalogTable.maintained.select (live ASTs for the compare)
  - packages/quereus/src/util/ast-spine-clone.ts            # doc field list gains .alias
  - packages/quereus/test/schema/table-rename-scope.spec.ts # 8 new grid cases incl. deep capture + DML-target CTE shadow; `absent` assertion support
  - packages/quereus/test/schema/rename-cross-schema.spec.ts# walker-level collision describe + engine-level collision describe (2a/2b/2c/2e/2d + deep capture + controls)
  - packages/quereus/test/schema-differ.spec.ts             # absorbRenameArtifacts describe (view/assertion/MV twins, guards); helpers carry ASTs
  - packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic  # § 67
  - packages/quereus/test/logic/50.2-declare-schema-renames.sqllogic    # §§ 26–27
  - docs/sql-alter.md                                       # known-limitation paragraph replaced with the positive invariant
  - docs/schema-rename-detection.md                         # residual-hazard paragraph replaced with the absorb description
---

# Rename preserves qualifier meaning — implemented

## What the change does

**Walker (`renameTableInAst`), qualifier namespace.** When a rename would give an
unaliased FROM source a bare name already live as a qualifier where that source
sits, the source takes the new name but pins its pre-rename spelling as an
explicit alias (`from t` → `from t2 as t`), and every column qualifier bound
through it keeps the old spelling. One predicate covers the ticket's four
sub-cases: sibling source, sibling alias, CTE in scope, enclosing-frame binding.
All four measured repros now return their pre-rename rows (verified against the
engine, plus engine-level tests).

**Beyond the ticket's spec — two capture holes the specified predicate missed,
both `repro: verified` before the fix:**

1. **CTE capture of the rewritten source.** In sub-case 2c the ticket's
   alias-only shape (`from t2 as t` under `with t2 as (…)`) would have re-bound
   the SOURCE to the CTE — the catalog post-condition can't see CTEs. New
   `TableRef.cteShadows` forces a schema qualifier (`from main.t2 as t`) when
   the new name is CTE-shadowed at the source; same treatment for a DML target
   renamed onto its statement's own WITH member (mirrors `resolveCteTarget`).
2. **Deep capture of a correlated qualifier.** `select t.x from t where exists
   (select 1 from other as t2 where t2.id = t.id)` under `t → t2`: nothing at
   the source's frame binds `t2`, but the inner alias captures the rewritten
   correlation (`t2.id = t2.id` — measured wrong rows). The ticket's
   "evaluate at the source's frame, truncate deeper frames" rule cannot see
   this. Fix: the predicate also consults a lazily-memoized set of every
   qualifier-capturing name the binding select's SUBTREE can introduce
   (`collectIntroducedQualifierNames`, memoized per frame so all consults for
   one frame agree). Conservative on purpose — a name in a sibling subquery
   that could never shadow the source still pins an alias; recorded as a
   `NOTE:` in the sink.

Aliased sources are untouched (2d control), a no-collision rename stays
byte-identical (asserted), and idempotence/probe-agreement grid tests pass over
all new cases.

**Differ.** Both arms of the ticket's differ section:

- *Alias arm:* implemented as compare-time normalization rather than inside
  `inverseRenamedViewParts` (deliberate deviation, see below): the new
  `absorbRenameArtifacts` walks declared-vs-live body ASTs in structural
  lockstep after the inverse pass and drops a declared alias equal to its
  source's post-inverse bare name when the live side has none.
- *Pin-qualifier arm:* the ticket's two options were "teach the inverse pass
  the real home path" vs "normalize engine-authored qualifiers before
  comparing." Option A cannot meet the ticket's own required outcome (at
  re-diff time the declared bare `k` genuinely resolves to `temp.k` under any
  honest catalog, so resolution-equality would legitimize the recreate the
  ticket forbids), so option B is implemented, metadata-free: the same lockstep
  walk accepts a live-side qualifier over a bare declared reference, and a
  declared qualifier naming the diff's own schema over a bare live one (the
  single-schema equivalence the old NOTE floated — now needed for real, since
  the CTE arm writes `main.t2 as t` into single-schema bodies). Soundness: the
  full canonical string/hash is compared after the walk, so an absorb at an
  edited site cannot manufacture equality. Reasoning recorded at the site; the
  measured `declare schema temp` shape now re-diffs empty after one apply and
  the view keeps reading `main.k` (sqllogic § 26).

The absorb runs for all three body sinks — plain views (string), maintained
tables/MVs (hash, via `maintainedBodyMatches`), assertions (expression string)
— because all three get pinned by the untouched arm and all three had the same
recreate-undoes-the-pin defect. That needed the live ASTs on the actual catalog
(`CatalogView.select`, `CatalogAssertion.check`, `maintained.select` — optional
fields; hand-built catalogs without them keep the strict compare).

## Deviations from the ticket's TODO list

- `resolveQualifier` returns `{ binding, frameIndex }` and the predicate is
  `qualifierCollidesAt` (visible-up-to-frame OR subtree-introduced), not the
  plain truncated scan the ticket specified — the truncated scan is provably
  insufficient (deep-capture repro above).
- The alias-drop lives in `absorbRenameArtifacts` (compare-time), not in
  `inverseRenamedViewParts` itself — one place handles both arms, recreate DDL
  renders (`columnReconciledViewStmt`) stay as-authored, and the "declared side
  must canonicalize the same way" hazard the ticket warned about disappears
  (normalization is toward-the-actual, per site, compare-only).
- `TableRef` gained `cteShadows` in addition to the two specified members.

## Accepted tradeoff recorded

`NOTE: accepted tradeoff` on `absorbRenameArtifacts`: a declaration that merely
un-qualifies a reference the live side carries qualified reads as unchanged
(the pin survives). Metadata-free compare cannot distinguish that author edit
from the engine's own pin; the escape hatch (qualify explicitly, e.g. `temp.k`)
is tested ('an author-written qualifier naming ANOTHER schema still recreates')
and documented in docs/schema-rename-detection.md.

## Validation

- `yarn build`, `yarn lint`, `yarn test` from repo root: all green
  (quereus: 9020 passing / 0 failing / 16 pre-existing pending; all other
  workspace suites pass).
- New coverage: 8 scope-grid cases (auto-included in the probe-agreement and
  idempotence meta-tests), 5 walker-level post-condition tests, 7 engine-level
  collision tests, 7 differ unit tests, sqllogic 41.3 § 67 (six shapes) and
  50.2 §§ 26–27 (one-pass convergence for both arms).

## What the reviewer should probe

- **Three-part column refs under a collision** (`select main.t.x … from main.t
  join temp.t2 …` + rename): the schema-qualified column branch still rewrites
  to `main.t2.x` while the source gets aliased `main.t2 as t` — whether the
  planner resolves a 3-part ref against an aliased source's underlying table
  decides if that spelling still plans. Untested; pre-existing branch, but the
  alias is new state it can now interact with.
- **Store backend parity**: `yarn test:store` was NOT run (agent default is the
  memory path). The store module re-runs the same walker over persisted DDL, so
  parity should hold by construction, but the alias-writing path is new there.
- **Conservativeness cost**: the subtree name-collection triggers an alias for
  names introduced in sibling subqueries that could never capture the source.
  Harmless semantically; worth a skim for surprising aliases in complex bodies.
- **`absorbRenameArtifacts` recursion**: structural lockstep over `Object.keys`
  — confirm no AST node kind pairs a declared `schema` field against an
  unrelated live one (the type-gate restricts absorbs to `table` / DML /
  `column` nodes, and the post-walk string compare backstops it).
- schema-differ.ts grew by ~180 lines and is already cited by
  `backlog/debt-oversized-source-files`; the absorb helpers are a natural
  extraction seam if that ticket lands.

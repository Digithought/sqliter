---
description: A lens mapping that names its underlying tables without spelling out which schema they live in now reads the right tables, and one that names a table the underlying schema does not have is rejected up front instead of quietly reading a same-named table from somewhere else.
files:
  - packages/quereus/src/schema/lens-compiler.ts    # forEachAstNode, collectCteNames, qualifyBasisSources, resolveBasisTableSource, basisHasRelation, validateOverrideBasisSources
  - packages/quereus/src/schema/lens-prover.ts      # resolveSingleBasisSource — reads the stored qualifier, no longer re-defaults a bare name
  - packages/quereus/src/util/ast-spine-clone.ts    # reused for the non-mutating rewrite (unchanged)
  - packages/quereus/test/logic/52-lens-overrides.sqllogic  # §§ 6-13
  - packages/quereus/test/lens-overrides.spec.ts    # describe 'lens overrides: unqualified basis sources' (11 tests)
  - packages/quereus/test/lens-advertisement.spec.ts # unqualified-FROM variant of advertisement gap-fill
  - docs/lens.md                                    # § Body-shape restrictions — three bullets
difficulty: medium
repro: verified
---

# What shipped

A lens maps a *logical* schema (what the app sees) onto a *basis* schema (where
the data lives). Inside `declare lens for carapp over ybasis { view Car as
select … from CarCore }`, the bare name `CarCore` means "a relation in the basis
schema". The compiler resolved it that way but stored the body with the authored
`FROM` copied verbatim, so nothing in the stored body recorded *which* schema the
bare name meant — and each later consumer re-resolved it its own way (the read
path plans under the logical schema's home path; the prover and `explain`
round-trip the body through SQL text with no schema path at all).

The compiled body is now self-describing. Three arms:

**Qualification.** `qualifyBasisSources` rewrites every bare `FROM` relation that
is not CTE-shadowed and does exist in the basis to `<basis>.<relation>`, matching
the fully-qualified form the synthesized default-mapper and decomposition bodies
already emit. The walk is reflective over the whole body (subquery sources, `with`
bodies, compound legs, `order by`, `where`/`in`/`exists` subqueries) via a shared
`forEachAstNode` helper that `validateOverrideBasisSources` also uses. The
authored AST is never mutated — it is the same object the catalog holds for the
user's own `declare lens` — so a rewrite works on a `spineCloneAst` copy.

**Escape rejection.** A `FROM` source may only name the declared basis or a CTE
of the same body. Both escapes are rejected at deploy, naming the relation:
qualified with another schema (`from Z.Foo` while `over Y`), and *bare but absent
from the basis* — the latter has no qualifier to pin, so it would otherwise fall
through to the default schema path and bind `main`'s same-named relation.

**CTE shadowing.** A name a `with` CTE declares is the CTE, not the basis
relation: it is neither qualified nor collected as a basis source, so `*`
expansion and gap-fill cannot draw columns from the shadowed basis table. An
uncovered logical column only that table could have backed is an uncovered-column
error at deploy rather than a body that deploys and fails at read.

# Review findings

Reviewed the implement commit `349167ea` diff first, then probed each behaviour
against a scratch `Database` before reading the handoff's own claims.

## Defects found — all fixed in this pass

**1. A bare basis *view* source was not qualified — same bug, different relation
kind.** The qualification test was `basis.getTable(name)`, which does not see
views. Measured: `declare lens for x over y { view Car as select id, speed from
CarV }` (where `y.CarV` is a basis view) **deployed, then failed at read** with
`Table 'CarV' not found in schema path: x, main`, while the explicitly qualified
`from y.CarV` worked. Fixed with a `basisHasRelation` helper (table *or* view)
used by both the qualifier and the new escape check. A view is still *opaque* for
`*` expansion and gap-fill — it exposes no column list — so `resolveBasisTableSource`
stays table-only and the two are now documented as deliberately different widths.

**2. A bare source absent from the basis still silently re-anchored off it.** The
implement pass hardened the case where the same name exists in *both* the basis
and `main` (the basis wins — its § 9 test). It left the case where the name exists
**only** in `main`: measured, `from Gadget` over basis `y` (no `Gadget`) deployed
and returned `main.Gadget`'s rows, while the qualified spelling `from main.Gadget`
is explicitly rejected as cross-basis. Same silent re-anchor the ticket exists to
kill, minus the qualifier that made it visible. Now a deploy error naming the
relation. This also turns the "exists nowhere" case (`from NoSuchTable`) from a
read-time `Table 'NoSuchTable' not found in schema path: x, main` — which does not
even mention the basis — into a deploy-time error that does.

**3. `lens-prover.ts` `resolveSingleBasisSource` still defaulted a bare name to the
basis.** The handoff flagged this as a probed-benign disagreement. It is now
simply removable: since every compiled body is basis-qualified by construction, a
bare name surviving in one is a CTE reference, so the prover reads the stored
qualifier and returns undefined otherwise. The `basisSchemaName` parameter is gone
from it and from `resolveSlotBasisSource`. Effect: a CTE-shadow body's columns
report `inverse: 'none'` instead of inheriting the shadowed table's attribution —
honest, and the read still returns the CTE's rows. This also removes the
mis-attribution risk in the FK-redundancy detector
(`planner/mutation/lens-enforcement.ts`), which consumes that resolver.

## Handoff claims checked

- **Non-mutation of the authored AST — holds.** `spineCloneAst` deep-copies plain
  objects, so `table` is freshly owned before `table.schema` is written. Confirmed
  end-to-end: the declaration still stringifies bare while the compiled body is
  qualified.
- **"Case sensitivity of the qualifier" — unfounded, nothing to do.** The rewrite
  writes `basis.schemaName`, which is the *catalog's* canonical name
  (`lens-compiler.ts:83`), not the text after `over`. A lens declared `over Y`
  against schema `y` stores `y.`.
- **"Function sources are untouched" — confirmed.** `functionSource` is not a
  `table` node, so neither the qualifier nor the escape check sees it; a TVF body
  fails (or not) for entirely unrelated reasons.
- **"A bare name that is neither a CTE nor a basis table produces today's ordinary
  unresolved-table error" — confirmed as described, and that turned out to be the
  problem, not the reassurance (finding 2).**
- **"Unqualified sources plus a module mapping advertisement" — reasoned about but
  untested, per the handoff. Now tested** (`lens-advertisement.spec.ts`): the
  advertisement gap-fill test re-run with a bare `FROM` resolves the same advertised
  member and gap-fills the renamed column identically. The reasoning was right.
- **Flat CTE shadow set (the handoff's deliberate gap) — re-probed and kept.** The
  over-shadow only bites when one body means the basis relation in one scope and a
  CTE in another; a CTE confined to a nested subquery source deploys and reads
  correctly. Such a source is left bare and exempted from the new escape check, so
  it degrades to the read-time unresolved-relation error rather than a wrong bind.
- **Only `table` nodes are rewritten.** Verified `type: 'table'` is `TableSource`
  and nothing else (`parser.ts:1156`); `insert`/`update`/`delete` carry
  `table: IdentifierExpr`, so a DML target inside a subquery source is untouched by
  both the qualifier and the cross-basis check. That is pre-existing — the original
  cross-basis walk never saw them either — and out of this ticket's scope.

## Tripwire recorded (not a ticket)

`qualifyBasisSources` returns its input unchanged when there is nothing to
qualify, so a compiled body shares FROM/`where` subtrees with the authored
declaration AST in that case while the rewrite path hands back a detached clone —
aliasing is asymmetric. Harmless while nothing mutates a compiled body in place.
Parked as a `NOTE:` at the early return in `lens-compiler.ts`.

## Checked and deliberately not flagged

- **Source size.** `lens-compiler.ts` is 2019 lines
  (`find packages/quereus/src -name "*.ts" -exec wc -l {} + | sort -rn`), which does
  not place it in the repo's ten largest files — `parser.ts` is 5003 and four
  others exceed 3000. No size-debt ticket.
- **Extra AST walks.** `qualifyBasisSources` walks the body twice (detect, then
  rewrite) and `deriveRelationBacking` collects CTE names on every compiled body
  including the synthesized ones that have none. Both are per-deploy over a single
  statement AST; not worth a note.
- **Empty categories.** No findings on error handling, resource cleanup, or type
  safety — the change adds no I/O, no lifetimes, and no `any`/casts beyond the
  `Record<string, unknown>` → AST narrowing the reflective walk requires, which is
  guarded by the `type` discriminant at each use.

## Tests added this pass

`lens-overrides.spec.ts` — bare basis *view* qualifies and reads; bare source the
basis lacks rejected when `main` has one; rejected when nothing has one; rejected
when nested in an `in`-subquery. `lens-advertisement.spec.ts` — unqualified FROM
with a module mapping advertisement. `52-lens-overrides.sqllogic` §§ 12-13 — the
`main`-shadow rejection and the basis-view source.

# Validation

- `yarn test` in `packages/quereus` — **8405 passing, 13 pending**, exit 0.
- `yarn test` at the repo root (all workspaces) — green, `Done in 3m 11s`, exit 0.
  The stale-`dist` build race the handoff noted did not recur.
- `yarn lint` at the repo root and in `packages/quereus` (eslint + `tsc -p
  tsconfig.test.json --noEmit`) — clean, exit 0.
- `yarn workspace @quereus/quereus run typecheck` — clean, exit 0.

No pre-existing failures surfaced, so `tickets/.pre-existing-error.md` was not
written.

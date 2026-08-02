----
description: A lens mapping that names its underlying tables without spelling out which schema they live in now works — it reads the right tables instead of failing or quietly reading a same-named table from somewhere else.
files:
  - packages/quereus/src/schema/lens-compiler.ts    # forEachAstNode, collectCteNames, qualifyBasisSources, resolveBasisTableSource (all new, ~1339-1465); callers at 368, 411, 1214, 1331, 1965
  - packages/quereus/src/util/ast-spine-clone.ts    # reused for the non-mutating rewrite (unchanged)
  - packages/quereus/test/logic/52-lens-overrides.sqllogic  # new §§ 6-11
  - packages/quereus/test/lens-overrides.spec.ts    # new describe 'lens overrides: unqualified basis sources' (7 tests)
  - docs/lens.md                                    # § Body-shape restrictions — two new bullets
difficulty: medium
repro: verified
----

# What changed

A lens maps a *logical* schema (what the app sees) onto a *basis* schema (where
the data lives). Inside `declare lens for carapp over ybasis { view Car as
select … from CarCore }`, the bare name `CarCore` is documented to mean "a table
in the basis schema". The compiler resolved it that way, but stored the body
with the authored `FROM` copied verbatim — so nothing in the stored body
recorded *which schema* the bare name meant, and each later consumer re-resolved
it its own way (the read path plans under the logical schema's home path; the
prover and `explain` round-trip the body through SQL text with no schema path at
all). None of them knew the basis.

The fix qualifies the compiled body once, at compile time, so it is
self-describing. Two arms, both in `schema/lens-compiler.ts`:

**Arm 1 — `qualifyBasisSources`.** Where `compileOverrideBody` assembles the
stored body, each `FROM` `table` node whose schema is absent, whose bare name is
not shadowed by a CTE, and which resolves in the basis is rewritten to
`<basis>.<table>`. Everything else is left exactly as authored. The walk is
reflective over the whole body (subquery sources, `with` bodies, compound legs,
`order by`, `where`/`in`/`exists` subqueries), matching what
`validateOverrideBasisSources` already did — that walk was refactored onto the
same shared `forEachAstNode` helper, which also now skips non-plain-prototype
leaves (`Uint8Array`, a Promise literal value).

The input AST is never mutated: `override.select` is also the declared-lens AST
the catalog holds, so an in-place edit would rewrite the user's own declaration.
When there is something to rewrite the pass works on a `spineCloneAst` copy;
when there is nothing (every existing, already-qualified body) it returns the
input untouched, so the existing corpus keeps byte-identical behavior.

**Arm 2 — CTE shadowing.** `collectOverrideSources` used to resolve *any* bare
`FROM` name against the basis, so a CTE shadowing a basis table name was
collected as that basis table and its columns drove `*` expansion and gap-fill.
A new `resolveBasisTableSource` treats a CTE-shadowed bare name as opaque
instead. `collectJoinKeyEquivalences` shared the identical bare-name assumption
and was moved onto the same helper.

The CTE-name set is threaded from four sites: `compileOverrideBody` (authored
select), `deriveRelationBacking` (compiled body), and
`validateOverrideAdvertisementConflict` (authored select).

# Measured before/after

Each variant was run against a scratch `Database` before and after.

| # | override `FROM` | before | after |
|---|---|---|---|
| a | `from ybasis.CarCore` | works | works (unchanged) |
| b | `from CarCore` | `Table 'CarCore' not found in schema path: carapp, main` | works |
| c | `from (select … from CarCore) s` | same error | works |
| e | `… where id in (select id from CarCore)` | same error | resolves; then rejected by the prover — **identical to the qualified control** |
| h | `from CarCore c join CarExtra x on …` | same error | works |
| f | `from CarCore`, **and** a `main.CarCore` exists | deployed and read `main.CarCore` — **wrong rows, no error** | reads the basis rows |
| g | basis is `main`, `from CarCore` | works | works (unchanged) |
| d | `with CarCore as (…) … from CarCore` | binds the CTE | binds the CTE (unchanged) |
| d2 | d, plus an uncovered `color` | deployed, then failed at read: `Column not found: color` | rejected at **deploy** with the coverage diagnostic |

Variant **e** is worth reading carefully: it still errors, but with
`lens.non-invertible` from the prover, not a resolution failure — and the
*qualified* spelling of the same body produces the same three prover errors. So
it is now at parity with the qualified form, which is the property the fix
claims. It is not evidence of a remaining resolution bug.

`quereus_effective_lens` for a formerly-unqualified override also changed for
the better: `effective_sql` now shows `from y.CarCore`, and every column's
`inverse` went from `'none'` (the body could not plan, so the prover degraded
everything) to `'inferred'`.

# What to test / poke at

**Where the tests live.** `test/logic/52-lens-overrides.sqllogic` §§ 6-11 and
the `lens overrides: unqualified basis sources` block in
`test/lens-overrides.spec.ts` (7 tests). Between them they cover: unqualified
single source over a non-`main` basis; a two-table basis join with both legs
bare; basis = `main` (no regression); a same-named `main` table losing to the
basis; a CTE shadow still binding the CTE; a CTE shadow making an uncovered
column a deploy error; a bare table inside a subquery source; `effective_sql`
carrying the qualifier with matching `inverse` dispositions; and that the
authored `declare lens` AST still stringifies as written while the compiled body
is qualified.

**Adversarial angles the tests do not reach — please push here:**

- **Unqualified sources plus a module mapping advertisement.** Every new test
  uses a plain basis; none exercises the advertisement/decomposition path with a
  bare `FROM`. The reasoning that it is unaffected is that source resolution
  happens on the authored select *before* qualification, so `overrideSourceByRel`
  sees the same `TableSchema` either way — but that is an argument, not a test.
- **Case sensitivity of the qualifier.** The rewrite writes `basisSchemaName`
  exactly as spelled in `declare lens … over Y`, not the catalog's canonical
  casing. Resolution is case-insensitive so this should be cosmetic in
  `effective_sql`, but a body qualified `Y.` vs `y.` is worth a glance if
  anything downstream string-compares schema names.
- **Function sources.** Only `table` nodes are qualified; `from someTvf(…)` is
  untouched (TVFs resolve through the function registry, not the schema path).
  Unchanged behavior, but it is a boundary the new pass draws silently.
- **A bare name that is neither a CTE nor a basis table** is deliberately left
  alone so it produces today's ordinary unresolved-table error. Confirm that
  message is still the good one and not something more confusing now.

**Known gap, deliberately taken (recorded as a `NOTE:` on `collectCteNames`,
`lens-compiler.ts:~1361`, and in `docs/lens.md`).** The CTE shadow set is one
flat set over the whole body, not per-scope frames like
`schema/rename-rewriter.ts` maintains. A name used as a CTE *anywhere* disables
basis resolution for that name in *every* scope of that body. That
over-shadows a body meaning the basis table under one scope and a CTE under
another — such a source stays unqualified and reports the ordinary
unresolved-table error, i.e. it degrades to today's behavior rather than binding
the wrong relation. Per-scope frames are the upgrade path if a real body ever
needs it.

**One disagreement this fix introduces, probed and found benign.**
`resolveSingleBasisSource` in `schema/lens-prover.ts:351` still resolves a bare
`FROM` name against the basis. Post-fix the only bare names surviving in a
compiled body are CTE references or unresolvable ones, so on a *full-coverage*
CTE-shadow body (which deploys, since there is no gap to fill) the prover
resolves the shadowed basis table while the compiler now correctly treats it as
opaque. Probed directly: the read returns the CTE's rows (correct), and a write
is rejected loudly — `cannot write through view 'Car': view body operator
'CTEReference' is not updateable in phase 1` — before the mis-attributed source
can matter. No silent wrong write, so it was not filed as a ticket; a reviewer
who disagrees with that read has the repro above.

# Validation run

- `yarn workspace @quereus/quereus test` — **8400 passing, 13 pending**.
- `yarn test` (all workspaces) — green (`Done in 4m 27s`). The *first* invocation
  failed in `@quereus/plugin-loader` with `Failed to resolve entry for package
  "@quereus/quereus"`; that run rebuilt `packages/quereus/dist` mid-flight
  (`dist/src/index.js` mtime matched the run's start second) and the failure did
  not recur on the immediate re-run. A stale-`dist` build-ordering race, not a
  test failure, and nothing a lens-compiler edit could cause — noted rather than
  filed.
- `yarn lint` (all workspaces) — clean.
- `tsc --noEmit` on `packages/quereus` — clean.

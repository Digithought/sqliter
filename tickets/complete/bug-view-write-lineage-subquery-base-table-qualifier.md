---
description: Updating, deleting, or inserting through a view now works when the view's definition contains a sub-query that refers back to the view's own table by name or alias; previously it failed with a confusing "column not found" error.
files:
  - packages/quereus/src/planner/mutation/single-source.ts          # normalizeBaseRefs (~224-282), analyzeView (~476)
  - packages/quereus/test/logic/93.4-view-mutation.sqllogic         # blocks (t)-(ac) ~line 2120; join-body block ~line 527
  - docs/vu-operators.md                                            # § Selection, depth-split paragraph
repro: verified
---

# What was wrong

A view whose body computes a column with a correlated sub-query — or whose body's
own `where` contains one — could not be written through when that sub-query spelled
its correlation with a **qualifier**: the base table's name (`gt.id`) or the body's
alias for it (`from gt a … a.id`). The unqualified spelling (`where fk = id`)
already worked.

```sql
create view gv as select id, x, (select lbl from gl where gl.id = gt.id) as lbl from gt;
select * from gv;                          -- worked
update gv set x = 77 where lbl = 'one';    -- QuereusError: gt.id isn't a column
delete from gv where lbl = 'one';          -- QuereusError: gt.id isn't a column
```

The lowered UPDATE/DELETE targets the base table under a synthesised correlation
name (`__vm_self`), so nothing named `gt` is in scope. `normalizeBaseRefs` — which
prepares every definition fragment the lowering copies into the base statement —
walked only the fragment's top level, leaving a nested `gt.` qualifier verbatim.

# What shipped

`normalizeBaseRefs` (`planner/mutation/single-source.ts`) applies a **depth-split**
rule:

- **top level** → strip the base-source qualifier to a bare name (unchanged behavior);
- **nested**, inside one of the fragment's own sub-queries → **re-point** the
  qualifier at the lowered statement's correlation name.

Stripping at depth would be *wrong*, not merely redundant: a bare `id` inside the
sub-query re-binds to a same-named column of the sub-query's own FROM, collapsing
`gl.id = gt.id` into the tautology `gl.id = gl.id` — a silent wrong write. The
nested walk reuses `transformAliasScopedQuery` from `scope-transform.ts`, so it is
FROM-alias-scope-aware: a qualifier the sub-query's own FROM binds stays local, and
unqualified nested references are untouched.

`analyzeView` takes an optional `correlationName` (default: the base table's own
name) threaded into both `normalizeBaseRefs` calls. `rewriteViewUpdate` /
`rewriteViewDelete` pass `SELF_ALIAS`; `rewriteViewInsert` and `buildCteSelfCapture`
keep the default, since INSERT lowers onto the bare base-table name.

sqllogic coverage in `test/logic/93.4-view-mutation.sqllogic`:

| block | shape |
|---|---|
| (t) / (u) | base-table-name-qualified correlation in a computed lineage sub-query — UPDATE / DELETE |
| (v) | body aliases its source (`from qa_t a`), correlation spelled `a.id` |
| (w) | collision negative control — the sub-query's FROM has a same-named column, so a naive deep strip writes both rows silently |
| (x) | shadow negative control — the sub-query's FROM names the view's own base table, so its qualified refs stay local |
| (y) | the correlated sub-query lives in the view's own `where` |
| (z) | `returning` through such a view |
| (aa) | `insert … returning` through an **alias**-qualified lineage correlation (added in review) |
| (ab) | the correlation sits **two** sub-query levels down (added in review) |
| (ac) | **compound** (`union all`) legs inside a lineage sub-query scope independently (added in review) |
| join-body block (`axc_v`, § Phase 2 adversarial) | the multi-source parallel: a lineage sub-query correlating to a join side by that side's alias (added in review) |

# Review findings

## Verification run

- `yarn lint` — clean (exit 0, all workspaces).
- `yarn test` — **8516 passing, 13 pending, 0 failing** in `@quereus/quereus`; every
  other workspace green. Exit 0.
- `yarn docs:check` — fails only on `docs/schema.md` (word-count ratchet). That is the
  known pre-existing `debt-doc-size-ratchet-red-at-head` entry in
  `tickets/.pre-existing-known.md`; not re-reported. `docs/vu-operators.md` is not
  ratcheted and the added paragraph did not push any other file over.

## Correctness review — no defects found

Read the implement diff before the handoff summary and traced every consumer of the
changed analysis surface:

- **Is `__vm_self` always in scope where the re-pointed refs land?** Yes. Both
  `rewriteViewUpdate` and `rewriteViewDelete` set `alias: SELF_ALIAS` on the lowered
  statement **unconditionally** (single-source.ts:1293, :1327) — not gated on whether a
  descent happened — so a re-pointed nested ref always binds. Checked every other
  `analyzeView` caller: `rewriteViewInsert` and `buildCteSelfCapture` keep the default,
  and `buildCteSelfCapture` reads only `viewColumns` off the analysis, so the correlation
  name never reaches a copied fragment there. `analysis.filterPredicate` is consumed only
  by the two UPDATE/DELETE sites; `analysis.columnMap` only by `remapper`,
  `makeViewColumnDescend`, and `rewriteViewReturning` — all inside the aliased statement.
- **Does the nested clone drop the `storedBodyEnv` stamp?** No. `view-mutation-builder.ts`
  stamps the body via `mapNestedSelects` *before* `analyzeView` runs, and the nested walk's
  `rebuildSelect` spreads `{...sel}`, so the stamp survives the re-clone. This is the same
  field the sibling `bug-setop-right-leg-write-drops-declared-schema-path` ticket turned on,
  so it was worth confirming explicitly.
- **`makeBaseQualifyScope`'s `if (col.table) return undefined`** — the diff added a comment
  claiming it is still right. It is: the only qualified refs reaching it are the already-
  correct correlation name or a user-authored qualifier, both of which must be left alone.

## Test coverage — 4 blocks added, every listed gap closed or shown unwritable

The handoff listed five coverage gaps. Four are now covered, one is unwritable:

- **INSERT was a behavior change nobody tested** → block (aa). Counterfactual-verified:
  with the nested walk removed it fails `a.id isn't a column`; with the nested rewrite
  reduced to a naive strip it fails `Scalar subquery returned more than one row`.
- **Depth beyond one level** → block (ab). Same two counterfactuals, same discrimination.
- **Compound legs inside a lineage sub-query** → block (ac). Under the naive-strip
  counterfactual it is the one that shows the *silent wrong write* (both rows updated,
  no error) — the strongest of the three.
- **Multi-source not re-verified** → verified by direct probe, then pinned as a permanent
  regression guard (`axc_v` block in § Phase 2 adversarial). A join-body view with a
  side-alias-qualified lineage correlation writes correctly; the multi-source spine's
  `stripSideQualifier` re-points at any depth, so it genuinely never had this bug. No
  ticket needed.
- **`schema: undefined` clearing untested** → *unwritable, not merely untested.*
  Probed the engine directly: `resolveColumn` resolves no `schema.table.column` reference
  anywhere — `select main.pt.id from main.pt` fails with `main.pt.id isn't a column` — so
  a body with that spelling dies at `create view`, long before `normalizeBaseRefs` runs.
  The clear is unreachable defensive code. Kept (cheap, correct if that spelling is ever
  made resolvable) with a `NOTE:` at the site recording why no test can exist. This also
  disposes of a latent concern that the qualifier match ignores `col.schema`, so a
  hypothetical `other.gt.id` would be treated as a base-source ref: same unreachability,
  and the top-level strip has behaved that way since before this change.

Also verified that the pre-existing counterfactual claims in the handoff reproduce:
disabling the nested walk fails block (t) with the originally reported
`qt_t.id isn't a column`.

## Fixed inline (minor)

- **Three doc sites asserted a falsehood.** `normalizeBaseRefs`' doc comment,
  `analyzeView`'s doc comment, and `docs/vu-operators.md` all said the INSERT path's
  default correlation name makes the nested rewrite "a no-op there". Block (aa) disproves
  it: for an aliased body the rewrite `a.` → `qi_t.` is what makes the reference resolve
  at all — without it, `a.id isn't a column`. All three now say the no-op holds only for a
  body that already spells the qualifier as the table name.
- Added the `NOTE:` at the `schema: undefined` clear described above.
- Test-authoring slip caught during the pass: the new join-body block initially reused the
  shared `ax_child` fixture and silently broke a *later* block's assertion. Given its own
  tables.

## Tripwires (recorded in code, not filed as tickets)

- **`normalizeBaseRefs` now deep-clones each fragment's nested sub-selects.** Threading a
  `descend` changed them from shared-verbatim to cloned — once per view column plus the
  body `where`, per plan *build*, and plans are cached. Same order as the whole-body clone
  `view-mutation-builder.ts` already carries its own note about. `NOTE:` parked at the
  `transformExpr` call in `normalizeBaseRefs`, pointing at the same "gate on: body contains
  a nested sub-select" mitigation if it ever shows in a profile. Not measured — no profile
  was run, and none is warranted at this size.

## Not found / explicitly empty

- **No major findings, so no new tickets filed.** Nothing in the diff resolves at a code
  site that needs its own ticket: the one behavior change the handoff flagged as untested
  (INSERT) turned out to be a strict improvement, and it is now covered.
- **No `blocked/` items.** Nothing here needs a human decision.
- **Source hygiene: no action.** `single-source.ts` is 1426 lines (`wc -l`), up 15 from the
  implement commit, almost all doc comment. `normalizeBaseRefs` itself is 17 lines with a
  ~35-line doc block — heavy, but the ratio matches this file and its siblings throughout,
  and the prose is load-bearing (it records *why* stripping at depth is wrong). Splitting
  the file is a pre-existing question this diff does not move.

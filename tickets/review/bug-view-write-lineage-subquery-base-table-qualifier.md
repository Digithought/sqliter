---
description: Updating or deleting through a view now works when the view's definition contains a sub-query that refers back to the view's own table by name; previously it failed with a confusing "column not found" error.
files:
  - packages/quereus/src/planner/mutation/single-source.ts          # normalizeBaseRefs (~224-270), makeBaseQualifyScope doc (~300-320), analyzeView signature (~475) + call sites (~615-622), rewriteViewUpdate (~1180), rewriteViewDelete (~1300)
  - packages/quereus/test/logic/93.4-view-mutation.sqllogic         # new blocks (t)-(z) after (s), ~line 2120
  - docs/vu-operators.md                                            # § Selection — new paragraph after the `__vm_self` correlation-name paragraph
repro: verified
---

# What was wrong

A view whose body computes a column with a correlated sub-query — or whose body's
own `where` contains one — could not be updated or deleted through when that
sub-query spelled its correlation with a **qualifier**: the base table's name
(`gt.id`) or the body's alias for it (`from gt a … a.id`). The unqualified
spelling (`where fk = id`) already worked.

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

# What changed

`normalizeBaseRefs` (`planner/mutation/single-source.ts`) now applies a
**depth-split** rule:

- **top level** → strip the base-source qualifier to a bare name (unchanged behavior);
- **nested**, inside one of the fragment's own sub-queries → **re-point** the
  qualifier at the lowered statement's correlation name.

Stripping at depth would be *wrong*, not merely redundant: a bare `id` inside the
sub-query re-binds to a same-named column of the sub-query's own FROM, collapsing
`gl.id = gt.id` into the tautology `gl.id = gl.id` — a silent wrong write. The
nested walk reuses the existing `transformAliasScopedQuery` primitive from
`scope-transform.ts`, so it is FROM-alias-scope-aware: a qualifier the sub-query's
own FROM binds stays local, and unqualified nested references are untouched.

`analyzeView` gained an optional `correlationName` (default: the base table's own
name) threaded into both `normalizeBaseRefs` calls (`columnMap` and
`filterPredicate`). `rewriteViewUpdate` / `rewriteViewDelete` pass `SELF_ALIAS`;
`rewriteViewInsert` and `buildCteSelfCapture` keep the default, since INSERT
lowers onto the bare base-table name.

Doc comments updated: `normalizeBaseRefs` (the old comment asserted outright that
not descending "is correct here" — that claim *was* the bug) and
`makeBaseQualifyScope` (recording why its `if (col.table) return undefined` early
return is still right — every base-source qualifier is already resolved upstream,
so a qualified reference reaching it is user-authored).

`docs/vu-operators.md` § Selection gained a paragraph stating the depth-split rule,
the shadow rule, and the multi-source `stripSideQualifier` parallel.

# Use cases to exercise

New sqllogic blocks (t)–(z) in `test/logic/93.4-view-mutation.sqllogic`, continuing
the existing block-letter family after (s):

| block | shape | asserts |
|---|---|---|
| (t) | base-table-name-qualified correlation in a computed lineage sub-query, UPDATE | only the matching row writes; the plain `select` through the view still returns the correlated values |
| (u) | same, DELETE | only the matching row is removed |
| (v) | body aliases its source (`from qa_t a`), correlation spelled `a.id` | only the matching row writes |
| (w) | **collision negative control** — the lineage sub-query's FROM has a column of the same name as the correlated base column, and holds exactly one row so a degenerate sub-query still returns a scalar | only the matching row writes (a naive deep strip writes both — silently) |
| (x) | **shadow negative control** — the lineage sub-query's FROM names the view's own base table | its qualified refs stay local, so the computed column is the same constant for every row |
| (y) | the correlated sub-query lives in the **view's own `where`** | the update touches exactly the rows the view's `select` returns, and not the row outside it |
| (z) | `returning` through such a view | the re-projected computed column carries the correlated (not de-correlated) value |

Each block's comment states what the wrong behavior would produce, so the
assertion's discriminating power is visible without running the counterfactual.

# Verification actually performed

- `yarn workspace @quereus/quereus run test` — **8516 passing, 13 pending**, green.
- `yarn lint` — clean across all workspaces.
- **Counterfactual runs** (temporary edits, reverted; the working tree carries only
  the three intended files):
  - descend disabled entirely → block (t) fails with the original
    `QuereusError: qt_t.id isn't a column`, confirming the new coverage reproduces
    the reported defect;
  - nested rewrite reduced to a naive strip → block (t) fails with
    `Scalar subquery returned more than one row`, and the (w) shape (checked in an
    isolated scratch file, since sqllogic aborts on the first failure) silently
    writes `{"id":2,"x":9}` instead of leaving row 2 alone — confirming (w) catches
    the silent wrong write specifically.

# Known gaps / where to push

- **INSERT is a behavior change nobody tested.** `rewriteViewInsert` keeps the
  default correlation name, so a nested qualifier is now re-pointed from the body's
  *alias* to the base *table name* rather than left verbatim. For an aliased body
  (`from t a … a.id`) that is a fix (it previously could not resolve); for a
  table-name-qualified body it is a textual no-op. No sqllogic block covers
  INSERT — or `insert … returning` — through a view with an alias-qualified lineage
  correlation. Worth adding.
- **Depth beyond one level is untested.** A sub-query nested inside a lineage
  sub-query rides the same recursive `transformAliasScopedQuery`, but no test goes
  two levels down.
- **Compound (`union` / `intersect`) legs inside a lineage sub-query are untested.**
  `transformAliasScopedQuery` handles them (a sibling leg keeps the *incoming*
  alias-shadow set rather than the enclosing select's), but no block exercises the
  distinction.
- **The `schema: undefined` clearing is untested.** A body spelling its correlation
  fully qualified (`main.gt.id`) inside a lineage sub-query should re-point to a
  bare `__vm_self.id`, never `main.__vm_self.id`. The code clears it; no test
  proves it.
- Block (x)'s shadow control only discriminates against a hypothetical
  "re-point everything, ignore the shadow set" variant — it is unaffected by the
  strip-vs-re-point choice, so it is weaker evidence than (t)/(w).
- `multi-source.ts` was not touched. The ticket's analysis (verified before
  implementation) is that its side-alias qualifiers already round-trip through
  `transformAliasScopedExpr`, so the join-body equivalent of this view already
  worked. Not re-verified during implementation.

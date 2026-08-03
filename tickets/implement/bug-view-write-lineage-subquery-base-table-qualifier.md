---
description: Updating or deleting through a view fails with a confusing "column not found" error when the view's definition contains a sub-query that refers back to the view's own table by name.
files:
  - packages/quereus/src/planner/mutation/single-source.ts          # normalizeBaseRefs (~236) — the one site to change; analyzeView columnMap/filterPredicate (~569-579); rewriteViewUpdate (~1139) / rewriteViewDelete (~1259) call sites; SELF_ALIAS (~133)
  - packages/quereus/src/planner/mutation/scope-transform.ts        # transformAliasScopedQuery (~720) / collectFromAliases (~661) — the primitive to reuse; no change needed
  - packages/quereus/src/planner/mutation/multi-source.ts           # stripSideQualifier (~2710 doc block) — the proven precedent for this shape; verified unaffected
  - packages/quereus/test/logic/93.4-view-mutation.sqllogic         # blocks (k)–(s) at ~1963-2130 are the sibling coverage; new blocks go after (s)
  - docs/vu-operators.md                                            # § Selection, lines ~65-67 — the correlation-qualification narrative
difficulty: medium
repro: verified
---

# A definition sub-query's base-table-name correlation dies on the lowered target alias

## What happens

```sql
create table main.gt (id integer primary key, x integer);
create table main.gl (id integer primary key, lbl text);
insert into main.gt values (1, 10);
insert into main.gl values (1, 'one');
create view main.gv as select id, x, (select lbl from gl where gl.id = gt.id) as lbl from gt;

select * from main.gv;                          -- [{id:1, x:10, lbl:'one'}]   works
update main.gv set x = 77 where lbl = 'one';    -- QuereusError: gt.id isn't a column
delete from main.gv where lbl = 'one';          -- QuereusError: gt.id isn't a column
```

Verified on the current tree (repro spec run under `packages/quereus/test/`, then removed).

## Reproduced scope

| shape | today |
|---|---|
| view column computed by a sub-query correlating via `gt.id` (base table name) | UPDATE + DELETE fail |
| same, correlating via the body's alias (`from gt a` … `a.id`) | UPDATE fails (`a.id isn't a column`) |
| same, correlating **unqualified** (`… where fk = id`) | works |
| the **view's own WHERE** contains such a sub-query (`where x < (select lim from wl where wl.id = wt.id)`) | UPDATE fails the same way |
| INSERT through such a view (incl. `returning`) | works — INSERT lowers onto the bare base-table name, so `gt.` still resolves |
| UPDATE … RETURNING (no user `where`) | works — the RETURNING scope binds the base table name as well as the alias |
| multi-source (join-body) view with the same lineage sub-query | works — see "Why multi-source is fine" |

## Root cause — one site

`normalizeBaseRefs` (`planner/mutation/single-source.ts` ~236) prepares every
definition-derived fragment the lowering copies into the base statement: each view
column's base-term expression (`analysis.columnMap`) and the view body's own WHERE
(`analysis.filterPredicate`). It strips a base-source qualifier (`gt.` or the body's
alias) so the reference binds the lowered statement's single source — but it calls
`transformExpr` with **no `descend`**, so it walks the fragment's top level only. A
reference inside the fragment's own sub-query keeps its `gt.` qualifier verbatim.

The lowered UPDATE/DELETE targets the base table under the synthesised
collision-proof correlation name `__vm_self` (`SELF_ALIAS`), so nothing named `gt`
(or the body alias) is in scope, and resolution fails in `planner/resolve.ts`.

The sibling helper `makeBaseQualifyScope` (~292) also returns early on any qualified
reference (`if (col.table) return undefined;`), but it is **not** the site to change:
it only runs on the *descend* path (a fragment emitted inside a user sub-query
operand), whereas the failures above happen on the plain top-level substitution path
where `makeBaseQualifier` is never applied. Fixing `normalizeBaseRefs` covers both
paths; fixing `makeBaseQualifyScope` covers only one.

### Why a naive deep strip is wrong

Stripping `gt.id` → `id` inside the sub-query re-binds it to a same-named column of
the sub-query's **own** FROM by ordinary innermost-scope rules. In the repro above
`gl` has its own `id`, so the strip would silently turn the correlation into
`gl.id = gl.id` — a wrong write, not an error. The qualifier must be **re-pointed**
at the lowered correlation name, not removed. This is exactly what the multi-source
spine already does (`stripSideQualifier`: owning-side alias → `__vm_self`, at any
nesting depth, alias-scope-aware).

### Why multi-source is fine

`multi-source.ts` keeps side-alias qualifiers on its lineage terms and rewrites them
to `__vm_self` through `transformAliasScopedExpr`, so its equivalent view
(`select ma.id, ma.x, mb.y, (select lbl from ml where ml.id = ma.id) as lbl from ma join mb …`)
already updates correctly — verified. `makeSideQualifyScope` has the same
`if (col.table) return undefined` early return, but it is harmless there because no
base-alias-qualified reference ever survives to it. No change needed in
`multi-source.ts`.

### Relationship to `bug-view-write-subquery-shadow-analysis-wrong-schema`

That sibling defect is in the **column-name** shadow set (`tableSourceColumnNames`
resolving FROM sources in one fixed schema). The fix below deliberately uses only
the **FROM-alias** shadow set (`collectFromAliases`), which is schema-free and never
taints, so the two do not interact and neither blocks the other. Do not add a
`prereq`.

## Expected behavior

A correlation inside a copied definition fragment that names the view's own base
source — by the table's name or by the body's alias — binds the row being
updated/deleted, exactly as the unqualified spelling already does. A qualifier that
the fragment's *own* sub-query FROM binds stays local (innermost scope wins).

## The change (prototyped and verified)

Three edits in `planner/mutation/single-source.ts`. Import
`transformAliasScopedQuery` from `./scope-transform.js`, then:

```ts
function normalizeBaseRefs(expr: AST.Expression, aliases: ReadonlySet<string>, correlationName: string): AST.Expression {
	const stripTop = (col: AST.ColumnExpr): AST.Expression | undefined =>
		col.table && aliases.has(col.table.toLowerCase()) ? { type: 'column', name: col.name } : undefined;
	// Nested (inside one of the fragment's own subqueries): re-point the base-source
	// qualifier at the lowered statement's correlation name instead of stripping it —
	// a bare name there would re-bind to a same-named column of the subquery's own
	// FROM (innermost-scope SQL rules). A qualifier that subquery's FROM itself binds
	// is left local by the same rule.
	const requalifyNested = (col: AST.ColumnExpr, aliasShadow: ReadonlySet<string>): AST.Expression | undefined => {
		if (!col.table) return undefined;
		const lcQual = col.table.toLowerCase();
		if (aliasShadow.has(lcQual) || !aliases.has(lcQual)) return undefined;
		return { ...col, table: correlationName, schema: undefined };
	};
	return transformExpr(expr, stripTop, (q) => transformAliasScopedQuery(q, requalifyNested));
}
```

`analyzeView` takes an optional `correlationName` (defaulting to `baseTable.name`)
and threads it into both `normalizeBaseRefs` calls (`columnMap`, `filterPredicate`).
`rewriteViewUpdate` and `rewriteViewDelete` pass `SELF_ALIAS`; `rewriteViewInsert`
and `buildCteSelfCapture` keep the default (INSERT lowers onto the bare table name,
so the rewrite is a no-op there — matching today's working behavior).

Notes on the shape:

- Top-level behavior is deliberately unchanged (strip to bare). Only nested
  references are re-pointed. Blanket top-level qualification would also reach
  `rewriteViewReturning`, where `__vm_self` vs. the NEW/OLD row binding is a
  semantics question this ticket has no need to open.
- Unqualified nested references are left alone. They are already correct by
  construction: the sub-query's FROM is copied unchanged, so a name it shadows
  stays local and a name it does not falls out to the target row either way.
- `schema` is cleared alongside the qualifier so a `main.gt.id` spelling cannot
  produce `main.__vm_self.id`.

Verified with the prototype applied: all four broken shapes above pass, the
collision shape writes only the matching row, the "sub-query FROM names the base
table itself" shadow case still resolves locally, and the full
`yarn workspace @quereus/quereus run test` suite is green (8516 passing, 13
pending). The prototype was then reverted — the working tree is unchanged.

## TODO

- Apply the three edits in `planner/mutation/single-source.ts` described above.
- Update the `normalizeBaseRefs` doc comment: it currently states outright that it
  "does not descend into subqueries, which is correct here". That claim is the bug;
  replace it with the depth-split rule (top level strips, nested re-points).
- Update the `makeBaseQualifyScope` doc comment (~275-291) to record *why* its
  `if (col.table) return undefined` early return is still right — base-alias
  qualifiers are already resolved upstream by `normalizeBaseRefs`, so a qualified
  reference reaching it is user-authored and must stay untouched.
- Add sqllogic coverage in `test/logic/93.4-view-mutation.sqllogic`, continuing the
  block-letter family after `(s)` (~line 2130):
  - base-table-name-qualified correlation inside a computed lineage sub-query —
    UPDATE, plus the DELETE variant;
  - the same with the body aliasing its source (`from t a` … `a.id`);
  - the **collision** negative control: the lineage sub-query's own FROM carries a
    column of the same name as the correlated base column, asserting only the
    matching row is written (this is what a naive strip would get wrong silently);
  - the **shadow** negative control: the lineage sub-query's FROM names the view's
    own base table, asserting its qualified references stay local;
  - a base-qualified correlation sub-query in the **view's own WHERE**, asserting
    the update touches exactly the rows the matching `select` returns;
  - `returning` through such a view, asserting the re-projected computed column.
- Update `docs/vu-operators.md` § Selection (lines ~65-67): the narrative describes
  qualifying *unqualified* base refs only. Add that a base-source-**qualified**
  reference inside a copied definition fragment is re-pointed at the lowered
  correlation name, with the FROM-alias shadow rule, and note the multi-source
  `stripSideQualifier` parallel.
- Run `yarn workspace @quereus/quereus run test` and `yarn lint` before handing off.

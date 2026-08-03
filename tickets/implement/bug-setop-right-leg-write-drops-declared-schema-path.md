---
description: A view can name the schemas its tables should be looked up in. When such a view combines two queries with `union`, updating through it works for the first query but fails with "table not found" for the second — the second half forgets which schemas the definition asked for.
files:
  - packages/quereus/src/planner/mutation/set-op.ts                   # buildBranch (~660) + flaglessShape (~1597) — the one site; add `withDeclaredPath`
  - packages/quereus/test/view-home-schema.spec.ts                    # `reaches the LEFT leg of a membership set-op definition that declares a path` — new cases go beside it
  - docs/view-updateability.md                                        # § Schema resolution during write-through, last paragraph (~line 123) names this slug as still-open
repro: verified
difficulty: easy
---

# A set-operation view's non-leading legs lose the definition's declared `with schema` path on write

## What is wrong

A `select` can end in `with schema a, b`, naming the schemas its unqualified table names
resolve against. When the select is a set operation (`union` / `intersect` / `except`), the
clause binds to the **whole compound**, and the parser attaches it to the leading leg's
statement node only — legs after the first never carry it themselves (`isCompoundSubquery`
suppression in `parser/parser.ts`).

On **read** that is harmless: `buildSelectStmt` applies `stmt.schemaPath` to the context once,
then hands that one context to `buildCompoundSelect`, so every leg sees the declared path.

On **write** each leg is lowered separately through its own synthetic branch view-like, whose
body is that leg's `SelectStmt`. The leading leg's body is a spread of the compound's root
node, so it keeps `schemaPath` by accident; every other leg's body is a spread of an operand
that never had it. Those legs plan on the view's plain home path, and any unqualified name
only the declared path reaches fails to resolve.

## Reproduction (verified on the current tree, all three arms)

```sql
create table main.sl (id integer primary key, x integer);
create table main.sr (id integer primary key, x integer);
create table temp.ok (id integer primary key);
insert into main.sl values (1, 10);
insert into main.sr values (2, 20);
insert into temp.ok values (1), (2);

create view main.sv as
  select id, x from sl
  with schema "temp", main
  union exists left as inl, exists right as inr
  select id, x from sr where id in (select id from ok);

select * from main.sv;                        -- both rows — the read is fine
update main.sv set x = x + 1 where inr = true;
delete from main.sv where inr = true;
```

Both the `update` and the `delete` fail with:

```
Table 'ok' not found in schema path: main
  Did you mean: temp.ok?
  Or add 'temp' to your WITH SCHEMA clause
```

The hint is misleading — the definition does name `temp`.

The **flag-less** (literal-discriminator) route fails identically, and its failure lands even
earlier, inside `analyzeFlaglessSetOpView`'s per-leg oracle plan:

```sql
create view main.fv as select id, x, 'L' as src from fl
  with schema "temp", main
  union all select id, x, 'R' as src from fr where id in (select id from ok);

update main.fv set x = x + 1 where src = 'R';   -- same "Table 'ok' not found" error
```

Moving the same sub-query to the leading leg makes the identical statement succeed, which is
what makes the failure look arbitrary from outside. That leading-leg case is already pinned by
`reaches the LEFT leg of a membership set-op definition that declares a path` in
`test/view-home-schema.spec.ts`, whose comment names this ticket as the known gap.

## Root cause — one site, two callers

Both routes derive a leg's body AST in `planner/mutation/set-op.ts`, and both drop the path at
the same point: the moment the leg SELECT is separated from the compound root.

- membership route — `buildBranch` (~line 660): `const effectiveSelect = unwrapBranchSelect(branchSelect)`.
  `unwrapBranchSelect` also strips it in the left-wrapped case (`select * from (<compound>)`,
  the parenthesized-left-operand shape), so even the leading leg loses it there.
- flag-less route — `flaglessShape` (~line 1597): legs 2..n come from
  `unwrapBranchSelect(stripLegModifiers(right))`, an operand the parser never let carry the clause.

Fix: stamp the compound's declared path onto a leg that has none of its own, right after the
unwrap. `buildSelectStmt` then applies `stmt.schemaPath` for that leg exactly as it does for the
leading one. A definition with no `with schema` clause is untouched — `withDeclaredPath` is the
identity when `declaredPath` is `undefined`.

### Why not honour the fragment marker instead

Every nested sub-select of the body already carries a stamped `AST.StoredBodyEnv` whose
`schemaPath` **is** the declared path, so it looks like the fix could be to honour that marker
even when the at-home guard (`ctx.storedBodyOf === env.homeSchema`) says no swap is needed. It
cannot: that guard is also what stops a sub-select with its *own* `with schema` clause, nested
inside a fragment, from having the body's declared path re-imposed over it — the read path's
precedence, pinned by `lets a fragment sub-select's OWN 'with schema' outrank the carried path`
in the same spec. The branch **body**'s own path is the thing to fix.

## The change (prototyped and verified — full quereus suite green, 8511 passing / 13 pending)

```diff
@@ analyzeSetOpView
 	const branches: [SetOpBranch, SetOpBranch] = [
-		buildBranch(view, 'left', leftBranchSelect(sel), dataColCount, flags),
-		buildBranch(view, 'right', rightBranchSelect(view, compound.select), dataColCount, flags),
+		buildBranch(view, 'left', leftBranchSelect(sel), dataColCount, flags, sel.schemaPath),
+		buildBranch(view, 'right', rightBranchSelect(view, compound.select), dataColCount, flags, sel.schemaPath),
 	];

@@ analyzeSetOpBranches            // the nested-subtree recursion
 	return [
-		buildBranch(view, 'left', leftBranchSelect(sel), dataColCount, innerFlags),
-		buildBranch(view, 'right', rightBranchSelect(view, compound.select), dataColCount, innerFlags),
+		buildBranch(view, 'left', leftBranchSelect(sel), dataColCount, innerFlags, sel.schemaPath),
+		buildBranch(view, 'right', rightBranchSelect(view, compound.select), dataColCount, innerFlags, sel.schemaPath),
 	];

@@ beside unwrapBranchSelect
+/** Stamp the compound's declared `with schema` path onto a leg that has none of its own. */
+function withDeclaredPath(sel: AST.SelectStmt, declaredPath: string[] | undefined): AST.SelectStmt {
+	if (!declaredPath || sel.schemaPath) return sel;
+	return { ...sel, schemaPath: declaredPath };
+}

@@ buildBranch
 	flags: readonly MembershipFlag[],
+	declaredPath?: string[],
 ): SetOpBranch {
-	const effectiveSelect = unwrapBranchSelect(branchSelect);
+	const effectiveSelect = withDeclaredPath(unwrapBranchSelect(branchSelect), declaredPath);

@@ flaglessShape
 	let cur: AST.SelectStmt = sel;
+	let declared = sel.schemaPath;
 	for (;;) {
-		const leftLeg = unwrapBranchSelect(leftBranchSelect(cur));
+		const leftLeg = withDeclaredPath(unwrapBranchSelect(leftBranchSelect(cur)), declared);
 		…
-		const rightEff = unwrapBranchSelect(stripLegModifiers(right));
+		const rightEff = withDeclaredPath(unwrapBranchSelect(stripLegModifiers(right)), declared);
 		…
+		declared = rightEff.schemaPath ?? declared;   // a parenthesized sub-compound's own path wins for its legs
 		cur = rightEff;
 	}
```

Nesting falls out for free: `buildBranch` stamps the path onto the subtree operand's body, and
`analyzeSetOpBranches` reads `sel.schemaPath` back off that stamped body when it recurses, so
the path reaches leaves at any depth.

Recursion in `analyzeSetOpBranches` takes `sel.schemaPath` from `branchView.selectAst`, which
`buildBranch` already stamped — do not re-thread the outer view's path through the recursion, or
a nested compound that declares its own path would be overridden.

`flaglessShape` is also read by the static surfaces (`isSetOpFlaglessWritableBody`,
`flaglessDiscriminatorColumnNames`); stamping a path on a leg SELECT does not change what those
compute.

## TODO

- Apply the change in `packages/quereus/src/planner/mutation/set-op.ts` (both routes, plus the
  `withDeclaredPath` helper beside `unwrapBranchSelect`).
- Extend the doc comments already on `buildBranch` / `flaglessShape` to say that the compound's
  declared `with schema` path is stamped onto a leg that has none, and why (the parser binds the
  clause to the compound and attaches it to the leading leg only).
- Add tests to `packages/quereus/test/view-home-schema.spec.ts`, beside the existing left-leg
  case:
  - membership set-op, sub-select in the RIGHT leg — `update` and `delete` both reach it;
  - flag-less literal-discriminator set-op, sub-select in the non-leading leg — `update` reaches it;
  - a set-op definition with NO `with schema` clause still resolves on the home path (guards
    against over-application).
- Update the existing left-leg test's `KNOWN GAP` comment (`test/view-home-schema.spec.ts` ~816)
  — the gap is closed; drop the forward reference to this slug.
- Update `docs/view-updateability.md` § Schema resolution during write-through: the closing
  paragraph (~line 123) lists this slug among the still-open related defects. Remove it from
  that list and, in the same section, note that a set-op body's non-leading legs are stamped with
  the compound's declared path when their branch body is built.
- Run `yarn workspace @quereus/quereus run test` and `yarn lint`.

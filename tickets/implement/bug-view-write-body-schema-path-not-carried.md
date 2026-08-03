---
description: A view definition can name the schemas its tables should be looked up in. Reading such a view works, but updating or deleting through it fails with "table not found" — the write forgets which schemas the definition asked for. Carry that list into the write.
files:
  - packages/quereus/src/parser/ast.ts                                # SelectStmt.storedHomeSchema / storedBodyCTEs (~198-225) — the markers to fold
  - packages/quereus/src/planner/building/view-mutation-builder.ts    # buildViewMutation — the mapNestedSelects stamp (~118-129)
  - packages/quereus/src/planner/building/select.ts                   # buildSelectStmt (~80-115) — consumes the markers; the ordering site
  - packages/quereus/src/planner/building/select-context.ts           # buildStoredBodyCTEs (~76) — builds the carried definitions
  - packages/quereus/src/planner/stored-body-context.ts               # storedBodyContext — sets schemaPath to the home path
  - packages/quereus/src/planner/mutation/scope-transform.ts          # mapNestedSelects (~184-236) — doc-only update
  - packages/quereus/src/planner/planning-context.ts                  # storedBodyOf / storedBodyCTECache docs (~193-220) — doc-only update
  - packages/quereus/test/view-home-schema.spec.ts                    # where the new coverage goes
  - docs/view-updateability.md                                        # § Schema resolution during write-through — has a paragraph describing this defect as open
repro: verified
difficulty: medium
---

# Carry a view definition's declared `with schema` path into write-through lowering

A `select` can end with `with schema a, b`, naming the schemas its unqualified table
names resolve against. A view definition is a `select`, so a view can carry one. On
**read** the clause is honoured. On **write** — `update` / `delete` / `insert` through
the view — it is honoured for the definition's own `from` sources but not for any
sub-query inside the definition, so the write and the matching read disagree about
which tables exist.

Both reproductions below were run on the current tree and fail; both pass with the
prototype described under *The fix*.

```sql
create table main.a (id integer primary key, x integer);
create table temp.t (id integer primary key);
insert into main.a values (1, 10);
insert into temp.t values (1);

create view main.vq as
  select id, x from a where id in (select id from t)
  with schema "temp", main;

select * from main.vq;              -- [{id: 1, x: 10}] — `t` resolves in temp
update main.vq set x = 48 where id = 1;
```

```
Table 't' not found in schema path: main
  Did you mean: temp.t?
  Or add 'temp' to your WITH SCHEMA clause
```

The suggestion is misleading — the definition *does* name `temp`. The same failure
appears when the sub-query reads a block defined in the definition's own leading
`with` clause:

```sql
create view main.vp as
  with c as (select id from t) select id, x from a where id in (select id from c)
  with schema "temp", main;
```

Here the failure is raised one level deeper — while *building* the carried block `c`,
whose own `from t` resolves on the home path instead of the declared one. That detail
fixes the ordering requirement below.

A definition with no sub-query at all is unaffected (`create view main.vz as select id,
id as x from t with schema "temp", main` updates correctly), which is what makes the
failure look arbitrary from outside.

## Why it happens

A write through a view is not executed as the body plan — it is *lowered* into a plain
statement against the base table, and pieces of the definition (the view's own `where`,
each view column's base-term expression, an authored `with inverse` put, a `with
defaults` value) are copied into it. That lowered statement is a mix of caller-authored
clauses and definition-derived fragments planned on **one** (caller's) context, so the
"which naming environment does this piece belong to" decision cannot ride the context —
it rides the AST node. `buildViewMutation` deep-clones the body and stamps every nested
sub-select with two markers:

- `AST.SelectStmt.storedHomeSchema` — the view's schema name, which `buildSelectStmt`
  turns into the view's *home* search path via `storedBodyContext`;
- `AST.SelectStmt.storedBodyCTEs` — the definition's own leading `with` clause, since
  re-entering the home environment clears the caller's CTE namespace.

The definition's declared `with schema` path is a third piece of the same environment,
and it is **not** stamped. It lives on the definition's top-level `SelectStmt` node,
which is not one of the copied pieces, so it is never consulted for them. The
definition's own `from` sources escape the bug only because they are planned from that
top-level node, which still carries the clause.

This is independent of the recently-landed carry of the leading `with` clause
(`bug-view-write-body-cte-not-carried-into-lowering`) — the first reproduction has no
`with` clause at all. It has been latent since the fragment tagging landed
(`bug-view-write-subquery-in-body-uses-caller-schema`).

## The fix

Carry the declared path on the same stamp, and apply it in `buildSelectStmt` between
the home swap and the carried-`with`-clause build.

**Fold the three markers into one object** rather than adding a third parallel optional
field. They are always stamped together, always consumed together, and their consumption
*order* matters — a single object gives that invariant one place to live and one place to
document, instead of three optionals that a future fourth piece can silently miss. The
fold is cheap right now: `storedHomeSchema` and `storedBodyCTEs` have exactly **five**
code references between them (two declarations in `ast.ts`, one stamp in
`view-mutation-builder.ts`, two reads in `select.ts`); everything else that names them is
prose. It gets more expensive the longer it waits.

```ts
// parser/ast.ts — write-through lowering metadata ONLY; never set by the parser.
export interface StoredBodyEnv {
	/** Schema the stored view / MV this fragment was copied out of lives in. */
	readonly homeSchema: string;
	/** The definition's declared `with schema` path, when it has one. */
	readonly schemaPath?: string[];
	/** The definition's own leading `with` clause, when it has one. */
	readonly withClause?: WithClause;
}

export interface SelectStmt extends AstNode {
	// … replaces `storedHomeSchema` + `storedBodyCTEs`
	storedBodyEnv?: StoredBodyEnv;
}
```

Type `schemaPath` as `string[]` (not `readonly string[]`) to match
`SelectStmt.schemaPath` and `PlanningContext.schemaPath`; a `readonly` array would need a
copy at the assignment site for no benefit.

In `buildViewMutation` build one `StoredBodyEnv` per lowering and spread it onto every
clone, reading `schemaPath` and `withClause` off the body select under the same
`!viewIn.ephemeral && viewIn.selectAst.type === 'select'` guard `bodyCTEs` already uses.
Keep `PlanningContext.storedBodyCTECache` keyed on the **`WithClause` object**, not the
env object — that key is what keeps a second lowering of a different view in the same
statement from sharing the first view's definitions.

In `buildSelectStmt` the order must be:

1. `storedBodyContext(ctx, env.homeSchema)` — home path, caller's CTE namespace cleared;
2. **then** override `schemaPath` with `env.schemaPath` when the definition declared one;
3. **then** `buildStoredBodyCTEs(...)` on that context — so a carried block's own sources
   resolve on the declared path, exactly as they do on the read path (this is what the
   second reproduction pins: it currently fails *inside* `buildStoredBodyCTEs`);
4. **then** the existing `stmt.schemaPath` override — a fragment's own `with schema`
   clause still wins over the carried one.

Do not push the declared path into `storedBodyContext` instead. That function is shared
with the read path and takes only a schema name; it has no access to the body AST, and on
the read path the body's top-level node applies its own `schemaPath` already.

The prototype of exactly this (three lines plus the marker) turns both reproductions
green and leaves the no-`with schema` control and the fragment-override case unchanged.

## Expected behavior

A sub-query copied out of a view definition resolves its unqualified names exactly as it
does when the view is read: the definition's declared `with schema` path when it has one,
the view's home path otherwise. A definition without a `with schema` clause keeps today's
home-path behaviour byte-for-byte.

## Relationship to the open siblings

`fix/bug-view-write-subquery-shadow-analysis-wrong-schema` is the *analysis*-side sibling:
it resolves a fragment's `from` sources against one fixed schema rather than any path, at
a different site (`tableSourceColumnNames` in `planner/mutation/scope-transform.ts`). The
two answer the same question — "which path does this fragment resolve on" — and should end
up reading **one** answer. Folding the markers here is what makes that possible: the
analysis walks the same AST, so after this lands it can read a fragment's whole naming
environment off one property instead of reassembling it. Nothing in this ticket blocks on
that one, and it touches none of the same code (only doc comments in
`scope-transform.ts`), so no `prereq:` is declared. Say so in the review handoff so the
sibling's fix stage knows the shape is already there.

`fix/bug-view-write-lineage-subquery-base-table-qualifier` is in the same machinery but at
a third site (qualifier spelling); no overlap.

## Tests

New coverage belongs in `packages/quereus/test/view-home-schema.spec.ts`, whose
`home-schema resolution for sub-selects copied out of a view body` describe is the direct
predecessor. `test/view-cte-isolation.spec.ts` holds the carried-`with`-clause sibling —
cross-reference it from the new block's doc comment rather than duplicating setup.

TODO
- [ ] Add `StoredBodyEnv` to `parser/ast.ts`; replace `SelectStmt.storedHomeSchema` and
      `SelectStmt.storedBodyCTEs` with a single `storedBodyEnv?: StoredBodyEnv`, carrying
      the existing doc prose across and adding the `schemaPath` field's own.
- [ ] `buildViewMutation`: build one `StoredBodyEnv` per lowering (home schema + the body
      select's `schemaPath` + its `withClause`, under the existing ephemeral / `type ===
      'select'` guard) and stamp it via `mapNestedSelects`. Keep the
      `rejectDataModifyingBodyCTE` gate reading the same `withClause`.
- [ ] `buildSelectStmt`: read `stmt.storedBodyEnv`; keep the `ctx.storedBodyOf` inertness
      guard on `env.homeSchema`; apply the declared path in step 2 of the order above.
      Update the surrounding comment block to describe all three carried pieces and why
      the order is what it is.
- [ ] `buildStoredBodyCTEs`: take the clause off the env; confirm the memo stays keyed on
      the `WithClause` object.
- [ ] Update the doc comments that name the retired markers by name:
      `planner/mutation/scope-transform.ts` (`mapNestedSelects`),
      `planner/planning-context.ts` (`storedBodyOf`, `storedBodyCTECache`),
      `planner/stored-body-context.ts`.
- [ ] Tests — `update` and `delete` through a view whose definition declares
      `with schema` and whose `where` holds a sub-query (the primary repro).
- [ ] Tests — same, for a definition with a leading `with` clause whose block resolves
      through the declared path (the second repro; this is the one that pins the
      path-before-`buildStoredBodyCTEs` ordering).
- [ ] Tests — a fragment sub-select carrying its **own** `with schema` still wins over
      the carried path (precedence guard; passes today, must keep passing).
- [ ] Tests — control: a definition with no `with schema` clause resolves on the home path
      unchanged, in a case where a declared path would have differed.
- [ ] Tests — one materialized-view arm and one insert-through arm (a `with defaults (col
      = (select …))` value or a `with inverse` put), since those fragments ride the same
      stamp through different copy channels.
- [ ] Probe a **compound** (`union` / set-op) definition that declares `with schema`:
      `mapNestedSelects` stamps compound legs as nested, so the carry should reach a
      set-op spine's per-branch synthetic view-likes for free. Confirm with a test; if it
      does not, note it in the review handoff rather than expanding scope here.
- [ ] `docs/view-updateability.md` § Schema resolution during write-through: the paragraph
      beginning "The stamp carries the view's home **schema name**, not the body's declared
      search path" describes this defect as open and names this slug — rewrite it to
      describe the delivered carry, the marker fold, and the consumption order. Check the
      neighbouring paragraphs for marker names that the fold retires.
- [ ] `yarn lint` and `yarn test` from the repo root.

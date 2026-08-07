---
description: Renaming a table onto a name that a saved query already uses for one of its other data sources makes the query read the same table twice, so it silently returns the wrong rows with no error.
prereq: rename-preserves-untouched-name-meaning
files:
  - packages/quereus/src/schema/rename/table-rename.ts        # renameTableInAst sink (~130), TableRef (~54), resolveQualifier (~350), collectFromBindings (~395), case 'table' (~609), case 'column' (~708)
  - packages/quereus/src/schema/schema-differ.ts              # inverseRenamedViewParts (~1460) + the NOTE at ~1475
  - packages/quereus/src/util/ast-spine-clone.ts              # doc comment lists the fields the rewriters assign to
  - packages/quereus/test/schema/rename-cross-schema.spec.ts  # post-condition describe (~511) and collision grid (~590)
  - packages/quereus/test/schema/table-rename-scope.spec.ts   # the walker's scope grid
  - packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic
  - packages/quereus/docs/sql-alter.md                        # line 27 — the "Known limitation" paragraph
difficulty: hard
repro: verified
---

# A rename must not change what a *qualifier* in a body binds

Inside one saved query, the name a `FROM` source exposes for use as a column
qualifier is that source's table name (or its alias, when it has one). Renaming a
source onto a name that is **already a live qualifier in that part of the body**
leaves two sources spelled the same, and every qualifier written that way then
points at whichever one wins.

This is the qualifier-namespace twin of the catalog-namespace rule
`rename-preserves-untouched-name-meaning` establishes. Same sink, different
namespace: that ticket asks "does this name still find the same *catalog
object*", this one asks "does this qualifier still bind the same *FROM source*".

## What was measured

All four sub-cases below were run against the engine as it stands (a scratch
script driving `Database.exec` / `Database.eval` under
`node --import ./packages/quereus/register.mjs`). All four are silent — no error,
just different rows. The rewritten body text is quoted from
`schemaManager.getView(...)!.sql`.

### 2a — collides with a sibling FROM source in another schema

```sql
create table main.t (id integer primary key, x integer);   insert into main.t values (1, 10);
create table temp.t2 (id integer primary key, x integer);  insert into temp.t2 values (2, 20);

create view temp.v as
  select t.x as a, t2.x as b from t join temp.t2 on t.id = t2.id - 1;
select * from temp.v;                   -- [{"a":10,"b":20}]

alter table main.t rename to t2;
select * from temp.v;                   -- []              ← no error, no rows
-- body: select t2.x as a, t2.x as b from main.t2 inner join "temp".t2 on t2.id = t2.id - 1
```

The schema qualifier on the source is correct and does not help: a column
qualifier is matched against the source's *bare* name. The join condition has
become self-referential and the projection reads one table twice.

### 2b — collides with a sibling's alias

```sql
create table main.t (id integer primary key, x integer);  insert into main.t values (1, 10);
create table main.u (id integer primary key, x integer);  insert into main.u values (1, 77);

create view temp.v as select t.x as a, t2.x as b from t join u as t2 on t.id = t2.id;
select * from temp.v;                   -- [{"a":10,"b":77}]

alter table main.t rename to t2;
select * from temp.v;                   -- [{"a":10,"b":10}]   ← b now reads main.t2
-- body: select t2.x as a, t2.x as b from t2 inner join u as t2 on t2.id = t2.id
```

Note this one needs no second schema — it collides entirely within `main`.

### 2c — collides with a CTE the body declares

```sql
create table main.t (id integer primary key, x integer);  insert into main.t values (1, 10);

create view temp.v as
  with t2 as (select 1 as id, 999 as x)
  select t.x as a, t2.x as b from t join t2 on t.id = t2.id;
select * from temp.v;                   -- [{"a":10,"b":999}]

alter table main.t rename to t2;
select * from temp.v;                   -- [{"a":999,"b":999}]
-- body: with t2 as (...) select t2.x as a, t2.x as b from t2 inner join t2 on t2.id = t2.id
```

The renamed source now binds the CTE outright. Also single-schema.

### 2e — collides with an *enclosing* frame's qualifier

```sql
create table main.t (id integer primary key, x integer);   insert into main.t values (1, 10);
create table temp.t2 (id integer primary key, x integer);
insert into temp.t2 values (1, 20), (7, 70);              -- id 7 has no main.t match

create view temp.v as
  select t2.x as a from temp.t2 where exists (select 1 from t where t.id = t2.id);
select * from temp.v order by a;        -- [{"a":20}]

alter table main.t rename to t2;
select * from temp.v order by a;        -- [{"a":20},{"a":70}]   ← correlation lost
-- body: select t2.x as a from "temp".t2 where exists (select 1 from main.t2 where t2.id = t2.id)
```

The renamed **inner** source now shadows the outer `t2` for everything inside the
subquery, so the correlated `EXISTS` silently became uncorrelated and admits a
row it must not.

### 2d — control: a source that already carries an author alias

```sql
create view temp.v as select tt.x as a, t2.x as b from t as tt join temp.t2 on tt.id = t2.id;
alter table main.t rename to t2;
select * from temp.v;                   -- [{"a":10,"b":20}]     ← correct today
-- body: select tt.x as a, t2.x as b from main.t2 as tt inner join "temp".t2 on tt.id = t2.id
```

Correct because an aliased source exposes its alias, which a rename never moves.
The fix must keep this case behaving exactly as it does now.

## The rule

> The bare qualifier a FROM source exposes must keep binding that source. When
> renaming an **unaliased** source would give it a name already visible as a
> qualifier where that source sits, pin the pre-rename spelling as an explicit
> alias instead of letting the two collapse.

So 2a becomes `from main.t2 as t inner join "temp".t2 …` with `t.x` / `t.id` left
untouched, and the same shape resolves 2b, 2c and 2e.

"Already visible as a qualifier where the source sits" is one predicate covering
all four: a sibling entry in the source's own FROM frame, a sibling's alias, a
CTE declared in any enclosing `WITH` frame, or a binding contributed by any
enclosing FROM frame. The walk's scope stack already holds all of them —
`resolveQualifier` walks exactly that chain today.

## Mechanics

Two new optional members on `TableRef` (`rename/table-rename.ts:54`), following
the existing convention there that **absence is a signal**:

```ts
/**
 * Present only for a reference that binds through a FROM frame — an UNALIASED
 * FROM source, or a bare column qualifier bound to one. Answers: would giving
 * that source the bare name `next` collide with a qualifier already visible
 * where the SOURCE sits? Both sites must get the same answer, so it is
 * evaluated at the source's own frame depth, never the walk's current depth.
 */
qualifierCollides?: (next: string) => boolean;
/**
 * FROM-source only, and only for a source with NO author-written alias: pin
 * the pre-rename bare name as an explicit alias so qualifiers spelled that way
 * keep binding this source. Absent on an aliased source — the rename cannot
 * move an alias, so there is nothing to preserve.
 */
aliasAs?: (aliasName: string) => void;
```

Sink, over the branch `rename-preserves-untouched-name-meaning` leaves in place:

```ts
const collides = !eq(oldName, newName) && (ref.qualifierCollides?.(newName) ?? false);
// A qualifier bound to a source we are about to alias keeps its spelling.
if (collides && !ref.aliasAs) return;
ref.setName(newName);
changed = true;
if (collides) ref.aliasAs(oldName);
// …existing catalog post-condition (qualify) unchanged…
```

Supporting changes in the walk:

- `resolveQualifier` (~line 350) must return the frame **index** alongside the
  binding, so a column qualifier's `qualifierCollides` scans the stack only up to
  and including the frame that binds it. Without that truncation, a deeper frame
  binding the new name would falsely trigger.
- `case 'table'` (~line 609) evaluates the predicate at `stack.length - 1`. That
  frame is always the source's own FROM frame: `collectFromBindings` fills it
  before anything under the FROM is visited, and `case 'table'` is reachable only
  from a select's `from` array (directly or through `join`) —
  `UpdateStmt.targetSource` / `DeleteStmt.targetSource` are typed
  `AST.SubquerySource`, never a bare table.
- The predicate must be a **pure function of frame state**, not of "have we
  already aliased the source". The select arm visits result columns *before*
  `stmt.from`, so `t.x` is reached before the source it binds. `collectFromBindings`
  runs before the frame is pushed and records pre-rewrite names, so frame state is
  stable across the whole subtree — which is what makes both emit sites agree.
- An aliased source reports no `qualifierCollides` (and no `aliasAs`), which is
  what preserves case 2d.
- Guard the whole thing on `!eq(oldName, newName)` so a case-only rename never
  self-collides.

Deliberately conservative: it aliases whenever the new name is visible in scope,
even when nothing in the source's subtree actually spells it. Detecting real use
would need a second pass over the subtree; the extra alias is harmless and the
predicate only fires in a genuine collision. Record that as a `NOTE:` at the site.

## The differ needs a real counterpart this time

`inverseRenamedViewParts` (`schema-differ.ts:1460`) inverse-applies in-diff table
renames NEW→OLD over a clone of the declared body, and the existing `NOTE:` at
line 1475 argues the forward rename's *schema qualifier* is unreachable there
because qualification needs the body's home schema to differ from the renamed
table's, while a diff covers one schema at a time.

**That argument does not carry to the alias.** Sub-cases 2b and 2c above collide
entirely inside one schema, so the forward rename genuinely writes `from t2 as t`
into a single-schema body. A re-diff would read that as a body edit and emit a
spurious drop+recreate — back to the collapsing spelling.

The self-inverting rule: during the inverse pass, drop an alias that equals the
source's **post-inverse** bare name. `from t2 as t` inverse-renames to
`from t as t`, whose alias is redundant, so it renders as `from t` — exactly the
declared form. An author-written `from t as t` is semantically identical, so
dropping it costs nothing beyond canonical-string normalization (make sure the
declared side canonicalizes the same way, or the compare re-diverges).

### Second arm at the same site — the schema qualifier IS reachable too

*Added by the review of `rename-preserves-untouched-name-meaning`; `repro:
verified` against that ticket's landed code.*

That prereq added a second place the forward rename writes a spelling the
declared side has no counterpart for. It schema-qualifies a reference the rename
never rewrote, when the name the rename **creates** would otherwise capture it —
and unlike the qualifier the *rewritten* arm adds, this one does not need the
body's home schema to differ from the renamed table's. It qualifies to the schema
the reference resolved to **before**, which is always a *later* schema on the home
path, so one schema in the diff is enough.

Measured on the current tree, default session `schema_path`, no pragma:

```sql
create table main.k (id integer primary key, x integer);      -- 1, 10
create table temp.other (id integer primary key, x integer);  -- 99, 999
create view temp.v as select id, x from k;   -- bare k falls through to main.k

declare schema temp {
  table k { id integer primary key, x integer } with tags ("quereus.previous_name" = 'other')
  view v as select id, x from k
}

diff schema temp;   -- [ALTER TABLE "temp".other RENAME TO k]      ← correct
apply schema temp;
-- live body is now: select id, x from main.k   (the pin — reads main.k, correct)
diff schema temp;   -- [DROP VIEW IF EXISTS "temp".v,
                    --  create view "temp".v as select id, x from k]
```

Two things are wrong there. `apply` no longer **converges in one pass** — the
existing round-trip invariant (`50.2-declare-schema-renames.sqllogic` asserts
`diff schema main; → []` right after an apply) is violated for this shape. And
the recreate it emits **undoes the pin**: the recreated body reads bare `k`, which
now binds the freshly renamed `temp.k`, so the view silently starts returning the
other table's rows.

Note the alias rule above does not resolve this arm, and neither does the
"accept a qualifier equal to `schemaName`" idea the old `NOTE:` floated — the
qualifier here is a *different* schema, and in the differ's single-schema world
the declared bare `k` genuinely means `temp.k`. So this arm needs its own
decision, and it is the more interesting half of the seam:

- **Either** the inverse pass learns the body's real home path (stop modelling
  the declared world as single-schema for *reference resolution* — the live path
  is available at diff time), so a declared bare `k` and a live `main.k` compare
  equal when they resolve to the same object;
- **or** the forward propagation records that this body was pinned (the
  qualification is engine-authored, not author-authored) and the differ normalizes
  engine-authored qualifiers away before comparing.

Whichever is chosen has to keep the *first* arm's alias normalization working, so
both belong in one pass over `inverseRenamedViewParts`.

Extra TODO items for this arm:

- Decide between the two options above and record the reasoning at the site.
- Rewrite the `NOTE:` in `inverseRenamedViewParts` again — the review already
  corrected its false "unreachable for both arms" claim, but it still describes
  the problem rather than a fix.
- Differ test: the `declare schema temp` shape above must re-diff **empty** after
  one apply, and the view must still read `main.k`.

## Watch out for

- The read-only DROP-guard probe (`tableReferencedInAst`) and the closure
  collector (`collectTableRefsInAst`) are the other two sinks over the SAME
  traversal, on purpose. Adding members to `TableRef` is fine — they ignore them.
  What must not change is *what counts as a reference*.
- `packages/quereus/test/schema/rename-cross-schema.spec.ts:560` ("keeps a bound
  column qualifier bare while its FROM source qualifies") must keep passing: its
  body has a single source, so the predicate is false and the qualifier still
  takes the new bare name.
- `spineCloneAst` deep-copies every plain object, so assigning `ts.alias` on a
  pre-flight clone cannot reach the live catalog AST — no change needed, but its
  doc comment enumerates the fields the rewriters assign to (`.name`, `.schema`,
  `.table`, `.column`); add `.alias`.
- `astToString` already renders a source alias (`from main.t2 as tt`, seen in the
  2d output above) — no emitter change.
- Stay conditional. A rename with no collision must leave every body
  byte-identical, or every materialized view's stored body hash churns on every
  unrelated rename.
- Related but **not** a prereq: `bug-duplicate-from-qualifier-resolves-inconsistently`
  (backlog) proposes rejecting a duplicated source name at build time. That would
  turn any surviving collapse into a loud error; this ticket stops the rename from
  creating one in the first place. Complementary — neither blocks the other.

## TODO

- Add `qualifierCollides` and `aliasAs` to `TableRef` in
  `packages/quereus/src/schema/rename/table-rename.ts`, documented in the
  absence-is-a-signal style the neighbouring `qualify` uses.
- Make `resolveQualifier` return the binding's frame index; add the
  scope-scan helper that answers "is `name` bound as a qualifier at or below
  frame `i`" (frame `bound` entries and `ctes` alike).
- Wire the predicate into the `case 'table'` emit (unaliased sources only, plus
  `aliasAs`) and the bound-column-qualifier emit in `case 'column'`.
- Add the collision branch to `renameTableInAst`'s sink, ahead of the existing
  catalog post-condition; guard on `!eq(oldName, newName)`.
- Teach `inverseRenamedViewParts` to drop an alias equal to the source's
  post-inverse bare name, and rewrite the `NOTE:` at `schema-differ.ts:1475` —
  the alias is reachable single-schema, and so (see the second arm above) is the
  schema qualifier the untouched-reference rewrite adds.
- Add `.alias` to the field list in `packages/quereus/src/util/ast-spine-clone.ts`'s
  doc comment.
- Walker-level tests: extend the scope grid in
  `packages/quereus/test/schema/table-rename-scope.spec.ts` and the
  post-condition describe in `rename-cross-schema.spec.ts` (~511) with the
  sibling / alias / CTE / enclosing-frame collisions, plus the no-collision
  byte-identical control.
- Engine-level tests in the collision-grid describe (~590 of
  `rename-cross-schema.spec.ts`): all four sub-cases above with their measured
  before/after row sets, and 2d as the "already aliased, stays correct" control.
- A differ test: a single-schema view whose forward rename adds an alias must
  re-diff clean (no drop+recreate).
- End-to-end coverage in
  `packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic`, following
  the file's existing per-section comment style and unique table-name suffixes.
- Delete the "Known limitation" paragraph at
  `packages/quereus/docs/sql-alter.md:27` (the prereq ticket already trimmed it to
  this arm) and state the full invariant positively in its place.
- `yarn build`, `yarn lint`, `yarn test` from the repo root.

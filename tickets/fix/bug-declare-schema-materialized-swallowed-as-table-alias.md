description: Inside a schema declaration, asking for a materialized view can silently produce an ordinary view instead, because the word "materialized" gets mistaken for a nickname belonging to the previous line's query.
prereq:
files:
  - packages/quereus/src/parser/parser.ts (declare-schema item loop ~3526-3611; `declareMaterializedViewItem` ~3834-3897; `declareViewItem` ~3799-3832)
  - packages/quereus/src/parser/ast.ts (`DeclareItem` union ~883)
difficulty: medium
----

## What is wrong

Items inside a `declare schema { … }` block are not separated by any required
token — the parser reads one item, then decides the next item's kind from the
leading keyword. A `view` / `materialized view` / `assertion` item ends in a
query body, and that body is parsed greedily. `materialized` is not a reserved
word, so when it follows a body that ends at a table source, it is consumed as
that source's alias, and the `view <name> as …` left behind parses as an
**ordinary view**.

The author asked for a materialized view and silently got a plain one.

## Reproduced

Parsed against the built `packages/quereus/dist`:

```
declare schema main {
  table t1 { id integer primary key, a text }
  materialized view m1 as select id from t1
  materialized view m2 as select a from t1
}
```

Parsed items: `declaredTable:t1 | declaredMaterializedView:m1 | declaredView:m2`
— `m2` is a plain view, and `m1`'s FROM source carries `alias: "materialized"`.

The mangling is visible in the generated migration, which renders the stolen
alias back out:

```
create table t1 (id integer primary key, a text)
create materialized view mv as select id from t1 as materialized
create view mv as select a from t1
```

It only bites when the preceding body ends somewhere an alias may appear. A
FROM-less body is safe:

```
declare schema main {
  materialized view m1 as select 1 as one
  materialized view m2 as select 2 as two
}
→ items: declaredMaterializedView, declaredMaterializedView   (correct)
```

`view` and `assertion` are reserved, so an item starting with either of those
words is not swallowed — `materialized` is the gap.

## Why it matters

- **Silent kind substitution.** A plain view computes on read and stores nothing;
  a materialized view is a maintained table with rows and an incarnation. Getting
  the plain one where the author declared the maintained one changes storage,
  refresh behavior, and what `apply schema` builds — with no diagnostic.
- **The corrupted alias rides into the migration DDL** (`… from t1 as
  materialized`), so the emitted statement is not what anyone wrote.
- **It hides a second declaration entirely** when the name matches: `materialized
  view mv` followed by a swallowed `materialized view mv` collapses to one
  maintained table plus one plain view of the same name — which then fails at
  apply time inside the migration.

## Expected behavior

A `materialized view` item inside `declare schema` should parse as a
materialized view regardless of what the preceding item's body ends with. The
declaration block's item boundary must not depend on whether the leading keyword
happens to be reserved.

Whatever mechanism is chosen must be a real parser change, not a lookahead
patch that special-cases the word `materialized` — the same class of ambiguity
applies to any future non-reserved item keyword, and to any alias-eligible
position at the end of a body (a `join` source, a subquery source, a `with`
tail). It is worth checking whether other declared item keywords (`seed`,
`index`, `table`, `unique`) are reserved, and whether an optional statement
separator between block items already parses (it does not appear to be required
today — the existing tests and docs write items without one, with a trailing `;`
optional on some forms).

## How it was found

Writing duplicate-`materialized view` reproductions for
`bug-declare-schema-silently-drops-duplicate-object-names`: the case that was
supposed to exercise the differ's materialized-view map turned out never to reach
it, because the second declaration had been reparsed as a plain view.

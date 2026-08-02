----
description: An integrity check declared as part of a non-default schema is quietly created in the default schema instead, and the tool that reconciles a declaration against reality then re-creates it endlessly because it can never find it where it expects.
files:
  - packages/quereus/src/parser/ast.ts                            # CreateAssertionStmt (line 385) — `name` is a bare string, no schema
  - packages/quereus/src/emit/ast-stringify.ts                    # createAssertionToString (line 1229) — renders a bare name
  - packages/quereus/src/schema/schema-differ.ts                  # assertion create render (line 846); DROP ASSERTION render (line 2498)
  - packages/quereus/src/schema/catalog.ts                        # assertion collection (lines 239-241, 741-759)
  - packages/quereus/src/schema/assertion.ts                      # IntegrityAssertionSchema
difficulty: medium
repro: verified
----

# A declared assertion ignores the schema it was declared in

## What happens

Quereus lets you write a schema *declaration* — the desired end state — and then
run `apply schema <name>`, which works out the difference against what exists and
runs the statements needed to close the gap. Running it twice in a row should be a
no-op the second time.

For a declaration containing an assertion (a named integrity check) in a
non-default schema, it never settles:

```sql
declare schema apol {
	table at_t (id INTEGER PRIMARY KEY, x INTEGER NOT NULL)
	assertion a1 check (not exists (select 1 from at_t where x < 0))
}

apply schema apol;
diff schema apol;
```

The apply reports success, but the following `diff` still asks for the assertion:

```
create assertion a1 check (not exists (select 1 from at_t where x < 0))
```

…and it will keep asking, on every run, forever. The same declaration in the
default `main` schema settles correctly on the first apply — verified both ways.

## Why it happens

The assertion is created without any mention of `apol`, so it lands in `main`.
The comparison that decides whether the assertion already exists looks only inside
`apol`, finds nothing, and re-issues the create. Meanwhile the object it just
created is sitting in the wrong schema, where it is checking against — and
constraining — the wrong tables.

Two consequences, both wrong and both silent:

- the integrity rule is enforced somewhere the author did not ask for;
- the declarative pipeline never reaches a fixed point, which is the one property
  it exists to provide.

## Why this is its own ticket

The grammar has no way to say which schema an assertion belongs to. Unlike a
table, an index or a view — each of which accepts a `schema.name` spelling —
an assertion's name in the syntax tree is a bare string with no schema slot
(`ast.ts:385`). So there is no statement anyone could write, generated or
hand-typed, that puts an assertion anywhere but the current schema.

That makes the fix a language-surface change (a schema-qualified assertion name,
plus the matching `drop assertion` spelling, plus catalog and persistence
follow-through), not a patch to the statement generator. It is a different site
from the view / materialized-view schema bug filed alongside it
(`bug-declared-materialized-view-non-main-schema`), which is why the two are not
one ticket. Note that the migration generator *already* emits
`DROP ASSERTION IF EXISTS <schema>.<name>` (`schema-differ.ts:2498`) — a spelling
the grammar cannot currently accept.

## Expected behavior

- An assertion declared inside a schema is created in that schema.
- A re-`diff` immediately after `apply schema` reports no remaining difference.
- An assertion can be named and dropped with an explicit schema qualifier, the
  same way a table, index or view can.
- The check evaluates against the tables of its own schema.

## How it was found

While reproducing `bug-declared-materialized-view-non-main-schema`. The
investigation applied a declaration holding a table, an index, a view, a
materialized view and an assertion to a non-default schema, to see which object
kinds survived. Tables and indexes were fine; views and materialized views failed
loudly (that ticket); assertions failed quietly, which is this one.

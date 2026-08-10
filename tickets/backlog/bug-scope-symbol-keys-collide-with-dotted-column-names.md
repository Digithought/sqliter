---
description: A table with a column whose quoted name contains a dot can become impossible to write to — the engine confuses that column's name with the "table-dot-column" form it uses internally, and every insert or update on the table fails before it runs.
files:
  - packages/quereus/src/planner/scopes/registered.ts              # registerSymbol — the flat string key namespace
  - packages/quereus/src/planner/scopes/scope.ts                   # Scope.resolveSymbol signature
  - packages/quereus/src/planner/building/constraint-builder.ts    # CHECK scope: bare + new. + old. keys
  - packages/quereus/src/planner/building/insert.ts                # DO UPDATE SET scope: bare + <table>. + new. + excluded. keys
  - packages/quereus/src/planner/building/generated-column-scope.ts # generated body scope: bare + new. keys
  - packages/quereus/src/planner/building/default-scope.ts         # row DEFAULT scope
repro: verified
severity: wrong-result
likelihood: contrived
tradeoffs: Nobody sensible names a column `"new.a"`, and the fix touches the symbol-resolution key type that every scope and every builder in the planner shares — a maintainer could reasonably decide the blast radius of the change outweighs an edge case no real schema hits.
---

# Column names containing a dot collide with qualified names in the planner's symbol table

## What goes wrong

Name resolution during planning uses a single flat string as its lookup key. A bare
column is registered under its lowercased name; a qualified reference is registered
under the qualifier, a literal dot, and the name — `new.a`, `excluded.a`, `t.a`,
`old.a`. Nothing separates the two namespaces.

SQL lets a quoted identifier contain a dot. So a table can have a column *named*
`new.a` at the same time as a column named `a`, and the two want the same key. The
scope refuses to register a key twice, so planning dies with an internal-sounding
message:

```
QuereusError: Symbol 'new.a' already exists in the same scope.
```

The table itself is created without complaint, and plain reads and writes of it work.
The failure only appears once a statement needs a scope that registers qualified
names — and then it appears for *every* such statement, permanently.

## Reproduction (verified, run against the engine)

```sql
create table p (id integer primary key, a integer, "new.a" integer);
insert into p (id, a, "new.a") values (1, 3, 9);   -- works
select id, a, "new.a" from p;                      -- works
```

Each of the following then fails to plan, on a table the engine happily created:

| trigger | site |
|---|---|
| any `CHECK` constraint on the table, on every INSERT/UPDATE | `constraint-builder.ts` (registers `new.<col>` and `old.<col>`) |
| any `insert ... on conflict ... do update` | `insert.ts` DO UPDATE SET scope (registers `<table>.<col>`, `new.<col>`, `excluded.<col>`) |
| any write to a table that has a generated column | `generated-column-scope.ts` (registers `new.<col>`) |

The first two pre-date the shared generated-column builder; the third arrived with it,
which is how this was found. A column named `p.a` on a table `p` collides the same way
with the `<table>.<col>` form.

## Why this is the shape of the problem, not three bugs

Every one of those sites is correct in isolation. They collide because the *key* is a
string that cannot distinguish "the column called `new.a`" from "the column `a` of the
row called `new`". Fixing the sites one at a time — skipping a duplicate, or renaming
the alias prefix to something less likely — leaves the next builder that registers a
qualified name free to reintroduce it, and a skip silently binds one of the two
columns rather than the one the user wrote.

The bad state is representable only because the key is a flat string. A structured
key — a qualifier and a name as two fields, compared as two fields — makes the
collision impossible to express, and makes `select "new.a" from p` inside a scope that
also registers `new.<col>` resolve to the column it names.

## What "done" looks like

- A scope key that carries qualifier and name separately, so a dotted column name and
  a qualified reference to a differently-named column can never be the same key.
- The four builders above register through that key type; none of them concatenates a
  dot into a string any more.
- Test coverage over the reproduction above: a table with both `a` and `"new.a"`
  survives a CHECK, an upsert, a generated column, and a `DEFAULT (new.a)`, and each
  reference resolves to the column the SQL actually names.
- The `NOTE:` in `generated-column-scope.ts` that points here comes out with the fix.

## Out of scope

Whether the engine should accept dotted identifiers at all is a separate question. It
does today, and reads of such a column already work, so the resolution path should be
consistent with that rather than the acceptance narrowed as a side effect.

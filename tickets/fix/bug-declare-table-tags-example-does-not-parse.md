---
description: A documented example showing how to tag a table in a schema declaration does not actually parse; anyone who copies it gets a syntax error.
files: docs/sql-ddl.md, packages/quereus/src/parser/parser.ts
repro: verified
severity: cosmetic
likelihood: normal-use
tradeoffs: It is only a documentation example — the working form is a few lines away in the same document — so a maintainer might reasonably rank it below any behavioural bug.
---

Found while writing tests for `apply-schema-unchanged-fast-path`, which needed a
declaration whose only difference from another was a table tag.

## What is wrong

`docs/sql-ddl.md` § *Reserved tags* shows how to attach tags to a table inside a
`declare schema` block by writing the tag list **before** the column definitions:

```sql
declare schema main {
  table customer with tags (
    "quereus.id" = 'tbl-customer',
    "quereus.previous_name" = 'client'
  ) {
    customer_id integer primary key with tags ("quereus.previous_name" = 'client_id'),
    full_name text not null with tags ("quereus.previous_name" = 'name')
  }
}
```

Pasting that into the engine fails:

```
Expected '(' or '{' before column definitions. Got 'with'.
```

## What actually works

The tag list has to come **after** the body, and the body has to use the
parenthesised form:

```sql
declare schema main {
  table customer (
    customer_id integer primary key with tags ("quereus.previous_name" = 'client_id'),
    full_name text not null with tags ("quereus.previous_name" = 'name')
  ) with tags (
    "quereus.id" = 'tbl-customer',
    "quereus.previous_name" = 'client'
  )
}
```

Verified by parsing all four combinations directly:

| form | result |
|---|---|
| `create table t with tags (…) (cols…)` | rejected |
| `create table t (cols…) with tags (…)` | accepted |
| `declare schema … { table t with tags (…) { cols… } }` | rejected |
| `declare schema … { table t ( cols… ) with tags (…) }` | accepted |
| column-level inline `with tags (…)` | accepted (the example's other half is fine) |

So the leading position is unsupported everywhere, not just inside a declaration
block — the example is simply wrong, and the column-level tags it also shows are
correct.

## Expected behaviour

One of the two, whichever the maintainer prefers — this is the reason it is filed
rather than fixed in passing:

- **Fix the document** (small): rewrite the example in the working form. Also
  worth a sweep for other tag examples in the same position.
- **Accept the leading form in the parser** (larger): make `with tags` legal
  before the column list too, at both `create table` and the `declare schema`
  table item, so the documented shape works. Whether that is desirable is a
  syntax decision, not a bug fix.

Whichever is chosen, the example should end up covered by something that would
have caught this — `documentation.spec.ts` already exists and is the obvious home
for "every SQL block in the docs parses".

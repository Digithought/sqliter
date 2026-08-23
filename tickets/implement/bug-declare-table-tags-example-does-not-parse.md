---
description: A documented example showing how to tag a table inside a schema declaration is written in an order the engine rejects; rewrite it in the working order and add a test so it cannot silently rot again.
files: docs/sql-ddl.md, packages/quereus/test/documentation.spec.ts, packages/quereus/src/parser/parser.ts
repro: verified
difficulty: easy
---

## What is wrong

`docs/sql-ddl.md` § 2.6.3 *Metadata Tags* ends with an example of declaring a
renamed table and column (around line 638). It puts the table's tag list
**before** the column body:

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

Parsing that fails:

```
Expected '(' or '{' before column definitions. Got 'with'. (at line 2, column 18)
```

The column-level `with tags (...)` in the same example is correct; only the
table-level position is wrong.

## Why the parser rejects it

`Parser.declareTableItem` (`packages/quereus/src/parser/parser.ts`, ~line 3784)
reads the item in a fixed order: table name → optional `using module(...)` →
column body (`( ... )` **or** `{ ... }`) → optional `maintained as ...` →
trailing `with context` / `with tags` clauses in any order. A `with` token where
the body is expected is a syntax error. `create table` has the same shape, so the
leading position is unsupported everywhere, not only inside a declaration block.

## The working form

Verified directly against the parser — the body may stay in the brace style the
rest of the document uses; only the tag list moves after it:

```sql
declare schema main {
  table customer {
    customer_id integer primary key with tags ("quereus.previous_name" = 'client_id'),
    full_name text not null with tags ("quereus.previous_name" = 'name')
  } with tags (
    "quereus.id" = 'tbl-customer',
    "quereus.previous_name" = 'client'
  )
}
```

Measured combinations (each parsed directly, whole `declare schema` block):

| form | result |
|---|---|
| `table t { cols… } with tags (…)` | accepted |
| `table t ( cols… ) with tags (…)` | accepted |
| `table t with tags (…) { cols… }` | rejected |
| `create table t (cols…) with tags (…)` | accepted |
| `create table t with tags (…) (cols…)` | rejected |
| column-level inline `with tags (…)` | accepted |

(The originating fix ticket said the parenthesised body was required; it is not —
brace + trailing tags parses. Keep the brace style so the example still matches
the surrounding declaration examples.)

## Decision: fix the document, not the grammar

The fix ticket left open whether to instead teach the parser to accept a leading
`with tags`. Fix the document, because:

- Trailing is the *only* position used by every other tag site in the codebase and
  the docs — `create table`, `create view`, `create index`, table and column
  constraints, and the other `declare schema` tag examples in `docs/lens.md`,
  `docs/lens-prover.md`, and `docs/schema.md`, all of which parse today. This one
  example is the sole outlier.
- The DDL generator renders tags trailing, so a leading-form declaration would
  round-trip back to the trailing form anyway — authors would see their own
  syntax rewritten.
- Accepting both positions adds a second legal spelling of one clause at two call
  sites (`declareTableItem` and `createTable`) for no expressive gain.

If a maintainer later wants the leading form as authoring sugar, that is a syntax
proposal, not this bug.

## Regression cover

`packages/quereus/test/documentation.spec.ts` already has the pattern for this:
the `plugins.md Function Examples` block transcribes doc examples with a header
comment saying "if you change one of these, change the doc — and vice versa".
Follow it — a small `describe` that parses the § 2.6.3 examples.

Doc-wide coverage ("every SQL block in every doc parses") is a bigger job: 85 of
263 ` ```sql ` blocks under `docs/` do not parse today, most of them legitimately,
because they are grammar templates using `[optional]` / `{a|b}` / `...`
metasyntax. That needs a fence-marker convention first and is filed separately as
`debt-doc-sql-blocks-unparsed` in `tickets/backlog/`. Do not attempt it here.

## TODO

- Rewrite the § 2.6.3 example in `docs/sql-ddl.md` (around line 638) into the
  working form above: keep the brace body, move the table-level `with tags (...)`
  after the closing `}`. Leave the column-level tags as they are.
- Re-read the surrounding prose for any sentence that implies tags may lead the
  body; correct it if found.
- Add a `describe('sql-ddl.md Metadata Tags examples')` to
  `packages/quereus/test/documentation.spec.ts` that parses (via `new Parser().parseAll`,
  imported from `../src/parser/parser.js`) the transcribed § 2.6.3 examples: the
  `declare schema` rename example in its corrected form, plus the `create table`
  table-level / column-level / constraint-level tag examples already shown in that
  section. Carry the same "change one, change the other" header comment as the
  `plugins.md` block above it.
- Assert the leading form is still rejected, so a future grammar change that
  silently accepts it is a conscious decision rather than a surprise.
- Run `yarn workspace @quereus/quereus test` and `yarn workspace @quereus/quereus lint`.

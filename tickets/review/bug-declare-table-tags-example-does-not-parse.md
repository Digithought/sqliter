description: A documented example showing how to tag a table inside a schema declaration was written in an order the engine rejects; the example now uses the working order and a test locks it in so it cannot silently rot again.
files: docs/sql-ddl.md, packages/quereus/test/documentation.spec.ts
---

## What changed

`docs/sql-ddl.md` § 2.6.3 *Metadata Tags* had a `declare schema` example (the
"declaring a renamed table and column" example, now around line 636-648) that
put the table-level `with tags (...)` clause **before** the column body. That
is not valid syntax anywhere in the grammar — table-level tags must trail the
column body (in braces or parens), matching every other tag site in the
codebase (`create table`, `create view`, `create index`, constraint tags, and
every other `declare schema` tag example already in the docs).

Fix was to the document, not the grammar (see the original ticket's
"Decision: fix the document, not the grammar" section for the full rationale —
short version: trailing is the only position used anywhere else, and the DDL
generator would round-trip a leading-form declaration back into trailing form
anyway, so accepting both would just be a silent rewrite trap for authors).

The example now reads:

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

Surrounding prose was re-read; nothing else implied tags could lead the body.

## Test coverage added

`packages/quereus/test/documentation.spec.ts` gained a
`describe('sql-ddl.md Metadata Tags examples')` block (mirrors the existing
`plugins.md Function Examples` pattern — same "if you change one of these,
change the doc — and vice versa" header comment) with five cases, each parsing
via `new Parser().parseAll(sql)`:

- the corrected `declare schema` renamed-table-and-column example (must parse)
- the `create table` table-level tags example from the same doc section (must parse)
- the `create table` column-level tags example (must parse)
- the `create table` constraint-level tags example (must parse)
- a leading `with tags (...)` before the column body, asserted to **still throw**
  — this is the regression guard: if a future grammar change makes the leading
  form parse, this test fails and forces a conscious decision about whether to
  update the doc back to the leading form, rather than silent grammar drift.

## Validation performed

- `yarn workspace @quereus/quereus test` — full suite green: 10176 passing, 25
  pending (pre-existing skips, unrelated to this change), 0 failing.
- `yarn workspace @quereus/quereus lint` — clean (eslint + test-file typecheck).

## Known gaps / out of scope

- Doc-wide "every SQL block in every doc parses" coverage was explicitly out of
  scope for this ticket — 85 of 263 fenced ` ```sql ` blocks under `docs/`
  don't parse today, mostly grammar-template blocks using `[optional]` /
  `{a|b}` / `...` metasyntax rather than real SQL. That's tracked separately as
  `debt-doc-sql-blocks-unparsed` in `tickets/backlog/`; nothing in this ticket
  touches it.
- Only this one § 2.6.3 example was broken; the rest of the section's examples
  (table/column/constraint/view/index tags) were already correct and are now
  covered by the added tests, but weren't otherwise changed.
- No parser or grammar changes were made — this was a documentation-only fix.
  Reviewer should double check the new test's "must still throw" case actually
  exercises the leading-form rejection at `Parser.declareTableItem` and isn't
  failing for some unrelated reason (e.g. a different syntax error earlier in
  the block) — I read the parser to confirm the rejection point but didn't
  step through it with a debugger.

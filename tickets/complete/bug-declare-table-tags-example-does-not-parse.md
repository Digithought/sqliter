---
description: A documented example showing how to tag a table inside a schema declaration was written in an order the engine rejects; the example now uses the working order, the whole documentation section is parsed straight out of the file by a test, and the grammar reference now says where table tags go.
files: docs/sql-ddl.md, packages/quereus/test/documentation.spec.ts, tickets/backlog/debt-doc-sql-blocks-unparsed.md
---

## What shipped

**Doc fix (implement stage).** `docs/sql-ddl.md` § 2.6.3 *Metadata Tags* had a
`declare schema` example that put the table-level `with tags (...)` clause
*before* the column body. That position is not in the grammar: after the table
name, `Parser.declareTableItem` requires `(` or `{` immediately (it accepts only
an optional `using` clause first), and tags are read from the trailing
`with …` loop after the body closes. The example was rewritten to the trailing
form, matching every other tag site in the codebase and the docs.

**Grammar reference (review stage).** The § 2.0 *Declaration Syntax* block — the
reference a reader consults for what a `declare schema { … }` item looks like —
never showed table-level tags at all, which is why the wrong order went
unnoticed. It now carries a short `audit_log` example showing the trailing
table-level clause alongside an inline column tag. Verified that exact snippet
parses.

**Guard (review stage, replacing the implement-stage version).** The
implement stage added five tests that hand-transcribed the § 2.6.3 SQL blocks
into the spec file. Those copies could not catch a doc regression — re-breaking
the doc left them green, because they asserted on the copy, not the doc. The
guard now reads `docs/sql-ddl.md` at test time, slices § 2.6.3, and parses every
fenced `sql` block found there:

- `sqlBlocksInSection(doc, heading)` — new helper at the top of
  `packages/quereus/test/documentation.spec.ts`; returns the fenced `sql` blocks
  between a `## ` heading and the next one.
- `should parse every SQL example in the section` — asserts at least two blocks
  are found (so a renamed heading fails loudly instead of passing vacuously),
  then parses each and reports every failure with the offending block inline.
- `should still reject a leading with-tags clause before the table body` — the
  synthetic negative, now asserting the *specific* message
  `Expected '(' or '{' before column definitions` rather than any throw at all.

This is both stronger and broader than what it replaced: it also covers the
`create view … with tags` and `create index … with tags` examples in the
section's syntax block, which the transcribed tests never touched.

## Validation

- Mutation-tested the guard: reverted the § 2.6.3 example to the broken leading
  form, ran the spec, saw it fail with
  `Expected '(' or '{' before column definitions. Got 'with'. (at line 2, column 18)`
  and the block printed. Doc restored; `git diff docs/sql-ddl.md` against the
  implement commit shows only the § 2.0 addition.
- `yarn workspace @quereus/quereus test` — 10173 passing, 25 pending, 0 failing.
  (Count is 3 lower than the implement stage's 10176 because five transcribed
  tests collapsed into two stronger ones.) The 25 pending are pre-existing skips
  unrelated to this change.
- `yarn workspace @quereus/quereus lint` — clean.
- `yarn docs:check` — clean (links, invariants, size ratchet, tiers).

## Review findings

**Read first:** the implement diff (`a7d324e49`), then the ticket handoff, then
`Parser.declareTableItem` (`packages/quereus/src/parser/parser.ts:3784-3883`),
`docs/sql-ddl.md` §§ 2.0 and 2.6.3, and the surrounding conventions in
`packages/quereus/test/documentation.spec.ts`.

**Major — fixed in this pass: the regression guard did not guard the document.**
The five added tests transcribed the doc's SQL by hand, so the assertion was
about a copy living in the spec file. Editing `docs/sql-ddl.md` back to the
broken form left the suite green — the exact regression the tests were added to
prevent. Notably, the same spec file already had the better pattern one block
up (`plugins.md return-type shapes` reads `docs/plugins.md` from disk and scans
its code fences), so the transcription was also inconsistent with its immediate
neighbours. Replaced with the file-reading guard described above and
mutation-tested to confirm it now fails on the original bug.

**Minor — fixed: the negative test asserted only that *something* threw.** The
handoff explicitly asked the reviewer to confirm the rejection happens at
`declareTableItem` and not at some unrelated earlier syntax error. Confirmed by
reading the parser and by the observed message: after the table name the parser
falls through the `using` check to `consume(LPAREN, "Expected '(' or '{' before
column definitions.")`, and `with` fails there. The assertion now pins that
message, so a future grammar change that makes the leading form fail for a
*different* reason no longer passes silently.

**Minor — fixed: the grammar reference omitted table-level tags.** Root cause of
how the wrong order got written in the first place: § 2.0's declaration-syntax
block shows tables, indexes, views, seeds, and assertions, but never a
table-level `with tags`. Added — see *What shipped*.

**Checked, nothing found — other instances of the same mistake.** Scanned every
git-tracked `.md` outside `tickets/` for a leading `<table|view|index> <name>
with tags` form (`grep -niE "(table|view|index)[[:space:]]+[a-z_][a-z0-9_]*[[:space:]]+with[[:space:]]+tags"`).
Zero hits. The § 2.6.3 example was the only one.

**Checked, no test needed — the example's semantic claim.** The doc asserts the
corrected example diffs to `ALTER TABLE client RENAME TO customer` plus two
column renames rather than a drop+create. `packages/quereus/test/schema-differ.spec.ts`
already covers exactly that, using the same trailing-tags declare syntax
(`:518` for the table rename via `quereus.previous_name`, `:531` for a
hyphenated `quereus.id`, `:645` for column renames). No duplicate coverage added.

**Checked, deliberately not extended — doc-wide SQL block coverage.** 85 of 263
fenced `sql` blocks under `docs/` still fail to parse, most of them grammar
templates that are *supposed* to. That sweep needs a fence-tagging convention
first and is already specified in `tickets/backlog/debt-doc-sql-blocks-unparsed.md`.
Rather than file anything new, appended an arm to that ticket: its text claimed
this ticket left behind a "transcribed test" (no longer true), it should reuse
`sqlBlocksInSection` instead of reinventing the section walk and must not
double-cover § 2.6.3, and its recorded `sql-ddl.md` line numbers have shifted by
six lines from the § 2.0 addition.

**No tripwires recorded.** Nothing in this change is a "fine now, matters if X"
concern — the guard reads two blocks from one section on each run, which is not
a cost worth conditioning on.

**No new tickets filed.** Both findings resolved at the site.

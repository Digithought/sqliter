---
description: Nothing checks that the SQL examples in the documentation actually run, so a broken example can sit in the docs indefinitely; a reader who copies it gets a syntax error.
prereq: bug-declare-table-tags-example-does-not-parse
files: docs/doc-conventions.md, scripts/check-docs.mjs, packages/quereus/test/documentation.spec.ts, docs/sql-ddl.md, docs/sql-constraints.md, docs/sql-select.md
difficulty: medium
tradeoffs: The corpus is large and mostly fine, the payoff is documentation-only, and it forces a fence-marker convention onto every future doc author — a maintainer could reasonably say the occasional bad example is cheaper than the convention.
---

## Background

`docs/` contains 263 fenced ` ```sql ` blocks. Nothing parses any of them. The
bug this ticket generalizes (`bug-declare-table-tags-example-does-not-parse`) was
a documented `declare schema` example whose table tags were written in an order
the parser rejects; it was found only because someone happened to copy it.

Measured by running every block through `Parser.parseAll` (whole block, one
`parseAll` call per block, docs/*.md plus `packages/quereus/README.md`):

- 263 blocks total
- 178 parse
- 85 fail, of which 68 contain grammar metasyntax (`[optional]`, `{a | b}`,
  `...`, `<placeholder>`) and are *supposed* to fail — they are syntax templates,
  not runnable SQL
- 17 fail while looking like ordinary SQL:

  ```
  functions.md:616        lens.md:136             plugins.md:297
  sql-constraints.md:34   sql-constraints.md:184  sql-ddl.md:100
  sql-ddl.md:638          sql-dml.md:144          sql-dml.md:268
  sql-functions.md:309    sql-select.md:570       sql-select.md:661
  sql-select.md:1340      sql-select.md:1377      sql-select.md:1448
  view-updateability.md:248  view-updateability.md:274
  ```
  (line numbers are the first line inside the fence, at the time of measurement)

Spot-checking that list shows it is not one kind of problem:

- `sql-ddl.md:638` — a genuinely wrong example (the ticket above).
- `sql-constraints.md:34` — uses `autoincrement`, which the engine rejects
  outright ("Quereus uses key-based addressing"). A reader copying it gets an error.
- `sql-functions.md:309` — uses a named window reference, which the parser reports
  as not yet supported.
- `sql-ddl.md:100` — an **intentional** counterexample: the prose is explaining
  that `materialized` cannot be a bare alias there, and the block is the shape
  that is *rejected*. Correct as documentation, and it must stay failing.
- several others are prose fragments (`where condition`, `cast(expr as type)`)
  that are templates without using bracket metasyntax.

## Why a guard is worth having

The class is "a documentation example that the engine will not accept". It recurs
because nothing mechanically distinguishes an example a reader can copy from one
that is illustrative, and because the engine's grammar moves. A one-off fix to a
single example does not make the next one less likely.

## What the guard needs before it can exist

A block's *kind* has to be declared, because at least three kinds exist and only
one of them should be required to parse:

| kind | example | should the guard parse it? |
| --- | --- | --- |
| runnable example | the `create table Orders (...) with tags (...)` block | yes — must parse |
| grammar template | `create table [if not exists] table_name (` | no |
| deliberate counterexample | `sql-ddl.md:100` | it must **fail**, and the guard should say so |

The obvious mechanism is the fence info string — keep ` ```sql ` for runnable
examples and give the other two kinds their own tags (names to be chosen; e.g. a
syntax-template tag and a rejected-example tag). That is an authoring convention,
so `docs/doc-conventions.md` is where it gets written down, and roughly 68 fences
have to be retagged as part of landing it. Retagging is mechanical, but it is the
bulk of the work and it touches most of the SQL-facing docs.

An alternative — infer the kind by looking for metasyntax characters — was
considered and is worse: a new runnable block silently opts itself out the moment
it contains a `[` (a JSON array literal, a quoted identifier), which is exactly
the failure the guard is supposed to prevent.

## Where the check should live

Two candidate homes, and the choice matters:

- `packages/quereus/test/documentation.spec.ts` (Mocha, already reads doc files
  from disk and already imports the engine). Easy: the parser is one import away.
- `scripts/check-docs.mjs` / `yarn docs:check`, which is where every other
  mechanical doc rule lives (links, anchors, doc size, stability tiers). Better
  home conceptually, but it is a plain `.mjs` script with no engine dependency
  today, so it would have to load the built parser from `dist`.

Note `debt-check-docs-script-too-large` proposes splitting `check-docs.mjs` into
one module per check; if this check goes there it should land as its own module.

## Expected behavior

- A fenced block tagged as a runnable SQL example fails the gate if the parser
  rejects it, reported as `path:line: message`.
- A block tagged as a counterexample fails the gate if the parser *accepts* it —
  otherwise a grammar change quietly turns the documented "this is rejected" into
  a lie.
- Grammar templates are not parsed.
- The 17 currently-failing real-looking blocks are triaged as part of landing
  this: retagged if they are templates or counterexamples, and **fixed** if they
  are wrong. Two of them (`autoincrement`, the named-window reference) document
  behavior the engine does not have, so fixing them means deciding whether the
  doc or the engine is wrong — expect that to spawn its own ticket rather than
  being absorbed here.

## Relationship to other work

- `bug-declare-table-tags-example-does-not-parse` (in `tickets/implement/`) fixes
  one of the 17 and adds a transcribed test for that one section. It is listed as
  a prereq so this ticket's sweep starts from a corpus that no longer contains it.
- `debt-check-docs-validate-section-markers` is a different hole in the same gate
  (prose `§ Section` pointers, not SQL blocks). Independent; either can land first.

---
description: The subquery-driven index lookup gives up when the two columns being matched hold different kinds of value (say whole numbers on one side and decimals on the other), even though the comparison itself works fine.
prereq: feat-key-set-semi-join
files:
  - packages/quereus/src/planner/rules/access/rule-key-set-seek.ts
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts
---

## The gap

`feat-key-set-semi-join` requires the target column and the subquery's column to declare the
**same** logical type. `a.i in (select b.r from b)` — INTEGER against REAL — therefore keeps
the slower plan even though the comparison `a.i = b.r` matches `1` against `1.0` perfectly
well.

The gate exists because an index seek looks rows up by their encoded key bytes. Handing the
backend the value `1.0` as a seek key against a column that stored `1` risks finding nothing
— and unlike an over-fetch, rows a seek never returns cannot be recovered by the
membership check that runs above it. Rather than reason about each backend's encoding, the
rule declines.

## What good would look like

Per-type evidence that the seek key can be coerced to the target column's storage form
without changing which rows match — probably by applying the same coercion the engine uses
when it writes a value into that column, then verifying against both the in-memory and the
persistent backend. Numeric widening (INTEGER target, REAL keys and vice versa) is the case
worth doing first; text-vs-number is a separate and much murkier question, tangled with
`backlog/bug-numeric-text-coercion-skips-in-and-case`.

Note that the plan-time literal path has the same latent question — `where i in (1.0, 2.0)`
against an INTEGER column types its seek literals from the column but does not coerce the
values — so whatever coercion rule comes out of this should be shared by both paths rather
than bolted onto one.

## Why it is not urgent

The declined case still runs correctly at the hash-semi-join floor. This is a missed
speed-up on a shape (cross-type join keys) that is uncommon in practice.

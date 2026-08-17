----
description: |
  A table in an application schema can declare a primary key on a column that is allowed to hold
  no value. Everywhere else in the engine two such empty-valued rows count as the same row and the
  second one is rejected; on one enforcement path they are treated as different rows and both are
  stored.
files:
  - packages/quereus/src/planner/mutation/lens-enforcement.ts # `synthesizeUniqueCountExpr` (~1277) — the counting predicate that skips empty key values
  - docs/lens.md # § Constraint Attachment → "Set-level (`unique`, primary key)" → the commit-time bullet
  - docs/schema.md # § Primary-key nullability — the rule this path disagrees with
difficulty: medium
repro: static
severity: edge-case
likelihood: contrived
tradeoffs: |
  Reaching it takes an unusual schema — a primary key on a nullable column whose values are not
  also protected by a key on the underlying storage — and the current behaviour is the one SQL's
  UNIQUE rule prescribes, so a maintainer may reasonably say the engine's key rule is the odd one
  out and leave this alone rather than making one enforcement path disagree with plain SQL.
----

# Two rows with an empty primary key are both accepted on the counting path

## The rule this contradicts

Quereus deliberately splits two rules (docs/schema.md § Primary-key nullability):

- **Key comparison** treats an absent value (NULL) as a value equal to itself, so two rows whose
  whole primary key is absent are the *same* row and the second one is a duplicate-key error. Both
  storage backends implement this.
- **`UNIQUE`** follows plain SQL and treats absent values as all-different, so two rows with no
  value in a UNIQUE column are both legal.

Since primary-key columns may be declared nullable, the first rule is reachable in ordinary use.

## Where the two disagree

When an application-schema ("logical") table declares a primary key that no structure on the
underlying storage can answer, the engine enforces it by counting: after the write, it counts the
rows of the logical table sharing the written row's key and rejects the write if the count exceeds
one. That count predicate compares the key with a plain `=`, which yields "unknown" — never true —
for an absent value, so a row with an empty key matches nothing, counts zero, and the duplicate is
never detected. Two rows with an entirely absent primary key are stored side by side.

That is exactly right for a declared `unique`, and wrong for a primary key.

## What would confirm it

Not reproduced — read from the code. Confirming it needs a logical table whose primary key is a
nullable column that maps to **no** key on its underlying table (otherwise the underlying table's
own key rejects the duplicate first and hides the hole), then two inserts through the logical table
with that column left empty. Both are expected to land today; the engine's key rule says the second
should be rejected as a duplicate.

## Shape of a fix

The counting predicate needs to answer the same way the key rule does for a primary key
(absent-equals-absent) while keeping today's answer for a `unique` — i.e. the NULL-safe comparison
already used for every other key correlation in the mutation layer, applied only on the
primary-key arm. The one-line helper that emits it exists
(`planner/mutation/capture-correlation.ts`, `captureKeyEquality`); the open question is purely
which arm gets it, and that is a semantics call worth stating in docs/lens.md alongside the change.

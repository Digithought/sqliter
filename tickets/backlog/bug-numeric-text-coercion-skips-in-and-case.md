---
description: Comparing a number column against a quoted number works with the equals operator and with BETWEEN, but silently fails with IN and with the short form of CASE — so the same value matches one way and misses another.
files:
  - packages/quereus/src/planner/building/expression.ts   # insertCrossTypeCoercion, coerceObjectPhysicalSet, the 'binary'/'between'/'case'/'in' build arms
  - packages/quereus/src/planner/nodes/subquery.ts        # InNode
  - packages/quereus/test/logic/06.4.2-collation-extras.sqllogic
difficulty: medium
---

# Number-vs-quoted-number comparison disagrees across comparison forms

## Observed behavior

With `create table nn (id integer primary key, i integer, r real)` holding
`(1, 1, 2.5)`:

| query | result |
|---|---|
| `select i = '1' from nn` | `true` |
| `select i between '0' and '2' from nn` | `true` |
| `select i in ('1') from nn` | **`false`** |
| `select case i when '1' then 'hit' else 'miss' end from nn` | **`'miss'`** |
| `select r = '2.5' from nn` | `true` |
| `select case r when '2.5' then 'hit' else 'miss' end from nn` | **`'miss'`** |

All six are the same comparison of a numeric column against a textual literal
that spells the same number. Four surfaces, two answers.

## Why it happens

When the planner builds a comparison it inserts an explicit cast whenever one
operand is numeric and the other textual, so the runtime compares two numbers
instead of ordering by storage class (a number always sorts before any string,
so an uncoerced numeric-vs-textual comparison is never equal). That cast
insertion is wired into two build sites — the binary-operator arm and the
BETWEEN arm — and **not** into the IN-list arm or the simple-`CASE` arm.

The IN list and simple `CASE` share a narrower helper that reconciles only
JSON-shaped operands, which is why `json_col in ('{"a":1}')` and
`case json_col when '{"a":1}'` behave correctly while the numeric case does not.
The helper's own comment already calls the numeric gap out as deliberate and
deferred; this ticket is that deferral.

## Expected behavior

One comparison rule for all of them: if `x = v` is true, then `x in (v)` and
`case x when v` must match, and vice versa. Whichever way the engine decides a
number should compare against a quoted number, all comparison forms must agree.

## Use cases

- `select … where status_code in ('404', '500')` over an integer column —
  currently silently returns nothing, which reads as "no such rows" rather than
  as a type problem.
- `case priority when '1' then 'high' … end` over an integer column — currently
  always falls to `ELSE`.
- A real column compared against a decimal string (`r = '2.5'`), where the
  textual spelling comes from a bound parameter or an imported CSV.

## Scope notes

- Not caused by, and not fixed by, the collation work in
  `simple-case-comparison-collation-and-type` — that ticket aligned the
  *collation* and *declared-type* axes only, and left this axis exactly as it
  found it. This is the one remaining axis on which `case x when v` and `x = v`
  still disagree.
- The same gap applies to `nullif` / `greatest` / `least`, which are being
  routed through the same shared comparator by
  `nullif-greatest-least-comparison-seam`. Whatever fix lands here should cover
  every probe-against-many-values site at once rather than one per ticket.
- Deciding *where* the coercion belongs is part of the work: pushing the cast in
  at build time (as `=` and BETWEEN do) is the established pattern, but a
  simple `CASE` compares one base against N differently-typed WHEN operands, so
  a single cast on the base is not obviously right — a mixed
  `case i when '1' when 2 …` needs a per-clause decision.
- Whichever direction is chosen, the plain-`TEXT`-column negative control must
  not regress: a text column holding `'1'` compared against the integer `1`
  should keep whatever `=` does for that pair.

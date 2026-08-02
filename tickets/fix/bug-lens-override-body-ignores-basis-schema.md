----
description: When a lens maps a logical schema onto tables that live in another schema, writing the mapping without spelling out that schema on every table name fails — the engine looks for those tables in the wrong place.
files:
  - packages/quereus/src/schema/lens-compiler.ts   # compileOverrideBody (~1319) keeps the override's FROM verbatim; collectOverrideSources (~1335) already resolves each unqualified source to the basis
  - packages/quereus/src/schema/lens-prover.ts     # planBody (~343), planLogicalBody (~714), and the body plan at ~1274 all plan without a basis path
  - packages/quereus/src/func/builtins/explain.ts  # lens-slot body plan (~801) — same
  - packages/quereus/src/planner/building/select.ts # read-time view expansion (~451): a lens view expands under its LOGICAL schema's home path, not its basis
  - packages/quereus/test/logic/52-lens-overrides.sqllogic # every existing override qualifies its sources, so the gap is untested
difficulty: medium
repro: verified
----

# A lens override body's unqualified table names never reach the basis schema

## What is broken

A lens maps a *logical* schema (what the application sees) onto a *basis*
schema (where the data actually lives):

```sql
declare lens for carapp over ybasis {
  view Car as select id, speed as maxSpeed from CarCore
}
```

`CarCore` here is unqualified. The lens compiler treats that as "a table in the
basis schema" — it resolves the source that way when it collects the override's
FROM sources, and its own validation explicitly documents unqualified names as
defaulting to the basis. But the compiled body is stored with the FROM clause
copied verbatim, so nothing ever records *which* schema the name meant. When the
body is later planned — at read time, by the lens prover, and by `explain` — the
name is resolved against the ordinary schema search path instead, which does not
include the basis.

Reproduced by running code (the fixture above, with `from CarCore` in place of
`from ybasis.CarCore`):

```
apply schema carapp;
select * from carapp.Car order by id;
-- Table 'CarCore' not found in schema path: carapp, main
```

It happens to work today only when the basis schema is `main`, because `main` is
on the default search path.

Not a regression from `bug-declared-materialized-view-non-main-schema`: before
that change the same read failed with `schema path: main`. That ticket made a
stored view body resolve against the schema the *view* lives in — for a lens
view that is the logical schema, which is exactly the schema the basis tables
are **not** in. So the home-schema rule does not reach this case and a separate
decision is needed.

## Root cause

One site decides it: `compileOverrideBody` in `schema/lens-compiler.ts` builds
the stored body as `{ ...select, columns: composed }`, preserving the authored
FROM. Every downstream consumer then has to guess the schema, and they all guess
the same wrong way. The compiler already has the resolved `TableSchema` for each
source in hand (`collectOverrideSources`), so the schema each unqualified name
was understood to mean is known at compile time and is simply discarded.

The synthesized bodies (`compileDefaultBody`, `compileDecompositionBody`) are
unaffected — they emit fully-qualified table references already.

## Expected behavior

- A lens override that names its basis tables unqualified reads exactly the same
  as one that qualifies them, for any basis schema (not only `main`).
- Reading, `explain`ing, and proving a lens all agree on which table an
  unqualified override source meant, and agree with what the compiler validated
  at deploy time.
- A source qualified with a *different* existing schema keeps being rejected at
  deploy time (the existing cross-basis guard), unchanged.
- Qualified overrides behave byte-identically to today.

## Test expectations

- The existing `52-lens-overrides.sqllogic` § 1 fixture, re-run with the
  override's FROM unqualified — same rows.
- A lens whose basis schema is `main`, unqualified — still works (no regression).
- An override joining two basis tables, both unqualified.
- A name collision: a table of the same name in `main` and in the basis — the
  override must bind the basis one.
- `explain` / lens-prover surfaces over an unqualified override produce the same
  output as over the qualified equivalent (today the prover silently degrades to
  its conservative answer when the body fails to plan).

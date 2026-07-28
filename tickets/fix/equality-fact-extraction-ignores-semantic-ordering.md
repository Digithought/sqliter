---
description: When a query joins a duration column to a plain text column and also filters on one of them, the engine copies the filter over to the other column and compares it as plain text, so matching rows silently disappear from the answer.
files:
  - packages/quereus/src/planner/nodes/join-node.ts                              # extractEquiPairsFromCondition — the ungated fact extractor
  - packages/quereus/src/planner/analysis/comparison-collation.ts                # isValueDiscriminatingEquality — the existing collation-only gate
  - packages/quereus/src/planner/rules/predicate/rule-predicate-inference-equivalence.ts  # the consumer that makes the over-claim observable
  - packages/quereus/src/util/comparison.ts                                      # semanticOrderingsAgree — the predicate the physical extractor already uses
  - packages/quereus/test/logic/15.1-semantic-ordering.sqllogic                  # where the regression assertions belong
difficulty: medium
---

# A join between a duration column and a text column lets a filter leak across, dropping rows

## What happens

Some column types define "same value" as something other than the stored text being
identical (`docs/types.md` § "Semantic ordering"). `TIMESPAN` is the motivating one:
`'PT1H'` and `'PT60M'` are two spellings of one hour, and the `=` operator treats them as
equal.

Add a `where` clause to a join over such a pair and rows vanish:

```sql
create table pa (id integer primary key, d timespan);
create table pb (id integer primary key, s text);
insert into pa values (1, 'PT1H'), (2, 'PT30M');
insert into pb values (10, 'PT60M'), (20, 'PT45M');

-- 1 row: {l:1, r:10}
select pa.id as l, pb.id as r from pa cross join pb where pa.d = pb.s and pa.d = 'PT1H';

-- 0 rows — WRONG, same predicate, different spelling
select pa.id as l, pb.id as r from pa join pb on pa.d = pb.s where pa.d = 'PT1H';
```

Both spellings mean the same thing, so both must return the same row.

Notably the mirror-image query is fine, which is why this is easy to miss:

```sql
-- 1 row, correct, both before and after ticket mixed-type-equi-join-key-drops-semantic-matches
select pa.id as l, pb.id as r from pa join pb on pa.d = pb.s where pb.s = 'PT60M';
```

The asymmetry is the tell: pinning the *plain text* side works, pinning the
*duration* side loses rows.

This is not a regression — it behaves the same way before and after ticket
`mixed-type-equi-join-key-drops-semantic-matches`, which fixed the neighbouring
physical-join-key problem and left this one open (documented there as gap 5).

## Why

`extractEquiPairsFromCondition` in `planner/nodes/join-node.ts` reads a join's ON
condition and mints **value-level facts**: equivalence classes, functional dependencies,
key coverage, join-elimination and coverage-prover inputs. Every consumer of those facts
assumes matched rows hold *equal values* on the pair.

That assumption is false for `pa.d = pb.s` above: the join matches `'PT1H'` against
`'PT60M'`, which are equal *as durations* but are two different strings. The extractor
gates only on collation (`isValueDiscriminatingEquality`), which asks a different
question — whether a NOCASE/RTRIM comparison is folding case — so it lets the pair
through.

`rule-predicate-inference-equivalence` then does exactly what it is designed to do: it
sees the filter pin `pa.d = 'PT1H'`, sees the equivalence class saying `pa.d` and `pb.s`
hold the same value, and emits `pb.s = 'PT1H'` so the `pb` side can be filtered
independently. But `pb.s` is a plain text column and `'PT1H'` is compared to it as text,
so it matches nothing and the row is lost. (The rule also injects that conjunct as a
filter directly on the `pb` branch, which is what shows up in `query_plan()`.)

## What "fixed" looks like

- A join conjunct pairing a semantic-ordering column with a plain one (or with a
  *different* semantic-ordering type) must not contribute an equality fact — no
  equivalence class, no mirror FD, no key-coverage or FK-alignment claim.
- Dropping the fact is an under-claim, which is the safe direction: keys combine as a
  cross product, eliminations don't fire, and no filter is inferred. The physical
  equi-pair extractor already made the same trade (see `semanticOrderingsAgree` in
  `util/comparison.ts`, and `docs/optimizer-joins.md` § Physical Join Algorithm
  Selection); this is the logical-fact twin of that gate.
- Both spellings in the example above must return the same single row, in both operand
  orders and with the pin on either side.

## Also worth checking while in here

The same fact extractor feeds several other consumers that were not exercised while
finding this. Probing during review found no wrong answer from them, but the probing was
not exhaustive:

- `rule-fanout-lookup-join` — turns a recognized pair into a parameterized lookup on the
  inner side, which would seek by the raw value.
- `rule-join-elimination` and `analysis/coverage-prover` — both treat a pair as a
  1:1 alignment witness.
- `analysis/update-lineage.ts` / materialized-view matching, which lean on the same
  equi-pair equivalence notion.

If gating the extractor centrally is the fix, all of these are covered at once; if the
gate has to live per-consumer, each needs its own decision.

## Regression coverage to add

`packages/quereus/test/logic/15.1-semantic-ordering.sqllogic` already has a
"Mixed-type equi-join keys agree with `=`" section — the constant-pin variants belong
there, asserting the `on` + `where` form against the `cross join … where` form for a pin
on each side, in both operand orders.

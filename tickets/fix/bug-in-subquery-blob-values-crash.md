---
description: Asking whether a value is one of the results of a subquery crashes the engine with an internal error whenever the subquery returns binary (BLOB) data, instead of answering yes or no.
files:
  - packages/quereus/src/runtime/emit/subquery.ts    # runSetProbe — builds the lookup set in a BTree (~line 209)
  - packages/quereus/test/logic/07.7-in-subquery-caching.sqllogic   # where the set-probe corpus lives
difficulty: medium
---

# `x IN (select <blob column> from …)` throws instead of answering

## What happens

Any `IN` against a subquery whose result column holds a BLOB aborts the
statement with an internal error rather than returning true/false/NULL:

```sql
create table o (id integer primary key, t text);
create table s (id integer primary key, b blob);
insert into o values (1, 'ab');
insert into s values (1, x'6162');

select id, t in (select b from s) as m from o;
-- Execution error: Cannot freeze array buffer views with elements
```

The underlying `TypeError` comes from the B-tree the engine uses to hold the
subquery's values: it freezes each entry it stores, and JavaScript refuses to
freeze a non-empty binary buffer.

```
TypeError: Cannot freeze array buffer views with elements
  at BTree.freezeEntry (inheritree/dist/b-tree.js:200)
  at BTree.insert (inheritree/dist/b-tree.js:386)
  at runSetProbe (src/runtime/emit/subquery.ts:209)
```

## Scope — which shapes are affected

Only the shapes that use the *set probe* (the path that materializes the
subquery's results once and then tests each row against them):

- `IN` in a select list, `case when x in (…)`, or anywhere other than a
  top-level `where`/`having` condition
- `not in (select …)`
- a `where` `IN` whose subquery is correlated, non-deterministic, or otherwise
  declines the semi-join rewrite

A plain top-level `where x in (select blob_col …)` is *not* affected today: the
optimizer turns it into a semi join, which uses a different comparison path and
answers correctly (empty result set for text-vs-blob, matching SQLite). That
divergence is itself part of the problem — the same expression succeeds or
crashes depending on where it is written.

## Expected behavior

BLOB values must be storable in the lookup set, and membership must answer with
the engine's ordinary BLOB comparison semantics — so `blob_col in (select
blob_col from …)` matches on byte equality, and a text-vs-blob comparison
simply does not match. No shape should throw.

## Provenance

Found by adversarial probing during the review of
`feat-uncorrelated-in-semijoin`. It is **pre-existing** and independent of that
ticket: the failing path is entirely inside the runtime set probe, which that
ticket did not touch. No existing test covers BLOB values on the set-probe
path, which is why the suite is green.

## Suggested coverage

`07.7-in-subquery-caching.sqllogic` (the set-probe corpus) should gain a BLOB
block: blob-vs-blob match and non-match, blob against a NULL-bearing inner,
text-vs-blob non-match, and the same three in select-list position — plus the
`where` position, so the two paths are pinned to agree.

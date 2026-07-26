---
description: After an insert or update, the engine reported the text the user typed instead of the value the table actually stored — so a JSON column read back as plain text right after writing it, and a summary view kept up to date row-by-row disagreed with the table it summarizes. Fixed; this ticket is the review pass over the fix, its regression tests, and its docs.
files:
  - packages/quereus/src/runtime/emit/dml-executor.ts                     # the fix (landed in a prior run) — storedRowOrRaw / withStoredNewSection
  - packages/quereus/test/logic/42.2-returning-stored-row.sqllogic        # NEW — RETURNING parity cases
  - packages/quereus/test/logic/53-materialized-views-rowtime.sqllogic    # section 32 appended — MV maintenance parity
  - packages/quereus/src/vtab/table.ts                                    # UpdateResult.row module-author contract
  - packages/quereus/src/common/types.ts                                  # UpdateResult type doc
  - docs/runtime.md                                                       # § per-row post-write pipeline — raw-down / stored-up rule
  - docs/module-authoring.md                                              # § update results — `row` bullet
difficulty: medium
---

# Post-write consumers must see the row the substrate stored

## The defect, in plain terms

The value you write is not always the value the table keeps. A column declared
`json` given the text `'{"a":2}'` is stored as a real JSON value; a column
declared `integer` given the text `'7'` is stored as the number `7`. That
conversion happens down in the storage layer, inside `vtab.update()`.

Everything the engine reported *about* a write was built from the row as it stood
**before** that conversion. So the same column had two observable values
depending on which door you looked through:

- `insert into t values (1, '{"a":2}') returning j` reported the text
  `'{"a":2}'`, while `select j from t where id = 1` reported the JSON value.
- A materialized view maintained row-by-row grouped `'{"a":1}'` and
  `'{ "a" : 1 }'` into **two** groups; the same view body evaluated against the
  base table produced **one**.

## What is in the diff

### The engine fix (landed in an earlier run — unchanged by this run)

`vtab.update()` already returns `result.row`: the row the substrate actually
stored, after its own coercion. The DML executor was ignoring it. All of the
change is in `packages/quereus/src/runtime/emit/dml-executor.ts`:

- `storedRowOrRaw(resultRow, rawRow, columnCount)` — the substrate's row when
  present and of the right width, else the raw row. The fallback serves the
  minimal test/sample modules that echo their input and never coerce.
- `withStoredNewSection(flatRow, storedRow, rawNewRow, columnCount)` — rebuilds
  the flat OLD/NEW row with the NEW half replaced by the stored row, so
  `RETURNING` projects stored values. Returns `flatRow` untouched when the
  fallback fired (no allocation in the no-coercion case).
- `processInsertRow`, `processUpdateRow`, `executeUpsertUpdate` compute
  `storedRow` right after the write and use it for change tracking, row-time
  materialized-view maintenance, the FK cascade, the auto-emitted data event,
  the changed-column comparison, and the row yielded downstream.
- DELETE deliberately untouched: its OLD row comes from the source scan (already
  stored), and `result.row` is *not* trustworthy for delete — the isolation layer
  returns a PK-only placeholder there.

### Regression tests (this run)

`packages/quereus/test/logic/42.2-returning-stored-row.sqllogic` — new file, 6
sections. Every case is a **parity assertion**: what `returning` reports must
equal what a following `select` reports, both value and `typeof`. `typeof()` is
what makes it sharp — a raw `'{"a":2}'` reports `text`, the stored value reports
`json`; a raw `'7'` reports `text`, the stored value reports `integer`.

- plain INSERT (named projection, `returning *`, multi-row)
- UPDATE, including an `old.<col>` / `new.<col>` projection asserting both images
  are coerced, and a whitespace-only JSON rewrite
- UPDATE that **moves the primary key** (the delete+insert arm), with
  `returning old.id, id, …`
- `on conflict (id) do update … returning` — both the conflicting arm and a
  non-conflicting insert through the same statement shape
- `insert or replace … returning`
- negative pin: `insert or ignore` on a conflicting row returns **no rows**, and
  the existing row is untouched; a non-conflicting `or ignore` insert does emit
  its stored row

`packages/quereus/test/logic/53-materialized-views-rowtime.sqllogic` — appended
section 32. A materialized view grouping on a `json` column, plus **the same
body as a plain (recomputed-from-base) view** so each assertion is checked
against both. Covers: two structurally-equal / textually-different spellings
merging into one group; a genuinely different value opening its own group; a
group-key UPDATE whose new key is a whitespace variant of an existing group
merging into it; splitting back out; and an `integer`-affinity group key where
`'7'` must group with numeric `7`.

**Both new suites were verified to actually bite.** `storedRowOrRaw` was
temporarily forced to always return the raw row; 42.2 failed at its first
assertion (`{"j":"{\"a\":2}","jt":"text","n":"7","nt":"text"}` against the
expected `{"j":{"a":2},"jt":"json","n":7,"nt":"integer"}`) and section 32 failed
with `Row count mismatch. Expected 1, got 2`. The helper was then restored —
`git diff` confirms `dml-executor.ts` is unmodified by this run.

### Docs

- `packages/quereus/src/vtab/table.ts` — `update()`'s doc comment now states the
  module-author contract: `row` is the **stored** row, a coercing module **must**
  return its coerced row, omitting it (or a wrong width) means "I store
  verbatim" and the executor falls back, and DELETE's `row` is never consulted.
- `packages/quereus/src/common/types.ts` — the `UpdateResult` type comment points
  at that contract.
- `docs/runtime.md` § per-row post-write pipeline — new **"Raw flows down, stored
  flows back up"** paragraph: coercion happens inside `vtab.update()`, so the row
  handed down is raw and the row reported back is stored, and every post-write
  consumer reads the latter. Also records that nothing is coerced above
  `update()`, so a row is coerced exactly once.
- `docs/module-authoring.md` § update results — a `row` bullet alongside the
  existing `replacedRow` / `evictedRows` bullets, written for a module author.

## How to exercise it by hand

```sql
create table t (id integer primary key, j json, n integer);
insert into t values (1, '{"a":2}', '7') returning j, typeof(j), n, typeof(n);
select j, typeof(j), n, typeof(n) from t where id = 1;   -- must match exactly
```

Same shape for `update … returning`, `on conflict do update … returning`,
`insert or replace … returning`, and a PK-moving `update`. For the view side:
group a materialized view on a `json` column, insert `'{"a":1}'` and
`'{ "a" : 1 }'`, and confirm one group of two — matching the same body as a
plain view.

## Validation run

- `yarn test` — **7185 passing, 0 failing** (7184 before; +1 for the new file).
- `yarn test:store` — **7179 passing, 0 failing, 19 pending** (7178 before; the
  19 pending are pre-existing store-mode skips, untouched).
- `yarn workspace @quereus/quereus run lint` — clean (eslint + test-file
  typecheck), exit 0.
- Per-file runs of both new/extended suites, plus the deliberately-broken-helper
  runs described above.

## Known gaps — please probe these

These are honest holes, not oversights papered over:

- **The isolation overlay substrate is not covered by the new cases.** The
  `.sqllogic` suite runs against the memory module (`yarn test`) and the LevelDB
  store (`yarn test:store`). `packages/quereus-isolation` has its own spec files
  and does not run `.sqllogic` at all, so the overlay's coercion path
  (`isolated-table.ts` returning the overlay memory table's coerced row,
  tombstone-sliced) is asserted only by reasoning, not by a test in this diff.
  Worth a targeted spec if the reviewer thinks the overlay's row-width or
  tombstone slicing could drift.
- **Only two of the six post-write consumers are pinned by tests.** `RETURNING`
  and row-time materialized-view maintenance are covered. Change tracking
  (`Database.watch` / change-scope / `DeltaExecutor`), the auto-emitted data
  event, the changed-column comparison, and the FK cascade all now read
  `storedRow` too, and none of them has a coercion-parity assertion. A watcher
  test that asserts the delivered NEW row is coerced would close the largest of
  these.
- **DELETE has no new test.** It is deliberately excluded from the fix; nothing
  pins that exclusion, so a future change that "helpfully" routes DELETE through
  `result.row` would break silently against the isolation layer's placeholder row
  rather than failing a test.
- **A `json` column holding a bare text scalar is deliberately not pinned.**
  `RETURNING` now surfaces the corrupted value the storage layer's
  non-idempotent re-parse produces on update, instead of the clean input text.
  That is honest reporting of an existing storage defect and is owned by
  `bug-json-string-scalar-not-round-trip-safe` (in `tickets/fix/`); pinning
  today's wrong value here would just have to be un-pinned when that lands.

## Out of scope (tracked elsewhere)

- The **pre-write foreign-key RESTRICT comparison** has the same class of bug —
  it compares a stored OLD row against a raw NEW row *before* `vtab.update()`
  runs, so there is no stored row yet and `result.row` cannot fix it. Filed as
  `bug-fk-restrict-change-detection-uncoerced` in `tickets/fix/`; confirmed
  reproducing.
- **Making coercion idempotent** (coerce once, up front, in
  `emit/insert.ts` / `emit/update.ts`, and retire `constraint-check.ts`'s
  separate coerced copy) is the deeper eventual shape. It needs JSON to stop
  representing a JSON string scalar as a bare JS string. Tracked as
  `bug-json-string-scalar-not-round-trip-safe` (fix/) and
  `bug-json-text-scalar-reparsed-on-write` (backlog/).

## Tripwire already parked in code

`withStoredNewSection` carries a `NOTE:`-style comment recording that on a
coercing substrate it allocates one array per written row (the executor
previously yielded `flatRow` verbatim). One copy against a per-row
`vtab.update()` await does not register today; if bulk-INSERT throughput ever
shows it as hot, the fix is for substrates to report which columns coercion
actually changed and patch only those in place. Noted here so the reviewer knows
it was considered rather than missed.

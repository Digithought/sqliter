---
description: After an insert or update, the engine reported the text the user typed instead of the value the table actually stored — so a JSON column read back as plain text right after writing it, and a summary view kept up to date row-by-row disagreed with the table it summarizes. Fixed, tested, reviewed, and shipped.
files:
  - packages/quereus/src/runtime/emit/dml-executor.ts                      # the fix — storedRowOrRaw / withStoredNewSection
  - packages/quereus/test/logic/42.2-returning-stored-row.sqllogic         # RETURNING parity cases
  - packages/quereus/test/logic/53-materialized-views-rowtime.sqllogic     # section 32 — MV maintenance parity
  - packages/quereus/test/logic/change-scope.spec.ts                       # NEW (review) — change-tracking parity
  - packages/quereus-isolation/test/isolation-layer.spec.ts                # NEW (review) — overlay substrate parity
  - packages/quereus/src/vtab/table.ts                                     # UpdateResult.row module-author contract
  - packages/quereus/src/common/types.ts                                   # UpdateResult type doc
  - docs/runtime.md                                                        # § per-row post-write pipeline
  - docs/module-authoring.md                                               # § update results — `row` bullet
---

# Post-write consumers see the row the substrate stored

## What was wrong

The value you write is not always the value the table keeps. A column declared
`json` given the text `'{"a":2}'` is stored as a real JSON value; a column
declared `integer` given the text `'7'` is stored as the number `7`. That
conversion happens down in the storage layer, inside `vtab.update()`.

Everything the engine reported *about* a write was built from the row as it
stood **before** that conversion, so the same column had two observable values
depending on which door you looked through — `insert … returning j` reported the
input text while `select j` reported the JSON value, and a materialized view
maintained row-by-row split two spellings of the same JSON value into two groups
where the same view body over the base table produced one.

## What shipped

`vtab.update()` already returns `result.row`: the row the substrate actually
stored. The DML executor was ignoring it. Two helpers in
`packages/quereus/src/runtime/emit/dml-executor.ts` fix that —
`storedRowOrRaw()` picks the substrate's row (falling back to the proposed row
when a module reports one of the wrong width, which the minimal test/sample
modules that never coerce rely on), and `withStoredNewSection()` swaps the NEW
half of the flat OLD/NEW row so `RETURNING` projects stored values. All six
post-write consumers — `RETURNING`, change tracking, row-time materialized-view
maintenance, the foreign-key cascade, the changed-column comparison, and the
auto-emitted data event — now read the stored row, on the INSERT, UPDATE, and
UPSERT-DO-UPDATE arms.

DELETE deliberately does not consult the row's *contents*: its OLD image comes
from the source scan and is already stored, and the isolation layer returns a
PK-only placeholder there. It does still depend on the row's *presence* — see
the first review finding.

Regression coverage: `42.2-returning-stored-row.sqllogic` (six sections of
`returning`-vs-`select` parity, asserting value **and** `typeof`, across plain
INSERT, UPDATE, PK-moving UPDATE, `on conflict do update`, `insert or replace`,
and a negative `insert or ignore` pin) and section 32 of
`53-materialized-views-rowtime.sqllogic` (a maintained view checked against the
same body as a plain recomputed view). Both were verified to fail when the
helper is forced back to the raw row.

## Review findings

Implement-stage diff read first and in full (commits `7a3c7267` engine +
`0843091c` tests/docs), then the substrate contracts on all three modules
(memory manager, store table, isolation overlay), then the handoff summary.

### Fixed in this pass

**The `UpdateResult.row` contract was documented backwards for the "omit it"
case — all four doc sites.** They told module authors that leaving `row` out
means "I store values verbatim; the executor falls back to the proposed values",
and that for DELETE it should be left undefined because the executor "never
consults it". Both are wrong. Every arm of the executor short-circuits on
`!result.row` and returns nothing downstream — that *absence* is the engine's
"nothing was written" signal, used for a key-not-found UPDATE/DELETE and for a
conflict the module itself resolved as IGNORE. A module author following the old
text would have shipped a table whose INSERT emits no `RETURNING` rows, records
no change, maintains no materialized view and fires no FK cascade; one following
the DELETE sentence would have broken DELETE outright. (`storedRowOrRaw`'s own
absent-row branch is unreachable for the same reason — only its width fallback
is live.) Rewrote the contract in `src/vtab/table.ts`, `src/common/types.ts`,
`docs/runtime.md`, and `docs/module-authoring.md` to state both halves — presence
means "a row really was written or removed", contents are the stored row and are
read for INSERT/UPDATE only — and tightened `storedRowOrRaw`'s comment to say
which branch is live. Also corrected `docs/module-authoring.md`'s section
preamble, which still framed the bullet list as "two optional channels" after
the non-optional `row` bullet was added to it.

**The isolation overlay had no test; it does now, and the fix is correct there.**
New `describe('isolated table stored-row reporting')` in
`packages/quereus-isolation/test/isolation-layer.spec.ts`: INSERT, UPDATE, and a
PK-moving UPDATE each assert `RETURNING` equals a following `SELECT` (value and
`typeof`) through the overlay, and a DELETE case asserts the tombstone path still
reports a row while a never-present key reports none. The handoff's reasoning
about this path held up — the isolation layer coerces only for conflict
detection and writes the raw row into the overlay, leaving the overlay's single
coercion pass to produce the stored row, which is then sliced back to
user-facing width.

**Change tracking is now pinned for coercion** — the largest of the handoff's
"only two of six consumers are covered" gap. Two tests in
`packages/quereus/test/logic/change-scope.spec.ts`: a `rows` watch on an
`integer` primary key fed the text `'7'` (it can only match if the executor
recorded the post-coercion row, on both the insert and the key-moving update),
and a `groups` watch on a `json` column asserting the delivered group key is the
parsed value rather than the input string.

### Found, deliberately not filed

**DELETE's exclusion from the fix was unpinned; it is now pinned by the new
isolation DELETE case** rather than by a ticket. That case fails if someone
routes DELETE's OLD image through `result.row`, because the overlay returns a
PK-only placeholder there.

**The remaining three unpinned consumers are not worth their own tests.** The
auto-emitted data event, the changed-column comparison, and the FK cascade have
no coercion-parity assertion. All three read the same `storedRow` local, in the
same three functions, as the two consumers that *are* pinned — a regression
reaching them would have to break `RETURNING` and change tracking first. No
ticket filed.

**A `json` column holding a bare text scalar is still not pinned**, as the
handoff said. `RETURNING` now surfaces the corrupted value the storage layer's
non-idempotent re-parse produces, which is honest reporting of a defect owned by
`bug-json-string-scalar-not-round-trip-safe` (in `tickets/fix/`). Pinning
today's wrong value would only have to be un-pinned when that lands.

### Process note (not a code defect)

The new isolation tests failed on their first run against a **stale
`packages/quereus/dist`**. Cross-package tests import the built
`@quereus/quereus`, and neither `yarn test` nor `yarn lint` rebuilds it — so
before this pass no test in the repo had ever exercised this fix through a
consumer package. `yarn build` first; everything is green after. Worth
remembering whenever a change to the engine is meant to be observed from another
workspace.

### Tripwires

No new ones. The existing `NOTE:` on `withStoredNewSection` — that a coercing
substrate now costs one array copy per written row, negligible against a per-row
`vtab.update()` await, with the escape hatch being for substrates to report
which columns coercion actually changed — was checked and is accurate; left in
place.

### Also checked, nothing found

`withStoredNewSection`'s identity fast-path and its assumption that the flat row
is exactly twice the column count (`extractNewRowFromFlat` always returns a fresh
`slice`, and `composeOldNewRow` always builds `2n`, so both hold); every
`vtab.update()` call site in the executor including the UPSERT DO-UPDATE arm;
what each of the three substrates actually returns in `row` for each operation;
the ordering of the stored-row computation against the REPLACE eviction and
`replacedRow` bookkeeping; and both new `.sqllogic` suites for coverage holes.

## Validation

- `yarn build` — clean (required; see the process note above).
- `yarn test` — **7187 passing, 0 failing, 13 pending** across all workspaces
  (7185 before; +2 for the new change-tracking tests). Isolation package: 255
  passing (252 before; +3).
- `yarn test:store` — **7181 passing, 0 failing, 19 pending** (7179 before; +2).
- `yarn lint` — clean, exit 0. `yarn typecheck` — clean, exit 0.

## Out of scope (tracked elsewhere)

- The **pre-write foreign-key RESTRICT comparison** has the same class of bug but
  cannot be fixed the same way — it compares a stored OLD row against a raw NEW
  row *before* `vtab.update()` runs, so there is no stored row yet. Filed as
  `bug-fk-restrict-change-detection-uncoerced` in `tickets/fix/`.
- **Making coercion idempotent** (coerce once, up front, and retire
  `constraint-check.ts`'s separate coerced copy) is the deeper eventual shape.
  It needs JSON to stop representing a JSON string scalar as a bare JS string.
  Tracked as `bug-json-string-scalar-not-round-trip-safe` (fix/) and
  `bug-json-text-scalar-reparsed-on-write` (backlog/).

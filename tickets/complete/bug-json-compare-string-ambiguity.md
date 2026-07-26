---
description: A rule that compares two JSON columns while saving a row used to reject perfectly good rows; fixed, tested, documented, and a follow-on defect found during review was fixed in the same pass.
files:
  - packages/quereus/src/runtime/emit/constraint-check.ts           # phase order: NOT NULL on the raw row, then the coerced view for CHECK/FK
  - packages/quereus/src/types/json-type.ts                         # JSON_TYPE.compare — no re-parse fallback; rank/storage-class NOTE
  - packages/quereus/test/logic/15.1.1-json-check-coercion.sqllogic # end-to-end regression
  - packages/quereus/test/logic/40.2-check-extras.sqllogic          # OR REPLACE default-substitution CHECK regression
  - packages/quereus/test/type-system.spec.ts                       # unit cases for mixed-type JSON_TYPE.compare
  - docs/types.md                                                   # "Where coercion happens (and why exactly once)"
  - docs/runtime.md                                                 # deferred-constraint queueing snippet
---

# JSON comparison inside CHECK constraints — complete

## What the bug was

A column declared `json` orders by what the JSON *means*, so `{"a":2}` sorts before
`{"a":10}` (2 is less than 10). That held everywhere the engine had already converted
stored text into a real JSON value, but not inside an immediate `check (...)`: the
insert pipeline evaluated CHECK against the row *before* conversion, so values were
still raw text and compared letter-by-letter — `{"a":10}` before `{"a":2}`, because
`1` sorts before `2`.

```sql
create table c (id integer primary key, a json, b json, check (a < b));
insert into c values (1, '{"a":2}', '{"a":10}');
-- was: ConstraintError: CHECK constraint failed: _check_0 (a < b)
-- now: succeeds, matching `select (a < b)` after the row is stored
```

## What shipped

**Fix stage (`b4c9af26`).** `ConstraintCheckNode` builds a coerced copy of the NEW
half of the flat OLD/NEW row once per row (`coerceNewSection`) and evaluates CHECK
against that copy, so immediate CHECKs read the same values a later `select` does
(deferred CHECKs already did). With every `JSON_TYPE.compare` caller then guaranteed
to hold parsed values, the guessing in `compare` was removed: a JS string is
unconditionally a JSON string scalar, nothing is re-parsed, and mixed-type pairs fall
through to the structural comparison. `compare('9', 9)` is now `1` (number ranks
before string) instead of `0`.

**Implement stage (`b401f32b`).** Regression test `15.1.1-json-check-coercion.sqllogic`,
unit cases in `type-system.spec.ts`, the `docs/types.md` coercion section, and a guard
so the per-row copy is skipped on tables that carry no constraint expressions.

**Review stage (this pass).** Fixed a regression the fix stage introduced (below),
restructured the phase order, added regression coverage for both defects, and brought
`docs/runtime.md` in line.

## The invariant everything rests on

The raw row keeps flowing downstream; only CHECK/FK evaluation gets a coerced copy.
Coercing further upstream fails — `JSON_TYPE.parse` is not idempotent for a JSON
string scalar (`parse('"Bob"')` → `Bob`; `parse('Bob')` throws), and the storage layer
coerces every row on its own, so a pre-coerced row is coerced twice and blows up.

## Review findings

### Checked

Read the `b4c9af26` and `b401f32b` diffs before the handoff summary. Audited
`constraint-check.ts` end to end (not only the changed lines), `json-type.ts`,
`context-helpers.ts` (row-context lifetime and getter laziness), the comparison
dispatch in `runtime/emit/binary.ts` and `util/comparison.ts`, and `emit/cast.ts`.
Re-read `docs/types.md` and `docs/runtime.md` against the new code. Ran lint,
typecheck, the full memory suite, and the LevelDB store suite.

### Major — fixed in this pass

**The fix stage regressed `OR REPLACE` default substitution on JSON columns.** The
NOT NULL pass runs *inside* the row context that CHECK expressions read from. Once
that context started exposing the coerced row, a column DEFAULT spelled
`default (new.<json col>)` began reading the **parsed** value; that value is written
straight back into the row that continues on to the storage layer, which parses it a
second time. Reproduced at the implement-stage commit:

```sql
create table p (id integer primary key, j json, k json not null default (new.j), check (id > 0));
insert or replace into p values (1, '"Bob"', null);
-- QuereusError: Type conversion failed for column 'k': Cannot convert 'Bob' to JSON: invalid JSON syntax
```

Only string scalars threw — for objects and arrays `parse` happens to be idempotent,
which is why the implement-stage suite stayed green. The `hasConstraintExprs` guard
added at implement stage also made the behaviour *depend on whether the table happens
to carry a CHECK*, since a constraint-free table kept seeing the raw row.

Fixed by giving the two phases different views of the row. `withAsyncRowContext`'s
row getter is called lazily per lookup, so one context now serves both: NOT NULL (and
its DEFAULT substitution) runs first against the raw row, then `coerceNewSection` runs
on the row *as finally substituted* and the getter is swapped to it for the CHECK/FK
phase. No extra context push, and the previous double `coerceNewSection` on the
REPLACE path collapses to one. Regression coverage in
`15.1.1-json-check-coercion.sqllogic` (string scalar, object, and the constraint-free
control); proved to discriminate by temporarily restoring the old phase order.

**`insert or replace` skipped CHECK on a substituted DEFAULT** — the defect the
implement stage found and filed as `tickets/fix/bug-replace-default-skips-check.md`.
The same restructure fixes it: the CHECK phase now observes the substituted row rather
than the pre-substitution one, so

```sql
create table t (id integer primary key, v integer not null default 5 check (v > 100));
insert or replace into t values (1, null);   -- now rejected; previously stored v=5
```

That ticket is therefore deleted rather than carried forward. Coverage added to
`40.2-check-extras.sqllogic`: rejected substitution, accepted substitution, the
deferred CHECK path, a `new.<sibling>` DEFAULT still resolving, and the UPDATE path
(which has no statement-level `OR` clause, so it substitutes via a column-level
`not null on conflict replace`). Each case was proved to discriminate.

### Minor — fixed in this pass

- The parent-side FK UPDATE "did any referenced column change?" short-circuit compared
  an already-coerced OLD value against a raw NEW value, so an unchanged column read as
  changed for any type whose raw and coerced forms differ. Only cost a redundant
  `NOT EXISTS` (never a missed check), but it now reads both halves from the coerced
  view.
- `checkCheckConstraints` no longer takes the `row` parameter it stopped using.
- The comment claiming "only the CHECK / FK expressions read this view" was false — the
  NOT NULL DEFAULT evaluators read it too. Rewritten to state the actual phase order.
- `docs/runtime.md`'s deferred-constraint snippet still showed `coerceNewSection` being
  called inline at the queue site; updated to the shared per-row view.
- `docs/types.md` said "constraint evaluation" where it now means CHECK/FK only, and
  gained a paragraph on why the phase order is what it is.

### Tripwires — recorded, not ticketed

- `NOTE:` at `jsonTypeOrder` in `packages/quereus/src/types/json-type.ts`: JSON's type
  rank and `StorageClass` in `util/comparison.ts` must stay ordered compatibly.
  `createTypedComparator` short-circuits on a storage-class mismatch before reaching
  `JSON_TYPE.compare`, while `compareSqlValues` calls the type's compare directly; the
  two agree today only because both put numbers before strings and strings before
  containers. Reorder either and `j1 < j2` starts disagreeing with `order by j`.
- `NOTE:` at the `coerceNewSection` call site: the copy runs `validateAndParse` over
  *every* column of a check-bearing table, including columns no constraint references.
  Worth narrowing only if constraint-heavy insert throughput shows as hot.

### Found but already tracked — no new ticket

- `insert ... returning j` reports the raw, uncoerced value (`typeof(j)` is `text`, not
  `json`), and row-time materialized-view maintenance writes the raw value into the MV
  backing, so an incrementally-maintained MV over a `json` column diverges from the same
  MV rebuilt from the base table. Same cause (the DML executor's row is raw), tracked as
  `bug-dml-downstream-uses-uncoerced-row`.
- The `JSON_TYPE.parse` non-idempotence that made the regression above possible is the
  general defect behind `bug-json-string-scalar-not-round-trip-safe` (fix/) and
  `bug-json-text-scalar-reparsed-on-write` (backlog/).

### Known remaining gaps

- Two sections of `15.1.1-json-check-coercion.sqllogic` are must-not-regress guards
  rather than proofs: the collation/BINARY cases (under the pre-fix raw path
  `'"Bob"' = '"bob"' collate nocase` compares the quoted texts and still folds to
  equal) and the deferred-CHECK section (deferred CHECKs already received the coerced
  row before the fix). The structural, type-rank, and DEFAULT-substitution cases are
  the discriminating ones.
- The skip-the-copy guard for constraint-free tables was not perf-measured. It removes
  obviously dead work and `performance-sentinels.spec.ts` (including `bulk insert 1000
  rows under 500 ms`) still passes, but the size of the win is unknown.
- No coverage for a `json` column used as an FK referenced column, where the coerced
  OLD/NEW comparison above would matter in practice.

## Validation

| Command | Result |
| --- | --- |
| `yarn workspace @quereus/quereus run lint` | exit 0 |
| `yarn workspace @quereus/quereus run typecheck` | exit 0 |
| `yarn test` (all workspaces, memory-backed) | green — 7184 passing, 13 pending, 0 failing |
| `yarn test:store` (LevelDB backend) | green — 7178 passing, 19 pending |

No pre-existing failures surfaced; `tickets/.pre-existing-error.md` was not written.

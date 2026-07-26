---
description: A rule that compares two JSON columns while saving a row used to reject perfectly good rows; the fix is in place and now has regression tests and documentation.
files:
  - packages/quereus/src/runtime/emit/constraint-check.ts          # coerceNewSection computed once per row, now skipped when no CHECK/FK expression reads it
  - packages/quereus/src/types/json-type.ts                        # JSON_TYPE.compare — re-parse fallback removed (already committed)
  - packages/quereus/test/logic/15.1.1-json-check-coercion.sqllogic # NEW — end-to-end regression
  - packages/quereus/test/type-system.spec.ts                      # NEW unit case for mixed-type JSON_TYPE.compare
  - docs/types.md                                                  # NEW "Where coercion happens (and why exactly once)" section
  - tickets/fix/bug-replace-default-skips-check.md                 # NEW ticket for a pre-existing defect found while testing
difficulty: medium
---

# JSON comparison inside CHECK constraints — review

## What the change is

A column declared `json` is ordered by what the JSON *means*, so `{"a":2}` sorts
before `{"a":10}` (2 is less than 10). That held everywhere the engine had
already converted stored text into a real JSON value, but not inside an immediate
`check (...)`: the insert pipeline evaluated CHECK against the row *before*
conversion, so values were still raw text and compared letter-by-letter —
`{"a":10}` before `{"a":2}`, because `1` sorts before `2`.

```sql
create table c (id integer primary key, a json, b json, check (a < b));
insert into c values (1, '{"a":2}', '{"a":10}');
-- was: ConstraintError: CHECK constraint failed: _check_0 (a < b)
-- now: succeeds, matching `select (a < b)` after the row is stored
```

The root-cause change landed in commit `b4c9af26` (before this ticket ran):

- `constraint-check.ts` computes `coerceNewSection` **once per row** and exposes
  that coerced copy through `withAsyncRowContext`, so immediate CHECKs read the
  same values a later `select` does. Deferred CHECKs already used it.
- With every `JSON_TYPE.compare` caller now guaranteed to hold parsed values, the
  guessing in `compare` is gone: a JS string is unconditionally a JSON string
  scalar, nothing is re-parsed, and mixed-type pairs fall through to the
  structural comparison. `compare('9', 9)` is now `1` (number ranks before
  string) instead of `0`.

**The invariant the fix rests on:** the raw row keeps flowing downstream; only
constraint evaluation gets a coerced copy. Coercing further upstream was
prototyped and fails — `JSON_TYPE.parse` is not idempotent for a JSON string
scalar (`parse('"Bob"')` → `Bob`; `parse('Bob')` throws), and the storage layer
coerces every row on its own, so a pre-coerced row is coerced twice and blows up.

## What this ticket added

**Regression test** — `packages/quereus/test/logic/15.1.1-json-check-coercion.sqllogic`
(new file; `15.1-semantic-ordering.sqllogic` is the thematic neighbour, not
`06.9-json-canonical-key.sqllogic` as the incoming ticket guessed). Covers:

- two `json` columns compared with `<` in an immediate CHECK, accepted where text
  order would reject; the reversed and equal pairs still rejected;
- JSON type rank across a CHECK (`'5' < '"a"'`) — chosen because raw text order
  is the *opposite* (`"` precedes `5`), so it discriminates;
- the same comparisons through an auto-deferred CHECK (`check ((select a < b))`),
  proving immediate and deferred agree;
- the UPDATE path through the same coerced NEW section;
- a JSON string scalar under an explicit `collate nocase` in a CHECK, plus the
  BINARY control, plus the `'"Bob"'` → `Bob` round-trip.

**Unit test** — `type-system.spec.ts`, new case `should treat a JS string as a
JSON string scalar, never as serialized text`: `compare('9', 9) === 1`,
`compare(9, '9') === -1`, `compare(true, 1) === -1`, string-vs-container pairs
(`'[1]'` vs `[1]`) not re-parsed, and a collation unable to reorder ranks.

**Documentation** — `docs/types.md` gained "Where coercion happens (and why
exactly once)" under Type Validation: the storage layer is the single conversion
point, constraint evaluation takes its own copy, `JSON_TYPE.parse` is not
idempotent for string scalars, and the consequence for raw-row consumers.
(Ticket said `packages/quereus/docs/types.md`; the real path is `docs/types.md`
at the repo root — `packages/quereus/docs/` does not exist.)

**Perf follow-up on the `NOTE:` at the `coerceNewSection` call site.** The note
claimed the copy runs "only for tables that have constraints at all". That was
wrong: the DML builders emit a `ConstraintCheckNode` for **every** table
(`planner/building/insert.ts:797`, `update.ts:397,446`, `delete.ts:250`) and no
optimizer rule elides it, so a constraint-free bulk insert was paying a
`row.slice()` plus a per-column `validateAndParse` on every row. The copy is now
guarded by `hasConstraintExprs` (`constraintMetadata.length > 0`); NOT NULL reads
the raw row and coercion cannot change NULL-ness, so nothing else needed it. The
note was rewritten to say what is actually true.

## How to exercise it

```
yarn workspace @quereus/quereus run test:single packages/quereus/test/logic.spec.ts --grep "15.1.1"
yarn workspace @quereus/quereus run test:single packages/quereus/test/type-system.spec.ts --grep "JSON_TYPE"
```

## Validation actually run

| Command | Result |
| --- | --- |
| `yarn test` (all workspaces, memory-backed) | green |
| `yarn test:store` (LevelDB backend) | green — 7178 passing, 19 pending |
| new logic file under `QUEREUS_TEST_STORE=true` | green (confirmed it is not skipped in store mode) |
| `yarn workspace @quereus/quereus run typecheck` | exit 0 |
| `yarn workspace @quereus/quereus run lint` | exit 0 |
| `performance-sentinels.spec.ts` | 22 passing, incl. `bulk insert 1000 rows under 500 ms` |

**The new logic test was proved to discriminate**: temporarily reverting the
row-context line to expose the raw `flatRow` makes
`15.1.1-json-check-coercion.sqllogic` fail on its first insert with
`CHECK constraint failed: _check_0 (a < b)`. The line was restored afterwards.

## Known gaps — please probe these

- **The collation and BINARY-control sections do not discriminate.** Under the
  pre-fix raw path `'"Bob"' = '"bob"' collate nocase` compares the quoted texts
  and still folds to equal, so those cases are must-not-regress guards, not
  proofs of the fix. Only the structural and type-rank cases fail without it.
- **The deferred section does not discriminate either** — deferred CHECKs already
  received the coerced row before this fix. It pins immediate/deferred agreement,
  which is what it claims, but it would pass on the old code.
- **`hasConstraintExprs` was not perf-measured.** It is an obvious removal of
  dead work and the bulk-insert sentinel still passes, but no before/after timing
  was taken, so the size of the win is unknown.
- **`coerceNewSection` still coerces every column** for tables that do have
  checks, even columns no constraint references. Left as the `NOTE:` at the call
  site.
- **`insert ... returning j` still reports the raw, uncoerced value** (`typeof(j)`
  is `text`, not `json`), and row-time materialized-view maintenance writes the
  raw value into the MV backing — so an incrementally-maintained MV over a `json`
  column diverges from the same MV rebuilt from the base table. Same cause (the
  DML executor's `flatRow` / `newRow` are raw), tracked separately as
  `bug-dml-downstream-uses-uncoerced-row`. Deliberately not folded in here; it is
  now also written down in `docs/types.md`.

## Defect found while testing (pre-existing, filed separately)

`tickets/fix/bug-replace-default-skips-check.md`. `insert or replace` that
substitutes a column's NOT NULL DEFAULT evaluates CHECK against the
**pre-substitution** row, because the row context is opened before the NOT NULL
pass and `checkConstraints` only reassigns a local variable:

```sql
create table t (id integer primary key, v integer not null default 5 check (v > 100));
insert into t values (2, 7);              -- correctly rejected
insert or replace into t values (1, null); -- ACCEPTED, stores v=5, which is not > 100
```

Verified pre-existing: `git show b4c9af26^:.../constraint-check.ts` has the same
shape (it exposed `flatRow` and reassigned the same local), so this is not a
regression from the JSON fix. Not fixed here — the NOT NULL pass cannot simply be
hoisted, because a DEFAULT may reference `new.<col>` and needs the row context
itself.

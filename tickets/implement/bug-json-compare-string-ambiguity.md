---
description: A rule that compares two JSON columns while saving a row used to reject perfectly good rows; the cause is fixed and now needs tests and documentation.
files:
  - packages/quereus/src/runtime/emit/constraint-check.ts       # coerceNewSection is now computed once per row and feeds the constraint row context
  - packages/quereus/src/types/json-type.ts                     # JSON_TYPE.compare — re-parse fallback removed
  - packages/quereus/src/types/validation.ts                    # validateAndParse / coerceRowToSchema (unchanged; background)
  - packages/quereus/test/planner/collation-soundness.spec.ts   # must-not-regress: NOCASE over JSON string scalars
  - packages/quereus/test/collation-key-normalizer.spec.ts      # must-not-regress: '"Bob"'/'"BOB"' grouped under NOCASE
  - packages/quereus/test/logic/06.9-json-canonical-key.sqllogic # nearest existing JSON logic test file
  - packages/quereus/docs/types.md                              # where the JSON coercion boundary should be written down
difficulty: medium
---

# JSON comparison inside CHECK constraints

## Status: the code fix is already in the working tree

The root-cause change is written and validated. `yarn test` (all workspaces),
`yarn workspace @quereus/quereus run typecheck` and `... run lint` are all green
with it applied. What is **not** done is regression coverage, documentation, and
a run against the LevelDB store backend — that is this ticket.

## What was wrong

A column declared `json` is supposed to be ordered by what the JSON *means*, so
`{"a":2}` sorts before `{"a":10}` (2 is less than 10). That held everywhere the
engine had already converted the stored text into a real JSON value, but not
inside an immediate `check (...)` constraint: the insert pipeline evaluated CHECK
against the row *before* conversion, so the values were still the raw text the
user typed and got compared letter-by-letter — `{"a":10}` before `{"a":2}`,
because `1` sorts before `2`.

```sql
create table c (id integer primary key, a json, b json, check (a < b));
insert into c values (1, '{"a":2}', '{"a":10}');
-- was: ConstraintError: CHECK constraint failed: _check_0 (a < b)
-- now: succeeds, matching `select (a < b)` after the row is stored
```

The second half of the same ambiguity: `JSON_TYPE.compare` could not tell a JSON
*string scalar* (a `json` column holding `'"hello"'` arrives as the plain JS
string `hello`) from *serialized JSON text*, so it guessed — and re-parsed a
string that was paired with a non-string. That made `JSON_TYPE.compare('9', 9)`
return `0`, claiming the JSON string `"9"` and the JSON number `9` are the same
value even though the type's own ordering puts numbers before strings.

## What the fix does

**One coerced view of the row, computed once, used only by constraints.**

`constraint-check.ts` already had `coerceNewSection`, which converts the NEW half
of the flat OLD/NEW row to the declared column types. It was only used to build
the snapshot handed to *deferred* constraints (and recomputed once per deferred
constraint). It is now computed **once per row**, and that coerced row is what
the constraint expressions read through `withAsyncRowContext` — so an immediate
CHECK sees `{"a":2}` as a parsed JSON value, exactly like a later `select` does.

With every `JSON_TYPE.compare` caller now guaranteed to hold parsed values, the
guessing in `compare` is gone: a JS string is unconditionally a JSON string
scalar, nothing is re-parsed, and the mixed-type case falls through to the normal
structural comparison. `compare('9', 9)` is now `1` (number ranks before string).

**Why the coercion was NOT moved further upstream.** The obvious-looking
alternative — coerce the NEW section in `emit/insert.ts` / `emit/update.ts` so
the whole downstream pipeline sees converted values — was prototyped and
**fails**. `JSON_TYPE.parse` is not idempotent for a JSON string scalar:
`parse('"Bob"')` returns the bare string `Bob`, and `parse('Bob')` then throws
`Cannot convert 'Bob' to JSON: invalid JSON syntax`. The storage layer coerces
every row unconditionally on its own (`MemoryTableManager.performInsert`,
`StoreTable.coerceRow`), so a pre-coerced row reaching it is coerced twice and
blows up. `collation-key-normalizer.spec.ts` catches this immediately. The same
hazard is already documented at `packages/quereus-isolation/src/isolated-table.ts`
(~line 1120), which deliberately does not thread its coerced row into the overlay
write for exactly this reason.

So the invariant this fix relies on is: **the raw row keeps flowing downstream;
only constraint evaluation gets a coerced copy.**

## Behavior that must not regress

- A supplied collation still wins for two JSON string scalars — `NOCASE` keeps
  matching `'"Bob"'` and `'"BOB"'` (`collation-soundness.spec.ts`,
  `collation-key-normalizer.spec.ts`).
- The collation-less string-vs-string comparison stays code-point order, so it
  keeps agreeing with the store's structural key bytes
  (`packages/quereus-store/src/common/json-key.ts`).
- A JSON string scalar still round-trips: `insert ... '"Bob"'` then `select`
  returns `Bob`.

## Known, deliberately out of scope

`insert ... returning j` still reports the **raw, uncoerced** value (`typeof(j)`
is `text`, not `json`), and row-time materialized-view maintenance writes the raw
value into the MV backing — so an incrementally-maintained MV over a `json`
column diverges from the same MV rebuilt from the base table. Both come from the
same cause (the DML executor's `flatRow` / `newRow` are raw) and are tracked
separately as `bug-dml-downstream-uses-uncoerced-row`, because fixing them means
resolving the `JSON_TYPE.parse` non-idempotency described above. Do not try to
fold it in here.

## TODO

- Add a `.sqllogic` regression case for the immediate-CHECK comparison. Cover:
  two `json` columns compared with `<` in a `check`, an equivalent `check` that
  should still fail, and a `check` on a `json` column that holds a string scalar
  (`'"Bob"'`) so the collation path is exercised at insert time. Nearest existing
  home is `packages/quereus/test/logic/06.9-json-canonical-key.sqllogic`; add a
  new numbered file if that one is thematically wrong.
- Add unit coverage for `JSON_TYPE.compare` mixed-type pairs directly (there is
  no spec for it today): `compare('9', 9)` and `compare(9, '9')` must be `1` and
  `-1`, `compare(true, 1)` must rank boolean before number, and two string
  scalars must honour a supplied collation. `packages/quereus/test/type-system.spec.ts`
  is the natural home.
- Add a case proving the deferred and immediate paths now agree: the same
  comparison as an `initially deferred` check must reach the same verdict as the
  immediate one.
- Document the coercion boundary in `packages/quereus/docs/types.md`: values are
  converted to their declared logical type at the storage layer, constraint
  evaluation gets its own coerced copy, and `JSON_TYPE.parse` is not idempotent
  for string scalars so a coerced row must never be coerced again.
- Run `yarn test:store 2>&1 | tee /tmp/store.log` and confirm the constraint and
  JSON logic tests pass against the LevelDB store backend. Only `yarn test`
  (memory-backed) has been run so far.
- Sanity-check the perf `NOTE:` left at the `coerceNewSection` call site in
  `constraint-check.ts` — the coerced copy is now built for every row passing
  through a constrained table. If `packages/quereus/test/performance-sentinels.spec.ts`
  has a relevant insert sentinel, confirm it still holds.

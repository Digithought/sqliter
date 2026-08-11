---
description: When a query is prepared first and its values supplied afterwards, the engine works out what kind of value each numbered placeholder holds but then files that information under a key nobody looks up, so it is silently thrown away and the placeholder is treated as text.
prereq:
files:
  - packages/quereus/src/core/param.ts            # getParameterTypes — keys positional hints by string on the boundArgs path
  - packages/quereus/src/planner/scopes/param.ts  # ParameterScope.resolveSymbol — looks the hint up by numeric index
  - packages/quereus/src/core/statement.ts        # compile() / getAnalysisPlan() — the two callers that pass boundArgs
  - packages/quereus/test/parameter-types.spec.ts # existing coverage for parameter type inference
difficulty: easy
repro: verified
---

# Problem

`getParameterTypes(params)` turns bound parameter values into per-parameter `ScalarType`
hints for the planner. It has two branches:

- **array** (`prepare(sql, [9])` — values supplied at prepare time): keys each hint by
  `index + 1`, a **number**.
- **object** (`prepare(sql)` then `run([9])` — values bound afterwards): walks the object
  with `Object.entries`, so every key is a **string**. Positional args live in `boundArgs`
  under numeric-looking keys (`boundArgs[index + 1]`, set by `bind`/`bindAll`), so a
  positional parameter's hint comes out keyed by the string `"1"`.

`ParameterScope.resolveSymbol` looks a positional hint up by the parser's **numeric**
1-based index. `Map` keys compare by identity, so `"1"` never matches `1`: the hint misses
and the parameter falls back to `DEFAULT_PARAMETER_TYPE`, which is TEXT.

Verified directly:

```
getParameterTypes([9])      -> key 1   (number) INTEGER   // array path: usable
getParameterTypes({1: 9})   -> key "1" (string) INTEGER   // boundArgs path: same type, unusable key
```

and end to end:

```js
const s = db.prepare('select ? as v');
await s.bindAll([9]);
s.getColumnDefs()[0].type.logicalType.name;   // 'TEXT' — should be INTEGER
```

Compilation happens *after* binding (`_iterateRowsRawInternal` calls `bindAll`, then
`compile()`), so the engine genuinely does know the value's type at plan time. It computes
the right answer and then drops it.

Named parameters are unaffected — both sides key by the same string. This is exactly why
`prepare(sql, [9])` produces a different plan from `prepare(sql)` + `run([9])` for the same
SQL and the same value.

# Consequence

Two, of different weight:

1. **Embedder-facing.** `Statement.getColumnType()` / `getColumnDefs()` announce TEXT for a
   projected `?` that will yield a number. A driver or UI that switches on the announced type
   renders it under the wrong branch.
2. **Storage.** The announced TEXT is an identity match against a TEXT-declared column, which
   makes the DML write path skip its conversion and store the raw JS value. That arm is
   independently fixed by `dml-write-coercion-representation-guard`; this ticket removes one
   of the two ways to reach it.

# Fix

In `getParameterTypes`'s object branch, key a numeric-looking parameter name by its number,
matching what `ParameterScope` looks up. `ParameterScope` already normalizes the same way for
explicit `:1`-style parameters (`parseInt(nameOrIndex, 10)`, numeric when it parses), so this
brings the inference path in line with a convention the scope already applies — it is not a
new one.

Keep the `:`-prefix stripping that is already there. Be careful that a key like `"1abc"` or
`"01"` does not get silently renumbered — match the scope's own normalization exactly rather
than inventing a second rule. If the two normalizations are worth sharing, factor one helper
and call it from both sides; that is preferable to two rules that agree today.

# Risk to check

This changes plans. A statement prepared without values whose `?` was previously typed TEXT
will now be typed from the bound value, which can change comparison coercion, collation
resolution, and index-seek eligibility. The array path already behaves this way, so the new
behavior is already exercised in tree — but `prepare(sql)` + `run(params)` is the more common
call shape, so the blast radius is wider. Run the full suite (`yarn test`, `yarn test:store`)
and read any diff in plan-shape tests carefully rather than re-baselining them.

Also confirm `validateParameterTypes` still behaves: it reads `this.boundArgs[key]` with keys
taken from `parameterTypes`, and JS object indexing coerces a number key to a string, so the
lookup works either way. Pin that with a test rather than reasoning about it.

One case to check explicitly while here: the `numeric-canonical` suite's "narrows named
bigint parameters through `bindAll`" test still announces TEXT for its projected parameter
even though it uses *named* parameters, which this analysis predicts should work. Either the
statement takes a path that binds after the types are frozen, or the name normalization
differs — find out which before assuming this fix covers it.

# TODO

- [ ] Normalize numeric-looking keys to numbers in `getParameterTypes`'s object branch,
      sharing one normalization helper with `ParameterScope` if practical.
- [ ] Unit test: `getParameterTypes({1: 9})` yields a hint under the number `1`, and
      `getParameterTypes({'1abc': 9})` / `{'01': 9}` do not get renumbered.
- [ ] Engine test: `prepare('select ? as v')` + `bindAll([9])` announces INTEGER, and the
      same statement with a string, a `Uint8Array`, a boolean, and a `bigint` past 2^53
      announces the matching type.
- [ ] Engine test: `prepare('insert into t values (1, ?)')` + `run([9])` into a `text` column
      stores `'9'` (this fix alone should close it; the guard ticket closes it again from the
      other side, and both tests should pass).
- [ ] Investigate the named-parameter `bindAll` case noted above; extend the fix or file what
      you find.
- [ ] Confirm `validateParameterTypes` still rejects a physical-type mismatch on a positional
      parameter after the key change; add a test if none pins it.
- [ ] Run `yarn test`, `yarn test:store`, `yarn lint`, `yarn typecheck`.

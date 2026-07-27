description: When converting a value with CAST fails, the engine quietly keeps the original value instead, so the word "junk" can end up stored in a date column. Make a failed CAST produce NULL instead.
files:
  - packages/quereus/src/runtime/emit/cast.ts                 # emitCast + castFallback — the fix
  - packages/quereus/src/planner/nodes/scalar.ts              # CastNode.generateType (~line 704)
  - packages/quereus/src/types/logical-type.ts                # LogicalType.validate / .parse contract
  - packages/quereus/src/planner/building/expression.ts       # insertCrossTypeCoercion / wrapInCast — depends on today's behavior
  - packages/quereus/test/logic/99.1-cast-syntax-extras.sqllogic  # existing CAST edge-case tests
  - packages/quereus/test/logic/06.9.2-json-structural-equality.sqllogic  # must not regress
  - docs/types.md                                             # lines ~211 and ~412
difficulty: medium
---

# A failed CAST must not yield a value outside the target type

## Confirmed behavior (reproduced at `8ba1fff7`)

```
create table d (id integer primary key, dt date);
insert into d values (1, cast('junk' as date));
select id, dt, typeof(dt), dt > '2000-01-01' from d;
  → [{"id":1,"dt":"junk","ty":"text","cmp":true}]

insert into d values (2, 'junk');
  → Error: Type conversion failed for column 'dt': Cannot convert 'junk' to DATE
```

Same shape for every target type that falls into `castFallback`'s `default:` arm:

| expression | today | should be |
|---|---|---|
| `cast('junk' as date)` | `'junk'` | `null` |
| `cast('junk' as time)` | `'junk'` | `null` |
| `cast('junk' as timespan)` | `'junk'` | `null` |
| `cast('junk' as boolean)` | `'junk'` | `null` |
| `cast(x'0102' as json)` | the blob | `null` |
| `cast('abc' as json)` | `'abc'` | `'abc'` — **unchanged**, see below |

## The decision

Take the **NULL** option from the fix ticket: a value that cannot be converted
does not inhabit the target type, so the CAST has no result. This keeps
`castFallback`'s "lenient, never throws" property, and the existing
numeric/text/blob arms (which are load-bearing for SQLite compatibility) stay
exactly as they are — only the `default:` arm changes.

## Why the `default:` arm cannot simply `return null`

`insertCrossTypeCoercion` (`planner/building/expression.ts`) wraps the non-JSON
side of a JSON comparison in a synthetic `cast(… as json)`, and today's
pass-the-operand-through behavior is what makes `json_col = 'not json'` come
back *false* instead of an error. More subtly, a JSON column can legitimately
hold a **string scalar** — a bare JS string such as `hello` is a perfectly valid
JSON value — and `JSON_TYPE.parse('hello')` still throws, because `parse` reads
its input as JSON *source text*, not as an already-converted value. So for JSON
the operand really can be a valid member of the target type even when `parse`
rejects it.

The rule that satisfies both: **fall back to the operand only when the operand
already validates against the target type; otherwise NULL.**

```ts
default:
    // `parse` reads its input as source text, so it can reject a value that
    // already IS a valid member of the target type (a JSON string scalar).
    // Keep the operand only when the type itself vouches for it; anything
    // else does not inhabit the target type, so the cast has no result.
    return type.validate?.(value) === true ? value : null;
```

This requires threading the `LogicalType` into `castFallback` instead of just
its `name`. Verify each surviving arm still yields a value the target type
validates (`0` / `0.0` / `String(v)` / UTF-8 bytes all do).

## Nullability

`CastNode.generateType` reports `nullable: operandType.nullable`, i.e. "CAST
preserves nullability". That is already untrue today — `cast('' as integer)`
returns `null` because `INTEGER_TYPE.parse` maps the empty string to null — and
this change adds more ways for a non-null operand to produce null. Widen it:

```ts
nullable: operandType.nullable || logicalType !== operandType.logicalType,
```

A cast to the operand's own type is a no-op and keeps the operand's
nullability; any converting cast is nullable. Nothing prunes NOT NULL checks
from static nullability today (the runtime check in
`runtime/emit/constraint-check.ts` always runs), so this is a truthfulness fix
rather than a bug fix — but it is cheap and it is what makes the static type
honest for the write path.

## Reconcile the two type lookups

`CastNode.generateType` resolves the target with
`typeRegistry.getTypeOrDefault(targetType)` while `emitCast` resolves it with
`inferType(targetType)`. These disagree for any single-word type name that is
not in the registry but matches an affinity rule — `cast(5 as nvarchar)` returns
the TEXT string `'5'` at runtime while the plan advertises BLOB. (Parenthesized
spellings like `VARCHAR(10)` are *not* reachable: the parser accepts only one
identifier token after `AS` in a CAST — `parser.ts` ~line 1855 — and rejects
`cast(x as varchar(10))` outright.) Change `generateType` to use
`typeRegistry.inferType` so planner and runtime agree.

## Validation already done

All three changes above were prototyped together and `yarn test` in
`packages/quereus` passed **7338 passing / 13 pending, 0 failing**. In
particular `06.9.2-json-structural-equality.sqllogic` — which asserts
`json_col = 'not json'` is empty rather than an error, and covers JSON string
scalars — is unaffected by the validate-based rule. No plan-shape or
expected-output churn was observed. Treat this as evidence the approach is
sound, not as a substitute for re-running the suite.

One visible consequence to expect: columns in Quereus default to NOT NULL, so
`insert into d values (1, cast('junk' as date))` now fails with
`NOT NULL constraint failed: d.dt` rather than storing garbage. That is the
intended outcome — the message differs from the raw-literal path's
`Type conversion failed for column 'dt'`, which is acceptable because the two
statements genuinely fail for different reasons (a NULL was produced vs. a value
could not be converted). Nullable columns store NULL.

## Docs

- `docs/types.md` ~line 412: replace the "known case" bullet naming this ticket
  with the settled rule.
- `docs/types.md` ~line 211: the JSON paragraph says "text that is not valid
  JSON comes back unchanged". Reword to the new rule — text that is not valid
  JSON source still compares unequal, but now because the cast yields NULL,
  except for values the JSON type already accepts (string scalars).

## Out of scope

`union-branch-value-not-converted-on-write` is the same root shape (a node
advertising a logical type it does not produce) and stays a separate ticket.

## TODO

- Thread the `LogicalType` (not just its name) into `castFallback` in
  `runtime/emit/cast.ts`; change the `default:` arm to return the operand only
  when `type.validate?.(value) === true`, else `null`. Update the doc comment
  above `castFallback` to state the rule and why JSON string scalars survive it.
- Confirm the INTEGER / REAL / NUMERIC / TEXT / BLOB arms each produce a value
  their own `validate` accepts; if any does not, fix that arm rather than
  weakening the rule.
- In `CastNode.generateType` (`planner/nodes/scalar.ts`), switch
  `typeRegistry.getTypeOrDefault` → `typeRegistry.inferType` so the planner's
  target type matches the emitter's.
- In the same method, widen nullability to
  `operandType.nullable || logicalType !== operandType.logicalType`, with a
  comment noting `cast('' as integer)` and the new failure→NULL path.
- Add SQL-level coverage. Extend `test/logic/99.1-cast-syntax-extras.sqllogic`
  (or add a sibling file) with: each failing temporal cast → null; failing
  boolean cast → null; `cast(x'0102' as json)` → null; `cast('abc' as json)`
  still `'abc'`; inserting a failed temporal cast into a nullable column stores
  NULL; inserting into a NOT NULL column raises the NOT NULL error; a stored
  value from a successful cast still round-trips.
- Run `yarn test` and `yarn lint` from `packages/quereus`.
- Update `docs/types.md` at both sites listed above.

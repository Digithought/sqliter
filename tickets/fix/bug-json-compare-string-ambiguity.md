---
description: A CHECK constraint that compares two JSON columns can reject a perfectly valid row, because at that point in the insert the values are still raw text and get compared letter-by-letter instead of by their real JSON structure.
files:
  - packages/quereus/src/types/json-type.ts                       # JSON_TYPE.compare — the ambiguous string branch
  - packages/quereus/src/runtime/emit/constraint-check.ts         # immediate CHECK evaluates the raw, uncoerced NEW row (see ~:403-414)
  - packages/quereus/src/types/validation.ts                      # coerceRowToSchema — what every other caller runs first
  - packages/quereus/src/runtime/emit/binary.ts                   # runSemanticTypedCompare — the compare entry point CHECK reaches
difficulty: medium
---

# JSON comparison cannot tell a text-encoded object from a plain string value

## The problem in plain terms

A column declared `json` holds a JSON value. Two such values are supposed to be
ordered *structurally* — by what the JSON means, not by how it is spelled. So
`{"a":2}` sorts before `{"a":10}`, because 2 is less than 10.

That works everywhere the engine has already converted the stored text into a real
JSON value. It does **not** work inside an immediate `check (...)` constraint, because
the insert pipeline runs CHECK constraints against the row *before* conversion — the
values are still the raw text the user typed. Comparing two pieces of raw text falls
back to alphabetical order, so `{"a":10}` sorts before `{"a":2}` (`1` before `2`), and
a constraint that should pass fails.

Reproduces on the current tree:

```sql
create table c (id integer primary key, a json, b json, check (a < b));
insert into c values (1, '{"a":2}', '{"a":10}');
-- ConstraintError: CHECK constraint failed: _check_0 (a < b)
```

The same comparison after the row is stored is correct:

```sql
create table t (id integer primary key, a json, b json);
insert into t values (1, '{"a":2}', '{"a":10}');
select (a < b) from t;   -- 1 (true), as it should be
```

This predates the `bug-json-pk-equality-drops-collation` fix; that fix did not change
this path (the CHECK path always supplies a collation, and both the old and new code
compare as text when one is given).

## The root cause, and why it is one problem and not two

`JSON_TYPE.compare` receives JavaScript strings from two unrelated sources and cannot
distinguish them:

- a **JSON string scalar** — the value of a `json` column holding `'"hello"'` arrives
  as the plain JS string `hello`;
- **serialized JSON text** — an unconverted `'{"a":2}'` straight from the SQL literal.

Today the function guesses: two strings are treated as scalars (compared as text), and
a string paired with a non-string is re-parsed as JSON. Both guesses are wrong in some
case:

1. Two serialized objects compare alphabetically instead of structurally — the CHECK
   bug above.
2. A string scalar paired with a native value is re-parsed, so
   `JSON_TYPE.compare('9', 9)` returns `0` — it claims the JSON string `"9"` and the
   JSON number `9` are the same value, when the type's own ordering ranks numbers
   before strings. No end-to-end failure was found for this second case (both the
   memory and store backends address rows through structural key bytes, not through
   this comparator, so PK identity and `order by` both stay correct), but the
   comparator is plainly wrong in isolation and would bite the first caller that
   relies on it for mixed-type values.

Fixing them separately would pull in opposite directions, which is why they belong in
one ticket: the only durable answer is to remove the ambiguity at the source rather
than guess better inside `compare`.

## Expected behavior

- A `check` constraint comparing two `json` columns must produce the same answer as
  the equivalent comparison after the row is stored — structural order in both cases.
- `JSON_TYPE.compare` must be able to trust that a JS string it receives is a JSON
  string scalar, so it never re-parses; the re-parse fallback for mixed pairs then
  disappears and case 2 above closes with it.
- Existing behavior that must not regress: a supplied collation still wins for two
  string scalars (`NOCASE` must keep matching `'Bob'` and `'bob'` — see
  `packages/quereus/test/planner/collation-soundness.spec.ts`), and the collation-less
  string-vs-string comparison must stay code-point order so it keeps agreeing with the
  store's structural key bytes (`packages/quereus-store/src/common/json-key.ts`).

## Notes for whoever picks this up

- The natural shape is to convert the NEW row's declared-type values before immediate
  CHECK evaluation, the way the deferred snapshot already does via `coerceNewSection`
  (`constraint-check.ts`), rather than to add more type-sniffing inside `compare`.
  Confirm whether that coercion is cheap enough to run on every insert, and whether
  any constraint currently depends on seeing the raw value.
- `RETURNING` also emits pre-coercion values (`insert ... returning j` reports the
  column as `text`, holding the raw string). Worth checking whether that is intended
  before changing where coercion happens, since a shared fix could move it too.
- `LogicalType.serialize` / `deserialize` are currently never called anywhere in the
  monorepo; only `parse` is. Do not assume a deserialize hook runs on read.

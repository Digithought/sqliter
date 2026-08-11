description: Fixed a bug where the engine correctly figured out what type a `?` placeholder's value was, then filed that answer under a key nobody looked up — so the placeholder was silently treated as generic text instead.
files:
  - packages/quereus/src/core/param.ts            # getParameterTypes + new normalizeParamKey helper
  - packages/quereus/src/planner/scopes/param.ts  # ParameterScope.resolveSymbol now calls the shared helper
  - packages/quereus/test/parameter-types.spec.ts # new coverage (see below)
---

# What was wrong

`getParameterTypes(params)` builds per-parameter type hints for the planner. When
called with an **array** (`db.prepare(sql, [9])`), it keyed each hint by a **number**
(`index + 1`). When called with an **object** — which is what `Statement.boundArgs`
always is, including for positional params bound after prepare via `bind()`/`bindAll()`
(`boundArgs[index + 1]`) — it keyed every hint by a **string** (`Object.entries`).

`ParameterScope.resolveSymbol` looks up positional `?` hints by the parser's numeric
1-based index. A `Map` compares keys by identity, so the string `"1"` never matched the
number `1`: the hint silently missed and the parameter fell back to the default type
(TEXT). This only affected the "prepare first, bind values later" call shape —
`db.prepare(sql, [9])` (values supplied at prepare time) was already correct, since that
path calls `getParameterTypes` on the original array, not on `boundArgs`.

Concretely, before the fix:

```js
const s = db.prepare('select ? as v');
s.bindAll([9]);
s.getColumnDefs()[0].type.logicalType.name; // 'TEXT' — wrong, should be 'INTEGER'
```

# What changed

- `getParameterTypes`'s object branch now normalizes a numeric-looking key to a number
  before storing the hint, via a new exported helper `normalizeParamKey(name)` in
  `core/param.ts`.
- `normalizeParamKey` only converts the **canonical** decimal form of a non-negative
  integer (`/^(0|[1-9]\d*)$/` — "0", "1", "42", ...). A numeric-looking but
  non-canonical string (`"01"`, `"1abc"`) is left as a string, so it can't be silently
  reassigned to an unrelated positional slot.
- `ParameterScope.resolveSymbol`'s `:`-prefixed branch previously normalized with a raw
  `parseInt(nameOrIndex, 10)`, which is lenient (`parseInt("1abc", 10) === 1`) and would
  have disagreed with the new helper on those edge cases. Replaced it with a call to the
  same shared `normalizeParamKey`, so there is exactly one normalization rule instead of
  two that happened to agree only for the common case. This is a behavior change for the
  (untested, unused-in-tree) edge case of an explicit `:1abc`-style named parameter,
  which previously aliased to positional slot 1 and now does not — this brings it in
  line with the documented/intended convention rather than away from it.
- No change to `core/statement.ts`: both call sites that build `parameterTypes` from
  `boundArgs` (`compile()`, `getAnalysisPlan()`) go through `getParameterTypes` and pick
  up the fix automatically.

# Investigated per the ticket's open question

The ticket flagged the `numeric-canonical` suite's "narrows named bigint parameters
through bindAll" test (`select :p as v` + `bindAll({ p: 7n })`) as a case that, by the
bug's own logic, should *also* have announced TEXT despite using a named parameter —
and asked to find out why it didn't before assuming this fix covers it.

Verified directly (see the new "announces INTEGER for a named parameter bound via
bindAll" test): it already worked, both before and after this fix. Reason: for a
*named* parameter the object-branch key and the ParameterScope lookup key are **both
strings** (`"p"` on each side) — the type/number mismatch that broke positional params
never applied here. That test's silence on the announced type was fine; nothing to fix
on that path.

# Use cases for testing / validation

- `getParameterTypes({1: 9})` yields a hint keyed by the **number** `1`, matching
  `getParameterTypes([9])`.
- `getParameterTypes({'1abc': 9})` and `getParameterTypes({'01': 9})` keep **string**
  keys (`'1abc'`, `'01'`) — not renumbered.
- `db.prepare('select ? as v')` + `bindAll([9])` announces `INTEGER` (previously
  `TEXT`), matching `db.prepare('select ? as v', [9])`.
- Same statement bound (via `bindAll`) to a string, a `Uint8Array`, a boolean, and a
  `bigint` past `2^53` each announce the matching logical type (`TEXT`, `BLOB`,
  `BOOLEAN`, `INTEGER`).
- `validateParameterTypes` still rejects a physical-type mismatch on a positional
  parameter after the key-normalization change (`stmt.compile()` to freeze types from
  an initial `INTEGER` bind, then `stmt.get([3.14])` throws "Parameter type mismatch").
- Storage-side consequence (an announced-TEXT positional `?` skipping the DML write
  conversion and storing the raw value) is already independently covered end-to-end by
  `test/dml-write-representation.spec.ts` (ticket
  `dml-write-coercion-representation-guard`, landed just before this one) — those tests
  already pass regardless of this fix, since that guard checks the runtime value rather
  than the (previously-wrong) announced type. This ticket closes the second, independent
  way the wrong-TEXT-announcement could have reached storage.

All new coverage lives in `packages/quereus/test/parameter-types.spec.ts`, in two new
`describe` blocks: `getParameterTypes key normalization` and `Positional parameters
bound after prepare (bind/bindAll)`.

# Verification run

- `yarn test` (from `packages/quereus`): 9453 passing, 0 failing.
- `yarn test:store`: 9445 passing, 0 failing (a few pre-existing "TransactionCoordinator
  ... out of range" console warnings from unrelated savepoint tests, not failures).
- `yarn lint` (root): clean.
- `yarn typecheck` (root): clean.

# Known gaps / things the reviewer should double check

- **Plan-shape blast radius**: the ticket's own risk note applies — a statement
  prepared without initial values, then run with `bindAll`/`bind`, now types its
  positional `?`s from the bound value instead of defaulting to TEXT. This can change
  comparison coercion, collation resolution, and index-seek eligibility for that (very
  common) call shape. The full suite is green, so nothing broke in tree, but this is a
  real behavior change for any *external* code relying on the old (buggy) TEXT default
  for an unbound-at-prepare positional parameter.
- **`:1abc`-style named parameters**: no test existed for this before or after (grepped
  the test suite; nothing exercises a digit-leading named parameter). The behavior
  changed as a side effect of sharing one normalization helper (see above) but is
  untested in either direction — flagging in case a reviewer wants a pinning test one
  way or the other.
- I did not add a test asserting `getParameterTypes({ '1abc': 9 })` against a live SQL
  statement using a parameter literally named `:1abc` — only the unit-level
  `getParameterTypes`/`normalizeParamKey` behavior and the `ParameterScope` code path
  are covered separately; nothing wires them together end-to-end for this specific
  digit-leading-name shape.

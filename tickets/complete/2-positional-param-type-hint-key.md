description: Fixed a bug where the engine correctly figured out what type a `?` placeholder's value was, then filed that answer under a key nobody looked up — so the placeholder was silently treated as generic text instead.
files:
  - packages/quereus/src/core/param.ts            # getParameterTypes + normalizeParamKey helper
  - packages/quereus/src/planner/scopes/param.ts  # ParameterScope.resolveSymbol uses the shared helper
  - packages/quereus/src/core/statement.ts        # NOTE on first-compile type freeze
  - packages/quereus/test/parameter-types.spec.ts # coverage
  - docs/sql.md, docs/usage.md                    # `:N` slot convention, type-freeze behavior
---

# What was wrong

`getParameterTypes(params)` builds per-parameter type hints for the planner. Given an
**array** (`db.prepare(sql, [9])`) it keyed each hint by a **number** (`index + 1`).
Given an **object** — which is what `Statement.boundArgs` always is, including for
positional params bound after prepare via `bind()`/`bindAll()` — it keyed every hint by
a **string** (`Object.entries`).

`ParameterScope.resolveSymbol` looks up positional `?` hints by the parser's numeric
1-based index. A `Map` compares keys by identity, so string `"1"` never matched number
`1`: the hint silently missed and the parameter fell back to the default type (TEXT).
Only the "prepare first, bind values later" call shape was affected;
`db.prepare(sql, [9])` was already correct.

# What shipped

- `getParameterTypes`'s object branch normalizes a numeric-looking key to a number via a
  new exported helper `normalizeParamKey(name)` in `core/param.ts`.
- `ParameterScope.resolveSymbol`'s `:`-prefixed branch calls the same helper instead of a
  raw `parseInt`, so there is exactly one normalization rule rather than two that agreed
  only for the common case.
- `normalizeParamKey` treats an **all-digit** name as a positional index (`"1"`, `"01"`,
  `"007"`), and leaves anything else — including a name that merely starts with digits
  (`"1abc"`) — as a string. Indices past 2^53 stay strings so two distinct names cannot
  collapse onto one key.
- No change needed in `core/statement.ts`'s hint construction: both sites that build
  `parameterTypes` from `boundArgs` go through `getParameterTypes`.

# Review findings

## Fixed in this pass

- **`:01` / `:007` named-index parameters stopped resolving** (`packages/quereus/src/core/param.ts`).
  The implement commit's `normalizeParamKey` accepted only the *canonical* decimal form
  (`/^(0|[1-9]\d*)$/`), so a leading-zero index became a string key. `ParameterScope` now
  shares that helper, so `select :01 as v` bound positionally resolved to key `"01"`
  instead of slot 1, and the runtime lookup threw. Verified against the shipped
  implement commit: `db.get('select :01 as v', [9])` → `Parameter with name '01' not
  found.`; the pre-fix `parseInt("01", 10) === 1` path returned `{ v: 9 }`. Root cause is
  the regex, not the sharing — the sharing is what made the tightening reachable
  end-to-end. Rule relaxed to all-digits (`/^\d+$/`), matching the `?NNN`-style
  convention where `:007` names slot 7; `"1abc"` still stays a string, which is the part
  of the tightening that was actually wanted. Pinned by three new end-to-end tests under
  `` `:N` named-index parameters ``.
- **Digit strings past 2^53 collided** (same site). `Number("9007199254740993")` and
  `Number("9007199254740994")` are the same double, so two distinct parameter names would
  have shared one hint slot. Guarded with `Number.isSafeInteger`; such names stay strings.
  Contrived, but the guard is one clause and the failure would have been a silent
  wrong-value.
- **Test gaps.** Added coverage the implement pass left open: the single-key `bind(1, v)`
  path (only `bindAll` was covered), several positional slots typed independently in one
  statement, and a `:`-prefixed key in the bound object (`{ ':p': 9 }`).
- **Docs were stale.** `docs/sql.md` listed parameter binding as `?`, `:name`, `$name`
  with no mention that an all-digit name is a positional slot — the exact convention this
  ticket now depends on. Added. `docs/usage.md` said nothing about where parameter types
  come from or when they freeze; added a paragraph under `bindAll`.

## Recorded as a tripwire (not a ticket)

- **Parameter types freeze at the first compile, and an unbound compile freezes them
  empty.** `Statement.compile()` establishes `parameterTypes` once; with no bound args
  `getParameterTypes({})` returns an empty-but-established map, so a statement introspected
  before binding (`getColumnDefs()` / `isQuery()` on a fresh `prepare`) keeps every
  parameter at TEXT forever, while binding first types them from the values. Measured:
  `prepare('select ? as v')` → `getColumnDefs()` → `bindAll([9])` → `getColumnDefs()`
  still reports TEXT; the reverse order reports INTEGER. Not a regression — that shape
  reported TEXT before this ticket too — and the execution paths all bind before
  compiling, so it only shows through pre-bind introspection. It is also deliberate:
  re-inferring per bind would recompile on every execution and defeat
  `validateParameterTypes`' frozen-type check. Parked as a `NOTE:` at
  `packages/quereus/src/core/statement.ts` (the `if (this.parameterTypes === undefined)`
  site in `compile()`) with its revisit condition, plus the user-facing half in
  `docs/usage.md`.

## Checked, no defect found

- **Runtime value lookup** (`runtime/emit/parameter.ts`). A numeric identifier does
  `key in params` / `params[key]` against `boundArgs`, whose numeric keys are JS object
  keys — the number/string coercion is the language's, so numeric normalization cannot
  desync hint key from value key. Same for `validateParameterTypes`' `this.boundArgs[key]`.
- **The implement handoff's flagged `:1abc` gap is moot.** The parser accepts only an
  `IDENTIFIER` or `INTEGER` token after `:`/`$` and takes that single token's lexeme as
  the name, so `:1abc` lexes as `:1` followed by a separate `abc` token — a digit-leading
  *mixed* parameter name is unreachable through SQL. `normalizeParamKey('1abc')` is still
  pinned at the unit level for the object-key path, where a caller can produce it.
- **Layering.** `planner/scopes/param.ts` importing `core/param.js` follows existing
  precedent (`planner/optimizer.ts` and `planner/framework/context.ts` both import
  `core/database.js`), and `core/param.ts` depends only on `common/`, so no cycle.
- **Plan/statement caching.** Nothing keys a cached plan on the hint map's key *type*;
  the FK probe cache passes an explicit empty `Map` and is unaffected by this branch.
- **`getParameterTypes({})` and `prepare(sql, new Map())` semantics** are untouched by the
  normalization change — the array branch and the explicit-Map branch never enter it.

## Verification

- `yarn test` (from `packages/quereus`): 9461 passing, 0 failing, 25 pending.
- `yarn lint` (root): clean.
- `yarn typecheck` (root): clean.
- `yarn test:store` not re-run this pass — the implement pass ran it green (9445 passing)
  and this pass's delta is confined to parameter-key normalization plus tests and docs,
  none of which touches the storage path.

## Residual risk (unchanged from the implement handoff, restated)

A statement prepared without initial values and then run via `bind`/`bindAll` now types
its positional `?`s from the bound value instead of defaulting to TEXT. That can change
comparison coercion, collation resolution, and index-seek eligibility for a very common
call shape. The full suite is green, but external code that relied on the old TEXT
default will see different plans.

description: Naming a column or table with a short alias that omits the word "as" used to fail to parse whenever anything else followed it in a comma-separated list; the fix has landed and needs a review pass.
files: packages/quereus/src/parser/parser.ts, packages/quereus/test/parser.spec.ts, packages/quereus/test/logic/01.1-select-projection-extras.sqllogic
difficulty: easy
---

# Bare (no-`as`) alias rejected when a comma follows it — fix landed

Implements the analysis from the superseded `implement/bug-bare-alias-before-comma-rejected`
ticket (which itself superseded `fix/bug-window-fn-breaks-earlier-column-alias-parse` —
window functions were a red herring; the real trigger is any bare alias not in
the last position of a comma-separated list).

## Root cause (confirmed, fixed)

Four alias-detection sites in `packages/quereus/src/parser/parser.ts` shared a
copy-pasted lookahead guard `!this.checkNext(1, TokenType.COMMA)` that rejected
treating an identifier as a bare alias whenever a comma immediately followed
it. Since `checkNext(1, ...)` looks one token past the *candidate alias*
itself, that guard meant "reject this alias if a comma follows it" — exactly
the shape of the legal `expr alias, …` construct. Rejecting the alias left the
parser cursor parked on the alias token (not the comma), which broke the
enclosing `do … while (this.match(COMMA))` loop and surfaced as a misleading
top-level parse error pointing at the alias token:

```
Expected statement type (SELECT, INSERT, UPDATE, DELETE, VALUES, CREATE, etc.), got 'kk'.
```

## What changed

Deleted the `!this.checkNext(1, TokenType.COMMA) &&` line at all four sites
(left every other guard — `DOT`, `LPAREN`, `isJoinToken()`, `isEndOfClause()`
— untouched):

- `columnList()` (SELECT result column, was line 910)
- `subquerySource()` (`(select …) x`, was line 1034)
- `standardTableSource()` (`from t x`, was line 1125)
- `functionSource()` (`from f(1) x`, was line 1185)

A comma after a bare alias never means anything except "end of this list
item," so the guard had no legitimate case to protect — no other logic needed
to change.

## Test coverage added

`packages/quereus/test/parser.spec.ts`, in the `Statement Parsing` describe
block next to the existing `'should parse SELECT with alias'` case:

- bare alias immediately followed by another select item (`select 1 a, 2 b, 3 c`)
- bare alias mixed with an explicit `as` alias in the same list
- bare alias immediately before a window function column
  (`select o.k kk, row_number() over () rn from o`)
- bare table alias in a comma-separated FROM list (`from t a, u b`)
- bare subquery alias in a comma-separated FROM list
  (`from (select 1) x, (select 2) y`)
- negative case: `select a, b from t` — confirms both columns still parse
  with `alias === undefined` (guards against a regression where the guard
  removal starts swallowing a plain column reference as an alias)

`packages/quereus/test/logic/01.1-select-projection-extras.sqllogic` — added
an end-to-end section (`create table b1 ...`) exercising a query with two
bare-aliased, non-last-position columns, and a second query pairing a bare
alias with a window function column, verifying both parse *and* execute to
the expected row shape.

## Validation performed

- `yarn test:single packages/quereus/test/parser.spec.ts` — 103 passing,
  including all 6 new cases.
- `yarn test:single packages/quereus/test/logic.spec.ts --grep "01.1-select-projection-extras"` —
  1 passing (the new sqllogic section runs inside the existing file's single
  test entry).
- Full `yarn test` from repo root — every workspace green, 0 failures.
  `packages/quereus` moved from the ticket's stated baseline of 7329 passing
  to 7335 (the 6 new parser-spec cases; the sqllogic addition is covered
  inside an existing file-level test entry, not a new count).
- `yarn lint` from repo root — clean across all workspaces (quereus's real
  lint is eslint + `tsc -p tsconfig.test.json --noEmit`; no errors or
  warnings).

## Gaps / things the reviewer should know

- Fix is a pure deletion at 4 call sites — no other alias-parsing logic was
  touched, and no new guard was added in its place. If the reviewer wants to
  double check there isn't a fifth copy-pasted site elsewhere in the parser,
  a grep for `checkNext(1, TokenType.COMMA)` in `parser.ts` should now return
  zero hits (confirmed clean as of this writing).
- No CHANGELOG/docs mention bare-alias parsing specifically, so nothing else
  needed updating.
- Did not add a test for a bare alias directly followed by a comma at the
  very end of a deeply nested expression (e.g. inside a subquery's own
  projection list) — the four call-site tests plus the sqllogic end-to-end
  case were judged sufficient coverage for a 4-line, single-guard deletion;
  flagging in case the reviewer wants an extra nested case.

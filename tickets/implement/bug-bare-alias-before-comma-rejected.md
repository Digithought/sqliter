---
description: Naming a column or table with a short alias that omits the word "as" fails to parse whenever anything else follows it in a comma-separated list; the fix is small and already validated.
files: packages/quereus/src/parser/parser.ts, packages/quereus/test/parser.spec.ts, packages/quereus/test/logic/01.1-select-projection-extras.sqllogic
difficulty: easy
---

# Bare (no-`as`) alias rejected when a comma follows it

Supersedes `fix/bug-window-fn-breaks-earlier-column-alias-parse`. That ticket
blamed window functions; window functions are irrelevant. The real trigger is
narrower and much broader in reach: **any alias written without `as` fails when
the aliased item is not the last entry of its comma-separated list.**

## Confirmed behavior (parser only, no planning involved)

Reproduced directly against `new Parser().parse(sql)`:

```
FAIL  select o.k kk, o.j jj from o
FAIL  select o.k kk, o.j from o
FAIL  select count(*) cnt, o.k kk from o group by o.k
FAIL  select 1 a, 2 b, 3 c
FAIL  select 1 from t a, u b                       -- table alias, same bug
FAIL  select 1 from (select 1) x, (select 2) y     -- subquery alias, same bug
OK    select o.k kk from o                         -- last in list → fine
OK    select o.k, o.j jj from o                    -- last in list → fine
OK    select o.k as kk, o.j jj from o              -- explicit `as` → fine
```

All failures produce the same misleading message, pointing at the alias token
as if it began a new statement:

```
Expected statement type (SELECT, INSERT, UPDATE, DELETE, VALUES, CREATE, etc.), got 'kk'.
```

Note the fix-stage ticket claimed `select count(*) cnt, o.k kk from o group by o.k`
succeeded — it does not. Trust the list above.

## Root cause

Four alias-detection sites in `packages/quereus/src/parser/parser.ts` share a
copy-pasted lookahead guard that refuses to treat an identifier as an alias when
the *next* token is a comma:

| line | site |
| --- | --- |
| 910 | `columnList()` — SELECT result column |
| 1034 | `subquerySource()` — `(select …) x` |
| 1125 | `standardTableSource()` — `from t x` |
| 1185 | `functionSource()` — `from f(1) x` |

Each reads:

```ts
} else if (this.checkIdentifierLike([]) &&
	!this.checkNext(1, TokenType.DOT) &&
	!this.checkNext(1, TokenType.COMMA) &&   // <-- the bug
	!this.isJoinToken() &&
	!this.isEndOfClause()) {
```

`checkNext(n, type)` inspects `tokens[current + n]`, and `current` is the
candidate alias itself — so `!checkNext(1, COMMA)` means "reject this alias if a
comma follows it", which is exactly the legal `expr alias, …` shape. When the
alias is rejected, the enclosing `do … while (this.match(COMMA))` loop stops
(the cursor is parked on the alias, not on the comma), the SELECT parser gives
up, and the statement dispatcher reports the alias token as a bad statement
start.

A comma after a bare alias never means anything other than "end of this list
item", so the guard has no legitimate case to protect. Dropping it is the whole
fix.

## Validation already performed

The 4-line deletion was prototyped locally: every repro above parses correctly
(aliases land where expected, non-alias cases such as `select a, b from t` stay
alias-free), and the full `yarn test` run was green — 7329 passing in
`packages/quereus` plus all other workspaces, 0 failures. The prototype was then
reverted, so the working tree is clean; re-apply it as below.

Beware line endings: `parser.ts` is CRLF. Edit it with the Edit tool, not with
`sed -i` (which rewrites the whole file as LF).

## TODO

- Delete the `!this.checkNext(1, TokenType.COMMA) &&` line at all four sites in
  `packages/quereus/src/parser/parser.ts` (lines 910, 1034, 1125, 1185). Leave
  the surrounding `DOT` / `LPAREN` / `isJoinToken` / `isEndOfClause` guards alone.
- Add parser unit coverage in `packages/quereus/test/parser.spec.ts` next to the
  existing `'should parse SELECT with alias'` case (~line 254): bare alias
  followed by another select item, bare alias mixed with `as` alias, bare alias
  before a window function, bare table alias in a comma-separated FROM list, and
  a bare subquery alias in a comma-separated FROM list. Assert the parsed alias
  values, and keep a negative case (`select a, b from t` → both aliases
  undefined) so the guard removal can't silently swallow a column as an alias.
- Add an executable case to `packages/quereus/test/logic/01.1-select-projection-extras.sqllogic`
  (or a sibling logic file) that runs a query using bare aliases in a multi-column
  select list — including one alongside a window function — so the fix is covered
  end-to-end, not just at parse time.
- Run `yarn test` and `yarn lint` from the repo root.

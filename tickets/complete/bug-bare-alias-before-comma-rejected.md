description: Naming a column or table with a short alias that omits the word "as" used to fail whenever anything else followed it in a comma-separated list; fixed, reviewed, and covered by tests.
files: packages/quereus/src/parser/parser.ts, packages/quereus/test/parser.spec.ts, packages/quereus/test/logic/01.1-select-projection-extras.sqllogic, docs/sql-select.md
---

# Bare (no-`as`) alias rejected when a comma follows it — done

## What was wrong

Four alias-detection sites in `packages/quereus/src/parser/parser.ts` shared a
copy-pasted lookahead guard `!this.checkNext(1, TokenType.COMMA)`. Because
`checkNext(1, …)` looks one token past the *candidate alias*, the guard meant
"reject this alias if a comma follows it" — i.e. it rejected the perfectly legal
`expr alias, …` shape. Rejecting left the cursor parked on the alias token, so the
enclosing `do … while (this.match(COMMA))` loop broke and the user saw a
misleading top-level error pointing at the alias.

## What shipped (implement stage)

Deleted the guard at all four sites — `columnList()`, `subquerySource()`,
`standardTableSource()`, `functionSource()` — leaving the `DOT` / `LPAREN` /
`isJoinToken()` / `isEndOfClause()` guards untouched. A comma after a bare alias
never means anything but "end of this list item", so the guard protected no real
case. Plus 6 parser-spec cases and an end-to-end sqllogic section.

## Review findings

**Checked:** the 4-site diff read cold before the handoff; every remaining
alias-parse path in `parser.ts` (grep for further `alias` assignments — no fifth
copy-pasted site exists, and `checkNext(1, TokenType.COMMA)` now returns zero
hits repo-wide); whether the deletion can *over*-accept (it only widens
acceptance in the comma case, and `checkIdentifierLike([])` still restricts bare
aliases to plain identifier tokens, so `select a, b from t` is unaffected —
covered by the implementer's negative test); doc accuracy for the FROM grammar;
lint + full test suite.

**Minor — fixed in this pass:**

- *DRY.* Three of the four sites (`subquerySource`, `standardTableSource`,
  `functionSource`) still carried byte-identical copies of the bare-alias guard —
  the exact copy-paste shape that bred this bug. Extracted
  `Parser.matchBareSourceAlias()` (next to `isJoinToken`), which consumes and
  returns the alias token or `undefined`. `columnList()` keeps its own guard: its
  conditions genuinely differ (rejects `LPAREN`, has no join check), so folding it
  in would have needed a flag parameter and read worse.
- *Test coverage.* Added three cases to `packages/quereus/test/parser.spec.ts`:
  bare table-function aliases in a comma-separated FROM list (`from f(1) x, g(2) y`
  — `functionSource` was the one changed site with no direct test), bare aliases
  inside a nested subquery's own projection list (the gap the implementer flagged),
  and a guard that a `join` keyword is still not swallowed as a bare table alias
  (protects the refactor's `isJoinToken()` branch).
- *Docs.* `docs/sql-select.md` FROM-clause grammar showed `table_name [as alias]`
  and `(select_statement) as alias`, implying `as` is required and (for subqueries)
  the alias mandatory. Neither is true. Corrected to `[[as] alias]` on all four
  `table_reference` productions. The projection grammar at line 105 already read
  `[ [as] alias ]` and needed no change.

**Major — none.** No finding warranted a new ticket: the change is a pure guard
deletion with no behavioral reach beyond alias acceptance, and no downstream
planner/emit code inspects alias provenance.

**Tripwire — one, parked as a code comment.** `isEndOfClause()` doubles as the
stop set for bare aliases, so a future clause keyword that lexes as a plain
identifier would be silently eaten as an alias. Not a defect today (every current
clause keyword has its own `TokenType`), so it is recorded as a `NOTE:` comment
directly above `isEndOfClause()` rather than filed as work.

## Validation

- `yarn workspace @quereus/quereus run test:single packages/quereus/test/parser.spec.ts`
  — 106 passing (the implement stage left this file at 103; the 3 review-stage
  cases bring it to 106).
- `yarn test` from repo root — all workspaces green, 0 failures.
- `yarn lint` from repo root and `yarn workspace @quereus/quereus run lint`
  (eslint + `tsc -p tsconfig.test.json --noEmit`) — clean, exit 0.

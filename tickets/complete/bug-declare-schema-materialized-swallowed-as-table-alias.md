----
description: A schema declaration that asked for a materialized view could silently produce an ordinary view, because the word "materialized" was mistaken for a nickname belonging to the previous line's query. The parser now refuses to treat a declaration keyword as a nickname in that spot.
prereq:
files:
  - packages/quereus/src/parser/parser.ts (`aliasBarriers` / `withAliasBarrier` / `atAliasBarrier` ~68, ~2331-2358; consulted at `matchBareSourceAlias` ~2318 and the implicit-alias branch of `columnList` ~931; `DECLARE_ITEM_KEYWORDS` / `LENS_OVERRIDE_KEYWORDS` ~39-53; `declareBlockItem` / `declareIgnoredItem` / `skipToDeclareItemBoundary` / `atDeclareItemStart` ~3639-3728; lens override wrap ~3747)
  - packages/quereus/test/declare-schema-item-boundary.spec.ts (30 cases)
  - packages/quereus/test/schema-differ.spec.ts (duplicate-MV regression + stale workaround comment removed)
  - docs/sql-ddl.md (§ Declaration Syntax → "Item keywords and bare aliases")
difficulty: medium
----

## What was wrong

Items inside `declare schema <name> { … }` need no separator. A query-bodied item
(`view`, `materialized view`, `table … maintained as <query>`) is parsed greedily
and the query grammar ends at a position where a **bare (no-`as`) alias** is legal.
`materialized` and `seed` are deliberately *not* reserved words in the lexer, so
they arrived as plain identifiers and were absorbed into that alias slot. The
remainder (`view m2 as …`) then parsed as the next thing that fit — an ordinary
view. Silent for `materialized`; for `seed` it fell into the unrecognized-item
fallback, whose stop condition tested for `}` as an identifier (it lexes as its own
token type), so the scan ran to end-of-input and reported
`Expected '}' to close schema declaration block.`

## What shipped

**A scoped bare-alias barrier in the parser.** `aliasBarriers` is a stack of
`{ words, parenDepth }` entries; `words` is an uppercase lexeme set that may not be
taken as an implicit alias, `parenDepth` is the open-paren depth the barrier was
pushed at. `withAliasBarrier(words, parse)` pushes/pops around a parse.
`atAliasBarrier()` reports whether the cursor sits on a *bare* identifier one of the
active sets reserves **at that set's own paren depth** (a quoted identifier carries a
`literal` payload and is exempt). It is consulted at exactly the two implicit-alias
decision points — `matchBareSourceAlias()` (table, subquery, and table-function
sources) and the implicit-alias branch of `columnList()`. Outside a declaration
block the stack is empty and every check short-circuits, so ordinary statements are
untouched.

The paren-depth scope matters because a sibling item can only begin at the item's
top level: inside an open `(` — a subquery source, an `exists` subquery, a scalar
subquery — a bare alias named `materialized` is unambiguous and still works.

The declare-block loop wraps each item in
`withAliasBarrier(DECLARE_ITEM_KEYWORDS, () => this.declareBlockItem())`; the
`if/else` kind dispatch moved into `declareBlockItem()`. Lens override bodies get
the same treatment with the single-word set `{VIEW}`.

**Unrecognized-item boundary.** `skipToDeclareItemBoundary()` replaces the broken
scan: it consumes the item's leading word, then advances until a depth-0 `;`, the
block's closing `}`, or the leading keyword of the next item, tracking brace/paren
depth so a nested payload doesn't end it early. A stray `;` between items is now
skipped instead of producing an empty placeholder item.

## Review findings

### Checked

- Full implement-stage diff read before the handoff summary (commit `4bdc1029`).
- Every bare-alias decision site in `parser.ts` — the three `matchBareSourceAlias()`
  call sites (table, subquery, table-function sources) and the `columnList()`
  implicit branch. Those four are the only places a bare identifier becomes an
  alias, so the barrier is consulted everywhere it needs to be.
- Lexer reality behind the fix: `materialized` is not a `TokenType` at all and
  `seed` is a `TokenType` that is *not* in the `KEYWORDS` map, so both lex as
  `IDENTIFIER` — confirming the premise. `assertion`, `table`, `view`, `index`,
  `unique` do lex to their own token types, so their entries in
  `DECLARE_ITEM_KEYWORDS` are inert today (documented as such in the code).
- Quoted-identifier exemption: double-quoted, bracketed, and backtick identifiers
  keep their delimiters in `token.lexeme`, so they can never match a barrier word
  even without the `literal !== undefined` guard. The guard is redundant but
  harmless and self-documenting — left alone.
- `skipToDeclareItemBoundary()` depth handling: an unbalanced `)` cannot drive its
  counter negative, because `advance()` already raises `Unmatched ')'` globally
  before the scan sees it. Verified by probe.
- Item kinds that are *not* query-bodied: `assertion` (`check ( … )`) and `index`
  (`… ( cols )`, optional `where <expr>`) both end on a closing paren or an
  expression, so neither has a bare-alias slot to steal from. Both now have a
  regression test anyway.
- `yarn workspace @quereus/quereus run lint` → exit 0 (eslint + `tsc -p
  tsconfig.test.json --noEmit`). `yarn test` (whole monorepo) → exit 0; quereus
  8039 passing / 13 pending, every other workspace green.
- `docs/sql-ddl.md` is the only doc that describes declaration-block item syntax;
  `docs/schema.md` and `docs/sql.md` do not restate alias rules, so nothing else
  went stale.

### Found and fixed in this pass

- **The barrier was too wide: it fired inside parentheses, turning previously valid
  SQL into a parse error.** Inside a declaration block,
  `... where exists (select 1 from t2 materialized)` did not merely lose the alias —
  the barrier suppressed it and the parser then failed with
  `Expected ')' after EXISTS subquery. … Got 'materialized'`. Same for a scalar
  subquery's column alias (`select (select 1 materialized) as z`). A sibling item
  can never begin inside an open `(`, so the restriction had no reason to reach
  there. Fixed by recording `parenStack.length` when a barrier is pushed and only
  applying it at that same depth. `parenStack` is maintained in `advance()` for
  every consumed token, so it is an exact depth counter. Three tests added and
  `docs/sql-ddl.md` now states the top-level-only scope.
- **Test coverage extended from 18 to 30 cases**, filling gaps the implementer's set
  left: bare aliases inside a subquery source / `exists` subquery / scalar subquery
  (the fix above), a materialized view following an `assertion`, an `index`, a
  `seed`, and a `union` compound body; a stray leading `;` and a doubled `;`
  producing no phantom items; an unrecognized item with a parenthesized payload and
  an unrecognized item as the block's last item; and a stringify → re-parse round
  trip of a separator-less block (the SQL writer separates items with `;`, which is
  what keeps the round trip honest — worth pinning).

### Found and filed as a ticket

- `backlog/bug-declare-schema-ignored-item-breaks-roundtrip` — **pre-existing, not
  from this diff.** A block containing an unmodeled item kind (`domain`,
  `collation`, `import`) does not survive parse → stringify → parse:
  `sourceSlice()` is a stub returning `''`, so the placeholder has no text, and the
  writer then emits `-- ignored` as a `--` line comment on a one-line block, which
  comments out the closing brace. Reproduced:
  `declare schema main { domain d1 as text  table t1 { id integer primary key } }`
  → `declare schema main { -- ignored; table t1 (id integer primary key); }` →
  `Expected '}' to close schema declaration block.` The ticket also asks whether
  `DeclareIgnoredItem.kind` (hardcoded `'domain'`, read by nothing) should be
  populated or dropped. Out of this ticket's scope — it is a writer/source-retention
  defect, unrelated to item boundaries.

### Recorded as tripwires, not tickets

- `skipToDeclareItemBoundary()` stopping on an item keyword is a heuristic: an
  unmodeled item whose body contained the word `table` would cut the skip short.
  Already carried as a `NOTE:` at the method by the implementer, with the exact
  workaround (`;`); left in place. It only trips if `domain`/`collation`/`import`
  gain real bodies, at which point they need a grammar rather than a wider scan.
- Unrecognized items are still silently dropped rather than diagnosed — `NOTE:` at
  `declareIgnoredItem`. Conditional on those kinds ever being implemented.

### Deliberately not changed

- `LENS_OVERRIDE_KEYWORDS = {VIEW}` is inert (`view` is reserved, and
  `atAliasBarrier` only inspects `IDENTIFIER` tokens). Kept: the lens override block
  has the identical separator-less shape, the entry costs nothing, and it starts
  working automatically if `view` is ever un-reserved. Same reasoning as the
  reserved entries in `DECLARE_ITEM_KEYWORDS`.
- The behavior change for anyone who wrote a *top-level* bare alias named after an
  item keyword inside a declaration block (`from t1 materialized`) stands — that is
  the ambiguity the ticket exists to resolve. `as materialized`, `"materialized"`,
  and `;` between items are all tested escape hatches.

## Validation

- `yarn workspace @quereus/quereus run lint` → exit 0.
- `yarn test` (whole monorepo) → exit 0; quereus 8039 passing / 13 pending,
  all other workspaces green.
- No pre-existing failures surfaced, so `tickets/.pre-existing-error.md` was not
  written.

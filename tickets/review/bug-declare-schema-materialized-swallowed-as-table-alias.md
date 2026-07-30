description: A schema declaration that asked for a materialized view could silently produce an ordinary view, because the word "materialized" was mistaken for a nickname belonging to the previous line's query. The parser now refuses to treat a declaration keyword as a nickname in that spot.
prereq:
files:
  - packages/quereus/src/parser/parser.ts (barrier: `aliasBarriers` / `withAliasBarrier` / `atAliasBarrier` ~68, ~2331-2352; consulted at `matchBareSourceAlias` ~2318 and the implicit-alias branch of `columnList` ~931; `DECLARE_ITEM_KEYWORDS` / `LENS_OVERRIDE_KEYWORDS` ~39-53; `declareBlockItem` / `declareIgnoredItem` / `skipToDeclareItemBoundary` / `atDeclareItemStart` ~3639-3728; lens override wrap ~3747)
  - packages/quereus/test/declare-schema-item-boundary.spec.ts (new, 18 cases)
  - packages/quereus/test/schema-differ.spec.ts (duplicate-MV regression + stale workaround comment removed)
  - docs/sql-ddl.md (§ Declaration Syntax → new "Item keywords and bare aliases")
difficulty: medium
----

## What was wrong

Items inside `declare schema <name> { … }` need no separator. A query-bodied item
(`view`, `materialized view`, `assertion`, `table … maintained as <query>`) is
parsed greedily and the query grammar ends at a position where a **bare (no-`as`)
alias** is legal. `materialized` and `seed` are deliberately *not* reserved words
in the lexer, so they arrive as plain identifiers and were absorbed into that
alias slot. The remainder (`view m2 as …`) then parsed as the next thing that fit
— an ordinary view. Silent for `materialized`; for `seed` it fell into the
unrecognized-item fallback, whose stop condition tested for `}` as an identifier
(it lexes as its own token type), so the scan ran to end-of-input and reported
`Expected '}' to close schema declaration block.`

## What changed

**A scoped bare-alias barrier in the parser.** `aliasBarriers` is a stack of
uppercase lexeme sets that may not be taken as an implicit alias.
`withAliasBarrier(words, parse)` pushes/pops around a parse; `atAliasBarrier()`
reports whether the cursor sits on a *bare* identifier one of the active sets
reserves (a quoted identifier carries a `literal` payload and is exempt). It is
consulted at exactly the two implicit-alias decision points — `matchBareSourceAlias()`
(table, subquery, and table-function sources) and the implicit-alias branch of
`columnList()`. Outside a declaration block the stack is empty and every check
short-circuits, so ordinary statements are untouched.

The declare-block loop now wraps each item in
`withAliasBarrier(DECLARE_ITEM_KEYWORDS, () => this.declareBlockItem())`; the
`if/else` kind dispatch moved into `declareBlockItem()`. Lens override bodies get
the same treatment with the single-word set `{VIEW}` — harmless today because
`view` is reserved, but the block has the identical separator-less shape.

**Unrecognized-item boundary.** `skipToDeclareItemBoundary()` replaces the broken
scan: it consumes the item's leading word, then advances until a depth-0 `;`, the
block's closing `}`, or the leading keyword of the next item, tracking
brace/paren depth so a nested payload doesn't end it early. A stray `;` between
items is now skipped instead of producing an empty placeholder item.

## Use cases to test / validate

Everything below is covered by `packages/quereus/test/declare-schema-item-boundary.spec.ts`
unless marked otherwise. The reviewer should treat these as a floor.

**Should now parse as two items (each was one view + one misparsed view before):**

```sql
declare schema main { view v1 as select id from t1
                      materialized view m2 as select id from t1 }   -- table source
declare schema main { view v1 as select 1
                      materialized view m2 as select id from t1 }   -- implicit column alias
declare schema main { view v1 as select x from (select 1 as x)
                      materialized view m2 as select id from t1 }   -- subquery source
declare schema main { view v1 as select value from generate_series(1, 3)
                      materialized view m2 as select id from t1 }   -- table-function source
declare schema main { table t2 (id integer primary key) maintained as select id from t1
                      materialized view m2 as select id from t1 }   -- maintained-as body
declare schema main { view v1 as select id from t1
                      seed t1 ( (1, 'x') ) }                        -- seed, previously a hard error
```

Tests assert both the item kinds *and* that no alias was stolen — asserting kinds
alone would pass if the alias merely moved.

**Must be unchanged (invariants):**

- With `;` between items — same parse as without.
- Escape hatches inside a block body: `from t1 as materialized` and
  `from t1 "materialized"` still alias as `materialized`.
- A column *reference* named `materialized` inside a block body still parses.
- Outside any block: `select materialized from t1`, `select a from t1 materialized`,
  `select seed from t1`, `select 1 materialized` — all unchanged.
- `declare lens for X over Y { view t1 as … view t2 as … }` still parses.

**Unrecognized items:**

```sql
declare schema main { domain d1 as text  table t1 { id integer primary key } }
```
→ two items (`declareIgnored`, `declaredTable`), block closes, no error. Same with
a braced payload inside the ignored item (`collation c1 using x { y };`).

**Differ-level (`schema-differ.spec.ts`):** two `materialized view mv` items whose
bodies end at a FROM source now report
`Materialized view 'mv' is declared more than once in schema 'main'` instead of
`'mv' is declared as both a materialized view and a view`. The pre-existing
duplicate-MV test used FROM-less bodies specifically to dodge this bug; its
workaround comment is gone and its item-kind assertion stays as a regression guard.

## Validation run

- `yarn workspace @quereus/quereus run lint` → exit 0 (eslint + `tsc -p tsconfig.test.json --noEmit`).
- `yarn test` (whole monorepo) → exit 0; quereus 8027 passing / 13 pending, all other
  workspaces green. Emit round-trip, declarative-equivalence, and lens suites all pass.

## Known gaps / things to look at

- **The barrier covers the whole item, including nested subqueries.** Inside a
  `declare schema` block, `select … from t1 materialized` no longer yields the alias
  `materialized` *anywhere* in the item, not just at the top level. That is the
  intended trade (documented in `docs/sql-ddl.md`), but it is a behavior change for
  anyone who wrote such an alias. The escape hatches (`as materialized`, quoting,
  `;`) are tested.
- **`skipToDeclareItemBoundary` stops on item keywords — a heuristic.** `domain` /
  `collation` / `import` have no grammar here, so an unmodeled item whose body
  contained the word `table` would cut the skip short. Parked as a `NOTE:` at the
  method; separating those items with `;` is exact. Judgement call: the ticket asked
  only for a depth-aware `;`/`}` stop, but that alone leaves the ticket's own
  expected case (`domain d1 as text  table t1 { … }` → *two* items) parsing as one
  swallowed item, so the keyword stop was needed to satisfy it.
- **Unrecognized items are still silently dropped** (out of scope per the ticket) —
  a typo'd item keyword is accepted and ignored rather than diagnosed. `NOTE:` added
  at `declareIgnoredItem`.
- **Pre-existing, untouched:** `declareIgnored.kind` is hardcoded `'domain'`
  regardless of the actual keyword, and `sourceSlice()` is a stub returning `''`, so
  the placeholder's `text` is always empty (`ast-stringify` emits `-- ignored`).
  Nothing consumes `kind` today.
- **Reserved item keywords ride along in `DECLARE_ITEM_KEYWORDS` as documentation
  only.** `TABLE` / `VIEW` / `INDEX` / `UNIQUE` / `ASSERTION` lex to their own token
  types, so `atAliasBarrier` (which only inspects `IDENTIFIER` tokens) never fires on
  them. If any of those is ever un-reserved, the barrier picks it up automatically.

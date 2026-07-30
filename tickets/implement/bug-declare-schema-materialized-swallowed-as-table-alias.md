description: Inside a schema declaration, asking for a materialized view can silently produce an ordinary view instead, because the word "materialized" gets mistaken for a nickname belonging to the previous line's query. Fix is to stop the parser from treating a declaration-block keyword as a nickname.
prereq:
files:
  - packages/quereus/src/parser/parser.ts (declare-block item loop ~3569-3606; `matchBareSourceAlias` ~2293-2301; `isEndOfClause` ~2317-2331; implicit column alias in `columnList` ~906-913; `declareLensStatement` ~3629-3647)
  - packages/quereus/src/parser/lexer.ts (`KEYWORDS` ~194-313 — note `materialized` / `seed` / `schema` / `version` deliberately unreserved; `CONTEXTUAL_KEYWORDS` ~323)
  - packages/quereus/src/schema/schema-differ.ts (`findDuplicateDeclaredName` ~254 — the guard the parse bug was hiding)
  - packages/quereus/test/parser.spec.ts (existing parser unit tests; new spec suggested below)
  - docs/sql-ddl.md (§ Declaration Syntax ~26-80)
difficulty: medium
----

## Root cause

Items inside `declare schema <name> { … }` need no separator: the loop at
`parser.ts:3569` parses one item, then picks the next item's kind from the
leading keyword (`peekKeyword('TABLE')`, `peekKeyword('MATERIALIZED')`, …).

`peekKeyword` matches either a dedicated `TokenType` **or** a bare `IDENTIFIER`
whose lexeme spells the word. `materialized` and `seed` have no `TokenType` —
the lexer's `KEYWORDS` table deliberately omits them (see the comment at
`lexer.ts:309`) so `select seed from t` and a column named `materialized` keep
working. So they arrive as plain `IDENTIFIER`.

An item whose body is a query (`view`, `materialized view`, `assertion`, and a
`table … maintained as <query>`) is parsed greedily, and the query grammar ends
at positions where a **bare (no-`as`) alias** is legal. Every bare-alias site
accepts any `IDENTIFIER`. So the next item's leading `materialized` / `seed` is
absorbed as the previous body's alias, and what is left (`view m2 as …`) parses
as the *next* thing that fits — an ordinary view.

Two independent stop-sets are involved, and both are reached through
`isEndOfClause()` (`parser.ts:2320`), whose own comment already names the hazard:
"Any new clause keyword that can follow a select item or table source must be
added here, or it will be swallowed as an alias — unless it lexes to its own
TokenType, which keeps it safe."

## Reproduced (against `src/`, via `register.mjs`)

Five distinct swallow sites, all confirmed except the last which shares a code
path with the second:

| Preceding body ends at | Example tail | Result |
| --- | --- | --- |
| table source (`standardTableSource`, `parser.ts:1122`) | `… as select id from t1` | alias `materialized`; next item becomes `declaredView` |
| implicit column alias (`columnList`, `parser.ts:907`) | `… as select 1` | column alias `materialized`; next item becomes `declaredView` |
| subquery source (`subquerySource`, `parser.ts:1032`) | `… from (select 1 as x)` | alias `materialized`; next item becomes `declaredView` |
| `maintained as` body (`table t2 (…) maintained as select …`) | `… from t1` | alias `materialized`; next item becomes `declaredView` |
| table-function source (`functionSource`, `parser.ts:1180`) | `… from f(…)` | same `matchBareSourceAlias` path — not separately reproduced |

Safe today: a body ending in `group by a`, `order by a`, `assertion … check (…)`,
or `join … on <expr>`; and any item list written with `;` separators (`;` is in
`isEndOfClause`). `table` / `index` / `unique` / `view` / `assertion` are reserved
so those item keywords are never swallowed.

`seed` is swallowed the same way, but fails loudly instead of silently: after the
alias grab, the loop's unrecognized-item fallback (`parser.ts:3595-3603`) runs and
its stop condition is wrong —

```ts
while (!this.isAtEnd() && !this.check(TokenType.SEMICOLON)
	&& !(this.check(TokenType.IDENTIFIER) && this.peek().lexeme === '}')) {
```

`}` lexes to `TokenType.RBRACE`, never `IDENTIFIER`, so nothing stops the scan at
the closing brace: it consumes to EOF and the block reports
`Expected '}' to close schema declaration block. Got ''.` This also fires without
any alias involvement, for a genuinely unrecognized item:

```
declare schema main { domain d1 as text  table t1 { id integer primary key } }
→ ERROR: Expected '}' to close schema declaration block.
```

## What the bug was hiding

`findDuplicateDeclaredName` (`schema-differ.ts:254`) already rejects two objects
sharing a name in the table/view/materialized-view namespace. With the parse bug,
two `materialized view mv` declarations reach it as *one MV plus one plain view*,
so the diagnostic reads `'mv' is declared as both a materialized view and a view`
instead of `Materialized view 'mv' is declared more than once in schema 'main'`.
Fixing the parse makes the correct message reachable.

## Fix: a scoped bare-alias barrier

Add a parser-level barrier — a stack of lexeme sets that may **not** be absorbed
as an implicit alias — pushed around each declaration-block item body. It is a
general mechanism (any block grammar with unreserved leading keywords can reuse
it), not a lookahead special-case for one word, and it changes nothing outside a
declaration block.

```ts
/**
 * Bare (no-`as`) alias barrier. While a declaration-block item body is being
 * parsed, the leading keywords of a *sibling* item must not be absorbed as an
 * implicit alias — block items carry no required separator, so the alias slot
 * and the next item's first token compete for the same position. Scoped by a
 * stack so it never leaks into ordinary statements.
 */
private aliasBarriers: ReadonlySet<string>[] = [];

private withAliasBarrier<T>(words: ReadonlySet<string>, parse: () => T): T {
	this.aliasBarriers.push(words);
	try { return parse(); } finally { this.aliasBarriers.pop(); }
}

/** True when the cursor sits on a bare identifier the active barrier reserves. */
private atAliasBarrier(): boolean {
	if (this.aliasBarriers.length === 0) return false;
	const token = this.peek();
	// A quoted identifier carries `literal`; only bare words are ambiguous, so
	// `"materialized"` stays usable as an alias.
	if (token.type !== TokenType.IDENTIFIER || token.literal !== undefined) return false;
	const upper = token.lexeme.toUpperCase();
	return this.aliasBarriers.some(set => set.has(upper));
}
```

Consult it at the two implicit-alias decision points — `matchBareSourceAlias()`
(covers table, subquery, and function sources) and the implicit-alias branch of
`columnList()`. `isEndOfClause()` has exactly those two callers, so folding the
check in there also works; prefer explicit `|| this.atAliasBarrier()` at both
sites and update the `isEndOfClause` comment to point at the barrier, since
"end of clause" and "reserved-in-this-block" are different ideas.

Push the barrier in the block loop. Extract the `if/else` kind dispatch into a
`declareBlockItem(): AST.DeclareItem` so the wrap is one call:

```ts
const DECLARE_ITEM_KEYWORDS: ReadonlySet<string> = new Set([
	'TABLE', 'INDEX', 'UNIQUE', 'MATERIALIZED', 'VIEW', 'SEED', 'ASSERTION',
	'DOMAIN', 'COLLATION', 'IMPORT',
]);
```

(The reserved ones are already safe; listing them costs nothing and keeps the set
readable as "the item keywords". `DOMAIN` / `COLLATION` / `IMPORT` are the
currently-ignored kinds.)

### Invariants the fix must preserve

- Outside a declaration block, nothing changes: `select materialized from t1`,
  `select a from t1 materialized`, `select seed from t` all keep working.
- Inside a block body, the escape hatches stay: `from t1 as materialized`
  (explicit `as`) and `from t1 "materialized"` (quoted) still yield that alias.
- A column *reference* named `materialized` inside a block body still parses —
  the barrier only guards the bare-alias slot, not expression parsing.
- Items separated by `;` keep parsing identically.

### Secondary: the unrecognized-item boundary

Same ten lines, same failure mode (a block item swallowing its own terminator).
Replace the broken `}`-as-IDENTIFIER test with a depth-aware scan that stops at a
top-level `SEMICOLON` or `RBRACE`, tracking `LBRACE`/`RBRACE` and
`LPAREN`/`RPAREN` depth so a braced or parenthesized payload inside the ignored
item does not end the scan early.

Leave the *silent drop* of unrecognized items as-is (out of scope), but mark it:
add a `NOTE:` comment at the fallback saying an unrecognized item is retained
only as opaque text, so a typo'd item keyword is accepted and ignored rather than
diagnosed.

## TODO

- Add `aliasBarriers` / `withAliasBarrier` / `atAliasBarrier` to `Parser`.
- Consult `atAliasBarrier()` in `matchBareSourceAlias()` and in the implicit-alias
  branch of `columnList()`; update the stop-set comment above `isEndOfClause()` to
  cross-reference the barrier.
- Extract the declare-block kind dispatch into `declareBlockItem()` and wrap each
  iteration in `withAliasBarrier(DECLARE_ITEM_KEYWORDS, …)`.
- Apply the same barrier (set: `VIEW`) around each `declare lens` override body in
  `declareLensStatement` — safe today because `view` is reserved, but the block has
  the identical separator-less shape.
- Fix the unrecognized-item scan to stop at a depth-0 `SEMICOLON`/`RBRACE`; add the
  `NOTE:` comment about silent drop.
- New spec `packages/quereus/test/declare-schema-item-boundary.spec.ts` asserting
  item kinds and absence of a stolen alias for each reproduced shape:
  - `materialized view` after a body ending in a table source, in an implicit
    column alias (`select 1`), in a subquery source, and after a
    `table … maintained as select … from t1` item
  - `seed t1 ( (1,'x') )` after a `view`/`materialized view` body → `declaredSeed`
  - the same blocks written with `;` separators → unchanged parse
  - `from t1 as materialized` and `from t1 "materialized"` inside a block body →
    alias still `materialized`
  - outside a block: `select materialized from t1`, `select a from t1 materialized`,
    `select seed from t1` → unchanged
  - `declare schema main { domain d1 as text  table t1 { … } }` → block closes,
    two items, no `Expected '}'` error
- Add a differ-level regression (near `packages/quereus/test/schema-differ.spec.ts`)
  that two `materialized view mv` items now report
  `Materialized view 'mv' is declared more than once in schema 'main'`.
- Update `docs/sql-ddl.md` § Declaration Syntax: inside a `declare schema` block an
  item keyword (`materialized`, `seed`, …) cannot be used as a bare alias at the end
  of an item body — write `as materialized`, quote it, or separate items with `;`.
- Run `yarn workspace @quereus/quereus run lint` and `yarn test` (emit round-trip and
  declarative-equivalence suites are the ones most likely to notice an alias-slot
  change).

----
description: Setting a database option back on with `pragma foreign_keys = on;` used to throw a confusing error, because the word "on" was mistaken for the JOIN keyword instead of a plain value — while `= off` worked fine, so people didn't notice until they tried to turn something back on. Fixed and reviewed.
files: packages/quereus/src/parser/parser.ts (nameValueItem, ~line 4163), packages/quereus/test/logic/103.1-pragma-boolean-values.sqllogic, docs/sql-txn.md (§9.1)
----

## What changed

`nameValueItem` in `packages/quereus/src/parser/parser.ts` — shared by the `PRAGMA name = value` grammar and the virtual-table module-argument `name = value` grammar — accepted a bareword value only via `this.check(TokenType.IDENTIFIER)`. The lexer hard-keywords `on` to `TokenType.ON` (the JOIN keyword) but leaves `off` as a plain identifier, so `pragma foreign_keys = off;` always worked while `pragma foreign_keys = on;` threw:

```
QuereusError: Expected pragma value (identifier, string, number, or NULL).
'ON' must follow a JOIN. Use WHERE for filters in subqueries. (at line 1, column 23)
```

The bareword branch now uses the parser's existing mechanism for exactly this situation — `checkIdentifierLike(CONTEXTUAL_KEYWORDS)` plus `consumeIdentifier(CONTEXTUAL_KEYWORDS, …)`. The fix is general: any bareword value colliding with a `CONTEXTUAL_KEYWORDS` entry (`key`, `action`, `set`, `default`, `check`, `unique`, `references`, `on`, `cascade`, `restrict`, `like`) is now accepted as a value. Value conversion was already correct — `database-options.ts` `convertToBoolean` lowercases and accepts `on`/`off`/`yes`/`no`/`1`/`0`/`true`/`false`.

Test coverage lives in `packages/quereus/test/logic/103.1-pragma-boolean-values.sqllogic`: each spelling set then read back — `off`/`on`, `OFF`/`On` (case), `'off'`/`'on'` (quoted), `0`/`1`, `false`/`true`, a second boolean pragma (`runtime_fuse_scalars`), and a string-typed pragma (`schema_path = key`) proving the fix is not `on`-specific and not boolean-specific.

## Review findings

**Checked:** the two-line parser diff against the surrounding identifier/keyword helpers (`consumeIdentifier` overloads, `consumeIdentifierOrContextualKeyword`, `checkIdentifierLike`); all five `nameValueItem` call sites (one pragma, four module-argument); the boolean conversion path in `core/database-options.ts`; the new `.sqllogic` file against the existing `103-database-options-edge-cases.sqllogic` conventions; every doc file mentioning pragma syntax (`docs/sql.md` grammar, `docs/sql-txn.md` §9, `docs/sql-constraints.md`); and the debt ticket the implement stage filed. Ran `yarn test` (all workspaces), `yarn lint`, `yarn typecheck` — all clean, 0 failing, no pre-existing failures surfaced.

**Fixed in this pass (minor):**

- The fix called `consumeIdentifierOrContextualKeyword` directly, while the ~40 other keyword-tolerant sites in `parser.ts` all use the `consumeIdentifier(CONTEXTUAL_KEYWORDS, …)` overload that wraps it. Switched to the house idiom and added a one-line comment naming the `on`/JOIN collision, so the next reader sees why the list is there.
- Test coverage was single-pragma and boolean-only, so it could not distinguish "the `on` bareword works" from "the fix is general". Added two arms: a second boolean pragma (`runtime_fuse_scalars = off`/`on`) and a string-typed pragma set to a different contextual keyword (`schema_path = key`, then reset), which exercises the bareword path with no boolean conversion in play. Both pass — the `schema_path = key` arm is the one that actually proves generality.
- `docs/sql-txn.md` §9.1 documented `pragma name = value` without saying what a value may look like; `docs/sql-constraints.md` had been showing `pragma foreign_keys = on` for a form that did not parse. Added one line to §9.1 listing the accepted bareword/quoted/boolean spellings. `docs/sql.md`'s grammar (`pragma_value = signed_number | name | string_literal`) already described the fixed behavior correctly and needed no change.

**Filed / re-filed (major):**

- The implement stage filed `debt-audit-contextual-keyword-value-positions` — the class behind this instance (~18 narrow `check(TokenType.IDENTIFIER)` sites). Moved it from `tickets/implement/` to `tickets/backlog/`: it carried a `debt-` prefix and a `tradeoffs:` line (both backlog conventions) and its own body says a maintainer might reasonably defer it, but sitting in `implement/` removed that choice. Dropped the now-moot `prereq:` on this ticket.
- Appended an arm to that ticket, found while reviewing the fix site: the **single-argument** `consumeIdentifier(<message>)` overload passes an empty keyword list, so it is exactly as narrow as the bare `check(TokenType.IDENTIFIER)` the ticket already tracks — and `nameValueItem`'s own *name* position still uses it. After this fix, `name = on` parses but a module argument named `on = 1` does not. Same root cause, same fix pattern, not covered by the ticket's original grep. Also corrected the ticket's rung-1 proposal: the helper it wanted (`checkIdentifierOrContextualKeyword`) already exists as `checkIdentifierLike`, so the real work is making the narrow spellings harder to write, not adding a helper.

**Tripwires:** none — nothing here is conditional-on-future-growth. The one "not wrong yet" item (the module-argument name position) is a live latent defect, so it went to the debt ticket as an arm rather than a `NOTE:`.

**Considered and not filed:**

- `runtime/emit/pragma.ts` wraps a rejected pragma *value* into an `Unknown pragma: <name>` error, so `pragma foreign_keys = key` reports the wrong problem. Pre-existing, unrelated to this diff, and low severity — but it is now the message users hit once the parser accepts these barewords, so it is recorded as an edge-case bullet on the debt ticket rather than as its own ticket.
- The implement handoff's gap about the module-argument grammar having no new test: the grammar path is literally the same function, and the `schema_path = key` arm already covers the shared code. A module-arg test would exercise vtab plumbing, not this fix.

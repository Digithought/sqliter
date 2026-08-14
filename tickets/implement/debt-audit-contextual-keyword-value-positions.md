----
description: Several places in the SQL parser check for a plain word using a narrow test that a handful of ordinary words (like "on") silently fail, so those words get rejected with a confusing error even though the grammar was designed to allow them there.
prereq: pragma-on-off-value-parsing
files: packages/quereus/src/parser/parser.ts (all `this.check(TokenType.IDENTIFIER)` call sites — currently ~18, see grep below), packages/quereus/src/parser/lexer.ts (KEYWORDS, CONTEXTUAL_KEYWORDS)
tradeoffs: auditing every one of the ~18 sites is a mechanical but non-trivial time sink, and most of them are probably fine (positions where a keyword genuinely shouldn't be a value); a maintainer might reasonably defer this until another instance actually surfaces, rather than pre-emptively auditing a class that's mostly benign.
----

`pragma-on-off-value-parsing` fixes one instance: `nameValueItem` in `parser.ts` used a bare `this.check(TokenType.IDENTIFIER)` to decide whether the next token could serve as a value, instead of the existing `consumeIdentifierOrContextualKeyword` / `CONTEXTUAL_KEYWORDS` mechanism that already exists precisely so common words that happen to be reserved (`on`, `key`, `default`, `check`, `unique`, `references`, `cascade`, `restrict`, `like`, `set`, `action`) can still be used as identifiers/values in the positions where the grammar doesn't need them as keywords.

`grep -n "check(TokenType\.IDENTIFIER)" packages/quereus/src/parser/parser.ts` currently finds ~18 call sites. Not all are bugs — many are positions where only a true identifier makes sense and a contextual keyword genuinely shouldn't be accepted. But `nameValueItem` shows the bug is real when it does occur, and the failure mode is specifically nasty: it doesn't just reject the input, it prints a misleading, unrelated hint ("'ON' must follow a JOIN") because of the generic error-hinting logic in `error()`, which makes the actual problem harder to diagnose from the message alone.

## Scope

1. Walk the `this.check(TokenType.IDENTIFIER)` call sites in `parser.ts` (and any equivalent pattern elsewhere in the parser) and classify each as: (a) correctly identifier-only, (b) should also accept `CONTEXTUAL_KEYWORDS` tokens like `nameValueItem` did, or (c) should accept the full keyword set as a bareword (name-position lenience).
2. For each (b)/(c) site, apply the same fix pattern as `pragma-on-off-value-parsing`.
3. Consider a rung-1 fix per the ticket workflow's "Architecture first" ladder: introduce one shared helper (e.g. `checkIdentifierOrContextualKeyword()` alongside `consumeIdentifierOrContextualKeyword()`) so a future call site can't reproduce this class by hand-rolling a narrow `check(TokenType.IDENTIFIER)` — make the narrow, wrong pattern harder to write than the correct one.
4. Add or extend a grammar/property test (see `test/property.spec.ts` "Parser Robustness" fuzzing) that specifically feeds `CONTEXTUAL_KEYWORDS` words into name/value positions across statement kinds, so a regression here fails a general test rather than requiring a bug report per keyword per position.

## Edge cases & interactions

- The generic `error()` hint logic (`parser.ts` ~line 2282) that appends "'ON' must follow a JOIN" for any un-consumed `ON` lexeme — worth checking whether other contextual keywords have similarly misleading generic hints that would mask a real fix-site elsewhere.
- Case sensitivity — `KEYWORDS` lookups lowercase first; confirm any generalized helper preserves that.

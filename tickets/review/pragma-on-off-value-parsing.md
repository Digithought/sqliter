description: Setting a database option back on with `pragma foreign_keys = on;` used to throw a confusing error, because the word "on" was mistaken for the JOIN keyword instead of a plain value — while `= off` worked fine, so people didn't notice until they tried to turn something back on. Fixed.
files: packages/quereus/src/parser/parser.ts (nameValueItem, ~line 4163), packages/quereus/test/logic/103.1-pragma-boolean-values.sqllogic (new)
difficulty: easy
----

## What changed

`nameValueItem` in `packages/quereus/src/parser/parser.ts` (shared by `PRAGMA name = value` and module-argument `name = value` grammars) only accepted a bareword value via `this.check(TokenType.IDENTIFIER)`. Since the lexer hard-keywords `on` to `TokenType.ON` (the JOIN keyword) but leaves `off` as a plain `IDENTIFIER`, `pragma foreign_keys = off;` always worked while `pragma foreign_keys = on;` threw:

```
QuereusError: Expected pragma value (identifier, string, number, or NULL).
'ON' must follow a JOIN. Use WHERE for filters in subqueries. (at line 1, column 23)
```

Fix: `nameValueItem`'s bareword branch now uses the same mechanism the rest of the parser already uses for this exact situation — `checkIdentifierLike(CONTEXTUAL_KEYWORDS)` / `consumeIdentifierOrContextualKeyword(CONTEXTUAL_KEYWORDS, ...)` from `lexer.ts`'s `CONTEXTUAL_KEYWORDS` list (which already includes `'on'`, used elsewhere for e.g. `ON DELETE`/`ON UPDATE`). This is general — any bareword pragma/module-arg value that collides with a `CONTEXTUAL_KEYWORDS` entry (`key`, `action`, `set`, `default`, `check`, `unique`, `references`, `on`, `cascade`, `restrict`, `like`) is now accepted as a value, not just `on`. Diff is 2 lines changed.

## Verified live (built dist, via `node --input-type=module`)

- `pragma foreign_keys = off;` → still works (regression guard)
- `pragma foreign_keys = on;` → now works (was the bug)
- `pragma foreign_keys = On;` / `= OFF;` → case-insensitive, both work
- `pragma foreign_keys = 'on';` / `= 'off';` (quoted STRING form) → still works
- `pragma foreign_keys = 1;` / `= 0;` / `= true;` / `= false;` → still work
- Read-back via `pragma foreign_keys;` returns the correctly-converted boolean in every case above (`database-options.ts` `convertToBoolean` already lowercases and accepts `on`/`off`/`yes`/`no`/`1`/`0`/`true`/`false` — no changes needed there)

## Other CONTEXTUAL_KEYWORDS barewords as pragma values

Checked `pragma foreign_keys = key;` and `pragma foreign_keys = default;` — both now parse successfully (no more parser error), but then correctly *fail at the option-conversion step* with `Invalid boolean value for option foreign_keys: key` (wrapped by `runtime/emit/pragma.ts` into a somewhat misleading `Unknown pragma: foreign_keys` message — that wrapping is pre-existing, unrelated to this fix, and out of scope: it mis-labels a "value rejected" error as "pragma name unknown"). This is correct behavior for this ticket's scope — the parser's job is just to accept the bareword as a candidate value; the boolean-option converter is right to reject nonsense values. Flagging the confusing wrapper-message behavior here rather than filing a ticket for it, since it's a pre-existing, low-severity message-clarity issue, not something this change introduced or needs to fix.

## Test coverage

Added `packages/quereus/test/logic/103.1-pragma-boolean-values.sqllogic`, modeled on the existing `103-database-options-edge-cases.sqllogic` file. Covers, each set-then-read-back against `pragma foreign_keys`:
- `off` / `on` (the regression case)
- `OFF` / `On` (case-insensitivity)
- `'off'` / `'on'` (quoted STRING form)
- `0` / `1` (numeric form, regression guard)
- `false` / `true` (TRUE/FALSE token form, regression guard)

Ran via `node test-runner.mjs --grep "pragma-boolean"` — 1 passing. Also reran the pre-existing `database-options-edge-cases` sqllogic file — still 1 passing, no regression.

## Full validation run

- `yarn workspace @quereus/quereus run build` — clean
- `yarn test` (repo root, all 6 workspaces) — all green (quereus: 725 passing including the new file; sync/sync-client/quoomb-cli/quoomb-web/plugin-loader etc. all passing). The only non-passing-looking log lines are intentional simulated-failure fixtures inside `quereus-sync`'s own test suite (`Data change listener error: Error: boom`, `socket write failed`) — not real failures, not related to this change.
- `yarn lint` (repo root, fans out to all packages) — clean, no eslint errors in `packages/quereus`
- `yarn typecheck` (repo root) — clean

## Known gaps / not covered

- Only `foreign_keys` was used as the guinea-pig boolean pragma for the new conformance file, since it's the pragma named in the bug report and the only boolean-typed one exercised elsewhere in existing tests. Other boolean pragmas (`runtime_stats`, `validate_plan`, `trace_plan_stack`, `runtime_fuse_scalars`, `nondeterministic_schema`) share the same `convertToBoolean` path and the same parser fix, but aren't individually exercised with `on`/`off` — low risk since the fix is at the grammar level (shared `nameValueItem`), not per-pragma.
- Module-argument `name = value` grammar (the other three call sites of `nameValueItem` in `parser.ts`, used for virtual-table module arguments) benefits from the same fix but has no new test — wasn't in the ticket's stated scope and I didn't want to invent unrelated coverage. Worth a quick look if module-arg parsing with `on`/`off`-shaped values ever comes up.
- Did not add a test for `pragma x = key;` / `= default;` style collisions (the "other bareword pragma value" edge case) — verified manually instead (see above) since the resulting behavior is a pre-existing, unrelated message-clarity quirk, not a parsing correctness question this ticket is about.

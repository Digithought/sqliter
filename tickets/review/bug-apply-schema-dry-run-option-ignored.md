description: `apply schema` now rejects the `dry_run` and `validate_only` options at parse time instead of silently accepting and ignoring them, so a user asking for a safe preview or check no longer gets a real migration run instead.
files: packages/quereus/src/parser/parser.ts, packages/quereus/src/parser/ast.ts, packages/quereus/src/emit/ast-stringify.ts, packages/quereus/test/parser.spec.ts
---

## What changed

`apply schema ... options (...)` previously had bespoke branches for `dry_run` and
`validate_only` that parsed the boolean value and stored it on the AST — but nothing downstream
ever read those fields, so the engine always ran the real migration regardless of what the user
asked for.

Chosen fix (see prior `fix/2-bug-apply-schema-dry-run-option-ignored.md` research, folded into
this ticket's body): **reject, don't implement.**

- `dry_run`'s job is already covered by `diff schema` — read-only preview of the exact migration
  DDL, today.
- `validate_only` only has a partial equivalent one layer down (`Table.alterSchema(...,
  validateOnly)`, implemented for `alterColumn`/`alterPrimaryKey` on the `memory` vtab) — no
  validate-only path exists for create/drop/rename or other migration steps, so wiring a real
  top-to-bottom validate-only mode is a much larger lift than this bug warrants.

### Parser (`packages/quereus/src/parser/parser.ts:4100-4126`, `applySchemaStatement`'s
`OPTIONS (...)` loop)

- `dry_run` and `validate_only` are now a `ParseError` at the option-key token, regardless of the
  boolean value that follows (`dry_run = false` still errors — the option existing at all is the
  problem). The boolean token is still consumed before throwing, so the parser stays in a
  well-formed state (mirrors how the `rename_policy` bad-value case is handled just below it).
  Message points at `diff schema` as the read-only alternative.
- `allow_destructive` and `rename_policy` branches are unchanged.

### AST (`packages/quereus/src/parser/ast.ts:987-997`)

- Removed the dead `dryRun` / `validateOnly` fields from `ApplySchemaStmt['options']`. Confirmed
  via grep that no planner/runtime code ever read `ApplySchemaStmt.options.dryRun` or
  `.validateOnly` (the same-named `validateOnly` fields in `vtab/table.ts` and
  `vtab/memory/table.ts` are a separate, already-existing mechanism — `Table.alterSchema`'s own
  parameter — untouched by this change).

### Stringifier (`packages/quereus/src/emit/ast-stringify.ts:156-162`)

- Removed the two now-dead round-trip branches for `dry_run` / `validate_only`.

### Tests (`packages/quereus/test/parser.spec.ts`, `Error Handling` describe block)

Added two tests next to the existing `rename_policy` bad-value test, same style
(`expect(() => parse(...)).to.throw(ParseError, /message/)`):

- `apply schema temp options (dry_run = true)` throws `ParseError` matching
  `/Unsupported apply schema option 'dry_run'/`.
- `apply schema temp options (validate_only = true)` throws `ParseError` matching
  `/Unsupported apply schema option 'validate_only'/`.

## How to validate

- `yarn workspace @quereus/quereus test` (or `node packages/quereus/test-runner.mjs`) — full
  suite, 9762 passing / 25 pending, no failures introduced.
- Targeted: `node test-runner.mjs --grep "apply schema|rename_policy|dry_run|validate_only"` from
  `packages/quereus` — 20 passing.
- `yarn workspace @quereus/quereus lint` — clean (this lint pass also runs
  `tsc -p tsconfig.test.json --noEmit`, so it catches the AST field removal against the new spec
  file too).
- Manually: `apply schema main options (dry_run = true)` and `apply schema main options
  (validate_only = true)` (and the `= false` variants) should now throw a `ParseError` naming the
  option and pointing at `diff schema`; `apply schema main options (allow_destructive = true)` and
  `rename_policy = 'allow'|'require-hint'|'deny'` should still parse and behave as before.

## Known gaps / things not covered

- No `.sqllogic` test exercises the new rejection end-to-end (i.e. via the CLI/engine entry point
  rather than the bare parser). The parser test is the only coverage; grepped
  `packages/quereus/test/logic/` for `dry_run`/`validate_only` before and after — zero hits, so
  nothing regressed, but there's also no logic-level test asserting the user-facing error surfaces
  correctly through `apply schema` end to end.
- This is a breaking change for any caller currently passing `dry_run` or `validate_only` — they
  previously got a silent real migration, now they get a parse error. Ticket explicitly accepted
  this trade (silently running the wrong thing was the actual bug).
- Did not re-check quoomb-cli / quoomb-web / docs for any UI or documentation that offers/mentions
  these two options — only `packages/quereus` (parser, AST, stringifier, tests) was in scope per
  the ticket's `files:` list. Worth a grep before considering this fully closed if those surfaces
  exist.

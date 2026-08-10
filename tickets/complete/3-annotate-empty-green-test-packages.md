description: Four packages reported a passing test run while containing zero test files; this reviewed the "green means nothing" state package by package and either explained it, tested it, or filed the gap. Review pass confirmed the work and caught one more CLI output wart.
files:
  - packages/quoomb-cli/src/commands/dot-commands.ts (bug fix: sqlite_schema → schema(); .schema no-arg function-filter added in review)
  - packages/quoomb-cli/test/dot-commands.spec.ts (smoke spec; +1 test in review)
  - packages/quoomb-cli/package.json (test NOTE)
  - packages/shared-ui/package.json (test NOTE)
  - packages/plugin-loader/package.json (test NOTE)
  - tickets/backlog/debt-plugin-loader-test-coverage.md (untested-surface follow-up)
----

## What this ticket did

Four workspace packages (quoomb-cli, quoomb-web, plugin-loader, shared-ui)
reported a passing `vitest` run via `--passWithNoTests`. The implement pass
audited each: two already had real coverage (quoomb-web 74 tests,
plugin-loader 3), shared-ui is a genuine placeholder (`src/index.ts` is
`export {}`, zero components), and quoomb-cli had real logic but no specs.

Implement outcomes:
- Added `quoomb-cli/test/dot-commands.spec.ts` smoke spec.
- The smoke test caught a real live bug: `.tables` / `.schema` queried a
  non-existent `sqlite_schema` table and silently printed an error for every
  CLI user. Fixed to use the built-in `schema()` table-valued function.
- Dropped a stray `await` on the synchronous `db.prepare(...)` in `importCsv`.
- Rewrote the `//test` NOTE in each of the three non-quoomb-web `package.json`
  files to say *why* the green is (or isn't) earned.
- Filed `tickets/backlog/debt-plugin-loader-test-coverage.md` for
  plugin-loader's untested surface (URL/npm-spec parsing, CDN resolution,
  protocol-allowlist rejection, env interpolation).

## Review findings

**Checked** the full implement diff first (fresh eyes, before the handoff):
the `sqlite_schema → schema()` fix, the `await` removal, the smoke spec, all
three `package.json` NOTEs, and the backlog ticket. Verified against the
engine source, not just the handoff claims.

- **`schema()` TVF shape** — confirmed `packages/quereus/src/func/builtins/schema.ts`
  exposes columns `schema, type, name, tbl_name, sql, tags`. The three fixed
  query sites (`name, type`; `sql`; `name = ?`) all reference real columns.
  Fix is correct, not just compiling.
- **`await` removal** — confirmed `Database.prepare()` returns `Statement`
  synchronously (`database.ts:443`), so dropping `await` is correct; the
  awaited `stmt.run()` / `stmt.finalize()` are the genuinely async calls and
  were left intact.
- **Other `sqlite_schema` / `sqlite_master` references** — searched the
  workspace. Only other hit is quoomb-web's worker, which already pulls from
  `schemaManager` directly (comment: "instead of sqlite_schema compatibility
  view"). No other live breakage; the fix is complete.

**Found and fixed inline (minor):**
- `.schema` with no argument dumped **every built-in function signature**.
  `schema()` emits one row per built-in function with a non-null `sql`
  (its `FUNCTION name(...)` string), and the no-arg query filtered only on
  `sql IS NOT NULL` — so the DDL dump was drowned in `FUNCTION` lines. This
  path was fully broken before the `sqlite_schema` fix (errored), so it's a
  fresh wart the fix exposed, not a regression from working behavior. Added
  `AND type <> 'function'` (keeps tables/views/indexes, matching sqlite's
  `.schema` semantics) and a guard test asserting the dump contains table DDL
  but no `FUNCTION` lines. quoomb-cli is now at 5 passing tests.

**Validation:**
- Full `yarn test` (workspace): **0 failures**, `Done in 2m 32s` — quoomb-cli
  5, quoomb-web 74, plugin-loader 3, shared-ui 0 (`--passWithNoTests`), all
  other packages green.
- `yarn workspace @quereus/quoomb-cli build`: clean tsc, no type errors.
- Lint: the three touched non-quereus packages ship the intentional
  `echo 'No lint configured'` no-op (only `packages/quereus` has a real
  lint), and none of my changes touched `packages/quereus`. `tsc` build is
  the effective type-check for the edited file and passes.

**Not filed as tickets (deliberate):**
- quoomb-cli's `.plugin` subcommand dispatch and `bin/quoomb.ts`'s
  config-path precedence (`--config` > `QUOOMB_CONFIG` > cwd > home) remain
  unit-test-free. Nothing indicates they're broken (unlike the
  `sqlite_schema` bug, which was actively wrong), so this stays a noted gap,
  not a ticket — a future coverage pass can extend the smoke spec.
- `debt-plugin-loader-test-coverage` (backlog) is a real scoped follow-up and
  correctly a ticket, not a tripwire: plugin-loader's untested surface is live
  logic today, not a conditional future risk.

**No major findings.** The implement work was sound; the one thing it
overlooked (function-signature noise in `.schema`) was fixed in this pass.

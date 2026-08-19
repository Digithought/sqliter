description: `apply schema` no longer accepts options it will not act on — asking for a preview, a check, or anything it does not recognize is now an error instead of a silently-ignored request that ran the real migration anyway.
files: packages/quereus/src/parser/parser.ts, packages/quereus/src/parser/ast.ts, packages/quereus/src/emit/ast-stringify.ts, packages/quereus/test/parser.spec.ts, packages/quereus/test/logic/50-declarative-schema.sqllogic, docs/sql-ddl.md
---

## Outcome

`apply schema <name> options (...)` used to accept `dry_run` and `validate_only`, store them on the
AST, and then ignore them — the engine ran the real migration regardless. The implement stage made
both a parse error (rejecting rather than implementing, because `diff schema` already gives a
read-only preview of the exact migration DDL, and no engine-level validate-only mode exists for
create/drop/rename), removed the dead AST fields and their stringifier branches, and added two
parser tests.

The review pass found the same defect one branch further down and closed it: every *other*
unrecognized option key was also being consumed and silently discarded. The option loop now
recognizes exactly `allow_destructive` and `rename_policy`; anything else — unknown key or
non-boolean value — is a `ParseError` sited at the offending token.

Final shape of the accepted option set:

| Key | Value | Behavior |
|-----|-------|----------|
| `allow_destructive` | `true` / `false` literal | Unchanged — gates the maintained-table backing-module move. |
| `rename_policy` | `'allow'` / `'require-hint'` / `'deny'` | Unchanged. |
| `dry_run`, `validate_only` | any | `ParseError`, message points at `diff schema`. |
| anything else | any | `ParseError`, message names the two supported keys. |

## Review findings

### Checked

- Implement-stage diff (`944bca44f`) read first, before its handoff summary: parser dispatch, AST
  field removal, stringifier branches, both new parser tests, and both doc edits.
- Repo-wide grep for `dry_run` / `validate_only` / `dryRun` / `validateOnly` across `.ts`, `.tsx`,
  `.md`, `.sqllogic`, `.json` (excluding `node_modules`, `dist`, `tickets/`). This closes the gap
  the implementer flagged as unchecked: **no** quoomb-cli, quoomb-web, plugin, or VS Code surface
  offers either option. The only surviving hits are the unrelated `Table.alterSchema(change,
  validateOnly)` vtab mechanism (`vtab/table.ts`, `vtab/memory/table.ts`,
  `vtab/memory/layer/manager.ts`, `quereus-isolation`) and its docs, which this change never
  touched.
- Docs that mention `apply schema` options: `docs/sql-ddl.md`, `docs/schema.md`,
  `docs/materialized-views.md`, `docs/todo.md`, `docs/lens.md`. Only `sql-ddl.md` needed a change
  (see below); the others discuss `allow_destructive` semantics, which are unchanged.
- `diff schema` takes no `OPTIONS (...)` clause at all (`diffSchemaStatement`), so pointing users
  at it as the read-only alternative is sound — it cannot be asked to mutate.
- Parser has no error-recovery path (`grep synchronize|recover` in `parser.ts` gives zero hits), so
  a thrown `ParseError` is terminal.
- `yarn workspace @quereus/quereus lint` — clean (includes the `tsc -p tsconfig.test.json` pass).
- `yarn test` (all workspaces) — exit 0, `packages/quereus` at 9768 passing / 25 pending, up from
  9762 at the implement commit (+6 net from the tests below). No pre-existing failures surfaced.

### Found and fixed in this pass (minor)

- **The same defect class was left standing three lines below the fix.** The option loop's `else`
  catch-all consumed and discarded any unrecognized key, so `options (allow_destrucive = true)` —
  a plausible typo of the destructive-change acknowledgement — parsed clean and ran the migration
  with the gate silently still on. That is exactly the "accept an option we will not honor" bug
  this ticket exists to fix. Rather than file a second point ticket, the invariant that retires
  the whole class went in at the same site: **an option key must be recognized or it is a parse
  error**, which also covers any future option name that gets added to the AST and forgotten in
  the dispatch. The dedicated `dry_run` / `validate_only` arm survives only to give those two a
  better message.
- **`consumeBooleanLiteral` returned `false` for any value it did not understand.**
  `allow_destructive = 'yes'` silently became `false`; so did `= 'on'`. Every silent misread
  happened to fall in the safe direction (the destructive gate stayed shut), so this was
  wrong-answer, not corruption — but it is the same silent-acceptance shape. It now throws
  `ParseError` on anything but a `true` / `false` literal. Its only caller is this options loop,
  so the blast radius is contained.
- **Dead motion removed.** The implementation parsed the boolean value before throwing, on the
  stated rationale of "keeping the parser well-formed". With no recovery path, nothing resumes
  after the throw — the parse is over. The error is now raised as soon as the key is known bad.
- **Readability.** The loop body was a four-arm `if` / `else if` chain with an inline
  `rename_policy` validator and an inline throw. Value parsing moved to `consumeRenamePolicy()`
  and error construction to `unsupportedApplySchemaOption()`; the loop body is six lines and reads
  as a dispatch table.

### Test gaps closed

The implementer's two tests covered `dry_run = true` and `validate_only = true` only.

- The handoff claimed `dry_run = false` still errors — nothing asserted it. Now table-driven over
  both options and both boolean values (4 cases), asserting the message reaches `diff schema`.
- Added: unrecognized key rejected (and its message names the two supported keys); non-boolean
  option value rejected.
- Added a positive `Apply Schema Options` describe: `allow_destructive` + `rename_policy` land on
  the AST as expected, and `astToString` round-trips them. The implement stage deleted two
  stringifier branches with **zero** test coverage over the ones that remain — this closes that.
- **Closed the implementer's own stated gap**: `packages/quereus/test/logic/50-declarative-schema.sqllogic`
  now has an `apply schema` options section exercising all four rejections end-to-end through
  `db.exec` (not just the bare parser), plus a successful `allow_destructive = true, rename_policy
  = 'deny'` apply. Verified the assertions actually bite by flipping one expected message to a
  sentinel and confirming the suite failed with the real message and a line/column
  (`Unsupported apply schema option 'dry_run'. Use 'diff schema' ... (at line 1, column 28)`),
  then restoring it.

### Docs

- `docs/sql-ddl.md` — the implement stage documented the rejection as a two-line comment inside a
  fenced example headed *"Future: versioned apply with options"*, which is close to the least
  likely place a reader checks for current behavior, and it covered only two of the (now three)
  rejection rules. Replaced with an **Options (`OPTIONS (...)`)** paragraph in §20 alongside the
  Safety and Rename-detection notes: names the two accepted keys and their value shapes, states
  that unknown keys and non-boolean values are parse errors, says why, and directs `dry_run` /
  `validate_only` users to `diff schema`. The example block is back to being just an example.
- `docs/todo.md` — the implement stage's removal of the "`validate_only` and `dry_run` modes for
  safety" planned item is correct and stands; the decision and its rationale now live in
  `sql-ddl.md` where a reader will meet them.

### Major findings → new tickets

**None.** The one finding that would have qualified (silently dropped unknown options) resolves at
the same code site as the ticket's own fix and was a few lines of change, so it was fixed in this
pass rather than filed. No accepted-tradeoff `NOTE:` markers exist at any of the touched sites.

### Tripwires

- The accepted option set is stated in three places — the parser dispatch,
  `ApplySchemaStmt['options']`, and `astToString`'s renderer — and nothing enforces that a new
  option reaches all three. Fine at two options; parked as a `NOTE:` on the options loop in
  `parser.ts` saying to table-drive it if the set grows.

## Breaking change

Any caller passing `dry_run`, `validate_only`, an unrecognized option key, or a non-`true` /
`false` value for `allow_destructive` now gets a parse error where it previously got a
silently-ignored option and a real migration. That silence was the defect; the ticket accepted the
trade.

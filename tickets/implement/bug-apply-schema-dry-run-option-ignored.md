description: Make `apply schema` reject the `dry_run` and `validate_only` options instead of silently accepting and ignoring them, since a user reaching for either is trying to preview or check a change safely and today the engine runs the real migration anyway.
files: packages/quereus/src/parser/parser.ts, packages/quereus/src/parser/ast.ts, packages/quereus/src/emit/ast-stringify.ts, packages/quereus/test/parser.spec.ts
difficulty: easy
---

## Chosen fix: reject, don't implement

Researched during `fix/2-bug-apply-schema-dry-run-option-ignored.md`. Two routes were laid out
there — reject the unimplemented options, or actually implement them (dry_run running the diff
without executing it; validate_only stopping after pre-mutation checks). Picking **reject**:

- `dry_run`'s job is already done by `diff schema` — it previews the exact migration DDL `apply
  schema` would run, read-only, today. A "real" dry_run mode would duplicate that.
- `validate_only`'s partial equivalent already exists one layer down — `Table.alterSchema(...,
  validateOnly)` (packages/quereus/src/vtab/table.ts:264, implemented for `memory`'s table at
  packages/quereus/src/vtab/memory/table.ts:345) — but only for `alterColumn`/`alterPrimaryKey`.
  Table create/drop/rename and every other migration step it would need to gate have no
  validate-only equivalent, so wiring it up top-to-bottom is a much larger lift than this bug
  warrants.
- Silently accepting-and-ignoring an option is the actual defect. An explicit error is honest;
  implementing a parallel preview path is not required to close that gap.

This is a small breaking change for anyone currently passing `dry_run` or `validate_only` and
(unknowingly) getting a real migration — but "getting a real migration when you asked it not to
run one" was never something to preserve.

## Where it wires in

Parser: `packages/quereus/src/parser/parser.ts:4100-4123` (`applySchemaStatement`'s `OPTIONS (...)`
loop). It currently has bespoke branches per known key (`dry_run`, `validate_only`,
`allow_destructive`, `rename_policy`) plus a catch-all that silently consumes-and-drops any
unrecognized key/value pair.

AST: `packages/quereus/src/parser/ast.ts:987-998` (`ApplySchemaStmt.options`) declares `dryRun` and
`validateOnly` fields that nothing downstream reads (confirmed — grepped every use; only the
parser writes them and `ast-stringify.ts` prints them back out).

Stringifier: `packages/quereus/src/emit/ast-stringify.ts:159-160` round-trips `dryRun`/
`validateOnly` back to `dry_run = ...` / `validate_only = ...` text — dead once the fields are gone.

## TODO

- In `applySchemaStatement`'s options loop, make `dry_run` and `validate_only` a parse error
  (`ParseError` on the option-key token, same style as the existing `Unknown rename_policy` error)
  instead of assigning into `options`. Point the message at `diff schema` as the read-only preview
  alternative. Reject regardless of the boolean value that follows (even `dry_run = false` implies
  the option exists) — but still consume the `= <bool>` token pair before throwing so parse errors
  stay well-formed, matching how the existing malformed-value cases are consumed.
- Remove `dryRun` and `validateOnly` from `AST.ApplySchemaStmt['options']` in `ast.ts`.
- Remove the now-dead `dryRun`/`validateOnly` branches in `ast-stringify.ts:159-160`.
- Add parser test(s) in `packages/quereus/test/parser.spec.ts` asserting `apply schema main options
  (dry_run = true)` and `apply schema main options (validate_only = true)` throw, alongside the
  existing coverage for `allow_destructive` / `rename_policy` (grep that spec file for how
  `rename_policy`'s error case is asserted and mirror it).
- Double check no `.sqllogic` test under `packages/quereus/test/logic/` exercises either option
  expecting success (none found in the fix-stage research, but re-grep before landing).

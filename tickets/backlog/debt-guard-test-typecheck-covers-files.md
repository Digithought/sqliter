---
description: Add an automated check that fails the build when a package's test-file type check is silently compiling nothing, so the "tests are type-checked" guarantee can't quietly break again.
files:
  - packages/*/tsconfig.test.json
  - packages/*/package.json
  - package.json
difficulty: easy
tradeoffs: The two known holes were already fixed by hand across all 14 packages, so this only protects against recurrence, and it adds a build step that will occasionally fail for reasons unrelated to the change being made.
---

# Guard: prove each package's test type check actually compiles its test files

## The problem this prevents

Every package keeps a second TypeScript config (`tsconfig.test.json`) whose job
is to type-check the package's spec files — catching things like a test mock
that has drifted out of sync with the real interface it stands in for. That
config is run by the package's `typecheck` script.

Twice now, that check has been silently doing nothing:

- A config can inherit a "skip the `test` folder" rule from the package's main
  config. The test config then asks to compile `test/**/*` and the inherited
  rule filters it straight back out. TypeScript compiles **zero** files, exits
  0, prints nothing — indistinguishable from a genuinely clean run.
- A package can simply have no `typecheck` script. The monorepo runner
  (`yarn workspaces foreach ... run typecheck`) skips workspaces that lack the
  script, with no warning.

Both were fixed by hand across all 14 packages (ticket
`debt-sync-test-files-never-typechecked`), and the rule is now written down in
`AGENTS.md`. But nothing *enforces* it — a new package, or a copy-pasted
config, reintroduces it just as silently.

## What's wanted

A cheap check, runnable from the repo root and wired into `yarn check`, that
fails when either hole reappears:

- **Every workspace that has a `tsconfig.test.json` must have a `typecheck`
  script that runs it.** (The one deliberate exception today is
  `packages/quereus`, which runs its test-config pass from `lint` instead —
  documented in `AGENTS.md`. The check should accept either, or the exception
  should be removed so the rule is uniform.)
- **Every `tsconfig.test.json` must actually resolve at least one file under
  its own `test/` directory.** The manual version of this check is
  `tsc -p tsconfig.test.json --noEmit --listFiles` and confirming test paths
  appear in the output; an implementation could shell out to that, or read the
  resolved file list some cheaper way.

Failure output should name the offending package and say which of the two
problems it has, since the symptom (silence) gives no clue on its own.

## Non-goals

- Not asking for changes to what the test configs check — only that they check
  *something*.
- Not asking for a new lint rule inside any single package; this is a
  repo-level consistency check.

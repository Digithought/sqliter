---
description: Test files in several packages were never actually type-checked by any command, because of a missing wiring step plus a config bug that made the wiring silently check nothing even where it had already been added; both are fixed and all 14 packages now really check their specs.
files:
  - AGENTS.md
  - packages/quereus-sync/{package.json,tsconfig.test.json}
  - packages/quereus-sync-client/{package.json,tsconfig.test.json}
  - packages/sync-coordinator/{package.json,tsconfig.test.json}
  - packages/quereus-store/tsconfig.test.json
  - packages/quereus-plugin-react-native-leveldb/package.json
  - packages/quereus-plugin-nativescript-sqlite/package.json
  - packages/sample-plugins/package.json
  - packages/quereus-vscode/package.json
  - packages/quereus-store/test/{json-key.spec.ts,stream-index-build.spec.ts,unique-constraints.spec.ts}
  - packages/quereus-sync/test/sync/{conflict-resolvers.spec.ts,sync-manager.spec.ts,sync-protocol-e2e.spec.ts}
  - packages/quereus-sync-client/test/sync-client.spec.ts
  - packages/quereus-plugin-react-native-leveldb/test/plugin.spec.ts
---

# Sync (and neighbours') test files are now genuinely type-checked

## What landed

Each package carries a second TypeScript config, `tsconfig.test.json`, whose
job is to type-check the package's spec files — the pass that catches a test
mock drifting out of sync with the real interface it stands in for. Two
independent holes meant that pass was doing nothing in several packages:

1. **Not wired.** Some packages' `typecheck` script was plain `tsc --noEmit`,
   which only reads the main config — and the main config excludes `test`.
2. **Wired but inert.** `tsconfig.test.json` `extends` the main config, and
   TypeScript *inherits* the parent's `exclude` when the child doesn't declare
   its own. The parent's exclude lists `test`, so the child's
   `include: ["test/**/*"]` was filtered right back out. Zero files compiled,
   exit 0, no output — visually identical to a clean run.

Both fixed across the monorepo, and the real type errors that surfaced once
files were actually being compiled were fixed too (see the implement handoff in
git history for the per-error detail — commit
`ticket(implement): debt-sync-test-files-never-typechecked`). Highlights:

- Two spec files had **dropped assertions** hiding behind unused locals — the
  idempotency test in `sync-protocol-e2e.spec.ts` never checked that a repeat
  apply leaves the change log alone, and a tombstone-blocking test in
  `conflict-resolvers.spec.ts` never checked `applied === 0`. Both assertions
  added; both pass.
- `quereus-sync-client`'s `MockSyncManager.getSnapshot()` was missing the
  `snapshotFormat` field a prior ticket added to the real `Snapshot` interface —
  exactly the drift class this ticket exists to catch.

## Review findings

### Verified as claimed

- **The exclude-inheritance diagnosis is correct.** Confirmed the four fixed
  packages' base configs list `exclude: ["node_modules", "dist", "test"]`, and
  that the four plugin packages the handoff called safe genuinely have no
  `test` in their base exclude — so their inherited exclude is harmless. The
  fix drops only the `test` entry; no other exclusion was lost.
- **The fix works.** Ran `tsc -p tsconfig.test.json --noEmit --listFiles` per
  package and counted files under each package's own `test/`:
  quereus-store 57, quereus-sync 43, quereus-sync-client 1, sync-coordinator
  10, react-native-leveldb 2, nativescript-sqlite 2. All six compile clean.
- **The two added assertions are real, not decorative.** Read both call sites
  in full: `changeLogAfterFirst` is captured after the first apply and the new
  assertion pins the second (no-op) apply against it; `result` is the return
  of the guest→host one-way sync whose whole point is that the tombstone blocks
  the write. Both match what the surrounding comments already promised.
- **The `json-key.spec.ts` retype loses no coverage.** The `SCALARS` array
  literal is unchanged and never contained a `bigint` or `Uint8Array`; only the
  annotation narrowed. Type-level change only.

### Found and fixed in this pass (minor)

- **The sweep missed 3 of the 14 packages with a `tsconfig.test.json`.** The
  handoff's table lists 11 and claims "every package" was checked. The three
  omitted:
  - `sample-plugins` had **no `typecheck` script at all**, so
    `yarn workspaces foreach ... run typecheck` skipped the entire package —
    src *and* test. Added `tsc --noEmit && tsc -p tsconfig.test.json --noEmit`;
    both passes clean.
  - `quereus-vscode`'s `typecheck` ran only `server/tsconfig.json` and
    `client/tsconfig.json`, never its `tsconfig.test.json` — leaving its 2
    server spec files unchecked. Appended the test pass; clean.
  - `quoomb-cli` was fine (its `typecheck` *is* the test-config pass, and it
    declares its own `exclude`); no change needed.
- **`sync-coordinator`'s test config disabled the very check this ticket is
  about.** It set `noUnusedLocals: false` / `noUnusedParameters: false`,
  suppressing TS6133 — the error class that exposed both dropped assertions in
  `quereus-sync`. Pre-existing, not introduced here. Verified the package
  compiles clean with both flags on, then deleted the two overrides so it now
  inherits the base `true`.
- **Docs were stale.** `AGENTS.md` § Build & Test described the test-type-check
  arrangement but not either failure mode. Added the two rules a future agent
  needs: every package needs a `typecheck` script (foreach silently skips
  workspaces lacking one), and every `tsconfig.test.json` must repeat
  `"exclude": ["node_modules", "dist"]`, plus the `--listFiles` trick for
  telling a zero-file config apart from a clean one.

### Filed as new work (major)

- `tickets/backlog/debt-guard-test-typecheck-covers-files.md` — nothing
  *enforces* either rule. The bug has now occurred silently twice, and a new
  package or a copy-pasted config reintroduces it with no signal. Asks for a
  root-level check, wired into `yarn check`, that fails when a package with a
  `tsconfig.test.json` either has no script running it or resolves zero test
  files.

### Corrected from the handoff

- The handoff flagged "`yarn test:store` was not run" as a risk to the three
  edited `quereus-store` spec files. Mis-scoped: `yarn test:store` re-runs
  `packages/quereus` logic tests against the LevelDB store module — it does not
  run `packages/quereus-store/test/**`. Those three files run under plain
  `yarn test` (quereus-store has its own `test` script in the workspace
  fanout), and they passed. No `test:store` gap remains for this ticket.

### Checked, nothing found

- **Test-edit soundness.** Every removed binding in `sync-manager.spec.ts` and
  `plugin.spec.ts` was traced for other uses before accepting the deletion;
  none had any. The `remoteHLC.tick()` whose binding was dropped in
  `sync-protocol-e2e.spec.ts` is retained as a bare call for its clock-advance
  side effect, which is correct.
- **Tripwires: none recorded.** Nothing in this diff is of the "fine now, only
  matters if X grows" shape — the findings above are either already fixed or
  genuinely unenforced today, so they went to code/docs/a ticket rather than a
  `NOTE:` comment. The one explanatory comment the implementer left on
  `JsonGenerated` in `json-key.spec.ts` is accurate and stays.

## Validation

All run from repo root, all green:

- `yarn typecheck` — clean, exit 0. Also ran the three touched packages
  individually (`@quereus/sample-plugins`, `quereus-vscode`,
  `@quereus/sync-coordinator`) to confirm the new/changed passes execute rather
  than no-op.
- `yarn lint` — clean.
- `yarn test` — clean, zero failing across every workspace (quereus 7765 +
  1176, quereus-sync 594, sync-coordinator 134, quereus-sync-client 52, plus
  the store, isolation, plugin, quoomb-cli and quoomb-web suites). Nothing
  skipped or disabled.
- Per-package `tsc -p tsconfig.test.json --noEmit --listFiles` file counts, as
  listed above — the regression check specific to the inert-config bug.

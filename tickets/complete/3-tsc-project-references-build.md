description: The monorepo now builds with dependency-aware, incremental TypeScript project references (`tsc -b`) instead of a hand-ordered 16-step chain.
files:
  - tsconfig.build.json (root solution config; `files: []` + references to all 13 library packages)
  - package.json (root `build` now `yarn clean && tsc -b tsconfig.build.json && yarn build:ui && yarn build:vscode && yarn build:web`)
  - packages/*/tsconfig.json (13 library packages: +composite where missing, +references mapping workspace deps)
  - AGENTS.md (build-line updated to describe tsc -b — review fix)
----

## What shipped

Root `build` replaced its 16-link `yarn build:engine && …` chain with:

```
yarn clean && tsc -b tsconfig.build.json && yarn build:ui && yarn build:vscode && yarn build:web
```

`tsc -b` reads each package tsconfig's `references` array, topologically sorts the
13 pure-`tsc` library packages, and skips packages whose inputs are unchanged. The
3 bundled apps (shared-ui, quereus-vscode, quoomb-web) emit via vite/esbuild so they
stay explicit steps after the graph. Adding/reordering a library package is now a
one-line `references` edit.

See the implement commit `33fc6913` and the review section below for full detail.

## Review findings

**Checked — reference graph correctness (CONFIRMED correct).** Extracted the actual
`@quereus/*` workspace deps (`dependencies` + `peerDependencies`) for all 13 class-A
packages and diffed against each tsconfig `references` array — they match **exactly**,
every edge present, none spurious. `quereus` is a true leaf (no `@quereus/*` deps).
No reference cycles. `tsc -b --dry` derives a valid topo order.

**Checked — `composite` requirement (CONFIRMED).** `tsc -b` requires every referenced
project be `composite`. Verified: quereus/isolation carry it in their own configs;
store/sync/sync-coordinator/4-plugins had it added this ticket; sync-client already
had it; plugin-loader/sample-plugins/quoomb-cli inherit it from `tsconfig.base.json`
(`composite: true`). All covered.

**Checked — incrementality is real, not just mtime (CONFIRMED; closes ticket's own
flagged gap).** Implement only used `touch` (mtime, no re-emit). I made a **real
content edit** (`export const __reviewIncrementalProbe = 1;`) to `quereus-store/src/
index.ts` and ran `tsc -b --dry --verbose`: store went **out of date → rebuild**, its
dependents (sync, plugin-leveldb, sync-coordinator, indexeddb, rn, ns) reported "up to
date with .d.ts files from its dependencies" (they re-check store's output), while
unrelated packages (quereus, isolation, plugin-loader, sync-client, sample-plugins,
quoomb-cli) stayed untouched. Dependency-aware incrementality proven. Probe reverted.

**Checked — full validation (all green).**
- `yarn build` from clean → exit 0 (tsc -b + 3 bundled-app steps).
- `yarn lint` → exit 0.
- `yarn test` → exit 0: quereus 6896 pass / 13 pending, store 910, sync 474,
  sync-client 52, sync-coordinator 117, plus isolation/plugin/sample/quoomb suites.
  stderr in log = intentional error-path test logging, not failures.
- `tsc -b tsconfig.build.json --dry` → exit 0, clean topo order.

**Checked — build artifacts / clean (CONFIRMED).** `tsconfig.build.tsbuildinfo` is
**never emitted** (a `files: []` solution config produces none) — the entry added to
`clean` is dead-but-harmless, matches nothing. Per-project tsbuildinfo lands at
`packages/*/dist/tsconfig.tsbuildinfo` or `packages/*/tsconfig.tsbuildinfo` (quoomb-cli),
both covered by existing clean globs. Working tree stays clean after build (dist +
tsbuildinfo gitignored).

**Fixed inline (minor) — stale doc.** `AGENTS.md` line 64 said "yarn build runs
sequential thru all packages" — no longer accurate (now dependency-ordered +
incremental). Rewrote to describe `tsc -b` + the 3 bundled-app steps.

**Correction to ticket's own reasoning — `packages/tools/planviz` (`@quereus/planviz`,
`"build": "tsc"`, deps `@quereus/quereus`).** The ticket claimed planviz is excluded
"because `packages/tools` has no package.json". planviz **does** have its own
package.json; the operative reason it's excluded is the workspace glob is single-level
`packages/*`, which never reaches the two-deep `packages/tools/planviz`. Confirmed via
`yarn workspaces list` — planviz is **not** a workspace, so it's outside `tsc -b`,
`yarn lint`, and `yarn test`. This is **pre-existing** (never in the old 16-step chain
either) and whether it *should* be built is a product decision — not a regression of
this ticket. Left as-is; noted here so a future editor knows planviz is an orphaned
buildable package (if it's meant to build, add it to `workspaces` **and**
`tsconfig.build.json`).

**Tripwires (recorded, not filed as tickets):**
- `composite` + `--noEmit` coexistence in the `tsconfig.test.json` gates is
  TS-version-dependent (works on pinned TS 5.9.3; TS5069 has flip-flopped across
  majors). No single code site owns it — parked as a `## Known gaps` bullet in the
  implement handoff and re-noted here. First thing to break on a TS major bump.
- `pub:*` publish order is now decoupled from the derived build order — parked as a
  `//pub` NOTE comment at the site in root `package.json`. Keep the publish list in
  dependency order by hand.

**Redundant-but-harmless (no action).** The 4 storage plugins reference `isolation`
via `peerDependencies` though their sources import only quereus + store (store already
references isolation). Edge is harmless (isolation always built first) and matches the
"map dependencies + peerDependencies" instruction. A reviewer preferring imports-only
references could trim them; not a correctness issue.

**Not exercised (noted, low risk).** `yarn test:store` (LevelDB-backed path) not run —
default memory `yarn test` only. The tsconfig changes don't alter emitted JS
semantics, so store-path behavior is very unlikely affected.

**Empty categories:** No major findings → no new fix/plan/backlog tickets filed. The
change is config-only (tsconfig + package.json scripts + one doc line), the graph is
provably correct against declared deps, and full build/lint/test pass.

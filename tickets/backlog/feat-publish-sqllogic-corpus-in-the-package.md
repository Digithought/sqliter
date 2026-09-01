---
description: |
  Ship the `test/logic` .sqllogic corpus inside the published npm package, and add the one exports
  entry that lets a consumer resolve a filesystem path into the package at all. Downstream (lamina)
  currently reads the corpus out of a sibling git checkout while running it against the published
  engine, so the two are different versions and the lane cannot run in CI. Two lines in one
  package.json; no source, build, or test change.
repro: verified
files:
  - packages/quereus/package.json          # :34 files array; :39 exports map — both lines change here
  - packages/quereus/test/logic/           # 371 .sqllogic files, 3.36 MiB raw / 810 KB gzipped, flat, self-contained
  - packages/quereus/test/README.md        # the `-- requires-capability:` section lamina cites as the cross-repo contract
---

# Publish the `.sqllogic` corpus in the package

Filed from the lamina board (`bug-sqllogic-corpus-read-from-sibling-checkout-not-the-pinned-engine`).

## Why lamina is asking

Lamina runs the `.sqllogic` conformance corpus against its own storage backend — 371 files, the
largest single body of behavioral coverage it has. Since lamina moved `@quereus/*` from `portal:`
sibling pins to published npm deps, the engine comes from `node_modules` but the corpus is still read
by walking five directories up into `../quereus/packages/quereus/test/logic`.

Consequences on lamina's side:

- The corpus and the engine under test are **different versions**. It is green today only because that
  developer's sibling checkout happens to sit exactly on `v4.18.0`.
- Two developers on the same lamina commit get different results.
- **In CI there is no sibling checkout at all**, so `readdirSync` throws before a single test
  registers. Lamina's largest conformance lane cannot act as a gate.

Shipping the corpus in the tarball makes corpus and engine inseparable by construction: same
`node_modules/@quereus/quereus` the test imports `Database` from, same version, pinned by one lockfile
entry.

## The change — two lines, both in `packages/quereus/package.json`

**1. `files` (line 34)**

```json
"files": ["dist", "!dist/test", "!**/*.tsbuildinfo", "test/logic/*.sqllogic"]
```

Use the glob, not a bare `"test/logic"` directory entry — the directory also holds
`change-scope.spec.ts` (20 KB), which should not ship. Optionally add `"test/README.md"`, whose
`-- requires-capability:` section lamina's `sqllogic/capabilities.ts` cites as the cross-repo contract.

**2. `exports` (line 39) — load-bearing and non-obvious**

```json
"./package.json": "./package.json"
```

Without this, **no consumer can resolve any path into the package.** Verified against the real
installed 4.18.0 from lamina's tree:

```
createRequire(...).resolve('@quereus/quereus')               => ERR_PACKAGE_PATH_NOT_EXPORTED
createRequire(...).resolve('@quereus/quereus/package.json')  => ERR_PACKAGE_PATH_NOT_EXPORTED
import.meta.resolve('@quereus/quereus/package.json')         => ERR_PACKAGE_PATH_NOT_EXPORTED
```

The `.` entry declares only `types` and `import` conditions — no `require`/`default` — so the CJS
resolver fails even on the bare specifier, and every subpath is blocked by exports encapsulation. A
condition-free string target satisfies both resolvers. Proven against a synthetic package mirroring
this exports shape: with the entry added, `require.resolve('<pkg>/package.json')` → dirname → readdir
of `test/logic` works.

Rejected alternatives, so they are not re-tried: a trailing-slash directory export
(`"./test/logic/"`) is removed in modern Node; a pattern export (`"./test/logic/*"`) resolves
individual files but cannot be `readdir`'d, so the consumer would need an upstream-shipped manifest.

## Cost

Measured against the published 4.18.0 tarball:

| | now | with corpus | delta |
|---|---:|---:|---:|
| tarball | 3,662,072 B | ≈ 4.47 MB | **+810 KB (+22%)** |
| unpacked | 15,342,449 B | ≈ 18.87 MB | +23% |
| files | 2,186 | 2,557 | +17% |

For scale: the package already ships **4,888,665 B of sourcemaps** (32% of unpacked). The corpus is
smaller than the sourcemaps already published, and `.sqllogic` files are inert data no bundler will
pull into an application build.

A separate `@quereus/sqllogic-corpus` package was considered and rejected: it saves 810 KB and costs a
new workspace, a hand-ordered `pub:` chain step, a `docs/.stability.json` entry — and reintroduces
exactly the failure being fixed, two artifacts that can be published out of step. One tarball is
lockstep by construction.

## Acceptance

`yarn pack --dry-run` in `packages/quereus` lists 371 `test/logic/*.sqllogic` entries, and **no**
`change-scope.spec.ts`, no `dist/test`, no `*.tsbuildinfo` (the existing negations must still hold).
Then publish any version — lamina bumps its range to pick it up.

Note the negations were verified with `npm pack --dry-run` on a synthetic package; this repo publishes
via `yarn npm publish` (`scripts/publish-package.js:22`, yarn 4.12.0). Yarn Berry honors `files` with
the same semantics and already honors the existing `!dist/test` negation, so behavior should match —
but run `yarn pack --dry-run` rather than taking that on trust.

## Not required

No source change, no build change, no test change. `tsconfig.json`'s `include: ["src"]` is untouched —
`tsc` never sees `test/`, and this ticket does not ask it to.

## Downstream note

Once this lands, a corpus change can break lamina at `yarn upgrade` time — e.g. a new
`-- requires-capability:` token makes lamina's `SQLLOGIC_CAPABILITIES` allow-list hard-error on the
unknown token. That is deliberate on lamina's side and documented there as the drift detector; the
failure is loud and names the file. Today that same drift arrives silently whenever a lamina developer
pulls their sibling checkout, which is strictly worse.

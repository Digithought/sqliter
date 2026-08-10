# Release Process

## Overview

Quereus uses [bumpp](https://github.com/antfu/bumpp) for version bumping and follows semver.
Tags use the `v` prefix (e.g. `v1.0.0`).

## Release notes

Curate release notes during the cycle in an **untracked** `.release-notes.pending.md`
at the repo root (gitignored). When `yarn gh-release` runs, it uses that file as the
GitHub release body and then consumes (deletes) it. If the file is absent, the release
falls back to GitHub's auto-generated notes — so the file is entirely optional. There is
no committed `CHANGELOG.md`; the published GitHub releases are the canonical history.

## Prerequisites

- `yarn build` succeeds
- `yarn check` passes
- Clean working tree (`git status` shows no uncommitted changes)

## Quick Release

```bash
yarn release
```

This first runs `scripts/release-guard.js` — an interactive gate that prints a banner and requires you to type `yes` to confirm `yarn check` passed on this commit (it aborts on a non-interactive terminal). Only then does it run `yarn bump` (interactive version prompt, commits, tags, pushes), `yarn pub` (clean + build + publish each package), and `yarn gh-release`.

## Step by Step

### 1. Ensure a clean working tree

```bash
git status          # no uncommitted changes
git pull origin main
```

### 2. Bump, commit, tag, and push

```bash
# Interactive — prompts for version type (major / minor / patch / prerelease)
yarn bump

# Or specify the release type directly
yarn bump --release patch
yarn bump --release minor
yarn bump --release major
```

`bumpp` will:
1. Update `version` in all `package.json` files (recursive)
2. Commit the changes
3. Create an annotated tag: `v{version}`
4. Push the commit and tag to `origin`

### 3. Publish to npm

```bash
# Publish all public packages (clean + build + publish each)
yarn pub
```

Or publish individually:

```bash
yarn pub:quereus
yarn pub:store
yarn pub:sync
# etc.
```

### 4. Create a GitHub release

```bash
yarn gh-release
```

Uses `.release-notes.pending.md` as the body if present (then deletes it), otherwise
falls back to `gh release create v{version} --generate-notes`.

## Prerelease / RC

```bash
yarn bump --release prerelease --preid rc    # e.g. 1.1.0-rc.0
yarn bump --release prerelease --preid beta  # e.g. 1.1.0-beta.0
```

Publish prereleases with a dist-tag so they don't become `latest`:

```bash
# Manually publish each package with --tag next
```

## Hotfix

1. Branch from the release tag: `git checkout -b hotfix/v1.0.1 v1.0.0`
2. Apply the fix, commit
3. Bump: `yarn bump --release patch`
4. Publish: `yarn pub`
5. Merge back into `main`

## Version Alignment

All packages in the monorepo share the same version number. The `--recursive` flag in the bump script ensures this stays in sync. Do not manually edit version numbers in individual `package.json` files.

## Checklist

- [ ] `yarn check` passes (there is no CI — this local run is the only pre-publish safety net)
- [ ] `yarn build` succeeds
- [ ] `yarn test` passes
- [ ] Clean working tree
- [ ] `.release-notes.pending.md` curated (optional — omit for auto-generated notes)
- [ ] `yarn release` (or `yarn bump` + `yarn pub` separately)
- [ ] GitHub release created (`yarn gh-release`)

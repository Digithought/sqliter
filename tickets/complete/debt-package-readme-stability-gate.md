description: The build now fails if a package README's stability label disagrees with the official tier list, the same way it already did for the documentation pages; the review tightened a few comments and messages that overstated what the new check can see.
files:
  - scripts/check-docs.mjs                                  # Check E — package README banners (new); plus packageDirs() widening
  - docs/.stability.json                                    # new `packages` map, `packagesSpanning` list, `packagesNote`
  - docs/doc-conventions.md                                 # § In a package README — what the gate does and does not cover
  - docs/stability.md                                       # one paragraph under the assignment table
  - package.json                                            # the `//pub` note says the publish chain is machine-parsed
----

# Complete: gate package README stability banners

Every package `README.md` carries a `> **Stability: <Tier>** — …` banner. Until now nothing
checked that those banners agreed with the tiers recorded for the project. They do now.

## What shipped

`scripts/check-docs.mjs` grew a fifth check, **Check E — package README banners**, running
between the doc-side stability check and the size ratchet. It enforces a three-way agreement
between the tier a package's README declares, the tier `docs/.stability.json` records, and the
set of packages that actually ship:

- **Coverage.** Every package `yarn pub` publishes must be classified. The expected list is
  *derived* by parsing the root `package.json` — the `pub` script's `yarn pub:<step>` chain,
  then each step's `node scripts/publish-package.js <dir>` argument — never hand-listed. (The
  first pass at these banners hand-listed the set and missed two packages that publish.)
- **Existence.** A map entry naming a package with no `README.md` fails.
- **Form and position.** A classified package's README carries exactly one stability
  blockquote, under its `#` heading.
- **Agreement.** The banner's tier equals the recorded tier; a `packagesSpanning` package's
  banner must be the tierless `**Stability**` form and vice versa; the recorded tier must be
  one `docs/stability.md` defines.
- **No unclassified tier claims.** A stability banner in any README that the map does not
  classify fails.

`docs/.stability.json` gained two keys beside the existing `docs` / `untiered` pair:

```jsonc
"packages": {                              // package DIRECTORY -> tier
  "packages/plugin-loader": "Stable",
  "packages/quereus-store": "Beta",
  "packages/tools/planviz": "Beta",
  // ...15 entries
},
"packagesSpanning": ["packages/quereus"]   // README declares no single tier
```

Keys are directories, not npm names, because that is what locates the README and what the
banner's relative link depth is computed from. `packages/quereus` is the one package whose
banner names no tier — the engine's areas are Stable, Beta, and Experimental at once — which is
why `packagesSpanning` exists rather than a magic tier string.

A package banner is a multi-line blockquote whose clause after the em dash explains what the
tier means for *that* package, so unlike the rigid one-line doc banner it is parsed loosely:
the block is rejoined, and only the head, the closing full stop, and the correctly-depthed
`[Stability Tiers](…#tiers)` link are pinned. Everything between is free prose.

The implement pass also fixed `packageDirs()`, which read `packages/*` only and so treated
`packages/tools` as a package while making `packages/tools/planviz` invisible to *every* check
that walks packages — including link validation of its README and sources. It now descends one
level into a directory that has no `package.json`, matching the root `workspaces` globs.

## Review findings

**Checked:** the implement diff read before the handoff; the five Check E rules exercised by
fault injection; the derived publish list against the 14 `pub:*` steps; all 16 package READMEs
against the 16 map entries; every map tier against the `## Assignment` table in
`docs/stability.md`, row by row; the `packageDirs()` widening against the actual tree; all four
touched docs plus `package.json`'s `//pub` note re-read against the code; `node
scripts/check-docs.mjs`, `yarn lint`, `yarn test`.

**Minor — fixed in this pass:**

- `PACKAGE_BANNER_ISH` was a verbatim duplicate of Check D's `BANNER_ISH`. Deleted;
  `packageBannerBlocks` opens on the shared constant, whose comment now says both checks use it.
- The `headerWindow` NOTE was wrong about its own bound. It claimed a banner's *length* eats
  the six-line window and that `packages/quereus/README.md` "spends five of the six". Only the
  banner's **opening** line is tested against the window, so length is irrelevant and quereus
  spends two. Verified empirically: three badge lines above a seven-line banner still pass; the
  bound bites at six non-blank lines above the banner's opening line. Comment corrected, and a
  self-test now pins both sides of the bound — vacuity-checked by raising 6 to 8, which makes it
  fail.
- The unclassified-banner rule's comment said it scans "anything else under `packages/`", but
  the loop also covers the repo root `README.md`; its failure message told the reader to
  "classify its package", which is meaningless for the root README. Both reworded.
- `docs/doc-conventions.md` claimed "The checker tells you when you have done fewer" than the
  three edits a retier needs. It cannot — it never reads the assignment table. Replaced with an
  honest statement of which two of the three are pinned.

**Major — filed as new tickets:**

- `backlog/debt-stability-table-machine-readable` — the `## Assignment` table in
  `docs/stability.md` is prose to the checker. Banners and the JSON maps are now pinned to each
  other, but editing a tier in that table alone leaves the build green and the table
  disagreeing with the banners. Pre-existing on the doc side too; the gates made it the only
  place drift can still hide.
- `backlog/debt-check-docs-script-too-large` — `scripts/check-docs.mjs` is 1,180 lines running
  five unrelated checks. The functions inside it are small and well named; the file is not.

**Tripwires — parked, not filed:**

- A package that carries a README, does not publish, and is not in the map is silently exempt —
  the rule catches a *claimed* tier, not a missing one. Confirmed by injection. Every package
  README today is classified, so there is nothing to exempt; noted as a `NOTE:` at the rule's
  site in `checkPackages`, pointing at an `untiered`-style escape list as the fix if a future
  non-publishing package needs no tier.
- The header-window bound has four non-blank lines of headroom above the worst README today —
  `NOTE:` on `headerWindow`, corrected as above.

**Checked and deliberately left alone:**

- `publishedPackages` *throws* rather than reporting through `fail` when the publish chain is
  not `yarn pub:<step>` → `publish-package.js <dir>`. The implement handoff flagged this. It
  matches `readStability`'s existing behavior for a malformed data file, the message names the
  offending step, and the build still exits non-zero — reporting through `fail` instead would
  hand back a partial package list and turn a hard stop into a silent under-check.
- `packagesSpanning` as a parallel list rather than a sentinel in the `packages` map. One
  member today; the handoff's own note is the right reading — revisit at two.
- Banner prose is unchecked. Pinning it would defeat the point of per-package wording.
- The strictness of the unclassified-banner rule (it fails a banner in a nested `src/README.md`
  and in the repo root README). This is the rule's purpose, not an overreach: a tier claim
  under no gate is what the check exists to prevent.

**Not found:** no defect in the parsing, the derivation, the classification, or the self-tests.
The implement pass's fault-injection table reproduced exactly as described, and four further
injections the handoff did not run — an unclassified README with a banner, an unclassified
README without one, a grouping directory with no `package.json`, and three header-window
shapes — behaved as analyzed. The working tree was verified clean after every injection.

## Validation

- `node scripts/check-docs.mjs` → exit 0.
- `yarn lint` → clean across all workspaces (1m18s).
- `yarn test` → all workspaces pass, zero failing (9m20s). The one `failing` string in the log
  is a `failingKv` test fixture in the sync suite, not a failure.
- `yarn build` not run: the diff touches no TypeScript, and `scripts/` sits outside every
  package's build and lint scope.

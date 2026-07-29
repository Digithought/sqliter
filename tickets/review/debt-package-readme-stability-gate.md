description: The build now fails if a package's README stability label disagrees with the official tier list, the same way it already did for the documentation pages.
files:
  - scripts/check-docs.mjs (Check E — new; plus a fix to `packageDirs()` and an updated `headerWindow` NOTE)
  - docs/.stability.json (new `packages` map, `packagesSpanning` list, `packagesNote`)
  - docs/doc-conventions.md (§ In a package README — the "nothing gates this" paragraph replaced)
  - docs/stability.md (one paragraph under the assignment table)
  - package.json (the `//pub` note now says the chain is machine-parsed)
difficulty: medium
----

## What landed

`scripts/check-docs.mjs` grew a fifth check, **Check E — package README banners**, wired
into `main()` between Check D and the size ratchet. It is the package-side mirror of Check D:
a three-way agreement between the tier a package's `README.md` declares, the tier
`docs/.stability.json` records for it, and the set of packages that actually ship.

`docs/.stability.json` gained two sibling keys next to the existing `docs` / `untiered` pair:

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
relative-link depth is computed from.

### The five rules Check E enforces

1. **Coverage.** Every package `yarn pub` publishes must appear in `packages` or
   `packagesSpanning`. The expected list is *derived* by parsing the root `package.json`:
   the `pub` script's `yarn pub:<step>` chain, then each step's
   `node scripts/publish-package.js <dir>` argument. Nothing is hand-listed — the ticket
   called this out because the first pass at the banners hand-listed the set and missed
   `@quereus/shared-ui` and `@quereus/planviz`.
2. **Existence.** A map entry naming a package with no `README.md` fails.
3. **Form and position.** A classified package's README carries exactly one stability
   blockquote, inside the header window under its `#` heading.
4. **Agreement.** The banner's tier equals the recorded tier; a `packagesSpanning` package's
   banner must be the tierless `**Stability**` form and vice versa; the recorded tier must be
   one `docs/stability.md` defines.
5. **No unclassified banners.** A stability banner in any README under `packages/` that the
   map does not classify — a nested `src/README.md`, or a package left out — fails. A tier
   claim under no gate is the thing this check exists to prevent.

### Why the banner parser is not Check D's regex

A doc banner is one rigid line. A package banner is a **multi-line blockquote with free-form
prose** — the clause after the em dash says what the tier means for *that* package (the
on-disk key encoding for `@quereus/store`, the wire protocol for the sync packages), and it
wraps across two to four lines. So `packageBannerBlocks()` collects the blockquote and joins
it, and `parsePackageBanner()` pins only the head, the closing full stop, and the presence of
`[Stability Tiers](<correct relative depth>#tiers)`. Everything between is unchecked prose.

`packages/quereus/README.md` is the one package whose banner names no tier — it reads
`> **Stability** — this package spans tiers: …` because the engine's areas are Stable, Beta,
and Experimental at once. That is why `packagesSpanning` exists rather than a magic tier
string.

## Scope note — a fix outside the ticket's ask

`packageDirs()` previously read `packages/*` only, so it treated `packages/tools` as a package
(it has no `README.md` and no `src/`) and **`packages/tools/planviz` was invisible to every
check that walks packages** — including Check A's link/anchor validation of its README and its
sources. It now descends one level into a directory that has no `package.json` of its own,
matching the `workspaces` globs in the root `package.json`. Without this, planviz could not be
covered by Check E at all. Worth a look: it widens Checks A and E, and the whole tree is still
green, but it is a behavior change the ticket did not ask for.

## Validation

**`node scripts/check-docs.mjs` → exit 0**, `Docs OK: links resolve, invariants well-formed,
sizes within ratchet, doc and package tiers declared.` Same via `yarn docs:check`.

**Fault injection — each rule was proven to bite**, mutating the tree, running the checker, and
restoring (working tree verified clean afterward with `git status --porcelain`):

| Injected fault | Reported |
| --- | --- |
| plugin-loader banner `Stable` → `Experimental` | `packages/plugin-loader/README.md:3: banner says 'Experimental' but docs/.stability.json records 'Stable'` |
| `packages/quoomb-cli` deleted from the map | *two* failures: not classified, **and** banner in an unclassified README |
| `packages/gone: Beta` added to the map | `is classified but has no README.md` |
| banner em dash → hyphen | `malformed stability banner — expected …` with the correct relative link quoted |
| `pub:newthing` added to the `pub` chain | `'packages/newthing' publishes to npm but is not classified` |
| banner written into `packages/quereus/src/README.md` | `stability banner in an unclassified README` |

**Self-tests** (`packageSelfTest`, run on every invocation like the rest of `selfTest`): the
`pub`-chain parser against an injected `scripts` object; both relative depths
(`packages/*` → `../../`, `packages/tools/*` → `../../../`); the canonical and spanning banner
forms; seven near-misses (hyphen for em dash, no space after the dash, no link, no full stop,
wrong link depth, lowercase, colon outside the bold); multi-line block rejoining;
`classifyPackages` double-classification and missing-publisher; ten `checkPackageBanner` cases
including both well-formed ones. **Vacuity-checked** — deleting the link requirement from
`parsePackageBanner` makes two near-miss self-tests fail, so the suite is not passing trivially.

**`yarn test` — all workspaces pass** (5m26s; quereus 34 + sync 134 + quoomb-web 68 + 22 and
the rest, zero failing). The `[StoreModule] Failed to rehydrate…` / `[Sync] … failed` lines in
the log are negative-path tests logging their expected errors.

**Not run, and why:** `yarn build` and `yarn lint` — this diff touches no TypeScript.
`scripts/` sits at the repo root and is outside every package's lint scope, so neither command
can see any of it. If the reviewer wants belt-and-braces, they are unaffected by the diff.

## Known gaps — please poke at these

- **The `## Assignment` table in `docs/stability.md` is still prose to the checker.** Nothing
  parses it. So banners and the JSON map are now pinned to each other, but if someone edits
  the Tooling row from Beta to Stable and touches nothing else, the build stays green and the
  human-readable table silently disagrees with fifteen banners. The *same* gap has always
  existed on the doc side (Check D never read that table either). The ticket put re-deciding
  tiers out of scope, but this is drift, not re-deciding — reviewer's call whether it wants a
  ticket.
- **Rule 5 is a judgment call.** The ticket asked only that a *published* package not be
  silently exempt. Failing on a banner in an unclassified README (including the repo root
  `README.md`, which has none today) goes further. If a nested README ever legitimately wants
  a tier, this rule is what will need loosening.
- **Banner prose is unchecked.** `> **Stability: Stable** — the moon is made of cheese. See
  [Stability Tiers](../../docs/stability.md#tiers).` passes. Pinning prose would defeat the
  point of per-package wording, but it means a copy-paste that keeps the tier word and drops
  the *right* explanation is invisible.
- **`packagesSpanning` scales badly at two entries.** With one member it reads fine. If a
  second package ever spans tiers, consider whether a per-package `"spans"` sentinel value in
  the `packages` map reads better than a parallel list.
- **The `pub`-chain parser assumes one shape.** `yarn pub:x && …`, each step calling
  `publish-package.js <dir>`. Any other publish mechanism (a direct `yarn npm publish`, a
  workspaces-foreach form) throws with a message rather than silently under-reporting — but it
  *does* throw, taking the whole docs gate down. Confirm that is the failure mode you want.
- **Tripwire parked, not filed:** the six-non-blank-line header window is close to binding for
  package READMEs — `packages/quereus/README.md` already uses five of six (logo line plus a
  four-line banner). A README that adds badges above its banner, or a five-line banner, would
  be reported as "sits below the header window". Recorded as an updated `NOTE:` on
  `headerWindow` in `scripts/check-docs.mjs`, which previously claimed the bound had no bite.

## Use cases to exercise

- Add a package to the `pub` chain without touching `.stability.json` → build must fail.
- Retier a package: edit the assignment table, the `packages` map, and the README banner.
  Doing any two of the three → build must fail (the map/banner pair, at least; see the first
  known gap for the pair the checker cannot see).
- Delete a package's README → build must fail on the stale map entry.
- Move a banner below the intro → build must fail on the header window, not on "no banner".

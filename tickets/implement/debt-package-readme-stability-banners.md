description: Someone installing one of the research-grade packages from npm reads only that package's own README, which currently says nothing about how likely the package is to change — the stability labels live in a separate docs folder they never see.
files:
  - docs/stability.md (the tier definitions and the per-area assignment table)
  - docs/.stability.json (machine-readable doc → tier map; a package → tier map would be its sibling)
  - packages/quereus/README.md (the one README that already carries the tier summary — the pattern to copy)
  - packages/quereus-sync/README.md
  - packages/quereus-sync-client/README.md
  - packages/sync-coordinator/README.md
  - packages/quereus-store/README.md
  - packages/quereus-isolation/README.md
difficulty: easy
----

## The gap

The project now publishes four stability labels — Stable, Beta, Experimental, Internal — and
every documentation page under `docs/` says which one applies to it. The main package's README
(`packages/quereus/README.md`) also carries a summary of the four labels.

None of the other fifteen packages say anything. A grep for "experimental", "beta", "alpha",
"stability", or "unstable" across the sibling package READMEs returns nothing.

That matters because a package README is what npm renders on the package page, and it is the
only thing many consumers ever read. Three of the silent packages are labelled **Experimental**
in `docs/stability.md`, meaning a breaking change may land in any release — including a patch —
with no deprecation notice and no upgrade path:

- `@quereus/sync`
- `@quereus/sync-client`
- `@quereus/sync-coordinator`

Two more are **Beta** — a breaking change may land in a minor release:

- `@quereus/store` (its on-disk key encoding is not frozen, so a format change can make an
  existing database unreadable without a migration step)
- `@quereus/isolation`

A developer who runs `yarn add @quereus/sync`, reads its README, and ships on it has been given
no signal at all.

## Expected behavior

Every published package's README states its stability label near the top, in whatever form
reads naturally there, and links to `docs/stability.md` for what the label promises. The
wording and the label must agree with the assignment table in `docs/stability.md` — that table
stays the single source of truth; a README states its label and links, rather than restating the
definitions.

Worth deciding while doing this:

- Whether the package → label map should be machine-readable and checked, the way
  `docs/.stability.json` maps documentation pages to labels today. If a package's README drifts
  from the table, nothing catches it. The doc-side gate for exactly this drift is being built
  under the `docs-stability-tier-gate` ticket; a package-side equivalent would be its sibling,
  not a rewrite.
- Whether the private / non-published packages (the VS Code extension, `shared-ui`,
  `sample-plugins`, `tools`) need a label at all. They are not something a consumer installs, so
  probably not.

## Out of scope

Emitting a warning at runtime when an experimental feature is used. That is its own ticket
(`feat-experimental-feature-runtime-notice`) and crosses a behavior boundary this one does not.

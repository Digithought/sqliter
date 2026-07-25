description: Nothing today would catch a package's README stability label drifting out of sync with the official tier table, the way an automated check already does for the documentation pages.
files:
  - docs/.stability.json (existing doc → tier map; a package → tier map would be its sibling)
  - scripts/check-docs.mjs (Check D — the existing doc-side stability-banner gate; the pattern to copy)
  - docs/stability.md (the tier definitions and the per-area assignment table; unchanged, source of truth)
  - packages/*/README.md (now each carries a `> **Stability: <Tier>**` banner near the top — see debt-package-readme-stability-banners)
difficulty: medium
----

## Background

`scripts/check-docs.mjs` (Check D, added under the completed `docs-stability-tier-gate`
ticket) already fails the build if a page under `docs/` is missing its stability banner,
carries the wrong tier, or is not classified in `docs/.stability.json` at all.

Every package `README.md` that ships to npm now carries the same kind of banner — a line
reading `> **Stability: <Tier>** — ... see [Stability Tiers](../../docs/stability.md#tiers).`
near the top — added under the `debt-package-readme-stability-banners` ticket. That ticket
copied the wording by hand from the tier each package is assigned in
`docs/stability.md`'s `## Assignment` table. Nothing checks that a future edit to either
side — a package README, or the assignment table — keeps them in agreement.

## Expected behavior

A package → tier map, analogous to the `docs` map in `docs/.stability.json`, naming every
package that carries a banner and the tier it should read. A build-time check (either a
new check inside `scripts/check-docs.mjs`, or a sibling script run alongside it) that:

- confirms every published, consumer-facing package's `README.md` carries exactly one
  well-formed stability banner near the top, and that its tier agrees with the map;
- flags a package in the map whose `README.md` no longer exists, or a published package
  missing from the map entirely (so a newly added package isn't silently exempt).

Which packages the map should cover, as of the review of
`debt-package-readme-stability-banners`:

- **All fourteen packages `yarn pub` publishes** (the list is in the root `package.json`'s
  `pub` script) carry a banner and belong in the map.
- `quoomb-web` and the VS Code extension are not published to npm but are named in the
  assignment table's Tooling row and carry a banner, so include them too.
- `@quereus/sample-plugins` has no `README.md` at all and is the one intended exclusion.

Deriving the expected package list from the `pub` script rather than hand-listing it is
worth considering — the first draft of the banners ticket hand-listed it and missed
`@quereus/shared-ui` and `@quereus/planviz`, both of which do publish.

## Out of scope

Re-deciding what tier a package carries — that judgment is recorded in
`docs/stability.md`'s assignment table and mirrored in the banners. This ticket is only
about catching future drift between the two.

description: The table in the docs that says which parts of the project are stable is written as prose, so nobody notices when someone edits it and forgets to update the matching labels elsewhere.
prereq: debt-oversized-source-files
files:
  - docs/stability.md (the `## Assignment` table — the human-readable source of truth)
  - docs/.stability.json (the machine-readable `docs` and `packages` maps the build gate reads)
  - scripts/check-docs.mjs (Checks D and E — the existing banner gates)
difficulty: medium
tradeoffs: The two machine-readable halves are already pinned to each other; only the prose table can drift, and parsing it constrains how that table may be written from then on.
----

## Background

The project promises a stability tier — Stable, Beta, Experimental, Internal — for each
feature area and each shipped package. That promise is written down in three places:

1. **`docs/stability.md`, the `## Assignment` table.** The human-readable source of truth.
   One row per feature area, naming the tier and the docs that cover it. Some rows name
   packages directly ("Tooling — `quoomb-cli`, `quoomb-web`, `@quereus/planviz`,
   `@quereus/shared-ui`, the VS Code extension | Beta").
2. **`docs/.stability.json`.** The machine-readable mirror: a `docs` map from doc file to
   tier, and a `packages` map from package directory to tier.
3. **The banners themselves.** A one-line quote near the top of each `docs/*.md` and each
   package `README.md` naming that file's tier.

`yarn docs:check` pins (2) and (3) to each other in both directions: change a banner without
the map, or the map without the banner, and the build fails. That is what the completed
`docs-stability-tier-gate` and `debt-package-readme-stability-gate` tickets built.

**Nothing reads (1).** The table is prose to the checker. So editing the Tooling row from
Beta to Stable, and touching nothing else, leaves the build green while the table disagrees
with five package banners and their map entries. The reverse drift is equally invisible: add
a new feature area to the table with a tier, and no check asks whether any doc or package
carries it.

The table has always been unchecked — this is not new breakage introduced by either gate. But
the gates made the other two sides tight enough that the table is now the only place drift can
hide, which is what makes it worth closing.

## Expected behavior

The assignment table becomes checkable, so that changing a tier in any one of the three places
fails the build until the other two agree.

Two shapes are plausible and the choice is part of the work:

- **Parse the table.** Each row already has a fixed column layout (area | tier | docs). A
  parser could extract each row's tier and the doc links in its third column, and require that
  every doc named in a row carries that row's tier — with an explicit escape for the rows that
  deliberately differ (a doc carrying a *section banner* for a sub-area at a different tier,
  which `sql-ddl.md` and `runtime.md` already do). Note the project rule against half-baked
  parsers: the table's third column mixes links with prose qualifiers ("§ 2.0 (section
  banner)"), so this needs a real grammar for the column or a stricter table format, not a
  regex that mostly works.
- **Generate the table.** Make `docs/.stability.json` the single source and emit the
  `## Assignment` table from it, checked in and verified byte-for-byte by the gate. This
  removes the drift rather than detecting it, but the table's area names and its prose
  qualifiers ("Its on-disk key encoding is **not** frozen…") would have to move into the JSON,
  which is a larger change to a hand-edited file.

Either way the outcome is the same: a reviewer editing one tier is told about the other two.

## Why the prerequisite

Whichever shape is chosen, this ticket adds a sixth check to `scripts/check-docs.mjs`, which
today holds five (A through E) in a single ~1,190-line file. `debt-check-docs-script-too-large`
splits that same file into one module per check. Doing this one first means writing the new
check into the monolith and then having it moved again by the split — two edits to the same
region and an avoidable conflict. After the split, this becomes a new module alongside the
others, which is both smaller and easier to review.

## Out of scope

Re-deciding what tier anything carries. Every tier assignment agrees across all three places
today — this ticket is only about keeping it that way.

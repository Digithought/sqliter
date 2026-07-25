description: Every package Quereus publishes now says how stable it is at the top of its README, so someone reading it on the npm page sees how likely that package is to change without digging through the docs folder.
files:
  - docs/stability.md (source of truth; Tooling row extended, opening package count corrected)
  - docs/doc-conventions.md (new "In a package README" subsection describing the banner form)
  - packages/quereus/README.md (header stability block added)
  - packages/quereus-sync/README.md (Experimental)
  - packages/quereus-sync-client/README.md (Experimental)
  - packages/sync-coordinator/README.md (Experimental)
  - packages/quereus-store/README.md (Beta)
  - packages/quereus-isolation/README.md (Beta)
  - packages/plugin-loader/README.md (Stable)
  - packages/quereus-plugin-leveldb/README.md (Beta)
  - packages/quereus-plugin-indexeddb/README.md (Beta)
  - packages/quereus-plugin-react-native-leveldb/README.md (Beta)
  - packages/quereus-plugin-nativescript-sqlite/README.md (Beta)
  - packages/quoomb-cli/README.md (Beta)
  - packages/quoomb-web/README.md (Beta; banner moved under the H1)
  - packages/shared-ui/README.md (Beta; added in review)
  - packages/tools/planviz/README.md (Beta; added in review)
  - packages/quereus-vscode/README.md (Beta; added in review)
  - tickets/backlog/debt-package-readme-stability-gate.md (follow-up; exclusion list corrected in review)
----

## What landed

Fifteen package `README.md` files carry a stability banner directly under the `#`
heading, before the intro prose:

```markdown
> **Stability: Experimental** — a research track; the API, the wire protocol, and the
> stored bytes may change or disappear without notice, in any release including a patch.
> See [Stability Tiers](../../docs/stability.md#tiers).
```

The tier word and the one-line rationale come from the `## Assignment` table in
`docs/stability.md`, which stays the single source of truth. No README restates the tier
*definitions* — each one states its own tier and links.

By tier:

- **Experimental** — `@quereus/sync`, `@quereus/sync-client`, `@quereus/sync-coordinator`
- **Beta** — `@quereus/store`, `@quereus/isolation`, the four storage plugins
  (`plugin-leveldb`, `plugin-indexeddb`, `plugin-react-native-leveldb`,
  `plugin-nativescript-sqlite`), `@quereus/quoomb-cli`, `@quereus/quoomb-web`,
  `@quereus/shared-ui`, `@quereus/planviz`, the VS Code extension
- **Stable** — `@quereus/plugin-loader`
- **Spans tiers** — `@quereus/quereus`, which gets a short header block pointing at the
  four-tier table already further down that README, rather than a single tier word

`@quereus/sample-plugins` is the one package left out: it has no package-level
`README.md` to put a banner in, and it is not published.

Two docs changed alongside: `docs/stability.md`'s Tooling row now names `@quereus/planviz`
and `@quereus/shared-ui`, and `docs/doc-conventions.md` gained an **In a package README**
subsection describing how the package banner differs from a doc banner (relative link
depth, and a tier-specific clause instead of a bare link).

## Review findings

### Fixed in this pass

**Two published packages were missed.** The implement pass decided scope by judging which
packages looked "consumer-facing" and left out `@quereus/shared-ui` ("internal") and
`@quereus/planviz` ("a dev CLI tool"). The authoritative list is the root `package.json`'s
`pub` script, which `yarn pub` runs at release: it publishes fourteen packages, **including
both of these**. Their READMEs open with `npm install @quereus/shared-ui` and
`yarn global add @quereus/planviz` respectively — they are as installable as any other.
Both now carry a Beta banner, and both are named in `docs/stability.md`'s Tooling row,
which previously covered no such package and so gave them no tier anywhere. (Extending the
existing Tooling row was the least-invention option available — it already reads Beta for
`quoomb-cli` / `quoomb-web` / the VS Code extension. A maintainer who thinks either
package deserves a weaker promise can change one table row and two banners.)

**The flagship package had its tier furthest from the top.** `packages/quereus/README.md`
was left untouched on the grounds that it already carries a fuller stability section — it
does, at line ~202, under `## Current Status`. On the npm page that is far below the fold,
which is precisely the problem this ticket set out to fix, and the package a reader is
most likely to land on first. It now carries a four-line header block that states which
areas are Stable, links the existing in-README table by anchor, and invents no tier.

**`quoomb-web`'s banner sat below the intro paragraph**, not under the H1 — the only one of
the twelve placed that way. Moved.

**The VS Code extension carried no banner** although `docs/stability.md` names it
explicitly in the Tooling row. Added. While in that file: it had no `#` heading and no
`##` headings at all (every line rendered as a paragraph, "Development" and "Schema
awareness" included), and its build command read
`yarn workspace @quereus/quereus-vscode build` — that workspace does not exist; the name is
`quereus-vscode`, unscoped. Both fixed.

**`docs/stability.md` opened with "Quereus publishes sixteen packages".** There are
seventeen workspaces and fourteen of them publish. Corrected, and the sentence now names
`yarn pub` as the list to check rather than restating a number on its own.

**`docs/doc-conventions.md` documented the banner convention for `docs/*.md` only.** After
this ticket the same banner lives in fifteen package READMEs in a slightly different form,
undocumented. Added the `### In a package README` subsection, including the explicit note
that `docs:check` reads package READMEs for link integrity only, so their tiers are correct
by review and not by gate.

**The follow-up backlog ticket stated the wrong exclusions.**
`debt-package-readme-stability-gate` said the VS Code extension, `shared-ui`,
`sample-plugins`, and `tools/planviz` "intentionally carry no banner and should stay
excluded from the map" — three of those four now carry one. Rewritten to describe the
actual coverage set, and to suggest deriving the expected package list from the `pub`
script rather than hand-listing it, since hand-listing is what caused the miss.

### Checked, nothing found

- **Banner wording against the assignment table**, all fifteen. Every tier word matches its
  row; no banner redefines a tier or promises more than the table does. `@quereus/store`
  and its four storage-plugin dependents each call out the unfrozen on-disk key encoding,
  which is the concrete risk `docs/stability.md` singles out for that row —
  the implement handoff flagged this as unverified; it holds.
- **Relative link depth.** `../../docs/stability.md#tiers` from `packages/*`,
  `../../../docs/stability.md#tiers` from `packages/tools/planviz`. Check A in
  `scripts/check-docs.mjs` scans every package README and validates both the path and the
  `#tiers` anchor; it passes.
- **Banner form vs. the doc-side gate.** Check D's banner regex is anchored to `docs/*.md`
  and to the short `stability.md#tiers` link form, so the longer package banners cannot
  collide with it or accidentally satisfy it.
- **No code changed** — this ticket is markdown only, so there is no new test surface. Lint
  and the full test suite were run to confirm nothing else moved, not because this diff
  could break them.

### New tickets filed

None. Every finding was small enough to fix in this pass. The one piece of deferred work,
the automated package → tier gate, was already filed by the implement stage as
`debt-package-readme-stability-gate` and only needed its facts corrected.

### Tripwires

- `docs/stability.md`'s opening sentence hard-codes "seventeen packages, fourteen of which
  publish". That will rot the next time a package is added or dropped. Nothing checks it.
  Parked in the sentence itself, which now names `yarn pub` as the authoritative list, so a
  reader who doubts the number knows where to look. Not worth a gate of its own; the
  package → tier map from `debt-package-readme-stability-gate` would make the count
  redundant if it lands.

## Validation

- `yarn docs:check` — pass. (`docs/runtime.md`'s word-count ratchet, which the implement
  stage recorded as a pre-existing failure, was resolved by the triage commit `31d0cde0`
  before this review ran.)
- `yarn lint` — pass across all workspaces.
- `yarn test` — pass, all packages. The `Error: boom` / `batch write failed` /
  `iterate failed` / `socket write failed` lines in the log come from `quereus-sync`'s
  deliberate error-path fixtures (`failingKv`), not from failures.

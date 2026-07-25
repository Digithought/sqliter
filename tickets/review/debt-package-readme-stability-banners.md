description: Every published package's README now states its stability label (Stable, Beta, or Experimental) near the top, so someone reading it on the npm package page — not just in the docs folder — sees how likely that package is to change.
files:
  - docs/stability.md (source of truth for tier assignment; unchanged)
  - docs/.stability.json (doc → tier map; unchanged — this ticket did not add a package → tier equivalent, see below)
  - packages/quereus/README.md (existing pattern; unchanged, already carried its tier summary)
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
  - packages/quoomb-web/README.md (Beta)
----

## What landed

Twelve package `README.md` files each gained one banner line (or short block) near the
top, immediately below the `#` heading and its one-line description, before the first
`##` section. Format:

```markdown
> **Stability: Experimental** — a research track; the API, the wire protocol, and the
> stored bytes may change or disappear without notice, in any release including a patch.
> See [Stability Tiers](../../docs/stability.md#tiers).
```

The tier and the one-line rationale for each package were taken directly from the
`## Assignment` table in `docs/stability.md`, which stays the single source of truth — no
README restates the tier *definitions*, only its own tier and a link. Packages touched,
by tier:

- **Experimental** (a breaking change may land in *any* release, including a patch, with
  no deprecation notice — the original motivating gap): `@quereus/sync`,
  `@quereus/sync-client`, `@quereus/sync-coordinator`
- **Beta** (breaking change may land in a minor release): `@quereus/store`,
  `@quereus/isolation`, `@quereus/plugin-leveldb`, `@quereus/plugin-indexeddb`,
  `@quereus/plugin-react-native-leveldb`, `@quereus/plugin-nativescript-sqlite`,
  `quoomb-cli`, `@quereus/quoomb-web`
- **Stable**: `@quereus/plugin-loader`

`packages/quereus/README.md` was left untouched — it already carries a fuller
stability section (a table of all four tiers plus a link), which was the pattern this
ticket copied from; a short banner didn't fit it since that package spans multiple
tiers itself, not just one.

## Decisions made (the two things the ticket asked to decide)

1. **Scope: which packages get a banner.** The ticket's `files:` list named 5 packages
   explicitly (the ones with no signal at all on a real risk — sync x3, store, isolation),
   but its "Expected behavior" section says *every published package's README* should
   state its label. Read literally, that's broader than 5. I extended the banner to every
   package in `packages/` whose `package.json` has no `private` flag and that a consumer
   would actually install: the storage plugins (`plugin-leveldb`, `plugin-indexeddb`,
   `plugin-react-native-leveldb`, `plugin-nativescript-sqlite`, all grouped with
   `@quereus/store` under one Beta row in the assignment table), `plugin-loader` (Stable),
   and the two tooling packages `quoomb-cli` / `quoomb-web` (Beta, grouped with the VS
   Code extension under "Tooling" in the assignment table).

   Left out, matching the ticket's own suggested exclusion list: `quereus-vscode` (VS Code
   extension — installed via the marketplace, not npm), `shared-ui` (internal, not
   independently consumer-facing), `sample-plugins` (has no `README.md` at all), and
   `tools/planviz` (a dev CLI tool, not named anywhere in `docs/stability.md`'s assignment
   table).

   **This is a judgment call, not something the ticket pinned down — flag it if the
   broader scope wasn't wanted.** The risk of having gone broader: nobody explicitly
   verified `plugin-loader`, the 4 storage plugins, or `quoomb-cli`/`quoomb-web`'s wording
   beyond checking it against the assignment table by hand.

2. **Machine-readable package → tier map, to catch drift.** Not built in this ticket. The
   docs side already has this (`docs/.stability.json` + Check D in
   `scripts/check-docs.mjs`, from the completed `docs-stability-tier-gate` ticket), but a
   package-README equivalent would be new script work, not a two-line addition, so I filed
   it as a separate backlog ticket — `debt-package-readme-stability-gate` — rather than
   scope-creeping this one. Until that lands, **nothing catches a package README drifting
   from `docs/stability.md`'s assignment table**, the same gap that motivated this ticket
   in the first place, just one level down. Worth prioritizing if package READMEs get
   edited often.

## How to validate

- `yarn workspace @quereus/quereus run lint` — exit 0 (eslint + tsc typecheck; unaffected,
  since only markdown changed).
- `yarn docs:check` — one failure, **pre-existing and unrelated**:
  `docs/runtime.md: 13983 words exceeds its ratchet of 13270` (word-count ratchet on a doc
  this ticket never touched; filed to `tickets/.pre-existing-error.md` for the triage
  agent). Check A (link integrity), which does scan every package README for broken
  links, raised nothing against the 12 new `../../docs/stability.md#tiers` links.
- `yarn test` — full workspace suite, exit 0 (22 passing in the last-run package; the
  `Error: boom` / `batch write failed` / `iterate failed` lines in the log are
  intentional error-path fixtures in `quereus-sync`'s test suite, not failures).
- Manual read-through: open each of the 12 changed READMEs and confirm the banner tier
  matches the row it's grouped under in `docs/stability.md`'s `## Assignment` table.

## Known gaps for the reviewer

- The banner wording is prose I wrote per package, not copy-pasted verbatim — reasonable
  wording variance is expected, but worth checking none of the 12 accidentally overstate
  or understate what the assignment table promises (e.g. that `@quereus/store` and its
  four storage-plugin dependents call out the *unfrozen on-disk key encoding* specifically,
  since that's the concrete risk `docs/stability.md` singles out for that row).
- No automated check ties a README banner's tier to `docs/stability.md` (see decision 2
  above / the new backlog ticket) — this pass is correct by hand-verification only.
- `packages/quereus/README.md` was deliberately left as-is; if a reviewer expects it to
  also link with the exact `../../docs/stability.md#tiers` anchor form for consistency,
  it already does (line 165, in its Documentation index), so no change needed there.

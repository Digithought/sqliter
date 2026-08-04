---
description: A long section of the schema design document was moved into its own file so the document fits back under the project's documentation size limit; reviewed and accepted with small wording additions.
files:
  - docs/schema.md                                     # hub; 8397 words, `### Rename Detection` is a stub at 496-498
  - docs/schema-rename-detection.md                    # NEW satellite, 5009 words
  - docs/.doc-budget.json                              # `docs/schema.md` ratchet entry deleted
  - docs/.stability.json                               # new doc classified Beta
  - packages/quereus/src/schema/reserved-tags.ts       # two prose markers repointed
  - packages/quereus/src/emit/ast-stringify.ts         # one prose marker repointed
  - packages/quereus/README.md                         # documentation index entry (line 173)
  - tickets/.pre-existing-known.md                     # entry amended to name only docs/sync.md
difficulty: easy
---

## What landed

`docs/schema.md` was 13157 words against a 12000-word cap and a 12109-word ratchet, so
`yarn docs:check` failed — and since it is the first step of `yarn check`, nothing after it ran.
`### Rename Detection` (old lines 482-576) moved into a new satellite document, following the
hub-and-satellite pattern `docs/optimizer.md` and `docs/view-updateability.md` already use.

Result: `docs/schema.md` **8397 words**, `docs/schema-rename-detection.md` **5009** — both under
the 12000-word cap with no ratchet entry, so the doc gate no longer has an opinion about either.

- New satellite: H1 `# Rename Detection`, `Beta` stability banner, intro closing with "A satellite
  of [Schema Management](schema.md)."; every `####` in the moved text promoted to `##`.
- `docs/schema.md` keeps the original `### Rename Detection` heading with a one-line
  "Moved to …" stub, so `schema.md#rename-detection` still resolves. Wording matches the seven
  existing stubs in `docs/view-updateability.md`.
- A `## Topic documents` table added to `docs/schema.md`, listing the new satellite and the
  pre-existing `docs/view-persistence.md` (previously reachable only from the package README).
- `"docs/schema.md"` **deleted** from `ratchet` in `docs/.doc-budget.json` rather than lowered —
  an entry at ~8400 would pin the doc far below the real cap and turn the gate red on the next
  honest addition.
- `"docs/schema-rename-detection.md": "Beta"` added to `docs/.stability.json`.
- Three prose section markers repointed; `packages/quereus/README.md:173` lists the satellite.
- `tickets/.pre-existing-known.md` narrowed to `docs/sync.md` / `docs-split-sync-protocol`, which
  still owns the remaining red.

No runtime code changed — the TypeScript diff is comments only.

## Review findings

### Verified — the things a reader cannot see by reading

- **The move is verbatim.** Reconstructed the moved text from the satellite (dropped banner +
  intro, mapped `## x` back to `#### x`, H1 back to `### Rename Detection`) and diffed against
  `git show HEAD~1:docs/schema.md | sed -n '482,576p'`. Only difference is the trailing blank
  line, which the stub replaced. No prose was silently edited during the move.
- **Word counts** independently measured: 8397 / 5009 (`wc -w`), both well under the 12000 cap.
- **Anchors.** `scripts/check-docs.mjs` validates every markdown anchor, including cross-file, and
  passes on both documents. Separately checked the duplicate-slug hazard the checker's `-1`/`-2`
  suffixing creates: 49 headings in `docs/schema.md` and 7 in the satellite, zero duplicate slugs,
  so no link was silently retargeted by the removal.
- **Incoming links.** Swept every `schema.md#…` reference in the tree — `#ddl-generation`,
  `#viewschema`, `#schema-path`, `#declarative-schema`, `#event-types`,
  `#covering-structure-links` — all still resolve; none pointed into the moved range.
- **The wrapped-marker second sweep the handoff asked for.** Re-ran the `§` sweep as a *multiline*
  match (`schema.md` on one line, `§` on the next), which is the shape that hid a marker from the
  implement stage's grep. No further hits in source: the only wrapped occurrence in the tree is
  `docs/view-persistence.md:8-9`, which is correct.
- **Line endings.** Docs are LF and TypeScript sources are CRLF in this repo (`core.autocrlf=true`
  locally, no `.gitattributes`). Byte-checked every touched file for mixed endings: zero lines
  deviate from their file's convention, and blob matches working tree. The handoff's claim that
  "every file is LF" is true of `docs/` but not of the two `.ts` files it also edited — the edits
  themselves are correct either way.
- **Build, lint, typecheck, tests.** `yarn build`, `yarn lint`, `yarn typecheck`, `yarn test` all
  pass. Tests were run despite the diff being prose and comments, since the handoff had skipped
  them.

### Fixed in this pass (minor)

- **The satellite's title undersold its contents.** The document also covers tag-drift detection
  and reserved-tag validation on the declarative path — neither is rename detection, and neither
  was mentioned in the intro or in the hub's "Covers" cell. (This nesting is inherited: those were
  `####` children of `### Rename Detection` in `docs/schema.md` before the split.) Broadened the
  satellite intro and the `## Topic documents` row rather than renaming the file, since the
  filename now appears in three source comments and the README.
- **The hub table had no lead sentence** explaining what stays in `docs/schema.md` versus what
  moved, unlike `docs/optimizer.md` and `docs/view-updateability.md`. Added one.

### Filed / appended elsewhere (pre-existing, not this diff)

- Appended a second data point to `tickets/backlog/debt-check-docs-validate-section-markers`
  rather than filing a new ticket, since it already owns the site (`bareDocRefs()` in
  `scripts/check-docs.mjs` validates the `.md` half of a `docs/x.md § Section` marker and ignores
  the section half). Two arms added: the **wrapped-comment-line** extraction requirement that this
  split's own grep tripped over, and three concrete markers that name `docs/schema.md`
  §"Per-column PK key collation" — a section that has never existed there; the content is bold
  prose in `docs/store.md` around line 489. Sites: `docs/module-capabilities.md:143`,
  `packages/quereus/src/schema/table.ts:346`, `packages/quereus/test/logic.spec.ts:60`.
  (`docs/memory-table.md:557` carries the same marker pointed correctly.) Left the markers
  themselves unedited — they are stale independently of this split and outside its diff.
- **`docs/lens.md` is 124 words from turning the gate red** (18310 against a 17934 ratchet, inside
  the 500-word grace band). Pre-existing, and exactly what `docs-doc-growth-convention-and-near-cap-warning`
  is being built to warn about, so nothing new filed.
- **`yarn docs:check` is still red** on `docs/sync.md`, owned by `docs-split-sync-protocol` and
  recorded in `tickets/.pre-existing-known.md`. Expected; no `.pre-existing-error.md` written.

### Tripwires (parked, not ticketed)

- **Stubs are invisible to the link checker.** `yarn docs:check` cannot tell a link deliberately
  left pointing at a stub from one that should have been retargeted and was not, so a future
  editor can link `schema.md#rename-detection` and get a one-line stub with a green gate.
  `docs/view-updateability.md` already carries an HTML `NOTE` comment saying this above its own
  topic table; added the same comment above `docs/schema.md`'s. Nothing to do until someone edits
  the hub — which is exactly when they will read it.

### Checked and clean — no findings

- **Structure and flow of the reduced hub.** Listed all 33 headings; the sequence
  (key types → API → schema path → events → errors → declarative schema → aggregate algebra)
  reads without a hole where the section was removed, and the neighbouring `### Migration Order` /
  `### Module Batch Hooks` still make sense with the stub between them.
- **`docs/.stability.json`** — new entry present, tier `Beta` matches the banner in the file, and
  ASCII-sorted correctly (`schema-` before `schema.`).
- **Convention conformance** of the new document against `docs/doc-conventions.md`: H1, stability
  banner, index entry in `packages/quereus/README.md`. All enforced by the checker, which passes.
- **Source hygiene** — nothing to report. The TypeScript diff is three comment edits; no function
  was added, moved, or grown, and no file changed size meaningfully.

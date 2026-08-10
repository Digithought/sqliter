description: The 28,000-word SQL reference manual was split into six per-topic pages, with the original page turned into a short table of contents that links to them.
prereq:
files:
  - docs/sql.md (hub — §1, Topic documents table, §10 errors, §11 Quereus-vs-SQLite, §12 EBNF)
  - docs/sql-select.md, docs/sql-dml.md, docs/sql-ddl.md, docs/sql-views.md, docs/sql-functions.md, docs/sql-txn.md (satellites)
  - docs/.doc-budget.json, docs/.stability.json
  - docs/todo.md (§11.4 roadmap relocated here)
difficulty: medium
----

## What shipped

`docs/sql.md` (was 28,745 words) split into a 3,996-word hub + six topic satellites.
Split only — section text moved **verbatim**, anchors preserved via `##`/`###` depth
promotion. Hub keeps §1, the `## Topic documents` table, and the three cross-cutting
appendices (§10 Error Handling, §11 Quereus vs. SQLite, §12 EBNF Grammar). Each moved
top-level section (§2–§9) left a one-line stub in the hub so old `sql.md#<anchor>` links
still resolve. §11.4 Future Roadmap (forward-looking only) relocated to `docs/todo.md`.

See the source ticket / implement commit `1b332307` for the full section→file map.

## Review findings

Adversarial pass over the implement diff (commit `1b332307`), read before the handoff summary.

**Checked — clean:**

- **Heading completeness.** Slug-set diff of `git show HEAD~1:docs/sql.md` vs. the union of
  the 7 new files: the *only* heading missing is `11.4 Future Roadmap`; the *only* additions
  are the 6 satellite H1 titles + `Topic documents`. Nothing dropped or silently retitled.
- **§11.4 relocation.** Content landed in `docs/todo.md` under "Language roadmap (relocated
  from the SQL reference §11.4)" — verbatim, all three bullets intact.
- **Cross-file anchor links.** `scripts/check-docs.mjs` validates cross-file `.md#anchor`
  targets (checker line ~297). Green for everything this ticket touched — every markdown link
  resolves.
- **Inbound anchored links from other docs.** All 9 (`architecture`, `schema`, `usage`,
  `view-updateability`, `vu-operators`, `vu-setops`) point at **satellites**, not hub stubs —
  they land on real content, not the safety-net stubs.
- **Config.** `docs/.doc-budget.json` sql.md ratchet removed; `docs/.stability.json`
  classifies all 6 satellites + hub as `Stable`.

**Found — fixed inline (minor):**

- **Cross-file prose section references.** The implementer flagged (and punted) plain-text
  "see section N" refs that now cross a file boundary — the checker can't see these, they
  aren't markdown links. Found 7 real ones and converted them to proper cross-file links:
  - `sql-dml.md` ×3: `(see section 2.6.2)` → `[§2.6.2 Mutation Context](sql-ddl.md#262-mutation-context-table-level-parameters)`
  - `sql-dml.md` ×3: `(see section 2.1.1)` → `[§2.1.1 Schema Search Path](sql-select.md#211-schema-search-path-with-schema)`
  - `sql-select.md` ×1: `(see section 2.1.1)` → same-page `[§2.1.1 Schema Search Path](#211-schema-search-path-with-schema)`
  Re-ran `check-docs.mjs` after the edit — new links resolve, no new failures.
  Remaining bare `§N` prose refs (`sql-ddl.md` §2.6.3 / §2.7, `sql-select.md` ISO SQL-2016
  §7.14) are same-file or external-standard — left as-is.

**Tripwire (recorded, not a ticket):**

- **Stub anchors duplicate satellite anchors.** `docs:check` cannot distinguish a link
  deliberately left on a hub stub from one that should retarget to satellite content. Parked
  as an HTML `NOTE:` comment under `## Topic documents` in `docs/sql.md` (mirrors the MV/VU
  splits). No inbound link currently lands on a stub, so this is latent guidance only.

**Not filed (empty categories, with reason):**

- **No major findings** → no new fix/plan/backlog tickets. The change is a verbatim
  documentation move with config updates; no source, specs, or runtime behavior touched.

## Pre-existing failures (not this ticket)

`node scripts/check-docs.mjs` reports 3 size-ratchet failures — `docs/runtime.md` (+363),
`docs/schema.md` (+339), `docs/sync.md` (+195) — all over-ratchet **at HEAD** and untouched
by this ticket. Already tracked in `tickets/.pre-existing-known.md` under in-flight slug
**`docs-megadoc-ratchet-overage`**, so not re-reported and no `.pre-existing-error.md` written.

## Validation run

- `node scripts/check-docs.mjs` — green for all files this ticket touched (only the 3
  pre-existing ratchet failures above remain).
- `yarn lint` / `yarn test` were **not** re-run this pass: the review changes are
  markdown-only link-text edits with no source/spec/config impact, and the implementer's diff
  already passed both green. `docs:check` is the relevant gate for a docs move and it passes.

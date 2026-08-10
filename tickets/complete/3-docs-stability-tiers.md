description: Published a page defining four stability labels (Stable, Beta, Experimental, Internal), labeled every user-facing documentation page with one, and summarized the labels in the package README so a reader can tell which features are safe to build on.
files:
  - docs/stability.md (NEW — tier definitions + per-area assignment table)
  - docs/.stability.json (NEW — machine-readable doc→tier map for the follow-on gate)
  - docs/doc-conventions.md (§ The stability banner — new)
  - docs/store.md (§ Isolation Gap — honesty paragraph on what @quereus/isolation actually guarantees)
  - docs/.doc-budget.json (six ratchet entries raised)
  - packages/quereus/README.md (§ Current Status → ### Stability; ## Documentation index entry; three capability bullets tagged)
  - 37 × docs/*.md (one header banner each); 4 of those also carry a section banner
  - scripts/check-docs.mjs (read-only — run, not edited)
difficulty: medium
----

## What landed

A labeling change only. **No feature's behavior changed**; not one line of `packages/*/src`
was touched.

**`docs/stability.md`** (new) is the canonical home. It opens by stating the load-bearing
distinction — a tier says *how much a future release may break you*, and says nothing about
whether a feature computes the right answer today; **a wrong answer is a bug at every tier,
including Experimental**. It works that through the two Experimental parallel-track optimizer
rules (`rule-fanout-lookup-join.ts`, `rule-async-gather-zip-by-key.ts`) that are registered in
`planner/optimizer.ts` and fire on ordinary user `select`s, and through the functional-dependency
framework (Internal, but soundness-guarded by property tests). Then `## Tiers` with one `###` per
tier and the promise table, the full per-area assignment table, and the three edge calls (views
split Stable/Beta; declarative schema Beta inside a Stable `sql.md`; FD framework Internal).

**`docs/.stability.json`** is the machine-readable form: `tiers`, a `docs` map, and an
`untiered` list. Together they name all 50 `docs/*.md` — every doc on disk except the two frozen
review artifacts (`review.md`, `review.html`). 37 tiered, 13 untiered.

**Banners.** Every doc in the `docs` map carries exactly one header banner, directly under its H1:

```markdown
> **Stability: Experimental** — see [Stability Tiers](stability.md#tiers).
```

Four docs also carry a **section banner** overriding the header tier for one section:

| Doc | Doc tier | Section | Section tier |
| --- | --- | --- | --- |
| `sql.md` | Stable | `### 2.0 Declarative Schema (Optional, Order-Independent)` | Beta |
| `usage.md` | Stable | `## Change-scope introspection` | Beta |
| `module-authoring.md` | Stable | `### 3. Concurrency Mode (Parallel Runtime)` | Experimental |
| `runtime.md` | Internal | `## ParallelDriver (Runtime Primitive)` | Experimental |

**`docs/store.md` § Isolation Gap** gained an honesty paragraph: `@quereus/isolation` gives
read-committed plus read-your-own-writes, is **not** snapshot isolation, and does **no**
write-write conflict detection (last flush wins).

**`docs/doc-conventions.md`** gained `## The stability banner`, recording the exact banner form,
that the tier word must match `docs/.stability.json`, that a section may override its doc's tier,
and that every `docs/*.md` lands in `docs` or `untiered`.

**`packages/quereus/README.md`**: `### Stability` at the top of `## Current Status` with the
four-row tier table and the compatibility-not-correctness sentence; the bold
`**Current capabilities include:**` line promoted to a sibling `### Capabilities` heading;
`[Stability Tiers](../../docs/stability.md)` added as the first bullet of the `## Documentation`
user docs list; and three capability bullets tagged — materialized views *(Beta)*, updatable
views *(Beta)*, logical schemas and lenses *(Experimental)*.

**Doc ratchet** raised for six docs (`lens.md`, `runtime.md`, `schema.md`, `sql.md`, `sync.md`,
`view-updateability.md`) — the banner is 7 checker-words, and `sql.md` / `runtime.md` took +14
because each also carries a section banner.

## Review findings

### Verified independently (not taken from the handoff)

- **Three-way agreement (banners ↔ `.stability.json` ↔ disk).** Re-derived from scratch:
  51 `docs/*.md` on disk = 37 tiered + 13 untiered + `review.md` (exempt). No doc missing from
  the JSON, no entry naming a missing file, no doc in both lists, every tier value drawn from
  `tiers`. Every tiered doc carries exactly one header banner in the 3-line window under its H1,
  and its tier word equals its JSON value. No untiered doc carries a banner outside a fence.
  Exactly four section banners exist, on the four sections the handoff names, with the tiers it
  names. Clean.
- **Factual claims in `docs/stability.md`.** "Sixteen packages sharing one version" — confirmed:
  16 `package.json` files under `packages/` (the seventeenth entry, `tools/`, has none), all at
  `4.3.1`. `ruleFanOutLookupJoin` and `ruleAsyncGatherZipByKey` are both registered
  unconditionally in `planner/optimizer.ts` (lines 481, 879) — cost-gated at plan time, not
  opt-in — so the "a plain `select` cannot opt out" framing is accurate.
  `query_plan()` / `scheduler_program()` / `execution_trace()` all exist in
  `func/builtins/explain.ts`. `test/declarative-equivalence.spec.ts` exists; the Key Soundness
  property tests live in `test/property.spec.ts`. `scripts/check-docs.mjs:34` does exempt
  `review.md` / `review.html` from every check, as the doc claims.
- **The `store.md` isolation paragraph — the handoff's own #2.** It does *not* over-claim.
  Read `packages/quereus-isolation/src/flush.ts`: the flush path writes overlay rows with
  `preCoerced: true, trustedWrite: true` and decides insert-vs-update purely on whether the PK
  already exists underlying — it re-checks nothing and detects no concurrent writer. The
  `conflict` machinery in `isolated-table.ts` is PK/UNIQUE *constraint* checking against the
  merged view at write time, which is a different thing from write-write conflict detection.
  "Last connection to flush wins" is exactly right, and matches
  `packages/quereus-isolation/README.md` §§ Features and Isolation Level.
- **The `### Capabilities` heading — the handoff's own #3.** `## Current Status` is unchanged,
  and nothing in-repo links to `#current-capabilities`. Confirmed no in-repo breakage; an
  external inbound link is out of scope for any check we have.

### Fixed in this pass (minor)

- **`docs/stability.md` — the store row contradicted the Beta promise.** The tier table says a
  Beta stored format "may change, with a documented upgrade path"; the store row said the on-disk
  key encoding "is **not** frozen" and stopped there. There is no format-version marker anywhere
  in `packages/quereus-store` and no migration tooling in the repo, so the Beta cell was
  promising something the project cannot currently deliver. Rewrote the row to say the encoding
  carries no format-version marker and has no in-place upgrade tooling today — a format change
  would ship with a documented migration procedure, not be applied for you. Keeps the tier at
  Beta (the handoff's #1 asked whether Beta is strong enough; it is, once the promise is stated
  honestly) and removes the contradiction.
- **`docs/doc-conventions.md` — "Every `docs/*.md` appears in one list or the other" was false.**
  `review.md` and `review.html` appear in neither, by design. Added the exemption clause, so the
  convention matches both `.stability.json` and `check-docs.mjs`.

### Filed as a new ticket (major)

- **`backlog/debt-package-readme-stability-banners`.** The tiers reach `docs/` and
  `packages/quereus/README.md` and stop there. The other fifteen package READMEs say nothing —
  a grep for "experimental|beta|alpha|stability|unstable" across them returns zero hits. Three
  of the silent ones (`@quereus/sync`, `@quereus/sync-client`, `@quereus/sync-coordinator`) are
  **Experimental**, and a package README is what npm renders. This is a real coverage hole in
  the feature the ticket set out to deliver, not a nit, and it is outside the diff's scope, so
  it gets its own ticket rather than an inline fix.

### Checked and found nothing wrong

- **Tier assignments (the handoff's #1).** Spot-checked the three it flagged.
  `schema.md` → Beta and `module-authoring.md` → Stable both survive scrutiny: the split between
  a Stable `VirtualTableModule` / `getBestAccessPlan` contract and a Beta `SchemaManager` is
  coherent, since the former is what a plugin *implements* and the latter is what it *calls into*,
  and only the latter is still moving. `store.md` → Beta is defensible once the format caveat is
  stated plainly (fixed above). The three edge calls in `## Three edge calls` are internally
  consistent with the assignment table. No change.
- **The follow-on gate's fenced-banner gotcha.** The handoff parks a warning that
  `doc-conventions.md` and `stability.md` each contain a banner line inside a fenced code block,
  so a naive line-scan will misfire. `tickets/implement/3.5-docs-stability-tier-gate.md` already
  covers this at lines 86–87 and 111–112, naming `stripFences` explicitly. No ticket needed; the
  warning is redundant, which is the good outcome.
- **Link and anchor integrity.** `node scripts/check-docs.mjs` → `Docs OK` both before and after
  my edits. The relative path in `packages/quereus/README.md` (`../../docs/stability.md`) is
  outside the checker's scan but resolves correctly by hand.

### Recorded as tripwires, not tickets

- **A section banner marks a start, not a range.** `runtime.md`'s Experimental banner sits on
  `## ParallelDriver (Runtime Primitive)` and is intended to cover its `###` children; nothing in
  the file says where the override ends. Same shape in the other three section-bannered docs.
  This is fine today because a human reads scope from the heading tree — it only becomes work if
  something needs to attribute an arbitrary line to a tier. Parked where the reader will meet it:
  `tickets/implement/3.5-docs-stability-tier-gate.md` § "Section banners are valid, not mapped"
  (line 71) already declines to map them, which is the correct non-decision. Not filed.
- **`FanOutLookupJoinNode` has no doc of its own.** It is named Experimental in the assignment
  table and covered by `runtime.md`'s Experimental section, but a reader arriving from
  `optimizer-joins.md` (Internal, no section banner) finds no banner saying so. Harmless — the
  `optimizer-*.md` docs are Internal throughout, so no compatibility promise is made either way.
  Recorded here only; no code site to annotate and no doc change warranted.
- **Five docs sit within a few hundred words of a freshly-raised ratchet.** The next
  banner-shaped convention will need its own `--force`. `docs/stability.md` itself is ~1,050
  words against a 12,000-word cap, so it has room. Noted in
  `docs/doc-conventions.md` § The size ratchet's existing guidance; no action.

### Explicitly not covered

- **Whether to freeze the parallel track** is a product call the plan reserved for a human, and
  declaring its tier does not force it. Untouched by design.
- **External inbound links** (npm page, blog posts) to `#current-capabilities` cannot be checked
  from inside this repo. Accepted.
- `docs/review.md` and `docs/review.html` were not opened or modified.

## Validation

- `node scripts/check-docs.mjs` → `Docs OK: links resolve, invariants well-formed, sizes within
  ratchet.` Run before my edits (confirming the implement commit's own claim) and after.
- Three-way agreement re-derived independently — see above. `OK: 51 md on disk, 37 tiered,
  13 untiered, 1 exempt; 4 section banners, all matching.`
- `yarn lint` → clean across all seventeen workspaces (`packages/quereus` eslint + `tsc -p
  tsconfig.test.json`; every other package's intentional no-op). 29s.
- `yarn test` → **8,775 passing, 0 failing** across every workspace. 3m30s. Run despite the diff
  touching no source, to confirm a clean baseline for the review; nothing regressed and nothing
  pre-existing is broken.
- `yarn test:store` / `test:full` not run: no store code changed, and the suite is well past the
  ten-minute idle window.

## Ratchet-raise justification — for the commit body

> Raised the doc ratchet for six docs: the stability-banner convention adds one
> header line to every user-facing topic doc. See docs/doc-conventions.md § The size
> ratchet.

## End

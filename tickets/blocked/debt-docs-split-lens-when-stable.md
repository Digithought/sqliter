----
description: One design document is far over the project's size limit and every other oversized document has been split, but this one describes a feature that is still being redesigned; this asks a human whether that feature has settled down enough to split its docs now, or should stay exempt.
files:
  - docs/lens.md (~17,900 words — the document in question)
  - docs/.doc-budget.json (its grandfathered size entry: docs/lens.md = 17934)
  - docs/.stability.json (docs/lens.md is classified Experimental)
  - docs/doc-conventions.md, scripts/check-docs.mjs, docs/invariants.md (the split machinery, for when the answer is yes)
----

**Blocked — category (a): a decision only a human should make.** It unblocks when someone
who knows where the lens feature is headed answers: *is the lens design settled enough that
splitting its documentation now is worth doing, or does it keep its exemption?* Only someone
with visibility into the feature's roadmap can answer that; no amount of further research
resolves it.

## Background, for a reader with no context

Quereus caps documentation files at 12,000 words, enforced by a build check
(`yarn docs:check`). Files that were already over the cap when it was introduced are
**grandfathered**: their current size is recorded in `docs/.doc-budget.json`, and they may
shrink but never grow. `docs/lens.md` is one of these, at roughly 17,900 words.

A **lens** — the thing that document describes — is a layered logical schema: a way to
present the same stored data under a different declared shape. It is the most speculative
subsystem in the repository, classified `Experimental` in `docs/.stability.json`, and it is
still actively being designed.

The other two oversized documents (the SQL reference and the view-updateability doc) were
already split by `debt-docs-shrink-remaining-megadocs`. That effort deliberately left lenses
alone. This ticket is that deferral, made explicit.

## The question, plainly

Split `docs/lens.md` now, or leave it grandfathered until the lens design stops moving?

The argument for waiting: you split a document along the seams its subject has *today*, and
a subject that is still being redesigned gives you new seams next month — so you split, then
re-split, and get churn instead of clarity. There is a second reason specific to this
document: project convention (`docs/doc-conventions.md`) says narrative history gets deleted
during a split, but for a design still in motion the "we tried X and moved to Y" record is
genuinely load-bearing, and a split is exactly when it would be thrown away.

## What happens if we do nothing

Nothing degrades. The grandfathered entry does its job: the document cannot grow, so it
cannot get worse, and the build stays green. The cost is that the largest design document in
the repo stays hard to navigate, and it stays the one exception to a rule now applied
everywhere else.

## Options

1. **RECOMMENDED DEFAULT — keep it exempt; revisit on a condition, not a date.** Promote this
   work when *either* `docs/lens.md` graduates out of `Experimental` in `docs/.stability.json`
   (to Beta or Stable — i.e. the design has stopped moving), *or* the grandfathered ceiling
   becomes a genuine obstacle (someone needs to add material and the ratchet blocks them).
   Lowest cost, and it protects the design history while it is still useful.
2. **Split it now anyway.** Buys consistency with the other documents and a navigable file
   immediately. Costs a re-split later if the design shifts, and forces a call on how much
   history to keep.
3. **Raise or drop its budget entry and stop treating it as debt.** Honest if we accept that
   this document is simply going to be long. Weakens the size rule by carving out a permanent
   exception.

## How reversible is this call

Cheaply reversible in both directions — this is documentation, not code or stored data.
Choosing to wait costs nothing but continued awkwardness. Choosing to split and regretting it
means re-splitting later, which is real work but bounded and carries no runtime risk. The one
genuinely lossy step is deleting narrative history during a split; if option 2 is chosen,
keep the rejected-alternatives rationale rather than discarding it wholesale.

## What the future pass will do, when the answer is yes

By then the split machinery will be well-proven (it will have shipped on the optimizer,
materialized-view, view-updateability, and SQL-reference docs). Follow the recipe written down
in `docs/doc-conventions.md`:

- Treat it as a **design doc** (it is) → split **and** add invariants. Split along the
  boundaries `lens.md`'s own outline already suggests — roughly: *What a Lens Is / Schema
  Kinds / The Lens Slot*, *The Default Mapper + module mapping advertisement*, *Sparse
  Overrides*, *Constraint Attachment*, *Computed and Generated Columns + round-trip proving*,
  *Deployment Is a Compile Step*. Measure before committing to file boundaries.
- Cut at headings, promote depth by one, leave a stub plus link, sort prose into
  invariant / rationale / history, delete the history (keeping the rejected-alternatives
  rationale).
- Repoint inbound doc anchors and the `docs/lens.md § …` markers in source comments — the
  checker (`scripts/check-docs.mjs`) names them all. `lens.md` is referenced by several
  `packages/quereus/src` comments (e.g. `planner/mutation/decomposition.ts`,
  `schema/lens-prover.ts`) and by `docs/migration.md`, `docs/schema.md`,
  `docs/view-updateability.md`.
- Lower or remove the `docs/lens.md` entry in `docs/.doc-budget.json`.
- Add a `LENS-*` invariant area to `docs/invariants.md`. Unlike the view-updateability area,
  `LENS` **is** already reserved: `docs/invariants.md` carries a `## LENS — Lens` placeholder
  header (`Reserved.`) and the `INVARIANT_HEADING` regex in `scripts/check-docs.mjs` already
  lists `LENS`. The view-updateability area had to be added to that regex by
  `docs-invariants-vu` — do not assume the same is needed here; confirm against the checker at
  the time.

The round-trip / lens-law prover (`schema/lens-prover.ts`, `analyzeRoundTrip` /
`emitRoundTrip`) and the deploy-time GetPut/PutGet verdicts are the strongest `LENS-*`
invariant candidates, analogous to how the view round-trip laws anchor the view-updateability
area.

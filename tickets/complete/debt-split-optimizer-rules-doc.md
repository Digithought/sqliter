description: The optimizer rule documentation was over its size limit; the long explanatory sections were moved into a second document so the rule list has room to grow again.
files: docs/optimizer-rules.md, docs/optimizer-rule-families.md, docs/optimizer.md, docs/.stability.json, docs/invariants.md, docs/materialized-views.md, docs/optimizer-fd.md, docs/optimizer-retrieve.md, docs/types.md, packages/quereus/README.md, packages/quereus/src/planner/rules/predicate/rule-empty-relation-folding.ts, tickets/.pre-existing-known.md
difficulty: easy

## Outcome

`docs/optimizer-rules.md` had grown to 12,174 words against the 12,000-word cap that
`scripts/check-docs.mjs` enforces on any doc lacking a `docs/.doc-budget.json` ratchet
entry, so `yarn check` failed at its first step. The doc is now two:

| Doc | Contents | Words |
| --- | --- | --- |
| `docs/optimizer-rules.md` | The catalog only — one line per rule, grouped by `src/planner/rules/` subdirectory | 6,077 |
| `docs/optimizer-rule-families.md` | Materialized-view read-side rewrite, constant folding, sargable range rewrites, predicate analysis/pushdown, key-driven row-count reduction, empty-relation folding, predicate contradiction detection, DISTINCT elimination, key inference | 6,233 |

Everything from `## Materialized-view query rewrite (read side)` to end-of-file moved
verbatim; no prose was rewritten (the ticket scoped this as a move, not an edit pass).
Neither doc was added to `docs/.doc-budget.json` — both sit under the cap unratcheted.

Inbound links were retargeted in `docs/invariants.md`, `docs/materialized-views.md`,
`docs/optimizer-fd.md` (×2), `docs/optimizer-retrieve.md`, `docs/optimizer.md` (×5),
`docs/types.md`, and the header comment of
`packages/quereus/src/planner/rules/predicate/rule-empty-relation-folding.ts`. Links to
`#optimization-rules` (the catalog heading, which stayed) were correctly left alone in
`docs/architecture.md`, `docs/optimizer-fd.md`, `docs/optimizer-streaming.md`,
`docs/optimizer.md`, `docs/runtime-caching.md`, `docs/vu-operators.md`, and
`docs/optimizer-joins.md`. The new doc is registered `Internal` in `docs/.stability.json`
(same tier as the doc it split from), carries the matching banner, and is listed in
`docs/optimizer.md`'s topic-document table and the package README's docs index. The stale
`> **NOTE:**` split instruction and the `tickets/.pre-existing-known.md` entry that tracked
this failure are both gone.

## Review findings

**Verification run**

- `node scripts/check-docs.mjs` — passes (links resolve, invariants well-formed, sizes
  within ratchet, tiers declared).
- `yarn lint` — clean across all packages.
- `yarn test` — full pass, no failures. No pre-existing failures surfaced;
  `tickets/.pre-existing-known.md` is back to `(none)`.
- Verified the move is **byte-verbatim**: diffed the lines removed from
  `optimizer-rules.md` against the body of `optimizer-rule-families.md`; the only
  differences are the six catalog cross-link sentences (intentionally retargeted) and
  SQL `--` comments inside fenced blocks (an artifact of the extraction, not a real
  difference). Nothing was silently dropped or reworded.
- Checked heading-slug collisions (the risk the handoff flagged): the new doc's nine `##`
  headings all slug distinctly, and the retained doc has only `## Optimization Rules`, so
  no `-1`/`-2` suffix retargeting can occur.
- Swept every reference to `optimizer-rules` across `.ts` / `.md` / `.json` / `.mjs` in the
  repo. Every survivor points at `#optimization-rules` or at catalog-resident prose
  (`ruleSemijoinExistenceRecovery`, `rule-subquery-decorrelation`, `rule-key-set-seek`) —
  all still correct. No other doc carries an index of optimizer topic docs, so
  `docs/optimizer.md` + the package README are the complete registration surface; there is
  no `docs/README.md` to update, and `docs/doc-conventions.md` never named this doc.
- Confirmed the new doc contains no same-page `](#…)` links, so the split could not have
  stranded one.

**Minor findings — fixed in this pass**

- Six retargeted catalog sentences read `See § [X](optimizer-rule-families.md#x)`. The `§`
  with no document name is a same-page idiom and reads wrong now that the target is a
  different file; every other retargeted link in this change uses the repo's cross-doc
  form. Rewritten to `See [Rule Families § X](…)`. Two of them also had link text
  (`Inclusion-dependency reasoning`) naming a section that does not exist under that title;
  they now name the actual heading, `Key-driven row-count reduction`.
- The new doc's intro enumerated the families but omitted DISTINCT elimination and key
  inference, both of which are in the file. Enumeration completed.
- **Stale content in the moved text** (pre-existing, but this ticket touches the file):
  the IND-promotion note asserted "No consumer reads `inds` yet — … the coverage prover
  (Wave 2) reads …", a sentence that contradicts itself and contradicts
  `docs/optimizer-fd.md:231` ("The **only** consumer of `PhysicalProperties.inds` is the
  coverage prover"). Rewritten to match `optimizer-fd.md`, and the undefined "Wave 1/2/3"
  vocabulary dropped along with it.

**Major findings — none.** The change is a doc move plus link updates; there is no
behavioral surface to break, the one code file touched is a comment-only edit, and the
mechanical checker plus full test run are green. Nothing warranted a new ticket.

**Tripwire recorded** — `docs/optimizer-rule-families.md` is grouped by "needs more than a
catalog line", not by subject, so it is a grab-bag of unrelated families. That is fine at
~6,200 of 12,000 words and only becomes work if it approaches the cap again. Parked as a
`> **NOTE:**` block at the top of that doc (the same convention the original doc used to
carry its own split instruction), naming the split axis to use next time — MV rewrite /
predicate / cardinality-key — rather than an arbitrary cut point. Not filed as a ticket.

**Not checked.** The moved prose's *technical* accuracy against the optimizer source was
out of scope: the ticket scoped this as a move, the text was already reviewed when written,
and re-auditing ~6,200 words of rule documentation is a separate edit pass. The one
exception is the `inds`-consumer sentence above, which surfaced as a direct contradiction
between two docs and so was fixed.

---
description: The benchmarking documentation file was nearly at the size limit the project enforces; compressing its prose bought it room, so the question is no longer urgent but is still open — split it, or accept that it is one topic and let it keep growing.
files:
  - docs/benchmarking.md
  - scripts/check-docs.mjs
  - docs/doc-conventions.md
difficulty: medium
tradeoffs: Splitting a doc costs every existing inbound link a redirect or an edit, and a maintainer may reasonably prefer to raise the cap or record an explicit size for this one file instead — the cap is a convention, not a correctness property.
---

# Update 2026-08-20 — the urgency is gone, the question is not

`docs/benchmarking.md` was compressed in place (prose tightened to caveman register;
headings, code blocks and links untouched and verified byte-identical). It went from
**11511 words to 9669** — from 489 under the 12000-word cap to **2331 under**, and
`check-docs.mjs` no longer emits its near-cap notice.

So the build is no longer one section away from going red, and this ticket is not
pressing. It was returned to `backlog/` on that basis. What did *not* change:

- The cap still has no grace band and `docs:check` is still the first step of `yarn check`.
- Compression bought roughly one section of headroom, not a structural answer. The file
  grew 10322 → 11511 in a single ticket (the gate wiring), so the next comparable change
  spends most of what was just recovered.
- The underlying question — is benchmarking one topic or several — is untouched, and
  compressing the prose is not an argument either way.

One claim below is now known to be **wrong** and should not be relied on: this ticket
asserted that `docs/architecture.md` and comments in `packages/quereus/bench/` deep-link
into this file by anchor (`#ratio-guards`, `#regression-gate`,
`#noise-floor-when-a-delta-is-a-change`). A repository-wide search for `benchmarking.md#`
finds **no such link**. `docs/architecture.md` links the file plainly, twice, and refers to
one section by name in prose ("See *Noise floor* in the benchmarking doc"). The anchor
constraint on a split is therefore much weaker than described — still real for a reader
following a name, but not a link-checker failure waiting to happen.

# The situation

`scripts/check-docs.mjs` enforces a 12000-word cap on any documentation file that has
not been given an explicit recorded size ("ratcheted"). `docs/benchmarking.md` is
currently **11511 words** — 489 under. The check passes today, but it emits its
near-cap notice on every run:

```
docs/benchmarking.md: 11511 words, 489 from the 12000-word cap — the cap has no grace
band, so split before the next section lands
```

The cap has no grace band, and `docs:check` is the **first** step of `yarn check`, so
the contributor who trips it gets a hard build failure before anything else in the
chain runs, and has to choose between splitting the doc mid-task or force-recording a
size to get unblocked.

This is not hypothetical. The file was 10322 words before the benchmark-gate wiring
work landed and 11511 after — that change is what moved it into the notice band. There
is at least one ticket still in flight that adds to this same file
(`bench-leveldb-read-cost-outcome`, currently in `implement/`), so the remaining margin
is expected to be spent, not saved.

# What a fix looks like

`docs/benchmarking.md` covers several distinguishable topics under one roof:

- what the suite measures and how to add a benchmark
- the timing model (calibration, batching, spread, the noise floor)
- storage backends as a measurement dimension
- work counters and the reference set
- the regression gate (`yarn bench:gate`), ratio guards, and how the three speed checks
  in this repository divide the work
- the exit-code contract and the `--json` shape

The gate half — the part that actually gates a build — is the most natural seam: it is
the newest material, it is what a contributor reads when a build goes red, and it is
cross-referenced from `docs/architecture.md` and from comments in
`packages/quereus/bench/`. Where exactly the seam goes is the substance of the work.

Two constraints on any answer:

- Every inbound link must still resolve. `check-docs.mjs` validates links, and
  `docs/architecture.md` plus several `bench/` source comments deep-link into this file
  by anchor (for example `#ratio-guards`, `#regression-gate`,
  `#noise-floor-when-a-delta-is-a-change`, `#informational-rows-reported-never-gated`).
- Whatever stays behind should leave real headroom, not land at 11900.

The repository has split docs before — see the completed `docs-split-*` tickets for
optimizer costing, SQL DDL, sync protocol and isolation design — so there is an
established pattern to follow. A sibling ticket, `debt-docs-split-runtime`, describes
the same problem for `docs/runtime.md`; whoever picks up either should look at both,
because the seam-choosing judgement and any shared tooling change are the same work
twice.

The alternative — recording an explicit size for this file and letting it keep growing
— is a legitimate outcome if a maintainer decides benchmarking is genuinely one topic.
That is a decision, not a default; making it deliberately is the point of this ticket.

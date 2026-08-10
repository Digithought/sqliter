# Documentation Conventions

How to write and maintain the design docs under `docs/`. `yarn docs:check`
(`scripts/check-docs.mjs`) mechanically backs this document: it fails the build on a broken
link or dead anchor, on a malformed invariant block, on a doc that has grown past its
recorded size, and on a doc whose stability tier is unclassified or misdeclared.

The problem this exists to prevent: two docs reached 38,000 and 28,500 words. At that size
nobody re-reads a doc against the code, so it drifts, and a doc that has drifted is worse
than no doc — it confidently tells the next developer something false.

## The three vocabularies

Almost every sentence in a topic doc is one of three things. They have different lifetimes
and different homes, and mixing them is what makes a doc unmaintainable.

**Normative invariant** — a statement the *code* must satisfy. Violating it is a bug, not a
missed optimization, and you can check it against the implementation by reading one file.

> Every registered optimizer rule declares `sideEffectMode`, and the registry rejects one
> that does not (`validateSideEffectMode`, `planner/framework/registry.ts`).

**Rationale** — why the design is shaped this way, including why *not* the alternatives.
Not checkable against code, but load-bearing: it stops the next person re-litigating a
settled call.

> "There is exactly one maintenance model — row-time — and no refresh-policy knob… The
> user never reasons about *when* the view is consistent." (`materialized-views.md`)

**Narrative history** — how the code got here. To a reader who does not already know it is
a changelog entry, it reads as current truth.

> "Historically 'same module ⇒ one atomic commit' did **not** hold even within the store
> module — a per-store `batch()` loop could tear a source and backing apart…"
> (once in `materialized-views.md`; deleted)

## Where each one goes

| Kind | Home |
| --- | --- |
| Normative invariant | The repo-wide register, `docs/invariants.md` |
| Rationale | The topic doc, including a `### Rejected alternatives` section |
| Narrative history | **Nowhere.** Delete it. |
| Future / planned work | `docs/todo.md`, or a ticket in `tickets/backlog/` |

**History is deleted, not archived.** Do not create `docs/archive/`. The project already
keeps two histories — `git log`, and `tickets/complete/`, which holds a written account of
every change. A third copy is a third thing that has to be kept true, and it will not be.

**The one exception is a rejected alternative.** When a passage says "we now do X; we used
to do Y" *and* gives the reason Y was wrong, that reason is rationale, not history — nobody
recovers it by grepping deleted text. Condense it to a single bullet under
`### Rejected alternatives` in the topic doc, and delete the rest of the passage.

**Future work leaves the docs.** A doc describing an unimplemented capability is
indistinguishable, to a reader, from a doc that has drifted. Move the passage to
`docs/todo.md` or a backlog ticket; leave at most a one-line pointer under
`## Current limitations`.

## The invariant register

`docs/invariants.md` is one file, read end-to-end against the code in one sitting. That is
the whole point of it — an invariant buried in the middle of a 38,000-word doc is an
invariant nobody audits.

**The register is the normative text.** A topic doc explains an invariant; the register
states it. When the two disagree, the register wins and the topic doc is the one to fix. A
topic-doc section an invariant summarizes carries a one-line
`> **Invariant:** [OPT-014](invariants.md#opt-014--an-attribute-id-is-originated-exactly-once)`
back-link near its heading, and does not restate the invariant. Back-links use the **full**
heading slug — an invariant heading's em dash slugifies to a double hyphen, so the short
`#opt-014` form does not resolve. `selfTest()` in the checker pins that form.

Copy the shape of an existing entry rather than working from a grammar restated here; the
checker's Check B is the source of truth. It enforces that each entry:

- has a heading `### <AREA>-<NNN> — <title>`, where `<AREA>` is one of `OPT`, `MV`, `VU`,
  `RT`, `SCH`, `SYNC`, `LENS`. IDs are unique, and ascend within an area. Gaps are fine — a
  retired invariant's number is never reused.
- carries at least one `code:` line and **exactly one** `guard:` line. `guard: none — <reason>`
  is legal; a bare `guard: none` is not, because the reason is the point.
- names, on every `code:` / `guard:` / `doc:` line, a file that exists — and where the line
  ends in a `` `symbol` ``, a symbol that still appears in that file.
- states itself in **120 words or fewer**. An invariant you cannot state in 120 words is two
  invariants, or it is rationale wearing an invariant's clothes.

The checker validates *pointers*, not semantics: it asserts an invariant still names a real
file and a real symbol, never that the invariant holds. Pointer rot is the drift that
actually happens; semantic verification is what tests are for.

## The stability banner

Every user-facing feature doc declares which stability tier it belongs to, so a reader
knows how much a future release may break them before reading a line of the doc. The tier
definitions and the per-area assignment live in [Stability Tiers](stability.md); a doc
*states* its tier and *links* the definitions rather than restating them — the same
discipline as the invariant back-link above.

A tiered doc carries exactly one banner, directly under its `#` heading and before the intro:

```markdown
# View Updateability

> **Stability: Beta** — see [Stability Tiers](stability.md#tiers).
```

The tier word is one of `Stable`, `Beta`, `Experimental`, `Internal`, and must match the
doc's entry in `docs/.stability.json`, which is the machine-readable form of the same map.

A **section** may override its doc's tier by carrying the same banner under that section's
heading — that is how `declare schema` is marked Beta inside the Stable `sql-ddl.md`. The header
banner states the doc's predominant tier; section banners are the exceptions, and there is
never more than one banner in the window below the H1.

Contributor and process docs — this one, `architecture.md`, `invariants.md`, `releasing.md`,
the design notes — carry no banner and are listed under `untiered` in `docs/.stability.json`.
Every `docs/*.md` appears in one list or the other, except the frozen review artifacts
(`review.md`, `review.html`), which every doc check skips.

`yarn docs:check` enforces all of this, so a new doc must be classified before `yarn check`
passes: add it to `docs` with a tier and give it a banner, or add it to `untiered` and give it
none. The checker also refuses a banner that is one character off the form above, an entry
naming a doc that no longer exists, and a tier name that `stability.md` does not define. It
does not — and cannot — tell you whether the tier you chose is the right one. There is no
`--update-stability` flag for the same reason: a flag that classifies a doc for you would
classify every doc `untiered`.

### In a package README

Every package that `yarn pub` publishes carries a banner under its `README.md` heading too,
so the tier reaches the npm page and not only this folder. Two differences from a doc
banner: the link is relative to the package (`../../docs/stability.md#tiers`, one level
deeper from `packages/tools/*`), and the clause after the em dash spells out what the tier
means for *this* package rather than stopping at the link — the on-disk format for
`@quereus/store`, the wire protocol for the sync packages. The tier word still comes from
the `## Assignment` table in `stability.md`; a README states its tier and never redefines
one.

`docs:check` gates this the same way it gates a doc banner. `docs/.stability.json` carries a
`packages` map — keys are package *directories*, values are tiers — plus a `packagesSpanning`
list for a README that declares no single tier, which today is only `packages/quereus`. The
checker derives the list of packages that must appear from the `pub` script chain in the root
`package.json`, so a package added to that chain without an entry in the map fails the build
rather than becoming silently exempt. `quoomb-web` and the VS Code extension do not publish
but carry a banner, so they are listed too; `packages/sample-plugins` has no README and is the
one intended omission.

A README banner is checked for form, position, and agreement — exactly one banner, under the
`#` heading, opening `**Stability: <Tier>**` (or `**Stability**` for a spanning package),
closing with a full stop, and containing the `[Stability Tiers](…#tiers)` link at the right
relative depth. Its prose is free-form, so nothing between the em dash and the link is
checked. A banner in a README that the map does not classify — a nested `src/README.md`, say —
also fails: a tier claim under no gate is what this check exists to prevent.

Changing a package's tier still means three edits: the assignment table in `stability.md`, the
`packages` map, and that package's README. The checker pins the last two to each other, so
editing one without the other fails. It cannot read the assignment table — that table is prose
— so a tier changed there alone leaves the build green and the table disagreeing with the
banners. Edit all three.

## Where new prose goes

**A topic doc is a map, not a log.** New material belongs in the smallest home that fits, and
appending to the biggest file is never the smallest home — that is how a doc reaches 38,000 words
one honest section at a time.

- If a feature *changes* what an existing section says, **edit that section.** Do not append a
  section that contradicts one above it; a doc carrying both readings has already drifted.
- If it needs a new section and that section is small — rule of thumb, under ~400 words — add it
  to the topic doc.
- Otherwise it becomes a **satellite**: `docs/<hub>-<topic>.md`, classified in
  `docs/.stability.json` at its hub's tier, opening with an H1, a stability banner, and an intro
  closing `A satellite of [Hub](hub.md).`, and listed in the hub's `## Topic documents` table. A
  hub with satellites carries that table directly below its intro — copy the shape from
  `docs/view-updateability.md` and its satellite `docs/vu-inverses.md`.
- **Never append to a doc the checker is already warning about.** A near-cap or drift notice means
  the next section goes in a satellite, not in that file.

Some prose is not design prose and does not belong in `docs/` at all. An API or usage detail goes
in the package `README.md`; a local mechanism, or a concern that only becomes work if some
condition trips later, goes in a `NOTE:` comment at the code site. For unimplemented work,
[Where each one goes](#where-each-one-goes) above already names the home.

## The size ratchet

`docs/.doc-budget.json` records each large doc's current word count. A doc may shrink; it
may grow only within the `slackWords` grace band above its recorded size (500 words). A doc
with no entry must come in under `maxWords` (12,000 — roughly the largest doc still readable
end-to-end in one sitting), which carries no grace band: at the cap the answer is a split,
not another 500 words.

Word count is whitespace-separated tokens over the whole file, fenced code included. A doc
whose bulk is code samples is just as unreviewable as one whose bulk is prose.

**The grace band is for the 40-word clarification.** Without it, adding a sentence to a
ratcheted doc fails the build, and a gate that fails on every honest edit trains everyone to
reach for `--force`. Drift inside the band never re-baselines the entry, so it is not a
slow leak: `--update-ratchet` still refuses to raise, which bounds total unforced growth at
500 words for the life of an entry. Every run prints the drift and the headroom left
(`docs/sync.md: 12,670 words, 132 over its ratchet of 12,538 — inside the 500-word grace
band (368 left)`), so the doc that is about to run out gets several runs of warning first.

**An unratcheted doc gets the same runway.** Once it is within `slackWords` of the cap the check
prints a notice too, so the warning arrives *before* the failure rather than with it:

```
docs/optimizer.md: 11965 words, 35 from the 12000-word cap — the cap has no grace band, so split before the next section lands
```

Both of these are notices, not failures: `yarn docs:check` still exits 0, and a healthy run prints
one line per doc that is running out of room. A doc named there is a doc whose next section belongs
in a satellite.

After a doc shrinks, lower its entry — this is expected routine, not an event, and it is
what buys the band back:

```bash
node scripts/check-docs.mjs --update-ratchet
```

It only ever lowers, and it **retires** an entry once its doc measures at or below `maxWords`. An
entry exists to grandfather a doc that is over the cap; one left pinned below the cap holds that
doc to an arbitrary number under the project's published readability limit, so the next honest
paragraph fails the gate for no readability reason. Retiring it does raise the doc's effective
limit up to `maxWords` — that is the intent, not a hole in the ratchet: the doc is then held to
the same cap as every other unratcheted doc, near-cap notice included.

It still refuses to raise or add an entry, and exits non-zero naming the doc and the delta; a
ratchet you can silently raise is not a ratchet. When a raise is genuinely justified — say a
convention adds a header line to every topic doc — `--update-ratchet --force` will do it, and the
commit message must carry a line saying why.

## Frozen artifacts

`docs/review.html` and `docs/review.md` are review artifacts. They describe a past state of
the codebase **on purpose**, are exempt from every check, and must not be "corrected."

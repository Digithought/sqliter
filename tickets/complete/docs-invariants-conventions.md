description: The repo's documentation-convention checker was red because two entries in the invariants document broke the style rules (one had a duplicate field, two were over the word limit); each was split into two entries, and review added the missing tests and cross-doc links.
files: docs/invariants.md, docs/optimizer.md, docs/optimizer-fd.md, docs/optimizer-conventions.md, scripts/check-docs.mjs, packages/quereus/test/optimizer/side-effect-audit.spec.ts, packages/quereus/test/optimizer/fd-propagation.spec.ts
difficulty: easy
----

## What shipped

`node scripts/check-docs.mjs` failed on three format violations in `docs/invariants.md`:
`OPT-002` carried two `guard:` lines (only one is legal) and a 148-word body (max 120), and
`OPT-046` carried a 155-word body. Both entries stated two distinct claims under one ID, so
each was split:

- **`OPT-002` → `OPT-002` + `OPT-003`.** `OPT-002` keeps "an `'aware'` optimizer rule
  consults the side-effect signal" with its behavioural guard. New `OPT-003` carries the
  static-analysis guard that scans every `'aware'` rule's source for a purity signal; its
  `describe(...)` title in `side-effect-audit.spec.ts` was renamed to match.
- **`OPT-046` → `OPT-046` + `OPT-047`.** `OPT-046` keeps "`addFd`/`mergeFds` is the only FD
  accumulation path" with its static guard. New `OPT-047` carries `addFd`'s internal
  subsumption-dedup and cap-eviction behaviour.

No IDs reused or renumbered; `OPT-003` / `OPT-047` fill existing gaps and ascend within
their areas.

## Review findings

**Checked:** the `f430af95` implement diff read cold before the handoff; `scripts/check-docs.mjs`
Check B read end-to-end to confirm what it actually enforces (heading form, ID uniqueness +
per-area ascent, ≥1 `code:` / exactly-1 `guard:`, `guard: none — <reason>` requires a reason,
pointer targets exist and named symbols still appear in the file, ≤120 prose words — meta lines
are excluded from the word count); `docs/doc-conventions.md`'s back-link rule; every in-repo
reference to `OPT-002/003/046/047`; `addFd` + `enforceCap` source against the new `OPT-047`
prose; existing `addFd` test coverage.

**Major (new ticket):** none. The diff is a docs split plus test-title renames; nothing found
warranted spinning out separate work.

**Minor (fixed in this pass):**

1. **`OPT-047`'s `guard: none — <reason>` was factually wrong.** Its stated reason — "no
   behavioural test exercises the subsumption or cap-eviction ordering" — was only half true:
   `fd-propagation.spec.ts` already had three subsumption tests (`addFd / mergeFds` describe).
   Only the *cap-eviction ordering* was untested. A `guard: none` line whose reason is
   contradicted by the tests is worse than no line, so this was closed rather than filed as
   debt: added three cap-eviction tests to `fd-propagation.spec.ts` covering key-hint
   preference over `'unique'`, `'unique'`-over-`'determination'` within a partition, and the
   ranking when both preferences apply; renamed the enclosing describe to
   `OPT-047: addFd dedupes by subsumption and evicts by key/kind preference` and pointed the
   `guard:` line at it. This resolves the handoff's open question 1 — the gap is closed, not
   accepted.
2. **Missing back-links (handoff open question 2, plus one the handoff missed).**
   `doc-conventions.md` states a topic-doc section an invariant summarizes carries a
   `> **Invariant:** [...]` back-link. Three sites named by a new invariant's `doc:` line
   lacked one: `docs/optimizer.md` § The two declarations (added `OPT-003`),
   `docs/optimizer-fd.md` § Helper surface (added `OPT-047`), and
   `docs/optimizer-conventions.md`'s `addFd` item, whose prose describes cap eviction (added
   `OPT-047`). Multi-invariant back-link lines already have precedent in
   `optimizer-conventions.md`. Anchor slugs verified live by the checker's Check A, not by eye.
3. **`OPT-047` prose omitted `addFd`'s kind reconciliation** — a dropped-or-subsumed
   `'unique'` twin upgrades the survivor's `kind`, which `fd-utils.ts` documents and the new
   tests depend on. Added one clause; body still under the 120-word budget.

**Tripwires (recorded, not filed):** none. The checker's own textual-match weakness (a
`guard:` line passes if its symbol appears anywhere in the file, including a comment) is
already a `NOTE:` at `scripts/check-docs.mjs:369`, and `OPT-046`'s prose already carries its
own "if the allowlist grows past a handful of entries, delete the guard" tripwire. Nothing new
to park.

**Doc accuracy:** every file the change touches was re-read against the new reality.
`docs/optimizer-fd.md` § Helper surface and `docs/optimizer-conventions.md` describe `addFd`'s
subsumption + `keyHints` cap eviction and are consistent with `OPT-047` as split.
`docs/doc-conventions.md` needed no change — the diff conforms to it rather than altering it.

## Verification

- `node scripts/check-docs.mjs` (repo root) → `Docs OK: links resolve, invariants
  well-formed, sizes within ratchet.`
- `yarn test:single .../fd-propagation.spec.ts .../side-effect-audit.spec.ts` → 66 passing
  (was 63; +3 new eviction tests).
- `yarn test` (from `packages/quereus`) → 6802 passing, 9 pending, 0 failing.
- `yarn lint` (from `packages/quereus`) → exit 0 (eslint + `tsc -p tsconfig.test.json
  --noEmit`).
- No pre-existing failures encountered; the two ratchet failures (`docs/schema.md`,
  `docs/sql.md`) noted in the earlier handoff were already resolved by commit `15874567`.

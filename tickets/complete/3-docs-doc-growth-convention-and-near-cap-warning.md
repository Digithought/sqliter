description: The documentation size check now warns while a document is still under the limit instead of only failing once it is over, retires a size exemption once the document no longer needs one, and the conventions document now says where a new feature's write-up should go so the biggest file stops being the default.
files:
  - scripts/check-docs.mjs        # ratchetVerdict, updateVerdict, checkRatchet, updateRatchet, selfTest, main
  - docs/doc-conventions.md       # "Where new prose goes" section; "The size ratchet" updated
  - docs/.doc-budget.json         # `note` field rewritten
---

## What landed

Three arms, all as specified in the implement ticket, plus two review fixes.

### Arm 1 — near-cap notice for unratcheted documents

`ratchetVerdict` gained a fourth verdict, `'near-cap'`: a document with no ratchet entry that is
within `slackWords` of `maxWords`. `checkRatchet` reports it through `notice(...)`, not `fail(...)`,
so the exit code is unchanged. Five documents print a notice on a clean run today; the build stays
green.

### Arm 2 — `--update-ratchet` retires an entry once its document is under the cap

A ratchet entry exists to grandfather a document that is *above* `maxWords`. Once the document
measures at or below the cap, `--update-ratchet` now drops the entry instead of lowering it, and the
document is held to the same published cap as every other unratcheted one. Runs on plain
`--update-ratchet`, no `--force`.

### Arm 3 — where new prose goes

New `## Where new prose goes` section in `docs/doc-conventions.md`, directly before
`## The size ratchet`: edit the section a change contradicts; add a small section in place; otherwise
open a satellite. `## The size ratchet` gained a paragraph for the near-cap notice and one for entry
retirement, and the `note` field in `docs/.doc-budget.json` matches.

## Review findings

### Checked

- **Read the implement diff first** (`git show 538af7d8 -- docs/.doc-budget.json docs/doc-conventions.md scripts/check-docs.mjs`), then the surrounding functions in full, then the handoff.
- **Boundary behaviour, live on the real corpus, in both directions.** Appended 200 filler words to `docs/types.md` (11,326) → `docs/types.md: 11526 words, 474 from the 12000-word cap …`, exit 0. Appended 100 to `docs/optimizer.md` (11,965) → `12065 words exceeds the 12000-word cap …`, exit 1. Both files restored byte-for-byte; `git diff --stat` on each is empty.
- **Retirement round trip.** Hand-added `"docs/errors.md": 2021`, ran `--update-ratchet`: entry dropped, `docs/lens.md` (18,310, above the cap) left alone, `docs/.doc-budget.json` restored byte-for-byte. Re-ran after the refactor below — byte-identical output.
- **Every factual claim in the new conventions prose.** The "satellite sits at its hub's tier" rule was checked against `docs/.stability.json` for all four hub/satellite families (`optimizer`/`optimizer-*` Internal, `view-updateability`/`vu-*` Beta, `schema`/`schema-rename-detection` Beta, `sync`/`sync-protocol` Experimental) — accurate in every case. The "38,000 words" figure matches the two other places `doc-conventions.md` already cites it.
- **Docs that *should* have been touched.** `docs/doc-conventions.md` and `docs/.doc-budget.json` are the only prose homes for this behaviour; `scripts/check-docs.mjs`'s own header comment block, `--update-ratchet` usage line, and the `notices` comment in `main()` were all updated by the implementer. Nothing else in `docs/` or any README describes the size gate.
- **`yarn lint`** exit 0 (quereus eslint + test-file `tsc` pass; every other workspace a deliberate no-op). **`yarn test`** exit 0 — 8,693 + 1,362 + 725 + 376 + … passing across every workspace, 13 pending, zero failures. **`node scripts/check-docs.mjs`** exit 0 (its `selfTest` runs on every invocation, so the new verdict cases run there too). No pre-existing failures surfaced; `tickets/.pre-existing-error.md` not written. `yarn build` / `yarn typecheck` not re-run — the review diff is one `.mjs` script (in no `tsconfig`) plus two markdown files, and the implementer ran both green on the same scope.

### Found and fixed in this pass (minor)

- **The new retirement branch had no automated coverage.** It was verified only by a hand round trip, and it is the branch whose *ordering* carries the behaviour — it has to sit above both lower and raise. Extracted the per-entry decision into a pure `updateVerdict(words, recorded, maxWords, slack, force)` alongside `ratchetVerdict`, rewrote `updateRatchet` as a switch over it (message strings unchanged), and added ten `selfTest` rows — including retirement at exactly `maxWords` and retirement under `--force`, the two the prose argues for. Behaviour-preserving: the `docs/errors.md` round trip reproduces exactly, and the checker's output on the real tree is unchanged.
- **`docs/doc-conventions.md` pointed at a bad exemplar with a wrong count.** "copy the shape from `docs/optimizer.md`, which has eleven" — that table has twelve rows, and none of the optimizer satellites carry the `A satellite of [Hub](hub.md).` intro closing that the same bullet requires, so a reader copying one would produce a file that misses half the convention. Repointed to `docs/view-updateability.md` and its satellite `docs/vu-inverses.md`, which demonstrate the full shape, and dropped the numeral so it cannot go stale again.

### Found, reviewed, kept as-is

- **The `--force` behaviour change the implementer flagged as beyond spec is correct.** `--update-ratchet --force` on a below-cap document now drops its entry rather than raising it. The existing force-*add* path already refuses to add an entry for a document under the cap, so retiring one under the cap is what makes the two directions symmetric: an entry exists if and only if the document is over the cap. That argument is now in the `updateVerdict` doc comment and pinned by a `selfTest` row, so it is no longer untested or undocumented.
- **A document sitting exactly at the cap prints `0 from the 12000-word cap`.** True, if slightly odd. A one-word window is not worth a branch.

### Filed as tickets

None. The one finding that would have warranted a ticket — `scripts/check-docs.mjs` is now 1,325 lines (`wc -l`), up 24 from the implement commit — is already claimed by `tickets/backlog/debt-check-docs-script-too-large.md`, which names the same file and the same split. Its stale line count was updated in place rather than a second ticket filed.

### Tripwires

- **The notice list only ever grows.** A near-cap document keeps printing until someone splits it, and five lines print today. Recorded as a `NOTE:` in `main()` in `scripts/check-docs.mjs`, with the remedy (sort by headroom, print the closest few and a `+N more` tail) if it ever reads as background noise.

### Known gap left open

`checkRatchet` and `updateRatchet` still read the real `docs/` tree and the real budget file, so their I/O and message strings have no fixture-driven test — only the decision logic is now pure and pinned. That is the same shape as checks D and E before their self-tests existed, and closing it means a fixture harness, which belongs with the split in `debt-check-docs-script-too-large`, not here.

### Still owed by nobody in this ticket

All five near-cap and drift documents remain where they are. The notice now arrives several hundred
words before the build breaks; the splits themselves are unchanged work. `docs/optimizer.md` has 35
words of headroom and is next to go red.

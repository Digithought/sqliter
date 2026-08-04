description: The documentation size check now warns while a document is still under the limit instead of only failing once it is over, retires a size exemption once the document no longer needs one, and the conventions document now says where a new feature's write-up should go so the biggest file stops being the default.
files:
  - scripts/check-docs.mjs        # ratchetVerdict ~530, checkRatchet ~547, updateRatchet ~575, selfTest ~1092
  - docs/doc-conventions.md       # new "Where new prose goes" section, ~line 161; "The size ratchet" updated
  - docs/.doc-budget.json         # `note` field rewritten
difficulty: medium
---

## What landed

Three arms, all as specified in the implement ticket. Nothing was descoped.

### Arm 1 — near-cap notice for unratcheted documents

`ratchetVerdict` gained a fourth verdict, `'near-cap'`: a document with no ratchet entry that is
within `slackWords` of `maxWords`. `checkRatchet` reports it through `notice(...)`, not `fail(...)`,
so the exit code is unchanged. The branch computes its own `budget.maxWords - words` distance
rather than reusing the `over` local, which is `NaN` when there is no entry — a comment at that
`const over` line now says so.

### Arm 2 — `--update-ratchet` retires an entry once its document is under the cap

New branch in `updateRatchet`, placed **after** the `words === undefined` (document deleted) branch
and **before** lower/raise, so a removed document is still reported as removed and a document above
the cap still falls through to the existing lower/raise logic. Runs on plain `--update-ratchet`,
no `--force`. Carries a comment explaining why this is not a hole in "a ratchet you can silently
raise is not a ratchet".

### Arm 3 — where new prose goes

New `## Where new prose goes` section in `docs/doc-conventions.md`, directly before
`## The size ratchet`. ~240 words, uses only vocabulary already live in the repo (hub, satellite),
and links `[Where each one goes](#where-each-one-goes)` rather than restating that table.
`## The size ratchet` gained a paragraph for the near-cap notice (with a real example line) and a
paragraph for entry retirement. The `note` field in `docs/.doc-budget.json` was rewritten to match.

Also updated: the check C description in the file header comment block, the `--update-ratchet`
usage line, and the `notices` comment in `main()`.

## What I actually ran

**Before any edit**, `node scripts/check-docs.mjs` printed exactly one line (`docs/lens.md` drift)
and exited 0.

**After arm 1** — the four documents the implement ticket predicted, and only those:

```
docs/design-isolation-layer.md: 11509 words, 491 from the 12000-word cap — the cap has no grace band, so split before the next section lands
docs/lens.md: 18310 words, 376 over its ratchet of 17934 — inside the 500-word grace band (124 left)
docs/materialized-views.md: 11548 words, 452 from the 12000-word cap — …
docs/optimizer.md: 11965 words, 35 from the 12000-word cap — …
docs/runtime.md: 11897 words, 103 from the 12000-word cap — …
Docs OK: …
EXIT=0
```

`docs/types.md` at 11,326 words is the nearest document that does *not* notice — 174 words below
the 11,500 threshold — so the boundary is exercised by the real corpus in both directions.

**Arm 2 round trip.** Hand-added `"docs/errors.md": 2021` to `docs/.doc-budget.json`, ran
`node scripts/check-docs.mjs --update-ratchet`. Output:

```
  docs/lens.md: +376 over 17934, inside the 500-word grace band — entry left alone
Updated the ratchet:
  dropped docs/errors.md: 2021 words, at or below the 12000-word cap — no longer grandfathered
```

`git diff docs/.doc-budget.json` was then empty — the rewrite restored the file byte-for-byte, and
`docs/lens.md` (18,310 words, above the cap) was left completely alone, which is the case the
branch must not fire for. The final diff of that file is the `note` field only; the `ratchet`
object is untouched.

**Full validation**, all from repo root, all exit 0:

| command | result |
| --- | --- |
| `node scripts/check-docs.mjs` | 5 notices, exit 0 |
| `yarn lint` | exit 0 (quereus eslint + test-file tsc pass; 16 no-op workspaces) |
| `yarn build` | exit 0 |
| `yarn typecheck` | exit 0 |
| `yarn test` | exit 0 — 8693 + 1362 + 725 + 376 + … passing across every workspace, 13 pending |

`selfTest(fail)` runs on every plain invocation, so the new verdict cases are covered by each of
those `check-docs.mjs` runs. No pre-existing failures surfaced; `tickets/.pre-existing-error.md`
was not written.

I did **not** run `yarn check` verbatim — it chains `test:full` (which re-runs the quereus logic
suite against the LevelDB store), `test:fork-strict`, and `test:context-strict`. The diff is one
`.mjs` script plus two documentation files: zero TypeScript, zero engine source, nothing any of
those three suites can reach. I ran every other link of the chain instead.

## Use cases to check

- **A document crosses 11,500 words.** Add ~200 words to `docs/types.md` (11,326) and confirm a
  near-cap notice appears and `yarn docs:check` still exits 0. Remove them afterwards.
- **A document crosses 12,000.** Add ~100 words to `docs/optimizer.md` (11,965, 35 from the cap)
  and confirm it turns from notice to `fail` with the split-or-`--force` message. Remove them.
- **Retirement does not fire on the document it must not fire on.** `node scripts/check-docs.mjs
  --update-ratchet` on the tree as-is prints "already matches" / leaves `docs/lens.md` alone and
  leaves the budget file byte-identical.
- **Retirement fires once.** Repeat the `docs/errors.md` round trip above.
- **`slackWords: 0` still means strict.** Set it to 0 in `docs/.doc-budget.json`, run the checker,
  confirm no near-cap notice appears anywhere and `docs/lens.md` becomes a hard failure (its 376
  words of drift are now outside a zero-width band). Restore the file by editing it back to 500.
- **The new conventions section is reachable prose.** `#where-each-one-goes` resolves — check A
  validates it, so a typo there would already have failed the build.

## Known gaps — treat these as the starting point

- **`updateRatchet` has no automated test.** `selfTest()` covers `ratchetVerdict`, which is pure;
  `checkRatchet` and `updateRatchet` both read the real `docs/` tree and the real budget file, so
  neither is exercised by injected inputs the way check D and check E are (`stabilitySelfTest`,
  `packageSelfTest`). Arm 2 is verified **only** by the hand round trip transcribed above. The
  refactor that would fix this — hoisting the entry-by-entry decision out of `updateRatchet` into a
  pure function alongside `ratchetVerdict`, the same shape `checkClassification` has — was outside
  this ticket's scope. If the reviewer thinks that is worth doing, it is a `debt-` ticket, and the
  site is `scripts/check-docs.mjs:575`.
- **Arm 2 changes `--force` behaviour too, which the implement ticket did not call out.** A
  `--update-ratchet --force` run on a document that has fallen under the cap now *drops* its entry
  rather than raising it, because the new branch sits above the raise branch. I believe this is
  correct — an entry below the cap serves no purpose whether or not `--force` was passed — but it
  is a behaviour change beyond the literal spec, and it is not covered by any test.
- **The near-cap message wording is unreviewed by anything but me.** It is the line four documents
  will print on every developer's `yarn check` from now on, so it is worth a second opinion on tone
  and length.
- **No structural check on hub/satellite layout.** Arm 3 states the `## Topic documents` convention
  in prose only. Making it machine-checked was explicitly ruled out of scope by the implement
  ticket (what counts as a hub? must a satellite be linked from exactly one?) and remains unbuilt.
- **This ticket does not shrink anything.** All four near-cap documents are still near the cap; the
  notice now says so several hundred words before the build breaks, but the splits themselves are
  still owed. `docs/optimizer.md` has 35 words of headroom and is the next one to go red.

---
description: Design documents keep growing past the size limit and turning the build red with no advance warning, because nothing says where a new feature's write-up should go and the check only warns about some files; write the rule down and make the checker warn before a document hits the limit rather than after.
prereq: docs-split-schema-rename-detection, docs-split-sync-protocol
files:
  - scripts/check-docs.mjs        # `ratchetVerdict` ~line 530, `checkRatchet` ~540, `updateRatchet` ~562, `selfTest` ~1082
  - docs/doc-conventions.md       # "The size ratchet" section, ~line 161
  - docs/.doc-budget.json         # the `note` field describes the rules to whoever opens it
difficulty: medium
---

## Why

The documentation size gate has now gone red on the same two documents three times
(`docs-megadoc-ratchet-overage`, `debt-doc-size-ratchet-red-at-head`, and the two split tickets
this one follows). Each pass trimmed or split the documents back under budget; each time, the next
few features appended a section to the biggest topic document and it drifted back over. Trimming
is not the fix, because nothing was wrong with the trimming — the fix is to stop new prose landing
in the largest file by default, and to warn a document's editor *before* the gate is red rather
than after.

Two concrete gaps:

**Nothing says where a feature's design prose goes.** The repo already has a working answer in
practice — a large document is a **hub** with a `## Topic documents` table, and material big
enough to read on its own lives in a **satellite** document beside it. `docs/optimizer.md` has
eleven satellites, `docs/materialized-views.md` and `docs/view-updateability.md` and `docs/sql.md`
each have several. But `docs/doc-conventions.md` never says so, so a feature's write-up defaults
to the hub and the hub grows.

**Half the corpus gets no warning at all.** A document with a ratchet entry gets a drift notice on
every run, several runs before it fails. A document with no entry is measured against the flat
12,000-word cap, which has no grace band and prints nothing until it fails. Measured on
2026-08-04 with `for f in docs/*.md; do printf "%7d %s\n" "$(wc -w < "$f")" "$f"; done | sort -rn`,
four documents sit inside 500 words of that cliff with zero warning today:

| document | words | from the cap |
| --- | --- | --- |
| `docs/optimizer.md` | 11965 | 35 |
| `docs/runtime.md` | 11897 | 103 |
| `docs/materialized-views.md` | 11548 | 452 |
| `docs/design-isolation-layer.md` | 11509 | 491 |

Any of the four is one honest paragraph away from turning `yarn check` red with no prior notice.
That is the next instance of this ticket, already loaded.

## What to build

Three arms, all small, all in the three files above.

### Arm 1 — a near-cap notice for unratcheted documents

`ratchetVerdict(words, recorded, maxWords, slack)` in `scripts/check-docs.mjs` (~line 530) gains a
fourth verdict, `'near-cap'`, for a document with no ratchet entry that is within `slackWords` of
the cap:

```js
function ratchetVerdict(words, recorded, maxWords, slack) {
	if (recorded === undefined) {
		if (words > maxWords) return 'over-cap';
		return words > maxWords - slack ? 'near-cap' : 'ok';
	}
	const over = words - recorded;
	if (over <= 0) return 'ok';
	return over <= slack ? 'drift' : 'over-band';
}
```

`checkRatchet` gets a matching `case 'near-cap':` that calls `notice(...)`, **not** `fail(...)` —
this is a warning, and `yarn docs:check` must still exit 0. Message in the style of the existing
drift notice, e.g.:

```
docs/optimizer.md: 11965 words, 35 from the 12000-word cap — the cap has no grace band, so split before the next section lands
```

The threshold mirrors the grace band deliberately: a ratcheted document gets 500 words of warning
before it fails, and an unratcheted one now gets the same.

### Arm 2 — `--update-ratchet` drops an entry once its document is under the cap

A ratchet entry exists to grandfather a document that is **above** the 12,000-word cap — that is
what `docs/.doc-budget.json`'s own `note` field says it records. An entry for a document that has
since shrunk under the cap pins it at an arbitrary number far below the project's actual
readability limit, so the next honest addition fails the gate for no readability reason. Both
split tickets remove such an entry by hand; teach the tool to do it.

In `updateRatchet`, before the lower/raise branches, add: when the document still exists and
`words <= budget.maxWords`, delete the entry and record it in `changes`, e.g.
`dropped docs/schema.md: 8300 words, at or below the 12000-word cap — no longer grandfathered`.

This runs on plain `--update-ratchet`, without `--force`. It does loosen the effective limit (from
`recorded + slack` up to `maxWords`), and that is the intent: `maxWords` is the project's published
readability limit and the document is now subject to it like every other unratcheted document.
Say so in the code comment — a reader who knows the "a ratchet you can silently raise is not a
ratchet" rule will otherwise read this as a hole in it.

### Arm 3 — write down where new prose goes

Add a section to `docs/doc-conventions.md` — put it before `## The size ratchet`, since it is the
rule the ratchet enforces. It should say, in the document's own voice and without inventing new
vocabulary (the hub/satellite words are already used in `docs/invariants.md:907`, `docs/sql.md:31`
and `docs/vu-setops.md:5`):

- **A topic document is a map, not a log.** New material belongs in the smallest home that fits.
- If a feature *changes* what an existing section says, **edit that section**. Do not append a
  section that contradicts one above it.
- If it needs a new section and that section is small (rule of thumb: under ~400 words), add it to
  the topic document.
- Otherwise it becomes a **satellite**: `docs/<hub>-<topic>.md`, classified in
  `docs/.stability.json` at its hub's tier, opening with an H1, a stability banner, and an intro
  closing "A satellite of [Hub](hub.md).", and listed in the hub's `## Topic documents` table. A
  hub that has satellites carries that table directly below its intro — copy the shape from
  `docs/optimizer.md`.
- **Never append to a document the checker is already warning about.** A near-cap or drift notice
  means the next section goes in a satellite, not in that file.
- Some prose is not design prose and does not belong in `docs/` at all: an API or usage detail goes
  in the package `README.md`; a local mechanism or a conditional concern goes in a `NOTE:` comment
  at the code site; unimplemented work goes to `docs/todo.md` or a backlog ticket. The existing
  "Where each one goes" table covers the last case — cross-reference it rather than restating it.

Then update `## The size ratchet` to describe both checker changes: the near-cap notice with an
example line, and the fact that `--update-ratchet` retires an entry once its document falls under
the cap. Update the `note` field in `docs/.doc-budget.json` to match — that field is what someone
opening the JSON reads instead of the conventions document.

## Edge cases & interactions

- **`checkRatchet` computes `const over = words - recorded` before the switch.** With no entry that
  is `NaN`, so the `near-cap` branch must compute its own `maxWords - words` distance rather than
  reusing `over`. A message reading "NaN from the cap" is the obvious way to get this wrong.
- **An existing self-test case changes meaning.** `selfTest()`'s `bandCases` contains
  `[12000, undefined, 'ok']`, which becomes `'near-cap'`. Update it and add
  `[11500, undefined, 'ok']` and `[11501, undefined, 'near-cap']` to pin the boundary exactly:
  at `maxWords - slack` there is no notice; one word above it there is. Keep
  `[12001, undefined, 'over-cap']`.
- **`slackWords: 0` must still restore the strict behaviour.** With slack 0 the near-cap threshold
  is `maxWords` itself, so `near-cap` becomes unreachable and a document at exactly `maxWords`
  verdicts `'ok'`. `slackOf` also returns 0 when the key is absent. Add a self-test case pinning
  `ratchetVerdict(12000, undefined, 12000, 0) === 'ok'` alongside the existing strict-ratchet case.
- **Notices must not change the exit code.** `main()` prints notices before the failure block and
  exits 0 when `failures` is empty. After this change a clean run prints several notice lines; that
  is the intended output, not a regression. Confirm `node scripts/check-docs.mjs; echo $?` prints 0.
- **Expected output after arm 1.** On the tree as of 2026-08-04, exactly the four documents in the
  table above should produce a near-cap notice, and no document should produce a `drift` notice
  (`docs/lens.md` is the only ratchet entry left after the prereq tickets, and it is over the cap,
  so it drifts — re-measure at implement time and state what you actually see rather than copying
  this list).
- **Arm 2's branch ordering.** The existing `words === undefined` branch (document deleted) must
  still win — a removed document is removed for that reason, not for being under the cap. And the
  new branch must not fire for a document *above* the cap, which is the case the entry exists for.
  `docs/lens.md` (18310 words) must be left completely alone by `--update-ratchet`.
- **Exercising arm 2 without corrupting the budget file.** After the prereq tickets the only entry
  is `docs/lens.md`, which the new branch must not touch, so a plain run proves nothing. Test it by
  hand-adding a throwaway entry for a small document (e.g. `"docs/errors.md": 2021`), running
  `node scripts/check-docs.mjs --update-ratchet`, and confirming it reports the entry dropped and
  that `git diff docs/.doc-budget.json` is then empty — the round trip should restore the file
  byte-for-byte, since `updateRatchet` rewrites with tab indentation and sorted keys. If the diff
  is not empty, restore it by editing the file; **do not** run `git checkout --` or any other
  working-tree reset.
- **`docs/doc-conventions.md` grows.** It is 1865 words (`wc -w`), unratcheted, so it has room —
  but the new section is a rule, not an essay. If it runs past ~400 words, it is violating the rule
  it states.
- **Do not add a check for the `## Topic documents` table.** Making hub structure machine-checked
  is a separate change with its own design questions (what counts as a hub? does a satellite have
  to be linked from exactly one?). Arm 3 states the convention in prose; that is this ticket's
  scope.

## TODO

- `scripts/check-docs.mjs`: add the `'near-cap'` verdict to `ratchetVerdict`; add the matching
  `notice(...)` case to `checkRatchet`, computing its own distance-to-cap.
- `scripts/check-docs.mjs`: in `updateRatchet`, drop an entry whose document measures at or below
  `maxWords`, recorded in `changes`, on plain `--update-ratchet`, with a comment explaining why
  this is not a silent raise.
- `scripts/check-docs.mjs`: update the `bandCases` entry that changes meaning; add the three new
  boundary cases; add the `slackWords: 0` case. Update the header comment block (check C's
  one-line description) if it no longer describes what the check does.
- `docs/doc-conventions.md`: add the "where new prose goes" section before `## The size ratchet`;
  update `## The size ratchet` for both checker changes.
- `docs/.doc-budget.json`: update the `note` field to describe the near-cap notice and entry
  retirement.
- Verify: `node scripts/check-docs.mjs; echo $?` → notices printed, exit 0. `yarn check` end to
  end. Run the arm-2 round-trip described above and confirm the budget file is unchanged
  afterwards. `yarn lint` (the script is not TypeScript, but the lint fan-out is cheap and the
  handoff should say it was run rather than reasoned about).

description: Two of the project's design documents have grown to the maximum length the documentation checker allows, so the checker now reports a failure and the next person who adds a paragraph to either one will be blocked.
files:
  - docs/module-authoring.md     # 12001 words — 1 over the cap, fails today
  - docs/store.md                # 11985 words — 15 under the cap, fails on the next paragraph
  - docs/optimizer.md            # 11977 words — 23 under the cap, same squeeze
  - scripts/check-docs.mjs       # the gate; `--update-ratchet --force` is the escape hatch
  - docs/doc-conventions.md      # where the cap and the ratchet are described
difficulty: medium
tradeoffs: Splitting a design document is disruptive — every inbound link and prose section marker has to be re-pointed, and a maintainer may prefer to record a higher ratchet for these two and move the split to whenever the content actually calls for one.
----

## What is happening

`yarn docs:check` enforces a 12,000-word cap on any document that has not had a larger size
recorded for it. The cap has no grace band: a document one word over fails.

Two documents are at that boundary:

- `docs/module-authoring.md` is **12001 words** and fails today. This is not caused by any
  recent change to it — it is over the line at `main`, so `yarn check` (which runs
  `docs:check` first) is red before anyone edits anything.
- `docs/store.md` is **11985 words**. It passes, but only by 15 words, so essentially any
  addition to it fails the gate.

## Why it is worth doing

`yarn check` is the full pre-release gate, and it currently cannot pass. Beyond that, the
practical effect is worse than the failure itself: the next person with something true and
useful to add to either document has to choose between dropping the content, cutting
unrelated prose to make room, or overriding the gate. That is a bad trade to force on
someone whose actual task is something else — during this review, a needed paragraph in
`docs/store.md` had to be written three times to fit.

Both documents are also large enough that the cap is doing its real job: they are hard to
read end to end, and each has sections that would stand on their own.

## Expected outcome

`yarn docs:check` passes, and both documents have enough headroom that an ordinary edit does
not run into the gate. Either outcome is acceptable and the choice is the maintainer's:

- **Split.** Move one or more self-contained sections into their own documents, updating
  every inbound markdown link and every prose section marker (`See docs/store.md § …`) that
  points at moved content. `debt-doc-size-ratchet-red-at-head` did exactly this before and
  left four stale markers behind, so budget for checking them.
- **Ratchet.** Record the current sizes with `--update-ratchet --force` and state in the
  commit message why these two documents are worth their length. This buys headroom without
  reorganizing anything, at the cost of raising the ceiling rather than lowering the content.

## Content already waiting on this

Found while reviewing the store's prefix-equality + trailing-range index seek (`plan=7`):

- `docs/module-authoring.md` documents the runtime shape of the `plan=5` multi-seek
  `FilterInfo` a module gets back after accepting an `IN` — how many constraints arrive, in
  what order — but says nothing equivalent for the prefix-range plan, which delivers a
  `prefixLen` parameter the runtime must honour rather than re-derive. A module author
  accepting that shape has to read the engine rule to learn its contract. Writing it down
  is a paragraph, and the document cannot take a paragraph today.
- `docs/optimizer.md` is now **11977 words** (23 from the cap) — close enough that it
  belongs in this ticket's scope even though it was not listed when the ticket was filed.

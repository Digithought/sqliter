----
description: |
  One reference document has grown one word past the documentation size limit, so the
  automated docs check now fails for every contributor until it is split or the limit
  is deliberately raised.
files:
  - docs/module-authoring.md
  - scripts/check-docs.mjs
difficulty: easy
tradeoffs: |
  Splitting a stable reference doc churns inbound links and reader habits for a
  one-word overage; recording a ratchet instead (--update-ratchet --force) is one
  command but weakens the cap's intent.
----

`yarn docs:check` fails at HEAD (observed at commit `70e93e30`, before any working-tree
edits): `docs/module-authoring.md: 12001 words exceeds the 12000-word cap for an
unratcheted doc — split it, or record it with --update-ratchet --force and say why in the
commit message`.

The failure predates and is unrelated to the FK-trust capability-gate work that surfaced
it — that change touches `module-capabilities.md`, `optimizer-*.md`, and `invariants.md`,
all of which pass the checker.

Wanted: a maintainer decision between (a) splitting `module-authoring.md` (the checker's
preferred path — several of its siblings are also near the cap, per the same run's
warnings), or (b) recording the ratchet with `--update-ratchet --force` and a
justification in the commit message. Whichever way, `yarn docs:check` should return to
green so it can gate other PRs again.

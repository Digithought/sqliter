description: The single script that checks the documentation has grown past a thousand lines and now does five unrelated jobs, which makes it hard to read and to add a sixth check to.
files:
  - scripts/check-docs.mjs (1,180 lines — the whole gate)
  - docs/doc-conventions.md (documents what the gate enforces)
difficulty: medium
----

## Background

`scripts/check-docs.mjs` is the documentation gate — the first and cheapest step of
`yarn check`. It started as a link checker and has accreted a check per ticket:

- **A. Link integrity** — every markdown link and `docs/*.md` reference resolves, and every
  `#anchor` names a real heading.
- **B. Invariant format** — `docs/invariants.md` parses and its `code:`/`guard:`/`doc:`
  pointers still resolve.
- **C. Size ratchet** — a doc may shrink but not grow past its recorded word count.
- **D. Stability tiers (docs)** — every `docs/*.md` is classified and carries a banner naming
  its recorded tier.
- **E. Stability tiers (packages)** — the same for package `README.md` banners.

Each check is well factored internally: the functions are short, named, and commented, and
each one has a self-test that runs on every invocation. The problem is only that they all live
in one 1,180-line file, sharing a handful of genuinely common helpers (a CRLF/BOM-safe file
reader, a fence stripper, a GitHub heading slugifier, the package-directory walker) with a
much larger amount of code that is specific to exactly one check. Reading any one check means
scrolling past four others; adding a sixth means growing the same file again.

## Expected behavior

The gate is split into a directory — `scripts/check-docs/` with a thin entry point and one
module per check, plus a shared module for the file/markdown helpers and one for the
self-test harness. `node scripts/check-docs.mjs`, `yarn docs:check`, and the
`--update-ratchet` / `--update-ratchet --force` flags keep working exactly as they do now,
including the deduplicated failure list and the exit codes.

Constraints worth preserving, because each is load-bearing and was learned the hard way:

- **No dependencies.** The gate runs before anything is built and must keep working with
  nothing installed.
- **Every file is read through the one CRLF- and BOM-normalizing reader.** The repo is
  developed on Windows; a raw `readFileSync` silently breaks every line-anchored regex.
- **The self-tests keep running on every invocation**, not only under a test command. They
  pin heading slugs and banner forms that live links already depend on.
- **Failure messages keep their exact `path:line: message` shape**, since the deduplication
  that suppresses double-reported breakage is a plain string-equality check.

## Out of scope

Changing what any check enforces, or adding a new one. This is a move-and-split with no
behavior change; the tree must stay green before and after with no edits to any doc.

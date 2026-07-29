---
description: Scratch notes and log files that people drop in a temporary folder keep getting swept into unrelated commits, because that folder was never told to stay out of version control.
files:
  - .gitignore
  - .tmp/
difficulty: easy
---

# What happens

The repository root has a `.tmp/` folder that people and agents use for throwaway
material — build logs, hand-written performance comparison notes, and similar. It is
**not** listed in `.gitignore`, so anything dropped there shows up as an untracked
change and gets picked up by whatever commit happens next, regardless of whether that
commit has anything to do with it.

Three such files are currently committed:

- `.tmp/build.log` (empty)
- `.tmp/quereus-join-perf.md`
- `.tmp/quereus-4.5-vs-4.4-perf.md`

The last one was swept into an isolation-layer bug-fix commit it has no relationship
to. That is the symptom; the pattern will keep repeating until the folder is ignored.

# What should happen

`.tmp/` should be ignored, so scratch material stays local to whoever created it and
never lands in a commit by accident.

# Decision needed before doing it

The two performance notes look like real human-written analysis, not disposable
output. Untracking them removes them from the repository's history going forward, so
whoever owns them should say whether they want them:

- kept, but moved somewhere intentional (a docs or notes folder), or
- untracked and left as local-only files, or
- deleted outright.

Do not silently discard them.

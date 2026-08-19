---
description: |
  Test files in the shared SQL test suite are supposed to announce when they use a database
  feature that not every storage backend offers, but nothing checks that they do — three files
  use such a feature without announcing it, so a backend lacking it hits a hard error instead
  of a clean skip.
files:
  - packages/quereus/test/logic-capabilities.spec.ts # corpus-sweep suite; the hand-listed `subjectFiles` check the guard would replace
  - packages/quereus/test/logic-capabilities.ts # the directive parser and capability vocabulary
  - packages/quereus/test/README.md # § `-- requires-capability:` directive — the cross-repo format spec
  - packages/quereus/test/logic/03.6-type-system.sqllogic # undeclared `create index` at lines 486, 523
  - packages/quereus/test/logic/11.3-index-nested-loop-join.sqllogic # undeclared `create index` at lines 15, 118, 133
  - packages/quereus/test/logic/15.1-semantic-ordering.sqllogic # undeclared `create unique index` at line 414
difficulty: medium
tradeoffs: |
  The guard has to recognise a SQL statement from test-file text without a real parser, so it is a
  line-anchored heuristic that can in principle miss an oddly-formatted statement or flag one inside
  a string literal; and annotating the three offending files makes them skip wholesale on backends
  without the feature, which loses coverage that a file split would keep — so a maintainer may
  prefer to fix the three files by hand and skip the guard.
---

# Nothing checks that a `.sqllogic` file declares the capabilities it actually uses

## Background

`packages/quereus/test/logic/*.sqllogic` is a **shared corpus**: sibling projects run the same
files against their own storage engine. A file that uses a statement some backend deliberately
does not implement declares that with a `-- requires-capability:` line in its header, and a
backend without the feature skips the whole file cleanly instead of dying mid-run. There is one
capability token today — `standalone-index-ddl`, meaning `create index` / `create unique index` /
`drop index` written as their own statements. The format is specified in
`packages/quereus/test/README.md`.

The declaration is entirely voluntary. `logic-capabilities.ts` validates a directive that is
*present* (unknown token, empty token list, misspelling, wrong position — all hard errors), but
nothing looks at what a file's SQL actually does. A file that uses index DDL and forgets the line
is silently wrong: it passes locally, because quereus's own two backends support everything, and
fails only downstream in someone else's repo.

That is exactly the defect the `41.2.3-alter-column-set-not-null-pk-backfill` ticket fixed, one
file at a time.

## What is wrong right now

Measured with
`grep -rlniE "^\s*(create (unique )?index|drop index)" packages/quereus/test/logic/*.sqllogic`
cross-referenced against `grep -rln "requires-capability"` over the same set: 54 files contain a
standalone index-DDL statement, 51 of them declare the capability, and three do not:

| File | Undeclared statements |
|---|---|
| `03.6-type-system.sqllogic` | `CREATE INDEX real_big_ir …` (line 486), `CREATE INDEX real_big_null_ir …` (line 523) |
| `11.3-index-nested-loop-join.sqllogic` | `CREATE INDEX inl_idx_v …` (line 15) and two more (lines 118, 133) |
| `15.1-semantic-ordering.sqllogic` | `create unique index ckp_v on ckp (v) where s = 'PT60M';` (line 414) |

Each behaves the way `41.2.3` did before it was fixed: on a backend without standalone index DDL
the file dies at that statement, taking every unrelated section with it.

The three are not the same case as each other, and that is the interesting part:

- `11.3-index-nested-loop-join`'s *subject* is index-driven joins. Adding the declaration is
  simply correct — there is nothing to preserve for a backend that has no indexes.
- `03.6-type-system` and `15.1-semantic-ordering` are like `41.2.3` was: large files about
  something else, with a couple of index-using sections inside. Declaring the capability would
  make a backend skip a whole type-system or ordering file over two statements. The README
  already prescribes the answer — split the file, per the `10.5.2-…` decimal sub-numbering
  convention — which is what `41.2.3` did.

## What to build

Two things, in this order.

**A corpus guard that makes the class impossible to re-introduce.** A test in
`logic-capabilities.spec.ts` that reads every `.sqllogic` file, finds files whose SQL uses a
statement covered by a capability token, and asserts each declares that token. That inverts
today's hand-maintained `subjectFiles` list — a list of files someone remembered to name, which
by construction cannot catch a file nobody remembered — into a check derived from the files
themselves. Detection has to work without a SQL parser; a line-anchored match on non-comment
lines is the pragmatic shape, and its limits should be stated in a comment at the site so the
next reader is not misled about how strong the guard is. Whether the existing `subjectFiles`
test survives alongside it is the implementer's call; it becomes largely redundant.

Keeping the guard honest as the vocabulary grows means the detection pattern should live next to
the token that owns it in `logic-capabilities.ts`'s `SQLLOGIC_CAPABILITIES`, not in the spec file,
so adding a second token cannot leave the guard silently checking only the first.

**The three files, brought into line.** `11.3` gets the declaration. `03.6` and `15.1` each need
the same judgement `41.2.3` got: rewrite the index-using section so it needs no capability, or
split it into a sibling file that declares one. Neither should be annotated wholesale without
weighing what coverage that costs downstream.

## Not in scope

Inventing new capability tokens. The vocabulary is deliberately closed and adding to it is its
own decision, documented in `test/README.md`.

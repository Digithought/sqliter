----
description: |
  Several places scan a parsed SQL expression to answer a yes/no question about it, and each one
  quietly stops descending partway through certain expressions — notably anything inside a
  `case when … then …`. They then answer confidently from a partial scan, and the caller acts on
  the wrong answer.
files:
  - packages/quereus/src/planner/mutation/decomposition.ts # `collectValueScopes` (~1095) and `collectViewColumnRefs` (~2220) — the two remaining copies
  - packages/quereus/src/planner/building/view-mutation-builder.ts # `astContainsSubquery` (~591) — the third copy, already fixed; use as the reference behaviour
  - packages/quereus/src/planner/mutation/scope-transform.ts # `transformExpr` — the traversal that does handle every container, for comparison
difficulty: medium
repro: verified
severity: wrong-result
likelihood: unusual
tradeoffs: |
  Making the two remaining scans see more of the expression changes how some writes are classified,
  which could turn today's silently-wrong-but-working cases into loud refusals; a maintainer may
  want that landed deliberately rather than as a drive-by, and may judge the triggering expressions
  rare enough to leave alone.
----

# Expression scans stop short of the parts of an expression that carry no node label

## The shape of the bug

Three helpers walk a parsed expression looking for one thing — "is there a subquery in here", "what
tables do the column references name", "are any references unqualified". Each walks by recursing
into every child of a node, but only after checking that the node carries a `type` label, and
returning immediately when it does not.

Most parts of an expression do carry that label. A few do not. The `when`/`then` pairs of a
`case … end` are plain unlabelled pairs, and so are the frame bounds of a window definition. So the
walk reaches the `case` node, looks at its children, finds an unlabelled pair, and stops — never
seeing anything written inside the `when` or the `then`.

Verified for the subquery question (Quereus, 2026-08-11): a rule written as
`exists (select 1 from Allowed where Allowed.name = tag)` was correctly identified as reading
another table, while the equivalent
`case when exists (select 1 from Allowed where Allowed.name = tag) then 1 else 0 end = 1` was
reported as reading nothing, and was consequently checked at the wrong moment — accepting a write
the first form rejected. That copy has been fixed in place; the two in `decomposition.ts` have not.

## Why the remaining two matter

They answer different questions, so the consequence differs:

- one classifies the value being assigned in an `update` — a value it believes is a plain constant
  is planned very differently from one that reads another table. A `case` expression whose branches
  read another table is currently classified as a constant.
- the other enumerates the columns a `where` clause names, to decide whether the write can be
  routed to a single underlying table. Columns named only inside a `case` are invisible to it, so a
  write that should be refused (or routed differently) may be planned as if those columns were not
  mentioned.

Neither has been reproduced end-to-end; both are read off the code with the third copy as the
worked example.

## What would retire the class

One shared traversal, used by all three, that descends into every child object rather than only
labelled ones — with the "is this a node" test used for *recognising* a node, never for deciding
whether to keep going. The already-fixed copy is the reference behaviour.

Worth pairing with a test that is general rather than per-instance: take each question the scans
answer, and assert the answer is unchanged when the same sub-expression is wrapped in a `case`, a
window frame, and any other container the parser produces. That catches the next container the
grammar grows, which a hand-written test per known container will not.

## Filed from the Lamina board

This ticket was written on Lamina's board (slug `debt-expression-scans-stop-at-untyped-container-nodes`)
during a review pass there, but every file it names is in this repository, so it was filed here
rather than worked from the other side. Lamina's `AGENTS.md` now requires that: cross-repo work is
filed as a ticket on this board, not landed as a direct commit from Lamina, except for completely
trivial updates.

It is filed into `backlog/` deliberately rather than `fix/` — the queue priority here is this repo's
call, not the filer's. It carries `repro: verified` and `severity: wrong-result`, so it may deserve
promoting sooner than a typical backlog entry.

Two notes for whoever picks it up:

- `astContainsSubquery` in `view-mutation-builder.ts` is the **already-fixed reference** — the two
  remaining copies should end up matching its descent behaviour, and `transformExpr` in
  `scope-transform.ts` is the traversal that already handles every container, worth reading before
  writing a third variant. The obvious higher-rung fix is one shared walker rather than three scans
  that must independently remember every container node.
- The ticket's own tradeoff note is real: making the two scans see more of the expression changes
  how some writes are classified, which may turn today's silently-wrong-but-working cases into loud
  refusals. That is a deliberate-landing question for this repo's maintainer.

No Lamina-side change is pending on this. Lamina has no workaround in place and no test asserting
the current behaviour, so nothing there breaks when this lands.

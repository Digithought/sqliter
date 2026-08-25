----
description: Asking for a read that does not queue behind a stalled write also silently gives up ever seeing what another machine wrote, because one option controls both. A consumer that wants the first behaviour and not the second has no way to say so, and finding that out costs a broken deployment rather than a compile error.
prereq:
files:
  - packages/quereus/src/common/types.ts (StatementOptions.readConcurrency ~81)
  - packages/quereus/src/core/statement.ts (tryRouteConcurrent ~558; _iterateConcurrent ~583 — `readCommitted: true`)
  - packages/quereus/src/core/database.ts (_isConcurrentReadEligible ~727; eval ~2120)
difficulty: medium
severity: silent-wrong-answer
likelihood: certain-for-any-consumer-that-opts-in-broadly
----

# `readConcurrency: 'committed'` buys mutex-freedom and forfeits refresh, and only one of those is in its name

`readConcurrency: 'committed'` is documented as the way to keep a read answering while another
statement is parked in its virtual-table commit, and it does that. But `_iterateConcurrent` also
passes `readCommitted: true` into the runtime, which connects every table in the statement on the
`_readCommitted` path. For a networked module that second half is not a detail — it is a different
read.

In `@optimystic/quereus-plugin-optimystic`, a `_readCommitted` connection is served by
`OptimysticCommittedTable`, a **pinned pre-transaction snapshot that never refreshes from the
network**, where an ordinary read calls `update()` on the collection first. So a consumer that opts
in broadly does not merely get "the same answer, sooner". It gets an answer that can no longer
include anything another machine has written.

## How this was found, and what it cost

Downstream (`sereus`), every read on the control database was routed through one helper that asked
for `readConcurrency: 'committed'`, to fix reads blocking behind a control write stalled against an
unresponsive cohort member. Reads did stop blocking. They also stopped converging: the scenario
`control-write-degraded-cohort-member` could no longer observe a sibling node publishing its own
`CadrePeer` row and died at suite setup —

```
Timeout waiting for B self-publishes its CadrePeer record after 45000ms
```

— on **two runs out of two**, on a file that had passed in isolation an hour earlier.

Nothing about that is visible from the option. The name says `committed`, which reads as an
isolation level, and the doc comment describes the ordering guarantee that is given up
(`void db.exec(insert); await db.get(select)` may not see the insert). That is accurate and it is
about a **local** write. The consequential loss for a networked module is a different one — remote
writes, indefinitely — and it is not stated anywhere the caller looks.

The downstream fix was to make the opt-in **conditional**: ask for it only while a writer's
transaction is actually open (`getAutocommit()` is false), and read normally otherwise. That works,
and it is a workaround for the coupling rather than a use of the API as designed — a consumer
should not have to sample transaction state to choose an isolation level.

## What would fix it

Any of these, in preference order — the point is that the two properties become separately
requestable, or at least separately *visible*:

1. **Separate them.** Let a caller ask for mutex-freedom without `_readCommitted`, for modules that
   can serve a refreshing read off the mutex. This is the real fix if the two are genuinely
   independent for some modules; whether they are is a question for this repo, not for a consumer.
2. **Let the module say what the pairing costs.** A module already declares
   `readCommittedSnapshot`. If it also declared that its committed connection does not refresh,
   the engine could surface that, and a consumer could decide with the fact in hand.
3. **At minimum, document it at the option.** `StatementOptions.readConcurrency`'s comment
   enumerates what is given up locally and should say plainly that for a module whose committed
   connection is a pinned snapshot, a committed read cannot observe writes that arrive from
   elsewhere while it runs — and that broad opt-in is therefore not a safe default.

(3) alone would have prevented the downstream breakage, so it is worth doing even if (1) is judged
too large.

## Not a defect in the eligibility gate

Recorded because a downstream ticket wasted a pass on it: the four-rule eligibility check in
`_isConcurrentReadEligible` is fine and was never the obstacle. `tryRouteConcurrent`'s first line
short-circuits on `options?.readConcurrency !== 'committed'`, so a caller that has not opted in
never reaches the rules at all. A consumer reading `_isConcurrentReadEligible` in isolation
concluded routing was automatic and that there was no public API to call. There is one; it is just
that the check they were reading runs strictly after it.

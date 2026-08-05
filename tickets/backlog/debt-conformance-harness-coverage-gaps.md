description: The reusable check that storage backends run to prove they serve consistent older data during a save only exercises the easiest case. Two harder situations it is meant to catch — a backend whose extra lookup structures lag behind its main data, and a table definition being changed at the same time — go untested, so a backend can pass and still be wrong.
files: packages/quereus/src/vtab/test-support/committed-read-conformance.ts, packages/quereus/test/core/committed-read-conformance.spec.ts, packages/quereus/test/vtab/_conformance-stub-modules.ts, packages/quereus/test/core/concurrent-committed-reads.spec.ts, docs/module-authoring.md
difficulty: medium
----

# The committed-read conformance harness under-covers the guarantee it certifies

## Background

A storage backend ("virtual table module") can declare
`readCommittedSnapshot` to promise: *while another connection is saving, a
read still sees one consistent earlier state, and keeps seeing that same state
until the read finishes.* `runCommittedReadConformance` is the runnable proof of
that promise — an author points it at their table and it either passes or names
the row that broke.

It is honest about what it checks, and it does catch a backend that publishes a
save in two visible steps. But the two situations that break real backends are
both outside what it drives. Both are fixed at the same place: the harness's own
run plan.

## Arm 1 — no secondary index is ever driven

The harness reads the table twice: a full scan, and a range lookup on the primary
key. It confirms the plan really used a lookup (it skips that leg, with a stated
reason, if the planner chose a scan instead).

The failure that actually happens in a real backend is different: a save applies
the main rows first and the *extra lookup structures* (secondary indexes) a moment
later. A full scan then looks perfectly clean, and only a read routed through the
lagging index sees rows that disagree. The harness has a stub proving it *detects*
an index-path-only mismatch — but that stub tears on the primary-key path, because
that is the only indexed path the harness drives.

So a backend with a real secondary-index lag passes today.

What would close it: let the caller name a second, non-key column that carries an
index (`indexColumn?`), drive a third read through it, and assert the plan really
chose *that* index rather than any index. A stub whose secondary-index entries lag
its base rows proves the new leg fires.

## Arm 2 — nothing changes the table definition during the read

The promise explicitly covers reads that overlap a table-definition change
(`alter`, `drop index`, and friends): the backend must keep serving its pinned
state across one. The engine-side tests cover two shapes (`add column`,
`drop index`). Two more — `alter column … set collate` and
`alter primary key` — were deliberately deferred by the module-gate review with
the note that "the conformance harness is where exhaustive DDL-shape coverage
belongs", and the harness shipped without any table-definition step at all
(its specification, steps 1–6, never had one). So the deferral landed nowhere.

What would close it: an optional hook that runs caller-supplied schema statements
while the writer is parked and the reads are in flight, so an author can certify
their own backend against the definition changes it actually supports — plus the
two named shapes exercised in-tree against the memory table.

## Why one ticket

Both arms are added at the same site: the harness's run plan and the reads it
issues. Splitting them would mean touching `buildRunPlan` /
`observeConcurrentReads` twice for the same reason.

## Out of scope

Whether the *engine* should hold table-definition changes and concurrent reads
apart with a lock is a separate, already-filed question
(`backlog/debt-concurrent-reads-schema-gate`). This ticket is only about what the
conformance check exercises.

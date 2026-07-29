----
description: One source file in the transaction-isolation package has grown past 2800 lines, and roughly half of it is a single subject — carrying each connection's uncommitted changes forward across an ALTER TABLE — which would read far better as its own file.
files:
  - packages/quereus-isolation/src/isolation-module.ts   # the file to split
  - packages/quereus-isolation/src/isolation-types.ts    # shared types the split would use
difficulty: medium
----

# Split the ALTER-migration machinery out of `isolation-module.ts`

`packages/quereus-isolation/src/isolation-module.ts` is ~2835 lines. It is the package's
central class and legitimately owns several concerns (per-connection staging-area lifecycle,
commit flush coordination, schema/catalog plumbing, query planning passthrough). But one
concern dominates it and is self-contained:

**Carrying open staging areas forward across a DDL change.** When one connection runs
`ALTER TABLE`, the shared table mutates immediately and irreversibly, so every connection's
uncommitted rows must be validated up front, then reshaped/rewritten to match, or else marked
unusable ("poisoned"). That subject is now roughly two dozen private methods — per-change-type
context derivation, a pre-mutation validation pass, per-change-type forwarding, the
primary-key re-key marker handling added most recently, and the poison-message builders.

Nothing about that cluster needs to be a method on the class: it reads a staging area and a
change descriptor and produces either a rejection or a set of writes.

## Why it matters

- The file is past the point where a reader can hold it in their head, and the ALTER cluster is
  the part that keeps growing — the last three tickets all landed here.
- The cluster has its own vocabulary (contexts, tiers, poison) that a reader currently has to
  disentangle from the lifecycle and flush code interleaved around it.
- Reviewing a change to the ALTER path means paging through unrelated code to find the call
  sites.

## Shape

Extract to a sibling module (e.g. `alter-migration.ts`) exposing a small surface the module
class calls: derive the per-change context, validate a staging area against it, migrate a
staging area forward, build the poison message. Keep the tiering and its ordering guarantees
exactly as they are — this is a move, not a redesign, and the existing tests should pass
untouched.

Behavior must not change. If the split turns up a behavioral question, file it separately
rather than resolving it inside the move.

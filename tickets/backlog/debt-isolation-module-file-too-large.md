---
description: One source file in the transaction-isolation package has grown to roughly 2,500 lines and now holds two unrelated jobs; split it so each file does one thing.
files:
  - packages/quereus-isolation/src/isolation-module.ts   # ~2,500 lines — the file to split
  - packages/quereus-isolation/src/isolated-table.ts     # ~2,100 lines — same problem, second candidate
---

# Split `isolation-module.ts`

`packages/quereus-isolation/src/isolation-module.ts` is ~2,500 lines. It mixes two
concerns that share almost no state:

1. **Module lifecycle and bookkeeping** — creating/connecting/destroying tables, the
   per-connection overlay registry, commit and rollback, savepoint tracking, renames.
2. **Schema-change forwarding** — the machinery that carries an open overlay across a
   DDL statement: deriving the backfill/conversion context for each `ALTER TABLE`
   variant, dry-run validating a connection's staged rows against the pending change,
   then forwarding the change into the overlay (column shape, column attributes,
   constraints, primary key), plus the shared error routing and the "poison" messages.

Job 2 arrived incrementally over a run of tickets and is now roughly 700 lines — the
bulk of the file's growth. It is cohesive enough to live in its own module (say
`alter-forward.ts`), reachable from `IsolationModule.alterTable` through a small
surface, with the overlay-schema construction helpers alongside it.

`isolated-table.ts` (~2,100 lines) has the same shape of problem and is worth the same
look, but it is a separate split — do not bundle them.

## Why it matters

The project's own guidance asks for small single-purpose files and decomposed
sub-functions. At this size the file is expensive to read, expensive to review, and
every ticket that touches the isolation layer pays for it. There is no behavior change
here — this is a pure move-and-reorganize, so it should be verifiable by the existing
test suite staying green with no test edits.

## Expectations

- No behavior change. `yarn build`, `yarn test`, `yarn lint`, `yarn typecheck` green,
  with **no** edits to existing test assertions.
- Public exports of `@quereus/isolation` unchanged.
- The long explanatory doc comments move with the code they explain; cross-references
  between the split files stay resolvable.

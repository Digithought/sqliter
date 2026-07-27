description: Two different parts of the codebase each contain their own copy of the rule that decides whether two spellings of a primary key mean the same row. If someone changes one copy and not the other, the transaction layer and the sync engine start disagreeing about row identity, which is the kind of disagreement that silently duplicates or loses rows.
files:
  - packages/quereus-isolation/src/overlay-rows.ts        # makePkKeySerializer
  - packages/quereus-sync/src/metadata/pk-identity.ts     # resolvePkKeying
  - packages/quereus-sync/src/metadata/keys.ts            # encodePkIdentity
  - packages/quereus/src/util/key-serializer.ts           # serializeKeyNullGrouping (the shared primitive both build on)
  - packages/quereus/src/planner/analysis/comparison-collation.ts  # pkKeyCollationName
difficulty: easy
----

## What is wrong

"Are these two primary keys the same row?" is answered by a specific recipe: for each
key column, apply the column's semantic key transform (a `timespan` becomes total
seconds, so `'PT1H'` and `'PT60M'` agree), then apply the column's key-collation
normalizer (under `collate nocase`, `'Apple'` becomes `'apple'`), then serialize the
whole list with the engine's type-tagged key serializer.

That recipe is written out twice, in full:

- `makePkKeySerializer` in the transaction-isolation layer, which uses it to line up a
  transaction's pending row edits against the rows already stored;
- `resolvePkKeying` + `encodePkIdentity` in the sync engine, which use it to decide
  which per-row sync bookkeeping belongs to which row.

They must agree. If they ever diverge, the isolation layer and the sync engine will
disagree about which rows are the same row — a class of bug that shows up as duplicated
or vanishing rows long after the change that caused it.

Cross-referencing comments were added to both sites during review, but a comment is a
weaker guarantee than one implementation.

## Expected outcome

One implementation, shared. The natural home is `packages/quereus` alongside
`serializeKeyNullGrouping`, exported as something both callers can use — taking a table
definition plus a collation-normalizer resolver, and returning a function from key values
to an identity string. The isolation layer's existing form (which takes a `Database` and
pulls the resolver off it) can stay as a thin wrapper, since sync has no `Database` to
hand.

Behavior must not change: the shared version has to produce byte-identical strings to
both current implementations, or existing sync bookkeeping stops resolving.

## Verification

- `packages/quereus-sync/test/metadata/pk-identity.spec.ts` pins the sync side's expected
  folding (nocase, binary, timespan, composite keys, numeric class).
- The isolation overlay's existing row-alignment tests pin the other side.
- Both suites must pass unchanged, with no fixture edits.

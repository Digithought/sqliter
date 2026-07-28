----
description: Changing the sorting rule of a primary-key column mid-transaction now checks the rows the transaction can actually see, so it no longer refuses over rows the transaction deleted with the wrong error, and no longer misses a clash between rows the transaction just inserted.
prereq:
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts        # validateRekeyedPrimaryKey (two-pass rewrite), assertNoPrimaryKeyCollisionInRows (new), alterColumn call site (~2570)
  - packages/quereus/src/vtab/memory/layer/base.ts           # rebuildPrimaryTreeStrict doc-comment precondition update (comment-only)
  - packages/quereus-isolation/test/isolation-layer.spec.ts  # new suite "SET COLLATE on a PRIMARY KEY column judges the transaction's effective rows" (4 tests, after the tombstone-narrowed UNIQUE test)
  - packages/quereus/test/logic/41.7.1-alter-column-collate-unique.sqllogic  # NOT modified — see "What was deliberately not changed"
difficulty: medium
----

# Review: `alter column … set collate` on a PK column now judges the right rows

## What was wrong

`MemoryTableManager.validateRekeyedPrimaryKey` ignored the `rows` argument
(`EffectiveRowSource` — the merged committed+staged stream a wrapper module like the isolation
layer hands down) and probed only its own layer chain. Under the isolation wrapper that meant:

- a collision confined to committed rows the transaction had **deleted** produced a false
  `CONSTRAINT` ("your data is invalid") instead of the retryable `BUSY`;
- two colliding rows the transaction had **staged** (both in the wrapper's overlay, none in the
  memory module's base) passed validation entirely — the shared table's collation was then
  mutated and the failure surfaced as `INTERNAL` ("validation and migration have drifted").

## What changed

`validateRekeyedPrimaryKey` is now async, takes `rows?: EffectiveRowSource`, and runs two
passes over two different row sets:

1. **Legality (CONSTRAINT)** — new sibling `assertNoPrimaryKeyCollisionInRows` probes the rows
   the transaction can see: `rows()` when supplied, else `effectiveDdlRows()`. Consumes
   `Iterable<Row> | AsyncIterable<Row>` via one `for await` loop. The error message now names
   the colliding key (`… collides under new collation (key: 'a')`), formatted with the existing
   `formatKeyValue` + `keyParts` (arity threaded from `primaryKeyArity(newSchema)`, per the
   BTreeKey scalar-vs-tuple invariant — never `Array.isArray`).
2. **Physical representability (BUSY)** — the existing per-layer `assertNoPrimaryKeyCollision`
   walk, unchanged in message and code. When `rows` is supplied the walk starts **at the view
   layer** (its committed rows are a different set from what pass 1 judged); when absent it
   starts at `view.getParent()` exactly as before.

The deliberate refusal of the deleted-only-collision case is kept and documented as physical
necessity (base rows must survive a rollback; the primary tree is a map, not a multi-map), with
cross-references to `backlog/bug-store-pk-collate-rejects-deleted-row-collision` and
`backlog/feat-transactional-ddl-native-backends`. The stale `NOTE:` at the `alterColumn` call
site claiming `rows` was deliberately ignored is replaced with an explanation of why the two
passes judge two different sets. `rebuildPrimaryTreeStrict`'s doc comment now names the
**layer-walk pass** as its precondition (the effective-row pass no longer implies base
cleanliness).

Plain memory leg (no wrapper): behavior identical except the `CONSTRAINT` message's new
`(key: …)` suffix.

## How to validate

- `yarn workspace @quereus/isolation test` — new suite covers all four shapes:
  deleted-only collision → `BUSY` + `/commit\/rollback and retry/i`; one-of-two deleted → same;
  two staged colliders → `CONSTRAINT` naming the key, **before** any mutation; committed
  colliders visible to the transaction → `CONSTRAINT` (pinned pre-existing behavior). Each
  asserts the underlying table's column collation is still `BINARY` via the live
  `getSchema()` (not the stale per-instance `tableSchema` snapshot).
- `yarn test` — full workspace green (7450 quereus + 324 isolation + rest, 0 failing).
- `yarn lint` and `yarn workspace @quereus/isolation run typecheck` — clean.
- Plain-memory in-transaction behavior pinned by the pre-existing
  `packages/quereus/test/ddl-in-transaction-validation.spec.ts` PK-collate suite (unchanged,
  passing).

## What was deliberately not changed

- `41.7.1-alter-column-collate-unique.sqllogic` untouched. Its `-- error: UNIQUE constraint
  failed` expectation is a substring match (`logic.spec.ts` uses `.include`), so the new key
  suffix passes; the file is cross-module and a key-naming assertion would break the store leg
  (different message). Existing memory-leg outcomes verified green under `yarn test`.
- `yarn test:store` was NOT run — no store code touched, and the store leg's error message and
  the sqllogic expectations are both unchanged.
- The deletion-marker + staged-row collision shape (marker and staged row collide only under
  the new rule) still ends in `INTERNAL` after mutation — that is the companion ticket
  `isolation-overlay-pk-rekey-collapses-deletion-markers` (in implement/, sequence 2), out of
  scope here by the ticket's own boundary.

## Known gaps / reviewer attention

- **BUSY wording under the wrapper is approximate in one corner.** The walk's message says
  "rows this transaction has removed still collide" — with `rows` supplied, a view-layer
  collision could in principle also involve a committed row *shadowed by a staged overwrite*
  rather than deleted. Same BUSY classification is correct either way; only the phrasing is
  narrower than the mechanism.
- **Which key gets named:** the probe names the second-seen row's key in stream order (the new
  test accepts `/key: '[Aa]'/`). Composite keys join with `, `. Blob keys render as `x'…'`
  (elided, from `formatKeyValue`).
- `assertNoPrimaryKeyCollision` keeps its general `code`/`message` parameters though the BUSY
  walk is now its only caller — harmless generality, flag if it bothers.
- The two pre-existing hint-level diagnostics in `base.ts` (`'await' has no effect` at ~419/440
  on the synchronous `rebuildAllSecondaryIndexes`) predate this ticket and were left alone.

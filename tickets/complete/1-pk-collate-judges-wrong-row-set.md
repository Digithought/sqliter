----
description: Changing the sorting rule of a primary-key column mid-transaction now checks the rows the transaction can actually see, so it no longer refuses over rows the transaction deleted with the wrong error, and no longer misses a clash between rows the transaction just inserted.
prereq:
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts        # validateRekeyedPrimaryKey + its two arms and the shared probe (~3510-3650), alterColumn call site (~2565)
  - packages/quereus/src/vtab/memory/layer/base.ts           # rebuildPrimaryTreeStrict doc-comment precondition (comment-only)
  - packages/quereus/test/ddl-in-transaction-validation.spec.ts  # memory-leg PK-collate suite; composite-key naming test added in review
  - packages/quereus-isolation/test/isolation-layer.spec.ts  # suite "SET COLLATE on a PRIMARY KEY column judges the transaction's effective rows" (4 tests)
  - docs/memory-table.md                                     # § DDL and transactions, rule 3 — rewritten in review
  - docs/module-authoring.md                                 # § EffectiveRowSource — BUSY carve-out added in review
difficulty: medium
----

# `alter column … set collate` on a PK column judges the right rows

## What was wrong

`MemoryTableManager.validateRekeyedPrimaryKey` ignored the `rows` argument (`EffectiveRowSource`
— the merged committed+staged stream a wrapper module like the isolation layer hands down) and
probed only its own layer chain. Under the isolation wrapper that meant:

- a collision confined to committed rows the transaction had **deleted** produced a false
  `CONSTRAINT` ("your data is invalid") instead of the retryable `BUSY`;
- two colliding rows the transaction had **staged** (both in the wrapper's overlay, none in the
  memory module's base) passed validation entirely — the shared table's collation was then
  mutated and the failure surfaced as `INTERNAL`.

## What shipped

`validateRekeyedPrimaryKey` is async, takes `rows?: EffectiveRowSource`, and asks two questions
over two different row sets:

1. **Legality → `CONSTRAINT`.** `assertNoPrimaryKeyCollisionInRows` probes the rows the
   transaction can see: `rows()` when supplied, else `effectiveDdlRows()`. Consumes
   `Iterable<Row> | AsyncIterable<Row>` in one `for await`. The message names the colliding key
   (`… collides under new collation (key: 'a')`), rendered via `keyParts` + `formatKeyValue` with
   arity from `primaryKeyArity(newSchema)` — never `Array.isArray`, per the BTreeKey invariant.
2. **Physical representability → `BUSY`.** `assertNoPrimaryKeyCollisionInLayer` walks the
   manager's own chain. With `rows` supplied the walk starts **at the view layer** (its committed
   rows are a different set from what pass 1 judged); without, at `view.getParent()` as before.

The refusal of the deleted-only-collision case stays, documented as physical necessity (base rows
must survive a rollback; the primary tree is a map, not a multi-map), cross-referenced to
`backlog/bug-store-pk-collate-rejects-deleted-row-collision` and
`backlog/feat-transactional-ddl-native-backends`.

Plain memory leg (no wrapper): behavior identical except the `CONSTRAINT` message's new
`(key: …)` suffix.

## Review findings

### Checked and clean — no action

- **Pass-order and set-selection logic.** Walked every reachable shape by hand on both legs
  (no wrapper / wrapper with and without staged rows; colliders committed-and-visible,
  committed-and-deleted, staged, split across the two). Pass 1 fires before pass 2 in every case
  where both would fire, and `CONSTRAINT`-before-`BUSY` is the right precedence each time.
- **`rows` is undefined when the wrapper has nothing staged** (`IsolationModule.issuerEffectiveRows`
  returns `undefined` unless `hasChanges`), so the isolated leg outside a transaction takes the
  unchanged path. The new isolation test that pins committed-collider `CONSTRAINT` deliberately
  stages an unrelated insert to force the supplied-`rows` path — correct, and now that it is
  load-bearing it is worth not "simplifying" away.
- **Pass 1 is stricter than the code it replaced, harmlessly.** The old pass returned early when
  a layer had no primary modification tree; `effectiveDdlRows()` falls back to the base tree
  instead. That closes a hole rather than opening one.
- **The implementer's flagged "BUSY wording is approximate" gap is not actually a gap.** For a
  committed collision to escape pass 1, at least one of the pair must be absent from the effective
  stream — under the isolation overlay that means tombstoned, which is what a delete *and* a
  PK-moving update both produce. A non-PK-column overwrite cannot create a new key collision. So
  "rows this transaction has removed" is accurate for every shape that reaches the message.
- **`41.7.1-alter-column-collate-unique.sqllogic` left untouched** — its `-- error:` expectation is
  a substring match, and the new key suffix passes. Confirmed by the full green run rather than by
  reading the matcher alone.

### Fixed in this pass (minor)

- **Stale docs — three sites, none touched by the implement pass.**
  `docs/memory-table.md` still stated that `validateRekeyedPrimaryKey` "deliberately ignores"
  the wrapper's rows (the exact behavior this ticket removed), and its rule 3 still described a
  one-pass check. Both rewritten to the two-question form, including why the sets diverge and
  where each walk starts. `docs/module-authoring.md`'s `EffectiveRowSource` contract said a module
  "MUST NOT reject the DDL over a duplicate that exists only in its own committed data" — now
  true of *constraint* rejections only, so the PK-tree carve-out is spelled out there with the
  requirement that it be `BUSY`, never `CONSTRAINT`.
- **Duplicated probe loop.** `assertNoPrimaryKeyCollisionInRows` and the layer walk each built
  their own `BTree` probe and open-coded the get/insert/throw. Extracted `makePrimaryKeyProbe`
  (returns a `(row) => duplicateKey | undefined` closure) and kept the two arms as thin,
  self-naming callers — the sync arm stays sync, so no `for await` overhead was added to the
  per-layer walk.
- **Dead generality.** `assertNoPrimaryKeyCollision`'s `code`/`message` parameters had exactly one
  caller left. Renamed to `assertNoPrimaryKeyCollisionInLayer`, which now owns its own `BUSY`
  status and wording — matching `…InRows`, which already owned `CONSTRAINT`. The implementer
  flagged this themselves.
- **Test gap: composite primary keys.** The `keyIsTuple` arm of the new message was untested on
  both legs; a wrong flag renders garbage instead of the value the user has to fix. Added
  `names the colliding key, joining the parts of a composite primary key` to the memory-leg suite
  in `ddl-in-transaction-validation.spec.ts` (`primary key (a, b)`, collate on `b`, asserts
  `key: 'x', 'Q'`). Passes.

### Tripwires recorded (not tickets)

- The duplicate probe holds every row it has seen, because the BTree derives its key from the
  stored value — an ALTER over a large table transiently doubles that table's row references.
  Parked as a `NOTE:` on `makePrimaryKeyProbe` with the fix (key a `Set` by `pkFunctions.encode`)
  should it ever become the memory peak. The pre-existing O(layers × rows) time `NOTE:` on the
  layer walk still stands alongside it.

### New tickets filed

None. Nothing found rose to major:

- `manager.ts` is now ~3850 lines and `validateRekeyedPrimaryKey` carries a ~45-line doc comment.
  Real hygiene pressure, but already owned by `backlog/debt-memory-alter-column-method-too-long`;
  filing a second file-size ticket would duplicate it. The comment was left long deliberately —
  it is the only place the two-set rationale lives at the code site, and `docs/memory-table.md`
  now carries the same reasoning for readers who never open the file.
- The deletion-marker + staged-row shape (marker and staged row collide only under the new rule)
  still ends in `INTERNAL` after mutation. Out of scope by this ticket's own boundary and already
  owned by `implement/2-isolation-overlay-pk-rekey-collapses-deletion-markers`.

## Validation

- `yarn lint` — clean (eslint + `tsc -p tsconfig.test.json --noEmit` for `packages/quereus`).
- `yarn test` — 7451 passing, 13 pending, **0 failing** across the workspace (7451 = the
  implement pass's 7450 plus this review's composite-key test), plus 324 isolation and the rest.
- `yarn test:store` deliberately not run: no store code is touched, the store leg's own error
  message is unchanged, and the sqllogic expectations it shares are substring matches that the
  memory leg already proved still match.

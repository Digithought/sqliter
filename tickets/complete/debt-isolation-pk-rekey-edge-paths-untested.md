----
description: Added tests for three rarely-hit safety checks in the transaction layer's handling of primary-key sort-order changes, so a future refactor that breaks any of them now turns a test red.
files:
  - packages/quereus/test/memory-vtable.spec.ts               # "TransactionLayer.rekeyPrimaryKey deletion replay" suite (3 tests)
  - packages/quereus-isolation/test/isolation-layer.spec.ts   # new test in the "foreign overlays under a cross-connection PK re-key" suite; helper consolidation
  - packages/quereus-isolation/src/isolation-module.ts        # comment-only: NOTE on the foreign-poison branch
  - docs/design-isolation-layer.md                            # corrected a poison-path claim the new test falsifies
----

# Coverage added for the primary-key re-sort safety paths

No behavior changed. The only non-test source edit is a comment. Everything below is tests,
comments, and one doc correction.

## What is covered

Changing the collation of a primary-key column re-sorts the table. Three checks make that safe
in edge cases; none had a test before this work.

### 1. A second connection's staged rows refuse the re-sort for the *retryable* reason

Every other open connection's uncommitted staging area has to adopt the re-sort or be marked
"poisoned" (its owner is told at its next read/write/commit and recovers by rolling back). Two
refusal kinds route to poison: a genuine duplicate (already tested), and a *retryable* refusal
the storage module raises when the re-sort is unrepresentable given that connection's savepoint
history (not tested).

Test: `poisons a foreign overlay whose staging table refuses the re-key as RETRYABLE`. It stages
the second connection's rows inside a real open transaction frozen behind a savepoint (helper
`injectOverlayRowsBehindSavepoint`) — the existing helper's writes autocommit, leaving a
one-layer history that can always be re-sorted, which is why the path was unreachable from this
suite. Asserts the issuing connection's change still applies, the second connection is poisoned
and its commit aborts, and the refusal was not silently absorbed.

### 2. A replayed deletion must remove the row it actually deleted

Re-sorting rewrites each open transaction layer; a recorded deletion is replayed by looking its
key up in the already re-sorted parent, where it can land on a *different* row whose key now
compares equal. A check confirms, under the old sort order, that the row found is the row this
layer removed.

Tests 1 and 2 of `TransactionLayer.rekeyPrimaryKey deletion replay`: the check fires (an
unrelated row survives), and it is not over-broad (a layer's own deletion still applies).

### 3. A deletion whose key an upsert now occupies is dropped from the replay log

The companion filter in the same method, covering a single statement that deletes one key and
writes a case-variant of it. Test 3 of the same suite (added during review — see findings).

All three unit tests build the layer chain directly, because the validation pass that runs
ahead of the re-sort refuses every chain that could reach these arrangements. That is what makes
the checks insurance rather than live logic, and the only way to exercise them.

## Validation performed

- `yarn build` — clean.
- `yarn lint`, `yarn typecheck` — clean.
- `yarn test` (all workspaces) — **10 281 passing, 0 failing.** No pre-existing failures
  surfaced; `tickets/.pre-existing-error.md` was not written.
- Every new test mutation-checked: each was re-run against a deliberately broken source and
  confirmed to fail, then the source was reverted. `git diff` confirms no source file other than
  the one comment is modified.

## Review findings

### Checked

The implement-stage diff was read first, then the guards themselves in source
(`TransactionLayer.installNetOwnWrites` / `rekeyPrimaryKey`,
`IsolationModule.applyInPlaceOverlayChange`, `MemoryTableManager.validateRekeyedPrimaryKey`'s two
arms, `alter-migration.ts`'s marker drop / reinsert pair), then reachability of each arrangement
by hand, then the tests, then the docs the change touches or should have touched.

### Fixed in this pass

- **The unit-test fixture built an arrangement the engine cannot produce.** It had the child
  layer delete a key that no layer in the chain held. Every `recordDelete` call site in
  `MemoryTableManager` resolves the effective row first and skips the call when there is none, so
  a deletion of a nonexistent key is never recorded — the fixture was testing the check against a
  shape it will never see. Reworked so the base commits the row the child deletes: the exact
  scenario `rekeyPrimaryKey`'s own doc comment describes. The recorded old row is now resolved
  from the chain the way the manager does it, which enforces the precondition structurally.
  Re-verified by mutation on the new fixture.
- **A suite comment stated the wrong reason the check is unreachable.** It credited the
  validation pass with refusing "every chain that could reach that arrangement", but for the old
  fixture that pass would have *permitted* the chain (no layer held a colliding pair) — the real
  blocker was the `recordDelete` precondition above. Corrected, and now accurate of the new
  fixture.
- **A third copy of the same structural helper.** `isolation-layer.spec.ts` already carried two
  near-identical `getSchema()` narrowing helpers and the diff added a third. Consolidated all
  five copies in that file (two collation readers, two column-count readers, one notNull reader)
  into one file-scope `liveSchema` plus a `liveCollation` built on it. Net −40 lines, no
  behavior change.
- **The new isolation test did not pin the state the tripwire is about.** It asserted collation,
  poison and object identity but never looked at what the poisoned staging area was left holding
  — which is exactly what the new NOTE documents. Added an assertion: the collapsed deletion
  marker is dropped and not restored. It passes, so the NOTE describes real behavior rather than
  a suspicion.
- **`docs/design-isolation-layer.md` was wrong about that same behavior.** It claimed a poisoned
  overlay "stays whole, in its pre-DDL shape". The assertion above falsifies that for the
  primary-key re-sort path. Amended to state the exception, why it is inert, and what would have
  to change first.
- **An uncovered branch in the same method.** The filter that drops a deletion an upsert has
  since re-occupied had no coverage anywhere in the engine's 2 943 tests — confirmed by removing
  it and running the whole package, where only the new deletion-identity test failed (for its own
  reason). It is reachable in production: a single `update t set k = 'a' where k = 'A'` inside a
  transaction, followed by the re-sort, produces exactly that shape. Added a third unit test and
  mutation-verified it. Scope-adjacent rather than in scope, but the fixture already existed and
  the branch is one line away from the ones the ticket named.

### Major findings

**None — no new ticket filed.** Both guards behave as documented under every arrangement traced,
the error routing matches what the design doc describes, and the diff changes no behavior. The
findings above are all fixture fidelity, comment accuracy, duplication, and coverage.

### Tripwires

- The implementer's NOTE on the foreign-poison branch in `isolation-module.ts` was reviewed and
  kept. Its premise was verified: poison is never cleared, only discarded together with the whole
  staging area on rollback, so the un-restored marker drops cannot be observed. It is now also
  pinned by a test assertion and reflected in the design doc.
- No new tripwires were parked.

### Known gaps left open, deliberately

- **The cross-connection test is white-box.** The second connection's staging area is built by
  hand rather than by a second `Database` running real SQL, matching how the rest of that suite
  works. Driving it for real needs one table visible in two database catalogs. Left unfiled: the
  test pins the error-routing contract, which is what the check actually is, and the end-to-end
  route adds harness, not coverage of this branch.
- **The issuer-side retryable rethrow is still untested.** With the bundled staging module the
  pre-flight catches that condition before the shared table mutates, so the rethrow is reachable
  only through a host-injected staging module. Already documented at the site; left as-is.
- **The unit tests pin the checks' contracts, not reachable user scenarios** (except the third,
  which is reachable). That is inherent — the validation pass refuses these chains upstream. If a
  future reviewer decides a check should be deleted in favour of that pass, its tests go with it;
  the original reasoning was the opposite, keep the check so the pass can be loosened later.

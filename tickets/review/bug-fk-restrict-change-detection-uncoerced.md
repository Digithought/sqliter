description: Added regression tests and a docs note for a fixed bug where rewriting a foreign-key-referenced value with an equivalent but differently-typed spelling (e.g. the number 1 typed as the text '1') was wrongly rejected as a real change to that value.
files:
  - packages/quereus/src/runtime/foreign-key-actions.ts        # anyReferencedColumnChanged + its 4 call sites (fix landed in a prior ticket; unmodified here)
  - packages/quereus/test/logic/41-foreign-keys.sqllogic        # new "change-detection short-circuit" phase (mixed restrict+cascade parent, un-batched path)
  - packages/quereus/test/logic/41.9-fk-restrict-batched.sqllogic  # new batched-path case (accumulateParentRestrictKeys)
  - packages/quereus/test/lens-enforcement.spec.ts              # new lens-routed case (resolveLensFkParentReferencedValues)
  - docs/runtime.md                                              # § Batched RESTRICT — coercion note added
difficulty: easy
---

# Regression coverage for the RESTRICT change-detection coercion fix

## What this ticket covers

The fix itself landed in an earlier ticket (`bug-fk-restrict-change-detection-uncoerced`,
already in the tree before this pass started): a shared helper,
`anyReferencedColumnChanged` in `packages/quereus/src/runtime/foreign-key-actions.ts:100`,
decides whether an UPDATE actually changes a value a child table's foreign key points at.
It used to compare the stored OLD value against the raw, un-coerced NEW value, so writing
the integer `1` as the text `'1'`, or a JSON object with reordered keys, read as "changed"
and wrongly ran (and failed) the RESTRICT enforcement scan. The fix re-coerces a
non-identical NEW value through the column's logical type before comparing again. This
ticket's job was purely to add regression tests and a docs note — no production code
changed here.

## Test coverage added

**`packages/quereus/test/logic/41-foreign-keys.sqllogic`** (new phase at the end of the
file): a parent table with *both* a RESTRICT child and a CASCADE child on the same
column. Mixing a cascading inbound FK with a RESTRICT one takes the parent update off the
"batchable" fast path (see `docs/runtime.md` § Batched RESTRICT), so the update runs the
per-row transitive walk (`assertNoRestrictedChildrenForParentMutation` plus the
cascade-recursion arm of `assertTransitiveRestrictsForParentMutation`) instead of the
batched accumulator. Two variants: an INTEGER key rewritten as text `'1'`, and a JSON key
rewritten with reordered keys — both must leave the stored value and the cascade child
untouched. Each is paired with a negative case: a genuine key change with a live RESTRICT
child must still fail (surfaces as `CHECK constraint failed: _fk_<child>_<col>` here — see
gap below on error-message shape). A separate small case pins that `ON DELETE RESTRICT`
(no NEW row, so the short-circuit never runs for it) is unaffected.

**`packages/quereus/test/logic/41.9-fk-restrict-batched.sqllogic`** (new section 11): the
same two respelling cases (integer-as-text, JSON reorder) against a schema with a single
RESTRICT FK — this one *is* batchable, so it specifically exercises
`accumulateParentRestrictKeys`. Each is paired with a genuine-re-key negative case, which
here does surface the batched flush's friendly `violates RESTRICT from '<child>'` message.

**`packages/quereus/test/lens-enforcement.spec.ts`**: one new test in the "parent-side FK
RESTRICT over a non-restrict basis (runtime pre-check)" describe block, reusing the
existing `deployLensRestrictOverBasis` fixture (basis FK is CASCADE, logical FK is bare ⇒
RESTRICT). Rewrites the integer parent key as text `'1'` through the logical view and
asserts no abort and no child mutation — this is the one path that reaches
`resolveLensFkParentReferencedValues`.

**`docs/runtime.md`** § Batched RESTRICT: added a paragraph noting that "changed" is
decided against the value the column will actually store (re-coerced via the same
`validateAndParse` conversion `coerceRowToSchema` applies), not the raw UPDATE text, and
that collation is deliberately excluded from that comparison.

## Validation

- `yarn test` (full workspace) — all green, 7188 passing in `@quereus/quereus` alone, 0
  failing anywhere.
- `yarn test:store` — 7182 passing, 19 pending (pre-existing store-mode exclusions listed
  in `test/logic.spec.ts`), 0 failing.
- `yarn workspace @quereus/quereus run lint` — clean (exit 0).

## Gaps / things worth a second look

- **Error message shape differs by path, and I only discovered this empirically.** A
  genuine key change on a *batchable* schema (single RESTRICT FK) throws the friendly
  `FOREIGN KEY constraint failed: ... violates RESTRICT from '<child>'` at end-of-statement
  flush. The same genuine change on a *non-batchable* schema (mixed RESTRICT+CASCADE, as in
  my 41-foreign-keys.sqllogic addition) instead throws the generic plan-time
  `CHECK constraint failed: _fk_<child>_<col>` — the synthesized parent-side `NOT EXISTS`
  fires before the runtime pre-walk gets a chance. I hadn't anticipated this until the test
  run showed it; both are legitimate rejections, but if you're auditing error-message
  consistency across enforcement paths, this divergence is pre-existing and out of this
  ticket's scope.
- **`executeForeignKeyActions` (the actual physical CASCADE/SET NULL/SET DEFAULT action
  executor, not the RESTRICT pre-check) has no `anyReferencedColumnChanged` short-circuit
  at all** — it unconditionally re-issues the cascade UPDATE/DELETE for every parent write
  with a cascading inbound FK, regardless of whether the referenced column actually moved.
  For a value-preserving respell (this ticket's scenario) the re-issued cascade UPDATE
  binds the same coerced value on both sides of `SET x = ? WHERE x = ?`, so it's an
  observable no-op — my sqllogic assertions (`SELECT p_id FROM ..._cascade_child`) confirm
  the *value* is unaffected, and all new tests pass. I did not verify whether a redundant
  UPDATE statement literally fires under the hood (e.g. via instrumentation) — only that
  final state is correct. If cascade-firing overhead or side effects (triggers, event
  emission on the child table) ever matter, this is the place to look; parking it here
  rather than filing a ticket since nothing is currently wrong.
- Coverage of the four call sites (`accumulateParentRestrictKeys`,
  `assertTransitiveRestrictsForParentMutation` step 2, `assertNoRestrictedChildrenForParentMutation`,
  `resolveLensFkParentReferencedValues`) is by test *design* (schema shapes chosen per
  `docs/runtime.md`'s stated batchability gate), not by measured code coverage — I did not
  run a coverage tool to confirm each new test actually executes the call site I intended.

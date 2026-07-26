---
description: An update that rewrites a linked-to column with the same value spelled differently — the number 1 typed as the text '1' — was wrongly rejected as if it were changing the link. The cause is found and a working fix is already in the tree; it needs regression tests and a docs note.
files:
  - packages/quereus/src/runtime/foreign-key-actions.ts        # anyReferencedColumnChanged + the four call sites (fix already applied)
  - packages/quereus/src/runtime/emit/dml-executor.ts          # accumulateParentRestrictKeys call sites (signature gained parentTable)
  - packages/quereus/src/types/validation.ts                   # validateAndParse — the coercion the comparison was missing
  - packages/quereus/test/logic/41-foreign-keys.sqllogic       # existing FK coverage; new cases belong alongside
  - packages/quereus/test/logic/41.9-fk-restrict-batched.sqllogic  # batched-RESTRICT path needs the same case
  - packages/quereus/docs/runtime.md                           # § Batched RESTRICT — the accumulate entry point is documented here
difficulty: easy
---

# A restricted foreign key rejected an update that did not change the key

## What was wrong

A parent row's key column can be written with a value that *looks* different from
what is stored but converts to the same stored value — the integer `1` written as
the text `'1'`, or a JSON value written with different whitespace.

Before applying an update, the engine asks "did any column a child table points at
actually change?" and skips the RESTRICT enforcement scan when the answer is no.
That question compared the stored old value against the **raw text the user typed**,
with no type conversion. So `1` versus `'1'` read as a change, the scan ran, found
the children that (correctly, and still) point at the parent, and rejected the
statement.

Both reproductions from the source ticket were confirmed failing on the tree, and
both now pass.

## The fix (already applied — verify, don't re-derive)

`packages/quereus/src/runtime/foreign-key-actions.ts` gained one shared helper,
`anyReferencedColumnChanged(parentTable, colIndices, oldRow, newRow)`. It compares
each referenced column and, when the two values are not already identical,
re-coerces the proposed value through that column's logical type
(`validateAndParse` — exactly what `coerceRowToSchema` applies a moment later in the
storage layer) and compares again.

It replaced the four hand-rolled `sqlValueIdentical` loops:

- `accumulateParentRestrictKeys` — batched path
- `assertTransitiveRestrictsForParentMutation` — step 2, cascade recursion
- `assertNoRestrictedChildrenForParentMutation` — direct RESTRICT pre-check
- `resolveLensFkParentReferencedValues` — the lens-routed variant

`accumulateParentRestrictKeys` needed the parent `TableSchema` to reach the column
types; it did not have one (`BatchableRestrictFk` carries only the *child* table), so
it gained a `parentTable` parameter. Both call sites in `dml-executor.ts` pass the
`tableSchema` already in scope.

### Two deliberate choices, both erring the same way

A comparison that wrongly says "changed" costs one redundant RESTRICT probe. One
that wrongly says "unchanged" would *skip enforcement* and let a real violation
through. Every fallback therefore reports "changed": a column with no declared
logical type, and a coercion that throws.

**Collation is deliberately not applied**, which departs from the source ticket's
suggested direction. The question this comparison answers is "will the stored value
differ?", not "would an equality test call these equal". A `NOCASE` parent column
still stores `'A'` and `'a'` as distinct values, and the child's own match runs under
the *child* column's collation — which may be `BINARY`. Treating a case-variant
rewrite as "unchanged" would therefore skip enforcement and orphan children. The
reasoning is recorded in the helper's doc comment; keep it there.

The coerced value is a throwaway comparison copy and never escapes the helper — the
row handed to the storage layer stays raw, so JSON's parse step is not run twice
(see `bug-json-string-scalar-not-round-trip-safe`).

## State of validation

- Both repros pass (scratch spec, since deleted — the permanent versions are the
  TODO below).
- `yarn test` — full suite green.
- `yarn workspace @quereus/quereus run lint` — clean.

Not yet run: `yarn test:store`. The change is backend-agnostic (it touches only the
pre-write comparison, never the row that reaches a substrate), so a store-path
divergence is unlikely, but it is unverified.

## TODO

- Add sqllogic regression coverage for the un-batched RESTRICT path (the source
  ticket's two repros verbatim): integer key rewritten as `'1'` succeeds and leaves
  `p.id` as `1`; JSON key rewritten with different whitespace succeeds. Alongside
  each, the negative case — a genuine key change with a live child still raises the
  RESTRICT error — so the fix cannot silently disable enforcement. Add to
  `test/logic/41-foreign-keys.sqllogic`.
- Cover `on delete restrict` too: a delete is unaffected by the change-detection
  short-circuit (there is no NEW row), so this is a guard that the refactor did not
  disturb the delete path.
- Add the same "differently-spelled, same value" case to
  `test/logic/41.9-fk-restrict-batched.sqllogic`, which exercises
  `accumulateParentRestrictKeys` — the one call site whose signature changed.
- Cover the lens-routed variant (`resolveLensFkParentReferencedValues`). Check
  whether `test/lens-enforcement.spec.ts` already has a logical-FK RESTRICT fixture
  to extend before building a new one.
- Confirm the coercion did not shift the *cascade* short-circuit's behavior: the
  same helper now gates `on update cascade` propagation, so an update that rewrites
  a parent key with an equivalent spelling should now leave child rows untouched
  rather than issuing a no-op cascade UPDATE. Assert the child rows are unchanged.
- Run `yarn test:store` once to confirm the store path agrees.
- Add a sentence to `docs/runtime.md` § Batched RESTRICT noting that the
  referenced-column-change short-circuit coerces the proposed value before
  comparing, and why collation stays out of it.

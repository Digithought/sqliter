---
description: When a table's identity columns are allowed to be empty, the transaction layer builds a bad internal lookup key for rows that have an empty one, and can hide the wrong rows from a query running inside that transaction.
files:
  - packages/quereus-isolation/src/isolated-table.ts (~553-567 — `pkShadowKey`, the `serializeKey(...)!`)
  - packages/quereus/src/util/key-serializer.ts (`serializeKey` returns `string | null`; `serializeKeyNullGrouping` is the NULL-tolerant sibling)
  - packages/quereus/src/index.ts (~336 — both are already exported)
  - packages/quereus-isolation/test/ (add the regression here)
difficulty: easy
repro: static
---

# A NULL in a primary key collapses the isolation layer's shadow key

## What is wrong

`quereus-isolation` serves a *merged secondary-index read* by scanning the transaction's
overlay once, collecting the primary key of every row the transaction has touched
("modified PKs"), then scanning the committed underlying table and skipping any committed
row whose primary key is in that set — because the overlay already carries the newer image
of it. That set is keyed by a serialized primary-key string built here
(`packages/quereus-isolation/src/isolated-table.ts` ~560):

```ts
const pkShadowKey = (row: Row): string => serializeKey(
    pkIndices.map(/* … semantic transforms … */),
    pkNormalizers,
)!;
```

`serializeKey` is declared `string | null` and **returns `null` as soon as any component
value is NULL** (`packages/quereus/src/util/key-serializer.ts` ~101-113). The `!` asserts
that never happens. The comment above it states the assumption outright:

> `!` on the serialized key is safe: PK columns are NOT NULL, so serializeKey never returns
> null

That assumption is false today. A table that declares **no** `PRIMARY KEY` gets an
all-columns key synthesized for it, and that synthesized key does **not** force its columns
NOT NULL — each keeps its declared nullability (`packages/quereus/src/schema/table.ts`
`findPKDefinition`, and `docs/schema.md` § "Primary-key nullability"). So any no-PK table
with a nullable column can produce a row whose primary key contains NULL.

When that happens `pkShadowKey` returns `null` (typed as `string` by the `!`). Every such
row — committed or overlaid — maps to the *same* shadow key. One overlaid row with a NULL
key component therefore shadows **every** committed row that also has a NULL key component,
and those committed rows silently vanish from the merged read.

## Why it matters beyond today

`tickets/implement/feat-relax-declared-primary-key-not-null` removes the NOT NULL promotion
from *declared* primary keys as well, which widens this from "no-PK tables under a nullable
column default" to "any table whose key columns are nullable". This must be fixed first.

## The fix

`serializeKeyNullGrouping` (same module, ~121-136) is the NULL-as-a-value sibling: it emits
a distinct `N:` marker for a NULL component instead of bailing out, so two rows differing
only in *which* component is NULL still get distinct keys. That is exactly the semantics a
primary key needs here — NULL is an ordinary self-equal value in key position on both
backends. Both symbols are already exported from `@quereus/quereus`
(`packages/quereus/src/index.ts` ~336) and `serializeKeyNullGrouping` is already used this
way by `quereus-sync` (`packages/quereus-sync/src/metadata/keys.ts`).

Swap the call, drop the `!`, and rewrite the comment to say why NULL is a legitimate key
component rather than why it cannot occur.

## Edge cases & interactions

- **Two committed rows, both with NULL in the same key column, one modified in the
  overlay.** The unmodified one must still surface. This is the headline case and the one
  the current code gets wrong.
- **Rows differing only in *which* component is NULL** — `(null, 1)` vs `(1, null)`. Must
  produce different shadow keys. `serializeKeyNullGrouping` handles this because it keeps
  positional separators; assert it rather than assuming it.
- **NULL vs the literal string `'N:'`** in a text key column. `serializeKeyNullGrouping`
  builds on the type-tagged `appendValue`, so a real string is tagged distinctly from the
  NULL marker — confirm with a test case, since a collision here would be a silent
  wrong-row bug of the same shape.
- **Collation normalizers on a NULL component.** Normalizers only run on string values; a
  NULL component must skip normalization without throwing.
- **Semantic-ordering key transforms** (the `semanticKeyTransform` / TIMESPAN groupKey path
  immediately above the call). The existing `transform && v !== null` guard already leaves
  NULL alone; keep it, and make sure the build side and the probe side still go through the
  one encoder so they cannot drift.
- **Deletes/tombstones.** A tombstone row in the overlay carries the deleted row's key; a
  NULL-keyed delete must shadow exactly the one committed row it deleted.
- **Both storage backends.** The merged secondary read path is isolation-layer code, so the
  regression belongs in `packages/quereus-isolation/test/`, but confirm the same scenario
  through the store leg if the harness there reaches it.

## TODO

- Reproduce first: a `quereus-isolation` test that creates a table with a nullable key
  column (either `pragma default_column_nullability = 'nullable'` with no `PRIMARY KEY`, or
  explicit `null` columns and no `PRIMARY KEY`), commits two rows whose key components are
  NULL, opens a transaction, modifies one of them, and reads through a secondary index.
  Assert the unmodified row is still returned. Confirm it fails before the fix.
- Replace `serializeKey(...)!` with `serializeKeyNullGrouping(...)` in `pkShadowKey`; remove
  the non-null assertion; update the import.
- Rewrite the comment above it: NULL is a legitimate primary-key component (memory compares
  `NULL == NULL` equal and orders NULL first; the store key codec encodes `TYPE_NULL`
  first), so the shadow key must treat it as a value, not as "no key".
- Add the differing-NULL-position and `'N:'`-string cases from the list above.
- Run `yarn test` (and the isolation package's own suite) plus `yarn lint`.
- Grep once more for other `serializeKey(` call sites that index primary-key columns and
  assert non-null; state in the review handoff what you found (the sweep done during
  planning found only this one — `database-transaction.ts` uses the NULL-safe
  `encodeKeyTuple`, and the store's `dedupeRowSignature` returns null deliberately for
  SQL's NULL-distinct UNIQUE rule).

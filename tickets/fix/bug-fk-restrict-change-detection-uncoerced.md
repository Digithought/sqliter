---
description: An update that rewrites a linked-to column with the same value spelled differently — the number 1 typed as the text '1' — is wrongly rejected as if it were changing the link, so the statement fails with a foreign key error even though nothing actually changed.
files:
  - packages/quereus/src/runtime/foreign-key-actions.ts        # the four "did a referenced column change?" comparisons
  - packages/quereus/src/runtime/emit/dml-executor.ts          # processUpdateRow — calls both entry points BEFORE vtab.update()
  - packages/quereus/src/types/validation.ts                   # validateAndParse — the coercion the comparison is missing
difficulty: medium
---

# A restricted foreign key rejects an update that did not actually change the key

## Plain statement of the problem

A parent row's key column can be written with a value that *looks* different
from what is stored but converts to the same stored value: the integer `1`
written as the text `'1'`, or a JSON value written with different whitespace.

Before applying an update, the engine asks "did any column that a child table
points at actually change?" — and if not, it skips the RESTRICT enforcement
scan entirely. That question is answered by comparing the stored old value
against the **raw text the user typed**, without first converting the typed
value the way storage will. So `1` versus `'1'` reads as a change, the RESTRICT
scan runs, it finds the children that (correctly, and still) point at the
parent, and the statement is rejected.

Nothing about the row is actually changing on that column. The update should
succeed.

## Reproductions

Both confirmed on the current tree (memory backend).

**Integer key rewritten as text:**

```sql
create table p (id integer primary key, note text);
create table c (id integer primary key,
                pid integer references p(id) on update restrict on delete restrict);
insert into p values (1, 'a');
insert into c values (10, 1);

update p set id = '1', note = 'b';
--   Error: FOREIGN KEY constraint failed: UPDATE on 'p' violates RESTRICT from 'c'
--   Expected: succeeds; p.id stays 1, p.note becomes 'b'
```

**JSON key rewritten with different whitespace:**

```sql
create table pj (j json primary key, note text);
create table cj (id integer primary key, pj json references pj(j) on update restrict);
insert into pj values ('{"a":1}', 'a');
insert into cj values (10, '{"a":1}');

update pj set j = '{ "a" : 1 }', note = 'b';
--   Error: FOREIGN KEY constraint failed: UPDATE on 'pj' violates RESTRICT from 'cj'
--   Expected: succeeds; the stored JSON is unchanged
```

## Where it comes from

Four places in `packages/quereus/src/runtime/foreign-key-actions.ts` ask the
"did a referenced column change?" question, and all four compare with
`sqlValueIdentical`, which is a byte/value identity test with no type
conversion:

- `accumulateParentRestrictKeys` (~line 92) — the batched path
- `assertTransitiveRestrictsForParentMutation` (~line 401)
- `assertNoRestrictedChildrenForParentMutation` (~line 540)
- the lens-routed variant (~line 771)

`packages/quereus/src/runtime/emit/dml-executor.ts` (`processUpdateRow`) calls
into these with the raw proposed row, deliberately **before** `vtab.update()`
runs. The OLD row comes from the source scan, so it is already stored (and
therefore converted); the NEW row is still exactly what the user typed. The two
sides are not comparable.

The pre-write ordering is intentional and documented — rowid-mode backends need
the RESTRICT walk to fire before the parent is mutated, because a post-mutation
scan for the OLD values dereferences through the already-changed parent and
finds nothing. So this cannot be fixed by reading the row back after the write.

## Direction that looks right

Apply the column's declared type to the proposed value before comparing, exactly
the way the same file's sibling problem was already handled elsewhere:
`dml-executor.ts`'s `conflictTargetValuesMatch` re-coerces the proposed value
with `validateAndParse` before matching it against a stored row, for precisely
this reason. The comparison should also honour the referenced column's
collation, the way an equality check on that column would.

Erring in the safe direction matters here: a comparison that wrongly says
"changed" costs a redundant RESTRICT scan (today, a wrong error); one that
wrongly says "unchanged" would *skip* enforcement and let a real violation
through. Whatever is done must not introduce the second kind.

Worth checking while working this: the coercion here would be a second
conversion of the same value (storage converts again a moment later), so it must
be a throwaway comparison copy that never flows onward — the row that reaches
the storage layer has to stay raw, because JSON's parse step is not safe to run
twice on an already-parsed value. See `bug-json-string-scalar-not-round-trip-safe`.

## Expected behavior

- An update that rewrites a referenced parent column with a differently-spelled
  but equivalent value is not treated as a change, and no RESTRICT error is
  raised.
- Genuine changes to a referenced column still raise RESTRICT when children
  reference the old value.
- The same holds for `on delete restrict` and for the lens-routed variant.
- The row reaching the storage layer is still the raw proposed row.

## Related

Found while working `bug-dml-downstream-uses-uncoerced-row`, which fixed the
*post*-write half of the same class (everything downstream of a write now uses
the row the substrate stored). This is the pre-write half and needs a different
mechanism.

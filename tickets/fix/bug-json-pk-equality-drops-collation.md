---
description: A disk-backed table can silently accept a row that breaks a uniqueness rule, when its primary key is a JSON value that happens to be a piece of text spelled like a number. The same table stored in memory correctly rejects it.
files:
  - packages/quereus-store/src/common/store-table.ts       # resolvePkSemanticEquality — builds the comparator with no collation
  - packages/quereus-isolation/src/isolated-table.ts       # getPkSemanticComparators — same omission (line ~95)
  - packages/quereus/src/types/json-type.ts                # JSON_TYPE.compare — the collation-less branch that re-parses string leaves
  - packages/quereus-store/src/common/json-key.ts          # header NOTE describing this divergence
  - packages/quereus-store/test/json-semantic-key-order.spec.ts  # natural home for the regression test
difficulty: medium
---

# JSON primary keys compare as "the same row" when they are different rows

## What goes wrong

A JSON value may be a bare piece of text (a "string scalar" — `'"9"'` in SQL, which the
engine stores as the JavaScript string `9`). Two such values that differ as text but
would parse to the same number — `"9"` and `"9.0"` — are treated as **the same primary
key** by two "is this the same row?" checks, even though every ordering path, the
in-memory backend, and the stored key bytes correctly treat them as different rows.

Reproduction (disk-backed store vs the same table in memory):

```sql
create table t (j json primary key, u text unique) using store;
create table m (j json primary key, u text unique);

insert into t values ('"9"', 'dup');
insert into t values ('"9.0"', 'dup');   -- ACCEPTED: two rows, both u = 'dup'

insert into m values ('"9"', 'dup');
insert into m values ('"9.0"', 'dup');   -- correctly raises UNIQUE constraint failed
```

The store ends with two rows sharing `u = 'dup'` under a `unique` column. Nothing later
repairs it: the duplicate is durably written.

## Why

The uniqueness check excludes the row being written from its own conflict search by
asking "is this candidate row the same row as the one I'm inserting?", using a
primary-key comparator built from the column's logical type. Both places that build it
pass **no collation**:

- `resolvePkSemanticEquality` in `packages/quereus-store/src/common/store-table.ts`
- `getPkSemanticComparators` in `packages/quereus-isolation/src/isolated-table.ts`

`JSON_TYPE.compare` only honours plain text-vs-text comparison **when a collation is
supplied**. With none, it falls through to re-parsing each side as JSON, so the strings
`9` and `9.0` both parse to the number 9 and compare equal. The self-exclusion then
believes the conflicting existing row *is* the row being inserted, and the violation is
swallowed.

Every other JSON path already passes a collation (BINARY) and gets this right — the
isolation merge, the store's key bytes, and the memory backend's index all rank `"9"`
before `"9.0"` by code point.

## Scope

- Pre-dates the structural JSON key encoding (`bug-json-pk-store-scan-order`); the old
  canonical-text key bytes disagreed with these comparators in exactly the same way.
- Only reachable when a JSON key member holds a **string scalar** whose text is itself
  parseable as JSON. Structured values (`'["9"]'` vs `'["9.0"]'`) already behave
  correctly, which is why the existing tests miss it.
- The isolation-layer site has the same defect and should be fixed alongside — its
  comparator decides overlay shadowing, so a staged row can fail to shadow (or wrongly
  shadow) the committed row it replaces.

## Expected behaviour

Two JSON primary keys are the same row exactly when the ordering comparator and the
physical key bytes call them equal. Concretely: the repro above must raise
`UNIQUE constraint failed` on the store exactly as it does in memory, and an
in-transaction update of one such row must not disturb the other.

Note that TIMESPAN — the other type routed through these comparators — is unaffected
either way (it takes no collation), so the fix must not change its behaviour.

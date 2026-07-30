description: Joining binary (BLOB) column values into a single string produces a list of decimal byte numbers instead of the bytes' text, and the numbers are separated by the same comma used between values, so the result cannot be split back apart.
files:
  - packages/quereus/src/func/builtins/aggregate.ts   # group_concat implementation (verify path)
  - packages/quereus/src/util/coercion.ts             # value → text conversion used by aggregates
---

# `group_concat` over BLOB values renders decimal byte numbers

## Observed

```sql
create table bt (id integer primary key, b blob);
insert into bt values (1, x'6162'), (2, x'6163'), (3, x'6162');

select group_concat(b) from bt;          -- → "97,98,97,99,97,98"
select group_concat(distinct b) from bt; -- → "97,98,97,99"
```

Each BLOB is converted to text as its bytes' decimal values joined by commas,
and then `group_concat` joins the values with a comma too. So a two-byte BLOB
contributes two comma-separated numbers and the caller cannot tell a
between-values separator from a between-bytes separator. The three source rows
above are indistinguishable from six single-byte rows.

## Expected

SQLite converts a BLOB to text by reinterpreting its bytes as text, so the same
query yields `ab,ac,ab` (and `ab,ac` for the DISTINCT form). Quereus should
match, or — if reinterpreting arbitrary bytes as text is deliberately rejected
here — raise an error rather than emit an ambiguous string.

Note this is not specific to `DISTINCT`: plain `group_concat(b)` shows it too,
so it is a value-to-text conversion issue in the aggregate, not a set-tracking
issue.

## Why it is filed separately

Found while reviewing the BLOB-in-lookup-set crash fix
(`bug-in-subquery-blob-values-crash`), which was about a `TypeError` on
inserting a BLOB into an in-memory set. That crash is fixed; this is an
independent, pre-existing formatting/conversion question that was explicitly
kept out of scope by both the fix and implement stages, and it deserves a
decision on the intended text conversion for BLOBs rather than a fold-in.

## Scope to consider

Whichever way this resolves, the same "BLOB as text" question applies to any
other place a BLOB is coerced to text (`cast(b as text)`, string concatenation,
`printf`-style formatting). Decide the rule once and check those call sites
agree, rather than patching `group_concat` alone.

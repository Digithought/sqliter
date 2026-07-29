---
description: The code that converts a value when a column's type changes is copy-pasted in three separate places, so a fix or a change in one is easy to miss in the other two.
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts        # alterColumn set-data-type branch (~2145)
  - packages/quereus-store/src/common/store-module.ts        # alterColumnSetDataType (~2401)
  - packages/quereus-isolation/src/isolation-module.ts       # deriveSetDataTypeConvert (~1790)
difficulty: easy
---

# One retype converter, three copies

## What is duplicated

`alter column … set data type` has to decide two things and does them identically in three
packages:

1. **Does this retype rewrite values at all?** All three compare the new type's physical type
   against the old column's physical type; equal means metadata-only, rewrite nothing.
2. **How is one value converted?** All three call `validateAndParse(value, newLogicalType,
   columnName)` and, on failure, throw a `QuereusError` with the *same* message string,
   `` `Cannot convert value in '<column>' to <type>` ``, and the same `StatusCode.MISMATCH`.

The three copies are byte-for-byte equivalent apart from how they reach `change.columnName`.

## Why this is worth fixing

The isolation copy was added by `bug-isolation-retype-leaves-staged-rows-unconverted`
specifically so the isolation layer's staged rows convert exactly the way the underlying
converts its committed ones. Its own doc comment argues the copies "cannot drift" *because*
they are literal mirrors — but nothing enforces that. A change to the message wording, the
physical-type gate, or the treatment of NULLs in any one site silently splits the behavior,
and the split only shows up as a mismatched error string or, worse, as some rows converted
and others not.

There is also a user-visible consequence to getting the message wrong: the isolation layer
maps this error to `MISMATCH` to decide whether another connection's pending rows should be
marked unusable rather than aborting the ALTER. That routing is keyed on the status code, so
a copy that drifts to a different code changes cross-connection behavior.

## What is wanted

A single exported helper in `@quereus/quereus` that both answers "does this retype rewrite
values?" and returns the per-value converter, used by all three call sites. Both other
packages already depend on `@quereus/quereus`, so there is no new dependency edge.

The helper should keep the current semantics exactly: NULLs are not converted, a metadata-only
retype yields no converter, and failure is `StatusCode.MISMATCH` with the existing message —
the isolation conformance tests assert on that string.

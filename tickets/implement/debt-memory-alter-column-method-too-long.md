----
description: One method in the in-memory table code has grown to roughly 340 lines handling six unrelated kinds of column change, which makes each new change type harder to add without breaking a neighbouring one.
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts   # alterColumn (~2024-2361); the file is ~3360 lines
difficulty: medium
----

# Decompose `MemoryTableManager.alterColumn`

## What is wrong

`alterColumn` in `packages/quereus/src/vtab/memory/layer/manager.ts` spans roughly lines
2024–2361. In that one body it:

*   resolves the target column and decides which of six attribute changes was asked for
    (`SET COLLATE`, `SET NOT NULL`, `DROP NOT NULL`, `SET DATA TYPE`, `SET/DROP DEFAULT`);
*   runs each change's own pre-validation (a NULL scan, a convertibility scan, a uniqueness probe,
    a primary-key carve-out);
*   builds the post-change schema;
*   rewrites the committed base rows and rebuilds the physical structures;
*   propagates the change into every open transaction layer;
*   emits the schema-change event and owns a rollback `catch` covering all of the above.

The result is two long `if (collationChanged) … else if (valueConvert) …` ladders sited hundreds
of lines apart, whose ordering relative to each other is load-bearing and explained only by
comment blocks. The project convention (`AGENTS.md`) is small single-purpose methods with
decomposed sub-functions rather than a long body split by comment banners.

This is a maintainability concern, not a defect — the behavior is correct and well covered by
tests. It is filed because each newly-supported change type has had to thread another arm through
both ladders, and the next one will be harder still.

## What good would look like

One small handler per attribute change, each returning what the shared tail needs (the new column
schema, an optional per-value rewrite, whether the structures must be re-keyed), with the schema
build / physical rebuild / open-layer propagation / event emit as named steps the outer method
calls in order. The rollback `catch` and the "validate before any mutation" ordering guarantee must
survive the split intact — they are the properties the current comments spend the most words
defending, and a refactor that loses them is worse than no refactor.

Worth checking at the same time whether `manager.ts` (~3360 lines) should be split along the same
seam, e.g. a dedicated module for the ALTER paths.

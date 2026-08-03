---
description: Two files in the persistent-storage package have grown past the size limit the project's own storage documentation sets for them, which the documentation says is the point to split them.
files:
  - packages/quereus-store/src/common/store-table-scan.ts   # 1023 lines
  - packages/quereus-store/src/common/store-table-base.ts   # 1033 lines
  - docs/store.md                                           # the NOTE that sets the ~1000-line threshold and names both seams
---

# Split `store-table-scan.ts` and `store-table-base.ts`

`docs/store.md` records a threshold for the four-file `StoreTable` inheritance chain
(`store-table-base.ts` → `store-table-scan.ts` → `store-table-constraints.ts` →
`store-table.ts`):

> NOTE: the two largest `StoreTable` layers sit near 900 lines each. If either passes
> ~1,000, split it the same way — the scan layer's natural next seam is the multi-seek
> group (`decodeMultiSeekTuples` / `orderTupleValues` / `scanMultiSeek` /
> `scanMultiSeekPrimary`), and the base's is the statistics block.

Both have now passed it. Measured with `wc -l` from `packages/quereus-store`:

```
1023 src/common/store-table-scan.ts
1033 src/common/store-table-base.ts
 711 src/common/store-table-constraints.ts
 722 src/common/store-table.ts
```

The doc already names the seam for each file, so this is a mechanical split along lines
the design has already chosen, not a design question:

- **scan layer** → lift the multi-seek group (`decodeMultiSeekTuples`,
  `orderTupleValues`, `scanMultiSeek`, `scanMultiSeekPrimary`, and the
  `MultiSeekTuple` / `MultiSeekWindow` / `MultiSeekWindowContext` types) out.
- **base layer** → lift the statistics block out.

Update the `docs/store.md` NOTE with the new numbers and seams once done, and follow the
same pure-move discipline the original four-way split used: no method bodies
restructured in the same pass.

## Why it matters

Every change to the store's read path lands in `store-table-scan.ts`, and the file's own
doc comments are dense enough that finding the arm you need already takes a scroll. The
threshold exists because that cost compounds; the split is cheapest done before the next
feature adds to it.

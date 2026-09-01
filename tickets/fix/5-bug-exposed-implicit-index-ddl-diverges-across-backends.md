description: The same table, created the same way, reports a different index definition depending on which storage backend is in use — one says the index is unique, the other says it is not.
files:
  - packages/quereus/src/schema/catalog.ts                  # syntheticExposedIndexToIndexSchema (~line 874) sets unique: true; SyntheticExposedIndex NOTE (~line 859) says it deliberately does not
  - packages/quereus/src/func/builtins/schema.ts            # schema() index loop (~line 150-175) and index_info() (~line 425-450) — the two read surfaces that disagree
  - packages/quereus/src/vtab/memory/layer/manager.ts       # ensureUniqueConstraintIndexes (~line 262) materializes the index WITHOUT a unique flag — the memory side of the divergence
  - packages/quereus/test/covering-structure.spec.ts        # existing coverage of exposed implicit indexes; asserts they are surfaced, never asserts their DDL text
difficulty: medium
repro: verified

# Exposed implicit covering index renders as UNIQUE in one backend and not the other

## What a user sees

Declare a table with a UNIQUE constraint that opts its backing index into catalog
visibility:

```sql
create table t (
  id integer primary key,
  x integer not null,
  constraint uq unique (x) with tags ("quereus.expose_implicit_index" = true)
);
```

Then read the index back. The answer depends on the storage backend, and inside the
store backend the two introspection surfaces contradict each other:

| surface | memory backend | store backend |
|---|---|---|
| `select sql from schema() where type='index'` | `CREATE INDEX "uq" ON "main"."t" ("x" COLLATE BINARY)` | `CREATE UNIQUE INDEX "uq" ON "main"."t" ("x" COLLATE BINARY)` |
| `collectSchemaCatalog(...).indexes[].definition` | `index (x)` | `unique index (x)` |
| `select "unique" from index_info('t')` | `0` | `0` |

So: the two backends disagree on the DDL text for the same logical schema, and the
store backend's own DDL disagrees with its own `index_info()`.

Verified by running both backends directly (memory `Database`, and a `Database` with
`default_vtab_module = 'store'` over the LevelDB provider, mirroring the store-mode
setup in `packages/quereus/test/logic.spec.ts`).

## Where it comes from

There are two code paths that surface this one index, one per backend, and only one
of them was changed:

- **Memory backend** materializes the backing index into `tableSchema.indexes` and
  does *not* set a `unique` flag on it (uniqueness is enforced through the UNIQUE
  constraint, not through the index). The generic "render every real index" loop
  therefore emits a plain `CREATE INDEX`.
- **Store backend** does not materialize it, so the index is reconstructed on the fly
  from a synthetic descriptor. That reconstruction was recently changed to stamp
  `unique: true` onto the descriptor before rendering, on the reasoning that these
  structures back UNIQUE constraints and so are "unique by construction".

Both statements are individually defensible; together they produce the table above.
The store change also left the flag out of `index_info()`, which is where the
within-backend contradiction comes from.

## What needs deciding, and what needs to hold afterwards

The decision is one question: **does an exposed implicit covering index describe
itself as UNIQUE?** Both answers are legitimate:

- *Yes* — the structure really does enforce a uniqueness rule, and DDL that omits
  `UNIQUE` does not re-parse into something equivalent. Cost: `index_info().unique`
  must flip to `1`, and the memory backend's emitted DDL changes, so any assertion
  pinning that text needs updating.
- *No* — uniqueness belongs to the constraint, and the index is only its backing
  structure; the surrounding code already documents this choice in a comment on the
  `SyntheticExposedIndex` type. Cost: revert the recently-added `unique: true` stamp.

Recommendation: **yes**. The DDL's job is to re-parse into the object it describes,
and a plain `CREATE INDEX` does not. But either answer is acceptable — what is not
acceptable is the current state, where the answer depends on the backend.

Whichever way it goes, the invariant afterwards must be that **the answer is produced
in one place**, not independently by the materialized-index path and the synthetic
path. Today the two paths each decide for themselves, which is exactly how they
drifted apart. A shared "how do I render this index" helper that both loops (in the
`schema()` TVF and in the catalog collector) call is the shape that keeps them from
drifting again.

## Coverage this needs

None of the existing tests would have caught this — they assert that the exposed
implicit index *is surfaced*, never what its DDL text says. The fix needs a test that
pins the rendered DDL and the `index_info().unique` flag for this exact shape, and
that runs under both backends (the store leg is what `yarn test:store` exercises), so
the two can never disagree silently again.

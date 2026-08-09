description: A foreign key's stored list of parent column positions is always empty and nothing reads it, but its name suggests it holds real data — which already caused one crash when code trusted it. Remove it so the trap can't be sprung again.
files:
  - packages/quereus/src/schema/table.ts                 # ForeignKeyConstraintSchema.referencedColumns (line ~989), resolveReferencedColumns (~1016)
  - packages/quereus/src/schema/constraint-builder.ts    # line ~106 writes Object.freeze([])
  - packages/quereus/src/schema/manager.ts               # line ~1815 writes Object.freeze([])
  - packages/quereus/src/planner/util/ind-utils.ts       # doc comments reference the field (lines 64, 68, 94)
  - packages/quereus/src/planner/util/key-utils.ts       # doc comment line 578
  - packages/quereus/test/util/schema-equivalence.ts     # line 160 compares the field
  - packages/quereus/test/optimizer/inclusion-dependencies.spec.ts  # line 172 constructs it
difficulty: easy
severity: wrong-result
likelihood: unusual
tradeoffs: The field is inert today, so removing it is churn across schema builders and test fixtures with no user-visible change; a maintainer may prefer to leave it and rely on the doc comments already added at the two remaining mention sites.

# Foreign key schema stores parent column positions that are never filled in

`ForeignKeyConstraintSchema` (packages/quereus/src/schema/table.ts) has a field
`referencedColumns: ReadonlyArray<number>` — "column indices in the parent table". Both
places that build a foreign key schema (`constraint-builder.ts`, `manager.ts`) set it to a
frozen empty array, with a comment saying it is "resolved at enforcement time". Nothing
ever writes anything else into it, and after the fix in
`bug-foreign-key-info-throws-on-implicit-parent-columns` no production code reads it at
all. The real resolution lives in `resolveReferencedColumns(fk, parentSchema)`, which
works from `referencedColumnNames` or the parent's primary key.

So the field is write-only dead state whose name and type advertise the opposite. That is
not hypothetical harm: the bug just fixed was caused by `foreign_key_info()` indexing into
`fk.referencedColumns[seq]`, trusting the name, and getting `undefined` for every foreign
key in the database.

## Expected outcome

A reader of the schema type cannot mistakenly believe parent column positions are
available on the constraint object. The one supported way to get them is to call the
resolver with the parent table in hand — which forces the caller to have resolved the
parent first, the exact step the old code skipped.

The straightforward shape is to delete the field and update the two builders, the
test-fixture construction, and the schema-equivalence comparison. If some
not-yet-identified consumer (schema persistence, sync payloads) turns out to need a slot
there, the alternative is to keep the field but make its emptiness explicit in the type
(e.g. drop it from the interface and expose only the resolver), rather than leaving a
number array that is a lie.

Note the doc comments in `planner/util/ind-utils.ts` and `planner/util/key-utils.ts` that
describe invariants in terms of `fk.referencedColumns[i]`; they should be restated in
terms of resolved indices.

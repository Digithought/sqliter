description: When a CAST cannot convert a value it quietly keeps the original instead, so writing that result into a column of the cast's type stores a value the column's own type rules would have rejected — for example the word "junk" sitting in a date column.
files:
  - packages/quereus/src/runtime/emit/cast.ts                # emitCast + castFallback
  - packages/quereus/src/planner/nodes/scalar.ts             # CastNode.generateType (~line 691)
  - packages/quereus/src/types/temporal-types.ts             # DATE/TIME/DATETIME/TIMESPAN parse
  - packages/quereus/src/types/validation.ts                 # buildRowCoercion — the static-type skip rule
difficulty: medium
---

# A failed CAST yields a value that does not inhabit the target type

## What happens

`CAST(x as <type>)` reports `<type>` as its static type. At runtime `emitCast`
calls that type's `parse`; if `parse` throws, `castFallback` supplies a lenient
substitute — `0` for INTEGER/REAL/NUMERIC, `''`-style stringification for TEXT,
a UTF-8 encoding for BLOB — and for **every other type** returns the operand
completely unchanged.

That unchanged operand is not a value of the target type, but it is still
labelled as one. Since `json-coerce-once-at-dml-source` a write trusts the
static type: a cell whose producing expression already reports the column's type
is written through without conversion *or validation*. So the mislabelled value
lands in the table (verified against `c4749ca0`):

```sql
create table d (id integer primary key, dt date);

insert into d values (1, cast('junk' as date));   -- succeeds
select dt, dt > '2000-01-01' from d;              -- 'junk', and the comparison says true

insert into d values (2, 'junk');                 -- correctly rejected:
-- Error: Type conversion failed for column 'dt': Cannot convert 'junk' to DATE
```

Two identical intents, opposite outcomes. Before that ticket the storage layer
re-converted every cell and rejected the cast form too; now nothing does.

Same shape for `cast(<not JSON source> as json)` — though there the stored
result (a bare JS string) happens to be a legal JSON string scalar, so it is
benign. The temporal types are where a genuinely uninhabitable value gets in,
and it then flows into index keys, ordering, and date functions.

## Expected behavior

Decide, and apply consistently, what a CAST that cannot convert produces. The
two coherent answers:

- **NULL** — the value does not inhabit the target type, so the cast has no
  result. This is what most typed SQL engines do and it keeps `castFallback`'s
  "lenient, never throws" property.
- **Throw** — but that contradicts the deliberate leniency the existing numeric
  and text fallbacks encode, so it would have to be argued for.

Whichever is chosen, `CAST(x as T)` must only ever produce a value that is
valid for `T`, so that the static type is truthful for the write path and for
every other consumer.

## Notes for whoever picks this up

- `CastNode.generateType` resolves the target with `typeRegistry.getTypeOrDefault`
  while `emitCast` resolves it with `inferType`. These disagree for
  parameterized spellings: `getTypeOrDefault('VARCHAR(10)')` finds no entry and
  falls back to BLOB, while `inferType('VARCHAR(10)')` applies the affinity rule
  and returns TEXT. Worth reconciling in the same pass — today the mismatch is
  harmless only because it errs toward "types differ ⇒ convert".
- The existing numeric/text/blob fallbacks are load-bearing for SQLite
  compatibility; only the `default:` arm is in question.
- Related, same root shape (a node advertising a logical type it does not
  produce), separate ticket: `union-branch-value-not-converted-on-write`.

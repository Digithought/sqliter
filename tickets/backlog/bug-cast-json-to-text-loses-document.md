description: Converting a JSON value to text with CAST produces the useless placeholder "[object Object]" instead of the document's text, so the data is silently destroyed.
files:
  - packages/quereus/src/runtime/emit/cast.ts        # castFallback — the TEXT and BLOB arms
  - packages/quereus/src/types/builtin-types.ts      # TEXT_TYPE.parse / BLOB_TYPE.parse
  - packages/quereus/src/types/json-type.ts          # canonicalJsonString lives nearby
difficulty: medium
---

# `cast(<json> as text)` yields "[object Object]"

## What happens

JSON values are held as native JavaScript objects. `TEXT`'s conversion routine
handles strings, numbers, booleans and binary data, and throws on anything else —
including an object. The CAST fallback then stringifies the operand with the
JavaScript default, which for an object is the literal placeholder
`[object Object]`.

```sql
create table j (id integer primary key, v json);
insert into j values (1, '{"a":1}');

select cast(v as text) from j;   -- '[object Object]'
select cast(v as blob) from j;   -- the UTF-8 bytes of '[object Object]'
```

Every document collapses onto the same string, so the conversion is not merely
unhelpful — it is unrecoverable, and it is silent.

## Expected behavior

Converting a JSON value to text should produce that value's JSON text. The
engine already has a canonical text form for JSON (used for grouping keys and
for fingerprinting object literals), so the shape of the answer exists; the
question this ticket has to settle is *which* text form is right for a
user-visible conversion — the canonical key-sorted form, or a form that
preserves the document as written.

Converting to binary should follow whatever text answer is chosen.

## Notes

Found during review of `failed-cast-stores-unconverted-value`, which established
the rule that a CAST must only ever produce a value that inhabits the type it
advertises. `[object Object]` technically satisfies that rule — it is a string —
so that ticket's fix does not and cannot address this; the defect here is loss of
the value, not a type mismatch. It predates that work.

The same gap applies to any future logical type whose values are objects, not
only JSON.

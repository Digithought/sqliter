description: The engine has several different, inconsistent ways of turning a value into text, so depending on which one a query happens to hit, binary data comes out as decimal numbers or as hex digits, and a JSON document is destroyed entirely.
files:
  - packages/quereus/src/types/cast-semantics.ts     # castFallback — TEXT arm (~line 38) and BLOB arm (~line 40)
  - packages/quereus/src/func/builtins/aggregate.ts  # group_concat step (~line 270) — acc.values.push(String(value))
  - packages/quereus/src/runtime/emit/binary.ts      # emitConcatOp (~lines 330-331) — String(v1) / String(v2)
  - packages/quereus/src/util/affinity.ts            # applyTextAffinity — tail returns String(value) (~line 142)
  - packages/quereus/src/types/builtin-types.ts      # TEXT_TYPE.parse (~line 138) — the hex-encoding answer; BLOB_TYPE.parse
  - packages/quereus/src/types/json-type.ts          # canonicalJsonString lives nearby
difficulty: medium
---

# There is no single value-to-text conversion, and three of them disagree

## Root cause

Raw JavaScript `String(value)` is used as *the* SQL value-to-text conversion at four separate
sites:

| site | code |
|---|---|
| `types/cast-semantics.ts` `castFallback`, TEXT arm (~38) | `return String(value)` |
| `types/cast-semantics.ts` `castFallback`, BLOB arm (~40) | `new TextEncoder().encode(String(value))` |
| `func/builtins/aggregate.ts` `group_concat` step (~270) | `acc.values.push(String(value))` |
| `runtime/emit/binary.ts` `emitConcatOp` (~330-331) | `const s1 = String(v1); const s2 = String(v2);` |
| `util/affinity.ts` `applyTextAffinity` tail (~142) | `return String(value)` |

Meanwhile `TEXT_TYPE.parse` (`types/builtin-types.ts`) does something else entirely for
binary data: it **hex-encodes** it. The result is that the engine has **three different
answers** for "what is this BLOB as text", and JSON documents — which are held as native
JavaScript objects — collapse to the placeholder `[object Object]` wherever `String()` is
reached.

Both symptoms below are that one cause. The work is to **define one canonical
value-to-text conversion and point every site at it**, not to patch any single site.

## Verified outputs

```sql
create table j (id integer primary key, v json);
insert into j values (1, '{"a":1}');

create table bt (id integer primary key, b blob);
insert into bt values (1, x'6162'), (2, x'6163'), (3, x'6162');
```

| expression | today's result | note |
|---|---|---|
| `cast(json_col as text)` | `[object Object]` | document destroyed |
| `cast(json('[1,2,3]') as text)` | `1,2,3` | JSON syntax lost (array joined by JS `Array.prototype.toString`) |
| `cast(<json> as blob)` | UTF-8 bytes of `[object Object]` | follows the TEXT arm |
| `group_concat(blob_col)` | `97,98,97,99` | decimal bytes |
| `cast(<blob> as text)` | `6162` | hex — a third answer |
| `<blob> \|\| ''` | `97,98` | decimal bytes again |

## Arm A — JSON is destroyed by conversion to text

JSON values are held as native JavaScript objects. `TEXT_TYPE.parse` handles strings,
numbers, booleans and binary data, and throws on anything else — including an object. The
CAST fallback then stringifies the operand with the JavaScript default: `[object Object]` for
an object, and the comma-joined elements for an array. Every document collapses onto the same
string (or onto an ambiguous one), so the conversion is not merely unhelpful — it is
**unrecoverable, and it is silent**.

**Expected:** converting a JSON value to text produces that value's JSON text. The engine
already has a canonical text form for JSON (used for grouping keys and for fingerprinting
object literals), so the shape of the answer exists. The question to settle is *which* text
form is right for a user-visible conversion — the canonical key-sorted form, or a form that
preserves the document as written. Converting to binary follows whatever text answer is
chosen.

The same gap applies to any future logical type whose values are objects, not only JSON.

**Provenance:** found during review of `failed-cast-stores-unconverted-value`, which
established that a CAST must only ever produce a value that inhabits the type it advertises.
`[object Object]` technically satisfies that rule — it is a string — so that ticket's fix does
not and cannot address this; the defect here is loss of the value, not a type mismatch. It
predates that work.

## Arm B — BLOB values render as decimal byte numbers

```sql
select group_concat(b) from bt;          -- → "97,98,97,99,97,98"
select group_concat(distinct b) from bt; -- → "97,98,97,99"
```

Each BLOB is converted to text as its bytes' decimal values joined by commas, and then
`group_concat` joins the values with a comma too. So a two-byte BLOB contributes two
comma-separated numbers and the caller cannot tell a between-values separator from a
between-bytes separator: the three source rows above are indistinguishable from six
single-byte rows. This is not specific to `DISTINCT` — plain `group_concat(b)` shows it — so
it is a value-to-text issue, not a set-tracking issue.

**Expected:** SQLite converts a BLOB to text by reinterpreting its bytes as text, so the same
query yields `ab,ac,ab` (and `ab,ac` for the DISTINCT form). Quereus should match, or — if
reinterpreting arbitrary bytes as text is deliberately rejected here — raise an error rather
than emit an ambiguous string. Note that `cast(<blob> as text)` already gives a *third*
answer (hex, from `TEXT_TYPE.parse`), so whichever rule is chosen, at least two of the three
current behaviors change.

**Provenance:** found while reviewing the BLOB-in-lookup-set crash fix
(`bug-in-subquery-blob-values-crash`), which was about a `TypeError` on inserting a BLOB into
an in-memory set. That crash is fixed; this is independent and pre-existing, and was
explicitly kept out of scope by both the fix and implement stages.

## What the fix has to produce

One canonical value-to-text conversion — a single function with a documented rule per source
type (string, number, bigint, boolean, binary, JSON/object, null) — with **every** site in the
table above calling it, and `TEXT_TYPE.parse` either delegating to it or having its divergence
justified in writing. Patching `group_concat` alone, or the CAST arm alone, leaves the engine
still disagreeing with itself.

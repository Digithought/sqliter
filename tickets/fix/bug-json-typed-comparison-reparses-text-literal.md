---
description: Comparing a JSON-flavored expression against a plain text value can silently re-parse the text as JSON, so an equality that is obviously true as text comes back false.
files:
  - packages/quereus/src/func/builtins/json.ts       # json_quote declares no return type
  - packages/quereus/src/types/json-type.ts          # JSON compare semantics
  - packages/quereus/test/logic/06.9.1-json-coerce-once.sqllogic  # where the quirk was noticed (test avoids it)
---

# Text comparison against a JSON-typed operand re-parses the text side

Observed while writing tests for `json-coerce-once-at-dml-source`; reproduces
at HEAD before that change, on a plain SELECT with no table involved:

```sql
select json_quote(j) = '"9"' as r, json_quote(j) as q
from (select json('"9"') as j);
-- r: false, q: "9"   ← q prints exactly the text the literal spells
```

`json_quote` returns TEXT by intent (a serialized JSON string, quotes and all),
but it declares no return type, and the comparison ends up treating one side
under JSON semantics: the right-hand TEXT literal `'"9"'` appears to be parsed
as JSON (yielding the bare string `9`) while the left side (the five-character
text `"9"`, already serialized) is not, so the two compare unequal even though
they are the identical string.

Expected: comparing two TEXT values compares them as text. `json_quote(x) =
'<the same serialized text>'` should be true.

Likely fixes to evaluate (whoever plans this should pick one):
- declare `returnType: TEXT` on `json_quote` (and audit other serializing
  functions that return JSON text, e.g. anything returning canonical JSON
  strings), so the comparison never gets a JSON-flavored operand; and/or
- revisit the comparison's implicit "parse the other side as JSON" coercion —
  parsing one operand but not the other is what makes the result surprising.

Not user-reported; low urgency. The new coerce-once tests deliberately avoid
the construct (they use `j <> 9`, which relies only on JSON type rank).

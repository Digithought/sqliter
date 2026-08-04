---
description: When a query summarizes data two ways that differ only in the capitalization of a quoted text value, and then filters or sorts by one of them, the engine silently uses the wrong summary and returns wrong rows, with no error. Fix the comparison so quoted values keep their capitalization.
files:
  - packages/quereus/src/emit/ast-stringify.ts                    # expressionToString; lowerExprIdentifiers (line ~462) — the helper to reuse
  - packages/quereus/src/planner/building/function-call.ts        # findMatchingAggregate (line ~49) — the site with the visible wrong answer
  - packages/quereus/src/planner/building/select-aggregates.ts    # dedupeNewAggregates (line ~808)
  - packages/quereus/src/planner/building/select-projections.ts   # collectInnerAggregates (line ~106)
  - packages/quereus/test/logic/07.3-group-by-extras.sqllogic     # HAVING/ORDER BY aggregate-matching coverage lives at the tail of this file
difficulty: easy
repro: verified
---

# Aggregate identity must fold identifier case only, not literal case

## The defect

Three planner sites answer the same question — "is this aggregate the same one
the SELECT list already computed?" — by rendering both back to SQL text with
`expressionToString` and comparing the two strings **after `.toLowerCase()` on
the whole string**. The lowercase is meant to make *identifiers*
case-insensitive (`sum(B)` must match `sum(b)` — correct SQL). It also
lowercases the contents of quoted string values, so two genuinely different
aggregates collapse into one and the clause reads the other one's number.

Reproduced against HEAD (scratch script, `db.eval`):

```sql
create table t (id integer primary key, g integer, b text);
insert into t values (1,1,'A'),(2,1,'A'),(3,1,'a');
```

| query | today | expected |
|---|---|---|
| `select g, count(nullif(b,'A')) c, count(nullif(b,'a')) d from t group by g` | `[{g:1,c:1,d:2}]` | same (already correct) |
| `select g, count(nullif(b,'A')) c from t group by g having count(nullif(b,'a')) > 1` | `[]` | `[{g:1,c:1}]` |
| `select g, count(nullif(b,'A')) c, count(nullif(b,'a')) d from t group by g having count(nullif(b,'a')) > 1` | `[]` | `[{g:1,c:1,d:2}]` |

The third row is the clearest statement of the bug: the correct aggregate (`d`,
value 2) is sitting right there in the SELECT list, and HAVING still binds to
`c` (value 1) because `c`'s fingerprint lowercases to the same string and it
comes first in the list.

Any literal containing a letter is exposed — `count(nullif(b,'A'))`,
`sum(case when b='X' then 1 else 0 end)`, `group_concat(b,'X')`.

## Root cause and the fix

`expressionToString` renders identifiers with their authored case and string
literals verbatim, so the callers apply a blanket `.toLowerCase()`. The right
tool already exists in the same file: `lowerExprIdentifiers` (ast-stringify.ts
~line 462) returns a structural clone with `column` / `identifier` node
`name` / `table` / `schema` folded and everything else — literals included —
byte-exact. It was written for canonical CHECK / partial-index bodies and is
currently module-private.

So the fix is one shared identity renderer beside it, exported, and the three
sites call it instead of open-coding `.toLowerCase()`:

```ts
export function expressionToIdentityString(expr: AST.Expression): string {
	return expressionToString(lowerExprIdentifiers(expr));
}
```

Nothing else needs case handling: function names, operators, `cast` target
types and `collate` collations are already lowercased at render time by
`expressionToString` itself. Do **not** change `expressionToString`'s own
output — its round-trip faithfulness is a contract with a property test behind
it (`test/emit-roundtrip-property.spec.ts`); the identity form must be a
separate rendering.

### The two dedupe sites need more than a call swap

Both dedupe sites currently compare the new key against
`entry.alias.toLowerCase()`. That works today only by accident — the alias *is*
the un-lowercased rendering, so lowercasing it reproduces the old key. Once the
key stops folding literals, `alias.toLowerCase()` still folds them, and the
comparison would keep wrongly deduping exactly the case this ticket fixes.
Compare identity keys on both sides:

- `dedupeNewAggregates` (select-aggregates.ts): replace
  `newAggregates.some(a => a.alias.toLowerCase() === key)` with a
  `Set<string>` of identity keys accumulated in the loop.
- `collectInnerAggregates` (select-projections.ts): replace
  `aggregates.some(a => a.alias.toLowerCase() === key)` with a comparison
  against each entry's own identity string. Entries are pushed here as
  `AggregateFunctionCallNode`s, but the array is shared with other collectors —
  guard with `CapabilityDetectors.isAggregateFunction` before reading
  `.expression` rather than casting blind.

Aliases themselves stay as they are (`expressionToString`, original case) —
they are display/column names, not identity.

### Validated

The above was prototyped end-to-end and then reverted; the tree is at HEAD. With
the prototype applied, the three repro rows returned the expected values and the
full `yarn test` in `packages/quereus` was **8686 passing / 0 failing / 13
pending**. Treat that as evidence the shape is right, not as a reason to skip
re-running.

## One intentional behavior change to assert

A window specification that names a literal-case-distinct aggregate not present
in the SELECT list currently reads the wrong aggregate silently; after the fix
it hits the existing loud guard in `rejectUncollectedAggregates`
(select-window.ts):

```sql
select g, count(nullif(b,'A')) as c,
       row_number() over (order by count(nullif(b,'a'))) as w
from t group by g;
-- before: silently ordered by c's value
-- after:  Aggregate function count in a window function's ORDER BY is only
--         supported when the same aggregate also appears in the SELECT list
```

That is the documented degradation for a missed match and is the correct
outcome — a clear error beats a wrong number. Assert it so it does not drift
back.

## Stale comment to correct while you are in there

`findMatchingAggregate`'s doc comment claims `buildGroupByCoverage` uses "the
same canonical-AST fingerprint (`expressionToString`, case-insensitive)". It
does not — the GROUP BY coverage fingerprints (`select-aggregates.ts` lines
~261, ~337, ~877, ~919) are fully case-**sensitive** `expressionToString`
calls, with no fold at all. Fix the claim to name only the two sites that
genuinely share the convention (`dedupeNewAggregates`, `collectInnerAggregates`).
Do not change the GROUP BY coverage fingerprints in this ticket — a case
divergence there is a missed match that surfaces as a plan-time error, not a
wrong answer, and it belongs with the qualifier-narrowing work already noted at
`findMatchingAggregate`.

## Not in scope

- Qualifier narrowing (`sum(w.b)` does not match `sum(b)`) — already a
  documented `NOTE:` at `findMatchingAggregate`; lifting it needs attribute-id
  binding unavailable at that point in the build.
- Making GROUP BY coverage fingerprints case-insensitive (see above).
- `lowerExprIdentifiers` does not descend into subquery bodies. An aggregate
  argument containing a subquery whose inner identifier case diverges therefore
  fails to match — a missed match (extra aggregate computed, or the loud window
  error), never a wrong answer. Leave it; add a `NOTE:` at the new helper so the
  next reader does not re-derive it.

## TODO

- Export a `expressionToIdentityString(expr)` from
  `packages/quereus/src/emit/ast-stringify.ts`, implemented as
  `expressionToString(lowerExprIdentifiers(expr))`. Document on it: folds
  identifier case only, leaves literals byte-exact, is NOT round-trip SQL, and
  the subquery-passthrough limitation. Re-export alongside `expressionToString`
  in `src/emit/index.ts` only if a consumer outside `src/` needs it — the three
  callers are all internal, so plain export is enough.
- Switch `findMatchingAggregate` (function-call.ts) to the new helper on both
  sides of the comparison.
- Switch `dedupeNewAggregates` (select-aggregates.ts) to the new helper, and
  replace the `alias.toLowerCase()` self-dedupe with an identity-key `Set`.
- Switch `collectInnerAggregates` (select-projections.ts) to the new helper on
  both sides, guarding entries with `CapabilityDetectors.isAggregateFunction`
  instead of an unchecked cast.
- Correct the stale `buildGroupByCoverage` claim in `findMatchingAggregate`'s
  doc comment; extend it to say identifier case folds but literal case does not.
- Extend the aggregate-matching block at the tail of
  `test/logic/07.3-group-by-extras.sqllogic` (it already has a `create table wg`
  fixture and control cases — follow its comment style): a literal-case
  divergence in HAVING binds to its own aggregate; the same in a top-level
  ORDER BY (use two groups so a wrong bind changes row order, not just values);
  the both-in-SELECT-list variant from the repro table above; and controls that
  identifier-case and whitespace/paren matching still work (some already exist —
  do not duplicate them).
- Add the window-specification assertion for the intentional
  `rejectUncollectedAggregates` error, in `test/logic/07.5-window.sqllogic`
  alongside the other grouped+window cases.
- Run `yarn test` and `yarn lint` from `packages/quereus` (stream with
  `2>&1 | tee /tmp/x.log`, then `tail` it — see AGENTS.md on Windows pipe
  behavior). Baseline before this ticket: 8686 passing, 0 failing, 13 pending.

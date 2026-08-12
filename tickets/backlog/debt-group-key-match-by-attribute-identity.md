description: When a query groups by a calculated expression, repeating that same expression elsewhere in the query only works if it is written with exactly the same table prefix; a different prefix makes the query fail with a confusing "must appear in the GROUP BY clause" error. Recognise grouping keys by what they resolve to instead of by how they are typed.
files:
  - packages/quereus/src/planner/building/select-aggregates.ts   # indexGroupKeys / buildGroupByCoverage build the text fingerprints; redirectNode rule 1 and findUngroupedColumnRef consume them
  - packages/quereus/src/emit/ast-stringify.ts                    # expressionToIdentityString — the fingerprint itself
  - packages/quereus/test/logic/07.5-window.sqllogic              # the pins that record today's behaviour, in the grouped ORDER BY section
  - packages/quereus/test/logic/07.3-group-by-extras.sqllogic     # the sibling narrowing for aggregate matching ("a qualifier divergence (`w.b` vs bare `b`) no longer matches")
  - docs/sql-select.md                                            # §3.3 documents the rule users see
difficulty: medium
tradeoffs: The text fingerprint is one small shared function that also matches aggregates and select-list aliases, and it works for every spelling users normally write; replacing it with resolved-attribute comparison touches several matchers at once and risks changing which spelling binds where, all for a spelling (a qualifier on a computed grouping key) that is rare in practice.
----

# Grouping keys are recognised by their text, not by what they resolve to

A grouping key that is not a plain column — `group by upper(a)`, `group by a || '!'` —
is recognised everywhere else in the query by rendering both expressions to a canonical
string and comparing. The renderer keeps the qualifier, so `upper(a)` and `upper(wg.a)`
are two different keys even though they denote the same value on the same table.

Everything after grouping is then checked against that recognition. What is left over
after a failed match is a bare reference to `a`, which is not a grouping column, so the
query is rejected:

```sql
create table wg (a text, b text);

select upper(a) as k, count(*) as c from wg group by upper(a) order by upper(wg.a);
-- Column 'wg.a' must appear in the GROUP BY clause or be used in an aggregate function

select upper(wg.a) as k, count(*) as c from wg group by upper(a);
-- same error
```

Both are legal in PostgreSQL, which compares the resolved expressions rather than their
text. A plain-column key does not have the problem — `group by a` is recognised by the
attribute the reference resolves to, so `a`, `wg.a` and `w.a` all match.

## Why now

The ORDER BY case above used to be *accepted*: the sort key silently read whichever row
of the group the aggregate happened to publish, so it usually produced the answer the
user wanted. The finished-plan coverage check added by
`grouped-post-aggregate-redirect-boundary-check` (see `complete/`) turned that accident
into a plan-time error, which is right in general — but it makes this narrow
text-matching gap user-visible instead of invisible. The select-list form has always
been rejected, so the two halves are at least consistent now.

## The class, not the instance

Three symptoms share one cause — the fingerprint is a rendering of AST text:

- the false **rejection** above (computed key, qualifier divergence);
- a false **redirect** in the other direction, already recorded in a `NOTE:` on
  `redirectToGroupKeys`: a subtree of *enclosing-query* references that happens to
  render identically to a grouping key would be rewritten onto this query's group
  column;
- the sibling narrowing for *aggregate* matching pinned in `07.3-group-by-extras.sqllogic`
  ("a qualifier divergence (`w.b` vs bare `b`) no longer matches, so HAVING computes a
  second, redundant aggregate over the same column").

Matching on resolved identity — the attribute ids and operators the expression actually
built, rather than the characters it was written with — retires all three. The existing
`NOTE:` says as much: "fixing it means comparing resolved attribute identity rather than
text, for both callers at once."

## Expected behaviour

Any spelling that resolves to the same value as a grouping key is that grouping key,
regardless of qualifier — for the select list, `having`, `order by`, and window
specifications alike. Case folding of identifiers and byte-exactness of quoted literals
must survive the change (`group by A || '!'` still covers `a || '!'`; `a || 'X'` and
`a || 'x'` stay different keys). The pins added in `07.5-window.sqllogic` under "A
COMPUTED grouping key is matched by the whole expression's TEXT" flip from `-- error:`
to result rows when this lands.

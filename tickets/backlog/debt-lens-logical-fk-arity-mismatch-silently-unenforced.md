---
description: A foreign key declared on a logical (lens) table whose column count does not line up with the parent it points at is quietly ignored instead of being reported, so the rule the schema promises is never actually applied.
files:
  - packages/quereus/src/schema/lens-fk-discovery.ts   # findLogicalParentFkRefs (~254) — the skip
  - packages/quereus/src/schema/lens-fk-discovery.ts   # resolveLogicalReferencedColumns (~50) — where the parent key arity comes from
  - packages/quereus/src/schema/table.ts               # resolveReferencedColumnsForEnforcement — the physical-side equivalent, for reference
  - docs/lens.md                                       # § constraint attachment / coverage checklist
difficulty: medium
severity: wrong-result
likelihood: unusual
tradeoffs: Reaching this needs both a lens-backed logical schema and a miscounted foreign key in it, so a maintainer may reasonably rank it below defects on the ordinary table path — and moving the complaint to deploy time is a stricter `apply schema` that could reject a schema someone is already living with.
---

# What is wrong

A foreign key can be declared on a *logical* table — a view-like table a lens
projects over real (basis) tables. When such a key names its parent without
listing the parent's columns, the parent's own key supplies them. If the two
counts disagree, the key cannot be checked at all.

On ordinary tables that situation now fails the statement, naming both tables
(`docs/sql-ddl.md` § 7.6, *When a foreign key cannot be enforced*). On the
logical/lens path it still does the old thing: writes a line to a debug log
nobody reads and moves on. The declared key is then simply not enforced —
deleting or updating a logical parent row that logical children still point at
succeeds.

The one site is the parent-side discovery walk,
`findLogicalParentFkRefs` in `schema/lens-fk-discovery.ts` (~254): on a count
mismatch it logs and `continue`s. Everything downstream — the logical RESTRICT
collector and the logical cascade walker — reads its output, so a skipped key
disappears from both.

# What it should do instead

Prefer refusing the schema over failing writes. Unlike an ordinary table, a lens
is deployed by `apply schema`, and at that moment both the logical child and the
logical parent are known — so the mismatch is decidable *before* any data moves.
Rejecting there names the declaration while the author is still looking at it,
and it means no enforcement site has to carry the case at all.

Expected behaviour:

- `apply schema` refuses a logical foreign key whose child column count cannot
  match the parent key it resolves to, with a message that names the constraint,
  the logical child, the logical parent, and both counts — the same shape the
  physical path already produces.
- If some shape genuinely cannot be decided at deploy (a parent key that is only
  knowable later), that shape raises at the enforcement seam rather than being
  skipped — never silently unenforced.
- A correctly-shaped logical foreign key is unaffected, including the defaulted
  `references <parent>` form.

# Why this was not fixed in place

Found while reviewing the physical-side fix (ticket
`fk-missing-parent-error-names-the-table`). That change routed every *physical*
enforcement site through one strict resolver. The lens path resolves parent
columns by **name** through a different function
(`resolveLogicalReferencedColumns`), against the logical parent's lens slot, so
it does not share that resolver and could not be swept along with it. The
remaining question — deploy-time refusal versus enforcement-time raise — is a
design choice about `apply schema` strictness, not a mechanical substitution.

No lens test exercises a miscounted logical foreign key today, so whichever way
this lands, it needs coverage: a lens schema declaring one, and an assertion
that the mismatch is reported rather than absorbed.

---
description: A query that groups rows can now sort or partition a window function by a grouping column's output name, and filter on it in HAVING — the same thing an aggregate's output name already allowed.
files:
  - packages/quereus/src/planner/building/select-aggregates.ts   # createAggregateOutputScope + collectAliasedGroupKeys/groupKeyIndexOf
  - packages/quereus/test/logic/07.5-window.sqllogic             # window-spec coverage
  - packages/quereus/test/logic/07.3-group-by-extras.sqllogic    # HAVING coverage
  - docs/sql-select.md                                           # § 3.3 GROUP BY and § 3.4 HAVING
repro: verified
---

# A grouping key can be named by its select-list alias

## What shipped

`createAggregateOutputScope` now registers each GROUP BY key under the select-list
alias of the column that selects it, alongside the key's own (bare and qualified)
names and each aggregate's alias. That one scope is what a grouped query's `HAVING`
predicate and — for a grouped, windowed query — its window specifications resolve
against, so the single registration fixes both clauses. Before this, only an
*aggregate* was registered under its alias, which was the reported asymmetry.

Matching a select-list column to its key reuses the existing `GroupKeyIndex`: by base
attribute id for a column reference (`select wg.a as k … group by a` and the reverse),
else by identity fingerprint of the whole expression (`select upper(a) as k … group by
upper(a)`). A projection matching no key is skipped.

`redirectToGroupKeys`, `assertGroupedWindowCoverage` and `buildHavingFilter` are
untouched — an alias resolves straight to the key's own output attribute, so the
window-phase redirect never sees it.

### Precedence, decided during implement and upheld here

A select-list alias is the **lowest-precedence** name in that scope: it is skipped
whenever a grouping key's own name or an aggregate's alias already claims it. The
implement ticket had asked for such a collision to be marked ambiguous instead; that
regresses `select a as b, b, count(*) from wg group by a, b`, which works today,
because the grouped select list is itself rebuilt against this scope. Skipping also
matches SQLite and PostgreSQL, where an alias never outranks a real column outside a
top-level `order by`. Ambiguity is still raised for the one collision nothing can
arbitrate: two aliases naming *different* grouping keys.

The decision and its revisit condition live as a `NOTE:` in the
`createAggregateOutputScope` doc comment.

### Behaviour worth knowing

- An alias **shadows** a same-named base-table column: `select a as b, … over (order
  by b) … group by a` numbers the groups by `a`. The rule an aggregate alias already
  had.
- An alias does **not** outrank a grouping key of the same name, qualified spellings
  included.
- The select list is **not** widened — `select a as k, k as k2 … group by a` is still
  `Column not found: k`.

## Review findings

### Fixed in this pass (minor)

- **Regression introduced by the implement diff: a quoted alias containing a dot broke
  a query that planned fine before it.** `select wg.a as "wg.a", count(*) as c from wg
  group by wg.a` died with the internal-sounding `Symbol 'wg.a' already exists in the
  same scope.`, as did its windowed form. The alias-registration loop guarded only
  against *bare* names already claimed, but the scope also registers a qualified key
  under `wg.a`, and `RegisteredScope.registerSymbol` throws on a duplicate key rather
  than skipping. Verified as new by running both queries against the pre-change file
  from `373732b3`, where they return rows.
  Fix: the loop now also skips a key the scope already holds under its qualified
  spelling, restoring the pre-change plan exactly. Regression assertions added to both
  sqllogic files, including the case where the dotted alias names a *different* key
  than the qualified spelling it collides with.

### Filed as arms on theme tickets that already own the site (major)

Neither warranted a new point ticket — an open ticket already claims the root cause in
each case, and per *Architecture first* the invariant that retires the class is the one
those tickets carry.

- **`backlog/bug-scope-symbol-keys-collide-with-dotted-column-names`** — the fix above
  is a *skip*, which is exactly the workaround that ticket argues against ("silently
  binds one of the two rather than the one the user wrote"). A select-list alias is a
  fifth site for the same flat-string-key defect, and the first that needs no
  `new.`/`old.`/`excluded.` prefix — a plain table qualifier is enough. Appended as an
  arm, with the reproduction and a pointer to the assertions that must be revisited
  when the structured key lands. Severity/likelihood unchanged (`wrong-result` /
  `contrived`).
- **`backlog/debt-oversized-source-files`** — `select-aggregates.ts` is 1,400 lines
  (`wc -l`, 2026-08-11; 1,296 before this change). Not previously listed. Appended with
  its four separable concerns named (GROUP BY key indexing and redirection, the
  aggregate output scope, HAVING construction, the final grouped projection).

### Tests added (the implementer's set was a floor)

The handoff named four untested areas. All four were exercised by hand, all four
worked, and the three that are cheap to assert are now asserted:

- grouped query inside a **view** body whose `HAVING` names a grouping-key alias
  (07.3), plus its drop;
- **compound (`union all`) arm** and **subquery source** whose window specification
  names one (07.5);
- **`group by` ordinal** resolving to an aliased column, in both `HAVING` and a window
  specification;
- a second **ambiguity shape** — an alias colliding with a bare group-key name that is
  *already* ambiguous from `group by i.a, c.a` — asserted to stay ambiguous rather than
  resolve to the alias's key;
- the two **dotted-alias** regression cases above.

Grouped queries inside *materialized* views remain unasserted; the scope is built the
same way for them and the plain-view arm now covers the shape.

### Checked, nothing found

- **Silent answer changes from alias shadowing.** The concern was that a name which
  used to fall through to a base-table column now binds to a grouping key, changing
  results without an error. Ran the two discriminating shapes (`having b = 'x'` and
  `over (order by b)` under `select a as b … group by a`) against the pre-change file:
  both **errored** there. The change turns errors into results only; no query's answers
  moved.
- **The precedence deviation itself.** Re-derived independently rather than taken on
  trust — marking the collision ambiguous does regress the bare `b` in the select list.
  The implementer's call stands and its `NOTE:` carries a revisit condition, so it is a
  recorded accepted tradeoff, not an open finding.
- **`groupKeyIndexOf` matches column-reference-first while `redirectNode` matches
  fingerprint-first.** The orders diverge only when the same column is grouped twice
  under two spellings (`group by wg.a, a`), where both indexes denote the same value.
  No observable difference, so no note filed.
- **The backlog bug the implementer filed rather than fixed**
  (`bug-qualified-group-key-in-select-list-breaks-window-query`). Independently
  reproduced against `373732b3`: `select wg.a, row_number() over (order by a) as rn
  from wg group by a` fails there with the identical "No row context found for column
  a". Genuinely pre-existing; the account in that ticket is accurate.
- **Docs.** Read every file the change touches and the sections it should have touched.
  `docs/sql-select.md` § 3.3 and § 3.4 reflect the new reality; extended the
  lowest-precedence bullet to cover a grouping key's *qualified* name, which is what
  the dotted-alias fix turns on. `node scripts/check-docs.mjs` clean.
- **Error handling and resource cleanup.** Nothing is allocated in the new code and the
  only throw path in it was the duplicate-registration one, now closed.

### Tripwires recorded

None new. The two existing `NOTE:` tripwires at these sites (alias precedence in
`createAggregateOutputScope`, per-node fingerprint cost in `redirectNode`) were read
and left standing; neither revisit condition has tripped. The fix's own rationale is a
comment at its site pointing at the ticket that owns the class.

## Validation

- `yarn test` from the repo root: 9396 + 386 + 147 + 80 + 69 + 80 + 1710 + 725 + 85 +
  31 + 34 + 134 + 22 passing, 0 failing.
- `yarn workspace @quereus/quereus run lint` (eslint + test-file `tsc --noEmit`): clean.
- `node scripts/check-docs.mjs`: clean.
- The sqllogic suite alone (363 files) passes with the new assertions in place.

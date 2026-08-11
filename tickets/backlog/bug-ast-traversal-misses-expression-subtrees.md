---
description: A check that is supposed to reject a table definition containing a random or clock-reading function does not look everywhere in the definition, so a definition that hides such a call in one of five less-common places is accepted — and the table then computes values that change every time it is read.
files:
  - packages/quereus/src/parser/visitor.ts        # traverseAst — the traversal with the gaps
  - packages/quereus/src/schema/manager.ts        # its four callers; findNonDeterministicCall (~2404) is the one with a verified user-visible miss
  - packages/quereus/src/schema/expr-scope/walk.ts # the sibling traversal that DOES reach all five; its NOTE: names this ticket
  - packages/quereus/test/visitor.spec.ts         # where a coverage ledger would live
repro: verified
severity: wrong-result
likelihood: unusual
tradeoffs: The five gaps are only reachable through SQL shapes almost nobody writes (a function call inside a window frame bound, or inside a nested statement's RETURNING list, inside a CHECK or generated-column body), and closing them widens what four other declaration-time validators in manager.ts see — so a maintainer could reasonably judge the risk of newly rejecting DDL that works today to be larger than the hole being closed.
---

# One AST traversal skips five expression-bearing places, and a declaration-time gate walks with it

## What the traversal is

`traverseAst` (`src/parser/visitor.ts`) is the engine's generic "visit every node
in this parsed statement" helper. Four checks in `src/schema/manager.ts` are built
on it, and they all run at `CREATE TABLE` time, before anything is stored:

- reject a bind parameter, or a bare column reference, in a `DEFAULT` expression;
- decide whether a `DEFAULT` embeds a subquery;
- decide whether a `DEFAULT` reads the row being written via `new.<column>`;
- **reject a non-deterministic function call in a `CHECK` or `GENERATED ALWAYS AS`
  body** — a generated column must be a pure function of its row, so `random()`
  or `date('now')` in one is refused up front.

A place the traversal never visits is a place none of those four checks can see.

## What goes wrong

Five expression-bearing places are never visited:

- a **window frame bound** — the `<expr>` in `rows between <expr> preceding and …`
  (the traversal carries this one as a `TODO` in its `windowDefinition` arm);
- a select's trailing **`with defaults (…)`** clause;
- a nested statement's **`returning`** list;
- a nested `insert`'s **`on conflict do update`** assignments and `where`;
- a nested statement's **`with context`** assignments.

The determinism gate's miss is user-visible. Each of these is accepted today,
and each one should have been refused (verified against the engine, one `create
table` each):

```sql
-- accepted; should be refused
create table c1 (id integer primary key,
  g integer generated always as
    ((select sum(v) over (rows between abs(random()) preceding and current row)
      from ds limit 1)));

create table c2 (id integer primary key,
  g integer generated always as ((select v from ds limit 1 with defaults (v = random()))));

create table c3 (id integer primary key,
  g integer generated always as
    ((select r from (insert into ds values (1, 1) returning random() as r) q limit 1)));

-- a CHECK constraint has the same hole
create table c4 (id integer primary key, n integer,
  check (n > (select sum(v) over (rows between abs(random()) preceding and current row)
              from ds limit 1)));
```

The control case — `generated always as ((select random() from ds limit 1))` — is
correctly refused, which is what makes these five misses rather than a missing
feature.

The consequence of acceptance is a stored generated column whose value is not a
function of its row: it differs between the `INSERT` that computes it and any later
recompute (an `UPDATE`, an `ALTER TABLE ADD COLUMN` backfill), so the same row can
read back differently depending on what touched it last. The other three checks have
the same blind spots, but no user-visible miss has been demonstrated for them — a
`DEFAULT` expression can only reach these subtrees through a nested query, where the
checks' own depth rules already stand down.

## Why a point fix is the wrong shape

Adding the five missing arms would close today's holes and leave the next AST field
to be forgotten the same way. There is a second traversal over the same node kinds —
the schema expression scope walk (`src/schema/expr-scope/walk.ts`) — which does reach
all five, and the two are kept in step only by a pair of cross-referencing comments.
That arrangement is deliberate (their scope models differ and unifying them was
considered and declined); what is missing is anything that *forces* a decision when
the AST grows a new expression-bearing field.

The scope walk's own spec already demonstrates the shape of the answer: a ledger
listing every expression node kind against how the walk treats it, so a new kind
fails to compile until someone classifies it. An equivalent ledger for `traverseAst`
— every AST node kind against every expression-bearing field it owns, and whether the
traversal descends it — would retire this whole class rather than these five
instances.

## What this ticket asks for

- Close the five gaps in `traverseAst`.
- Add the ledger-style coverage guard so a sixth cannot appear silently.
- **Price the blast radius first.** Widening the traversal widens what all four
  `manager.ts` callers see, and three of them *reject* DDL. Establish what, if
  anything, becomes newly rejected before landing the widening — that is the reason
  the gaps were left alone when they were discovered, and it is the real work here.

## Related

`bug-unknown-function-not-caught-at-declaration` is a different hole in the same
determinism gate: there the traversal *does* reach the function call, but the gate
skips a name the function registry cannot resolve. Disjoint root causes, adjacent
symptoms — worth reading together, and possibly worth fixing in one pass.

## How this was found

While reviewing `debt-schema-scope-walk-uncovered-subtrees`, which closed the same
five gaps in the *scope* walk. That change added a comment claiming window frame
bounds were the only remaining difference between the two traversals; checking the
claim turned up the other four and the determinism-gate consequence.

---
description: The built-in listing of integrity rules always shows an empty list of the tables each rule depends on, even when the rule clearly depends on one.
files:
  - packages/quereus/src/runtime/emit/create-assertion.ts   # emitCreateAssertion — the dependency-discovery walk (~lines 52-82)
  - packages/quereus/src/core/database-assertions.ts        # AssertionEvaluator.compileUnderSuppression — derives the same base set correctly, via extractBindings
  - packages/quereus/src/schema/assertion.ts                # IntegrityAssertionSchema.dependentTables
repro: verified
---

# `assertion_info().dependent_tables` is empty for every realistic assertion

## What happens

`create assertion` records which base tables the rule depends on, and surfaces
them through the `dependent_tables` column of `assertion_info()`. For the normal
way of writing an assertion the recorded list is empty:

```
create table t ( x integer primary key );
create assertion a1 check (not exists (select 1 from t where x < 0));
-- dependentTables is []   (expected: main.t)
```

Verified in-process at HEAD.

## Why

`emitCreateAssertion` plans the derived violation query
(`select 1 where not (<check expr>)`) and then walks the plan tree looking for
table references, descending only through each node's `getRelations()`. In that
query the base table lives inside a *scalar subquery expression* attached to the
`where`, not in the relational child chain — so the walk never reaches it.

Practically every assertion is written as `not exists (select … from <table> …)`
or similar, so practically every assertion records nothing.

## Impact

Display only. **Enforcement is unaffected**: the commit-time evaluator does not
read `dependentTables` — it derives its own base-table set with
`extractBindings` over the optimized plan when it compiles the body
(`AssertionEvaluator.compileUnderSuppression`), and that set is correct. The
consequence is limited to `assertion_info()` reporting nothing useful, and to any
future consumer that trusts the stored field.

## Worth considering

The evaluator already computes exactly the right answer. The obvious repair is to
have the create path derive the list the same way rather than maintain a second,
weaker walk — which would also make the two definitions unable to drift apart.
Whether the create path can afford the evaluator's full optimize-for-analysis
pass, and what should happen when it fails (today the failure is warned and the
list left empty, which must stay non-fatal — see
`fix/bug-assertion-body-can-name-missing-table` for the part that should *not*
stay non-fatal), are the questions to settle.

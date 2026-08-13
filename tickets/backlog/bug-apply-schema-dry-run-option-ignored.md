---
description: Asking the schema tool to do a practice run instead of a real one has no effect — it changes the database anyway, without warning.
files: packages/quereus/src/parser/parser.ts, packages/quereus/src/runtime/emit/schema-declarative.ts, packages/quereus/src/parser/ast.ts
difficulty: easy
repro: verified
severity: wrong-result
likelihood: normal-use
tradeoffs: The safe half of the fix (reject what is not implemented) is a small breaking change for anyone already passing these options and getting away with it, and the generous half (implement them) partly duplicates `diff schema`, which already previews a migration — a maintainer might reasonably close this by deleting the options instead.
---

## What happens

`apply schema` accepts an options list. Two of the options it accepts do nothing at all:

```sql
apply schema main options (dry_run = true)
apply schema main options (validate_only = true)
```

Both parse cleanly, and both perform a **real migration**. Verified directly: declaring a schema
with one table and applying it with `dry_run = true` leaves the table created.

The user-facing consequence is the worst kind — someone reaching for `dry_run` is reaching for it
precisely because they are not sure the change is safe, and the engine answers by making the change.

## Where it goes wrong

The parser fills `ApplySchemaStmt.options.dryRun` and `.validateOnly`, and the AST declares both
fields, so the surface looks supported. Nothing downstream ever reads either one — the emitter that
executes `apply schema` branches only on `renamePolicy` and `allowDestructive`. The options are
accepted into a field and dropped.

This is **not** caused by the applied-state fast path (the ticket during whose review it was
found); it predates it. The fast path is unaffected either way.

## What "fixed" should mean

The root problem is that the statement's option list can express an intent the executor does not
implement. Two ways out, and the choice is a maintainer's:

- **Reject.** Make the unimplemented options a parse/plan-time error, so the surface stops
  promising something it does not deliver. Cheapest, and honest. Point users at `diff schema`,
  which already previews exactly the migration `apply schema` would run.
- **Implement.** `dry_run` runs the diff and the plan and reports the steps without executing them;
  `validate_only` stops after the checks that can fail before any DDL runs (the reserved-tag
  diagnostics, the duplicate-name guard, the destructive-change gate). This is close to what
  `diff schema` already does, so decide whether the duplication earns its keep.

Whichever is chosen, the invariant worth landing with it is that an option the parser accepts must
be one the executor reads — otherwise the next added option repeats this silently.

## What to pin

A test that `apply schema … options (dry_run = true)` does not create the declared table (or, under
the reject route, that the statement fails). Today no test covers either option, which is why the
gap survived.

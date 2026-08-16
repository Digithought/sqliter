---
description: A leftover marker records whether a table's identity columns were spelled out by the author or filled in by the engine. That distinction is being retired, but another product still reads the marker, so deleting it here would break that product until its own matching change ships — a human needs to decide when the two land.
prereq: feat-relax-declared-primary-key-not-null
files:
  - packages/quereus/src/schema/table.ts (~44-67 `TableSchema.synthesizedPrimaryKey`; ~1193-1206 `findPKDefinition`'s `@returns` doc; ~1226-1257 the two return sites carrying `synthesized`)
  - packages/quereus/src/schema/manager.ts (~1710-1748 `buildColumnSchemas`' `synthesizedPk` return field; ~1966 and ~2025 — the two `synthesizedPrimaryKey:` assignments)
  - ../lamina/packages/lamina-quereus/src/quereus-ast-translators.ts (~646 — reads the field)
  - ../lamina/packages/lamina-quereus/src/module.ts (~3258 `rejectSynthesizedKeyWidening`)
  - ../lamina/tickets/backlog/debt-retire-synthesized-primary-key-flag.md (the other half of this change)
difficulty: medium
---

# Delete `TableSchema.synthesizedPrimaryKey` — needs cross-repo sequencing

## What the human decision is

`TableSchema.synthesizedPrimaryKey` is a boolean on every table's schema recording whether
the table's primary key was written by the author or synthesized by the engine (the
all-columns fallback a table gets when it declares no `PRIMARY KEY`). The maintainer has
decided the two are the same key — "an undeclared all-columns key is syntactic sugar for the
declared one" — which makes the flag meaningless and deletable.

Nothing in **this** repo reads it. The sibling `../lamina` repo does, in two places, and
lamina's own comments say the fallback it would use instead is unsound. So deleting the flag
here does not merely *unblock* lamina — it **breaks** lamina until lamina's matching change
ships.

**The decision:** land lamina's side first, or land both together in one coordinated change.
Someone with both repos in hand has to sequence it. That is why this sits in `blocked/`
rather than in the working queue.

## Why it can't just be queued

The dependency runs in a loop through both repos:

```
quereus  fix/bug-set-not-null-backfill-can-merge-two-primary-keys
  → quereus  implement/feat-relax-declared-primary-key-not-null
      → lamina  backlog/debt-retire-synthesized-primary-key-flag   (currently marked
        "blocked-on: ../quereus ticket feat-relax-declared-primary-key-not-null")
          → THIS ticket
```

lamina's ticket is still in lamina's `backlog/` — not promoted, not scheduled. Until a human
promotes and lands it, this ticket has nowhere to go.

## What lamina reads it for

- `packages/lamina-quereus/src/quereus-ast-translators.ts:646` reads
  `s.synthesizedPrimaryKey` and falls back to a *shape* test (is the key exactly every
  column, in order, ascending?) when the slot is absent.
- `packages/lamina-quereus/src/module.ts:3258` (`rejectSynthesizedKeyWidening`) gates its
  `ALTER TABLE … ADD COLUMN` key-widening refusal on `primaryKey.synthesized`.

lamina's own comment states the shape fallback cannot tell a *declared* all-columns primary
key from a synthesized one, and that using it for the ADD COLUMN decision would "silently
rewrite a key its author wrote". So the shape fallback is not an acceptable landing pad —
the flag has to disappear from both sides in step.

## The change, once unblocked

Small and mechanical — it is only the sequencing that is hard.

- Delete `TableSchema.synthesizedPrimaryKey` and its doc block (including its `NOTE:` about
  the lamina consumer).
- Delete the `synthesizedPk` field from `buildColumnSchemas`' return type and value in
  `schema/manager.ts`, and both `synthesizedPrimaryKey:` assignments (in
  `buildTableSchemaFromAST` and `buildLogicalTableSchema`).
- Delete `findPKDefinition`'s `synthesized` return member from its type and both return
  sites, and rewrite the `@returns` doc paragraph that explains it. Check first that nothing
  reads it — after `feat-relax-declared-primary-key-not-null` lands, its only remaining
  reader is the `synthesizedPk` plumbing above.
- Rewrite the block comment above `findPKDefinition`'s synthesized return, and
  `TableSchema.primaryKeyDefinition`'s neighbouring docs, so none of them describes a
  distinction that no longer exists.
- `yarn build`, `yarn test`, `yarn lint` — and a lamina build against the updated engine,
  which is the check that actually matters here.

## Not part of this

The canonical-DDL side of the retirement — making every key emit its `PRIMARY KEY` clause and
deleting `isSynthesizedAllColumnsKey` — is independent of lamina and is queued separately as
`implement/debt-emit-primary-key-clause-for-every-key`. That one also fixes a live bug (a
key column's `on conflict` action is lost across a persistence round-trip); do not hold it
for this.

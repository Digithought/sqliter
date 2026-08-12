----
description: Re-applying a declarative schema that has not changed still does all the work of comparing it against the database; design a safe way to detect "nothing to do" and skip it, without letting the engine miss a change someone made another way.
files: packages/quereus/src/runtime/emit/schema-declarative.ts, packages/quereus/src/schema/schema-hasher.ts, packages/quereus/src/schema/catalog.ts, packages/quereus/src/schema/manager.ts, packages/quereus/src/schema/schema-differ.ts
difficulty: medium
----

Split out of the backlog ticket `debt-apply-schema-redundant-work`, filed from [issue #29](https://github.com/gotchoices/quereus/issues/29) § *Related, lower priority*. The sibling arm is `apply-schema-migration-plan-representation`; the two are independent and share no code site.

## What happens today

`emitApplySchema` (`schema-declarative.ts:194–303`) always walks the full path: resolve the declared schema, `collectSchemaCatalog(db, schemaName)`, `computeSchemaDiff(...)`, `generateMigrationDDL(...)`. Only *after* the diff does a fast path exist — an empty statement list skips `runBatchedMigrationLoop`, so no module batch hooks fire. The diff itself is never skipped.

`computeShortSchemaHash` (`schema-hasher.ts:87`) exists and is wired to exactly one caller: `explain schema` (`schema-declarative.ts:406`). Nothing stores it, and `apply schema` never consults it.

Reporter's measurement of the always-paid work on a ~92 KB declared schema (54 tables, 14 views): **~12 ms**. Theirs, not reproduced here.

An idempotent reopen — apply the same schema every time an application starts, the normal embedder pattern this feature is built for — pays that on every single start for a guaranteed-empty diff.

## The soundness problem, which is the whole ticket

The naive fix (remember the hash of the last successfully applied declaration; skip when it matches) is **unsound**, and the reason is worth stating precisely: the hash covers the *declared* side only. `apply schema` is documented and used as a **reconciling** operation — it makes the catalog match the declaration, whatever the catalog currently is. A declared-side-only hash silently changes it into "apply the delta since the last apply *by this process*", which is a different and much weaker contract.

Cases it would skip over, each of which reconciles correctly today:

- a direct `drop table` / `alter table` between two applies in the same process;
- a schema change from another connection to the same database;
- a store-backed database reopened against persisted state that changed out of band;
- anything that mutates the catalog without going through the declarative pipeline at all.

So the design problem is: **find a cheap, sound signal for "the catalog has not moved either"**, or write down explicitly what the fast path is permitted to miss and make that a documented property rather than an accident.

## Design directions, with a recommendation

- **Catalog epoch counter (recommended starting point).** A monotonic counter on `SchemaManager`, bumped on every registration/deregistration/alter. Cache `(declaredHash, epochAtLastApply)` per schema; skip when both match. Cheap to check (an integer compare), and — unlike a content hash of the catalog — it does not require `collectSchemaCatalog`, which is the expensive half of the 12 ms. The correctness burden moves to *completeness of the bump*: every mutation site must bump, and a missed site is a silent wrong-skip. That is a real risk in a manager of this size, so the epoch needs a guard test that fails when a new mutation path forgets to bump, not just a review pass.
- **Both-sides content fingerprint.** Sound and self-checking, but requires collecting the catalog to compute — which likely eats most of the win. Measure before dismissing; if `collectSchemaCatalog` turns out to be cheap relative to `computeSchemaDiff`, this becomes attractive precisely because it has no completeness obligation.
- **Opt-in only.** Expose the skip behind an explicit option (e.g. `apply schema X options (assume_unchanged = true)`) and leave the default path always-reconciling. Weakest win, zero soundness risk, and honest — the caller asserts the precondition. A reasonable fallback if neither of the above survives scrutiny.

Note the interaction with schema events: `SchemaManager` already emits auto schema events, but only when a listener is registered (`emitAutoSchemaEventIfNeeded`, `manager.ts:2806`). That is a notification channel, not a version counter, and it is conditional — it cannot be the fast path's signal as-is, though the epoch bump could plausibly live at the same sites.

## Constraints that must hold

- The fast path must be **observably indistinguishable** from a full apply whose diff comes out empty — including the existing behaviour that no module batch hooks fire on an empty diff.
- `apply schema … with seed` must still apply seeds when it skips the migration, or must not skip at all in that case. Seeding is idempotent by construction (`ON CONFLICT (pk) DO NOTHING`) but it is not a no-op: a table emptied since the last apply gets its seed rows back today. Decide this deliberately and state it.
- `explain schema` and `diff schema` must keep working unchanged — `diff schema` is a preview and must never take the fast path.
- Whatever is cached must be keyed per schema name and must not leak across `Database` instances.

## TODO

- Measure the 12 ms breakdown: declared-schema resolution vs `collectSchemaCatalog` vs `computeSchemaDiff`. This decides between the epoch counter and the both-sides fingerprint — do not pick before measuring.
- Settle the direction and record the rejected alternatives and why in the implement ticket.
- If the epoch counter wins: enumerate every `SchemaManager` mutation site that must bump, and design the guard that catches a future site that forgets. A completeness argument by inspection alone is not sufficient here.
- Decide the `with seed` interaction explicitly and document it in `docs/` alongside the declarative-schema behaviour.
- Emit implement ticket(s) with an `## Edge cases & interactions` section covering: out-of-band `drop`/`alter` between applies, a second connection mutating the catalog, store reopen against changed persisted state, `with seed`, `diff schema` never fast-pathing, per-schema cache keying, and a before/after measurement on a large schema as the acceptance criterion.

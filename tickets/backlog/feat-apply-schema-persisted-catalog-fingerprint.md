---
description: An application that re-applies the same unchanged schema every time it starts still pays for a full comparison against the database on every start; remembering the last result inside the database itself would let a restart skip it.
prereq: apply-schema-unchanged-fast-path
files: packages/quereus/src/runtime/emit/schema-declarative.ts, packages/quereus/src/schema/declared-schema-manager.ts, packages/quereus/src/schema/catalog-rendering.ts, packages/quereus-store/src
difficulty: hard
tradeoffs: Buys a few milliseconds once per process start in exchange for a new piece of persisted engine state that has to stay exactly in step with the catalog across crashes — a maintainer could reasonably say the saving is not worth a new durability invariant.
---

## The gap this fills

`apply schema X` reconciles: it compares the declared schema against whatever the database
currently holds and migrates the difference. The normal embedder pattern is to declare and apply
the same schema at every application start, so the comparison usually finds nothing to do — but it
runs in full anyway.

The sibling ticket `apply-schema-unchanged-fast-path` makes a **repeat** apply cheap by remembering,
in memory, what both sides looked like at the end of the last successful apply. That does nothing
for the start-up case, because there is exactly one apply per process and the in-memory memory is
empty on it.

To help the start-up case, the "what it looked like last time" record has to survive the process —
i.e. live in the database alongside the catalog.

## What a solution would look like

On reopen the engine already rehydrates the catalog, so the *current* side can be re-derived
locally. The only thing that must be persisted is the record of the last successful reconcile:
the rendering of the declaration that was applied, and the rendering of the catalog it left behind.
On the next start, render both again and compare; equal on both sides means the reconcile can be
skipped.

Note the pleasant consequence: a peer process that changed the stored schema out of band is caught
for free, because this process re-derives the catalog side from what it actually read. The
persisted record is not trusted as a description of the current catalog — only as a description of
what the last reconcile concluded.

## Why it is hard

The record has to be written **atomically with the catalog changes it describes**. A crash between
"migration committed" and "record written" is harmless (the record is stale-absent, so the next
start reconciles in full). A crash the other way round — record written, catalog changes not
durable — leaves a record claiming a state the database is not in, and the next start silently
skips a reconcile it needed. Getting that ordering right across every storage module is the real
work, not the comparison.

Secondary questions a design pass has to answer:

- Where the record lives (an engine-managed table? a store-module catalog slot?) and how it is
  keyed per schema name.
- What happens on an engine version change that alters how either side is rendered — a rendering
  change must invalidate every persisted record rather than compare unequal-but-plausible strings.
- Whether the record is per-database or per-declared-schema-name, given attached schemas.
- Whether storage modules that keep no catalog of their own simply opt out.

## What it is worth

From the plan-stage measurements in `bench/apply-schema-unchanged.mjs` (54 tables, 14 views, median
of 9, one Windows box — ratios are the finding, absolutes are one machine's):

| declaration | no-op apply total | the part this could remove | estimated cost of the check | estimated saving |
|---|---|---|---|---|
| 20.4 KB | 1.35 ms | 1.18 ms (collect + diff) | ~0.6 ms | ~0.6 ms |
| 62.9 KB | 3.40 ms | 2.84 ms | ~1.1 ms | ~1.7 ms |
| 112.7 KB | 5.21 ms | 4.65 ms | ~2.0 ms | ~2.6 ms |

The check is not free on a cold start: rendering the *declaration* costs roughly what the sibling
ticket measures at ~1.26 ms for the 112.7 KB case (inferred at plan stage; the sibling ticket
records the real number when it lands). That rendering has to happen on every start, since there is
nothing in memory to compare against, which is why the saving is roughly half the removable work
rather than all of it.

So: single-digit milliseconds off application start-up, growing with schema size. Worth filing;
not obviously worth the durability invariant. That call is a maintainer's.

## Do not start this before

`apply-schema-unchanged-fast-path` lands — it builds both renderings and the in-memory record this
would persist. Building the persisted version first would mean building them twice.

---
description: Quereus is about to allow a table's identity columns to be left empty, which is stricter in every other SQL database — this asks a human whether the database should say something out loud when someone writes a table that way, so the difference is visible where it is written.
files:
  - packages/quereus/src/schema/table.ts (`columnDefToSchema` — where a column-level `null` + `primary key` pair is resolved)
  - packages/quereus/src/schema/manager.ts (`buildColumnSchemas` — where the same pair is resolved for a table-level key)
  - packages/quereus/src/common/logger.ts (the only message channel that exists today)
  - tickets/blocked/feat-experimental-feature-runtime-notice.md (the same open question, for a different feature)
tradeoffs: |
  A warning nobody sees costs maintenance and buys nothing, and Quereus has no user-facing
  message channel today — only a debug logger. Adding one for this is out of proportion to
  the feature. Against that: the divergence is silent and only bites at the moment someone
  ports a schema from another database, which is exactly when a message would land.
---

**Blocked — a decision only a human should make.** Nothing is missing except the answer to
the question below. The feature it concerns
(`tickets/implement/feat-relax-declared-primary-key-not-null`) ships without it; this is a
follow-on that can land any time, or never.

## The question, plainly

*When someone writes a table whose identity columns are allowed to be empty, should the
database say so out loud — and if so, through what?*

```sql
create table t (x integer null primary key);
--                        ^^^^  in Postgres, SQLite, MySQL, SQL Server: an error or ignored.
--                              In Quereus after this change: accepted, x really is nullable.
```

Three answers are all defensible:

- **Nothing.** It is documented behaviour; documented behaviour does not warrant a runtime
  message. This is the status quo and costs nothing.
- **A debug-log line.** Cheap — `warnLog` already exists and `findPKDefinition` already logs
  on a neighbouring path ("No PRIMARY KEY explicitly defined"). But a debug log is not seen
  by the person writing the DDL, so it mostly buys a grep target.
- **A real user-facing advisory**, surfaced at `create table` time the way the lens
  subsystem surfaces its advisory codes. Genuinely useful, and genuinely more work — see
  the catch below.

## Why this needs a human

The engine's `NOT NULL`-by-default posture is a deliberate design position, and so is this
relaxation. Whether the *departure from every other SQL dialect* is something the project
wants to advertise at the point of authorship is a product judgement about who Quereus's
users are and where they are coming from, not a technical one. Someone porting a schema
from Postgres or SQLite gets a weaker constraint than they wrote, with no error — that is
the single most likely way this change surprises anyone. Whether that is worth a message is
the call being asked for.

## The catch

Quereus has **no user-facing message channel**. There is a debug logger
(`packages/quereus/src/common/logger.ts`) and there are lens advisory codes, which are
specific to the lens subsystem. Anything that reaches the person typing the DDL would be a
new mechanism.

That is the same catch, and largely the same design work, as
`tickets/blocked/feat-experimental-feature-runtime-notice.md`, which asks whether the
database should warn on first use of an Experimental feature. If a general notice channel is
ever built for that, this becomes a two-line addition on top of it. **Consider answering
both together** — separately, each looks like it has to justify the whole mechanism on its
own, which is why neither is obviously worth doing.

## What happens if nothing is decided

Nothing breaks. The relaxation ships and is documented in `docs/schema.md`,
`docs/sql-constraints.md`, and `docs/sql-txn.md`. Users who read the docs are fine; users
who port DDL from another engine get a quietly weaker constraint. There is no deadline.

## One thing already answered, recorded here so it is not asked twice

The originating plan ticket flagged a second open question alongside this one: what a
foreign key referencing a parent key that contains an empty value should mean. Research
during planning settled it and it needs **no** decision and no code — the engine already
answers it uniformly, everywhere: a parent key tuple containing NULL is unreferenceable. A
child row with non-empty values can never match it (equality against NULL is never true),
a child row with any empty value is admitted unchecked (the standard MATCH SIMPLE rule),
and every parent-side `cascade` / `restrict` path already skips such a tuple. That path is
not even new — a foreign key may already reference a nullable `UNIQUE` column today. The
rule and its evidence are written up in
`tickets/implement/feat-relax-declared-primary-key-not-null` § "Foreign keys", which also
adds the tests and the documentation for it. Flag it there if you disagree with the reading.

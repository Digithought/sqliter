---
description: |
  One test-corpus file quietly uses a `create index` statement in its last section, but never
  declares that it needs standalone index support — so a backend that does not offer that feature
  cannot pass the file even though every other section of it works there.
repro: verified
files:
  - packages/quereus/test/logic/41.2.3-alter-column-set-not-null-pk-backfill.sqllogic # § 12, line 289
  - packages/quereus/test/logic/43.3-nullable-primary-key.sqllogic # the same author's file that got this right, see its § 12 header prose
---

# `41.2.3-alter-column-set-not-null-pk-backfill.sqllogic` § 12 needs `standalone-index-ddl`

## What is wrong

`41.2.3-alter-column-set-not-null-pk-backfill.sqllogic` carries no
`-- requires-capability:` directive. Its last section, § 12 ("A SECONDARY INDEX over an untouched
column still resolves after the re-key"), opens with:

```sql
create table t_bf13 (x integer null default 7, y integer null);
create index ix_bf13 on t_bf13 (y);
```

`create index` as a standalone statement is the `standalone-index-ddl` capability. The capability
directive is per-file and whole-file by design, so a backend lacking it has only two outcomes for
this file, both bad:

- run the file and fail at line 289 with
  `Virtual table module '<m>' for table 't_bf13' does not support CREATE INDEX`, even though
  §§ 1-11 all pass; or
- have the file declare the capability, which skips the whole file and loses §§ 1-11 coverage —
  eleven sections of primary-key-backfill semantics that have nothing to do with secondary indexes.

Sibling file `43.3-nullable-primary-key.sqllogic` faces the same choice in its § 12 and resolves it
the other way, in prose that spells out the intent:

> Table-level `unique` (not a standalone `create unique index`) so the file needs no
> `-- requires-capability: standalone-index-ddl` and runs on every backend.

§ 12 of `41.2.3` is the only part of that file that needs the capability.

## How it was found

Lamina's conformance harness runs this corpus against the `lamina` vtab module, which has no
standalone index DDL (`LAMINA_BACKEND_CAPABILITIES` is empty). With the primary-key-backfill work
that file specifies implemented on the Lamina side, §§ 1-11 pass and the run stops at line 289.

## Expected shape of the fix

Either is fine; the first keeps the most coverage:

- **Split § 12 into a sibling file** (e.g. `41.2.3.1-alter-column-set-not-null-pk-backfill-secondary-index.sqllogic`)
  that declares `-- requires-capability: standalone-index-ddl`, and drop § 12 from `41.2.3`. This is
  what the directive's own contract recommends for section-scoped needs.
- Or rewrite § 12 to reach a secondary index without standalone index DDL, the way `43.3` § 12 does
  with a table-level `unique`. The section's subject is "an index whose entries embed the primary
  key still resolves after the key moves", which a table-level `unique` also exercises.

Filed from the lamina board while implementing
`tickets/fix/nullable-key-column-notnull-flip-verbs.md`.

description: Once queries can opt into reading slightly older data instead of waiting behind a write, let an application turn that on once for the whole database rather than repeating the option at every call site.
prereq: concurrent-reads-engine-path
files: packages/quereus/src/core/database-options.ts, packages/quereus/src/core/database.ts, packages/quereus/src/common/types.ts
difficulty: easy
----

# Database-level default for read concurrency

The concurrent committed-read path is opted into per call, via
`StatementOptions.readConcurrency: 'committed'`. That was chosen deliberately:
the option gives up the guarantee that `void db.exec(insert); await
db.get(select)` shows the insert, and a per-call opt-in keeps that tradeoff
visible at the site accepting it.

An application that wants the behaviour everywhere (a UI reading from a
database whose writes go over a slow network, say) has to thread the option
through every read. A database option — e.g. `default_read_concurrency`,
registered in `DatabaseOptionsManager` alongside the existing options — would
set the default that a per-statement `readConcurrency` still overrides.

## Why this is not obviously a good idea

Flipping it changes ordering semantics for every read in the codebase,
including reads written long before anyone flipped it, and including reads
inside library code the application does not own. The failure mode is a read
that silently returns pre-write data in a place where the author assumed
queue ordering — quiet, intermittent, and hard to attribute.

Worth doing only once there is a real consumer asking for it, and worth doing
with the option name and docs stating the ordering tradeoff loudly.

## Open questions for whoever picks this up

- Should the option be settable only before the first statement, so an
  application cannot change read semantics mid-flight?
- Should a statement inside an explicit transaction be exempt (it already is,
  by eligibility) *and* should the option be ignored while any explicit
  transaction has ever been used on that database?
- Does the CLI / web UI need to surface it, or is it a programmatic-only knob?

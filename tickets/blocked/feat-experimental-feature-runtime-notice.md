----
description: Someone can use one of the project's research-grade features without ever reading the docs that warn it may break without notice; this asks a human whether the database should say so out loud the first time such a feature is used.
files:
  - docs/stability.md (the tier definitions this notice would point at)
  - packages/quereus/src/common/logger.ts (the existing logging surface — see the caveat below)
  - packages/quereus/src/schema/lens.ts, lens-compiler.ts (a candidate first-use site)
  - packages/quereus/src/core/database.ts (where a per-database "already warned" flag would live)
----

**Blocked — category (a): a decision only a human should make.** It unblocks the moment
someone answers this: *should the database emit a runtime warning the first time an
Experimental feature is used, and if so, is it on or off by default?* Nothing else is
missing — the design is worked out below and can be built as soon as that call is made.

## The question, plainly

Some of Quereus's features are marked **Experimental**, which means exactly this: they may
change or be removed in any release, including a patch release, with no upgrade path for
anything already stored using them. That promise is published in `docs/stability.md` and
every user-facing doc carries its tier.

That works for someone who reads the docs before adopting a feature. It does nothing for
someone who copies `create lens` out of an example, an AI completion, or a colleague's
branch, and ships it. They find out at the next upgrade.

The proposal is a one-time message, printed once per database connection, the first time
the user actually touches an Experimental feature. Roughly:

> Lenses are an Experimental feature: the API and any stored artifacts may change or be
> removed in any release, including a patch. See https://…/docs/stability.md

## What happens if we do nothing

Nothing breaks. The status quo holds: the tiers stay documented and unenforced, and users
who don't read the docs keep discovering the tier when an upgrade breaks them. The cost is
paid by them, later, and it is not recoverable — stored artifacts from a removed feature
have no migration. There is no deadline; this can sit indefinitely.

## The catch that may decide it for you

Quereus's logger is built on the `debug` library. `debug` output is **off unless the user
opts into a namespace**. So a notice sent through the existing logger — even one "on by
default" — is invisible to essentially everyone it is meant to reach. Making it visible
means adding a separate always-on output channel to a library that currently prints nothing
unbidden.

That reframes the question. It is not "should we log a line"; it is "is this worth adding an
always-on output channel for". Settle that first; it may be the whole answer.

## Options

1. **Do nothing.** Documentation is the channel. Cheapest, changes no behavior, leaves the
   gap open.
2. **RECOMMENDED DEFAULT — do nothing *as a log line*; make the tier visible in the API
   surface instead.** Name Experimental entry points so they can't be adopted unknowingly
   (an `Experimental` suffix on the exported symbol, or a required opt-in flag on the
   `Database` options before an Experimental statement will run). A user cannot type it
   without seeing it, no output channel is needed, and libraries that print unbidden are the
   thing people wrap to silence. This is the lowest-regret option: it closes the gap without
   committing the project to a new always-on channel.
3. **Log it through `debug`, default on.** Cheap to build, but per the catch above, almost
   nobody will see it. Risks being mistaken for having solved the problem.
4. **Log it through a new always-on channel, default on, silenceable.** Actually reaches
   users. Costs a new output surface in a library, and needs a suppression option (a
   `pragma`, or a `Database` option alongside the existing `nondeterministic_schema` and
   friends) so consumers can quiet it.

## How reversible is this call

Options 1, 3 and 4 are cheap to reverse — adding or removing a log line is a small,
self-contained change with no stored consequences. Option 2 is the sticky one: renaming a
public export or adding a required opt-in flag is a breaking change for anyone already
using the feature, so it is best done now while adoption is small rather than later.

## The shape it should take, if the answer is yes

**Once per database, on first use — not at startup.** A process that never touches an
Experimental feature has nothing to be told, and a startup banner is the kind of noise
people learn to filter, taking the real warnings with it.

**On first use, not per statement.** A notice on every statement is a notice nobody reads.

**Not on the parallel-runtime optimizer rules.** This is the important carve-out. Two rules
from the Experimental parallel track (`rule-fanout-lookup-join`,
`rule-async-gather-zip-by-key`) are registered in the optimizer and fire on ordinary
`select` statements. The user did not opt in and cannot opt out. Warning them about a
feature they cannot avoid using is a warning they cannot act on. The tier there covers
plan-node shapes and internal APIs, never the correctness of returned rows — so there is
nothing for the user to do and nothing to say. Warn only on surfaces the user *chose*:
`create lens`, `declare logical schema`, lens deployment, sync.

**Silenceable.** Whatever the default, offer a way to turn it off.

**Experimental only, probably not Beta.** Beta surfaces break in minor releases, which
release notes already cover.

## Where this came from

The `docs-stability-tiers` plan asked whether an Experimental feature needs a visible
in-product signal beyond the documentation table, and was told to *recommend, not mandate*.
Publishing the tiers was a documentation change with a firm no-behavior-change boundary;
emitting anything at runtime crosses it. So it is filed here as its own decision.

## Non-goals

- Any change to what a tier promises. Those are settled in `docs/stability.md`.
- Any decision about freezing the parallel-runtime track. That is a separate product call.

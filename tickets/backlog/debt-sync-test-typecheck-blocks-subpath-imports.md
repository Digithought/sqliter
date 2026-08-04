---
description: The sync package's test type-check uses an old module-resolution mode, so sync source files cannot import from the engine's secondary entry points and have to work around it — a workaround that will be re-invented every time someone needs one of those types.
files:
  - packages/quereus-sync/tsconfig.test.json         # moduleResolution: "node" — the cause
  - packages/quereus-sync/tsconfig.json              # moduleResolution: "NodeNext" — what src actually builds under
  - packages/quereus-sync/register.mjs               # the ts-node/ESM loader the test run uses
  - packages/quereus-sync/src/sync/store-adapter.ts  # current workaround: AST types derived structurally from Parser['parse']
  - packages/quereus/src/index.ts                    # exports widened purely so the sync package could reach two helpers
difficulty: medium
---

# The sync test type-check dictates what sync source may import

## The situation

The engine package publishes three entry points: its main one, plus `/parser`
and `/emit` for the syntax-tree and SQL-rendering helpers.

The sync package builds its source with a modern module-resolution setting that
understands those secondary entry points. But its **test** type-check config
(`tsconfig.test.json`) overrides the setting to the oldest mode, which predates
them — and that config compiles `src/**/*` as well as `test/**/*`. So the older,
narrower mode is the one that decides what source files are allowed to import.

Verified by adding a one-line probe file importing from `@quereus/quereus/parser`
and running each config:

- `tsc --noEmit` (source config): clean.
- `tsc -p tsconfig.test.json --noEmit`: `error TS2307: Cannot find module
  '@quereus/quereus/parser' … There are types at
  '…/dist/src/parser/index.d.ts', but this result could not be resolved under
  your current 'moduleResolution' setting. Consider updating to 'node16',
  'nodenext', or 'bundler'.`

## What it has cost so far

Replicating table alterations needed the syntax-tree types for `ALTER TABLE`,
plus two helpers that live behind the secondary entry points. Neither could be
imported, so:

- the syntax-tree types were re-derived *structurally* from the parser's return
  type instead of imported by name — which works, but is opaque to read and
  breaks in confusing ways if the parser's signature shifts;
- two engine helpers were added to the engine's main entry point purely so the
  sync package could see them, widening a public surface for a tooling reason
  rather than a design one.

Both are documented at their sites, so nothing is mysterious today. The concern
is that the next sync file needing a syntax-tree type hits the same wall and
either repeats the workaround or widens the main entry point again.

## What's wanted

The test type-check should resolve modules the same way the source build does,
so "what source may import" is decided by the source config alone. The catch is
that the setting is entangled with how the sync tests actually run — mocha via a
ts-node ESM loader (`register.mjs`) with loose specifier resolution — so
changing it means checking the test run still works, not just that the type check
passes.

Once it does, the two workarounds above can be unwound: import the syntax-tree
types by name, and reconsider whether the two engine helpers belong on the main
entry point on their own merits.

## Related

`debt-guard-test-typecheck-covers-files` covers a different failure of the same
config family (a test type-check that silently compiles nothing). This ticket is
about the resolution *mode*, not about whether files are picked up — they are.

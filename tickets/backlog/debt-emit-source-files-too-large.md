---
description: Two files in the SQL engine's instruction-emitter folder have grown to roughly 2,200 and 3,100 lines each; split them so each file covers one job and is readable on its own.
files:
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts   # 3,093 lines — the bigger one
  - packages/quereus/src/runtime/emit/alter-table.ts                 # 2,155 lines
  - packages/quereus-isolation/src/alter-migration.ts                # a prior split of this kind, for reference
---

# Two oversized emitter files

`packages/quereus/src/runtime/emit/` holds one module per plan-node family. Two of them have
grown far past the size at which the project has previously split a file — the isolation
package got its own splitting tickets at ~1,800 lines (`debt-isolation-module-file-too-large`,
and the already-landed `debt-isolation-module-alter-migration-extract`).

| file | lines |
|---|---|
| `materialized-view-helpers.ts` | 3,093 |
| `alter-table.ts` | 2,155 |

Both mix several jobs that a reader has to hold at once:

- `alter-table.ts` contains the dispatcher for every `ALTER TABLE` verb, the per-verb runners
  (add/drop/rename column, alter column, primary key, constraints, tags, the maintained-view
  lifecycle verbs), *and* three independent table-rebuild strategies (in-place memory rebuild,
  shadow-table rebuild via generated SQL, and the native-module path). The rebuild strategies
  in particular are self-contained and read as their own concern.
- `materialized-view-helpers.ts` is the larger of the two; its internal seams need a look
  before proposing a split.

## Why this is worth doing

Nothing is broken. The cost is comprehension: every ticket touching an `ALTER TABLE` behaviour
has to load a 2,000-line file to change twenty lines, and the file's several concerns make it
easy to add a per-verb behaviour to the wrong place (or to only one of the two rebuild paths).

## Expected outcome

Each resulting file does one job and says so in its header comment. No behaviour change, no
public-API change — the emitter entry points stay where their callers expect them. Existing
tests must pass unchanged; a split that needs test edits is a split that changed behaviour.

Take the two files independently — they share no code and either can land alone.

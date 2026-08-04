---
description: The sync design document was too long and kept the standard documentation check failing; its protocol and API reference chapter moved into its own file, and the check now passes.
files:
  - docs/sync-protocol.md               # NEW — the moved chapter (3575 words)
  - docs/sync.md                        # hub; now 10213 words, was 13645
  - docs/.doc-budget.json               # `docs/sync.md` ratchet entry deleted
  - docs/.stability.json                # `docs/sync-protocol.md` classified Experimental
  - docs/todo.md                        # anchor repointed
  - docs/sync-coordinator.md            # prose marker + link repointed
  - README.md                           # docs index gained the satellite
  - tickets/.pre-existing-known.md       # `yarn docs:check` entry deleted
difficulty: medium
---

## What landed

`docs/sync.md` lines 641-1129 (`## Sync Protocol` through the line before `## Reactive Hooks`)
became `docs/sync-protocol.md`. The hub keeps the CRDT model — clocks, conflict resolution,
tombstones, transaction grouping, transactional integrity, storage layout — and the satellite
holds the reference material a transport or client author needs: wire data structures, the
`SyncManager` API surface, and the WebSocket message protocol.

Same hub-and-satellite shape the repo already uses for `docs/optimizer.md` and
`docs/view-updateability.md`.

### The gate

`node scripts/check-docs.mjs` exits **0** — "Docs OK: links resolve, invariants well-formed,
sizes within ratchet, doc and package tiers declared." It was the only red step in `yarn check`,
so `yarn check` now gets past its first step for the first time in this ticket chain.

`ratchet` in `docs/.doc-budget.json` now contains exactly one entry, `docs/lens.md`, as the plan
predicted.

### Word counts (`wc -w`, 2026-08-04)

| file | before | after |
| --- | --- | --- |
| `docs/sync.md` | 13645 | **10213** (cap is 12000, no ratchet entry) |
| `docs/sync-protocol.md` | — | **3575** |

The 143-word overshoot versus the 13645 original is the satellite's H1 + stability banner +
three-line intro, the hub's new `## Topic documents` table, and the stub.

## How to verify

Cheapest first. All of these were run and passed before handoff.

- **The gate.** `node scripts/check-docs.mjs` → exit 0. This is the load-bearing check: its
  link-integrity pass (check A) validates every `#anchor` against the target file's headings, so
  it is what proves the three retargeted anchors below actually resolve.
- **The moved text is byte-identical.** Reconstruct it and diff against `HEAD`:

  ```bash
  node -e '
  const {readFileSync}=require("fs"), {execSync}=require("child_process");
  const exp=execSync("git show HEAD:docs/sync.md",{encoding:"buffer"}).toString("utf8")
    .replace(/^﻿/,"").split(/\r?\n/).slice(640,1129);
  let rest=readFileSync("docs/sync-protocol.md","utf8").split(/\r?\n/).slice(8);
  while(rest.length && rest[rest.length-1]==="") rest.pop();
  let f=false;
  const got=["## Sync Protocol",""].concat(rest.map(l=>{
    if(/^\s*```/.test(l)){f=!f;return l}
    return (!f && /^#{2,3}\s/.test(l)) ? "#"+l : l;
  }));
  while(got.length<exp.length) got.push("");
  const bad=exp.filter((l,i)=>l!==got[i]).length;
  console.log(bad?bad+" MISMATCHED":"IDENTICAL: "+exp.length+" lines");'
  ```

  Prints `IDENTICAL: 489 lines`. The only edits inside the moved range are the heading
  promotion (`###`→`##`, `####`→`###`, fence-aware) and dropping the original `## Sync Protocol`
  line in favour of the H1 front matter.
- **The byte-order mark stayed put.** `head -c 3 docs/sync.md | xxd` → `efbbbf`.
  The same command on `docs/sync-protocol.md` → `2320 5379` (`# Sy`), i.e. **no BOM**. This was
  the ticket's named corruption mode; both are as intended.
- **Line endings.** `docs/sync-protocol.md` is 494 CRLF, **0 bare LF** — matches `.editorconfig`.
- **No duplicate heading slugs on either file.** 36 headings on `sync.md`, 14 on
  `sync-protocol.md`, zero collisions, so no `-1`/`-2` anchor suffix shifted.
- **Tree.** `yarn build`, `yarn typecheck`, `yarn lint` all pass (typecheck 26s, lint 28s, both
  exit 0; build log has zero `error`/`failed` hits).

## Retargeted references

Three, not the two the plan named — the coordinator site had both a prose marker and a bare
file link on one line, and both moved:

| Site | Was | Now |
| --- | --- | --- |
| `docs/todo.md:448` | `` [`sync.md`](sync.md#data-structures) `` | `` [`sync-protocol.md`](sync-protocol.md#data-structures) `` |
| `docs/sync-coordinator.md:220` | `` [`sync.md` § Protocol version](sync.md) `` | `` [`sync-protocol.md` § Protocol version](sync-protocol.md#protocol-version) `` |
| `docs/sync.md:652` (the stub) | — | `Moved to [Sync Protocol](sync-protocol.md#sync-protocol).` |

The coordinator link previously pointed at the *file* while the prose named a section; it now
points at the section. That is a small improvement beyond the literal instruction — flagging it
so the reviewer can object if the plain file link was deliberate.

Re-ran the reference sweep after the move. Every surviving `sync.md#…` anchor in the tree targets
`#transactional-integrity-during-sync` or `#store-isolation-store-phase-8---future`, both of which
stayed on the hub:

```bash
grep -rn "sync\.md#" --include=*.md --include=*.ts . | grep -v node_modules | grep -v /dist/
```

## Judgement calls the reviewer should check

- **The `## Topic documents` table on `docs/sync.md:7-14`.** The `Covers` blurbs for
  `sync-coordinator.md` and `migration.md` are **my summaries of those documents**, not text
  copied from them. Worth a read against the actual files — a wrong blurb is the kind of thing
  that survives for years. The `sync-protocol.md` and `sync-schema.md` rows are closer to their
  sources.
- **The satellite's three-line intro** (`docs/sync-protocol.md:5-7`) is likewise newly written,
  ending in "A satellite of [Sync Module](sync.md)." per the plan.
- **`README.md:137`** gained a `Sync Protocol` entry under *Storage & Sync*. That index already
  listed `sync-schema.md` but, oddly, never listed `sync.md` itself — I added only the satellite
  rather than fixing the omission, to keep this diff one contiguous change. Adding `sync.md` to
  that index is a reasonable one-line follow-up if the reviewer wants it.

## Known gaps and things I did not touch

- **`yarn test` was not run.** The diff is markdown plus two JSON keys — `git status` shows only
  `.md` and `.json` files changed, zero `.ts`. `packages/quereus-sync/README.md` needed no edit
  (see below), so no package source moved at all.
- **Pre-existing stale section markers, left alone.** These name headings that do not exist in
  `docs/sync.md` and never did within this ticket's range; they belong to
  `backlog/debt-check-docs-validate-section-markers`:
  - `docs/sync.md § Streaming Snapshot API` — `packages/quereus-sync/src/sync/protocol.ts:310`,
    `packages/quereus-sync/README.md:210`, and **`docs/sync-schema.md:69`**. That third site is
    one the plan did not list; I found it in the sweep and left it, same as the other two.
  - `docs/sync.md § Who drives the sweep` — `docs/migration.md:114`,
    `packages/quereus-sync/src/sync/maintenance.ts:7`, `packages/sync-coordinator/README.md:80`.

  Note the shape of the hazard: `check-docs.mjs` validates markdown `#anchors` but **not** these
  `§ Section Name` prose markers, which is exactly why they rotted unnoticed. A split like this
  one cannot be caught by the gate if it breaks a `§` marker. It did not here — none of the
  markers name a heading in the moved range — but the reviewer should not read a green gate as
  proof of that.
- **`Streaming Snapshot Example` (now `docs/sync.md:917`) stayed on the hub** under
  `## Usage Example`, per the plan, despite reading like protocol material. Deliberate: one
  contiguous cut.
- **`docs/lens.md` is still the loose end.** 18310 words against a 17934 ratchet — inside the
  500-word grace band with **124 words of headroom**. The gate prints this on every run and goes
  red the first time someone adds more than 124 words to it. Its split is a human decision already
  tracked in `tickets/blocked/debt-docs-split-lens-when-stable`; nothing new filed for it.

## Two references that are now cross-page — left verbatim, reviewer's call

Byte-identity proves nothing was *lost*; it does not prove the chapter **reads** standalone. I
swept the satellite for positional and `§` references (`above|below|earlier|as described|see the
… section`) and found four. Two are page-local and fine. **Two now point at the hub:**

| Site | Text | Target now lives at |
| --- | --- | --- |
| `docs/sync-protocol.md:185` | "The header HLC is drift-validated before the clear (see the HLC section)" | `docs/sync.md:30` `### Hybrid Logical Clock (HLC)` — **on the hub** |
| `docs/sync-protocol.md:411` | "(§ Transaction-Based Change Grouping → Read side)" | `docs/sync.md:207` — **on the hub** |

Neither was a markdown link before the move, so neither is a *broken* link and the gate cannot
see them; both read as same-page pointers that are now off-page. The two page-local ones are
fine: `:191` ("§ Checkpoint presence means partial data below") resolves within the satellite at
`:283`, and `:448` ("the three codes above") is inside its own section.

I left both **verbatim** because the ticket made a byte-identical move an explicit requirement
and verification step, and rewriting prose inside the moved range would have voided the diff
check above. Retargeting them — e.g. `see [Hybrid Logical Clock](sync.md#hybrid-logical-clock-hlc)`
— is a clean, tiny follow-up edit, and a reasonable thing for the reviewer to apply inline now
that the identity check has served its purpose. `:185` sits inside a TypeScript doc-comment in a
fenced block, so it cannot become a markdown link there; it wants prose naming `sync.md`.

The hub's surviving prose does not forward-reference the moved chapter: the only `above`/`below`
after the seam is `docs/sync.md:744`, which means structurally-below-the-transaction-boundary,
not a document position.

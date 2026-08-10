description: The command-line tool can now mark a downloaded plugin as "only run this exact version", refuse to load it if the download changes, and accept a new version deliberately.
files:
  - packages/quereus/src/vtab/manifest.ts (`PluginRecord.pinned`)
  - packages/quoomb-cli/src/plugins/remote-resolver.ts (`setRecordPinnedHashes`, `lookupPin`, `fetchRemoteModuleHash`)
  - packages/quoomb-cli/src/commands/dot-commands.ts (`syncPluginPins`, `syncSavedPluginPins`, `pinPluginCommand`, `unpinPluginCommand`, `trustPluginCommand`, `reportPinViolation`, `installPluginCommand`, `isRemoteUrl`, `reportNotRemote`, `loadEnabledPlugins`)
  - packages/quoomb-cli/src/repl.ts (~line 57)
  - packages/quoomb-cli/src/bin/quoomb.ts (~line 151)
  - packages/quoomb-cli/test/plugin-commands.spec.ts
  - packages/quoomb-cli/test/remote-resolver.spec.ts
  - packages/quoomb-cli/README.md
  - docs/plugins.md (~line 956–962)
difficulty: medium
----

## What shipped

Plugins the quoomb CLI installs from an `https:` URL are re-downloaded and
re-executed on every load. Before this, the CLI recorded the SHA-256 of what it
downloaded and *warned*, after the fact, when that changed. A plugin record can
now opt into refusing instead.

**Default behaviour is unchanged.** A record without `pinned: true` warns exactly
as before, byte for byte.

### Wiring

- `PluginRecord.pinned?: boolean` (`packages/quereus/src/vtab/manifest.ts`),
  meaningful only for `https:` records in a host that installed the Node remote
  resolver. quoomb-web keeps its own record type and is untouched.
- `setRecordPinnedHashes(pins)` in `remote-resolver.ts` replaces a per-URL pin
  table wholesale; `installRemotePluginResolver` passes a private `lookupPin`
  through as the resolver's `expectedHash`, so a mismatch is refused *before* the
  module is written to disk or imported. Keys are normalized with the same
  `normalizeUrlKey` as `lastFetchByUrl`.
- `fetchRemoteModuleHash(url)` wraps the loader's `hashRemoteModule` so the
  Node-only `@quereus/plugin-loader/node` subpath import stays in one file.
- `syncPluginPins(plugins)` in `dot-commands.ts` rebuilds that table from the
  records — called on every path that reaches `dynamicLoadModule` and after every
  mutation that changes pin state, which is what makes `.plugin unpin` take
  effect in the same session.
- `syncSavedPluginPins()` covers the two entry points that load plugins without
  going through the records at all (`repl.ts`, `bin/quoomb.ts`, both immediately
  before `loadPluginsFromConfig`). Without it, a URL pinned by a saved record but
  declared in `quoomb.config.json` would load unverified — and that config load
  is the *only* plugin load in one-shot (`-c` / `-f`) mode.

### Commands

```
  .plugin install <url> [--pin]   Install plugin from URL (--pin: verify before every load)
  .plugin pin <name|url>          Require the recorded hash before loading
  .plugin unpin <name|url>        Go back to warning after the fact
  .plugin trust <name|url> [hash] Record a new expected hash (fetches and hashes when omitted)
```

`.plugin list` prints `pinned sha256 <hash>` under a pinned record.

### Behaviour changes beyond the new commands

- `installPluginCommand` does its already-installed check **before** loading.
  Previously it imported and registered the module and only then reported the
  duplicate, so `.plugin install <pinned url>` could run unpinned bytes.
- A load refused by a pin reports through one helper (`reportPinViolation`) from
  autoload, `enable`, `reload` and `config`'s reload branch: both hashes, the
  URL, and the two remedies (`.plugin trust` / `.plugin unpin`).
- In `loadEnabledPlugins` a pin refusal **does not disable the plugin and saves
  nothing** — the plugin is not broken, and the usual `.plugin enable` hint would
  hit the same pin. Every other failure keeps the previous auto-disable.
- `--pin`, `.plugin pin` and `.plugin trust` all refuse a `file:` plugin with the
  same reason (nothing is downloaded, so there is nothing to verify).

## Review findings

### Checked

- Read the implement diff (`32b60b7a`) before the handoff summary.
- Traced the enforcement path end to end: `syncPluginPins` →
  `setRecordPinnedHashes` → `lookupPin` → the loader's `expectedHash`. Confirmed
  in `packages/plugin-loader/src/node-remote.ts` that the loader trims and
  lowercases the expected value and fails closed on anything that is not 64 hex
  characters, so a hand-edited uppercase digest still enforces correctly and a
  typo cannot silently read as "not pinned".
- Enumerated every `dynamicLoadModule` call site in quoomb-cli (install, enable,
  config-reload, reload, `loadEnabledPlugins`) and confirmed each syncs first;
  the two entry points that reach the loader another way call
  `syncSavedPluginPins`. `src/index.ts` installs the resolver and performs no
  load of its own. **No unsynced load path found.**
- Re-verified the rewritten `reconcilePluginHash` NOTE rather than trusting it:
  pinned + match takes the `fetched === plugin.sha256` early return, pinned +
  mismatch throws before reaching it, and pinned + no recorded hash contributes
  no pin at all, so it records on first load. The claim holds.
- Error unwrapping: `dynamicLoadModule` wraps exactly once with `{ cause }`
  (`plugin-loader.ts:188`), which is what `hashMismatchFrom` assumes.
- Docs: read `docs/plugins.md` (§ pinning and the CLI paragraph at ~1179),
  `packages/quoomb-cli/README.md`, and the `PluginRecord.pinned` JSDoc. All
  reflect the shipped behaviour; README amended for the fix below.
- Endorsed the implementer's flagged scope call (`syncSavedPluginPins` at the two
  config-autoload sites) — it closes a real hole, and one-shot mode has no other
  plugin load. Also endorsed `reportPinViolation` covering four call sites rather
  than one: all four are the same event, and the plainer wording it replaces
  (`Error reloading plugin: Failed to load plugin from …`) offers no remedy.
- File size: `dot-commands.ts` measured at 1,151 lines (`wc -l`), below the
  ~1,800 at which this project has split files before (see
  `debt-emit-source-files-too-large`). Not a ticket — recorded as a tripwire.
- Ran `yarn build`, `yarn lint`, `yarn typecheck`, `yarn test` (all workspaces,
  green), `yarn workspace @quereus/quoomb-cli test` (46 passing), and
  `yarn docs:check`.

### Found and fixed in this pass

- **`.plugin install <file:…> --pin` recorded an unenforceable pin.** `.plugin
  pin` and `.plugin trust` both refuse a `file:` record with a reason, but
  `install --pin` did not: it wrote `pinned: true` on a record no pin can ever
  act on and printed *"the next successful load records one and enforcement
  begins there"*, which is false for a plugin that is never downloaded. The user
  ends up believing they have a guarantee they do not have. Install now refuses
  the whole install (before the load) rather than quietly delivering a weaker
  thing than was asked for. README updated to say all three refuse.
- **DRY:** the two near-identical two-line `Cannot pin/trust … https:` messages
  became one `reportNotRemote(lead, url)`, and `isRemotePlugin(record)` became
  `isRemoteUrl(url)` so `installPluginCommand` (which has no record yet) can use
  it. Three call sites, one wording.

### Test gaps closed (41 → 46 cases)

The implementer's suite covered the resolver level and the record level well.
Five reachable paths had no test:

- pin violation reported through `.plugin enable` (record stays disabled)
- pin violation through `.plugin config` (config change *is* saved, reload
  refused, recorded hash untouched, module never evaluated)
- `.plugin remove` dropping the pin in-session, so the same URL reinstalls
- `--pin` on a `file:` URL refused with nothing installed (the fix above)
- an unrecognized install flag rejected instead of being read as the URL

### Tripwires recorded (conditional; deliberately not tickets)

- `dot-commands.ts:346` — everything from `handlePluginCommand` down is one
  self-contained concern in a 1,151-line file; the NOTE names
  `src/commands/plugin.ts` as the seam if it reaches ~1,800 lines.
- `dot-commands.ts`, install duplicate check — it matches the URL string exactly
  while the pin table is keyed by the normalized href, so
  `https://host:443/p.mjs` installs a second record beside `https://host/p.mjs`
  and shares its pin. Safe direction today; NOTE says to match on the normalized
  form if two records for one fetch ever need to disagree.
- `hashMismatchFrom` — unwraps one `cause` level, matching the loader's single
  wrap. A second wrapping layer would silently degrade every pin refusal to the
  generic message with no test noticing.

### Left standing, with reasons

- **No test drives `repl.ts` or `bin/quoomb.ts`.** This package has no harness
  for either entry point, and building one is a bigger job than the two-line call
  sites justify. `syncSavedPluginPins` itself is tested directly. Not filed:
  `feat-config-declared-plugin-hashes` touches exactly these two sites next.
- **Two pinned records for one URL with different hashes — first entry wins.**
  Deterministic, documented, hand-edit-only. A resolution (strictest wins? refuse
  the load?) is a policy call with no user asking for it.
- **`.plugin trust`'s fetch is separate from the load that follows.** Bytes
  changing in between fail the pinned load closed, which is the right direction
  and matches the loader's own documented contract.
- **A hand-edited `pinned: true` with a malformed `sha256` still auto-disables on
  autoload** (only `PluginHashMismatchError` is carved out). Correctly deferred:
  Arm B of `bug-cli-corrupt-plugins-file-silently-wipes-plugins` owns the general
  auto-disable question and explicitly says the pin carve-out should be folded
  into whatever it lands. Verified that arm exists rather than taking the
  handoff's word for it.

### No new tickets filed

Nothing found rose to a separate ticket: the one real defect was a two-line fix
applied here, and the three remaining concerns are conditional, so they are
tripwires at their code sites instead.

### Pre-existing, not re-reported

- `yarn docs:check` fails on `docs/schema.md`'s word-count ratchet. Already
  listed in `tickets/.pre-existing-known.md` against
  `debt-doc-size-ratchet-red-at-head`. `docs/plugins.md` — the file this ticket
  edits — is not among the flagged ones.
- The implement commit swept `.tmp/quereus-4.6-groupby-join-bug.md` and
  `.tmp/repro-store.mjs` in with it. Root cause is already tracked by
  `debt-gitignore-tmp-scratch-dir`; left untouched, since scratch files may
  belong to another in-flight run.

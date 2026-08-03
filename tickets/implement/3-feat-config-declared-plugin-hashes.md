----
description: Let a project's checked-in settings file state the exact expected contents of each plugin it downloads, so everyone who runs the tool from that project gets the same verified code.
prereq: feat-cli-plugin-pinning
files:
  - packages/plugin-loader/src/config-loader.ts (`PluginConfig`, `validateConfig`, `isValidPluginEntry`)
  - packages/plugin-loader/test/config-loader.spec.ts
  - packages/quoomb-cli/src/plugins/remote-resolver.ts (`setConfigPinnedHashes`)
  - packages/quoomb-cli/src/bin/quoomb.ts (config autoload, ~line 151)
  - packages/quoomb-cli/src/repl.ts (config autoload, ~line 57)
  - packages/quoomb-cli/test/plugin-commands.spec.ts
  - docs/plugins.md
difficulty: easy
----

## Where things stand

`feat-cli-plugin-pinning` lets an individual user pin a plugin they installed
interactively. The other way plugins get loaded is `quoomb.config.json`, read by
both CLI entry points and handed to `loadPluginsFromConfig`. Those entries are not
`PluginRecord`s, carry no hash, and cannot be pinned at all.

That is the case where declaring an expected hash is most useful: a config file
lives in a repository, is reviewed, and is shared by everyone who runs the tool
from that directory. A hash written there means every machine runs the same
bytes.

## What to build

### 1. `sha256` on a config plugin entry

```ts
export interface PluginConfig {
	source: string;
	config?: Record<string, unknown>;
	/**
	 * SHA-256 (hex) the module at `source` must hash to. Enforced before the
	 * module is imported; a mismatch refuses the load. Only applies to `https:`
	 * sources fetched by the Node remote resolver.
	 */
	sha256?: string;
}
```

`validateConfig` / `isValidPluginEntry` accept a string there and reject any
other type, matching how `config` is validated today.

Note that `loadPluginsFromConfig` itself does **not** enforce anything — it lives
in the browser-safe part of the package and has no access to a Node resolver.
Enforcement is the host's, exactly as with plugin records.

### 2. A second pin source in the CLI

`feat-cli-plugin-pinning` leaves the pin lookup private with two sources in mind.
Add the second:

```ts
/**
 * Expected hashes declared in quoomb.config.json. Seeded once per process,
 * before any config plugin loads. Takes precedence over hashes derived from
 * ~/.quoomb/plugins.json: the config file is the explicit, reviewed
 * declaration, and a record hash is only what happened to be served once.
 */
export function setConfigPinnedHashes(pins: Iterable<{ url: string; sha256: string }>): void;
```

Lookup order becomes config → records. When both name the same URL with
*different* hashes, warn once at seed time naming the URL and both values, so a
user is not left wondering why their `.plugin trust` had no effect.

Give the CLI one helper — call it from both `bin/quoomb.ts` and `repl.ts` rather
than duplicating the seeding at each config-autoload site.

### 3. Fail loudly on a hash that cannot be enforced

A config that believes it is pinning but is not is worse than no pin. Both of
these are **hard errors** at seed time, before any plugin loads, naming the
offending entry:

- `sha256` on a source that is not an `https:` URL (an `npm:` spec, a bare
  package name, a `file:` URL). Those never reach the remote resolver, so a hash
  there can never be checked.
- `sha256` that is not 64 hex characters.

The CLI already surfaces config problems at startup; route these the same way.

## Edge cases & interactions

- **Config entry with no `sha256`** → loads exactly as today. Default off.
- **Config entry with a matching hash** → loads normally, no output difference.
- **Config entry with a stale hash** → refused before the module is imported,
  message names both hashes and the URL (the error comes from the loader).
- **`sha256` on an `npm:` / bare-name / `file:` source** → startup error, not a
  silent no-op.
- **Malformed `sha256`** → startup error naming the entry, not a load that fails
  later with a confusing message.
- **Same URL in both the config file and `plugins.json`, hashes disagree** →
  config wins; one warning naming both.
- **Same URL in both, only the config declares a hash** → config's applies.
- **Config seeded but `installRemotePluginResolver` not yet called** → the CLI
  installs the resolver at both entry points before any load; keep the seeding
  after that, and make the ordering explicit rather than incidental.
- **A config load failure must not take down the record autoload** — `repl.ts`
  already wraps the config path in its own try/catch and runs
  `loadEnabledPlugins` separately. Keep that separation: a bad config pin should
  not silently skip the user's installed plugins.
- **Env-var interpolation runs first** (`interpolateConfigEnvVars`), so a
  `${PLUGIN_SHA}` placeholder in `sha256` resolves before validation. Seed from
  the interpolated config, not the raw one.

## TODO

- Add `sha256?: string` to `PluginConfig`; accept/validate it in
  `isValidPluginEntry`.
- Add `setConfigPinnedHashes` to the CLI's `remote-resolver.ts`; make the private
  pin lookup consult config before records, warning once on a conflict.
- Add a single CLI helper that validates and seeds config pins from an
  interpolated `QuoombConfig`, and call it from `bin/quoomb.ts` and `repl.ts`
  before `loadPluginsFromConfig`.
- Reject a non-`https:` source carrying a hash, and a malformed hash, as startup
  errors.
- Extend `packages/plugin-loader/test/config-loader.spec.ts`: `sha256` accepted
  as a string, rejected when it is a number/object, and round-tripped through
  `interpolateConfigEnvVars`.
- Extend `packages/quoomb-cli/test/plugin-commands.spec.ts`: config-declared hash
  matching (loads) and mismatching (refused before import); config hash beating a
  disagreeing record hash; the two startup-error cases.
- Update `docs/plugins.md` config section with the field and the
  https-sources-only rule.
- `yarn workspace @quereus/plugin-loader test`,
  `yarn workspace @quereus/quoomb-cli test`, then root `yarn build` and
  `yarn typecheck`.

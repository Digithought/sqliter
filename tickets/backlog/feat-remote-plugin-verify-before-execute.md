----
description: When a plugin is loaded from a web address, the tool checks whether the downloaded code changed since it was installed only after it has already run that code, so the check can warn but can never stop bad code. Give users a way to require the code match what they approved before it runs.
files:
  - packages/plugin-loader/src/node-remote.ts (`createNodeRemoteResolver`, `NodeRemoteResolverOptions.onFetched`)
  - packages/plugin-loader/src/plugin-loader.ts (`RemoteModuleResolver`, `resolveImportSpecifier`)
  - packages/quoomb-cli/src/plugins/remote-resolver.ts
  - packages/quoomb-cli/src/commands/dot-commands.ts (`reconcilePluginHash`)
  - packages/quereus/src/vtab/manifest.ts (`PluginRecord.sha256`)
difficulty: medium
----

## Where things stand

Loading a plugin from an `https:` URL under Node works by downloading the module
to a temporary file first. The downloader records a SHA-256 of the bytes it got.
The CLI stores that hash on the plugin record when the plugin is installed, and on
later loads compares the two and prints a warning when they differ — remote code
served from a stable URL has changed since the user approved it.

The warning is real and useful, but it happens *after* the fact. The comparison
lives in the CLI's plugin commands, which run once `dynamicLoadModule` has
returned — by which point the module has been imported and its registration
function has already executed. There is nothing left to prevent. It is a change
notice, not a safeguard.

There is also no on-disk cache: every start of the CLI re-downloads and
re-executes each saved remote plugin. So the window is not a one-off at install
time; it is every single start.

## What to build

A way for a host to state, up front, what it expects a remote plugin's bytes to
hash to, and to have the load refused before the module is imported when they do
not match.

The seam for this already exists. The downloader calls an `onFetched` callback and
awaits it before importing, so a rejection there aborts the load. What is missing
is the host telling the downloader which URL is expected to hash to what, so the
comparison can happen inside that callback instead of after the load. That means a
per-URL expected-hash channel available at fetch time, alongside (or derived from)
the saved plugin records.

Requirements:

- A host can supply an expected hash per plugin URL, and a mismatch aborts the
  load with a message naming both hashes and the URL. Nothing from the module runs.
- Enforcement is opt-in and off by default. Warn-and-continue stays the default
  behavior, so an unpinned setup keeps working exactly as it does today.
- The user can accept a new version deliberately — reinstalling, reloading, or an
  explicit "trust this hash" action updates the recorded hash.
- A record with no recorded hash is not a mismatch; it is a first observation.
- Worth deciding as part of this: whether the CLI should offer to pin (verify
  before execute) as a per-plugin setting, and whether an on-disk cache of the
  verified bytes should replace the per-start re-download.

## Why it is not urgent

Nothing regressed; before this the CLI could not load remote plugins at all. And
installing a plugin from a URL is already an explicit act of trusting that URL.
The gap matters for the case the current warning was written for and cannot
actually cover: a URL that was trustworthy when installed and is not anymore.

----
description: In the browser, a plugin downloaded from a web address is run without any check that it is the version the user approved — the same check the command-line tool can now make. Give the browser one too.
files:
  - packages/plugin-loader/src/plugin-loader.ts (`resolveImportSpecifier` — the browser/worker branch)
  - packages/plugin-loader/src/node-remote.ts (the Node resolver, for the behavior to mirror)
  - packages/quoomb-web/src/worker/quereus.worker.ts (`loadModule`)
  - packages/plugin-loader/README.md, docs/plugins.md
difficulty: medium
----

## What is missing

A Quereus host can load a plugin from an `https:` URL. Under Node, the host
installs a resolver that downloads the module, hashes it, and — since
`feat-plugin-loader-hash-pinning` — can refuse to run it when the bytes do not
match a SHA-256 the host recorded earlier. Nothing runs before that check.

In a browser or a Web Worker there is no resolver. `import('https://…')` works
natively, so the loader hands the URL straight to the runtime and the remote code
evaluates immediately. There is no download step to hook, no hash, and no way to
say "only this version".

That is the state today in quoomb-web: `quereus.worker.ts`'s `loadModule` calls
`dynamicLoadModule` with the URL and the plugin runs. The web app's own plugin
records carry no hash at all, so there is nothing to compare against even if
there were a hook.

## Why it matters

The remote URL is re-fetched on every load. Whoever controls that URL controls
what executes, on every start, with whatever the plugin is allowed to do. Node
hosts can now pin against that; browser hosts cannot. A user who pins a plugin in
the CLI and opens the same plugin in the web UI gets a materially weaker
guarantee, and nothing in the product says so at the point of use — only the
developer docs mention it.

## Expected behavior

- A browser host can supply the same kind of "what should this URL hash to?"
  answer the Node host supplies, and a mismatch stops the load before the plugin
  evaluates.
- Unpinned loads keep working exactly as they do now. Verification is opt-in;
  hosts that ask nothing get today's behavior.
- A refused load surfaces the same failure a Node host sees, so a shared UI can
  report it the same way — the URL, the expected digest, the served digest, and
  the fact that nothing ran.
- A host that does verify can also ask "what does this URL serve right now?"
  without running it, so a user can look at a changed version and accept it
  deliberately.

## What makes this different from the Node case

Native `import('https://…')` gives no seam: by the time the runtime has the
bytes, it has already evaluated them. Verification therefore requires the browser
path to stop using the native import for URLs it wants to check — fetching the
module itself, hashing it, and importing the verified bytes through some other
specifier. Whatever mechanism is chosen has consequences worth settling before
building:

- Relative imports inside a fetched module no longer resolve against the original
  URL, so a plugin with more than one file may stop loading. (The Node resolver
  already has this limitation; the browser does not, so this would be a
  regression there for anyone relying on it.)
- Same-origin and CORS rules apply to a `fetch` that did not apply to a module
  import, so some URLs that load today may fail to fetch.
- Whatever holds the fetched bytes needs a lifetime story, so a long session
  reloading plugins does not accumulate them.

A plausible shape is "fetch, hash, verify, then import the verified bytes", but
the cost above is real and the decision of whether verified loads should be the
default or strictly opt-in belongs to whoever picks this up.

## Out of scope

- Anything about where the expected hashes come from in the web UI (records,
  config, a trust prompt). This ticket is about the loader having a check at all.
- The Node side, which is done.
- `packages/quoomb-cli`, covered by `feat-cli-plugin-pinning`.

## Related

- `feat-plugin-loader-hash-pinning` — the Node-side verification this mirrors.
- `feat-cli-plugin-pinning` — wires the CLI's saved hashes into it. It states
  explicitly that quoomb-web is untouched, which is what leaves this gap open.
- `feat-config-declared-plugin-hashes` — a `quoomb.config.json` plugin entry can
  now carry a `sha256`, and the *same config file* is what quoomb-web loads
  plugins from. The web app cannot check it, so those hashes are inert there.
  Its review added a startup `console.warn`
  (`packages/quoomb-web/src/stores/session/plugins.ts`, `loadEnabledPlugins`)
  naming the entries whose hashes are not being enforced — a stopgap so the
  silence is not mistaken for verification, not a substitute for this ticket.
  Whoever picks this up should feed those config-declared hashes into the check
  and drop the warning.

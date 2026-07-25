description: Installing a plugin from a web address in the command-line tool always fails, even though the tool accepts the address as valid — Node.js cannot import code straight from the web.
files:
  - packages/quoomb-cli/src/commands/dot-commands.ts (`.plugin install` / `.plugin load` — calls validatePluginUrl then dynamicLoadModule)
  - packages/plugin-loader/src/plugin-loader.ts (`validatePluginUrl`, `dynamicLoadModule`, `ALLOWED_PLUGIN_PROTOCOLS`)
  - packages/quoomb-web/src/worker/quereus.worker.ts (browser caller — works today, must keep working)
  - docs/plugins.md (§ Installation & loading — now documents the limitation)
difficulty: medium
----

## Symptom

In the CLI:

```
.plugin install https://example.com/plugin.js
```

prints `Installing plugin from https://example.com/plugin.js...` and then fails
with:

```
Failed to load plugin from https://example.com/plugin.js: Only URLs with a
scheme in: file and data are supported by the default ESM loader.
Received protocol 'https:'
```

The address passes `validatePluginUrl` (https + `.js` is explicitly allowed, and
the CLI's own rejection message advertises `https://` as a supported form), so
the user is told the address is fine right before the load fails for a reason
that has nothing to do with their input.

## Why

`dynamicLoadModule` loads modules with a dynamic `import()`. Node's ESM loader
only accepts `file:` and `data:` URLs — importing over the network was an
experimental flag (`--experimental-network-imports`) and has since been removed.
Verified on Node v24.2.0: `import('https://example.com/plugin.js')` throws
`ERR_UNSUPPORTED_ESM_URL_SCHEME`.

In a browser, `import('https://…')` works normally, so the web UI's worker path
(`quereus.worker.ts`) is unaffected. The capability gap is Node-only, and it has
presumably been broken for as long as the CLI has had `.plugin install`.

## Expected behaviour

Pick one; both are defensible and the choice belongs with this ticket:

1. **Support it** — in Node, fetch the module over https, write it to a temp file
   (or otherwise materialise it locally), then import that file. This is what a
   user typing `.plugin install <url>` expects. It needs decisions on where the
   file lands (cache dir vs. temp), whether it is re-fetched per run, integrity
   checking, and the fact that fetching-then-executing remote code should be an
   explicit, visible step rather than a silent one.
2. **Refuse it early and clearly** — make the Node path reject `https:` up front
   with a message that says *why* and what to do instead (install the npm
   package, or point at a local `file://` module), and stop advertising
   `https://` as valid in the CLI's usage text.

Either way the outcome must be: the CLI never accepts an address it cannot act
on, and the browser path keeps working unchanged.

## Notes

- `validatePluginUrl` is shared by both environments, so any environment-specific
  narrowing has to be parameterised rather than hard-coded — the web UI still
  needs `https:` to validate.
- `docs/plugins.md` § Installation & loading and `packages/plugin-loader/README.md`
  now state the limitation as it currently stands. Update them with whichever
  behaviour lands.
- No test covers an `https:` module load in `@quereus/plugin-loader`, and one
  cannot exist under Node for the current code — that gap is a symptom of this
  bug, not an independent one.

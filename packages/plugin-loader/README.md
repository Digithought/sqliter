# @quereus/plugin-loader

> **Stability: Stable** — the exported API keeps its shape across minor and patch
> releases. See [Stability Tiers](../../docs/stability.md#tiers).

Plugin loading system for Quereus. This package provides dynamic module loading capabilities for extending Quereus with custom virtual tables, functions, collations, and types.

**Note:** This package uses dynamic `import()` which is not compatible with React Native. For React Native environments, use static imports and manual plugin registration instead.

## Installation

```bash
npm install @quereus/plugin-loader
# or
yarn add @quereus/plugin-loader
```

## Usage

```typescript
import { Database } from '@quereus/quereus';
import { loadPlugin, dynamicLoadModule } from '@quereus/plugin-loader';

const db = new Database();

// Load from npm package (Node.js)
await loadPlugin('npm:@acme/quereus-plugin-foo@^1', db, { api_key: '...' });

// Load from an https:// URL. Native in the browser; Node needs the resolver below.
await dynamicLoadModule('https://example.com/plugin.js', db, { timeout: 10000 });

// Load from a local file (Node.js)
await dynamicLoadModule('file:///path/to/plugin.mjs', db, { timeout: 10000 });

// Browser with CDN (opt-in)
await loadPlugin('npm:@acme/quereus-plugin-foo@^1', db, {}, { allowCdn: true });
```

## Loading plugins over `https:` in Node

Browsers implement `import('https://…')`; Node's ESM loader does not — it accepts
only `file:` and `data:` URLs. A Node host that wants remote plugins installs the
resolver from the `./node` subpath once at startup:

```typescript
import { installNodeRemoteModuleResolver } from '@quereus/plugin-loader/node';

installNodeRemoteModuleResolver({
  // The SHA-256 this URL must serve, or undefined to leave it unpinned.
  // Consulted on every fetch; asked with the normalized URL.
  expectedHash: url => myPluginRecords.get(url)?.sha256,
  // Awaited after each fetch, before the module is imported.
  onFetched: ({ url, sha256, bytes }) => console.log(`Fetched ${url} (${bytes} B, sha256 ${sha256})`),
  maxBytes: 5 * 1024 * 1024,   // default
});
```

The resolver fetches the module, refuses a redirect that leaves `https:`, enforces
the size cap, SHA-256s the bytes, checks them against `expectedHash`, writes them
to a temp file, and hands the loader that file's `file:` URL. Temp files live for
the life of the process (so plugin stack traces resolve) and the directory is
removed at exit.

**Verification is opt-in and Node-only.** With no `expectedHash`, or when it
returns `undefined`, the load proceeds exactly as before. When it returns a
digest that the fetched bytes do not match, the load fails with a
`PluginHashMismatchError` (exported from the package index) *before* anything is
written to disk, `onFetched` fires, or the module is imported — so the rejected
code never runs. An `expectedHash` that returns something other than 64 hex
characters is treated as a host bug and fails the load rather than being read as
"unpinned". Browsers and workers install no resolver at all — they
`import('https://…')` natively, with no hash check — so a host must not describe
pinning as a universal guarantee. Nor does it cover `file:` URLs, which never
reach the resolver.

`dynamicLoadModule` wraps loader failures, so callers test the wrapped error's
`cause`:

```typescript
import { dynamicLoadModule, PluginHashMismatchError } from '@quereus/plugin-loader';

try {
  await dynamicLoadModule(url, db);
} catch (error) {
  if ((error as Error).cause instanceof PluginHashMismatchError) { /* pin failed */ }
}
```

To find out what a URL serves *now* — to adopt a new version deliberately —
`hashRemoteModule` (also from `./node`) runs the same fetch, redirect check, and
size cap, but writes nothing and imports nothing. It is a separate fetch from the
load that follows it, so a change in between makes the pinned load fail; that
fails closed, which is the direction you want.

Nothing is cached on disk: each load re-downloads and re-executes the remote
module, so hosts should use `onFetched` to make that visible. See
[Plugin System Documentation](https://github.com/gotchoices/quereus/blob/main/docs/plugins.md)
for the full picture.

## React Native

This package is **not compatible** with React Native due to its use of dynamic `import()`. For React Native apps:

1. Exclude this package from your dependencies
2. Use static imports for plugins
3. Manually register plugins with the database

Example for React Native:

```typescript
import { Database } from '@quereus/quereus';
import myPlugin from './plugins/my-plugin';

const db = new Database();

// Manually register the plugin
const registrations = await myPlugin(db, { /* config */ });

// Register vtables
if (registrations.vtables) {
  for (const vtable of registrations.vtables) {
    db.registerModule(vtable.name, vtable.module, vtable.auxData);
  }
}

// Register functions, collations, types similarly...
```

## API

See the [Plugin System Documentation](https://github.com/gotchoices/quereus/blob/main/docs/plugins.md) for complete details.

## License

MIT


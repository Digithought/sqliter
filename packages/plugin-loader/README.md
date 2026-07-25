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

// Load from an https:// URL (Browser only — Node's ESM loader rejects https:)
await dynamicLoadModule('https://example.com/plugin.js', db, { timeout: 10000 });

// Load from a local file (Node.js)
await dynamicLoadModule('file:///path/to/plugin.mjs', db, { timeout: 10000 });

// Browser with CDN (opt-in)
await loadPlugin('npm:@acme/quereus-plugin-foo@^1', db, {}, { allowCdn: true });
```

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


# Quereus SQL VS Code Extension

> **Stability: Beta** — complete and tested, but the surface is still being shaped; a
> breaking change may land in a minor release. See
> [Stability Tiers](../../docs/stability.md#tiers).

Provides language support for Quereus SQL in VS Code:

- Syntax highlighting (TextMate + semantic tokens)
- Diagnostics (syntax errors via Quereus parser)
- Completions for keywords, functions, tables, and columns
- Hover (placeholder)

## Development

- Build: `yarn workspace quereus-vscode build` (auto-builds `@quereus/quereus`)

Manual steps:

```
yarn workspace @quereus/quereus build
yarn workspace quereus-vscode build
yarn workspace quereus-vscode package
```

- Launch: Open this folder in VS Code, run the "Run Extension" launch config.

## Schema awareness

The server hoists an in-memory `Database` instance to read currently-known tables/functions. Future enhancements can connect to a running app and sync schema.

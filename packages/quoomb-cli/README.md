# quoomb-cli

> **Stability: Beta** — complete and tested, but the surface is still being shaped; a
> breaking change may land in a minor release. See
> [Stability Tiers](../../docs/stability.md#tiers).

Command-line interface for [Quereus](https://github.com/gotchoices/quereus) — an interactive SQL shell and file execution tool.

## Installation

```bash
npm install -g quoomb-cli
# or run directly with npx
npx quoomb
```

## Usage

### Interactive Mode

```bash
# Start REPL with in-memory database
quoomb

# Start with persistent database
quoomb --store ./data

# Connect to sync coordinator
quoomb --sync http://localhost:3000/sync
```

### Execute SQL Files

```bash
# Run a SQL file
quoomb script.sql

# Run with persistent storage
quoomb --store ./data script.sql

# Run multiple files
quoomb schema.sql data.sql queries.sql
```

### Pipe SQL from stdin

```bash
echo "SELECT 1 + 1 as result" | quoomb

cat queries.sql | quoomb --store ./data
```

## Commands

In interactive mode, use dot-commands for meta operations:

| Command | Description |
|---------|-------------|
| `.help` | List these commands |
| `.tables` | List all tables and views |
| `.schema [table]` | Show table schema (all DDL when no table is given) |
| `.import <file.csv>` | Import a CSV file as a table named after the file |
| `.export <sql> <file>` | Run a query and write the rows to `.json` or `.csv` |
| `.plugin <subcommand>` | Manage plugins — see below |
| `.exit`, `.quit` | Exit the REPL |

### Plugin commands

| Command | Description |
|---------|-------------|
| `.plugin install <url>` | Install a plugin from an `https:` or `file:` module URL |
| `.plugin list` | List installed plugins, with their name, version and URL |
| `.plugin enable <name\|url>` | Enable and load a plugin |
| `.plugin disable <name\|url>` | Disable a plugin (unloaded on next start) |
| `.plugin remove <name\|url>` | Forget a plugin entirely |
| `.plugin config <name\|url> [key=value ...]` | Show or set the plugin's settings |
| `.plugin reload <name\|url>` | Re-fetch and re-register a plugin |

Installed plugins live in `~/.quoomb/plugins.json` and enabled ones load at startup.

A plugin's name comes from the `package.json` next to its module. Many hosting
layouts have no such file — a lone `.mjs` on a static host, a raw file URL, a
gist — so a plugin without one is named after the last segment of its URL
(`https://example.com/dist/plain.mjs` → `plain`). Whichever name `.plugin list`
shows is the one the other subcommands accept, and the install URL always works
as an identifier too. If two plugins end up sharing a derived name, the
subcommands say so and ask for a URL rather than guessing.

## Options

| Option | Description |
|--------|-------------|
| `--store <path>` | Use persistent LevelDB storage |
| `--sync <url>` | Connect to sync coordinator |
| `--format <mode>` | Output format: table, json, csv |
| `--no-header` | Omit column headers in output |
| `--help` | Show help |
| `--version` | Show version |

## Examples

```bash
# Create a table and insert data
$ quoomb
quereus> CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);
quereus> INSERT INTO users VALUES (1, 'Alice'), (2, 'Bob');
quereus> SELECT * FROM users;
┌────┬───────┐
│ id │ name  │
├────┼───────┤
│  1 │ Alice │
│  2 │ Bob   │
└────┴───────┘
quereus> .quit

# JSON output for scripting
$ echo "SELECT * FROM users" | quoomb --store ./data --format json
[{"id":1,"name":"Alice"},{"id":2,"name":"Bob"}]

# CSV export
$ quoomb --store ./data --format csv -c "SELECT * FROM users" > users.csv
```

## Frameworks/plugins

The CLI automatically loads:
- `@quereus/plugin-indexeddb` - Persistent storage with IndexedDB
- `@quereus/sync` - CRDT sync (when `--sync` is provided)

## Related Packages

- [`quereus`](../quereus/) - Core SQL engine
- [`@quereus/store`](../quereus-store/) - Storage plugin
- [`@quereus/sync-coordinator`](../sync-coordinator/) - Server for sync

## License

MIT


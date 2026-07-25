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
| `.tables` | List all tables |
| `.schema [table]` | Show table schema |
| `.indexes [table]` | List indexes |
| `.mode [mode]` | Output mode: table, json, csv, line |
| `.output [file]` | Send output to file |
| `.read [file]` | Execute SQL from file |
| `.quit` | Exit the REPL |

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


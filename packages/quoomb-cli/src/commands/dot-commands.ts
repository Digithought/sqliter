import { Database, quoteIdentifier } from '@quereus/quereus';
import chalk from 'chalk';
import Table from 'cli-table3';
import * as fs from 'fs/promises';
import * as path from 'path';
import Papa from 'papaparse';
import { dynamicLoadModule, validatePluginUrl, PluginHashMismatchError } from '@quereus/plugin-loader';
import type { PluginRecord, PluginSetting } from '@quereus/plugin-loader';
import { fetchRemoteModuleHash, getLastFetchedHash, setRecordPinnedHashes } from '../plugins/remote-resolver.js';
import type { SqlValue } from '@quereus/quereus';
import type { Interface as ReadlineInterface } from 'node:readline';
import os from 'os';
import crypto from 'crypto';

/** A parsed CSV row: header → cell value (papaparse coerces numeric cells). */
type CsvRow = Record<string, string | number | null>;

export class DotCommands {
  constructor(private db: Database) {}

  async handle(command: string, rl: ReadlineInterface): Promise<boolean> {
    const parts = command.slice(1).split(/\s+/);
    const cmd = parts[0];
    const args = parts.slice(1);

    switch (cmd) {
      case 'help':
        this.printHelp();
        break;
      case 'exit':
      case 'quit':
        rl.close();
        break;
      case 'tables':
        await this.listTables();
        break;
      case 'schema':
        await this.showSchema(args[0]);
        break;
      case 'import':
        await this.importCsv(args[0]);
        break;
      case 'export':
        await this.exportQuery(args[0], args[1]);
        break;
      default:
        return false; // Command not handled
    }
    return true; // Command was handled
  }

  private printHelp(): void {
    console.log(`
Available commands:
  .help                    Show this help message
  .exit, .quit             Exit the REPL
  .tables                  List all tables
  .schema [table]          Show table schema
  .import <file.csv>       Import CSV file as table
  .export <sql> <file>     Export query results to file

Plugin commands:
${PLUGIN_HELP_LINES.join('\n')}

SQL commands:
  Enter any SQL statement to execute it

Examples:
  CREATE TABLE users (id INTEGER, name TEXT);
  INSERT INTO users VALUES (1, 'Alice');
  SELECT * FROM users;
  .import data.csv
  .export "SELECT * FROM users" output.json
`);
  }

  async listTables(): Promise<void> {
    try {
      const results = [];
      for await (const row of this.db.eval(`
        SELECT name, type FROM schema()
        WHERE type IN ('table', 'view')
        ORDER BY name
      `)) {
        results.push(row);
      }

      if (results.length === 0) {
        console.log(chalk.yellow('No tables found'));
        return;
      }

      const table = new Table({
        head: [chalk.cyan('Name'), chalk.cyan('Type')]
      });

      for (const row of results) {
        table.push([String(row.name || ''), String(row.type || '')]);
      }

      console.log(table.toString());
      console.log(chalk.gray(`\n${results.length} table(s)`));
    } catch (error) {
      console.error(chalk.red('Error listing tables:'), error instanceof Error ? error.message : String(error));
    }
  }

  async showSchema(tableName?: string): Promise<void> {
    try {
      if (!tableName) {
        // Show all schemas
        const results = [];
        // schema() also emits a row per built-in function (sql = its signature);
        // `.schema` is a DDL dump (tables/views/indexes, like sqlite's .schema),
        // so exclude functions or the output is drowned in FUNCTION lines.
        for await (const row of this.db.eval(`
          SELECT sql FROM schema()
          WHERE sql IS NOT NULL AND type <> 'function'
          ORDER BY name
        `)) {
          results.push(row);
        }

        if (results.length === 0) {
          console.log(chalk.yellow('No schema found'));
          return;
        }

        for (const row of results) {
          console.log(chalk.white(String(row.sql) + ';'));
        }
      } else {
        // Show specific table schema
        const results = [];
        for await (const row of this.db.eval(`
          SELECT sql FROM schema()
          WHERE name = ? AND sql IS NOT NULL
        `, [tableName])) {
          results.push(row);
        }

        if (results.length === 0) {
          console.log(chalk.yellow(`Table '${tableName}' not found`));
          return;
        }

        console.log(chalk.white(String(results[0].sql) + ';'));

        // Also show column info. `table_info` is a table-valued function taking
        // the table name as a *string* argument, so bind it as a parameter rather
        // than interpolating the identifier into the SQL text (injection-shaped).
        const columns = [];
        for await (const row of this.db.eval(
          `select cid, name, type, notnull, dflt_value, pk from table_info(?)`,
          [tableName]
        )) {
          columns.push(row);
        }

        if (columns.length > 0) {
          console.log(chalk.gray('\nColumns:'));
          const table = new Table({
            head: [chalk.cyan('Name'), chalk.cyan('Type'), chalk.cyan('NotNull'), chalk.cyan('Default'), chalk.cyan('PK')]
          });

          for (const col of columns) {
            table.push([
              String(col.name || ''),
              String(col.type || 'TEXT'),
              col.notnull ? 'YES' : 'NO',
              String(col.dflt_value || ''),
              col.pk ? 'YES' : 'NO'
            ]);
          }

          console.log(table.toString());
        }
      }
    } catch (error) {
      console.error(chalk.red('Error showing schema:'), error instanceof Error ? error.message : String(error));
    }
  }

  async importCsv(filePath: string): Promise<void> {
    if (!filePath) {
      console.log(chalk.red('Please specify a CSV file path'));
      return;
    }

    try {
      const resolvedPath = path.resolve(filePath);
      const fileContent = await fs.readFile(resolvedPath, 'utf-8');

      // Parse CSV
      const parseResult = Papa.parse(fileContent, {
        header: true,
        skipEmptyLines: true,
        transform: (value, _field) => {
          // Try to convert numbers
          if (value === '') return null;
          const num = Number(value);
          if (!isNaN(num) && value === num.toString()) {
            return num;
          }
          return value;
        }
      });

      if (parseResult.errors.length > 0) {
        console.log(chalk.red('CSV parsing errors:'));
        parseResult.errors.forEach(error => {
          console.log(chalk.red(`  Line ${error.row}: ${error.message}`));
        });
        return;
      }

      if (parseResult.data.length === 0) {
        console.log(chalk.yellow('No data found in CSV file'));
        return;
      }

      // Generate table name from file name
      const tableName = path.basename(filePath, path.extname(filePath))
        .replace(/[^a-zA-Z0-9_]/g, '_')
        .replace(/^[0-9]/, '_$&'); // Ensure it doesn't start with a number

      // Infer column types from data
      const rows = parseResult.data as CsvRow[];
      const firstRow = rows[0];
      const columns = Object.keys(firstRow).map(col => {
        const sampleValues = rows.slice(0, 10).map(row => row[col]);
        const hasNumbers = sampleValues.some(val => typeof val === 'number');
        const hasStrings = sampleValues.some(val => typeof val === 'string' && val !== '');

        let type = 'TEXT';
        if (hasNumbers && !hasStrings) {
          type = 'REAL';
        } else if (hasNumbers) {
          type = 'TEXT'; // Mixed, so use TEXT
        }

        // quoteIdentifier escapes embedded quotes; a CSV header could contain any character.
        return `${quoteIdentifier(col)} ${type}`;
      });

      // Create table
      const createSql = `CREATE TABLE ${quoteIdentifier(tableName)} (${columns.join(', ')})`;
      await this.db.exec(createSql);

      console.log(chalk.green(`Created table: ${tableName}`));

      // Insert data
      const columnNames = Object.keys(firstRow);
      const placeholders = columnNames.map(() => '?').join(', ');
      const insertSql = `INSERT INTO ${quoteIdentifier(tableName)} (${columnNames.map(c => quoteIdentifier(c)).join(', ')}) VALUES (${placeholders})`;

      const stmt = this.db.prepare(insertSql);
      let insertCount = 0;

      try {
        for (const row of rows) {
          const values = columnNames.map(col => row[col]);
          await stmt.run(values);
          insertCount++;
        }
      } finally {
        await stmt.finalize();
      }

      console.log(chalk.green(`Imported ${insertCount} rows into table '${tableName}'`));
    } catch (error) {
      console.error(chalk.red('Error importing CSV:'), error instanceof Error ? error.message : String(error));
    }
  }

  async exportQuery(sql: string, outputPath: string): Promise<void> {
    if (!sql || !outputPath) {
      console.log(chalk.red('Please specify both SQL query and output file path'));
      console.log(chalk.gray('Usage: .export "SELECT * FROM table" output.json'));
      return;
    }

    try {
      const results = [];
      for await (const row of this.db.eval(sql)) {
        results.push(row);
      }

      const resolvedPath = path.resolve(outputPath);
      const ext = path.extname(resolvedPath).toLowerCase();

      if (ext === '.json') {
        await fs.writeFile(resolvedPath, JSON.stringify(results, null, 2), 'utf-8');
      } else if (ext === '.csv') {
        if (results.length === 0) {
          await fs.writeFile(resolvedPath, '', 'utf-8');
        } else {
          const csv = Papa.unparse(results);
          await fs.writeFile(resolvedPath, csv, 'utf-8');
        }
      } else {
        // Default to JSON
        await fs.writeFile(resolvedPath, JSON.stringify(results, null, 2), 'utf-8');
      }

      console.log(chalk.green(`Exported ${results.length} rows to '${outputPath}'`));
    } catch (error) {
      console.error(chalk.red('Error exporting query:'), error instanceof Error ? error.message : String(error));
    }
  }
}

export const handleDotCommand = async (
  line: string,
  db: Database,
  _readlineInterface: ReadlineInterface
): Promise<boolean> => {
  // ... existing commands ...

  if (line.startsWith('.plugin')) {
    await handlePluginCommand(line, db);
    return true;
  }

  // ... rest of existing code ...

  // Return false for unhandled commands
  return false;
};

/** `.plugin` usage, shown by both `.help` and a bare/unrecognized `.plugin`. */
const PLUGIN_HELP_LINES = [
  '  .plugin install <url> [--pin]   Install plugin from URL (--pin: verify before every load)',
  '  .plugin list                    List installed plugins',
  '  .plugin enable <name|url>       Enable a plugin',
  '  .plugin disable <name|url>      Disable a plugin',
  '  .plugin remove <name|url>       Remove a plugin',
  '  .plugin config <name|url>       Configure a plugin',
  '  .plugin reload <name|url>       Reload a plugin',
  '  .plugin pin <name|url>          Require the recorded hash before loading',
  '  .plugin unpin <name|url>        Go back to warning after the fact',
  '  .plugin trust <name|url> [hash] Record a new expected hash (fetches and hashes when omitted)',
  '  <name> is whatever `.plugin list` shows; the install URL works too.',
];

const handlePluginCommand = async (line: string, db: Database): Promise<void> => {
  const args = line.split(/\s+/).slice(1);
  const subcommand = args[0];

  switch (subcommand) {
    case 'install':
      await installPluginCommand(args.slice(1), db);
      break;
    case 'list':
      await listPluginsCommand();
      break;
    case 'enable':
      await enablePluginCommand(args.slice(1), db);
      break;
    case 'disable':
      await disablePluginCommand(args.slice(1));
      break;
    case 'remove':
      await removePluginCommand(args.slice(1));
      break;
    case 'config':
      await configPluginCommand(args.slice(1), db);
      break;
    case 'reload':
      await reloadPluginCommand(args.slice(1), db);
      break;
    case 'pin':
      await pinPluginCommand(args.slice(1));
      break;
    case 'unpin':
      await unpinPluginCommand(args.slice(1));
      break;
    case 'trust':
      await trustPluginCommand(args.slice(1));
      break;
    default:
      console.log('Plugin management commands:');
      console.log(PLUGIN_HELP_LINES.join('\n'));
      break;
  }
};

const getPluginsFilePath = (): string => {
  const homeDir = os.homedir();
  const configDir = path.join(homeDir, '.quoomb');
  return path.join(configDir, 'plugins.json');
};

const loadPlugins = async (): Promise<PluginRecord[]> => {
  try {
    const filePath = getPluginsFilePath();
    const data = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    // File doesn't exist or is invalid, return empty array
    return [];
  }
};

// NOTE: every subcommand read-modify-writes the whole file, so two CLI sessions
// running side by side can have the later save drop the earlier one's change.
// Harmless for one interactive user; if plugin state ever gets written from
// anything concurrent, this needs a merge on the record `id` or a lock file.
const savePlugins = async (plugins: PluginRecord[]): Promise<void> => {
  const filePath = getPluginsFilePath();
  const configDir = path.dirname(filePath);

  // Ensure config directory exists
  try {
    await fs.mkdir(configDir, { recursive: true });
  } catch (error) {
    // Directory already exists
  }

  await fs.writeFile(filePath, JSON.stringify(plugins, null, 2));
};

/**
 * Derives a display name from a plugin's URL for when no manifest was
 * available to name it (e.g. package.json 404s beside the module).
 * Falls back to the full URL if it cannot be parsed into segments.
 */
const deriveNameFromUrl = (url: string): string => {
  try {
    const { pathname, hostname } = new URL(url);
    const segments = pathname.split('/').filter(Boolean);
    const last = segments[segments.length - 1] || hostname;
    return last.replace(/\.m?js$/i, '');
  } catch {
    return url;
  }
};

/**
 * The identifier `.plugin list` prints and every other `.plugin` subcommand
 * accepts: the manifest name when one loaded, otherwise a name derived from
 * the URL so a manifest-less plugin is still addressable.
 *
 * A manifest name containing whitespace cannot be used — `.plugin <sub> <name>`
 * splits its arguments on whitespace, so such a name is not typeable. That is
 * reachable: a package.json without a `name` field manifests as the loader's
 * `'Unknown Plugin'` placeholder. Derive from the URL in that case too.
 */
const displayName = (plugin: PluginRecord): string => {
  const manifestName = plugin.manifest?.name;
  return manifestName && !/\s/.test(manifestName) ? manifestName : deriveNameFromUrl(plugin.url);
};

/**
 * Resolves a user-typed identifier — a display name, or the exact URL `list`
 * prints — to a single installed plugin, reporting not-found and ambiguity
 * itself so every subcommand words them the same way.
 */
const resolvePlugin = (plugins: PluginRecord[], identifier: string): PluginRecord | undefined => {
  const byUrl = plugins.find(p => p.url === identifier);
  if (byUrl) {
    return byUrl;
  }

  const byName = plugins.filter(p => displayName(p) === identifier);
  if (byName.length === 0) {
    console.log(`Plugin '${identifier}' not found`);
    return undefined;
  }

  // Two manifest-less plugins whose URLs end in the same file name derive the
  // same display name. Acting on whichever installed first would be a guess,
  // and for `remove` a destructive one.
  if (byName.length > 1) {
    console.log(`Plugin name '${identifier}' is ambiguous — ${byName.length} installed plugins go by it. Pass one of these URLs instead:`);
    for (const p of byName) {
      console.log(`  ${p.url}`);
    }
    return undefined;
  }

  return byName[0];
};

/** A SHA-256 as `.plugin trust` accepts it: 64 hex characters. */
const SHA256_HEX = /^[0-9a-f]{64}$/i;

/**
 * Hands the remote resolver the pins the current records imply, so the next
 * fetch is gated on them.
 *
 * Called at the top of every path that reaches `dynamicLoadModule`, and again
 * after any mutation that changes pin state — a later command in the same
 * session must see the current table, or `.plugin unpin` would not take effect
 * until the next start.
 *
 * A pinned record with no recorded hash contributes nothing: that is a first
 * observation, not a violation, so its next load records a hash and enforcement
 * begins from there.
 */
const syncPluginPins = (plugins: PluginRecord[]): void => {
  setRecordPinnedHashes(
    plugins.flatMap(p => (p.pinned && p.sha256 ? [{ url: p.url, sha256: p.sha256 }] : []))
  );
};

/**
 * Rebuilds the pin table from the saved records, for a host about to load
 * plugins some other way. `loadPluginsFromConfig` bypasses the record path
 * entirely, and a pin is a property of the URL, not of the record that asked for
 * it — without this, declaring a pinned plugin's URL in `quoomb.config.json`
 * would load it unverified.
 *
 * Every `.plugin` subcommand and {@link loadEnabledPlugins} sync for themselves;
 * this is only for entry points that reach the loader without going through
 * either.
 */
export const syncSavedPluginPins = async (): Promise<void> => {
  syncPluginPins(await loadPlugins());
};

/**
 * True when this plugin's module is fetched over the network, which is the only
 * case a pin can act on — a `file:` URL never reaches the remote resolver, so a
 * pin on one would be silently inert.
 */
const isRemotePlugin = (plugin: PluginRecord): boolean => {
  try {
    return new URL(plugin.url).protocol === 'https:';
  } catch {
    return false;
  }
};

/**
 * The {@link PluginHashMismatchError} behind a failed load, if that is what
 * failed. `dynamicLoadModule` wraps every error in a `Failed to load plugin
 * from …` Error, keeping the original on `cause`, so the class is only reachable
 * through there.
 */
const hashMismatchFrom = (error: unknown): PluginHashMismatchError | undefined => {
  if (error instanceof PluginHashMismatchError) return error;
  const cause = error instanceof Error ? error.cause : undefined;
  return cause instanceof PluginHashMismatchError ? cause : undefined;
};

/**
 * Reconciles a plugin record's recorded module hash against the bytes actually
 * fetched for it a moment ago. No-op for plugins that were not fetched over the
 * network (a `file:` URL never is).
 *
 * Remote plugin code can change under a stable URL, so a mismatch is worth
 * shouting about — but we warn and continue rather than block: refusing to load
 * changed code is a bigger policy call than the CLI should make on its own.
 * `adopt` marks a load the user explicitly asked for (install, enable, reload),
 * where taking the new hash as expected is the point; startup autoload leaves
 * the record alone so it keeps warning until the user acts on it.
 *
 * NOTE: every call site runs *after* `dynamicLoadModule`, so the warning reports
 * code that has already been imported and registered. That is the whole point of
 * warn-don't-block, and it is why refusing is a separate mechanism: a record with
 * `pinned: true` is enforced inside the resolver, before the module is written or
 * imported (see {@link syncPluginPins}), and never gets this far — a pinned
 * mismatch throws, and a pinned match takes the `fetched === plugin.sha256` early
 * return below.
 *
 * @returns true when the record changed and the caller should save it.
 */
const reconcilePluginHash = (plugin: PluginRecord, adopt: boolean): boolean => {
  const fetched = getLastFetchedHash(plugin.url);
  if (!fetched || fetched === plugin.sha256) {
    return false;
  }

  // No recorded hash means a legacy record or a first install — trust what we
  // just fetched and start comparing from here.
  if (plugin.sha256) {
    console.log(chalk.yellow(`Warning: the module at ${plugin.url} has changed since it was installed.`));
    console.log(chalk.yellow(`  recorded sha256 ${plugin.sha256}`));
    console.log(chalk.yellow(`  fetched  sha256 ${fetched}`));
    if (!adopt) {
      console.log(chalk.yellow(`  Run '.plugin reload ${displayName(plugin)}' to accept the new version.`));
      return false;
    }
  }

  plugin.sha256 = fetched;
  return true;
};

const installPluginCommand = async (args: string[], db: Database): Promise<void> => {
  const url = args.find(arg => !arg.startsWith('--'));
  const flags = args.filter(arg => arg.startsWith('--'));
  const unknownFlag = flags.find(flag => flag !== '--pin');

  if (!url || unknownFlag) {
    if (unknownFlag) {
      console.log(`Unknown option: ${unknownFlag}`);
    }
    console.log('Usage: .plugin install <url> [--pin]');
    return;
  }

  if (!validatePluginUrl(url)) {
    console.log('Error: Invalid plugin URL. Must be https:// or file:// URL ending in .js or .mjs');
    return;
  }

  const pin = flags.includes('--pin');
  const plugins = await loadPlugins();

  // Before the load, not after: re-installing an already-installed URL used to
  // import (and register) the module and only then report the duplicate, which
  // let `.plugin install <pinned url>` run unpinned bytes.
  if (plugins.some(p => p.url === url)) {
    console.log(`Plugin from ${url} is already installed`);
    return;
  }

  // Other records' pins still apply to their own URLs; this URL has no record
  // yet, so nothing gates it.
  syncPluginPins(plugins);

  try {
    console.log(`Installing plugin from ${url}...`);

    // Try to load the plugin
    const manifest = await dynamicLoadModule(url, db, {});

    // Create plugin record, remembering what was fetched so a later load can
    // tell that the code behind this URL changed.
    const pluginRecord: PluginRecord = {
      id: crypto.randomUUID(),
      url,
      enabled: true,
      manifest,
      config: {},
      sha256: getLastFetchedHash(url),
    };
    if (pin) {
      pluginRecord.pinned = true;
    }

    // Add to list and save
    plugins.push(pluginRecord);
    await savePlugins(plugins);
    syncPluginPins(plugins);

    console.log(`Successfully installed plugin: ${displayName(pluginRecord)}`);
    if (manifest?.description) {
      console.log(`  ${manifest.description}`);
    }
    if (manifest?.version) {
      console.log(`  Version: ${manifest.version}`);
    }
    if (pin) {
      reportPinState(pluginRecord);
    }
  } catch (error) {
    console.log(`Error installing plugin: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
};

/**
 * Says what a just-pinned record actually enforces. A pin without a recorded
 * hash is not an error — install records one from the fetch it just did, but a
 * `file:` plugin or a hand-edited record may have none — so say which of the two
 * situations the user is in.
 */
const reportPinState = (plugin: PluginRecord): void => {
  if (plugin.sha256) {
    console.log(`  Pinned to sha256 ${plugin.sha256}; a load serving anything else is refused.`);
  } else {
    console.log('  Pinned, but no hash is recorded yet; the next successful load records one and enforcement begins there.');
  }
};

const listPluginsCommand = async (): Promise<void> => {
  const plugins = await loadPlugins();

  if (plugins.length === 0) {
    console.log('No plugins installed');
    return;
  }

  console.log('Installed plugins:');
  for (const plugin of plugins) {
    const status = plugin.enabled ? '✓' : '✗';
    const name = displayName(plugin);
    const version = plugin.manifest?.version || '';
    console.log(`  ${status} ${name} ${version ? `(v${version})` : ''}`);
    console.log(`    ${plugin.url}`);
    if (plugin.pinned) {
      console.log(`    pinned sha256 ${plugin.sha256 ?? '(none recorded yet)'}`);
    }
    if (plugin.manifest?.description) {
      console.log(`    ${plugin.manifest.description}`);
    }
    console.log();
  }
};

const enablePluginCommand = async (args: string[], db: Database): Promise<void> => {
  if (args.length === 0) {
    console.log('Usage: .plugin enable <name|url>');
    return;
  }

  const plugins = await loadPlugins();
  const plugin = resolvePlugin(plugins, args[0]);
  if (!plugin) {
    return;
  }

  if (plugin.enabled) {
    console.log(`Plugin '${displayName(plugin)}' is already enabled`);
    return;
  }

  syncPluginPins(plugins);

  try {
    // Load the plugin
    const manifest = await dynamicLoadModule(plugin.url, db, plugin.config);

    // Update plugin record
    plugin.enabled = true;
    if (manifest) {
      plugin.manifest = manifest;
    }
    reconcilePluginHash(plugin, true);

    await savePlugins(plugins);
    console.log(`Enabled plugin: ${displayName(plugin)}`);
  } catch (error) {
    const mismatch = hashMismatchFrom(error);
    if (mismatch) {
      reportPinViolation(plugin, mismatch);
      return;
    }
    console.log(`Error enabling plugin: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
};

const disablePluginCommand = async (args: string[]): Promise<void> => {
  if (args.length === 0) {
    console.log('Usage: .plugin disable <name|url>');
    return;
  }

  const plugins = await loadPlugins();
  const plugin = resolvePlugin(plugins, args[0]);
  if (!plugin) {
    return;
  }

  if (!plugin.enabled) {
    console.log(`Plugin '${displayName(plugin)}' is already disabled`);
    return;
  }

  plugin.enabled = false;
  await savePlugins(plugins);
  console.log(`Disabled plugin: ${displayName(plugin)}`);
  console.log('Note: Plugin will be unloaded on next restart');
};

const removePluginCommand = async (args: string[]): Promise<void> => {
  if (args.length === 0) {
    console.log('Usage: .plugin remove <name|url>');
    return;
  }

  const plugins = await loadPlugins();
  const plugin = resolvePlugin(plugins, args[0]);
  if (!plugin) {
    return;
  }

  const removedName = displayName(plugin);
  plugins.splice(plugins.indexOf(plugin), 1);
  await savePlugins(plugins);
  // Drops its pin too, so a fresh install of the same URL later in this session
  // is not gated by a record that no longer exists.
  syncPluginPins(plugins);
  console.log(`Removed plugin: ${removedName}`);
};

const configPluginCommand = async (args: string[], db: Database): Promise<void> => {
  if (args.length === 0) {
    console.log('Usage: .plugin config <name|url> [key=value ...]');
    return;
  }

  const plugins = await loadPlugins();
  const plugin = resolvePlugin(plugins, args[0]);
  if (!plugin) {
    return;
  }

  const name = displayName(plugin);

  if (args.length === 1) {
    // Show current configuration
    console.log(`Configuration for ${name}:`);
    if (!plugin.manifest?.settings?.length) {
      console.log('  No configuration options available');
      return;
    }

    for (const setting of plugin.manifest.settings) {
      const value = plugin.config[setting.key] ?? setting.default ?? '';
      console.log(`  ${setting.key}: ${value} (${setting.type})`);
      if (setting.help) {
        console.log(`    ${setting.help}`);
      }
    }
    return;
  }

  // Update configuration
  const configUpdates: Record<string, SqlValue> = {};
  for (let i = 1; i < args.length; i++) {
    const [key, ...valueParts] = args[i].split('=');
    if (!key || valueParts.length === 0) {
      console.log(`Invalid config format: ${args[i]}. Use key=value`);
      continue;
    }

    const value = valueParts.join('=');
    const setting = plugin.manifest?.settings?.find((s: PluginSetting) => s.key === key);

    if (!setting) {
      console.log(`Unknown setting: ${key}`);
      continue;
    }

    // Parse value according to type
    let parsedValue: SqlValue;
    switch (setting.type) {
      case 'number':
        parsedValue = Number(value);
        if (isNaN(parsedValue)) {
          console.log(`Invalid number value for ${key}: ${value}`);
          continue;
        }
        break;
      case 'boolean':
        parsedValue = value.toLowerCase() === 'true';
        break;
      default:
        parsedValue = value;
    }

    configUpdates[key] = parsedValue;
  }

  // Update plugin config
  plugin.config = { ...plugin.config, ...configUpdates };
  await savePlugins(plugins);

  // Reload plugin if enabled
  if (plugin.enabled) {
    syncPluginPins(plugins);
    try {
      await dynamicLoadModule(plugin.url, db, plugin.config);
      if (reconcilePluginHash(plugin, true)) {
        await savePlugins(plugins);
      }
      console.log(`Updated configuration and reloaded plugin: ${name}`);
    } catch (error) {
      const mismatch = hashMismatchFrom(error);
      if (mismatch) {
        console.log(`Configuration updated, but the plugin was not reloaded.`);
        reportPinViolation(plugin, mismatch);
        return;
      }
      console.log(`Configuration updated but failed to reload plugin: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  } else {
    console.log(`Updated configuration for plugin: ${name}`);
  }
};

const reloadPluginCommand = async (args: string[], db: Database): Promise<void> => {
  if (args.length === 0) {
    console.log('Usage: .plugin reload <name|url>');
    return;
  }

  const plugins = await loadPlugins();
  const plugin = resolvePlugin(plugins, args[0]);
  if (!plugin) {
    return;
  }

  if (!plugin.enabled) {
    console.log(`Plugin '${displayName(plugin)}' is disabled`);
    return;
  }

  syncPluginPins(plugins);

  try {
    const manifest = await dynamicLoadModule(plugin.url, db, plugin.config);

    // Update manifest if it changed
    const hashChanged = reconcilePluginHash(plugin, true);
    if (manifest) {
      plugin.manifest = manifest;
    }
    if (manifest || hashChanged) {
      await savePlugins(plugins);
    }

    console.log(`Reloaded plugin: ${displayName(plugin)}`);
  } catch (error) {
    const mismatch = hashMismatchFrom(error);
    if (mismatch) {
      reportPinViolation(plugin, mismatch);
      return;
    }
    console.log(`Error reloading plugin: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
};

/**
 * Turns on before-the-load verification for a plugin. Pinning a plugin with no
 * recorded hash still succeeds — see {@link reportPinState}.
 */
const pinPluginCommand = async (args: string[]): Promise<void> => {
  if (args.length === 0) {
    console.log('Usage: .plugin pin <name|url>');
    return;
  }

  const plugins = await loadPlugins();
  const plugin = resolvePlugin(plugins, args[0]);
  if (!plugin) {
    return;
  }

  const name = displayName(plugin);

  if (!isRemotePlugin(plugin)) {
    console.log(`Cannot pin '${name}': pinning only applies to modules the CLI downloads (https: URLs).`);
    console.log(`  ${plugin.url} is loaded directly, so there are no fetched bytes to verify.`);
    return;
  }

  if (plugin.pinned) {
    console.log(`Plugin '${name}' is already pinned`);
    reportPinState(plugin);
    return;
  }

  plugin.pinned = true;
  await savePlugins(plugins);
  syncPluginPins(plugins);

  console.log(`Pinned plugin: ${name}`);
  reportPinState(plugin);
};

/** Back to warn-and-continue. Takes effect immediately, not at the next start. */
const unpinPluginCommand = async (args: string[]): Promise<void> => {
  if (args.length === 0) {
    console.log('Usage: .plugin unpin <name|url>');
    return;
  }

  const plugins = await loadPlugins();
  const plugin = resolvePlugin(plugins, args[0]);
  if (!plugin) {
    return;
  }

  const name = displayName(plugin);

  if (!plugin.pinned) {
    console.log(`Plugin '${name}' is not pinned`);
    return;
  }

  plugin.pinned = false;
  await savePlugins(plugins);
  syncPluginPins(plugins);

  console.log(`Unpinned plugin: ${name}`);
  console.log('  A changed module now warns after it loads, rather than being refused.');
};

/**
 * Accepts a new version of a pinned plugin.
 *
 * With an explicit hash the record is updated without fetching or loading
 * anything — the safest form, for a user who verified the bytes out of band.
 * Without one, the URL is fetched and hashed (no import), so the user sees what
 * changed before any of it runs.
 */
const trustPluginCommand = async (args: string[]): Promise<void> => {
  if (args.length === 0) {
    console.log('Usage: .plugin trust <name|url> [sha256]');
    return;
  }

  const plugins = await loadPlugins();
  const plugin = resolvePlugin(plugins, args[0]);
  if (!plugin) {
    return;
  }

  const name = displayName(plugin);

  if (!isRemotePlugin(plugin)) {
    console.log(`Cannot trust a hash for '${name}': hashes only apply to modules the CLI downloads (https: URLs).`);
    console.log(`  ${plugin.url} is loaded directly, so there are no fetched bytes to verify.`);
    return;
  }

  const trusted = args.length > 1
    ? parseTrustedHash(args[1])
    : await fetchTrustedHash(plugin.url);
  if (!trusted) {
    return;
  }

  console.log(`  previous sha256 ${plugin.sha256 ?? '(none recorded)'}`);
  console.log(`  trusted  sha256 ${trusted}`);

  if (trusted === plugin.sha256) {
    console.log(`Plugin '${name}' already trusts that hash`);
    return;
  }

  plugin.sha256 = trusted;
  await savePlugins(plugins);
  syncPluginPins(plugins);

  console.log(`Now trusting the new version of ${name}.`);
  console.log(`  It is not loaded — run '.plugin reload ${name}' to load it.`);
};

/** Validates a user-supplied digest, reporting the refusal itself. */
const parseTrustedHash = (raw: string): string | undefined => {
  if (!SHA256_HEX.test(raw)) {
    console.log(`Not a SHA-256: '${raw}'. Expected 64 hex characters; nothing was changed.`);
    return undefined;
  }
  return raw.toLowerCase();
};

/**
 * Fetches and digests the URL without importing it, reporting a fetch failure
 * itself. Separate from the load that follows, so the bytes can still change in
 * between — that fails the pinned load closed, which is the right direction.
 */
const fetchTrustedHash = async (url: string): Promise<string | undefined> => {
  try {
    const fetched = await fetchRemoteModuleHash(url);
    return fetched.sha256;
  } catch (error) {
    console.log(`Could not fetch ${url}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    console.log('  Nothing was changed.');
    return undefined;
  }
};

// Update the startup function to load enabled plugins
export const loadEnabledPlugins = async (db: Database): Promise<void> => {
  const plugins = await loadPlugins();
  const enabledPlugins = plugins.filter(p => p.enabled);

  syncPluginPins(plugins);

  for (const plugin of enabledPlugins) {
    try {
      const manifest = await dynamicLoadModule(plugin.url, db, plugin.config);

      // Autoload is not an explicit request for *this* plugin, so a changed hash
      // only warns here — it is adopted when the user installs or reloads.
      const hashChanged = reconcilePluginHash(plugin, false);

      // Update manifest if it changed
      const manifestChanged = manifest !== undefined && (!plugin.manifest || plugin.manifest.version !== manifest.version);
      if (manifestChanged) {
        plugin.manifest = manifest;
      }
      if (manifestChanged || hashChanged) {
        await savePlugins(plugins);
      }
    } catch (error) {
      const mismatch = hashMismatchFrom(error);
      if (mismatch) {
        reportPinViolation(plugin, mismatch);
        continue;
      }

      console.log(`Warning: Failed to load plugin ${displayName(plugin)}: ${error instanceof Error ? error.message : 'Unknown error'}`);

      // Disable the plugin if it failed to load. Say so — a remote plugin can
      // fail for a reason that has nothing to do with the plugin (the host was
      // offline), and a silent disable leaves the user with no idea why it
      // stopped loading. `displayName` always resolves to something typeable,
      // even when no manifest was ever cached.
      plugin.enabled = false;
      await savePlugins(plugins);
      console.log(`  Disabled it; run '.plugin enable ${displayName(plugin)}' to try again.`);
    }
  }
};

/**
 * Reports a load refused by a pin, from wherever it was attempted, and names the
 * only two things that resolve it.
 *
 * Every caller leaves the record alone. That matters most in
 * {@link loadEnabledPlugins}, which disables a plugin that fails to load: here
 * that would be wrong twice over — the plugin is not broken (the code behind its
 * URL changed), and the hint that path prints, `.plugin enable`, hits the same
 * pin and fails identically. Nothing is saved, so the record keeps both
 * `enabled: true` and the hash the user pinned.
 *
 * The wider question of whether a failed startup load should auto-disable at all
 * is tracked separately; only the pin case is carved out here.
 */
const reportPinViolation = (plugin: PluginRecord, mismatch: PluginHashMismatchError): void => {
  const name = displayName(plugin);
  console.log(chalk.yellow(`Refused to load plugin ${name}: the module at ${mismatch.url} does not match its pinned hash.`));
  console.log(chalk.yellow(`  pinned sha256 ${mismatch.expected}`));
  console.log(chalk.yellow(`  served sha256 ${mismatch.actual}`));
  console.log(chalk.yellow(`  Verify the new version, then '.plugin trust ${name}' to accept it,`));
  console.log(chalk.yellow(`  or '.plugin unpin ${name}' to go back to warning only.`));
};

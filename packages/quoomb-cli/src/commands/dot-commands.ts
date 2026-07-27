import { Database, quoteIdentifier } from '@quereus/quereus';
import chalk from 'chalk';
import Table from 'cli-table3';
import * as fs from 'fs/promises';
import * as path from 'path';
import Papa from 'papaparse';
import { dynamicLoadModule, validatePluginUrl } from '@quereus/plugin-loader';
import type { PluginRecord, PluginSetting } from '@quereus/plugin-loader';
import { getLastFetchedHash } from '../plugins/remote-resolver.js';
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
  .plugin install <url>    Install plugin from URL
  .plugin list            List installed plugins
  .plugin enable <name>   Enable a plugin
  .plugin disable <name>  Disable a plugin
  .plugin remove <name>   Remove a plugin
  .plugin config <name>   Configure a plugin
  .plugin reload <name>   Reload a plugin

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
    default:
      console.log('Plugin management commands:');
      console.log('  .plugin install <url>     - Install plugin from URL');
      console.log('  .plugin list             - List installed plugins');
      console.log('  .plugin enable <name>    - Enable a plugin');
      console.log('  .plugin disable <name>   - Disable a plugin');
      console.log('  .plugin remove <name>    - Remove a plugin');
      console.log('  .plugin config <name>    - Configure a plugin');
      console.log('  .plugin reload <name>    - Reload a plugin');
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
      console.log(chalk.yellow(`  Run '.plugin reload ${plugin.manifest?.name ?? '<name>'}' to accept the new version.`));
      return false;
    }
  }

  plugin.sha256 = fetched;
  return true;
};

const installPluginCommand = async (args: string[], db: Database): Promise<void> => {
  if (args.length === 0) {
    console.log('Usage: .plugin install <url>');
    return;
  }

  const url = args[0];

  if (!validatePluginUrl(url)) {
    console.log('Error: Invalid plugin URL. Must be https:// or file:// URL ending in .js or .mjs');
    return;
  }

  try {
    console.log(`Installing plugin from ${url}...`);

    // Try to load the plugin
    const manifest = await dynamicLoadModule(url, db, {});

    // Load existing plugins
    const plugins = await loadPlugins();

    // Check if already installed
    const existing = plugins.find(p => p.url === url);
    if (existing) {
      console.log(`Plugin from ${url} is already installed`);
      return;
    }

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

    // Add to list and save
    plugins.push(pluginRecord);
    await savePlugins(plugins);

    console.log(`Successfully installed plugin: ${manifest?.name || 'Unknown'}`);
    if (manifest?.description) {
      console.log(`  ${manifest.description}`);
    }
    if (manifest?.version) {
      console.log(`  Version: ${manifest.version}`);
    }
  } catch (error) {
    console.log(`Error installing plugin: ${error instanceof Error ? error.message : 'Unknown error'}`);
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
    const name = plugin.manifest?.name || 'Unknown';
    const version = plugin.manifest?.version || '';
    console.log(`  ${status} ${name} ${version ? `(v${version})` : ''}`);
    console.log(`    ${plugin.url}`);
    if (plugin.manifest?.description) {
      console.log(`    ${plugin.manifest.description}`);
    }
    console.log();
  }
};

const enablePluginCommand = async (args: string[], db: Database): Promise<void> => {
  if (args.length === 0) {
    console.log('Usage: .plugin enable <name>');
    return;
  }

  const name = args[0];
  const plugins = await loadPlugins();
  const plugin = plugins.find(p => p.manifest?.name === name);

  if (!plugin) {
    console.log(`Plugin '${name}' not found`);
    return;
  }

  if (plugin.enabled) {
    console.log(`Plugin '${name}' is already enabled`);
    return;
  }

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
    console.log(`Enabled plugin: ${name}`);
  } catch (error) {
    console.log(`Error enabling plugin: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
};

const disablePluginCommand = async (args: string[]): Promise<void> => {
  if (args.length === 0) {
    console.log('Usage: .plugin disable <name>');
    return;
  }

  const name = args[0];
  const plugins = await loadPlugins();
  const plugin = plugins.find(p => p.manifest?.name === name);

  if (!plugin) {
    console.log(`Plugin '${name}' not found`);
    return;
  }

  if (!plugin.enabled) {
    console.log(`Plugin '${name}' is already disabled`);
    return;
  }

  plugin.enabled = false;
  await savePlugins(plugins);
  console.log(`Disabled plugin: ${name}`);
  console.log('Note: Plugin will be unloaded on next restart');
};

const removePluginCommand = async (args: string[]): Promise<void> => {
  if (args.length === 0) {
    console.log('Usage: .plugin remove <name>');
    return;
  }

  const name = args[0];
  const plugins = await loadPlugins();
  const pluginIndex = plugins.findIndex(p => p.manifest?.name === name);

  if (pluginIndex === -1) {
    console.log(`Plugin '${name}' not found`);
    return;
  }

  plugins.splice(pluginIndex, 1);
  await savePlugins(plugins);
  console.log(`Removed plugin: ${name}`);
};

const configPluginCommand = async (args: string[], db: Database): Promise<void> => {
  if (args.length === 0) {
    console.log('Usage: .plugin config <name> [key=value ...]');
    return;
  }

  const name = args[0];
  const plugins = await loadPlugins();
  const plugin = plugins.find(p => p.manifest?.name === name);

  if (!plugin) {
    console.log(`Plugin '${name}' not found`);
    return;
  }

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
    try {
      await dynamicLoadModule(plugin.url, db, plugin.config);
      if (reconcilePluginHash(plugin, true)) {
        await savePlugins(plugins);
      }
      console.log(`Updated configuration and reloaded plugin: ${name}`);
    } catch (error) {
      console.log(`Configuration updated but failed to reload plugin: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  } else {
    console.log(`Updated configuration for plugin: ${name}`);
  }
};

const reloadPluginCommand = async (args: string[], db: Database): Promise<void> => {
  if (args.length === 0) {
    console.log('Usage: .plugin reload <name>');
    return;
  }

  const name = args[0];
  const plugins = await loadPlugins();
  const plugin = plugins.find(p => p.manifest?.name === name);

  if (!plugin) {
    console.log(`Plugin '${name}' not found`);
    return;
  }

  if (!plugin.enabled) {
    console.log(`Plugin '${name}' is disabled`);
    return;
  }

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

    console.log(`Reloaded plugin: ${name}`);
  } catch (error) {
    console.log(`Error reloading plugin: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
};

// Update the startup function to load enabled plugins
export const loadEnabledPlugins = async (db: Database): Promise<void> => {
  const plugins = await loadPlugins();
  const enabledPlugins = plugins.filter(p => p.enabled);

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
      console.log(`Warning: Failed to load plugin ${plugin.manifest?.name || plugin.url}: ${error instanceof Error ? error.message : 'Unknown error'}`);

      // Disable the plugin if it failed to load
      plugin.enabled = false;
      await savePlugins(plugins);
    }
  }
};

#!/usr/bin/env node

import { Command } from 'commander';
import { REPL } from '../repl.js';
import { Database, type SqlValue } from '@quereus/quereus';
import { loadPluginsFromConfig, interpolateConfigEnvVars, validateConfig, type QuoombConfig } from '@quereus/plugin-loader';
import chalk from 'chalk';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import Table from 'cli-table3';
import { installRemotePluginResolver } from '../plugins/remote-resolver.js';

// Must run before any plugin is loaded — config autoload, saved-plugin autoload,
// and `.plugin install <url>` all reach the loader through this one resolver.
installRemotePluginResolver();

/** Options parsed by commander from the `quoomb` argv. */
interface CliOptions {
  json?: boolean;
  file?: string;
  cmd?: string;
  config?: string;
  /** `--no-autoload` sets this to false. */
  autoload?: boolean;
  /** `--no-color` sets this to false. */
  color?: boolean;
}

const program = new Command();

program
  .name('quoomb')
  .description('Quoomb - Interactive REPL for Quereus SQL engine')
  .version('0.0.1')
  .option('-j, --json', 'output results as JSON instead of ASCII table')
  .option('-f, --file <path>', 'execute SQL from file and exit')
  .option('-c, --cmd <sql>', 'execute SQL command and exit')
  .option('--config <path>', 'load configuration from file')
  .option('--no-autoload', 'do not auto-load plugins from config')
  .option('--no-color', 'disable colored output')
  .action(async (options: CliOptions) => {
    try {
      if (options.file) {
        await executeFile(options.file, options);
      } else if (options.cmd) {
        await executeCommand(options.cmd, options);
      } else {
        console.log(chalk.blue('Welcome to Quoomb - Quereus SQL REPL'));
        console.log(chalk.gray('Type .help for available commands or enter SQL to execute'));
        console.log(chalk.gray('Use Ctrl+C or .exit to quit\n'));

        // Load config if available
        let config: QuoombConfig | undefined;
        const configPath = await resolveConfigPath(options.config);
        if (configPath) {
          try {
            const parsed = await loadConfigFile(configPath);
            if (validateConfig(parsed)) {
              config = parsed;
              console.log(chalk.gray(`Loaded config from ${configPath}`));
            } else {
              console.warn(chalk.yellow(`Warning: Invalid config file at ${configPath}`));
            }
          } catch (error) {
            console.warn(chalk.yellow(`Warning: ${error instanceof Error ? error.message : 'Failed to load config'}`));
          }
        }

        const repl = new REPL({ ...options, config, autoload: options.autoload !== false });
        await repl.start();
      }
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

/**
 * Resolve config file path following the resolution strategy
 */
async function resolveConfigPath(configOption?: string): Promise<string | null> {
  // 1. --config CLI argument (highest priority)
  if (configOption) {
    return path.resolve(configOption);
  }

  // 2. QUOOMB_CONFIG environment variable
  if (process.env.QUOOMB_CONFIG) {
    return path.resolve(process.env.QUOOMB_CONFIG);
  }

  // 3. ./quoomb.config.json (current directory)
  const cwd = process.cwd();
  const cwdConfig = path.join(cwd, 'quoomb.config.json');
  try {
    await fs.access(cwdConfig);
    return cwdConfig;
  } catch {
    // File doesn't exist, continue
  }

  // 4. ~/.quoomb/config.json (user home directory)
  const homeDir = os.homedir();
  const homeConfig = path.join(homeDir, '.quoomb', 'config.json');
  try {
    await fs.access(homeConfig);
    return homeConfig;
  } catch {
    // File doesn't exist, continue
  }

  // 5. No config found
  return null;
}

/**
 * Load and parse config file
 */
async function loadConfigFile(configPath: string): Promise<unknown> {
  try {
    const content = await fs.readFile(configPath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`Failed to load config from '${configPath}': ${error instanceof Error ? error.message : error}`);
  }
}

async function executeFile(filePath: string, options: CliOptions): Promise<void> {
  try {
    const sql = await fs.readFile(filePath, 'utf-8');
    await executeCommand(sql.trim(), options);
  } catch (error) {
    throw new Error(`Failed to read file '${filePath}': ${error instanceof Error ? error.message : error}`);
  }
}

async function executeCommand(sql: string, options: CliOptions): Promise<void> {
  const db = new Database();
  const startTime = Date.now();

  try {
    // Load config and plugins if available
    const configPath = await resolveConfigPath(options.config);
    if (configPath) {
      try {
        const config = await loadConfigFile(configPath);
        if (validateConfig(config)) {
          const interpolatedConfig = interpolateConfigEnvVars(config);
          if (interpolatedConfig.autoload !== false && options.autoload !== false) {
            await loadPluginsFromConfig(db, interpolatedConfig);
          }
        }
      } catch (error) {
        console.warn(chalk.yellow(`Warning: ${error instanceof Error ? error.message : 'Failed to load config'}`));
      }
    }

    // Check if this is a query that returns results
    const trimmedSql = sql.trim().toLowerCase();
    if (trimmedSql.startsWith('select') || trimmedSql.startsWith('with')) {
      const results: Record<string, SqlValue>[] = [];
      for await (const row of db.eval(sql)) {
        results.push(row);
      }

      const endTime = Date.now();

      if (options.json) {
        console.log(JSON.stringify(results, null, 2));
      } else {
        printTable(results, options);
      }

      if (options.color !== false) {
        console.error(chalk.gray(`${results.length} row(s) (${endTime - startTime}ms)`));
      } else {
        console.error(`${results.length} row(s) (${endTime - startTime}ms)`);
      }
    } else {
      // Execute statement without expecting results
      await db.exec(sql);
      const endTime = Date.now();

      if (options.color !== false) {
        console.error(chalk.green(`Query executed successfully (${endTime - startTime}ms)`));
      } else {
        console.error(`Query executed successfully (${endTime - startTime}ms)`);
      }
    }
  } catch (error) {
    const endTime = Date.now();
    if (options.color !== false) {
      console.error(chalk.red(`Query failed (${endTime - startTime}ms)`));
    } else {
      console.error(`Query failed (${endTime - startTime}ms)`);
    }
    throw error;
  } finally {
    await db.close();
  }
}

function printTable(results: Record<string, SqlValue>[], options: CliOptions): void {
  if (results.length === 0) {
    console.log(options.color !== false ? chalk.yellow('No rows returned') : 'No rows returned');
    return;
  }

  const columns = Object.keys(results[0]);
  const table = new Table({
    head: columns.map(col => options.color !== false ? chalk.cyan(col) : col),
    style: {
      head: options.color !== false ? ['cyan'] : []
    }
  });

  for (const row of results) {
    const values = columns.map(col => {
      const value = row[col];
      if (value === null) return options.color !== false ? chalk.gray('NULL') : 'NULL';
      if (typeof value === 'string') return value;
      return String(value);
    });
    table.push(values);
  }

  console.log(table.toString());
}

program.parse();

import * as readline from 'node:readline';
import { Database, formatErrorChain, unwrapError } from '@quereus/quereus';
import { loadPluginsFromConfig, interpolateConfigEnvVars, type QuoombConfig } from '@quereus/plugin-loader';
import chalk from 'chalk';
import { DotCommands } from './commands/dot-commands.js';
import { handleDotCommand, loadEnabledPlugins, syncSavedPluginPins } from './commands/dot-commands.js';
import { seedConfigPluginPins } from './plugins/remote-resolver.js';

interface REPLOptions {
  json?: boolean;
  color?: boolean;
  config?: QuoombConfig;
  autoload?: boolean;
}

export class REPL {
  private db: Database;
  private rl: readline.Interface;
  private dotCommands: DotCommands;
  private options: REPLOptions;

  constructor(options: REPLOptions = {}) {
    this.options = { color: true, autoload: true, ...options };
    this.db = new Database();
    this.dotCommands = new DotCommands(this.db);

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: this.getPrompt(),
      completer: this.completer.bind(this)
    });

    this.setupSignalHandlers();
  }

  private getPrompt(): string {
    return this.options.color ? chalk.green('quoomb> ') : 'quoomb> ';
  }

  private setupSignalHandlers(): void {
    this.rl.on('SIGINT', () => {
      console.log('\nReceived SIGINT. Use .exit to quit.');
      this.rl.prompt();
    });
  }

  async start(): Promise<void> {
    console.log('🚀 Quoomb Interactive SQL Shell');
    console.log('Type .help for available commands, or enter SQL statements');
    console.log('');

    // Load plugins from config if provided and autoload is enabled
    if (this.options.config && this.options.autoload !== false) {
      try {
        // A config-declared URL that a saved record pins is still pinned; this
        // load does not go through the record path that would sync it.
        await syncSavedPluginPins();
        const config = interpolateConfigEnvVars(this.options.config);
        seedConfigPluginPins(config);
        if (config.autoload !== false) {
          await loadPluginsFromConfig(this.db, config);
        }
      } catch (error) {
        console.log(`Warning: Error loading plugins from config: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    // Load enabled plugins at startup (from legacy plugin storage)
    try {
      await loadEnabledPlugins(this.db);
    } catch (error) {
      console.log(`Warning: Error loading plugins: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    this.rl.prompt();

    this.rl.on('line', async (line: string) => {
      const trimmed = line.trim();

      if (!trimmed) {
        this.rl.prompt();
        return;
      }

      // Handle dot commands
      if (trimmed.startsWith('.')) {
        try {
          // Check if it's a plugin command first
          if (trimmed.startsWith('.plugin')) {
            await handleDotCommand(trimmed, this.db, this.rl);
          } else {
            // Use existing dot commands handler
            const handled = await this.dotCommands.handle(trimmed, this.rl);
            if (!handled) {
              console.log(`Unknown command: ${trimmed}`);
              console.log('Type .help for available commands');
            }
          }
        } catch (error) {
          this.printEnhancedError(error);
        }
        this.rl.prompt();
        return;
      }

      // Handle SQL
      try {
        const results = [];
        for await (const row of this.db.eval(trimmed)) {
          results.push(row);
        }

        if (results.length > 0) {
          console.table(results);
          console.log(`\n${results.length} row(s) returned\n`);
        } else {
          console.log('Query executed successfully\n');
        }
      } catch (error) {
        this.printEnhancedError(error);
      }

      this.rl.prompt();
    });

    this.rl.on('close', () => {
      console.log('\nGoodbye! 👋');
      this.db.close();
      process.exit(0);
    });
  }

  private completer(line: string): [string[], string] {
    const hits = [];

    // Dot command completion
    if (line.startsWith('.')) {
      const dotCommands = [
        '.help',
        '.tables',
        '.schema',
        '.dump',
        '.read',
        '.exit',
        '.plugin',
        '.plugin install',
        '.plugin list',
        '.plugin enable',
        '.plugin disable',
        '.plugin remove',
        '.plugin config',
        '.plugin reload'
      ];

      for (const cmd of dotCommands) {
        if (cmd.startsWith(line)) {
          hits.push(cmd);
        }
      }
    } else {
      // SQL keyword completion
      const sqlKeywords = [
        'SELECT', 'FROM', 'WHERE', 'INSERT', 'UPDATE', 'DELETE',
        'CREATE', 'DROP', 'ALTER', 'TABLE', 'INDEX', 'VIEW',
        'JOIN', 'INNER', 'LEFT', 'RIGHT', 'OUTER', 'ON',
        'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET',
        'AND', 'OR', 'NOT', 'NULL', 'IS', 'IN', 'EXISTS',
        'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'DISTINCT'
      ];

      const lastWord = line.split(/\s+/).pop()?.toUpperCase() || '';

      for (const keyword of sqlKeywords) {
        if (keyword.startsWith(lastWord)) {
          hits.push(line.slice(0, -lastWord.length) + keyword);
        }
      }
    }

    return [hits, line];
  }

  close(): void {
    this.rl.close();
  }

  private printEnhancedError(error: unknown): void {
    if (this.options.color) {
      console.error(chalk.red('━'.repeat(60)));
      console.error(chalk.red.bold('SQL ERROR'));
      console.error(chalk.red('━'.repeat(60)));
    } else {
      console.error('━'.repeat(60));
      console.error('SQL ERROR');
      console.error('━'.repeat(60));
    }

    if (error instanceof Error) {
      const errorChain = unwrapError(error);

      if (errorChain.length > 1) {
        // Multiple errors in chain - show formatted chain
        const formattedChain = formatErrorChain(errorChain, false);
        if (this.options.color) {
          // Colorize the error chain
          const colorized = formattedChain
            .replace(/^Error: (.*)$/gm, chalk.red.bold('Error: ') + chalk.red('$1'))
            .replace(/^Caused by: (.*)$/gm, chalk.yellow.bold('Caused by: ') + chalk.yellow('$1'))
            .replace(/\(at line (\d+), column (\d+)\)/g, chalk.cyan('(at line $1, column $2)'));
          console.error(colorized);
        } else {
          console.error(formattedChain);
        }
      } else {
        // Single error - use simpler format
        const errorInfo = errorChain[0];
        let message = errorInfo?.message || error.message;

        if (errorInfo?.line && errorInfo?.column) {
          message += ` (at line ${errorInfo.line}, column ${errorInfo.column})`;
        }

        if (this.options.color) {
          console.error(chalk.red(message));
        } else {
          console.error(message);
        }
      }
    } else {
      // Fallback for non-Error objects
      const message = typeof error === 'string' ? error : String(error);
      if (this.options.color) {
        console.error(chalk.red(message));
      } else {
        console.error(message);
      }
    }

    if (this.options.color) {
      console.error(chalk.red('━'.repeat(60)));
    } else {
      console.error('━'.repeat(60));
    }
    console.error('');
  }
}

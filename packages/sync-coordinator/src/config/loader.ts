/**
 * Configuration loading from multiple sources.
 *
 * Priority (highest to lowest):
 * 1. Programmatic options
 * 2. CLI arguments
 * 3. Environment variables
 * 4. Config file
 * 5. Defaults
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { configLog } from '../common/logger.js';
import {
  type CoordinatorConfig,
  type PartialCoordinatorConfig,
  DEFAULT_CONFIG,
} from './types.js';

/**
 * Load configuration from a JSON file.
 */
export function loadConfigFile(configPath: string): PartialCoordinatorConfig {
  const resolved = resolve(configPath);
  if (!existsSync(resolved)) {
    configLog('Config file not found: %s', resolved);
    return {};
  }

  try {
    const content = readFileSync(resolved, 'utf-8');
    const parsed = JSON.parse(content) as PartialCoordinatorConfig;
    configLog('Loaded config from %s', resolved);
    return parsed;
  } catch (err) {
    configLog('Failed to parse config file %s: %O', resolved, err);
    throw new Error(`Failed to parse config file: ${resolved}`);
  }
}

/**
 * Load configuration from environment variables.
 */
export function loadEnvConfig(): PartialCoordinatorConfig {
  const config: PartialCoordinatorConfig = {};

  if (process.env.SYNC_HOST) {
    config.host = process.env.SYNC_HOST;
  }
  if (process.env.SYNC_PORT) {
    config.port = parseInt(process.env.SYNC_PORT, 10);
  }
  if (process.env.SYNC_BASE_PATH) {
    config.basePath = process.env.SYNC_BASE_PATH;
  }
  if (process.env.SYNC_DATA_DIR) {
    config.dataDir = process.env.SYNC_DATA_DIR;
  }

  // CORS
  if (process.env.SYNC_CORS_ORIGIN) {
    const origins = process.env.SYNC_CORS_ORIGIN;
    if (origins === 'true') {
      config.cors = { origin: true };
    } else if (origins === 'false') {
      config.cors = { origin: false };
    } else {
      config.cors = { origin: origins.split(',').map(o => o.trim()) };
    }
  }
  if (process.env.SYNC_CORS_CREDENTIALS) {
    config.cors = config.cors || {};
    config.cors.credentials = process.env.SYNC_CORS_CREDENTIALS === 'true';
  }

  // Auth
  if (process.env.SYNC_AUTH_MODE) {
    const mode = process.env.SYNC_AUTH_MODE as 'none' | 'token-whitelist' | 'custom';
    config.auth = { mode };
  }
  if (process.env.SYNC_AUTH_TOKENS) {
    config.auth = config.auth || { mode: 'token-whitelist' };
    config.auth.tokens = process.env.SYNC_AUTH_TOKENS.split(',').map(t => t.trim());
  }

  // Sync settings
  if (process.env.SYNC_RETENTION_HORIZON_MS) {
    config.sync = config.sync || {};
    config.sync.retentionHorizonMs = parseInt(process.env.SYNC_RETENTION_HORIZON_MS, 10);
  }
  if (process.env.SYNC_BATCH_SIZE) {
    config.sync = config.sync || {};
    config.sync.batchSize = parseInt(process.env.SYNC_BATCH_SIZE, 10);
  }

  // Logging
  if (process.env.SYNC_LOG_LEVEL) {
    config.logging = {
      level: process.env.SYNC_LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error',
    };
  }

  return config;
}

/**
 * Deep merge configuration objects.
 */
function mergeConfig(
  base: CoordinatorConfig,
  ...overrides: PartialCoordinatorConfig[]
): CoordinatorConfig {
  const result = { ...base };

  for (const override of overrides) {
    if (override.host !== undefined) result.host = override.host;
    if (override.port !== undefined) result.port = override.port;
    if (override.basePath !== undefined) result.basePath = override.basePath;
    if (override.dataDir !== undefined) result.dataDir = override.dataDir;

    if (override.cors) {
      result.cors = { ...result.cors, ...override.cors };
    }
    if (override.auth) {
      result.auth = { ...result.auth, ...override.auth };
    }
    if (override.sync) {
      result.sync = { ...result.sync, ...override.sync };
    }
    if (override.logging) {
      result.logging = { ...result.logging, ...override.logging };
    }
  }

  return result;
}

/**
 * Load full configuration from all sources.
 */
export function loadConfig(options: {
  configPath?: string;
  overrides?: PartialCoordinatorConfig;
} = {}): CoordinatorConfig {
  const sources: PartialCoordinatorConfig[] = [];

  // Load from file if specified or default exists
  const configPath = options.configPath || 'sync-coordinator.json';
  if (options.configPath || existsSync(configPath)) {
    sources.push(loadConfigFile(configPath));
  }

  // Load from environment
  sources.push(loadEnvConfig());

  // Apply programmatic overrides
  if (options.overrides) {
    sources.push(options.overrides);
  }

  const config = mergeConfig(DEFAULT_CONFIG, ...sources);
  configLog('Final config: %O', config);

  return config;
}


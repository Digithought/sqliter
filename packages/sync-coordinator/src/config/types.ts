/**
 * Configuration types for sync-coordinator.
 */

/**
 * CORS configuration.
 */
export interface CorsConfig {
  /** Allowed origins. true = all, false = none, string/array = specific origins */
  origin: boolean | string | string[];
  /** Whether to allow credentials (cookies, auth headers) */
  credentials: boolean;
}

/**
 * Authentication configuration.
 */
export interface AuthConfig {
  /** Authentication mode */
  mode: 'none' | 'token-whitelist' | 'custom';
  /** Allowed tokens for token-whitelist mode */
  tokens?: string[];
}

/**
 * Sync-specific settings (passed to SyncManager).
 */
export interface SyncSettings {
  /** Retention horizon in milliseconds: changes older than this are not guaranteed deliverable */
  retentionHorizonMs: number;
  /** Maximum changes per sync batch */
  batchSize: number;
}

/**
 * Logging configuration.
 */
export interface LoggingConfig {
  /** Log level */
  level: 'debug' | 'info' | 'warn' | 'error';
  /** Debug namespace filter (e.g., 'sync-coordinator:*') */
  namespaces?: string;
}

/**
 * Full coordinator configuration.
 */
export interface CoordinatorConfig {
  // Server settings
  /** Host to bind to */
  host: string;
  /** Port to listen on */
  port: number;
  /** Base path for all routes */
  basePath: string;

  // Data storage
  /** Directory for LevelDB data */
  dataDir: string;

  // CORS
  cors: CorsConfig;

  // Authentication
  auth: AuthConfig;

  // Sync settings
  sync: SyncSettings;

  // Logging
  logging: LoggingConfig;
}

/**
 * Default configuration values.
 */
export const DEFAULT_CONFIG: CoordinatorConfig = {
  host: '0.0.0.0',
  port: 3000,
  basePath: '/sync',
  dataDir: './.data',
  cors: {
    origin: true,
    credentials: true,
  },
  auth: {
    mode: 'none',
  },
  sync: {
    retentionHorizonMs: 30 * 24 * 60 * 60 * 1000, // 30 days
    batchSize: 1000,
  },
  logging: {
    level: 'info',
  },
};

/**
 * Partial configuration for merging.
 */
export type PartialCoordinatorConfig = {
  host?: string;
  port?: number;
  basePath?: string;
  dataDir?: string;
  cors?: Partial<CorsConfig>;
  auth?: Partial<AuthConfig>;
  sync?: Partial<SyncSettings>;
  logging?: Partial<LoggingConfig>;
};


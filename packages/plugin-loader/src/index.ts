/**
 * @quereus/plugin-loader
 * 
 * Plugin loading system for Quereus with dynamic import() support.
 * 
 * WARNING: This package uses dynamic import() which is NOT compatible with React Native.
 * For React Native environments, use static imports and manual plugin registration instead.
 */

// Re-export plugin loader functions
export {
	dynamicLoadModule,
	validatePluginUrl,
	loadPlugin,
	setRemoteModuleResolver,
	PluginHashMismatchError
} from './plugin-loader.js';
export type {
	PluginModule,
	LoadPluginOptions,
	RemoteModuleFetch,
	RemoteModuleResolver
} from './plugin-loader.js';
// The Node implementation of the resolver is deliberately NOT re-exported here —
// it imports node:fs, so it lives behind the '@quereus/plugin-loader/node' subpath
// where a browser bundle will never reach it.

// Re-export manifest types
export type {
	PluginManifest,
	PluginRecord,
	PluginSetting,
	VTablePluginInfo,
	FunctionPluginInfo,
	CollationPluginInfo,
	TypePluginInfo,
	PluginRegistrations
} from './manifest.js';

// Re-export config loader
export {
	interpolateEnvVars,
	interpolateConfigEnvVars,
	loadPluginsFromConfig,
	validateConfig,
	toPluginSqlConfig
} from './config-loader.js';
export type { PluginConfig, QuoombConfig } from './config-loader.js';


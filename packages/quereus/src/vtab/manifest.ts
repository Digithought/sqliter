import type { SqlValue } from '../common/types.js';
import type { FunctionSchema } from '../schema/function.js';
import type { CollationFunction } from '../util/comparison.js';
import type { TypePluginInfo } from '../types/plugin-interface.js';
import type { VirtualTableModule } from './module.js';
import type { VirtualTable } from './table.js';

// Re-export TypePluginInfo so it can be imported from this module
export type { TypePluginInfo };

/**
 * Configuration setting definition for a plugin
 */
export interface PluginSetting {
	key: string;                    // "path"
	label: string;                  // "JSON Path"
	type: 'string' | 'number' | 'boolean' | 'select';
	default?: SqlValue;
	options?: SqlValue[];           // for select type
	help?: string;
}

/**
 * Virtual table module registration info
 */
export interface VTablePluginInfo {
	name: string;
	module: VirtualTableModule<VirtualTable>;
	auxData?: unknown;
}

/**
 * Function registration info
 */
export interface FunctionPluginInfo {
	schema: FunctionSchema;        // complete function schema
}

/**
 * Collation registration info
 */
export interface CollationPluginInfo {
	name: string;                  // collation name
	func: CollationFunction;       // comparison function
	/** Optional key normalizer; required for the collation to be usable as the
	 *  key in a compound index. Without it, the collation works for ORDER BY but
	 *  any attempt to build an index keyed by it will fail at create time. */
	normalizer?: (s: string) => string;
}

/**
 * Plugin registration items - what the plugin wants to register
 */
export interface PluginRegistrations {
	vtables?: VTablePluginInfo[];
	functions?: FunctionPluginInfo[];
	collations?: CollationPluginInfo[];
	types?: TypePluginInfo[];
}

/**
 * Plugin manifest that describes the plugin's metadata and configuration options
 */
export interface PluginManifest {
	name: string;                   // "JSON_TABLE"
	version: string;                // "1.0.0"
	author?: string;
	description?: string;
	pragmaPrefix?: string;          // default = name, used for PRAGMA commands
	settings?: PluginSetting[];     // configuration options
	capabilities?: string[];        // e.g. ['scan', 'index', 'write']

	// Plugin type indicators (for UI display)
	provides?: {
		vtables?: string[];         // names of vtable modules provided
		functions?: string[];       // names of functions provided
		collations?: string[];      // names of collations provided
		types?: string[];           // names of types provided
	};
}

/**
 * Plugin record used for persistence across sessions
 */
export interface PluginRecord {
	id: string;                     // UUID for this installation
	url: string;                    // Full URL to the ES module
	enabled: boolean;               // Whether to load at startup
	manifest?: PluginManifest;      // Cached after first successful load
	config: Record<string, SqlValue>; // User-configured values
	/**
	 * SHA-256 (lowercase hex) of the module bytes last fetched from `url`, when
	 * the host fetched them over the network. Lets a host notice that remote
	 * code served from a stable URL has changed since it was installed. Absent
	 * for records installed before this was recorded, and for `file:` plugins.
	 */
	sha256?: string;
	/**
	 * When true, `sha256` is enforced *before* the module is imported: a host that
	 * verifies remote plugins refuses the load on a mismatch instead of warning
	 * after the code has already run. Absent or false keeps the warn-and-continue
	 * default.
	 *
	 * A pinned record with no `sha256` is not a violation — it is a first
	 * observation. The next successful load records a hash and enforcement starts
	 * from there.
	 *
	 * Only meaningful for `https:` records in a host that installed the Node remote
	 * resolver. Browsers import the URL directly with no verification step, and
	 * `file:` URLs never reach the resolver at all.
	 */
	pinned?: boolean;
}

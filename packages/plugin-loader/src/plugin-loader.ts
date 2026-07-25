import type { Database, SqlValue } from '@quereus/quereus';
import { registerPlugin } from '@quereus/quereus';
import type { PluginManifest, PluginRegistrations } from './manifest.js';
import debug from 'debug';

const log = debug('quereus:plugin-loader');

/**
 * Protocols a plugin module may be loaded from. Enforced inside
 * {@link dynamicLoadModule} (the single choke point every load path funnels
 * through) so no caller can reach the loader with a disallowed protocol, and
 * re-used by {@link validatePluginUrl} for pre-flight UI validation.
 */
const ALLOWED_PLUGIN_PROTOCOLS = ['https:', 'file:'];

/**
 * Plugin module interface - what we expect from a plugin module
 */
export interface PluginModule {
	/** Default export - the plugin registration function */
	default: (db: Database, config?: Record<string, SqlValue>) => Promise<PluginRegistrations> | PluginRegistrations;
}

interface PackageJson {
	name?: string;
	version?: string;
	author?: string;
	description?: string;
	quereus?: {
		pragmaPrefix?: string;
		settings?: PluginManifest['settings'];
		provides?: PluginManifest['provides'];
		capabilities?: string[];
	};
}

/**
 * Extracts plugin manifest from package.json metadata
 */
function extractManifestFromPackageJson(pkg: PackageJson): PluginManifest {
	const quereus = pkg.quereus ?? {};

	return {
		name: pkg.name ?? 'Unknown Plugin',
		version: pkg.version ?? '0.0.0',
		author: pkg.author,
		description: pkg.description,
		pragmaPrefix: quereus.pragmaPrefix,
		settings: quereus.settings,
		provides: quereus.provides,
		capabilities: quereus.capabilities
	};
}

/**
 * Validates that a plugin module has the expected structure.
 */
function assertValidPluginModule(mod: unknown, source: string): asserts mod is PluginModule {
	const m = mod as Record<string, unknown>;
	if (typeof m.default !== 'function') {
		throw new Error(`Module at ${source} has no default export function`);
	}
}

/**
 * Attempts to load a package.json manifest from a URL.
 * Returns undefined when the manifest is unavailable.
 */
async function tryLoadManifestFromUrl(moduleUrl: URL): Promise<PluginManifest | undefined> {
	try {
		const packageJsonUrl = new URL('package.json', moduleUrl);
		const response = await fetch(packageJsonUrl.toString());
		if (response.ok) {
			const pkg = await response.json() as PackageJson;
			return extractManifestFromPackageJson(pkg);
		}
	} catch {
		log('Could not load package.json for plugin at %s', moduleUrl);
	}
	return undefined;
}

/**
 * Dynamically loads and registers a plugin module
 *
 * @param url The URL to the ES module (can be https:// or file:// URL)
 * @param db The Database instance to register the module with
 * @param config Configuration values to pass to the module
 * @returns The plugin's manifest if available
 */
export async function dynamicLoadModule(
	url: string,
	db: Database,
	config: Record<string, SqlValue> = {}
): Promise<PluginManifest | undefined> {
	try {
		const moduleUrl = new URL(url);

		// Enforce the protocol allowlist here, at the loader itself, so a caller
		// that reaches dynamicLoadModule without going through validatePluginUrl
		// (e.g. the web worker's loadModule) still cannot load an arbitrary scheme.
		if (!ALLOWED_PLUGIN_PROTOCOLS.includes(moduleUrl.protocol)) {
			throw new Error(
				`Unsupported plugin URL protocol '${moduleUrl.protocol}'. ` +
				`Allowed: ${ALLOWED_PLUGIN_PROTOCOLS.join(', ')}.`
			);
		}

		// Add cache-busting timestamp for local development
		if (moduleUrl.protocol === 'file:' || moduleUrl.hostname === 'localhost') {
			moduleUrl.searchParams.set('t', Date.now().toString());
		}

		// Dynamic import with Vite ignore comment for bundler compatibility
		const mod: unknown = await import(/* @vite-ignore */ moduleUrl.toString());

		assertValidPluginModule(mod, url);

		await registerPlugin(db, mod.default, config);
		log('Loaded plugin from %s', url);

		return await tryLoadManifestFromUrl(moduleUrl);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to load plugin from ${url}: ${message}`);
	}
}

/**
 * Validates that a URL is likely to be a valid plugin module
 *
 * @param url The URL to validate
 * @returns true if the URL appears valid
 */
export function validatePluginUrl(url: string): boolean {
	try {
		const parsed = new URL(url);

		// Only allow secure protocols (shared with the loader's enforced allowlist)
		if (!ALLOWED_PLUGIN_PROTOCOLS.includes(parsed.protocol)) {
			return false;
		}

		// Must end with .js or .mjs
		if (!/\.(m?js)$/i.test(parsed.pathname)) {
			return false;
		}

		return true;
	} catch {
		return false;
	}
}


/** Loader options for loadPlugin */
export interface LoadPluginOptions {
	/**
	 * Environment hint. Defaults to auto-detection.
	 * 'browser' enables optional CDN resolution when allowCdn is true.
	 */
	env?: 'auto' | 'browser' | 'node';
	/**
	 * Allow resolving npm: specs to a public CDN in browser contexts.
	 * Disabled by default (opt-in).
	 */
	allowCdn?: boolean;
	/** Which CDN to use when allowCdn is true. Defaults to 'jsdelivr'. */
	cdn?: 'jsdelivr' | 'unpkg' | 'esm.sh';
}

/**
 * High-level plugin loader that accepts npm specs or direct URLs.
 *
 * Examples:
 * - npm:@scope/quereus-plugin-foo@^1
 * - @scope/quereus-plugin-foo (npm package name)
 * - https://raw.githubusercontent.com/user/repo/main/plugin.js
 * - file:///path/to/plugin.js (Node only)
 */
export async function loadPlugin(
	spec: string,
	db: Database,
	config: Record<string, SqlValue> = {},
	options: LoadPluginOptions = {}
): Promise<PluginManifest | undefined> {
	const env = resolveEnvironment(options.env);

	// Direct URL or file path via dynamicLoadModule
	if (isUrlLike(spec)) {
		return await dynamicLoadModule(spec, db, config);
	}

	// Interpret as npm spec or bare package name
	const npm = parseNpmSpec(spec);
	if (!npm) {
		throw new Error(
			`Invalid plugin spec: ${spec}. Use a URL, file://, or npm package (e.g., npm:@scope/name@version).`
		);
	}

	if (env === 'node') {
		return await loadFromNodePackage(npm, db, config);
	}

	// Browser path: npm spec requires CDN; only if explicitly allowed
	if (!options.allowCdn) {
		throw new Error(
			`Loading npm packages in the browser requires allowCdn=true. Received spec '${spec}'. ` +
			`Either provide a direct https:// URL to the ESM plugin or enable CDN resolution.`
		);
	}

	const cdnUrl = toCdnUrl(npm, options.cdn ?? 'jsdelivr');
	return await dynamicLoadModule(cdnUrl, db, config);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * @internal Exported for tests only — not re-exported from `index.js`, so it is
 * not part of the package's public API.
 */
export function resolveEnvironment(env?: 'auto' | 'browser' | 'node'): 'browser' | 'node' {
	if (env && env !== 'auto') return env;
	return isBrowserEnv() ? 'browser' : 'node';
}

function isBrowserEnv(): boolean {
	return typeof globalThis !== 'undefined'
		&& typeof (globalThis as unknown as { document?: unknown }).document !== 'undefined';
}

// NOTE: a spec with a disallowed scheme (e.g. 'http://host/p.js') is not
// url-like, so loadPlugin falls through to the npm branch and reports a package
// resolution failure rather than a protocol one. The load is still refused —
// only the message is confusing. If that error turns up in user reports, reject
// parseable-but-disallowed URL schemes here instead of letting them fall through.
function isUrlLike(s: string): boolean {
	try {
		const u = new URL(s);
		return u.protocol === 'https:' || u.protocol === 'file:';
	} catch {
		return false;
	}
}

/** @internal Exported for tests only — see {@link resolveEnvironment}. */
export interface NpmSpec {
	name: string;
	version?: string;
	subpath?: string;
}

/**
 * Parses an npm spec (`npm:@scope/name@version/subpath`, or a bare package
 * name) into its parts. Returns null for input that cannot be a package spec
 * (empty, or containing whitespace); it does *not* attempt full npm name
 * validation — resolution failures surface from the import itself.
 *
 * @internal Exported for tests only — see {@link resolveEnvironment}.
 */
export function parseNpmSpec(input: string): NpmSpec | null {
	const raw = input.startsWith('npm:') ? input.slice(4) : input;
	if (!raw || /\s/.test(raw)) return null;

	const { nameAndVersion, subpath } = splitSubpath(raw);
	return splitVersion(nameAndVersion, subpath);
}

function splitSubpath(raw: string): { nameAndVersion: string; subpath?: string } {
	if (raw.startsWith('@')) {
		const secondSlash = raw.indexOf('/', raw.indexOf('/') + 1);
		if (secondSlash !== -1) {
			return { nameAndVersion: raw.slice(0, secondSlash), subpath: raw.slice(secondSlash) };
		}
	} else {
		const firstSlash = raw.indexOf('/');
		if (firstSlash !== -1) {
			return { nameAndVersion: raw.slice(0, firstSlash), subpath: raw.slice(firstSlash) };
		}
	}
	return { nameAndVersion: raw };
}

function splitVersion(nameAndVersion: string, subpath?: string): NpmSpec {
	const atIndex = nameAndVersion.lastIndexOf('@');
	const startsWithScope = nameAndVersion.startsWith('@');

	if (atIndex > (startsWithScope ? 0 : -1)) {
		const name = nameAndVersion.slice(0, atIndex);
		const version = nameAndVersion.slice(atIndex + 1) || undefined;
		return { name, version, subpath };
	}
	return { name: nameAndVersion, subpath };
}

async function loadFromNodePackage(
	npm: NpmSpec,
	db: Database,
	config: Record<string, SqlValue>
): Promise<PluginManifest | undefined> {
	const subpathImport = `${npm.name}/plugin${npm.subpath ?? ''}`;
	const candidates = [subpathImport, `${npm.name}${npm.subpath ?? ''}`];

	const mod = await resolveFirstModule(candidates, npm.name);
	assertValidPluginModule(mod, npm.name);

	await registerPlugin(db, mod.default, config);
	log('Loaded plugin from package %s', npm.name);

	return await tryLoadManifestFromPackage(npm.name);
}

async function resolveFirstModule(candidates: string[], packageName: string): Promise<unknown> {
	let lastErr: unknown;
	for (const target of candidates) {
		try {
			return await import(/* @vite-ignore */ target);
		} catch (e) {
			lastErr = e;
		}
	}
	throw new Error(
		`Failed to resolve plugin package '${packageName}'. ` +
		`Ensure it exports './plugin' or a default module. ` +
		`Last error: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`
	);
}

async function tryLoadManifestFromPackage(packageName: string): Promise<PluginManifest | undefined> {
	try {
		const pkg = await import(/* @vite-ignore */ `${packageName}/package.json`, { with: { type: 'json' } });
		return extractManifestFromPackageJson(pkg.default as PackageJson);
	} catch {
		log('Could not load package.json for plugin %s', packageName);
		return undefined;
	}
}

/** @internal Exported for tests only — see {@link resolveEnvironment}. */
export function toCdnUrl(spec: NpmSpec, cdn: 'jsdelivr' | 'unpkg' | 'esm.sh'): string {
	const versionSegment = spec.version ? `@${spec.version}` : '';
	const subpath = spec.subpath ? spec.subpath.replace(/^\//, '') : 'plugin';
	switch (cdn) {
		case 'unpkg':
			return `https://unpkg.com/${spec.name}${versionSegment}/${subpath}`;
		case 'esm.sh':
			return `https://esm.sh/${spec.name}${versionSegment}/${subpath}`;
		case 'jsdelivr':
		default:
			return `https://cdn.jsdelivr.net/npm/${spec.name}${versionSegment}/${subpath}`;
	}
}

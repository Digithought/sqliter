/**
 * Round-trips `.plugin` subcommands (packages/quoomb-cli/src/commands/dot-commands.ts)
 * through `handleDotCommand` against a temp `~/.quoomb` and a stubbed `fetch`.
 *
 * The case that motivated these: a plugin whose `package.json` 404s beside the
 * module has no manifest, so every subcommand matching on `plugin.manifest?.name`
 * (`undefined`) could never find it again. Subcommands now accept the name
 * `.plugin list` prints — derived from the URL when there is no manifest — or the
 * install URL itself. Covered here: that round-trip, the manifest-name path it
 * had to leave alone, URL lookup, ambiguous derived names, a `package.json`
 * without a `name`, writing config values, and the autoload failure hint.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import os from 'node:os';
import { Database } from '@quereus/quereus';
import type { PluginRecord } from '@quereus/plugin-loader';
import { handleDotCommand, loadEnabledPlugins } from '../src/commands/dot-commands.js';
import { installRemotePluginResolver } from '../src/plugins/remote-resolver.js';
import type { Interface as ReadlineInterface } from 'node:readline';

const PLUGIN_SOURCE = 'export default function register() { return {}; }\n';

const MODULE_URL_NO_MANIFEST = 'https://plugins.example.test/dist/plain.mjs';
const MODULE_URL_WITH_MANIFEST = 'https://plugins.example.test/dist/named/plugin.mjs';

const readlineStub = {} as unknown as ReadlineInterface;

describe('.plugin subcommands', () => {
	let db: Database;
	let homeDir: string;
	let logSpy: ReturnType<typeof vi.spyOn>;
	/** URL → response, consulted by the stubbed `fetch`; anything else 404s. */
	let routes: Map<string, () => Response>;

	const serveModule = (url: string): void => {
		routes.set(url, () => new Response(PLUGIN_SOURCE, { status: 200, headers: { 'content-type': 'text/javascript' } }));
	};

	/** Serves a `package.json` beside `moduleUrl`, where the loader probes for it. */
	const serveManifest = (moduleUrl: string, pkg: Record<string, unknown>): void => {
		routes.set(new URL('package.json', moduleUrl).toString(), () => new Response(JSON.stringify(pkg), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		}));
	};

	beforeEach(async () => {
		homeDir = await mkdtemp(join(tmpdir(), 'quoomb-cli-plugins-'));
		vi.spyOn(os, 'homedir').mockReturnValue(homeDir);

		db = new Database();
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		routes = new Map();
		serveModule(MODULE_URL_NO_MANIFEST);
		serveModule(MODULE_URL_WITH_MANIFEST);
		serveManifest(MODULE_URL_WITH_MANIFEST, { name: 'named-plugin', version: '1.0.0' });
		vi.stubGlobal('fetch', (async (input: unknown) => (
			routes.get(String(input))?.() ?? new Response('not found', { status: 404 })
		)) as unknown as typeof fetch);
		installRemotePluginResolver();
	});

	afterEach(async () => {
		logSpy.mockRestore();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		await db.close();
		await rm(homeDir, { recursive: true, force: true });
	});

	const output = () => logSpy.mock.calls.flat().join('\n');

	const records = async (): Promise<PluginRecord[]> =>
		JSON.parse(await readFile(join(homeDir, '.quoomb', 'plugins.json'), 'utf-8'));

	it('installs, lists, disables, enables, reloads, configures and removes a manifest-less plugin by its derived name', async () => {
		await handleDotCommand(`.plugin install ${MODULE_URL_NO_MANIFEST}`, db, readlineStub);
		expect(output()).toContain('Successfully installed plugin: plain');
		expect(output()).not.toContain('Unknown');
		logSpy.mockClear();

		await handleDotCommand('.plugin list', db, readlineStub);
		expect(output()).toContain('plain');
		expect(output()).not.toContain('Unknown');
		logSpy.mockClear();

		await handleDotCommand('.plugin disable plain', db, readlineStub);
		expect(output()).toContain('Disabled plugin: plain');
		expect(output()).not.toContain('not found');
		logSpy.mockClear();

		await handleDotCommand('.plugin enable plain', db, readlineStub);
		expect(output()).toContain('Enabled plugin: plain');
		expect(output()).not.toContain('not found');
		logSpy.mockClear();

		await handleDotCommand('.plugin reload plain', db, readlineStub);
		expect(output()).toContain('Reloaded plugin: plain');
		expect(output()).not.toContain('not found');
		logSpy.mockClear();

		await handleDotCommand('.plugin config plain', db, readlineStub);
		expect(output()).not.toContain('not found');
		logSpy.mockClear();

		await handleDotCommand('.plugin remove plain', db, readlineStub);
		expect(output()).toContain('Removed plugin: plain');
		logSpy.mockClear();

		await handleDotCommand('.plugin list', db, readlineStub);
		expect(output()).toContain('No plugins installed');
	});

	it('still finds a plugin by its manifest name when package.json resolves', async () => {
		await handleDotCommand(`.plugin install ${MODULE_URL_WITH_MANIFEST}`, db, readlineStub);
		expect(output()).toContain('Successfully installed plugin: named-plugin');
		logSpy.mockClear();

		await handleDotCommand('.plugin disable named-plugin', db, readlineStub);
		expect(output()).toContain('Disabled plugin: named-plugin');
		logSpy.mockClear();

		await handleDotCommand('.plugin enable named-plugin', db, readlineStub);
		expect(output()).toContain('Enabled plugin: named-plugin');
	});

	it('accepts the install URL as an identifier, reporting the canonical name back', async () => {
		await handleDotCommand(`.plugin install ${MODULE_URL_WITH_MANIFEST}`, db, readlineStub);
		logSpy.mockClear();

		await handleDotCommand(`.plugin disable ${MODULE_URL_WITH_MANIFEST}`, db, readlineStub);
		expect(output()).toContain('Disabled plugin: named-plugin');
		expect(output()).not.toContain('not found');
		expect((await records())[0].enabled).toBe(false);
	});

	it('refuses to guess when two manifest-less plugins derive the same name', async () => {
		const first = 'https://a.example.test/dist/plugin.mjs';
		const second = 'https://b.example.test/dist/plugin.mjs';
		serveModule(first);
		serveModule(second);

		await handleDotCommand(`.plugin install ${first}`, db, readlineStub);
		await handleDotCommand(`.plugin install ${second}`, db, readlineStub);
		logSpy.mockClear();

		await handleDotCommand('.plugin remove plugin', db, readlineStub);
		expect(output()).toContain('ambiguous');
		expect(output()).toContain(first);
		expect(output()).toContain(second);
		expect(output()).not.toContain('Removed plugin');
		expect(await records()).toHaveLength(2);
		logSpy.mockClear();

		// The URLs the ambiguity report offered disambiguate it.
		await handleDotCommand(`.plugin remove ${second}`, db, readlineStub);
		expect(output()).toContain('Removed plugin: plugin');
		expect((await records()).map(p => p.url)).toEqual([first]);
	});

	it('derives a name when package.json has no name field, since the placeholder is not typeable', async () => {
		const url = 'https://nameless.example.test/dist/anon.mjs';
		serveModule(url);
		serveManifest(url, { version: '2.0.0' });

		await handleDotCommand(`.plugin install ${url}`, db, readlineStub);
		expect(output()).toContain('Successfully installed plugin: anon');
		// The loader names a nameless package.json 'Unknown Plugin', which the
		// whitespace-splitting argument parser could never receive as one word.
		expect((await records())[0].manifest?.name).toBe('Unknown Plugin');
		logSpy.mockClear();

		await handleDotCommand('.plugin disable anon', db, readlineStub);
		expect(output()).toContain('Disabled plugin: anon');
		expect((await records())[0].enabled).toBe(false);
	});

	it('writes a config value for a plugin addressed by its derived name', async () => {
		const url = 'https://settings.example.test/dist/tunable.mjs';
		serveModule(url);
		serveManifest(url, {
			version: '1.0.0',
			quereus: { settings: [{ key: 'depth', label: 'Depth', type: 'number', default: 1 }] },
		});

		await handleDotCommand(`.plugin install ${url}`, db, readlineStub);
		logSpy.mockClear();

		await handleDotCommand('.plugin config tunable depth=5', db, readlineStub);
		expect(output()).toContain('reloaded plugin: tunable');
		expect(output()).not.toContain('Unknown setting');
		expect((await records())[0].config).toEqual({ depth: 5 });
		logSpy.mockClear();

		await handleDotCommand('.plugin config tunable', db, readlineStub);
		expect(output()).toContain('depth: 5');
	});

	it('names a manifest-less plugin in the autoload failure hint', async () => {
		await handleDotCommand(`.plugin install ${MODULE_URL_NO_MANIFEST}`, db, readlineStub);
		logSpy.mockClear();

		// The host went away between install and the next CLI start.
		routes.delete(MODULE_URL_NO_MANIFEST);
		await loadEnabledPlugins(db);

		expect(output()).toContain('Failed to load plugin plain');
		expect(output()).toContain('.plugin enable plain');
		expect((await records())[0].enabled).toBe(false);
	});
});

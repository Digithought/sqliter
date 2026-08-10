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
 *
 * The `pinning` block covers the opt-in refusal path: `routes` can re-serve a
 * different body for the same URL, which is the "the remote code changed"
 * fixture, and the replacement body sets a global when it evaluates, so a test
 * can tell a refused load from a load that merely reported a mismatch.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { Database } from '@quereus/quereus';
import { dynamicLoadModule } from '@quereus/plugin-loader';
import type { PluginRecord } from '@quereus/plugin-loader';
import { handleDotCommand, loadEnabledPlugins, syncSavedPluginPins } from '../src/commands/dot-commands.js';
import { installRemotePluginResolver, setRecordPinnedHashes, seedConfigPluginPins } from '../src/plugins/remote-resolver.js';
import type { Interface as ReadlineInterface } from 'node:readline';

const PLUGIN_SOURCE = 'export default function register() { return {}; }\n';
/**
 * The same module, changed — as remote code served from a stable URL can be.
 * It marks a global as it evaluates, so a test can assert that a refused load
 * never ran the module body rather than only that it complained about it.
 */
const V2_MARKER = '__quoombPluginV2Evaluated';
const PLUGIN_SOURCE_V2 =
	`globalThis.${V2_MARKER} = true;\nexport default function register() { return {}; }\n`;

const sha256 = (source: string): string =>
	createHash('sha256').update(Buffer.from(source, 'utf8')).digest('hex');

const v2Evaluated = (): boolean =>
	(globalThis as unknown as Record<string, unknown>)[V2_MARKER] === true;

const MODULE_URL_NO_MANIFEST = 'https://plugins.example.test/dist/plain.mjs';
const MODULE_URL_WITH_MANIFEST = 'https://plugins.example.test/dist/named/plugin.mjs';

const readlineStub = {} as unknown as ReadlineInterface;

describe('.plugin subcommands', () => {
	let db: Database;
	let homeDir: string;
	let logSpy: ReturnType<typeof vi.spyOn>;
	/** Separate from `logSpy`: the pin-source conflict is the one thing that warns. */
	let warnSpy: ReturnType<typeof vi.spyOn>;
	/** URL → response, consulted by the stubbed `fetch`; anything else 404s. */
	let routes: Map<string, () => Response>;
	/** Every call the stubbed `fetch` saw, so a test can assert none happened. */
	let fetchCount: number;

	const serveModule = (url: string, source: string = PLUGIN_SOURCE): void => {
		routes.set(url, () => new Response(source, { status: 200, headers: { 'content-type': 'text/javascript' } }));
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
		warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		routes = new Map();
		fetchCount = 0;
		serveModule(MODULE_URL_NO_MANIFEST);
		serveModule(MODULE_URL_WITH_MANIFEST);
		serveManifest(MODULE_URL_WITH_MANIFEST, { name: 'named-plugin', version: '1.0.0' });
		vi.stubGlobal('fetch', (async (input: unknown) => {
			fetchCount++;
			return routes.get(String(input))?.() ?? new Response('not found', { status: 404 });
		}) as unknown as typeof fetch);
		delete (globalThis as unknown as Record<string, unknown>)[V2_MARKER];
		installRemotePluginResolver();
	});

	afterEach(async () => {
		logSpy.mockRestore();
		warnSpy.mockRestore();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		// The resolver and its pin tables are process-wide; leaving a pin behind
		// would gate the next test's loads.
		setRecordPinnedHashes([]);
		seedConfigPluginPins({ plugins: [] });
		await db.close();
		await rm(homeDir, { recursive: true, force: true });
	});

	const output = () => logSpy.mock.calls.flat().join('\n');
	const warnings = () => warnSpy.mock.calls.flat().join('\n');

	const records = async (): Promise<PluginRecord[]> =>
		JSON.parse(await readFile(join(homeDir, '.quoomb', 'plugins.json'), 'utf-8'));

	/** Hand-writes `plugins.json`, for record shapes no command produces. */
	const writeRecords = async (plugins: PluginRecord[]): Promise<void> => {
		await mkdir(join(homeDir, '.quoomb'), { recursive: true });
		await writeFile(join(homeDir, '.quoomb', 'plugins.json'), JSON.stringify(plugins, null, 2));
	};

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

	describe('pinning', () => {
		/** Installs the manifest-less plugin, pinned or not, and clears the log. */
		const install = async (options: { pin?: boolean } = {}): Promise<void> => {
			await handleDotCommand(
				`.plugin install ${MODULE_URL_NO_MANIFEST}${options.pin ? ' --pin' : ''}`,
				db,
				readlineStub
			);
			expect(output()).toContain('Successfully installed plugin: plain');
			logSpy.mockClear();
		};

		/** The remote code behind an installed URL changes under it. */
		const serveChangedBytes = (): void => serveModule(MODULE_URL_NO_MANIFEST, PLUGIN_SOURCE_V2);

		it('refuses a pinned plugin whose remote code changed, and changes nothing', async () => {
			await install({ pin: true });
			const before = (await records())[0];
			expect(before.pinned).toBe(true);
			expect(before.sha256).toBe(sha256(PLUGIN_SOURCE));

			serveChangedBytes();
			await handleDotCommand('.plugin reload plain', db, readlineStub);

			expect(output()).toContain('does not match its pinned hash');
			expect(output()).toContain(sha256(PLUGIN_SOURCE));
			expect(output()).toContain(sha256(PLUGIN_SOURCE_V2));
			expect(output()).toContain(".plugin trust plain");
			expect(output()).toContain(".plugin unpin plain");
			// Refused before the import, not after: the module body never ran.
			expect(v2Evaluated()).toBe(false);
			expect(await records()).toEqual([before]);
		});

		it('still only warns for an unpinned plugin whose remote code changed, and adopts it', async () => {
			await install();
			serveChangedBytes();

			await handleDotCommand('.plugin reload plain', db, readlineStub);

			expect(output()).toContain('has changed since it was installed');
			expect(output()).toContain('Reloaded plugin: plain');
			expect(v2Evaluated()).toBe(true);
			expect((await records())[0].sha256).toBe(sha256(PLUGIN_SOURCE_V2));
		});

		it('loads a pinned plugin whose bytes are unchanged, without complaint', async () => {
			await install({ pin: true });

			await handleDotCommand('.plugin reload plain', db, readlineStub);

			expect(output()).toContain('Reloaded plugin: plain');
			expect(output()).not.toContain('does not match');
			expect(output()).not.toContain('has changed');
		});

		it('treats a pinned record with no recorded hash as a first observation', async () => {
			await install({ pin: true });
			const [record] = await records();
			delete record.sha256;
			await writeRecords([record]);

			await handleDotCommand('.plugin reload plain', db, readlineStub);

			expect(output()).toContain('Reloaded plugin: plain');
			expect(output()).not.toContain('does not match');
			const [after] = await records();
			expect(after.sha256).toBe(sha256(PLUGIN_SOURCE));
			expect(after.pinned).toBe(true);
		});

		it('records a hash handed to `.plugin trust` without fetching or loading anything', async () => {
			await install({ pin: true });
			serveChangedBytes();
			const fetchesBefore = fetchCount;

			await handleDotCommand(`.plugin trust plain ${sha256(PLUGIN_SOURCE_V2)}`, db, readlineStub);

			expect(fetchCount).toBe(fetchesBefore);
			expect(v2Evaluated()).toBe(false);
			expect(output()).toContain('.plugin reload plain');
			expect((await records())[0].sha256).toBe(sha256(PLUGIN_SOURCE_V2));

			// And the new hash is live: the changed bytes now load.
			logSpy.mockClear();
			await handleDotCommand('.plugin reload plain', db, readlineStub);
			expect(output()).toContain('Reloaded plugin: plain');
		});

		it('fetches and digests the new version for `.plugin trust` with no hash, without loading it', async () => {
			await install({ pin: true });
			serveChangedBytes();

			await handleDotCommand('.plugin trust plain', db, readlineStub);

			expect(output()).toContain(sha256(PLUGIN_SOURCE));
			expect(output()).toContain(sha256(PLUGIN_SOURCE_V2));
			expect(v2Evaluated()).toBe(false);
			expect((await records())[0].sha256).toBe(sha256(PLUGIN_SOURCE_V2));
		});

		it('refuses a `.plugin trust` argument that is not a SHA-256, leaving the record alone', async () => {
			await install({ pin: true });

			await handleDotCommand('.plugin trust plain deadbeef', db, readlineStub);

			expect(output()).toContain('Not a SHA-256');
			expect((await records())[0].sha256).toBe(sha256(PLUGIN_SOURCE));
		});

		it('records nothing when `.plugin trust` cannot fetch the module', async () => {
			await install({ pin: true });
			routes.delete(MODULE_URL_NO_MANIFEST);

			await handleDotCommand('.plugin trust plain', db, readlineStub);

			expect(output()).toContain('Could not fetch');
			expect(output()).toContain('Nothing was changed');
			expect((await records())[0].sha256).toBe(sha256(PLUGIN_SOURCE));
		});

		it('lets an unpin take effect in the same session', async () => {
			await install({ pin: true });
			serveChangedBytes();
			await handleDotCommand('.plugin reload plain', db, readlineStub);
			expect(output()).toContain('does not match its pinned hash');
			logSpy.mockClear();

			await handleDotCommand('.plugin unpin plain', db, readlineStub);
			expect((await records())[0].pinned).toBe(false);
			logSpy.mockClear();

			// Same process, no restart: the pin table is rebuilt from the records.
			await handleDotCommand('.plugin reload plain', db, readlineStub);
			expect(output()).toContain('Reloaded plugin: plain');
			expect(v2Evaluated()).toBe(true);
		});

		it('leaves a plugin enabled when a pin refuses it during autoload', async () => {
			await install({ pin: true });
			const before = (await records())[0];
			serveChangedBytes();

			await loadEnabledPlugins(db);

			expect(output()).toContain('Refused to load plugin plain');
			expect(output()).toContain(".plugin trust plain");
			expect(output()).toContain(".plugin unpin plain");
			expect(output()).not.toContain('Disabled it');
			expect(v2Evaluated()).toBe(false);
			expect(await records()).toEqual([before]);
		});

		it('keeps loading the other plugins when one autoloaded plugin fails its pin', async () => {
			await install({ pin: true });
			await handleDotCommand(`.plugin install ${MODULE_URL_WITH_MANIFEST}`, db, readlineStub);
			serveChangedBytes();
			logSpy.mockClear();

			await loadEnabledPlugins(db);

			expect(output()).toContain('Refused to load plugin plain');
			const after = await records();
			expect(after.map(p => p.enabled)).toEqual([true, true]);
		});

		it('pins a URL held by two records when only one of them is pinned', async () => {
			await install();
			const [record] = await records();
			// Only reachable by hand-editing plugins.json — install refuses a URL it
			// already holds. The strictest entry wins: the URL is pinned.
			await writeRecords([
				{ ...record, id: 'unpinned-copy' },
				{ ...record, id: 'pinned-copy', pinned: true },
			]);
			serveChangedBytes();

			await handleDotCommand(`.plugin reload ${MODULE_URL_NO_MANIFEST}`, db, readlineStub);

			expect(output()).toContain('does not match its pinned hash');
			expect(v2Evaluated()).toBe(false);
		});

		it('surfaces a hand-edited pin that is not a valid hash, rather than flattening it', async () => {
			await install({ pin: true });
			const [record] = await records();
			await writeRecords([{ ...record, sha256: 'not-a-real-hash' }]);

			await handleDotCommand('.plugin reload plain', db, readlineStub);

			expect(output()).toContain('not 64 hex characters');
			expect(v2Evaluated()).toBe(false);
		});

		it('reports a pin violation from `.plugin enable`, leaving the record disabled', async () => {
			await install({ pin: true });
			await handleDotCommand('.plugin disable plain', db, readlineStub);
			serveChangedBytes();
			logSpy.mockClear();

			await handleDotCommand('.plugin enable plain', db, readlineStub);

			expect(output()).toContain('does not match its pinned hash');
			expect(output()).toContain('.plugin trust plain');
			expect(output()).not.toContain('Enabled plugin');
			expect(v2Evaluated()).toBe(false);
			expect((await records())[0].enabled).toBe(false);
		});

		it('keeps a `.plugin config` change but reports the pin that stopped its reload', async () => {
			// Needs a manifest: `.plugin config` only accepts a declared setting.
			const url = 'https://settings.example.test/dist/tunable.mjs';
			serveModule(url);
			serveManifest(url, {
				name: 'tunable',
				version: '1.0.0',
				quereus: { settings: [{ key: 'depth', label: 'Depth', type: 'number', default: 1 }] },
			});
			await handleDotCommand(`.plugin install ${url} --pin`, db, readlineStub);
			serveModule(url, PLUGIN_SOURCE_V2);
			logSpy.mockClear();

			await handleDotCommand('.plugin config tunable depth=5', db, readlineStub);

			expect(output()).toContain('Configuration updated');
			expect(output()).toContain('does not match its pinned hash');
			expect(v2Evaluated()).toBe(false);
			const [after] = await records();
			expect(after.config).toEqual({ depth: 5 });
			expect(after.sha256).toBe(sha256(PLUGIN_SOURCE));
		});

		it('drops a removed plugin\'s pin in the same session, so the URL can be reinstalled', async () => {
			await install({ pin: true });
			serveChangedBytes();

			await handleDotCommand('.plugin remove plain', db, readlineStub);
			logSpy.mockClear();

			await handleDotCommand(`.plugin install ${MODULE_URL_NO_MANIFEST}`, db, readlineStub);

			expect(output()).toContain('Successfully installed plugin: plain');
			expect(output()).not.toContain('does not match');
			expect((await records())[0].sha256).toBe(sha256(PLUGIN_SOURCE_V2));
		});

		it('refuses `--pin` for a file: URL rather than recording a pin that can never fire', async () => {
			await handleDotCommand('.plugin install file:///plugins/local.mjs --pin', db, readlineStub);

			expect(output()).toContain('Cannot install');
			expect(output()).toContain('https:');
			expect(output()).not.toContain('Installing plugin from');
			await expect(records()).rejects.toThrow();
		});

		it('rejects an unrecognized install flag instead of treating it as the URL', async () => {
			await handleDotCommand(`.plugin install ${MODULE_URL_NO_MANIFEST} --pinn`, db, readlineStub);

			expect(output()).toContain('Unknown option: --pinn');
			expect(output()).toContain('Usage: .plugin install');
			await expect(records()).rejects.toThrow();
		});

		it('refuses to pin or trust a hash for a file: plugin, whose bytes are never fetched', async () => {
			await writeRecords([{
				id: 'local',
				url: 'file:///plugins/local.mjs',
				enabled: true,
				config: {},
			}]);

			await handleDotCommand('.plugin pin local', db, readlineStub);
			expect(output()).toContain('Cannot pin');
			expect(output()).toContain('https:');
			expect((await records())[0].pinned).toBeUndefined();
			logSpy.mockClear();

			await handleDotCommand('.plugin trust local', db, readlineStub);
			expect(output()).toContain('Cannot trust a hash');
			expect((await records())[0].sha256).toBeUndefined();
		});

		it('pins an already-installed plugin, and says enforcement starts at the recorded hash', async () => {
			await install();

			await handleDotCommand('.plugin pin plain', db, readlineStub);

			expect(output()).toContain('Pinned plugin: plain');
			expect(output()).toContain(sha256(PLUGIN_SOURCE));
			expect((await records())[0].pinned).toBe(true);
			logSpy.mockClear();

			// The pin is live immediately, not at the next start.
			serveChangedBytes();
			await handleDotCommand('.plugin reload plain', db, readlineStub);
			expect(output()).toContain('does not match its pinned hash');
		});

		it('applies a saved pin to a load that never goes through the record path', async () => {
			await install({ pin: true });
			serveChangedBytes();
			// A fresh process that is about to load plugins from quoomb.config.json:
			// nothing has synced the records yet.
			setRecordPinnedHashes([]);

			await syncSavedPluginPins();

			await expect(dynamicLoadModule(MODULE_URL_NO_MANIFEST, db, {})).rejects.toThrow(/pinned SHA-256/);
			expect(v2Evaluated()).toBe(false);
		});

		it('does not evaluate the module when re-installing a URL it already holds', async () => {
			await install({ pin: true });
			serveChangedBytes();
			const fetchesBefore = fetchCount;

			await handleDotCommand(`.plugin install ${MODULE_URL_NO_MANIFEST}`, db, readlineStub);

			expect(output()).toContain('already installed');
			// The duplicate check runs before the load, so the changed bytes were
			// never fetched, let alone imported.
			expect(fetchCount).toBe(fetchesBefore);
			expect(v2Evaluated()).toBe(false);
		});

		describe('config-declared pins', () => {
			it('loads a config-declared hash that matches what is served, without complaint', async () => {
				serveModule(MODULE_URL_NO_MANIFEST);
				seedConfigPluginPins({ plugins: [{ source: MODULE_URL_NO_MANIFEST, sha256: sha256(PLUGIN_SOURCE) }] });

				await expect(dynamicLoadModule(MODULE_URL_NO_MANIFEST, db, {})).resolves.toBeUndefined();
			});

			it('refuses a config-declared hash that does not match, before importing the module', async () => {
				seedConfigPluginPins({ plugins: [{ source: MODULE_URL_NO_MANIFEST, sha256: sha256(PLUGIN_SOURCE_V2) }] });

				await expect(dynamicLoadModule(MODULE_URL_NO_MANIFEST, db, {})).rejects.toThrow(/pinned SHA-256/);
				expect(v2Evaluated()).toBe(false);
			});

			it('prefers the config hash over a disagreeing saved-record hash', async () => {
				await install({ pin: true });
				serveChangedBytes();

				seedConfigPluginPins({ plugins: [{ source: MODULE_URL_NO_MANIFEST, sha256: sha256(PLUGIN_SOURCE_V2) }] });

				// The record still pins the old hash; the config's hash wins, so the
				// changed bytes — which the record alone would have refused — load.
				await expect(dynamicLoadModule(MODULE_URL_NO_MANIFEST, db, {})).resolves.toBeUndefined();
				expect(v2Evaluated()).toBe(true);
			});

			it('rejects a config sha256 declared on a non-https source at seed time, before any load', () => {
				expect(() => seedConfigPluginPins({
					plugins: [{ source: 'npm:@scope/foo', sha256: sha256(PLUGIN_SOURCE) }]
				})).toThrow(/not an https/);
			});

			it('rejects a malformed config sha256 at seed time, before any load', () => {
				expect(() => seedConfigPluginPins({
					plugins: [{ source: MODULE_URL_NO_MANIFEST, sha256: 'deadbeef' }]
				})).toThrow(/64 hex characters/);
			});

			it('rejects an empty config sha256 rather than reading it as "not pinned"', async () => {
				expect(() => seedConfigPluginPins({
					plugins: [{ source: MODULE_URL_NO_MANIFEST, sha256: '' }]
				})).toThrow(/64 hex characters/);

				// And the entry did not quietly become an unpinned load.
				serveChangedBytes();
				await expect(dynamicLoadModule(MODULE_URL_NO_MANIFEST, db, {})).resolves.toBeUndefined();
				expect(v2Evaluated()).toBe(true);
			});

			it('reports every unusable sha256 at once, not only the first', () => {
				expect(() => seedConfigPluginPins({
					plugins: [
						{ source: 'npm:@scope/foo', sha256: sha256(PLUGIN_SOURCE) },
						{ source: MODULE_URL_WITH_MANIFEST, sha256: 'deadbeef' },
					]
				})).toThrow(/declares 2 unusable sha256[\s\S]*not an https[\s\S]*64 hex characters/);
			});

			it('still seeds the entries that validated when a sibling entry is unusable', async () => {
				// The caller abandons this config's plugin load, but the URL is also
				// reachable from the saved records, and the config's statement about
				// it stands.
				expect(() => seedConfigPluginPins({
					plugins: [
						{ source: MODULE_URL_NO_MANIFEST, sha256: sha256(PLUGIN_SOURCE) },
						{ source: 'npm:@scope/foo', sha256: sha256(PLUGIN_SOURCE) },
					]
				})).toThrow();

				serveChangedBytes();
				await expect(dynamicLoadModule(MODULE_URL_NO_MANIFEST, db, {})).rejects.toThrow(/pinned SHA-256/);
				expect(v2Evaluated()).toBe(false);
			});

			it('rejects a config that pins one URL to two different hashes', () => {
				expect(() => seedConfigPluginPins({
					plugins: [
						{ source: MODULE_URL_NO_MANIFEST, sha256: sha256(PLUGIN_SOURCE) },
						// Differs only in host case, so it is the same download.
						{ source: MODULE_URL_NO_MANIFEST.replace('plugins.', 'PLUGINS.'), sha256: sha256(PLUGIN_SOURCE_V2) },
					]
				})).toThrow(/listed more than once/);
			});

			it('accepts the same URL declared twice with the same hash', () => {
				expect(() => seedConfigPluginPins({
					plugins: [
						{ source: MODULE_URL_NO_MANIFEST, sha256: sha256(PLUGIN_SOURCE) },
						{ source: MODULE_URL_NO_MANIFEST, sha256: sha256(PLUGIN_SOURCE).toUpperCase() },
					]
				})).not.toThrow();
			});

			it('warns once when the config and a saved record pin the same URL differently', async () => {
				await install({ pin: true });
				await syncSavedPluginPins();

				seedConfigPluginPins({ plugins: [{ source: MODULE_URL_NO_MANIFEST, sha256: sha256(PLUGIN_SOURCE_V2) }] });

				expect(warnings()).toContain(MODULE_URL_NO_MANIFEST);
				expect(warnings()).toContain(sha256(PLUGIN_SOURCE_V2));
				expect(warnings()).toContain(sha256(PLUGIN_SOURCE));
				expect(warnSpy.mock.calls.length).toBe(1);
			});

			it('says a config pin outranks the record when `.plugin pin` and `trust` report one', async () => {
				await install();
				seedConfigPluginPins({ plugins: [{ source: MODULE_URL_NO_MANIFEST, sha256: sha256(PLUGIN_SOURCE_V2) }] });

				await handleDotCommand('.plugin pin plain', db, readlineStub);
				expect(output()).toContain('quoomb.config.json pins');
				expect(output()).toContain(sha256(PLUGIN_SOURCE_V2));
				logSpy.mockClear();

				// `.plugin trust <hash>` touches no network and reports the same way.
				await handleDotCommand(`.plugin trust plain ${sha256(PLUGIN_SOURCE)}`, db, readlineStub);
				expect(output()).toContain('quoomb.config.json pins');
				logSpy.mockClear();

				// Once the record agrees with the config there is nothing to warn about.
				await handleDotCommand(`.plugin trust plain ${sha256(PLUGIN_SOURCE_V2)}`, db, readlineStub);
				expect(output()).not.toContain('quoomb.config.json pins');
			});

			it('points a config-caused refusal at the config file, not at `.plugin trust`', async () => {
				await install({ pin: true });
				seedConfigPluginPins({ plugins: [{ source: MODULE_URL_NO_MANIFEST, sha256: sha256(PLUGIN_SOURCE) }] });
				serveChangedBytes();
				logSpy.mockClear();

				await handleDotCommand('.plugin reload plain', db, readlineStub);

				expect(output()).toContain('does not match its pinned hash');
				expect(output()).toContain('declared in quoomb.config.json');
				expect(output()).not.toContain(`.plugin trust plain' to accept`);
				expect(v2Evaluated()).toBe(false);
			});
		});
	});
});

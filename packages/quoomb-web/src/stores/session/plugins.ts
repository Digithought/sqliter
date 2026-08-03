import type { SqlValue } from '@quereus/quereus';
import type { PluginRecord } from '../../worker/types.js';
import { validatePluginUrl, interpolateConfigEnvVars, toPluginSqlConfig } from '@quereus/plugin-loader';
import { useSettingsStore } from '../settingsStore.js';
import { useConfigStore } from '../configStore.js';
import type { StoreSet, StoreGet } from './types.js';

export function createPluginActions(set: StoreSet, get: StoreGet) {
	return {
		installPlugin: async (url: string) => {
			const { api } = get();

			if (!api) {
				throw new Error('Database not connected');
			}

			// Validate URL format
			if (!validatePluginUrl(url)) {
				throw new Error('Invalid plugin URL. Must be https:// or file:// URL ending in .js or .mjs');
			}

			try {
				// Try to load the plugin
				const manifest = await api.loadModule(url, {});

				// Create plugin record
				const pluginRecord: PluginRecord = {
					id: crypto.randomUUID(),
					url,
					enabled: true,
					manifest,
					config: {},
				};

				// Add to settings store
				useSettingsStore.getState().addPlugin(pluginRecord);

				// Update runtime state
				set((state) => ({
					loadedPlugins: new Set([...state.loadedPlugins, pluginRecord.id]),
				}));

				// Clear any previous error
				get().clearPluginError(pluginRecord.id);
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : 'Unknown error';
				throw new Error(`Failed to install plugin: ${errorMessage}`);
			}
		},

		togglePlugin: async (id: string, enabled: boolean) => {
			const { api, loadedPlugins } = get();
			const plugins = useSettingsStore.getState().plugins;
			const plugin = plugins.find(p => p.id === id);

			if (!plugin) {
				throw new Error('Plugin not found');
			}

			if (!api) {
				throw new Error('Database not connected');
			}

			try {
				if (enabled && !loadedPlugins.has(id)) {
					// Load the plugin
					const manifest = await api.loadModule(plugin.url, plugin.config);

					// Update manifest if it changed
					if (manifest) {
						useSettingsStore.getState().updatePlugin(id, { manifest });
					}

					set((state) => ({
						loadedPlugins: new Set([...state.loadedPlugins, id]),
					}));

					get().clearPluginError(id);
				} else if (!enabled && loadedPlugins.has(id)) {
					// Note: We can't unload modules at runtime, so we just mark as disabled
					// The plugin will not be loaded on next session start
					set((state) => {
						const newLoadedPlugins = new Set(state.loadedPlugins);
						newLoadedPlugins.delete(id);
						return { loadedPlugins: newLoadedPlugins };
					});
				}

				// Update the enabled state
				useSettingsStore.getState().updatePlugin(id, { enabled });
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : 'Unknown error';
				set((state) => ({
					pluginErrors: new Map(state.pluginErrors).set(id, errorMessage),
				}));
				throw error;
			}
		},

		updatePluginConfig: async (id: string, config: Record<string, SqlValue>) => {
			const { api, loadedPlugins } = get();
			const plugins = useSettingsStore.getState().plugins;
			const plugin = plugins.find(p => p.id === id);

			if (!plugin) {
				throw new Error('Plugin not found');
			}

			if (!api) {
				throw new Error('Database not connected');
			}

			// Update the config in settings
			useSettingsStore.getState().updatePlugin(id, { config });

			// If plugin is currently loaded, we need to reload it with new config
			if (loadedPlugins.has(id)) {
				try {
					await api.loadModule(plugin.url, config);
					get().clearPluginError(id);
				} catch (error) {
					const errorMessage = error instanceof Error ? error.message : 'Unknown error';
					set((state) => ({
						pluginErrors: new Map(state.pluginErrors).set(id, errorMessage),
					}));
					throw error;
				}
			}
		},

		reloadPlugin: async (id: string) => {
			const { api } = get();
			const plugins = useSettingsStore.getState().plugins;
			const plugin = plugins.find(p => p.id === id);

			if (!plugin) {
				throw new Error('Plugin not found');
			}

			if (!api) {
				throw new Error('Database not connected');
			}

			try {
				const manifest = await api.loadModule(plugin.url, plugin.config);

				// Update manifest if it changed
				if (manifest) {
					useSettingsStore.getState().updatePlugin(id, { manifest });
				}

				set((state) => ({
					loadedPlugins: new Set([...state.loadedPlugins, id]),
				}));

				get().clearPluginError(id);
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : 'Unknown error';
				set((state) => ({
					pluginErrors: new Map(state.pluginErrors).set(id, errorMessage),
				}));
				throw error;
			}
		},

		getPluginError: (id: string) => {
			return get().pluginErrors.get(id);
		},

		clearPluginError: (id: string) => {
			set((state) => {
				const newErrors = new Map(state.pluginErrors);
				newErrors.delete(id);
				return { pluginErrors: newErrors };
			});
		},

		loadEnabledPlugins: async () => {
			const { api } = get();
			if (!api) return;

			// First, load plugins from config if available
			const configState = useConfigStore.getState();
			if (configState.config && configState.config.plugins && configState.config.autoload !== false) {
				const config = interpolateConfigEnvVars(configState.config);

				// The browser imports `https:` URLs natively — there is no remote
				// resolver here to hash the bytes against — so a config-declared
				// `sha256` is inert. Say so: silence would leave a user believing the
				// pin they wrote in the config file is being enforced.
				const unverifiable = (config.plugins || []).filter(p => p.sha256).map(p => p.source);
				if (unverifiable.length > 0) {
					console.warn(
						`quoomb.config.json declares sha256 for ${unverifiable.join(', ')}, but the browser ` +
						'cannot verify plugin bytes before importing them; those hashes are not enforced here. ' +
						'Load these plugins through the quoomb CLI for a checked load.'
					);
				}

				for (const pluginConfig of config.plugins || []) {
					try {
						// Pass the config object through unflattened so structured settings
						// (e.g. IndexedDB's `cache`) reach the plugin as objects, not JSON strings.
						await api.loadModule(pluginConfig.source, toPluginSqlConfig(pluginConfig.config));
					} catch (error) {
						console.warn(`Failed to load plugin from config ${pluginConfig.source}:`, error);
					}
				}
			}

			// Then load plugins from settings (legacy plugin storage)
			const plugins = useSettingsStore.getState().plugins;
			const enabledPlugins = plugins.filter(p => p.enabled);

			for (const plugin of enabledPlugins) {
				try {
					const manifest = await api.loadModule(plugin.url, plugin.config);

					// Update manifest if it changed
					if (manifest && (!plugin.manifest || plugin.manifest.version !== manifest.version)) {
						useSettingsStore.getState().updatePlugin(plugin.id, { manifest });
					}

					set((state) => ({
						loadedPlugins: new Set([...state.loadedPlugins, plugin.id]),
					}));

					get().clearPluginError(plugin.id);
				} catch (error) {
					console.error(`Failed to load plugin ${plugin.url}:`, error);
					const errorMessage = error instanceof Error ? error.message : 'Unknown error';
					set((state) => ({
						pluginErrors: new Map(state.pluginErrors).set(plugin.id, errorMessage),
					}));

					// Disable the plugin if it failed to load
					useSettingsStore.getState().updatePlugin(plugin.id, { enabled: false });
				}
			}
		},
	};
}

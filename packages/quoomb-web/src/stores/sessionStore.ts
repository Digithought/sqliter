import { create } from 'zustand';
import { subscribeWithSelector, persist } from 'zustand/middleware';
import { QuereusWorkerAPI, SyncStatus, SyncEvent } from '../worker/types.js';
import { unwrapError } from '@quereus/quereus';
import { useSettingsStore } from './settingsStore.js';
import * as Comlink from 'comlink';

import { createTabActions } from './session/tabs.js';
import { createExportActions } from './session/export.js';
import { createPluginActions } from './session/plugins.js';
import { createSyncActions } from './session/sync.js';

// Re-export types from the shared types module
export type { QueryResult, Tab, SessionState } from './session/types.js';
import type { QueryResult, Tab, SessionState, StoreSet, StoreGet } from './session/types.js';

/**
 * Shared body for the `fetch*` actions that lazily populate one field of the
 * active query result (plan / program / trace / row-trace / plan-graph). Each
 * differs only in the result field it writes, the worker API call it makes, and
 * the label used in the error log — so they collapse to this one helper.
 */
async function fetchIntoActiveResult(
	get: StoreGet,
	set: StoreSet,
	field: keyof QueryResult,
	label: string,
	run: (api: Comlink.Remote<QuereusWorkerAPI>) => Promise<unknown>,
): Promise<void> {
	const { api, isConnected, activeResultId } = get();
	if (!api || !isConnected) throw new Error('Not connected to database');

	try {
		const value = await run(api);
		if (activeResultId) {
			const patch = { [field]: value } as Partial<QueryResult>;
			set((state) => ({
				...state,
				queryHistory: state.queryHistory.map(r =>
					r.id === activeResultId ? { ...r, ...patch } : r
				),
			}));
		}
	} catch (error) {
		console.error(`Failed to fetch ${label}:`, error);
		throw error;
	}
}

export const useSessionStore = create<SessionState>()(
	persist(
		subscribeWithSelector(
			(set, get) => ({
				// Initial state
				isConnected: false,
				isConnecting: false,
				connectionError: null,
				worker: null,
				api: null,

				sessionId: null,
				tabs: [],
				activeTabId: null,

				isExecuting: false,
				currentQuery: null,
				queryHistory: [],

				activeResultId: null,
				selectedPanel: 'result',

				loadedPlugins: new Set(),
				pluginErrors: new Map(),

				unsavedChangesDialog: {
					isOpen: false,
					tabId: null,
					fileName: '',
				},

				navigateToError: null,

				syncStatus: { status: 'disconnected' } as SyncStatus,
				syncEvents: [],

				// --- Connection & session lifecycle ---

				initializeSession: async () => {
					const { isConnecting, isConnected } = get();
					if (isConnecting || isConnected) return;

					set(() => ({
						isConnecting: true,
						connectionError: null,
					}));

					try {
						const worker = new Worker(
							new URL('../worker/quereus.worker.ts', import.meta.url),
							{ type: 'module' }
						);

						const api = Comlink.wrap<QuereusWorkerAPI>(worker);
						await api.initialize();

						const { storageModule, syncUrl, syncDatabaseId } = useSettingsStore.getState();
						await api.setStorageModule(storageModule);

						const sessionId = crypto.randomUUID();

						const initialTab: Tab = {
							id: crypto.randomUUID(),
							name: 'scratch.sql',
							content: 'SELECT \'Hello, Quoomb!\' as message;',
							isActive: true,
							isDirty: false,
						};

						set((state) => {
							if (state.tabs.length === 0) {
								return {
									...state,
									worker, api, sessionId,
									isConnected: true,
									isConnecting: false,
									tabs: [initialTab],
									activeTabId: initialTab.id,
								};
							} else {
								const hasActiveTab = state.tabs.some(tab => tab.isActive);
								const updatedTabs = hasActiveTab
									? state.tabs
									: state.tabs.map((tab, index) => ({
											...tab,
											isActive: index === 0
										}));

								return {
									...state,
									worker, api, sessionId,
									isConnected: true,
									isConnecting: false,
									tabs: updatedTabs,
									activeTabId: state.activeTabId || (updatedTabs.length > 0 ? updatedTabs[0].id : null),
								};
							}
						});

						await get().loadEnabledPlugins();

						if (storageModule === 'sync') {
							set({ syncStatus: { status: 'disconnected' } });

							try {
								await api.onSyncEvent(Comlink.proxy(async (event: SyncEvent) => {
									get().addSyncEvent(event);
									if (event.type === 'state-change') {
										const status = await api.getSyncStatus();
										if (status) {
											get().setSyncStatus(status);
										}
									}
								}));

								if (syncUrl && syncDatabaseId) {
									set({ syncStatus: { status: 'connecting' } });
									await api.connectSync(syncUrl, syncDatabaseId);
								}
							} catch (error) {
								console.warn('Failed to initialize sync:', error);
								set({ syncStatus: { status: 'disconnected' } });
							}
						}
					} catch (error) {
						set(() => ({
							isConnecting: false,
							connectionError: error instanceof Error ? error.message : 'Failed to initialize session',
						}));
					}
				},

				disconnect: async () => {
					const { worker, api } = get();

					try {
						if (api) {
							await api.close();
						}
						if (worker) {
							worker.terminate();
						}
					} catch (error) {
						console.warn('Error during disconnect:', error);
					}

					set(() => ({
						isConnected: false,
						worker: null,
						api: null,
						sessionId: null,
						syncStatus: { status: 'disconnected' } as SyncStatus,
						syncEvents: [],
					}));
				},

				// --- Query execution ---

				executeSQL: async (sql, selectionInfo) => {
					const { api, isConnected } = get();

					if (!api || !isConnected) {
						throw new Error('Not connected to database');
					}

					set((state) => ({
						...state,
						isExecuting: true,
						currentQuery: sql,
					}));

					const startTime = Date.now();
					const resultId = crypto.randomUUID();

					try {
						const results = await api.executeQuery(sql);
						const executionTime = Date.now() - startTime;

						const queryResult: QueryResult = {
							id: resultId, sql, results, executionTime,
							timestamp: new Date(),
							planMode: 'estimated',
							selectionInfo,
						};

						set((state) => ({
							...state,
							queryHistory: [queryResult, ...state.queryHistory],
							activeResultId: resultId,
							isExecuting: false,
							currentQuery: null,
						}));
					} catch (error) {
						const executionTime = Date.now() - startTime;
						const errorMessage = error instanceof Error ? error.message : 'Unknown error';
						const errorChain = error instanceof Error ? unwrapError(error) : [];

						const queryResult: QueryResult = {
							id: resultId, sql,
							error: errorMessage, errorChain, executionTime,
							timestamp: new Date(),
							planMode: 'estimated',
							selectionInfo,
						};

						set((state) => ({
							...state,
							queryHistory: [queryResult, ...state.queryHistory],
							activeResultId: resultId,
							isExecuting: false,
							currentQuery: null,
						}));
					}
				},

				fetchQueryPlan: (sql) =>
					fetchIntoActiveResult(get, set, 'queryPlan', 'query plan', (api) => api.explainQuery(sql)),

				fetchProgram: (sql) =>
					fetchIntoActiveResult(get, set, 'program', 'query program', (api) => api.explainProgram(sql)),

				fetchTrace: (sql) =>
					fetchIntoActiveResult(get, set, 'trace', 'query trace', (api) => api.executionTrace(sql)),

				fetchRowTrace: (sql) =>
					fetchIntoActiveResult(get, set, 'rowTrace', 'query row trace', (api) => api.rowTrace(sql)),

				fetchPlanGraph: (sql, withActual) =>
					fetchIntoActiveResult(get, set, 'planGraph', 'query plan graph', (api) => api.explainPlanGraph(sql, { withActual })),

				// --- UI state ---

				setSelectedPanel: (panel) => {
					set((state) => ({ ...state, selectedPanel: panel }));
				},

				setActiveResultId: (resultId) => {
					set((state) => ({ ...state, activeResultId: resultId }));
				},

				setSelectedNodeId: (nodeId) => {
					const { activeResultId } = get();
					set((state) => ({
						...state,
						queryHistory: state.queryHistory.map(r =>
							r.id === activeResultId ? { ...r, selectedNodeId: nodeId } : r
						),
					}));
				},

				setPlanMode: (mode) => {
					const { activeResultId } = get();
					set((state) => ({
						...state,
						queryHistory: state.queryHistory.map(r =>
							r.id === activeResultId ? { ...r, planMode: mode } : r
						),
					}));
				},

				clearHistory: () => {
					set((state) => ({
						...state,
						queryHistory: [],
						activeResultId: null,
					}));
				},

				// Editor integration
				setNavigateToError: (fn) => {
					set({ navigateToError: fn });
				},

				// --- Delegated action groups ---
				...createTabActions(set),
				...createExportActions(set, get),
				...createPluginActions(set, get),
				...createSyncActions(set, get),
			})
		),
		{
			name: 'quoomb-session',
			version: 2,
			partialize: (state) => ({
				tabs: state.tabs,
				activeTabId: state.activeTabId,
				queryHistory: state.queryHistory.slice(0, 50).map(result => ({
					id: result.id,
					sql: result.sql,
					error: result.error,
					errorChain: result.errorChain,
					executionTime: result.executionTime,
					timestamp: result.timestamp,
					planMode: result.planMode,
					selectionInfo: result.selectionInfo,
				})),
				activeResultId: state.activeResultId,
				selectedPanel: state.selectedPanel,
			}),
			onRehydrateStorage: () => (state) => {
				if (state) {
					if (state.tabs && state.tabs.length > 0) {
						const hasActiveTab = state.tabs.some(tab => tab.isActive);
						if (!hasActiveTab) {
							state.tabs[0].isActive = true;
						}
						if (!state.activeTabId) {
							state.activeTabId = state.tabs.find(tab => tab.isActive)?.id || state.tabs[0]?.id || null;
						}
					}

					if (state.queryHistory) {
						state.queryHistory = state.queryHistory.map(result => ({
							...result,
							timestamp: typeof result.timestamp === 'string' ? new Date(result.timestamp) : result.timestamp
						}));
					}
				}
			},
		}
	)
);

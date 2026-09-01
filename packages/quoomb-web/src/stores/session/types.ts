import type { ErrorInfo, SqlValue } from '@quereus/quereus';
import type * as Comlink from 'comlink';
import type { PlanGraph, QuereusWorkerAPI, SyncEvent, SyncStatus } from '../../worker/types.js';

export interface QueryResult {
	id: string;
	sql: string;
	results?: Record<string, SqlValue>[];
	error?: string;
	errorChain?: ErrorInfo[];
	executionTime: number;
	timestamp: Date;
	queryPlan?: Record<string, SqlValue>[];
	program?: Record<string, SqlValue>[];
	trace?: Record<string, SqlValue>[];
	rowTrace?: Record<string, SqlValue>[];
	planGraph?: PlanGraph;
	planMode: 'estimated' | 'actual';
	selectedNodeId?: string;
	selectionInfo?: {
		isSelection: boolean;
		startLine: number;
		startColumn: number;
		endLine: number;
		endColumn: number;
	};
}

export interface Tab {
	id: string;
	name: string;
	content: string;
	isActive: boolean;
	isDirty: boolean;
}

export interface SessionState {
	// Connection state
	isConnected: boolean;
	isConnecting: boolean;
	connectionError: string | null;
	worker: Worker | null;
	api: Comlink.Remote<QuereusWorkerAPI> | null;

	// Session data
	sessionId: string | null;
	tabs: Tab[];
	activeTabId: string | null;

	// Query execution
	isExecuting: boolean;
	currentQuery: string | null;
	queryHistory: QueryResult[];

	// Results display
	activeResultId: string | null;
	selectedPanel: 'result' | 'plan' | 'graph' | 'program' | 'trace' | 'messages' | 'erd';

	// Plugin state
	loadedPlugins: Set<string>;
	pluginErrors: Map<string, string>;

	// Unsaved changes dialog
	unsavedChangesDialog: {
		isOpen: boolean;
		tabId: string | null;
		fileName: string;
	};

	// Sync state
	syncStatus: SyncStatus;
	syncEvents: SyncEvent[];

	// Editor integration
	navigateToError: ((line: number, column: number) => void) | null;

	// Actions
	initializeSession: () => Promise<void>;
	executeSQL: (sql: string, selectionInfo?: { isSelection: boolean; startLine: number; startColumn: number; endLine: number; endColumn: number; }) => Promise<void>;
	fetchQueryPlan: (sql: string) => Promise<void>;
	fetchProgram: (sql: string) => Promise<void>;
	fetchTrace: (sql: string) => Promise<void>;
	fetchRowTrace: (sql: string) => Promise<void>;
	fetchPlanGraph: (sql: string, withActual?: boolean) => Promise<void>;
	createTab: (name?: string) => string;
	closeTab: (tabId: string) => void;
	forceCloseTab: (tabId: string) => void;
	setActiveTab: (tabId: string) => void;
	updateTabContent: (tabId: string, content: string) => void;
	updateTabName: (tabId: string, name: string) => void;
	setSelectedPanel: (panel: 'result' | 'plan' | 'graph' | 'program' | 'trace' | 'messages' | 'erd') => void;
	setActiveResultId: (resultId: string | null) => void;
	setSelectedNodeId: (nodeId: string | undefined) => void;
	setPlanMode: (mode: 'estimated' | 'actual') => void;
	exportResultsAsCSV: () => void;
	exportResultsAsJSON: () => void;
	saveTabAsFile: (tabId?: string) => Promise<void>;
	loadSQLFile: () => Promise<void>;
	showUnsavedChangesDialog: (tabId: string) => void;
	hideUnsavedChangesDialog: () => void;
	clearHistory: () => void;
	disconnect: () => Promise<void>;

	// Plugin management
	installPlugin: (url: string) => Promise<void>;
	togglePlugin: (id: string, enabled: boolean) => Promise<void>;
	updatePluginConfig: (id: string, config: Record<string, SqlValue>) => Promise<void>;
	reloadPlugin: (id: string) => Promise<void>;
	getPluginError: (id: string) => string | undefined;
	clearPluginError: (id: string) => void;
	loadEnabledPlugins: () => Promise<void>;

	// Editor integration
	setNavigateToError: (fn: ((line: number, column: number) => void) | null) => void;

	// Sync management
	setSyncStatus: (status: SyncStatus) => void;
	addSyncEvent: (event: SyncEvent) => void;
	clearSyncEvents: () => void;
	connectSync: () => Promise<void>;
	disconnectSync: () => Promise<void>;
}

/** Zustand set function type for use in extracted action modules */
export type StoreSet = {
	(partial: SessionState | Partial<SessionState> | ((state: SessionState) => SessionState | Partial<SessionState>), replace?: false): void;
	(state: SessionState | ((state: SessionState) => SessionState), replace: true): void;
};

/** Zustand get function type for use in extracted action modules */
export type StoreGet = () => SessionState;

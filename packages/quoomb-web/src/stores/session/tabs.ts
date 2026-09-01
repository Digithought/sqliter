import type { StoreSet, StoreGet, Tab } from './types.js';

export function createTabActions(set: StoreSet) {
	return {
		createTab: (name?: string) => {
			const tabId = crypto.randomUUID();
			const tabName = name || `query-${Date.now()}.sql`;

			set((state) => {
				const newTab: Tab = {
					id: tabId,
					name: tabName,
					content: '',
					isActive: true,
					isDirty: false,
				};

				return {
					...state,
					tabs: [
						...state.tabs.map(tab => ({ ...tab, isActive: false })),
						newTab,
					],
					activeTabId: tabId,
				};
			});

			return tabId;
		},

		closeTab: (tabId: string) => {
			set((state) => {
				const tab = state.tabs.find(t => t.id === tabId);
				if (!tab) return state;

				// If tab has unsaved changes, show confirmation dialog
				if (tab.isDirty) {
					return {
						...state,
						unsavedChangesDialog: {
							isOpen: true,
							tabId,
							fileName: tab.name,
						},
					};
				}

				// If no unsaved changes, close immediately
				return removeTab(state, tabId);
			});
		},

		forceCloseTab: (tabId: string) => {
			set((state) => {
				const tabIndex = state.tabs.findIndex(t => t.id === tabId);
				if (tabIndex === -1) return state;
				return removeTab(state, tabId);
			});
		},

		setActiveTab: (tabId: string) => {
			set((state) => ({
				...state,
				tabs: state.tabs.map(tab => ({
					...tab,
					isActive: tab.id === tabId,
				})),
				activeTabId: tabId,
			}));
		},

		updateTabContent: (tabId: string, content: string) => {
			set((state) => ({
				...state,
				tabs: state.tabs.map(tab =>
					tab.id === tabId
						? { ...tab, content, isDirty: true }
						: tab
				),
			}));
		},

		updateTabName: (tabId: string, name: string) => {
			set((state) => ({
				...state,
				tabs: state.tabs.map(tab =>
					tab.id === tabId
						? { ...tab, name }
						: tab
				),
			}));
		},

		showUnsavedChangesDialog: (tabId: string) => {
			set((state) => ({
				...state,
				unsavedChangesDialog: {
					isOpen: true,
					tabId,
					fileName: state.tabs.find(tab => tab.id === tabId)?.name || '',
				},
			}));
		},

		hideUnsavedChangesDialog: () => {
			set((state) => ({
				...state,
				unsavedChangesDialog: {
					isOpen: false,
					tabId: null,
					fileName: '',
				},
			}));
		},
	};
}

/** Shared tab removal logic used by both closeTab and forceCloseTab */
function removeTab(state: ReturnType<StoreGet>, tabId: string) {
	const tabIndex = state.tabs.findIndex(t => t.id === tabId);
	const newTabs = state.tabs.filter(t => t.id !== tabId);
	let newActiveTabId = state.activeTabId;

	// If closing the active tab, activate another one
	if (state.activeTabId === tabId) {
		if (newTabs.length > 0) {
			const newActiveTab = newTabs[Math.max(0, tabIndex - 1)];
			newActiveTabId = newActiveTab.id;
			newTabs[Math.max(0, tabIndex - 1)] = { ...newActiveTab, isActive: true };
		} else {
			newActiveTabId = null;
		}
	}

	return {
		...state,
		tabs: newTabs,
		activeTabId: newActiveTabId,
	};
}

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { PluginRecord, StorageModuleType } from '../worker/types.js';

export type Theme = 'light' | 'dark' | 'auto';

// Re-export for convenience
export type { StorageModuleType } from '../worker/types.js';

export interface SettingsState {
  // Appearance
  theme: Theme;
  fontSize: number;
  fontFamily: string;

  // Editor preferences
  autoSave: boolean;
  autoSaveDelay: number;
  wordWrap: boolean;
  showLineNumbers: boolean;
  showMinimap: boolean;

  // Query execution
  autoExecuteOnShiftEnter: boolean;
  showExecutionTime: boolean;
  maxHistoryItems: number;

  // Layout
  defaultPanelSizes: {
    editor: number;
    results: number;
  };

  // Plugins
  plugins: PluginRecord[];

  // Storage & Sync
  storageModule: StorageModuleType;
  syncUrl: string;
  syncDatabaseId: string;

  // Actions
  loadSettings: () => void;
  setTheme: (theme: Theme) => void;
  setFontSize: (size: number) => void;
  setFontFamily: (family: string) => void;
  setAutoSave: (enabled: boolean) => void;
  setAutoSaveDelay: (delay: number) => void;
  setWordWrap: (enabled: boolean) => void;
  setShowLineNumbers: (enabled: boolean) => void;
  setShowMinimap: (enabled: boolean) => void;
  setAutoExecuteOnShiftEnter: (enabled: boolean) => void;
  setShowExecutionTime: (enabled: boolean) => void;
  setMaxHistoryItems: (max: number) => void;
  setPanelSizes: (sizes: { editor: number; results: number }) => void;

  // Plugin management
  addPlugin: (plugin: PluginRecord) => void;
  updatePlugin: (id: string, updates: Partial<PluginRecord>) => void;
  removePlugin: (id: string) => void;
  setPlugins: (plugins: PluginRecord[]) => void;

  // Storage & Sync actions
  setStorageModule: (module: StorageModuleType) => void;
  setSyncUrl: (url: string) => void;
  setSyncDatabaseId: (databaseId: string) => void;

  resetToDefaults: () => void;
}

const defaultSettings = {
  theme: 'auto' as Theme,
  fontSize: 14,
  fontFamily: '"Fira Code", "Cascadia Code", "JetBrains Mono", Monaco, Consolas, monospace',

  autoSave: true,
  autoSaveDelay: 2000,
  wordWrap: true,
  showLineNumbers: true,
  showMinimap: false,

  autoExecuteOnShiftEnter: true,
  showExecutionTime: true,
  maxHistoryItems: 100,

  defaultPanelSizes: {
    editor: 50,
    results: 50,
  },

  // Storage & Sync defaults
  storageModule: 'memory' as StorageModuleType,
  syncUrl: 'ws://localhost:8080/sync/ws',
  syncDatabaseId: 'local-s1',
};

// Helper function to get resolved theme
const getResolvedTheme = (theme: Theme): 'light' | 'dark' => {
  if (theme === 'auto') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return theme;
};

// Helper function to apply theme to document
const applyThemeToDocument = (theme: Theme) => {
  const resolvedTheme = getResolvedTheme(theme);
  document.documentElement.setAttribute('data-theme', resolvedTheme);
  // Also set class for compatibility
  document.documentElement.classList.remove('light', 'dark');
  document.documentElement.classList.add(resolvedTheme);
};

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      ...defaultSettings,
      plugins: [],

      loadSettings: () => {
        // Settings are automatically loaded by the persist middleware
        // This function ensures theme is applied to document
        const { theme } = get();
        applyThemeToDocument(theme);
      },

      setTheme: (theme: Theme) => {
        set((state) => ({
          ...state,
          theme,
        }));

        // Apply theme immediately
        applyThemeToDocument(theme);
      },

      setFontSize: (size: number) => {
        set((state) => ({
          ...state,
          fontSize: Math.max(8, Math.min(32, size)),
        }));
      },

      setFontFamily: (family: string) => {
        set((state) => ({
          ...state,
          fontFamily: family,
        }));
      },

      setAutoSave: (enabled: boolean) => {
        set((state) => ({
          ...state,
          autoSave: enabled,
        }));
      },

      setAutoSaveDelay: (delay: number) => {
        set((state) => ({
          ...state,
          autoSaveDelay: Math.max(500, Math.min(10000, delay)),
        }));
      },

      setWordWrap: (enabled: boolean) => {
        set((state) => ({
          ...state,
          wordWrap: enabled,
        }));
      },

      setShowLineNumbers: (enabled: boolean) => {
        set((state) => ({
          ...state,
          showLineNumbers: enabled,
        }));
      },

      setShowMinimap: (enabled: boolean) => {
        set((state) => ({
          ...state,
          showMinimap: enabled,
        }));
      },

      setAutoExecuteOnShiftEnter: (enabled: boolean) => {
        set((state) => ({
          ...state,
          autoExecuteOnShiftEnter: enabled,
        }));
      },

      setShowExecutionTime: (enabled: boolean) => {
        set((state) => ({
          ...state,
          showExecutionTime: enabled,
        }));
      },

      setMaxHistoryItems: (max: number) => {
        set((state) => ({
          ...state,
          maxHistoryItems: Math.max(10, Math.min(1000, max)),
        }));
      },

      setPanelSizes: (sizes: { editor: number; results: number }) => {
        set((state) => ({
          ...state,
          defaultPanelSizes: { ...sizes },
        }));
      },

      addPlugin: (plugin: PluginRecord) => {
        set((state) => ({
          plugins: [...state.plugins, plugin],
        }));
      },

      updatePlugin: (id: string, updates: Partial<PluginRecord>) => {
        set((state) => ({
          plugins: state.plugins.map((plugin) =>
            plugin.id === id ? { ...plugin, ...updates } : plugin
          ),
        }));
      },

      removePlugin: (id: string) => {
        set((state) => ({
          plugins: state.plugins.filter((plugin) => plugin.id !== id),
        }));
      },

      setPlugins: (plugins: PluginRecord[]) => {
        set({ plugins });
      },

      setStorageModule: (module: StorageModuleType) => {
        set((state) => ({
          ...state,
          storageModule: module,
        }));
      },

      setSyncUrl: (url: string) => {
        set((state) => ({
          ...state,
          syncUrl: url,
        }));
      },

      setSyncDatabaseId: (databaseId: string) => {
        set((state) => ({
          ...state,
          syncDatabaseId: databaseId,
        }));
      },

      resetToDefaults: () => {
        set({
          ...defaultSettings,
          plugins: [],
        });

        // Reapply theme
        applyThemeToDocument(defaultSettings.theme);
      },
    }),
    {
      name: 'quoomb-settings',
      version: 1,
      onRehydrateStorage: () => (state) => {
        // Apply theme immediately after rehydration
        if (state?.theme) {
          applyThemeToDocument(state.theme);
        }
      },
    }
  )
);

// Listen for system theme changes when theme is set to 'auto'
if (typeof window !== 'undefined') {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (_) => {
    const { theme } = useSettingsStore.getState();
    if (theme === 'auto') {
      // Use the helper function for consistency
      applyThemeToDocument(theme);
    }
  });
}

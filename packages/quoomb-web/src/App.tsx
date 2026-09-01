import React, { useEffect, useMemo, useState } from 'react';
import { MainLayout } from './components/MainLayout.js';
import { LoadingSplash } from './components/LoadingSplash.js';
import { SyncEventsPanel } from './components/SyncEventsPanel.js';
import { useSessionStore } from './stores/sessionStore.js';
import { useSettingsStore } from './stores/settingsStore.js';

export const App: React.FC = () => {
  const { initializeSession, saveTabAsFile, loadSQLFile, tabs, isConnected, isConnecting } = useSessionStore();
  const { loadSettings, theme } = useSettingsStore();
  const [systemIsDark, setSystemIsDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches
  );

  // Resolve the actual theme to apply
  const resolvedTheme = useMemo(() => {
    if (theme === 'auto') {
      return systemIsDark ? 'dark' : 'light';
    }
    return theme;
  }, [theme, systemIsDark]);

  useEffect(() => {
    // Initialize settings and session on app start
    loadSettings();
    void initializeSession().catch((error) => {
      console.error('Failed to initialize session:', error);
    });

  }, [loadSettings, initializeSession]);

  useEffect(() => {
    // Listen for system theme changes
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (e: MediaQueryListEvent) => {
      setSystemIsDark(e.matches);
    };

    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  useEffect(() => {
    // Add keyboard shortcuts
    const handleKeyDown = async (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey) { // Support both Ctrl and Cmd
        switch (e.key.toLowerCase()) {
          case 's':
            e.preventDefault();
            try {
              await saveTabAsFile();
            } catch (error) {
              console.error('Failed to save file:', error);
            }
            break;
          case 'o':
            e.preventDefault();
            try {
              await loadSQLFile();
            } catch (error) {
              console.error('Failed to load file:', error);
            }
            break;
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [saveTabAsFile, loadSQLFile]);

  useEffect(() => {
    // Warn before closing browser tab/window if there are unsaved changes
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      const hasUnsavedChanges = tabs.some(tab => tab.isDirty);
      if (hasUnsavedChanges) {
        e.preventDefault();
        e.returnValue = ''; // Required for Chrome
        return ''; // Required for other browsers
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [tabs]);

  // Show loading splash while connecting or if not connected yet
  if (isConnecting || !isConnected) {
    return (
      <div className={`app ${resolvedTheme}`} data-theme={resolvedTheme}>
        <LoadingSplash />
      </div>
    );
  }

  return (
    <div className={`app ${resolvedTheme}`} data-theme={resolvedTheme}>
      <MainLayout />
      <SyncEventsPanel />
    </div>
  );
};

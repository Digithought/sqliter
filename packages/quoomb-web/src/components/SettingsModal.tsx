import { AlertCircle, Monitor, Moon, Puzzle, Settings2, Sun, X } from 'lucide-react';
import React, { useState } from 'react';
import { useSettingsStore } from '../stores/settingsStore.js';
import { ConfigModal } from './ConfigModal.js';
import { PluginsModal } from './PluginsModal.js';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({ isOpen, onClose }) => {
  const {
    theme,
    setTheme,
    fontSize,
    setFontSize,
    fontFamily,
    setFontFamily,
    wordWrap,
    setWordWrap,
    showLineNumbers,
    setShowLineNumbers,
    showMinimap,
    setShowMinimap,
    autoExecuteOnShiftEnter,
    setAutoExecuteOnShiftEnter,
    showExecutionTime,
    setShowExecutionTime,
    maxHistoryItems,
    setMaxHistoryItems,
    syncUrl,
    setSyncUrl,
    syncDatabaseId,
    setSyncDatabaseId,
    resetToDefaults,
  } = useSettingsStore();

  const [showPluginsModal, setShowPluginsModal] = useState(false);
  const [showConfigModal, setShowConfigModal] = useState(false);

  // Validate database ID format
  const validateDatabaseId = (id: string): boolean => {
    if (!id) return false;
    const parts = id.split('-');
    if (parts.length !== 2) return false;
    const [accountId, dbPart] = parts;
    if (!accountId) return false;
    if (dbPart === 'acc') return true;
    if (dbPart.length < 2) return false;
    const typeChar = dbPart[0];
    if (typeChar !== 's' && typeChar !== 'd') return false;
    const numStr = dbPart.slice(1);
    const num = parseInt(numStr, 10);
    return !isNaN(num) && num >= 1;
  };

  const isDatabaseIdValid = validateDatabaseId(syncDatabaseId);

  if (!isOpen) return null;

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  const getThemeIcon = (themeOption: string) => {
    switch (themeOption) {
      case 'light':
        return <Sun size={16} />;
      case 'dark':
        return <Moon size={16} />;
      case 'auto':
        return <Monitor size={16} />;
      default:
        return <Monitor size={16} />;
    }
  };

  const fontSizeOptions = [10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24];
  const fontFamilyOptions = [
    '"Fira Code", "Cascadia Code", "JetBrains Mono", Monaco, Consolas, monospace',
    '"Cascadia Code", "Fira Code", "JetBrains Mono", Monaco, Consolas, monospace',
    '"JetBrains Mono", "Fira Code", "Cascadia Code", Monaco, Consolas, monospace',
    '"SF Mono", Monaco, Consolas, monospace',
    'Monaco, Consolas, monospace',
    'Consolas, monospace',
  ];

  const fontDisplayNames = [
    'Fira Code (default)',
    'Cascadia Code',
    'JetBrains Mono',
    'SF Mono',
    'Monaco',
    'Consolas',
  ];

  return (
    <>
      <div
        className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50"
        onClick={handleOverlayClick}
      >
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-2xl max-h-[80vh] overflow-y-auto m-4">
          {/* Header */}
          <div className="flex items-center justify-between p-6 border-b border-gray-200 dark:border-gray-700">
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white">Settings</h2>
            <button
              onClick={onClose}
              className="p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 rounded"
            >
              <X size={20} />
            </button>
          </div>

          {/* Content */}
          <div className="p-6 space-y-8">
            {/* Extensions */}
            <div>
              <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-4">
                Extensions
              </h3>
              <div className="space-y-3">
                <button
                  onClick={() => setShowPluginsModal(true)}
                  className="flex items-center gap-3 w-full p-3 border border-gray-200 dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
                >
                  <Puzzle size={20} className="text-blue-500" />
                  <div className="text-left">
                    <div className="font-medium text-gray-900 dark:text-white">
                      Manage Plugins
                    </div>
                    <div className="text-sm text-gray-600 dark:text-gray-400">
                      Install and configure virtual table plugins
                    </div>
                  </div>
                </button>
                <button
                  onClick={() => setShowConfigModal(true)}
                  className="flex items-center gap-3 w-full p-3 border border-gray-200 dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
                >
                  <Settings2 size={20} className="text-green-500" />
                  <div className="text-left">
                    <div className="font-medium text-gray-900 dark:text-white">
                      Configuration
                    </div>
                    <div className="text-sm text-gray-600 dark:text-gray-400">
                      Import/export plugin configuration
                    </div>
                  </div>
                </button>
              </div>
            </div>

            {/* Appearance Section */}
            <section>
              <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-4">Appearance</h3>

              {/* Theme Selection */}
              <div className="mb-6">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
                  Theme
                </label>
                <div className="flex gap-2">
                  {(['auto', 'light', 'dark'] as const).map((themeOption) => (
                    <button
                      key={themeOption}
                      onClick={() => setTheme(themeOption)}
                      className={`flex items-center gap-2 px-4 py-2 rounded-lg border transition-colors ${
                        theme === themeOption
                          ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300'
                          : 'border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-600'
                      }`}
                    >
                      {getThemeIcon(themeOption)}
                      <span className="capitalize">{themeOption}</span>
                    </button>
                  ))}
                </div>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
                  Auto will follow your system theme preference
                </p>
              </div>
            </section>

            {/* Editor Section */}
            <section>
              <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-4">Editor</h3>

              {/* Font Size */}
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Font Size: {fontSize}px
                </label>
                <select
                  value={fontSize}
                  onChange={(e) => setFontSize(Number(e.target.value))}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                >
                  {fontSizeOptions.map(size => (
                    <option key={size} value={size}>{size}px</option>
                  ))}
                </select>
              </div>

              {/* Font Family */}
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Font Family
                </label>
                <select
                  value={fontFamily}
                  onChange={(e) => setFontFamily(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                >
                  {fontFamilyOptions.map((font, index) => (
                    <option key={font} value={font}>{fontDisplayNames[index]}</option>
                  ))}
                </select>
              </div>

              {/* Editor Options */}
              <div className="space-y-3">
                <label className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    checked={wordWrap}
                    onChange={(e) => setWordWrap(e.target.checked)}
                    className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                  />
                  <span className="text-sm text-gray-700 dark:text-gray-300">Word wrap</span>
                </label>

                <label className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    checked={showLineNumbers}
                    onChange={(e) => setShowLineNumbers(e.target.checked)}
                    className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                  />
                  <span className="text-sm text-gray-700 dark:text-gray-300">Show line numbers</span>
                </label>

                <label className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    checked={showMinimap}
                    onChange={(e) => setShowMinimap(e.target.checked)}
                    className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                  />
                  <span className="text-sm text-gray-700 dark:text-gray-300">Show minimap</span>
                </label>
              </div>
            </section>

            {/* Query Execution Section */}
            <section>
              <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-4">Query Execution</h3>

              <div className="space-y-3">
                <label className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    checked={autoExecuteOnShiftEnter}
                    onChange={(e) => setAutoExecuteOnShiftEnter(e.target.checked)}
                    className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                  />
                  <span className="text-sm text-gray-700 dark:text-gray-300">Execute on Shift+Enter</span>
                </label>

                <label className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    checked={showExecutionTime}
                    onChange={(e) => setShowExecutionTime(e.target.checked)}
                    className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                  />
                  <span className="text-sm text-gray-700 dark:text-gray-300">Show execution time</span>
                </label>
              </div>

              {/* Max History Items */}
              <div className="mt-4">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Max History Items: {maxHistoryItems}
                </label>
                <input
                  type="range"
                  min="10"
                  max="1000"
                  step="10"
                  value={maxHistoryItems}
                  onChange={(e) => setMaxHistoryItems(Number(e.target.value))}
                  className="w-full h-2 bg-gray-200 dark:bg-gray-700 rounded-lg appearance-none cursor-pointer"
                />
                <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400 mt-1">
                  <span>10</span>
                  <span>1000</span>
                </div>
              </div>
            </section>

            {/* Sync Settings Section */}
            <section>
              <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-4">Sync Settings</h3>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    Sync Server URL
                  </label>
                  <input
                    type="text"
                    value={syncUrl}
                    onChange={(e) => setSyncUrl(e.target.value)}
                    placeholder="ws://localhost:8080/sync/ws"
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400"
                  />
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                    WebSocket URL of the sync-coordinator server (e.g., ws://host:port/sync/ws).
                  </p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    Database ID
                  </label>
                  <div className="relative">
                    <input
                      type="text"
                      value={syncDatabaseId}
                      onChange={(e) => setSyncDatabaseId(e.target.value)}
                      placeholder="local-s1"
                      className={`w-full px-3 py-2 border rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 font-mono ${
                        syncDatabaseId && !isDatabaseIdValid
                          ? 'border-red-500 dark:border-red-500'
                          : 'border-gray-300 dark:border-gray-600'
                      }`}
                    />
                    {syncDatabaseId && !isDatabaseIdValid && (
                      <div className="absolute right-3 top-1/2 -translate-y-1/2">
                        <AlertCircle size={16} className="text-red-500" />
                      </div>
                    )}
                  </div>
                  {syncDatabaseId && !isDatabaseIdValid ? (
                    <p className="text-xs text-red-600 dark:text-red-400 mt-1 flex items-center gap-1">
                      <AlertCircle size={12} />
                      Invalid format. Must be: accountId-s# or accountId-d# or accountId-acc
                    </p>
                  ) : (
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                      Format: <code className="bg-gray-100 dark:bg-gray-700 px-1 py-0.5 rounded">accountId-type#</code>
                      {' '}where type is <code className="bg-gray-100 dark:bg-gray-700 px-1 py-0.5 rounded">s</code> (scenario),
                      <code className="bg-gray-100 dark:bg-gray-700 px-1 py-0.5 rounded">d</code> (dynamics), or
                      <code className="bg-gray-100 dark:bg-gray-700 px-1 py-0.5 rounded">acc</code> (account).
                      Default: <code className="bg-gray-100 dark:bg-gray-700 px-1 py-0.5 rounded">local-s1</code>
                    </p>
                  )}
                </div>
              </div>
            </section>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between p-6 border-t border-gray-200 dark:border-gray-700">
            <button
              onClick={resetToDefaults}
              className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 transition-colors"
            >
              Reset to Defaults
            </button>
            <button
              onClick={onClose}
              className="px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      </div>

      {/* Plugins Modal */}
      <PluginsModal
        isOpen={showPluginsModal}
        onClose={() => setShowPluginsModal(false)}
      />

      {/* Config Modal */}
      <ConfigModal
        isOpen={showConfigModal}
        onClose={() => setShowConfigModal(false)}
      />
    </>
  );
};

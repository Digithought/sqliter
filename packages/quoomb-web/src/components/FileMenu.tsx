import { FolderOpen, Loader, Save } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import { useSessionStore } from '../stores/sessionStore.js';

interface FileMenuProps {
  isOpen: boolean;
  onClose: () => void;
}

export const FileMenu: React.FC<FileMenuProps> = ({ isOpen, onClose }) => {
  const { tabs, activeTabId, saveTabAsFile, loadSQLFile } = useSessionStore();
  const [isLoading, setIsLoading] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen, onClose]);

  const activeTab = tabs.find(tab => tab.id === activeTabId);

  const handleSaveFile = async () => {
    if (!activeTab) {
      alert('No active tab to save');
      return;
    }

    try {
      setIsLoading(true);
      await saveTabAsFile();
      onClose();
    } catch (error) {
      console.error('Failed to save file:', error);
      alert(`Failed to save file: ${error instanceof Error ? error.message : error}`);
    } finally {
      setIsLoading(false);
    }
  };

  const handleLoadFile = async () => {
    try {
      setIsLoading(true);
      await loadSQLFile();
      onClose();
    } catch (error) {
      console.error('Failed to load file:', error);
      alert(`Failed to load file: ${error instanceof Error ? error.message : error}`);
    } finally {
      setIsLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div
      ref={menuRef}
      className="absolute top-full right-0 mt-1 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg py-1 z-50 min-w-[200px]"
    >
      <button
        onClick={handleLoadFile}
        disabled={isLoading}
        className="flex items-center justify-between w-full px-3 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors disabled:opacity-50"
      >
        <div className="flex items-center gap-2">
          {isLoading ? <Loader size={16} className="animate-spin" /> : <FolderOpen size={16} />}
          Open SQL File...
        </div>
        <kbd className="text-xs text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-700 px-1 rounded">
          Ctrl+O
        </kbd>
      </button>

      <button
        onClick={handleSaveFile}
        disabled={!activeTab || isLoading}
        className="flex items-center justify-between w-full px-3 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors disabled:opacity-50"
      >
        <div className="flex items-center gap-2">
          {isLoading ? <Loader size={16} className="animate-spin" /> : <Save size={16} />}
          Save As...
        </div>
        <kbd className="text-xs text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-700 px-1 rounded">
          Ctrl+S
        </kbd>
      </button>

      {activeTab && (
        <div className="px-3 py-1 text-xs text-gray-500 dark:text-gray-400 border-t border-gray-200 dark:border-gray-700 mt-1">
          <div className="flex items-center gap-1">
            <span>Current: {activeTab.name}</span>
            {activeTab.isDirty && (
              <span className="text-orange-500" title="Unsaved changes">●</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

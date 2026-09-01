import { Plus, X } from 'lucide-react';
import React from 'react';
import { useSessionStore } from '../stores/sessionStore.js';

export const TabBar: React.FC = () => {
  const {
    tabs,
    createTab,
    closeTab,
    setActiveTab
  } = useSessionStore();

  const handleAddTab = () => {
    createTab();
  };

  const handleCloseTab = (tabId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    closeTab(tabId);
  };

  const handleTabClick = (tabId: string) => {
    setActiveTab(tabId);
  };

  return (
    <div className="flex items-center bg-gray-100 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
      {/* Tab list */}
      <div className="flex flex-1 overflow-x-auto">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`
              relative flex items-center gap-2 px-3 py-2 border-r border-gray-200 dark:border-gray-700 cursor-pointer
              hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors min-w-0
              ${tab.isActive
                ? 'bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100'
                : 'text-gray-600 dark:text-gray-400'
              }
            `}
            onClick={() => handleTabClick(tab.id)}
            title={tab.name}
          >
            {/* Tab name */}
            <span className="text-sm truncate max-w-[120px]">
              {tab.name}
            </span>

            {/* Dirty indicator */}
            {tab.isDirty && (
              <div className="w-2 h-2 bg-orange-500 rounded-full flex-shrink-0" title="Unsaved changes" />
            )}

            {/* Close button */}
            <button
              onClick={(e) => handleCloseTab(tab.id, e)}
              className="flex-shrink-0 p-0.5 rounded hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors"
              title="Close tab"
            >
              <X size={12} />
            </button>
          </div>
        ))}
      </div>

      {/* Add tab button */}
      <button
        onClick={handleAddTab}
        className="flex items-center justify-center p-2 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
        title="New tab"
      >
        <Plus size={16} />
      </button>
    </div>
  );
};

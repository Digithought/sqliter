import React, { useState } from 'react';
import { useSessionStore } from '../stores/sessionStore.js';
import { useSettingsStore } from '../stores/settingsStore.js';
import { Cloud, CloudOff, Loader, AlertCircle, CheckCircle } from 'lucide-react';

export const SyncStatusIndicator: React.FC = () => {
  const { syncStatus, syncEvents } = useSessionStore();
  const { storageModule } = useSettingsStore();
  const [showTooltip, setShowTooltip] = useState(false);

  // Only show when sync module is enabled
  if (storageModule !== 'sync') {
    return null;
  }

  const getStatusIcon = () => {
    switch (syncStatus.status) {
      case 'disconnected':
        return <CloudOff size={12} className="text-gray-400" />;
      case 'connecting':
        return <Loader size={12} className="animate-spin text-yellow-500" />;
      case 'bootstrapping':
        return <Loader size={12} className="animate-spin text-blue-500" />;
      case 'syncing':
        return <Cloud size={12} className="text-blue-500 animate-pulse" />;
      case 'synced':
        return <CheckCircle size={12} className="text-green-500" />;
      case 'error':
        return <AlertCircle size={12} className="text-red-500" />;
      default:
        return <CloudOff size={12} className="text-gray-400" />;
    }
  };

  const getStatusText = () => {
    switch (syncStatus.status) {
      case 'disconnected':
        return 'Sync: Disconnected';
      case 'connecting':
        return 'Sync: Connecting...';
      case 'bootstrapping':
        return `Sync: Downloading snapshot (${syncStatus.tablesProcessed}/${syncStatus.totalTables} tables)`;
      case 'syncing':
        return `Sync: Syncing (${syncStatus.progress}%)`;
      case 'synced':
        const lastSync = new Date(syncStatus.lastSyncTime);
        return `Sync: Synced at ${lastSync.toLocaleTimeString()}`;
      case 'error':
        return `Sync Error: ${syncStatus.message}`;
      default:
        return 'Sync: Unknown';
    }
  };

  const getStatusColor = () => {
    switch (syncStatus.status) {
      case 'disconnected':
        return 'text-gray-500 dark:text-gray-400';
      case 'connecting':
        return 'text-yellow-600 dark:text-yellow-400';
      case 'bootstrapping':
        return 'text-blue-600 dark:text-blue-400';
      case 'syncing':
        return 'text-blue-600 dark:text-blue-400';
      case 'synced':
        return 'text-green-600 dark:text-green-400';
      case 'error':
        return 'text-red-600 dark:text-red-400';
      default:
        return 'text-gray-500 dark:text-gray-400';
    }
  };

  const recentEvents = syncEvents.slice(0, 5);

  return (
    <div
      className="relative"
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
    >
      <div className={`flex items-center gap-1 cursor-pointer ${getStatusColor()}`}>
        {getStatusIcon()}
        <span className="hidden sm:inline">{getStatusText()}</span>
      </div>

      {/* Tooltip with recent events */}
      {showTooltip && recentEvents.length > 0 && (
        <div className="absolute bottom-full left-0 mb-2 w-64 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-2 z-50">
          <div className="text-xs font-medium text-gray-700 dark:text-gray-300 mb-2">
            Recent Sync Events
          </div>
          <div className="space-y-1">
            {recentEvents.map((event, index) => (
              <div
                key={index}
                className="text-xs text-gray-600 dark:text-gray-400 flex items-start gap-1"
              >
                <span className="text-gray-400 dark:text-gray-500 flex-shrink-0">
                  {new Date(event.timestamp).toLocaleTimeString()}
                </span>
                <span className="truncate">{event.message}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};


import { AlertCircle, CheckCircle, Play, X } from 'lucide-react';
import React from 'react';
import { useSessionStore } from '../stores/sessionStore.js';

interface HistoryPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

export const HistoryPanel: React.FC<HistoryPanelProps> = ({ isOpen, onClose }) => {
  const { queryHistory, executeSQL, setActiveResultId } = useSessionStore();

  const handleQueryClick = (resultId: string) => {
    setActiveResultId(resultId);
    onClose();
  };

  const handleRerunQuery = async (sql: string) => {
    await executeSQL(sql);
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-4xl max-h-[80vh] overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
            Query History ({queryHistory.length})
          </h2>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        {/* Content */}
        <div className="overflow-y-auto max-h-[60vh]">
          {queryHistory.length === 0 ? (
            <div className="flex items-center justify-center py-12 text-gray-500">
              <p>No queries in history</p>
            </div>
          ) : (
            <div className="divide-y divide-gray-200 dark:divide-gray-700">
              {queryHistory.map((query) => (
                <div
                  key={query.id}
                  className="p-4 hover:bg-gray-50 dark:hover:bg-gray-700 cursor-pointer"
                  onClick={() => handleQueryClick(query.id)}
                >
                  <div className="flex items-start justify-between gap-4">
                    {/* Query info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-2">
                        {query.error ? (
                          <AlertCircle size={16} className="text-red-500 flex-shrink-0" />
                        ) : (
                          <CheckCircle size={16} className="text-green-500 flex-shrink-0" />
                        )}
                        <span className="text-sm text-gray-500 dark:text-gray-400">
                          {query.timestamp.toLocaleString()}
                        </span>
                        <span className="text-sm text-gray-500 dark:text-gray-400">
                          • {query.executionTime}ms
                        </span>
                        {!query.error && (
                          <span className="text-sm text-gray-500 dark:text-gray-400">
                            • {query.results?.length || 0} rows
                          </span>
                        )}
                      </div>

                      {/* SQL Query */}
                      <div className="bg-gray-100 dark:bg-gray-800 rounded p-3 mb-2">
                        <pre className="text-sm text-gray-800 dark:text-gray-200 whitespace-pre-wrap break-words">
                          {query.sql}
                        </pre>
                      </div>

                      {/* Error message if any */}
                      {query.error && (
                        <div className="text-sm text-red-600 dark:text-red-400">
                          Error: {query.error}
                        </div>
                      )}
                    </div>

                    {/* Actions */}
                    <div className="flex flex-col gap-2">
                      <button
                        onClick={async (e) => {
                          e.stopPropagation();
                          await handleRerunQuery(query.sql);
                        }}
                        className="flex items-center gap-1 px-2 py-1 text-xs bg-blue-500 hover:bg-blue-600 text-white rounded transition-colors"
                        title="Re-run this query"
                      >
                        <Play size={12} />
                        Run
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 p-4 border-t border-gray-200 dark:border-gray-700">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

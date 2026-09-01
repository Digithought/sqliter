import { FileJson, FileText } from 'lucide-react';
import React, { useEffect, useRef } from 'react';
import { useSessionStore } from '../stores/sessionStore.js';

interface ExportMenuProps {
  isOpen: boolean;
  onClose: () => void;
}

export const ExportMenu: React.FC<ExportMenuProps> = ({ isOpen, onClose }) => {
  const { exportResultsAsCSV, exportResultsAsJSON, queryHistory, activeResultId } = useSessionStore();
  const menuRef = useRef<HTMLDivElement>(null);

  const activeResult = queryHistory.find(result => result.id === activeResultId);
  const hasResults = activeResult?.results && activeResult.results.length > 0;

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen, onClose]);

  const handleExportCSV = () => {
    exportResultsAsCSV();
    onClose();
  };

  const handleExportJSON = () => {
    exportResultsAsJSON();
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div
      ref={menuRef}
      className="absolute top-full right-0 mt-1 w-48 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-50"
    >
      {hasResults ? (
        <div className="py-1">
          <button
            onClick={handleExportCSV}
            className="flex items-center gap-2 w-full px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
          >
            <FileText size={16} />
            Export as CSV
          </button>
          <button
            onClick={handleExportJSON}
            className="flex items-center gap-2 w-full px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
          >
            <FileJson size={16} />
            Export as JSON
          </button>
        </div>
      ) : (
        <div className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
          No results to export
        </div>
      )}
    </div>
  );
};

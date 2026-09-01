import React from 'react';
import { useSessionStore } from '../stores/sessionStore.js';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface ConnectionErrorProps {
  error: unknown;
}

const formatErrorMessage = (error: unknown): string => {
  if (typeof error === 'string') {
    return error;
  }

  if (error instanceof Error) {
    return error.message;
  }

  if (error === null || error === undefined) {
    return 'Unknown connection error';
  }

  return String(error);
};

export const ConnectionError: React.FC<ConnectionErrorProps> = ({ error }) => {
  const { initializeSession } = useSessionStore();
  const errorMessage = formatErrorMessage(error);

  const handleRetry = () => {
    void initializeSession();
  };

  return (
    <div className="flex items-center justify-center h-screen bg-gray-50 dark:bg-gray-900">
      <div className="text-center max-w-md mx-auto p-6">
        <div className="flex justify-center mb-4">
          <AlertTriangle className="h-16 w-16 text-red-500" />
        </div>

        <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-2">
          Connection Failed
        </h2>

        <p className="text-gray-600 dark:text-gray-400 mb-6">
          Unable to connect to the Quereus database engine.
        </p>

        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4 mb-6">
          <p className="text-sm text-red-700 dark:text-red-300 font-mono">
            {errorMessage}
          </p>
        </div>

        <button
          onClick={handleRetry}
          className="flex items-center gap-2 px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg transition-colors mx-auto"
        >
          <RefreshCw size={16} />
          Retry Connection
        </button>
      </div>
    </div>
  );
};

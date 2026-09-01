import { CheckCircle, Clock, Info } from 'lucide-react';
import React from 'react';
import { useSessionStore } from '../stores/sessionStore.js';
import { EnhancedErrorDisplay } from './EnhancedErrorDisplay.js';

type MessageType = 'info' | 'success' | 'warning' | 'error';

interface Message {
  type: MessageType;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  message: string;
}

export const MessagesPanel: React.FC = () => {
  const { queryHistory, activeResultId } = useSessionStore();

  const activeResult = queryHistory.find(result => result.id === activeResultId);

  if (!activeResult) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500">
        <p>No query selected</p>
      </div>
    );
  }

  const infoMessages: Message[] = [
    {
      type: 'info',
      icon: Info,
      message: `Query executed at ${activeResult.timestamp.toLocaleTimeString()}`,
    },
    {
      type: 'info',
      icon: Clock,
      message: `Execution time: ${activeResult.executionTime}ms`,
    },
  ];

  if (!activeResult.error) {
    infoMessages.push({
      type: 'success',
      icon: CheckCircle,
      message: `Query completed successfully. ${activeResult.results?.length || 0} rows returned.`,
    });
  }

  const getMessageStyles = (type: MessageType) => {
    switch (type) {
      case 'error':
        return 'text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800';
      case 'success':
        return 'text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800';
      case 'warning':
        return 'text-yellow-600 dark:text-yellow-400 bg-yellow-50 dark:bg-yellow-900/20 border-yellow-200 dark:border-yellow-800';
      default:
        return 'text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800';
    }
  };

  return (
    <div className="p-4 space-y-3">
      <h3 className="text-lg font-semibold mb-4">Messages</h3>

      {/* Error display with enhanced information */}
      {activeResult.error && (
        <EnhancedErrorDisplay
          error={activeResult.error}
          errorChain={activeResult.errorChain}
          selectionInfo={activeResult.selectionInfo}
        />
      )}

      {/* Info messages */}
      {infoMessages.map((msg, index) => {
        const Icon = msg.icon;
        return (
          <div
            key={index}
            className={`flex items-start gap-3 p-3 rounded-lg border ${getMessageStyles(msg.type)}`}
          >
            <Icon size={16} className="mt-0.5 flex-shrink-0" />
            <span className="text-sm">{msg.message}</span>
          </div>
        );
      })}

      {/* Query details */}
      <div className="mt-6 pt-4 border-t border-gray-200 dark:border-gray-700">
        <h4 className="font-medium mb-2">Query Details</h4>
        <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3">
          <pre className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap">
            {activeResult.sql}
          </pre>
        </div>
      </div>
    </div>
  );
};

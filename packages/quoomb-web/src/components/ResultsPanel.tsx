import { Activity, Database, FileText, GitBranch, Layers3, MessageSquare, Share2 } from 'lucide-react';
import React from 'react';
import { useSessionStore } from '../stores/sessionStore.js';
import { ERDPanel } from './ERDPanel.js';
import { ExecutionTrace } from './ExecutionTrace.js';
import { MessagesPanel } from './MessagesPanel.js';
import { QueryPlan } from './QueryPlan.js';
import { QueryPlanGraph } from './QueryPlanGraph.js';
import { QueryProgram } from './QueryProgram.js';
import { ResultsGrid } from './ResultsGrid.js';

export const ResultsPanel: React.FC = () => {
  const {
    selectedPanel,
    setSelectedPanel,
    queryHistory,
    activeResultId
  } = useSessionStore();

  const activeResult = queryHistory.find(result => result.id === activeResultId);

  const tabs = [
    { id: 'result', label: 'Results', icon: Database },
    { id: 'plan', label: 'Plan', icon: FileText },
    { id: 'graph', label: 'Graph', icon: Share2 },
    { id: 'program', label: 'Program', icon: Layers3 },
    { id: 'trace', label: 'Trace', icon: Activity },
    { id: 'erd', label: 'ERD', icon: GitBranch },
    { id: 'messages', label: 'Messages', icon: MessageSquare },
  ] as const;

  return (
    <div className="h-full flex flex-col">
      {/* Tab bar */}
      <div className="flex items-center bg-gray-100 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
        {tabs.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setSelectedPanel(id)}
            className={`
              flex items-center gap-2 px-4 py-2 text-sm border-r border-gray-200 dark:border-gray-700 transition-colors
              ${selectedPanel === id
                ? 'bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100'
                : 'text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'
              }
            `}
          >
            <Icon size={16} />
            {label}
          </button>
        ))}

        {/* Results summary */}
        {activeResult && (
          <div className="ml-auto px-4 py-2 text-sm text-gray-600 dark:text-gray-400">
            {activeResult.error ? (
              <span className="text-red-500">Error</span>
            ) : (
              <span>
                {activeResult.results?.length || 0} rows
                {activeResult.executionTime && ` • ${activeResult.executionTime}ms`}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Panel content */}
      <div className="flex-1 overflow-hidden">
        {selectedPanel === 'result' && (
          <ResultsGrid />
        )}

        {selectedPanel === 'plan' && (
          <QueryPlan />
        )}

        {selectedPanel === 'graph' && (
          <QueryPlanGraph />
        )}

        {selectedPanel === 'program' && (
          <QueryProgram />
        )}

        {selectedPanel === 'trace' && (
          <ExecutionTrace />
        )}

        {selectedPanel === 'erd' && (
          <ERDPanel />
        )}

        {selectedPanel === 'messages' && (
          <MessagesPanel />
        )}
      </div>
    </div>
  );
};

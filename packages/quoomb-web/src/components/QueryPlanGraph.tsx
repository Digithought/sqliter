import React, { useState, useRef, useCallback, useMemo } from 'react';
import { useSessionStore } from '../stores/sessionStore.js';
import { Play, ZoomIn, ZoomOut, RotateCcw, Eye, Activity, Copy, Check, Minimize2, Info } from 'lucide-react';
import type { PlanGraphNode, PlanGraph } from '../worker/types.js';

interface TreeLayout {
  x: number;
  y: number;
  node: PlanGraphNode;
}

interface ViewBox {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
}

export const QueryPlanGraph: React.FC = () => {
  const { queryHistory, activeResultId, fetchPlanGraph, setSelectedNodeId, setPlanMode } = useSessionStore();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewBox, setViewBox] = useState<ViewBox>({ x: 0, y: 0, width: 800, height: 600, scale: 1 });
  const [copySuccess, setCopySuccess] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [lastMousePos, setLastMousePos] = useState({ x: 0, y: 0 });
  const [showQuery, setShowQuery] = useState(false);
  const [showLegend, setShowLegend] = useState(true);
  const svgRef = useRef<SVGSVGElement>(null);

  const activeResult = queryHistory.find(result => result.id === activeResultId);
  const planGraph = activeResult?.planGraph;
  const planMode = activeResult?.planMode || 'estimated';
  const selectedNodeId = activeResult?.selectedNodeId;

  // Simple tree layout algorithm (Reingold-Tilford style)
  const layoutTree = useCallback((root: PlanGraphNode): TreeLayout[] => {
    const layouts: TreeLayout[] = [];
    const nodeWidth = 200;
    const levelHeight = 110; // Tighter spacing
    const nodeSpacing = 40;

    const traverse = (node: PlanGraphNode, depth: number, siblingIndex: number, siblingsCount: number) => {
      // Center nodes better by using wider spacing
      const x = (siblingIndex - (siblingsCount - 1) / 2) * (nodeWidth + nodeSpacing);
      const y = depth * levelHeight + 50;

      layouts.push({ x, y, node });

      // Layout children
      node.children.forEach((child, index) => {
        traverse(child, depth + 1, index, node.children.length);
      });
    };

    if (root) {
      traverse(root, 0, 0, 1);
    }

    return layouts;
  }, []);

  // Calculate content bounds
  const getContentBounds = useCallback((layouts: TreeLayout[]) => {
    if (layouts.length === 0) {
      return { minX: 0, maxX: 800, minY: 0, maxY: 600 };
    }

    const nodeWidth = 200;
    const nodeHeight = 80; // Updated

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;

    layouts.forEach(layout => {
      minX = Math.min(minX, layout.x - nodeWidth / 2);
      maxX = Math.max(maxX, layout.x + nodeWidth / 2);
      minY = Math.min(minY, layout.y - nodeHeight / 2);
      maxY = Math.max(maxY, layout.y + nodeHeight / 2);
    });

    // Add padding
    const padding = 50;
    return {
      minX: minX - padding,
      maxX: maxX + padding,
      minY: minY - padding,
      maxY: maxY + padding
    };
  }, []);

  // Auto-fit viewBox to content
  const autoFitContent = useCallback((layouts: TreeLayout[]) => {
    const bounds = getContentBounds(layouts);
    const width = bounds.maxX - bounds.minX;
    const height = bounds.maxY - bounds.minY;

    setViewBox({
      x: bounds.minX,
      y: bounds.minY,
      width,
      height,
      scale: 1
    });
  }, [getContentBounds]);

  // Calculate hotspot score for a node
  const getHotspotScore = useCallback((node: PlanGraphNode, totals: PlanGraph['totals']): number => {
    const timeOrCost = node.actTimeMs ?? node.estCost;
    const totalTimeOrCost = totals.actTimeMs ?? totals.estCost;

    if (totalTimeOrCost === 0) return 0;
    return Math.min(1, timeOrCost / totalTimeOrCost);
  }, []);

  // Get color based on hotspot score
  const getNodeColor = useCallback((score: number): string => {
    if (score < 0.1) return '#e5f3ff'; // Very light blue
    if (score < 0.3) return '#fef3c7'; // Light yellow
    if (score < 0.6) return '#fed7aa'; // Light orange
    if (score < 0.8) return '#fecaca'; // Light red
    return '#fca5a5'; // Red
  }, []);

  const getNodeBorderColor = useCallback((score: number): string => {
    if (score < 0.1) return '#3b82f6'; // Blue
    if (score < 0.3) return '#f59e0b'; // Yellow
    if (score < 0.6) return '#f97316'; // Orange
    if (score < 0.8) return '#ef4444'; // Red
    return '#dc2626'; // Dark red
  }, []);

  const layouts = useMemo(() => {
    const newLayouts = planGraph ? layoutTree(planGraph.root) : [];

    // Auto-fit when new plan is loaded
    if (newLayouts.length > 0) {
      setTimeout(() => autoFitContent(newLayouts), 0);
    }

    return newLayouts;
  }, [planGraph, layoutTree, autoFitContent]);

  // Mouse event handlers - changed to use mouse buttons for zoom and wheel for pan
  const handleMouseDown = (e: React.MouseEvent<SVGSVGElement>) => {
    if (e.button === 0 || e.button === 1) { // Left or middle mouse button for pan
      setIsDragging(true);
      setLastMousePos({ x: e.clientX, y: e.clientY });
      e.preventDefault();
    }
  };

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!isDragging) return;

    const deltaX = e.clientX - lastMousePos.x;
    const deltaY = e.clientY - lastMousePos.y;

    setViewBox(prev => ({
      ...prev,
      x: prev.x - deltaX / prev.scale,
      y: prev.y - deltaY / prev.scale
    }));

    setLastMousePos({ x: e.clientX, y: e.clientY });
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  // Fixed wheel to pan with better calculations
  const handleWheel = (e: React.WheelEvent<SVGSVGElement>) => {
    e.preventDefault();
    e.stopPropagation();

    const panSpeed = 1.5; // Reduced pan speed
    const deltaX = e.deltaX * panSpeed;
    const deltaY = e.deltaY * panSpeed;

    setViewBox(prev => ({
      ...prev,
      x: prev.x + deltaX,
      y: prev.y + deltaY
    }));
  };

  // Fixed zoom event handling to prevent browser zoom
  const handleDoubleClick = (e: React.MouseEvent<SVGSVGElement>) => {
    e.preventDefault();
    e.stopPropagation();
    handleZoom(1.5, e.clientX, e.clientY);
  };

  const handleContextMenu = (e: React.MouseEvent<SVGSVGElement>) => {
    e.preventDefault();
    e.stopPropagation();
    handleZoom(0.67, e.clientX, e.clientY);
  };

  const handleZoom = (factor: number, mouseX?: number, mouseY?: number) => {
    setViewBox(prev => {
      const newScale = Math.max(0.1, Math.min(5, prev.scale * factor));

      if (mouseX !== undefined && mouseY !== undefined && svgRef.current) {
        // Zoom towards mouse position
        const rect = svgRef.current.getBoundingClientRect();
        const currentViewWidth = prev.width / prev.scale;
        const currentViewHeight = prev.height / prev.scale;
        const svgMouseX = prev.x + ((mouseX - rect.left) / rect.width) * currentViewWidth;
        const svgMouseY = prev.y + ((mouseY - rect.top) / rect.height) * currentViewHeight;

        const scaleRatio = newScale / prev.scale;

        return {
          ...prev,
          x: svgMouseX - (svgMouseX - prev.x) * scaleRatio,
          y: svgMouseY - (svgMouseY - prev.y) * scaleRatio,
          scale: newScale
        };
      } else {
        // Zoom towards center
        const scaleRatio = newScale / prev.scale;
        const centerX = prev.x + prev.width / (2 * prev.scale);
        const centerY = prev.y + prev.height / (2 * prev.scale);

        return {
          ...prev,
          x: centerX - (centerX - prev.x) * scaleRatio,
          y: centerY - (centerY - prev.y) * scaleRatio,
          scale: newScale
        };
      }
    });
  };

  const handleReset = () => {
    if (layouts.length > 0) {
      autoFitContent(layouts);
    } else {
      setViewBox({ x: 0, y: 0, width: 800, height: 600, scale: 1 });
    }
    setSelectedNodeId(undefined);
  };

  const handleFetchPlan = async (withActual: boolean) => {
    if (!activeResult) return;

    setIsLoading(true);
    setError(null);

    try {
      await fetchPlanGraph(activeResult.sql, withActual);
      setPlanMode(withActual ? 'actual' : 'estimated');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch plan graph');
    } finally {
      setIsLoading(false);
    }
  };

  const handleNodeClick = (node: PlanGraphNode) => {
    setSelectedNodeId(selectedNodeId === node.id ? undefined : node.id);
  };

  const copyPlanAsText = async () => {
    if (!planGraph) return;

    const lines = [`Query Plan (${planMode})`, '='.repeat(40), ''];

    const traverse = (node: PlanGraphNode, depth: number) => {
      const indent = '  '.repeat(depth);
      const timeInfo = node.actTimeMs ? ` (${node.actTimeMs.toFixed(1)}ms)` : '';
      const rowInfo = node.actRows ? ` [${node.actRows} rows]` : ` [~${node.estRows} rows]`;
      lines.push(`${indent}${node.opcode}${timeInfo}${rowInfo}`);

      if (node.extra?.detail) {
        lines.push(`${indent}  ${node.extra.detail}`);
      }

      node.children.forEach(child => traverse(child, depth + 1));
    };

    traverse(planGraph.root, 0);

    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 2000);
    } catch (error) {
      console.error('Failed to copy plan to clipboard:', error);
    }
  };

  if (!activeResult) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500 dark:text-gray-400">
        <div className="text-center">
          <Eye size={48} className="mx-auto mb-4 text-gray-400 dark:text-gray-500" />
          <p>No query selected for plan visualization</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-white dark:bg-gray-900">
      {/* Compact Header */}
      <div className="flex items-center justify-between p-3 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
        <div className="flex items-center gap-3">
          <h3 className="font-semibold text-gray-900 dark:text-white">
            Query Plan Graph
          </h3>

          <button
            onClick={() => setShowQuery(!showQuery)}
            className="p-1 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
            title="Toggle query display"
          >
            <Info size={16} />
          </button>
        </div>

        <div className="flex items-center gap-2">
          {/* Plan mode toggle */}
          <div className="flex items-center bg-gray-100 dark:bg-gray-700 rounded-lg p-1">
            <button
              onClick={() => handleFetchPlan(false)}
              className={`px-2 py-1 text-xs rounded transition-colors ${
                planMode === 'estimated'
                  ? 'bg-white dark:bg-gray-600 text-gray-900 dark:text-white shadow'
                  : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'
              }`}
            >
              Estimated
            </button>
            <button
              onClick={() => handleFetchPlan(true)}
              className={`px-2 py-1 text-xs rounded transition-colors ${
                planMode === 'actual'
                  ? 'bg-white dark:bg-gray-600 text-gray-900 dark:text-white shadow'
                  : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'
              }`}
            >
              <Activity size={10} className="inline mr-1" />
              Actual
            </button>
          </div>

          {/* Zoom controls */}
          <div className="flex items-center gap-1">
            <button
              onClick={() => handleZoom(1.2)}
              className="p-1 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white"
              title="Zoom in"
            >
              <ZoomIn size={14} />
            </button>
            <button
              onClick={() => handleZoom(0.8)}
              className="p-1 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white"
              title="Zoom out"
            >
              <ZoomOut size={14} />
            </button>
            <button
              onClick={handleReset}
              className="p-1 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white"
              title="Reset view"
            >
              <RotateCcw size={14} />
            </button>
          </div>

          {/* Copy and toggle buttons */}
          {planGraph && (
            <>
              <button
                onClick={copyPlanAsText}
                className="p-1 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white"
                title="Copy plan as text"
              >
                {copySuccess ? <Check size={14} /> : <Copy size={14} />}
              </button>
              <button
                onClick={() => setShowLegend(!showLegend)}
                className="p-1 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white"
                title="Toggle legend"
              >
                <Minimize2 size={14} />
              </button>
            </>
          )}

          {/* Fetch button */}
          <button
            onClick={() => handleFetchPlan(planMode === 'actual')}
            disabled={isLoading}
            className="flex items-center gap-1 px-2 py-1 text-xs bg-blue-500 hover:bg-blue-600 disabled:bg-gray-400 text-white rounded transition-colors"
          >
            <Play size={14} />
            {isLoading ? 'Loading...' : 'Go'}
          </button>
        </div>
      </div>

      {/* Collapsible Query display */}
      {showQuery && activeResult && (
        <div className="p-2 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
          <div className="bg-gray-100 dark:bg-gray-700 rounded p-2">
            <pre className="text-xs text-gray-800 dark:text-gray-200 whitespace-pre-wrap break-words">
              {activeResult.sql}
            </pre>
          </div>
        </div>
      )}

      {/* Error display */}
      {error && (
        <div className="p-2 bg-red-50 dark:bg-red-900/20 border-b border-red-200 dark:border-red-800">
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        </div>
      )}

      {/* SVG Graph - takes remaining space */}
      <div className="flex-1 overflow-hidden relative">
        {planGraph ? (
          <svg
            ref={svgRef}
            className={`w-full h-full ${isDragging ? 'cursor-grabbing' : 'cursor-grab'}`}
            viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width / viewBox.scale} ${viewBox.height / viewBox.scale}`}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
            onWheel={handleWheel}
            onDoubleClick={handleDoubleClick}
            onContextMenu={handleContextMenu}
          >
            {/* Connections */}
            {layouts.map(layout =>
              layout.node.children.map(child => {
                const childLayout = layouts.find(l => l.node.id === child.id);
                if (!childLayout) return null;

                return (
                  <line
                    key={`${layout.node.id}-${child.id}`}
                    x1={layout.x}
                    y1={layout.y + 40} // Updated for smaller nodes
                    x2={childLayout.x}
                    y2={childLayout.y - 40} // Updated for smaller nodes
                    stroke="#94a3b8"
                    strokeWidth="2"
                  />
                );
              })
            )}

            {/* Nodes */}
            {layouts.map(layout => {
              const score = getHotspotScore(layout.node, planGraph.totals);
              const isSelected = selectedNodeId === layout.node.id;
              const node = layout.node;

              // Extract information from the proper fields
              const objectName = node.extra?.objectName || '';
              const alias = node.extra?.alias || '';
              const nodeType = node.extra?.nodeType || '';
              const detail = node.extra?.detail || '';
              const subqueryLevel = node.extra?.subqueryLevel || 0;
              const hasActual = node.actTimeMs !== undefined || node.actRows !== undefined;

              // Create meaningful display text
              const displayName = objectName || (nodeType !== node.opcode ? nodeType : '');
              const aliasText = alias ? ` AS ${alias}` : '';
              const subqueryText = subqueryLevel > 0 ? ` (L${subqueryLevel})` : '';

              return (
                <g key={layout.node.id}>
                  {/* Node background - tighter */}
                  <rect
                    x={layout.x - 100}
                    y={layout.y - 40} // Reduced from 50
                    width={200}
                    height={80} // Reduced from 100
                    fill={getNodeColor(score)}
                    stroke={isSelected ? '#3b82f6' : getNodeBorderColor(score)}
                    strokeWidth={isSelected ? 3 : 2}
                    rx={6}
                    className="cursor-pointer hover:stroke-blue-500"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleNodeClick(layout.node);
                    }}
                  />

                  {/* Top row: Operation name + subquery level */}
                  <text
                    x={layout.x}
                    y={layout.y - 22} // Adjusted
                    textAnchor="middle"
                    className="text-sm font-bold pointer-events-none"
                    fill="currentColor"
                    style={{ color: '#1f2937' }}
                  >
                    {node.opcode}{subqueryText}
                  </text>

                  {/* Second row: Object name + alias */}
                  {displayName && (
                    <text
                      x={layout.x}
                      y={layout.y - 8} // Adjusted
                      textAnchor="middle"
                      className="text-xs font-medium pointer-events-none"
                      fill="currentColor"
                      style={{ color: '#4f46e5' }}
                    >
                      {displayName}{aliasText}
                    </text>
                  )}

                  {/* Third row: Rows (compact format) */}
                  <text
                    x={layout.x - 85}
                    y={layout.y + 6} // Adjusted
                    textAnchor="start"
                    className="text-xs pointer-events-none"
                    fill="currentColor"
                    style={{ color: '#6b7280' }}
                  >
                    Rows: {hasActual ? `${node.actRows || 0}` : `~${node.estRows || 0}`}
                  </text>

                  {/* Fourth row: Cost/Time (compact format) */}
                  <text
                    x={layout.x - 85}
                    y={layout.y + 18} // Adjusted
                    textAnchor="start"
                    className="text-xs pointer-events-none"
                    fill="currentColor"
                    style={{ color: '#6b7280' }}
                  >
                    {hasActual && node.actTimeMs ?
                      `Time: ${node.actTimeMs.toFixed(1)}ms` :
                      `Cost: ${(node.estCost || 0).toFixed(1)}`
                    }
                  </text>

                  {/* Fifth row: Estimated vs actual (when both available) - only if space */}
                  {hasActual && (node.actRows !== node.estRows || (node.actTimeMs && node.actTimeMs > 10)) && (
                    <text
                      x={layout.x - 85}
                      y={layout.y + 30} // Adjusted
                      textAnchor="start"
                      className="text-xs pointer-events-none"
                      fill="currentColor"
                      style={{ color: '#9ca3af' }}
                    >
                      Est: {node.estRows || 0} rows
                    </text>
                  )}

                  {/* Operation detail (right side, top) */}
                  {detail && detail !== node.opcode && (
                    <text
                      x={layout.x + 85}
                      y={layout.y + 6} // Adjusted
                      textAnchor="end"
                      className="text-xs pointer-events-none"
                      fill="currentColor"
                      style={{ color: '#9ca3af' }}
                    >
                      {detail.length > 20 ? `${detail.substring(0, 17)}...` : detail}
                    </text>
                  )}

                  {/* Performance indicator dot */}
                  {hasActual && node.actTimeMs && node.actTimeMs > 5 && (
                    <circle
                      cx={layout.x + 85}
                      cy={layout.y - 30} // Adjusted
                      r={3}
                      fill={node.actTimeMs > 100 ? '#ef4444' : node.actTimeMs > 25 ? '#f59e0b' : '#10b981'}
                      className="pointer-events-none"
                    />
                  )}

                  {/* Selection indicator */}
                  {isSelected && (
                    <circle
                      cx={layout.x - 85}
                      cy={layout.y - 30} // Adjusted
                      r={3}
                      fill="#3b82f6"
                      className="pointer-events-none"
                    />
                  )}

                  {/* Node ID badge (top left corner) */}
                  <text
                    x={layout.x - 90}
                    y={layout.y - 32} // Adjusted
                    className="text-xs font-mono pointer-events-none"
                    fill="currentColor"
                    style={{ color: '#9ca3af' }}
                  >
                    #{layout.node.id.replace('node-', '')}
                  </text>
                </g>
              );
            })}
          </svg>
        ) : (
          <div className="flex items-center justify-center h-full text-gray-500 dark:text-gray-400">
            <div className="text-center">
              <Eye size={48} className="mx-auto mb-4 text-gray-400 dark:text-gray-500" />
              <p className="mb-4">Click "Go" to visualize the query plan</p>
              <p className="text-sm text-gray-400 dark:text-gray-500">
                Double-click to zoom in • Right-click to zoom out • Drag to pan • Scroll to pan
              </p>
            </div>
          </div>
        )}

        {/* Floating Legend */}
        {planGraph && showLegend && (
          <div className="absolute bottom-2 left-2 bg-white dark:bg-gray-800 rounded shadow-lg border border-gray-200 dark:border-gray-600 p-2 text-xs text-gray-600 dark:text-gray-400">
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <span>Hotspots:</span>
                <div className="flex items-center gap-1">
                  <div className="w-2 h-2 bg-blue-100 border border-blue-400 rounded"></div>
                  <span>Low</span>
                </div>
                <div className="flex items-center gap-1">
                  <div className="w-2 h-2 bg-yellow-200 border border-yellow-500 rounded"></div>
                  <span>Med</span>
                </div>
                <div className="flex items-center gap-1">
                  <div className="w-2 h-2 bg-red-200 border border-red-500 rounded"></div>
                  <span>High</span>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

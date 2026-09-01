import { transpileQuereusAstToMermaidEr } from '@quereus/babel-fish';
import { Lexer, TokenType, parse, type DeclareSchemaStmt, type Statement } from '@quereus/quereus/parser';
import { AlertTriangle, CheckCircle2, GitBranch, MoveDown, MoveLeft, MoveRight, MoveUp, RefreshCw, ZoomIn, ZoomOut } from 'lucide-react';
import { type MermaidConfig } from 'mermaid';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSessionStore } from '../stores/sessionStore.js';
import { MermaidDiagram } from './MermaidDiagram.js';

type MermaidTheme = 'default' | 'neutral' | 'dark' | 'forest' | 'base';

interface DeclareSchemaBlock {
	id: string;
	statement: DeclareSchemaStmt;
	label: string;
}

function extractDeclareSchemaSnippets(sql: string): string[] {
	const lexer = new Lexer(sql);
	const tokens = lexer.scanTokens();
	const snippets: string[] = [];

	for (let i = 0; i < tokens.length; i += 1) {
		const token = tokens[i];
		if (token.type !== TokenType.DECLARE) {
			continue;
		}

		const nextToken = tokens[i + 1];
		if (!nextToken) {
			continue;
		}

		const isSchemaKeyword =
			nextToken.type === TokenType.SCHEMA || nextToken.lexeme.toLowerCase() === 'schema';
		if (!isSchemaKeyword) {
			continue;
		}

		let braceDepth = 0;
		let sawSchemaBody = false;
		let endOffset = token.endOffset;
		let endingTokenIndex = i;

		for (let j = i + 1; j < tokens.length; j += 1) {
			const current = tokens[j];
			endOffset = current.endOffset;
			endingTokenIndex = j;

			if (current.type === TokenType.LBRACE) {
				braceDepth += 1;
				sawSchemaBody = true;
			}
			if (current.type === TokenType.RBRACE) {
				braceDepth = Math.max(0, braceDepth - 1);
				if (sawSchemaBody && braceDepth === 0) {
					const maybeSemicolon = tokens[j + 1];
					if (maybeSemicolon?.type === TokenType.SEMICOLON) {
						endOffset = maybeSemicolon.endOffset;
						endingTokenIndex = j + 1;
					}
					break;
				}
			}

			if (current.type === TokenType.EOF) {
				break;
			}
		}

		i = endingTokenIndex;

		const snippet = sql.slice(token.startOffset, endOffset).trim();
		if (snippet.length > 0) {
			snippets.push(snippet);
		}
	}

	return snippets;
}

function extractDeclareSchemaBlocks(sql: string): DeclareSchemaBlock[] {
	const snippets = extractDeclareSchemaSnippets(sql);
	const blocks: DeclareSchemaBlock[] = [];

	for (let index = 0; index < snippets.length; index += 1) {
		const snippet = snippets[index];
		try {
			const parsed = parse(snippet);
			if (parsed.type !== 'declareSchema') {
				continue;
			}

			const schemaName = parsed.schemaName ?? `Schema ${index + 1}`;
			const versionSuffix = parsed.version ? ` (v${parsed.version})` : '';
			blocks.push({
				id: `declare-schema-${index}`,
				statement: parsed,
				label: `${schemaName}${versionSuffix}`,
			});
		} catch {
			continue;
		}
	}

	return blocks;
}

function buildMermaidFromDeclareSchema(block: DeclareSchemaBlock): string {
	const statementOnly: Statement[] = [block.statement];
	return transpileQuereusAstToMermaidEr(statementOnly);
}

export const ERDPanel: React.FC = () => {
	const { tabs, activeTabId } = useSessionStore();
	const [declareBlocks, setDeclareBlocks] = useState<DeclareSchemaBlock[]>([]);
	const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
	const [diagramCode, setDiagramCode] = useState<string | null>(null);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);
	const [activeTheme, setActiveTheme] = useState<MermaidTheme>('default');
	const [isRefreshing, setIsRefreshing] = useState(false);
	const [diagramRenderVersion, setDiagramRenderVersion] = useState(0);
	const [zoom, setZoom] = useState(0.9); // 90% zoom
	const [panX, setPanX] = useState(0);
	const [panY, setPanY] = useState(0);
	const diagramViewportRef = useRef<HTMLDivElement | null>(null);
	const diagramCanvasRef = useRef<HTMLDivElement | null>(null);

	const activeTab = useMemo(() => tabs.find(tab => tab.id === activeTabId), [tabs, activeTabId]);

	const selectedBlock = useMemo(
		() => declareBlocks.find(block => block.id === selectedBlockId) ?? null,
		[declareBlocks, selectedBlockId]
	);

	const refreshDiagram = useCallback(() => {
		setIsRefreshing(true);
		setErrorMessage(null);
		setZoom(1);
		setPanX(0);
		setPanY(0);

		try {
			const sql = activeTab?.content ?? '';
			const blocks = extractDeclareSchemaBlocks(sql);
			setDeclareBlocks(blocks);

			if (blocks.length === 0) {
				setSelectedBlockId(null);
				setDiagramCode(null);
				return;
			}

			const lastBlock = blocks[blocks.length - 1];
			setSelectedBlockId(lastBlock.id);
			setDiagramCode(buildMermaidFromDeclareSchema(lastBlock));
		} catch (error) {
			setDiagramCode(null);
			setErrorMessage(error instanceof Error ? error.message : 'Failed to generate ER diagram');
		} finally {
			setIsRefreshing(false);
		}
	}, [activeTab?.content]);

	useEffect(() => {
		refreshDiagram();
	}, [refreshDiagram]);

	const fitDiagramToWidth = useCallback(() => {
		const viewport = diagramViewportRef.current;
		const canvas = diagramCanvasRef.current;
		if (!viewport || !canvas) {
			return;
		}

		const svg = canvas.querySelector('svg');
		if (!svg) {
			return;
		}

		const viewBoxWidth = svg.viewBox?.baseVal?.width ?? 0;
		const measuredWidth = svg.getBoundingClientRect().width;
		const svgWidth = viewBoxWidth > 0 ? viewBoxWidth : measuredWidth;
		if (svgWidth <= 0) {
			return;
		}

		const availableWidth = Math.max(0, viewport.clientWidth - 24);
		const fittedZoom = Number((availableWidth / svgWidth).toFixed(2));
		setZoom(Math.max(0.9, Math.min(2.5, fittedZoom)));
		setPanX(0);
		setPanY(0);
	}, []);

	useEffect(() => {
		if (!diagramCode) {
			return;
		}

		let timeoutId: ReturnType<typeof setTimeout> | null = null;
		const frameId = requestAnimationFrame(() => {
			timeoutId = setTimeout(() => {
				fitDiagramToWidth();
			}, 150);
		});

		return () => {
			cancelAnimationFrame(frameId);
			if (timeoutId) {
				clearTimeout(timeoutId);
			}
		};
	}, [diagramCode, diagramRenderVersion, activeTheme, selectedBlockId, fitDiagramToWidth]);

	const handleSelectBlock = useCallback((block: DeclareSchemaBlock) => {
		setErrorMessage(null);
		setZoom(1);
		setPanX(0);
		setPanY(0);
		setSelectedBlockId(block.id);
		try {
			setDiagramCode(buildMermaidFromDeclareSchema(block));
		} catch (error) {
			setDiagramCode(null);
			setErrorMessage(error instanceof Error ? error.message : 'Failed to render selected schema block');
		}
	}, []);

	const mermaidConfig = useMemo<MermaidConfig>(
		() => ({
			startOnLoad: false,
			theme: activeTheme,
			securityLevel: 'strict',
		}),
		[activeTheme]
	);

	const resetViewport = useCallback(() => {
		fitDiagramToWidth();
	}, [fitDiagramToWidth]);

	const handleThemeChange = useCallback((theme: MermaidTheme) => {
		setActiveTheme(theme);
		// Bumping the render version changes the diagram id, forcing a re-render
		// with the new theme (MermaidDiagram re-initializes mermaid on each render).
		setDiagramRenderVersion(prev => prev + 1);
	}, []);

	const nudgePan = useCallback((deltaX: number, deltaY: number) => {
		setPanX(prev => prev + deltaX);
		setPanY(prev => prev + deltaY);
	}, []);

	const adjustZoom = useCallback((delta: number) => {
		setZoom(prev => Math.max(0.4, Math.min(2.5, Number((prev + delta).toFixed(2)))));
	}, []);

	return (
		<div className="h-full flex flex-col bg-white dark:bg-gray-900">
			<div className="flex items-center justify-between p-3 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
				<div className="flex items-center gap-2">
					<GitBranch size={16} className="text-indigo-500" />
					<h3 className="font-semibold text-gray-900 dark:text-white">Entity Relationship Diagram</h3>
				</div>
				<button
					onClick={refreshDiagram}
					disabled={isRefreshing}
					className="flex items-center gap-1 px-2 py-1 text-xs bg-blue-500 hover:bg-blue-600 disabled:bg-gray-400 text-white rounded transition-colors"
				>
					<RefreshCw size={14} className={isRefreshing ? 'animate-spin' : ''} />
					Refresh Diagram
				</button>
			</div>

			<div className="px-3 py-2 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
				<div className="flex flex-wrap items-center gap-2">
					{(['default', 'neutral', 'dark', 'forest', 'base'] as MermaidTheme[]).map(theme => (
						<button
							key={theme}
							onClick={() => handleThemeChange(theme)}
							className={`px-2 py-1 text-xs rounded border transition-colors ${
								activeTheme === theme
									? 'border-blue-500 bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-200'
									: 'border-gray-300 text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700'
							}`}
						>
							{theme}
						</button>
					))}
					<div className="ml-auto flex items-center gap-1">
						<button
							onClick={() => adjustZoom(-0.1)}
							className="p-1 rounded border border-gray-300 text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
							title="Zoom out"
						>
							<ZoomOut size={14} />
						</button>
						<span className="min-w-12 text-center text-xs text-gray-600 dark:text-gray-300">{Math.round(zoom * 100)}%</span>
						<button
							onClick={() => adjustZoom(0.1)}
							className="p-1 rounded border border-gray-300 text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
							title="Zoom in"
						>
							<ZoomIn size={14} />
						</button>
						<button
							onClick={() => nudgePan(0, -40)}
							className="p-1 rounded border border-gray-300 text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
							title="Pan up"
						>
							<MoveUp size={14} />
						</button>
						<button
							onClick={() => nudgePan(-40, 0)}
							className="p-1 rounded border border-gray-300 text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
							title="Pan left"
						>
							<MoveLeft size={14} />
						</button>
						<button
							onClick={() => nudgePan(40, 0)}
							className="p-1 rounded border border-gray-300 text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
							title="Pan right"
						>
							<MoveRight size={14} />
						</button>
						<button
							onClick={() => nudgePan(0, 40)}
							className="p-1 rounded border border-gray-300 text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
							title="Pan down"
						>
							<MoveDown size={14} />
						</button>
						<button
							onClick={resetViewport}
							className="px-2 py-1 text-xs rounded border border-gray-300 text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
						>
							Reset View
						</button>
					</div>
				</div>
			</div>

			{errorMessage && (
				<div className="m-3 p-3 rounded border border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-900/30">
					<div className="flex items-center gap-2 text-red-700 dark:text-red-300">
						<AlertTriangle size={16} />
						<span className="text-sm font-medium">ERD generation failed</span>
					</div>
					<p className="mt-1 text-sm text-red-700 dark:text-red-300">{errorMessage}</p>
				</div>
			)}

			<div className="flex-1 min-h-0 grid grid-cols-12">
				<div className="col-span-3 border-r border-gray-200 dark:border-gray-700 overflow-auto p-3">
					<h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-2">
						Declare Schema Blocks
					</h4>
					{declareBlocks.length === 0 ? (
						<p className="text-sm text-gray-500 dark:text-gray-400">
							No `declare schema` blocks found.
						</p>
					) : (
						<div className="space-y-2">
							{declareBlocks.map((block, idx) => (
								<button
									key={block.id}
									onClick={() => handleSelectBlock(block)}
									className={`w-full text-left p-2 rounded border transition-colors ${
										selectedBlockId === block.id
											? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
											: 'border-gray-200 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800'
									}`}
								>
									<div className="text-xs text-gray-500 dark:text-gray-400">Block {idx + 1}</div>
									<div className="text-sm font-medium text-gray-900 dark:text-gray-100">{block.label}</div>
								</button>
							))}
						</div>
					)}
				</div>

				<div className="col-span-9 overflow-auto p-3">
					{diagramCode ? (
						<div ref={diagramViewportRef} className="h-full border border-gray-200 dark:border-gray-700 rounded bg-white dark:bg-gray-900 p-3 overflow-auto">
							<div className="mb-2 flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
								<CheckCircle2 size={14} className="text-green-500" />
								<span>Rendering from: {selectedBlock?.label ?? 'Selected declare schema block'}</span>
							</div>
							<div
								className="erd-diagram-canvas"
								ref={diagramCanvasRef}
								style={{
									transform: `translate(${panX}px, ${panY}px) scale(${zoom})`,
									transformOrigin: 'top left',
									width: 'max-content',
									minWidth: '100%',
								}}
							>
								<MermaidDiagram
									id={`erd-${activeTheme}-${selectedBlockId ?? 'none'}-${diagramRenderVersion}`}
									code={diagramCode}
									config={mermaidConfig}
								/>
							</div>
						</div>
					) : (
						<div className="h-full flex items-center justify-center text-gray-500 dark:text-gray-400 border border-dashed border-gray-300 dark:border-gray-700 rounded">
							<div className="text-center p-4">
								<p className="font-medium">A `declare schema` block is required for ER Diagram.</p>
								<p className="text-sm mt-2">Add one in the editor, then click Refresh Diagram.</p>
							</div>
						</div>
					)}
				</div>
			</div>
		</div>
	);
};

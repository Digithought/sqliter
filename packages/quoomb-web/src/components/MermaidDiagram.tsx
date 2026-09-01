import mermaid, { type MermaidConfig } from 'mermaid';
import React, { useEffect, useRef, useState } from 'react';

export interface MermaidDiagramProps {
	/** Stable id used to seed mermaid's internal SVG element id. Vary it to force a re-render. */
	id: string;
	/** Mermaid diagram source. */
	code: string;
	/** Mermaid configuration; merged over `{ startOnLoad: false }`. */
	config?: MermaidConfig;
}

/**
 * Renders a single mermaid diagram from a source string.
 *
 * Replaces the `react-markdown-mermaid` wrapper: we only need direct diagram
 * rendering, not markdown parsing, so this calls mermaid's render API directly.
 * mermaid sanitises the produced SVG via DOMPurify (see `securityLevel`).
 */
export const MermaidDiagram: React.FC<MermaidDiagramProps> = ({ id, code, config }) => {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const renderSeq = useRef(0);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		const seq = ++renderSeq.current;

		const renderDiagram = async () => {
			const container = containerRef.current;
			if (!container) {
				return;
			}

			try {
				mermaid.initialize({ startOnLoad: false, ...config });
				// Unique id per render avoids collisions with mermaid's temporary DOM node.
				const { svg, bindFunctions } = await mermaid.render(`${id}-${seq}`, code);
				// Ignore results from superseded renders.
				if (seq !== renderSeq.current || !containerRef.current) {
					return;
				}
				containerRef.current.innerHTML = svg;
				bindFunctions?.(containerRef.current);
				setError(null);
			} catch (err) {
				if (seq !== renderSeq.current) {
					return;
				}
				if (containerRef.current) {
					containerRef.current.innerHTML = '';
				}
				setError(err instanceof Error ? err.message : 'Failed to render diagram');
			}
		};

		void renderDiagram();
	}, [id, code, config]);

	if (error) {
		return <pre className="text-sm text-red-600 dark:text-red-400 whitespace-pre-wrap">{error}</pre>;
	}

	return <div ref={containerRef} />;
};

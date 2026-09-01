declare module '@quereus/babel-fish' {
	import type { Statement } from '@quereus/quereus/parser';

	export function transpileQuereusAstToMermaidEr(statements: Statement[]): string;
}

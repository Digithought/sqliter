/**
 * Helpers for *static convention guards* — tests that read engine source files as
 * text and assert a coding convention holds. They cost nothing at runtime and catch
 * the exact mistake they were written for, at the price of being string matchers:
 * keep the patterns narrow and the allowlists short.
 *
 * See `docs/invariants.md` for the invariants these guards back.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Remove block and line comments so a guard keys on code, not on prose that
 * happens to name the symbol being searched for. Newlines inside block comments
 * survive, so line numbers in the stripped text still match the original file.
 *
 * NOTE: naive — a `//` inside a string literal (e.g. a URL) would be treated as a
 * comment start. No planner source currently contains one; if that changes, the
 * symptom is a guard that stops seeing code after such a line, so it fails open.
 */
export function stripComments(src: string): string {
	return src
		.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, '')) // block comments, line count preserved
		.replace(/\/\/[^\n]*/g, ''); // line comments
}

/** 1-based line number of `index` within `src`. */
export function lineAt(src: string, index: number): number {
	let line = 1;
	for (let i = 0; i < index; i++) if (src[i] === '\n') line++;
	return line;
}

/** Absolute paths of every `.ts` file under `dir`, recursively. */
export function tsFilesUnder(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...tsFilesUnder(full));
		else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full);
	}
	return out;
}

/** Comment-stripped contents of a source file. */
export function readCode(file: string): string {
	return stripComments(readFileSync(file, 'utf8'));
}

/** Path relative to `root`, with forward slashes on every platform. */
export function relPosix(root: string, file: string): string {
	return file.slice(root.length).replace(/\\/g, '/').replace(/^\//, '');
}

#!/usr/bin/env node

// Documentation integrity gate. Cheapest link in `yarn check`, so it runs first.
//
// Five independent checks, all reporting to one failure list:
//
//   A. Link integrity   — every markdown link and every `docs/*.md` reference in
//                         the source tree names a file that exists, and every
//                         `#anchor` names a heading that exists in that file.
//   B. Invariant format — `docs/invariants.md` (when present) parses as a register
//                         of invariant blocks whose `code:`/`guard:`/`doc:` pointers
//                         still resolve. Pointers only; semantics are what tests are for.
//   C. Size ratchet     — a doc listed in `docs/.doc-budget.json` may shrink but never
//                         grow past its recorded size; an unlisted doc must come in
//                         under the global `maxWords`.
//   D. Stability tiers  — every docs/*.md is classified in `docs/.stability.json`, every
//                         tiered doc carries exactly one header banner naming its
//                         recorded tier, and every tier named anywhere is one that
//                         `docs/stability.md` defines.
//   E. Package tiers    — the same three-way agreement for package `README.md` banners:
//                         every package `yarn pub` publishes is classified in
//                         `docs/.stability.json`, and its README carries exactly one
//                         well-formed banner naming its recorded tier.
//
// Usage:
//   node scripts/check-docs.mjs                    run every check; exit 1 on any failure
//   node scripts/check-docs.mjs --update-ratchet   lower ratchet entries to current sizes
//   node scripts/check-docs.mjs --update-ratchet --force
//                                                  ...also allow raising / adding entries
//
// See docs/doc-conventions.md for what belongs in a doc and how to lower a ratchet entry.

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUDGET_PATH = join(ROOT, 'docs', '.doc-budget.json');
const INVARIANTS_PATH = join(ROOT, 'docs', 'invariants.md');
const STABILITY_PATH = join(ROOT, 'docs', '.stability.json');
const STABILITY_DOC_PATH = join(ROOT, 'docs', 'stability.md');

// Frozen review artifacts: they describe a past state on purpose and must not be "corrected".
const EXEMPT = new Set(['docs/review.md', 'docs/review.html']);

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', 'out', 'coverage']);

// ---------------------------------------------------------------------------
// paths
// ---------------------------------------------------------------------------

/** Repo-relative, forward-slashed. The repo is developed on win32; `\` never leaves this module. */
const toPosix = (p) => p.split(sep).join('/');
const repoPath = (abs) => toPosix(relative(ROOT, abs));

/**
 * Read with line endings normalized to `\n` and any leading byte-order mark dropped.
 *
 * NOTE: this is load-bearing on win32, where the working tree is CRLF. JavaScript's `.`
 * does not match `\r` (it is a line terminator), so a `(.*)$` pattern silently fails to
 * match any line of a CRLF file — fences never open and headings never parse. Every
 * regex in this module assumes LF; read through here, never `readFileSync` directly.
 *
 * The BOM strip is the same class of defect one character in: `docs/sync.md` opens with
 * U+FEFF, so `/^# /` never matched its H1 and its title anchor was invisible to Check A.
 */
const readText = (path) => readFileSync(path, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');

// NOTE: the tree is re-walked and every file re-read on each run (~1s for this repo). If the
// checker ever shows up as slow in `yarn check`, cache results by mtime rather than trimming
// the corpus — a check that skips files is a check that misses breakage.
function walk(dir, predicate, found = []) {
	if (!existsSync(dir)) return found;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name), predicate, found);
		} else if (predicate(join(dir, entry.name))) {
			found.push(join(dir, entry.name));
		}
	}
	return found;
}

/**
 * Every workspace directory: `packages/*` plus `packages/tools/*`, mirroring the `workspaces`
 * globs in the root `package.json`.
 *
 * NOTE: a directory under `packages/` with no `package.json` of its own is a grouping folder,
 * not a package, so we descend one level into it. Before this, `packages/tools` was treated as
 * a package — it has no `README.md` and no `src/` — and `packages/tools/planviz` was invisible
 * to every check that walks packages.
 */
function packageDirs() {
	const pkgRoot = join(ROOT, 'packages');
	if (!existsSync(pkgRoot)) return [];

	const children = (dir) =>
		readdirSync(dir, { withFileTypes: true })
			.filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name))
			.map((e) => join(dir, e.name));

	const dirs = [];
	for (const dir of children(pkgRoot)) {
		if (existsSync(join(dir, 'package.json'))) dirs.push(dir);
		else dirs.push(...children(dir).filter((sub) => existsSync(join(sub, 'package.json'))));
	}
	return dirs;
}

/** `docs/**\/*.md`, minus the frozen review artifacts. */
function docFiles() {
	return walk(join(ROOT, 'docs'), (f) => f.endsWith('.md')).filter((f) => !EXEMPT.has(repoPath(f)));
}

/**
 * The repo README plus every package README, top-level and nested under `src/` or `test/`.
 * These are source-tree docs. The repo README carries the documentation index, so it is the
 * most link-dense file in the tree and the one whose rot is most visible to a newcomer.
 */
function readmeFiles() {
	const files = [];
	const rootReadme = join(ROOT, 'README.md');
	if (existsSync(rootReadme)) files.push(rootReadme);
	for (const pkg of packageDirs()) {
		const top = join(pkg, 'README.md');
		if (existsSync(top)) files.push(top);
		const nested = (f) => f.endsWith(`${sep}README.md`);
		files.push(...walk(join(pkg, 'src'), nested));
		files.push(...walk(join(pkg, 'test'), nested));
	}
	return files;
}

/** `packages/*\/src/**\/*.ts` and `packages/*\/test/**\/*.ts`. */
function sourceFiles() {
	const files = [];
	const isTs = (f) => f.endsWith('.ts') && !f.endsWith('.d.ts');
	for (const pkg of packageDirs()) {
		files.push(...walk(join(pkg, 'src'), isTs));
		files.push(...walk(join(pkg, 'test'), isTs));
	}
	return files;
}

// ---------------------------------------------------------------------------
// markdown
// ---------------------------------------------------------------------------

/**
 * Blank out fenced code blocks, preserving line count so reported line numbers stay true.
 * Several docs show example markdown; without this the checker reports phantom links.
 */
function stripFences(content) {
	const lines = content.split('\n');
	let fenceChar = null;
	let fenceLen = 0;

	return lines
		.map((line) => {
			const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
			if (fenceChar === null) {
				if (match) {
					fenceChar = match[1][0];
					fenceLen = match[1].length;
					return '';
				}
				return line;
			}
			const closes = match && match[1][0] === fenceChar && match[1].length >= fenceLen && match[2].trim() === '';
			if (closes) fenceChar = null;
			return '';
		})
		.join('\n');
}

/**
 * GitHub's heading-anchor algorithm, as implemented by `github-slugger`:
 * lowercase, drop punctuation and symbols, spaces to hyphens, `-1`/`-2` for repeats.
 *
 * What survives is letters, numbers, `_` and `-` — note that "letters" is Unicode-wide,
 * so `### Selection (σ)` anchors as `selection-σ`. What goes is punctuation and symbols:
 * the U+2011 non-breaking hyphen, and `≡ → ∅ & ( )`. That is why
 * `### Rename propagation ("MV ≡ faster view")` resolves with a *double* hyphen — the
 * dropped `≡` leaves its two surrounding spaces behind. Live links depend on these exact
 * forms; `selfTest()` pins them.
 */
function slugify(headingText) {
	return headingText
		.toLowerCase()
		.replace(/[^\p{L}\p{N} _-]/gu, '')
		.replace(/ /g, '-');
}

/** Render heading source to the text GitHub slugs: link syntax collapses to its label. */
function headingText(raw) {
	return raw
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
		.trim();
}

/**
 * Every anchor `content` exposes, computed with a per-file repeat counter.
 *
 * NOTE: `-1`/`-2` suffixes are assigned in document order, so reordering two headings that
 * share a base slug silently retargets any link to the suffixed one. Both mega-docs repeat
 * `### Overview` / `### Registration`. If a split ticket ever moves such a pair, re-check
 * its links by hand — the checker cannot see that kind of breakage.
 */
function headingSlugs(content) {
	const seen = new Map();
	const slugs = new Set();

	for (const line of stripFences(content).split('\n')) {
		const match = /^(#{1,6})\s+(.*)$/.exec(line);
		if (!match) continue;

		const base = slugify(headingText(match[2]));
		const count = seen.get(base) ?? 0;
		seen.set(base, count + 1);
		slugs.add(count === 0 ? base : `${base}-${count}`);
	}
	return slugs;
}

const anchorCache = new Map();

function anchorsOf(absPath) {
	if (!anchorCache.has(absPath)) {
		anchorCache.set(absPath, headingSlugs(readText(absPath)));
	}
	return anchorCache.get(absPath);
}

// ---------------------------------------------------------------------------
// reference extraction
// ---------------------------------------------------------------------------

const EXTERNAL = /^(https?:|mailto:|data:|tel:|#!)/;

/**
 * Blank inline code spans so a `](…)`-shaped expression inside backticks (a plan-tree
 * illustration like `` `Project[keys](Filter(residual, c))` ``) is not extracted as a link.
 * Each span collapses to a single space, so link *text* that is itself inline code
 * (`[`alter table …`](#anchor)`) keeps resolving — the `](target)` sits outside the span.
 */
const stripInlineCode = (line) => line.replace(/`[^`]*`/g, ' ');

/** Markdown links `](target)` outside fenced code and inline code, with 1-based line numbers. */
function markdownLinks(content) {
	const refs = [];
	stripFences(content)
		.split('\n')
		.forEach((line, index) => {
			for (const match of stripInlineCode(line).matchAll(/\]\(([^)]+)\)/g)) {
				// `](path "title")` — the target is the first whitespace-delimited token.
				const target = match[1].trim().split(/\s+/)[0].replace(/^<|>$/g, '');
				if (!target || EXTERNAL.test(target)) continue;
				refs.push({ target, line: index + 1 });
			}
		});
	return refs;
}

/**
 * Bare `docs/<name>.md` / `docs/<name>.md#anchor` references in the source tree.
 *
 * The lookbehind rejects anything preceded by a path segment, which is what makes
 * `// ...like [text](../docs/foo.md)` in documentation.spec.ts a non-reference: it is
 * an illustration of link syntax, not a pointer at a real file. A *bare* ref is
 * repo-root-relative by definition.
 *
 * A trailing prose section marker (`See docs/optimizer.md § Audit discipline`) is not an
 * anchor and is ignored — the regex simply stops at `.md`.
 */
function bareDocRefs(content) {
	const refs = [];
	content.split('\n').forEach((line, index) => {
		for (const match of line.matchAll(/(?<![\w./\\-])(docs\/[A-Za-z0-9._-]+\.md)(#[A-Za-z0-9_-]+)?/g)) {
			refs.push({ target: match[1] + (match[2] ?? ''), line: index + 1, rootRelative: true });
		}
	});
	return refs;
}

// ---------------------------------------------------------------------------
// Check A — link integrity
// ---------------------------------------------------------------------------

function checkReference(ref, referrerAbs, fail) {
	const [targetPath, anchor] = ref.target.split('#');
	const where = `${repoPath(referrerAbs)}:${ref.line}`;

	// `](#anchor)` — same-page, validated against the containing file.
	if (targetPath === '') {
		if (anchor && !anchorsOf(referrerAbs).has(anchor)) {
			fail(`${where}: dead same-page anchor '#${anchor}'`);
		}
		return;
	}

	const base = ref.rootRelative ? ROOT : dirname(referrerAbs);
	const absTarget = resolve(base, targetPath);

	if (!existsSync(absTarget)) {
		fail(`${where}: link target does not exist: '${targetPath}'`);
		return;
	}
	// `](../quereus-store/)` — a directory link; GitHub renders its README. Nothing to anchor into.
	if (statSync(absTarget).isDirectory()) {
		if (anchor) fail(`${where}: anchor '#${anchor}' on a directory target '${targetPath}'`);
		return;
	}
	if (!anchor) return;

	if (!absTarget.endsWith('.md')) {
		fail(`${where}: anchor '#${anchor}' on a non-markdown target '${targetPath}'`);
		return;
	}
	if (EXEMPT.has(repoPath(absTarget))) return;

	if (!anchorsOf(absTarget).has(anchor)) {
		fail(`${where}: dead anchor '#${anchor}' in '${targetPath}'`);
	}
}

function checkLinks(fail) {
	for (const file of [...docFiles(), ...readmeFiles()]) {
		const content = readText(file);
		for (const ref of markdownLinks(content)) checkReference(ref, file, fail);
	}
	// Bare `docs/*.md` refs live in the source tree, never in `docs/` prose — a design doc
	// legitimately names a sibling doc (or a planned one) in running text. A README's fenced
	// blocks are stripped for the same reason they are stripped above: a doc path inside a
	// shell example is an illustration, not a pointer. TypeScript has no fences to strip.
	for (const file of [...readmeFiles(), ...sourceFiles()]) {
		const content = readText(file);
		const scanned = file.endsWith('.md') ? stripFences(content) : content;
		for (const ref of bareDocRefs(scanned)) checkReference(ref, file, fail);
	}
}

// ---------------------------------------------------------------------------
// Check B — invariant-block format
// ---------------------------------------------------------------------------

const INVARIANT_HEADING = /^### ((?:OPT|MV|VU|RT|SCH|SYNC|LENS))-(\d{3}) — .+$/;
const META_LINE = /^-\s+(code|guard|doc):\s*(.*)$/;
const MAX_INVARIANT_BODY_WORDS = 120;

/**
 * Split `docs/invariants.md` into `### ID — title` blocks, keeping line numbers.
 *
 * A block ends at the next heading of ANY level, so an area's `## <Area>` heading and the
 * preamble prose under it are charged to nobody — not to the preceding invariant's 120-word
 * budget. (Before this, an area preamble silently ate the last block's headroom.)
 */
function parseInvariantBlocks(content) {
	const blocks = [];
	let open = null;
	stripFences(content)
		.split('\n')
		.forEach((line, index) => {
			if (/^### /.test(line)) {
				open = { heading: line, line: index + 1, body: [] };
				blocks.push(open);
			} else if (/^#{1,6} /.test(line)) {
				open = null; // a heading of any other level closes the current block
			} else if (open) {
				open.body.push({ text: line, line: index + 1 });
			}
		});
	return blocks;
}

/** `- code: \`path\` — \`symbol\` (aside)` → `{ kind, path, symbol }`. */
function parseMetaLine(kind, rest) {
	if (kind === 'doc') {
		const link = /\]\(([^)\s]+)\)/.exec(rest);
		return link ? { kind, target: link[1] } : null;
	}
	if (kind === 'guard' && /^none\b/.test(rest)) {
		// `guard: none — <reason>` is legal and explicit. A bare `guard: none` is not.
		return { kind, none: true, reason: rest.slice('none'.length).replace(/^\s*—\s*/, '').trim() };
	}
	const ticked = [...rest.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
	if (!ticked.length) return null;
	return { kind, path: ticked[0], symbol: ticked[1] };
}

function checkInvariantPointer(meta, at, fail) {
	if (meta.kind === 'doc') {
		checkReference({ target: meta.target, line: at.line }, INVARIANTS_PATH, fail);
		return;
	}
	const abs = resolve(ROOT, meta.path);
	if (!existsSync(abs) || !statSync(abs).isFile()) {
		fail(`${at.where}: ${meta.kind}: names a file that does not exist: '${meta.path}'`);
		return;
	}
	// NOTE: a plain substring match, so a symbol surviving only in a comment still passes. That is
	// the intended strength — this validates pointers, not semantics. If it ever needs to be
	// stricter, match against the file with comments stripped rather than parsing TypeScript here.
	// Consequence for `guard:`: a common token (`isSet`) matches anywhere in the spec file and a
	// heading-style comment matches too, so a guard can name something that is not a test and still
	// pass. Write the exact `describe`/`it` title, or the name of the function driving the law.
	if (meta.symbol && !readText(abs).includes(meta.symbol)) {
		fail(`${at.where}: ${meta.kind}: symbol '${meta.symbol}' no longer appears in '${meta.path}'`);
	}
}

function checkInvariantBlock(block, ids, lastPerArea, fail) {
	const where = `docs/invariants.md:${block.line}`;
	const match = INVARIANT_HEADING.exec(block.heading);
	if (!match) {
		fail(`${where}: invariant heading must match '### <AREA>-<NNN> — <title>': ${block.heading.trim()}`);
		return;
	}

	const [, area, digits] = match;
	const id = `${area}-${digits}`;
	if (ids.has(id)) fail(`${where}: duplicate invariant id '${id}' (first seen at line ${ids.get(id)})`);
	else ids.set(id, block.line);

	// Ascending within an area; gaps are fine — a retired invariant's number is never reused.
	const previous = lastPerArea.get(area);
	if (previous !== undefined && Number(digits) <= previous) {
		fail(`${where}: invariant '${id}' is out of order — ${area} ids must ascend (previous was ${area}-${String(previous).padStart(3, '0')})`);
	}
	lastPerArea.set(area, Number(digits));

	const metas = [];
	const prose = [];
	for (const { text, line } of block.body) {
		const metaMatch = META_LINE.exec(text.trim());
		if (!metaMatch) {
			prose.push(text);
			continue;
		}
		const parsed = parseMetaLine(metaMatch[1], metaMatch[2].trim());
		if (!parsed) {
			fail(`docs/invariants.md:${line}: malformed '${metaMatch[1]}:' line — expected a \`path\` (or a markdown link for doc:)`);
			continue;
		}
		metas.push({ ...parsed, line });
	}

	if (!metas.some((m) => m.kind === 'code')) fail(`${where}: invariant '${id}' has no 'code:' line`);

	const guards = metas.filter((m) => m.kind === 'guard');
	if (guards.length !== 1) fail(`${where}: invariant '${id}' has ${guards.length} 'guard:' lines — expected exactly one`);
	for (const guard of guards) {
		if (guard.none && !guard.reason) {
			fail(`docs/invariants.md:${guard.line}: bare 'guard: none' — state the reason: 'guard: none — <reason>'`);
		}
	}

	for (const meta of metas) {
		if (meta.none) continue;
		checkInvariantPointer(meta, { where: `docs/invariants.md:${meta.line}`, line: meta.line }, fail);
	}

	const words = countWords(prose.join('\n'));
	if (words > MAX_INVARIANT_BODY_WORDS) {
		fail(`${where}: invariant '${id}' body is ${words} words (max ${MAX_INVARIANT_BODY_WORDS}) — it is two invariants, or it is rationale wearing an invariant's clothes`);
	}
}

function checkInvariants(fail) {
	// A zero-invariant register is the starting state, not a failure.
	if (!existsSync(INVARIANTS_PATH)) return;

	const blocks = parseInvariantBlocks(readText(INVARIANTS_PATH));
	const ids = new Map();
	const lastPerArea = new Map();
	for (const block of blocks) checkInvariantBlock(block, ids, lastPerArea, fail);
}

// ---------------------------------------------------------------------------
// Check C — size ratchet
// ---------------------------------------------------------------------------

/**
 * Whitespace-separated tokens over the whole file, fenced code included. Counting prose-only
 * is more principled and less predictable; a doc whose bulk is code samples is just as
 * unreviewable. The number only has to be comparable to itself over time.
 */
function countWords(content) {
	return content.split(/\s+/).filter(Boolean).length;
}

function readBudget() {
	if (!existsSync(BUDGET_PATH)) {
		throw new Error(`missing ${repoPath(BUDGET_PATH)} — the size ratchet has no data`);
	}
	return JSON.parse(readText(BUDGET_PATH));
}

function measureDocs() {
	const sizes = new Map();
	for (const file of docFiles()) sizes.set(repoPath(file), countWords(readText(file)));
	return sizes;
}

// NOTE: a ratchet entry naming a doc that no longer exists is not reported — it is inert, and
// `--update-ratchet` removes it. If a stale entry ever masks a re-added doc's real size, make
// this fail on the orphan instead.
function checkRatchet(fail) {
	const budget = readBudget();
	for (const [doc, words] of measureDocs()) {
		const recorded = budget.ratchet[doc];
		if (recorded === undefined) {
			if (words > budget.maxWords) {
				fail(`${doc}: ${words} words exceeds the ${budget.maxWords}-word cap for an unratcheted doc — split it, or record it with --update-ratchet --force and say why in the commit message`);
			}
		} else if (words > recorded) {
			fail(`${doc}: ${words} words exceeds its ratchet of ${recorded} (+${words - recorded}) — a doc may shrink, never grow`);
		}
	}
}

function updateRatchet(force) {
	const budget = readBudget();
	const sizes = measureDocs();
	const changes = [];
	const refusals = [];

	for (const [doc, recorded] of Object.entries(budget.ratchet)) {
		const words = sizes.get(doc);
		if (words === undefined) {
			changes.push(`  removed ${doc} (no longer present)`);
			delete budget.ratchet[doc];
		} else if (words < recorded) {
			changes.push(`  lowered ${doc}: ${recorded} -> ${words} (-${recorded - words})`);
			budget.ratchet[doc] = words;
		} else if (words > recorded) {
			if (!force) refusals.push(`  ${doc}: grew to ${words} from a ratchet of ${recorded} (+${words - recorded})`);
			else {
				changes.push(`  RAISED ${doc}: ${recorded} -> ${words} (+${words - recorded})`);
				budget.ratchet[doc] = words;
			}
		}
	}

	for (const [doc, words] of sizes) {
		if (budget.ratchet[doc] !== undefined || words <= budget.maxWords) continue;
		if (!force) refusals.push(`  ${doc}: ${words} words, over the ${budget.maxWords}-word cap and not in the ratchet`);
		else {
			changes.push(`  ADDED ${doc}: ${words}`);
			budget.ratchet[doc] = words;
		}
	}

	if (refusals.length) {
		console.error('Refusing to raise the ratchet (a ratchet you can silently raise is not a ratchet):');
		for (const refusal of refusals) console.error(refusal);
		console.error('\nShrink the doc, or re-run with --force and justify the raise in the commit message.');
		return 1;
	}

	if (!changes.length) {
		console.log('Ratchet already matches current doc sizes; nothing to do.');
		return 0;
	}

	budget.ratchet = Object.fromEntries(Object.entries(budget.ratchet).sort(([a], [b]) => a.localeCompare(b)));
	writeFileSync(BUDGET_PATH, `${JSON.stringify(budget, null, '\t')}\n`);
	console.log('Updated the ratchet:');
	for (const change of changes) console.log(change);
	return 0;
}

// ---------------------------------------------------------------------------
// Check D — stability banners
// ---------------------------------------------------------------------------

// The one legal banner form. Anchored, and deliberately not forgiving: a banner one character
// off is a banner that gets copy-pasted wrong forever. The dash is an em dash (U+2014), matching
// the `code:` / `guard:` line style of the invariant register.
//
// NOTE: the link target is the literal `stability.md#tiers`, which only resolves from a doc
// sitting directly in `docs/`. Every doc does today (`docs/images/` holds no markdown). The
// first `docs/<subdir>/x.md` that wants a tier will need `../stability.md#tiers`, which this
// regex rejects — accept both forms then, rather than letting Check A resolve the link the
// banner check has already forced to be wrong.
const BANNER = /^>\s+\*\*Stability:\s+(\w+)\*\*\s+—\s+see \[Stability Tiers\]\(stability\.md#tiers\)\.$/;

// Anything a reader would call a banner. Matching this but not BANNER is a malformed banner,
// reported as such — otherwise a wrong dash reads as "no banner at all".
const BANNER_ISH = /^>\s*\*\*Stability\b/;

/** `> **Stability: Beta** — see [Stability Tiers](stability.md#tiers).` → `{ tier }`; anything else → `null`. */
function parseBanner(line) {
	const match = BANNER.exec(line.trimEnd());
	return match ? { tier: match[1] } : null;
}

/** Every banner in `content`, fences already stripped, with 1-based line numbers. */
function banners(strippedContent, doc, fail) {
	const found = [];
	strippedContent.split('\n').forEach((line, index) => {
		const parsed = parseBanner(line);
		if (parsed) found.push({ tier: parsed.tier, line: index + 1 });
		else if (BANNER_ISH.test(line)) fail(`${doc}:${index + 1}: malformed stability banner: ${line.trim()}`);
	});
	return found;
}

/**
 * The lines below the `#` H1 that a header banner may occupy: everything up to the first
 * subsequent heading of any level, or six non-blank lines, whichever comes first. The
 * line-count bound is a fallback for a doc whose H1 is followed by a long intro before its
 * first `##`. Returns `null` when the doc has no H1.
 *
 * NOTE: every doc puts its banner on the line right below the H1, so the six-line bound has no
 * bite there. Package READMEs (Check E) are closer to it — `packages/quereus/README.md` spends
 * a logo line plus a four-line banner, five of the six. If a README ever needs badges above its
 * banner, or a banner longer than four lines, raise the bound rather than dropping it: a banner
 * outside the window is reported as sitting below the header, not as missing.
 */
function headerWindow(lines) {
	const h1 = lines.findIndex((line) => /^# /.test(line));
	if (h1 === -1) return null;

	const window = new Set();
	let nonBlank = 0;
	for (let i = h1 + 1; i < lines.length; i++) {
		if (/^#{1,6} /.test(lines[i])) break;
		if (lines[i].trim() !== '' && ++nonBlank > 6) break;
		window.add(i + 1); // 1-based, to match banner line numbers
	}
	return window;
}

/** The `###` headings under `## Tiers` in `docs/stability.md` — the vocabulary of tier names. */
function definedTiers(content) {
	const tiers = [];
	let inTiers = false;
	for (const line of stripFences(content).split('\n')) {
		const match = /^(#{1,6})\s+(.*)$/.exec(line);
		if (!match) continue;
		if (match[1].length <= 2) inTiers = match[1] === '##' && headingText(match[2]) === 'Tiers';
		else if (inTiers && match[1] === '###') tiers.push(headingText(match[2]));
	}
	return tiers;
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * `docs/.stability.json`, shape-checked. Read through `readText` like every other file: a BOM
 * or a CRLF line ending in a hand-edited JSON file must not turn into an opaque `JSON.parse`
 * error. (JSON forbids a raw newline inside a string, so normalizing them is a no-op on values.)
 *
 * The shape guard buys a message instead of a `TypeError` stack when a key goes missing — this
 * file is hand-edited, and deleting the last `untiered` doc is an easy way to delete the array.
 */
function readStability() {
	if (!existsSync(STABILITY_PATH)) {
		throw new Error(`missing ${repoPath(STABILITY_PATH)} — the stability map has no data`);
	}
	const stability = JSON.parse(readText(STABILITY_PATH));
	const shape = [
		['tiers', Array.isArray, 'an array'],
		['untiered', Array.isArray, 'an array'],
		['docs', isObject, 'an object'],
		['packages', isObject, 'an object'],
		['packagesSpanning', Array.isArray, 'an array'],
	];
	for (const [key, wellShaped, label] of shape) {
		if (!wellShaped(stability[key])) {
			throw new Error(`${repoPath(STABILITY_PATH)}: '${key}' is missing or is not ${label}`);
		}
	}
	return stability;
}

/** Rule 1: the two sources of tier names must agree as a set, so a rename fails loudly. */
function checkTierVocabulary(recorded, fail) {
	const defined = definedTiers(readText(STABILITY_DOC_PATH));
	if (!defined.length) fail(`docs/stability.md: no '###' tier headings under '## Tiers'`);

	for (const tier of recorded) {
		if (!defined.includes(tier)) fail(`docs/.stability.json: tier '${tier}' is not defined in docs/stability.md`);
	}
	for (const tier of defined) {
		if (!recorded.includes(tier)) fail(`docs/stability.md: tier '${tier}' is defined here but missing from docs/.stability.json`);
	}
	return new Set(defined);
}

/** Rule 2: every doc is classified exactly once, and every entry names a doc that exists. */
function checkClassification(stability, docs, fail) {
	const tiered = new Map(Object.entries(stability.docs));
	const untiered = new Set(stability.untiered);

	for (const doc of tiered.keys()) {
		if (untiered.has(doc)) fail(`docs/.stability.json: '${doc}' is classified twice — it is in both 'docs' and 'untiered'`);
	}
	// Unlike the ratchet, whose orphan entries are inert, a stale tier entry hides a missing
	// classification: re-add the doc and rule 2 would pass on an assignment nobody reviewed.
	for (const doc of [...tiered.keys(), ...untiered]) {
		if (docs.has(doc)) continue;
		if (EXEMPT.has(doc)) fail(`docs/.stability.json: entry '${doc}' is a frozen review artifact — every doc check skips it, so it must not be classified`);
		else fail(`docs/.stability.json: entry '${doc}' names a file that does not exist`);
	}
	for (const doc of docs) {
		if (!tiered.has(doc) && !untiered.has(doc)) {
			fail(`${doc}: not classified in docs/.stability.json — add it to 'docs' with a tier, or to 'untiered'`);
		}
	}
	return { tiered, untiered };
}

/** Rules 3 and 5: a tiered doc's header banner names its recorded tier; section banners only have to name a real tier. */
function checkTieredDoc(doc, tier, found, window, vocabulary, fail) {
	if (window === null) {
		fail(`${doc}: tiered '${tier}' but has no '#' heading — cannot locate the header window`);
		return;
	}

	const header = found.filter((banner) => window.has(banner.line));
	if (!header.length) {
		fail(`${doc}: tiered '${tier}' but carries no stability banner under its H1`);
	} else if (header.length > 1) {
		fail(`${doc}:${header[1].line}: a second stability banner in the header window — a doc declares exactly one tier`);
	} else if (header[0].tier !== tier) {
		fail(`${doc}:${header[0].line}: banner says '${header[0].tier}' but docs/.stability.json records '${tier}'`);
	}

	// A banner below the header window is a section override — that is how `declare schema` is
	// Beta inside a Stable `sql.md`. Disagreeing with the doc's tier is its whole purpose, so it
	// is checked for tier validity and nothing else.
	for (const banner of found) {
		if (window.has(banner.line)) continue;
		if (!vocabulary.has(banner.tier)) {
			fail(`${doc}:${banner.line}: section banner names tier '${banner.tier}', which is not defined in docs/stability.md`);
		}
	}
}

function checkStability(fail) {
	const stability = readStability();
	const docs = new Set(docFiles().map(repoPath));

	const vocabulary = checkTierVocabulary(stability.tiers, fail);
	const { tiered, untiered } = checkClassification(stability, docs, fail);

	for (const [doc, tier] of tiered) {
		if (!vocabulary.has(tier)) fail(`docs/.stability.json: '${doc}' is tiered '${tier}', which is not defined in docs/stability.md`);
	}

	for (const doc of docs) {
		// Fences first: `doc-conventions.md` and `stability.md` both show the banner form as an
		// illustration. Without this, `stability.md` fails rule 4 against its own example.
		const content = stripFences(readText(resolve(ROOT, doc)));
		const found = banners(content, doc, fail);

		if (untiered.has(doc)) {
			// Rule 4. Untiered docs never take the "missing banner" branch — the whole file is scanned,
			// H1 or no H1, and any banner at all is the failure.
			for (const banner of found) fail(`${doc}:${banner.line}: untiered doc carries a stability banner`);
		} else if (tiered.has(doc)) {
			checkTieredDoc(doc, tiered.get(doc), found, headerWindow(content.split('\n')), vocabulary, fail);
		}
	}

	// Check E reads the same file and the same tier vocabulary; parse and validate them once.
	return { stability, vocabulary };
}

// ---------------------------------------------------------------------------
// Check E — package README banners
// ---------------------------------------------------------------------------

const ROOT_PACKAGE_PATH = join(ROOT, 'package.json');

/** The classification of a package whose README declares no single tier — today only the engine. */
const SPANS = Symbol('spans tiers');

/**
 * The package directories `yarn pub` publishes, derived from the root `package.json` rather than
 * restated here. `pub` chains `yarn pub:<step>` calls; each step runs
 * `node scripts/publish-package.js <dir>`, where `<dir>` is relative to `packages/`.
 *
 * Deriving it is the point. The first pass at the package banners hand-listed the packages and
 * silently missed two that publish, which is exactly the drift this check exists to catch.
 */
function publishedPackages(scripts) {
	const chain = scripts.pub;
	if (typeof chain !== 'string') {
		throw new Error(`package.json: no 'pub' script — cannot derive the list of published packages`);
	}

	const dirs = [];
	for (const [, step] of chain.matchAll(/\byarn\s+(pub:[\w:-]+)/g)) {
		const command = scripts[step];
		if (typeof command !== 'string') throw new Error(`package.json: 'pub' runs '${step}', which is not a script`);

		const arg = /publish-package\.js\s+(\S+)/.exec(command);
		if (!arg) throw new Error(`package.json: '${step}' does not call scripts/publish-package.js — cannot tell which package it publishes`);
		dirs.push(`packages/${arg[1]}`);
	}
	if (!dirs.length) throw new Error(`package.json: the 'pub' script chains no 'yarn pub:*' steps`);
	return dirs;
}

/** The `docs/stability.md` target a README in `pkgDir` must link — `../../docs/stability.md`, one deeper under `packages/tools/`. */
const stabilityLinkFrom = (pkgDir) => toPosix(relative(resolve(ROOT, pkgDir), join(ROOT, 'docs', 'stability.md')));

/** Anything a reader would call a package banner: the line that opens the blockquote. */
const PACKAGE_BANNER_ISH = /^>\s*\*\*Stability\b/;

// A package banner is not a doc banner. The clause after the em dash spells out what the tier
// means for *this* package — the on-disk format for `@quereus/store`, the wire protocol for the
// sync packages — so it is free-form prose and wraps across several lines. Only the head and the
// trailing link are pinned; `parsePackageBanner` also requires a closing full stop.
const PACKAGE_TIER = /^\*\*Stability:\s+(\w+)\*\*\s+—\s+\S/;
const PACKAGE_SPANS = /^\*\*Stability\*\*\s+—\s+\S/;

/**
 * Every blockquote in `lines` that opens with `**Stability`, as `{ line, text }` with the `> `
 * prefixes stripped and the lines joined by single spaces. Matching line by line the way Check D
 * does would see only the banner's first line, which rarely reaches the link.
 */
function packageBannerBlocks(lines) {
	const blocks = [];
	for (let i = 0; i < lines.length; i++) {
		if (!PACKAGE_BANNER_ISH.test(lines[i])) continue;

		const text = [];
		let end = i;
		while (end < lines.length && lines[end].startsWith('>')) {
			text.push(lines[end].replace(/^>\s?/, '').trim());
			end++;
		}
		blocks.push({ line: i + 1, text: text.join(' ').trim() });
		i = end;
	}
	return blocks;
}

/**
 * `{ tier }` for a single-tier banner, `{ spans: true }` for the `**Stability**` form the engine
 * package uses, `null` for anything that is not a well-formed banner.
 */
function parsePackageBanner(text, pkgDir) {
	if (!text.endsWith('.')) return null;
	if (!text.includes(`[Stability Tiers](${stabilityLinkFrom(pkgDir)}#tiers)`)) return null;

	const tier = PACKAGE_TIER.exec(text);
	if (tier) return { tier: tier[1] };
	return PACKAGE_SPANS.test(text) ? { spans: true } : null;
}

/** Rule 1: a package is classified at most once, and every package that publishes is classified. */
function classifyPackages(stability, published, fail) {
	const classified = new Map(Object.entries(stability.packages));
	for (const pkgDir of stability.packagesSpanning) {
		if (classified.has(pkgDir)) {
			fail(`docs/.stability.json: '${pkgDir}' is classified twice — it is in both 'packages' and 'packagesSpanning'`);
		}
		classified.set(pkgDir, SPANS);
	}

	for (const pkgDir of published) {
		if (!classified.has(pkgDir)) {
			fail(`docs/.stability.json: '${pkgDir}' publishes to npm but is not classified — add it to 'packages' with a tier, or to 'packagesSpanning' if its README declares no single tier`);
		}
	}
	return classified;
}

/** Rules 2 and 3: exactly one banner, sitting under the H1, agreeing with the map. */
function checkPackageBanner(readme, pkgDir, expected, blocks, window, fail) {
	if (!blocks.length) {
		fail(`${readme}: no stability banner — a classified package states its tier under its '#' heading`);
		return;
	}
	if (blocks.length > 1) {
		fail(`${readme}:${blocks[1].line}: a second stability banner — a package declares exactly one tier`);
		return;
	}

	const [block] = blocks;
	if (window === null) fail(`${readme}: has no '#' heading — cannot locate the header window`);
	else if (!window.has(block.line)) {
		fail(`${readme}:${block.line}: stability banner sits below the header window — it belongs under the '#' heading, before the intro`);
	}

	const parsed = parsePackageBanner(block.text, pkgDir);
	if (!parsed) {
		fail(`${readme}:${block.line}: malformed stability banner — expected '> **Stability: <Tier>** — <what that means for this package>' closing with '[Stability Tiers](${stabilityLinkFrom(pkgDir)}#tiers).'`);
		return;
	}

	if (expected === SPANS) {
		if (!parsed.spans) fail(`${readme}:${block.line}: banner names tier '${parsed.tier}' but docs/.stability.json lists this package under 'packagesSpanning'`);
	} else if (parsed.spans) {
		fail(`${readme}:${block.line}: banner declares no single tier but docs/.stability.json records '${expected}'`);
	} else if (parsed.tier !== expected) {
		fail(`${readme}:${block.line}: banner says '${parsed.tier}' but docs/.stability.json records '${expected}'`);
	}
}

function checkPackageReadme(pkgDir, expected, fail) {
	const readme = `${pkgDir}/README.md`;
	const abs = resolve(ROOT, readme);
	// Unlike a ratchet orphan, a stale entry here is not inert: it is a tier assignment nobody
	// can read, and re-adding the package would pass on a classification nobody reviewed.
	if (!existsSync(abs)) {
		fail(`docs/.stability.json: '${pkgDir}' is classified but has no README.md — drop the entry, or restore the file`);
		return;
	}

	// Fences first, for the same reason Check D strips them: a README may show a banner as an
	// illustration, and an illustration is not a declaration.
	const lines = stripFences(readText(abs)).split('\n');
	checkPackageBanner(readme, pkgDir, expected, packageBannerBlocks(lines), headerWindow(lines), fail);
}

function checkPackages(stability, vocabulary, fail) {
	const published = publishedPackages(JSON.parse(readText(ROOT_PACKAGE_PATH)).scripts ?? {});
	const classified = classifyPackages(stability, published, fail);

	for (const [pkgDir, tier] of classified) {
		if (tier !== SPANS && !vocabulary.has(tier)) {
			fail(`docs/.stability.json: '${pkgDir}' is tiered '${tier}', which is not defined in docs/stability.md`);
		}
		checkPackageReadme(pkgDir, tier, fail);
	}

	// Rule 4. A banner on a README nobody classifies is a tier claim under no gate at all. The
	// classified set names every top-level package README that may carry one; anything else under
	// `packages/` — a nested `src/README.md`, or a package left out of the map — must not.
	for (const file of readmeFiles()) {
		const readme = repoPath(file);
		if (classified.has(readme.replace(/\/README\.md$/, ''))) continue;
		for (const block of packageBannerBlocks(stripFences(readText(file)).split('\n'))) {
			fail(`${readme}:${block.line}: stability banner in an unclassified README — classify its package in docs/.stability.json, or drop the banner`);
		}
	}
}

// ---------------------------------------------------------------------------
// self-test — pins the slugifier against forms that live links already depend on
// ---------------------------------------------------------------------------

function selfTest(fail) {
	const cases = [
		['Rename propagation ("MV ≡ faster view")', 'rename-propagation-mv--faster-view'],
		['Strategy selection (hash → merge)', 'strategy-selection-hash--merge'],
		['Row‑specific vs Global Classification for Assertions', 'rowspecific-vs-global-classification-for-assertions'],
		['Conflict Resolution (OR clause)', 'conflict-resolution-or-clause'],
		['2.1.1 Schema Search Path (WITH SCHEMA)', '211-schema-search-path-with-schema'],
		['`function_info()` columns', 'function_info-columns'],
		['Audit discipline: `sideEffectMode`', 'audit-discipline-sideeffectmode'],
		// Unicode letters survive; symbols and dashes do not.
		['Selection (σ)', 'selection-σ'],
		['4. Contract — retire the old table', '4-contract--retire-the-old-table'],
		['Store Isolation (Store Phase 8 - Future)', 'store-isolation-store-phase-8---future'],
		// Invariant headings: the em dash leaves a double hyphen, so a back-link written as
		// the short `#opt-014` does NOT resolve. Every back-link in the tree uses the full
		// slug; this case pins the form Check A resolves them against.
		['OPT-014 — An attribute ID is originated exactly once', 'opt-014--an-attribute-id-is-originated-exactly-once'],
		['OPT-030 — Uniqueness is read through one surface', 'opt-030--uniqueness-is-read-through-one-surface'],
	];
	for (const [heading, expected] of cases) {
		const actual = slugify(headingText(heading));
		if (actual !== expected) fail(`scripts/check-docs.mjs: slugifier regression: '${heading}' -> '${actual}', expected '${expected}'`);
	}

	const repeated = headingSlugs('## Overview\n\n## Overview\n\n## Overview\n');
	for (const expected of ['overview', 'overview-1', 'overview-2']) {
		if (!repeated.has(expected)) fail(`scripts/check-docs.mjs: duplicate-heading disambiguation lost '${expected}'`);
	}

	// Every stability banner links `stability.md#tiers`. Pinning the slug here means a rename of
	// `## Tiers` is caught once, rather than as forty simultaneous dead-anchor failures.
	if (slugify(headingText('Tiers')) !== 'tiers') fail(`scripts/check-docs.mjs: '## Tiers' no longer slugs to 'tiers'`);

	const banner = '> **Stability: Experimental** — see [Stability Tiers](stability.md#tiers).';
	if (parseBanner(banner)?.tier !== 'Experimental') fail(`scripts/check-docs.mjs: the canonical stability banner no longer parses`);

	const nearMisses = [
		'> **Stability: Experimental** - see [Stability Tiers](stability.md#tiers).', // hyphen, not an em dash
		'> **Stability: Experimental** — see Stability Tiers.', // no link
		'> **stability: Experimental** — see [Stability Tiers](stability.md#tiers).', // lowercase
		'> **Stability: Experimental** — see [Stability Tiers](stability.md#tiers)', // no full stop
		'> **Stability: Experimental** — see [Stability Tiers](#tiers).', // link relative to the wrong file
	];
	for (const line of nearMisses) {
		if (parseBanner(line)) fail(`scripts/check-docs.mjs: the banner regex tolerates a near-miss: ${line}`);
	}

	// A `](…)`-shaped plan expression inside backticks is not a link; inline code that is only
	// the link's *text* still resolves. `optimizer-rules.md` relies on both halves of this.
	const codeSpans = markdownLinks('a `Project[o.id, f](LeftJoin[c.fk = o.k] exists(o))` plan, see [`alter table`](#anchor).');
	if (codeSpans.length !== 1 || codeSpans[0].target !== '#anchor') {
		fail(`scripts/check-docs.mjs: inline-code link extraction broke: got ${JSON.stringify(codeSpans)}`);
	}

	// A banner shown inside a fence is an illustration, not a declaration. `doc-conventions.md`
	// and `stability.md` both rely on this, and `stability.md` is itself untiered.
	const fenced = stripFences(`# Doc\n\n\`\`\`markdown\n${banner}\n\`\`\`\n`);
	if (fenced.split('\n').some((line) => parseBanner(line))) fail(`scripts/check-docs.mjs: a fenced banner survives stripFences`);

	// The header window ends at the first subsequent heading, so a banner under `## Section` is a
	// section override — never the doc's header banner.
	const window = headerWindow(`# Doc\n\n${banner}\n\n## Section\n\n${banner}\n`.split('\n'));
	if (!window.has(3) || window.has(7)) fail(`scripts/check-docs.mjs: the header window no longer ends at the first subsequent heading`);
	if (headerWindow(['no h1 here']) !== null) fail(`scripts/check-docs.mjs: headerWindow must report a missing H1 as null`);

	stabilitySelfTest(fail);
	packageSelfTest(fail);
}

/** Run something that reports through a `fail` callback; return the messages it produced, in order. */
function collectFailures(run) {
	const messages = [];
	run((message) => messages.push(message));
	return messages;
}

function expectFailures(actual, expected, what, fail) {
	const matches = actual.length === expected.length && expected.every((needle, i) => actual[i].includes(needle));
	if (!matches) fail(`scripts/check-docs.mjs: ${what}: expected failures matching ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/**
 * Check D's rules, against injected inputs rather than the real `docs/` tree. `checkClassification`
 * and `checkTieredDoc` already take everything they need as arguments, so `checkStability` is the
 * only part of the check that touches the filesystem — and the only part left uncovered.
 */
function stabilitySelfTest(fail) {
	// Only `###` under `## Tiers` is a tier: not a deeper heading, and not one under a later `##`.
	const tiersDoc = ['# Stability Tiers', '## What a tier measures', '### Not a tier', '## Tiers', '### Stable', '#### Not a tier either', '### Beta', '## Assignment', '### Nor this'].join('\n');
	const defined = definedTiers(tiersDoc);
	if (defined.join(',') !== 'Stable,Beta') fail(`scripts/check-docs.mjs: definedTiers read '${defined.join(',')}' from a doc defining Stable and Beta`);

	expectFailures(
		collectFailures((f) => checkClassification(
			{ docs: { 'docs/a.md': 'Stable', 'docs/both.md': 'Beta', 'docs/gone.md': 'Beta' }, untiered: ['docs/b.md', 'docs/both.md', 'docs/review.md'] },
			new Set(['docs/a.md', 'docs/b.md', 'docs/both.md', 'docs/new.md']),
			f,
		)),
		[`'docs/both.md' is classified twice`, `entry 'docs/gone.md' names a file that does not exist`, `entry 'docs/review.md' is a frozen review artifact`, `docs/new.md: not classified`],
		'checkClassification',
		fail,
	);

	const vocabulary = new Set(['Stable', 'Beta']);
	const header = new Set([2, 3]);
	const at = (tier, line) => ({ tier, line });
	const tiered = (found, window) => collectFailures((f) => checkTieredDoc('docs/d.md', 'Beta', found, window, vocabulary, f));

	expectFailures(tiered([], null), [`has no '#' heading`], 'a tiered doc with no H1', fail);
	expectFailures(tiered([], header), [`carries no stability banner under its H1`], 'a tiered doc with no header banner', fail);
	expectFailures(tiered([at('Beta', 2), at('Beta', 3)], header), [`a second stability banner in the header window`], 'a doc declaring its tier twice', fail);
	expectFailures(tiered([at('Stable', 2)], header), [`banner says 'Stable' but docs/.stability.json records 'Beta'`], 'a banner disagreeing with the map', fail);
	expectFailures(tiered([at('Beta', 2), at('Nonsense', 9)], header), [`section banner names tier 'Nonsense'`], 'a section banner naming an undefined tier', fail);
	// A section banner disagreeing with the doc's tier is the whole point of a section banner.
	expectFailures(tiered([at('Beta', 2), at('Stable', 9)], header), [], 'a well-formed section override', fail);
}

/**
 * Check E's rules, against injected inputs. `checkPackageReadme` is the only part that touches
 * the filesystem, and it is a four-line wrapper over `checkPackageBanner`.
 */
function packageSelfTest(fail) {
	const published = publishedPackages({
		pub: 'yarn pub:engine && yarn pub:viz',
		'pub:engine': 'node scripts/publish-package.js quereus',
		'pub:viz': 'node scripts/publish-package.js tools/planviz',
	}).join(',');
	if (published !== 'packages/quereus,packages/tools/planviz') {
		fail(`scripts/check-docs.mjs: publishedPackages read '${published}' from a chain publishing quereus and tools/planviz`);
	}

	// The nesting depth is load-bearing: a `packages/tools/*` README is one level further out.
	if (stabilityLinkFrom('packages/x') !== '../../docs/stability.md') fail(`scripts/check-docs.mjs: a packages/* README no longer links '../../docs/stability.md'`);
	if (stabilityLinkFrom('packages/tools/x') !== '../../../docs/stability.md') fail(`scripts/check-docs.mjs: a packages/tools/* README no longer links '../../../docs/stability.md'`);

	const link = (pkgDir) => `[Stability Tiers](${stabilityLinkFrom(pkgDir)}#tiers)`;
	const banner = (tier) => `**Stability: ${tier}** — complete and tested, but the surface is still being shaped. See ${link('packages/x')}.`;
	const spans = `**Stability** — this package spans tiers: some areas are Stable, others Beta. See ${link('packages/x')} for the per-area assignment.`;

	if (parsePackageBanner(banner('Beta'), 'packages/x')?.tier !== 'Beta') fail(`scripts/check-docs.mjs: the canonical package stability banner no longer parses`);
	if (!parsePackageBanner(spans, 'packages/x')?.spans) fail(`scripts/check-docs.mjs: the spans-tiers package banner no longer parses`);

	const nearMisses = [
		`**Stability: Beta** - complete and tested. See ${link('packages/x')}.`, // hyphen, not an em dash
		`**Stability: Beta** —complete and tested. See ${link('packages/x')}.`, // no space after the em dash
		`**Stability: Beta** — complete and tested. See Stability Tiers.`, // no link
		`**Stability: Beta** — complete and tested. See ${link('packages/x')}`, // no full stop
		`**Stability: Beta** — complete and tested. See ${link('packages/tools/x')}.`, // link relative to the wrong depth
		`**stability: Beta** — complete and tested. See ${link('packages/x')}.`, // lowercase
		`**Stability:** Beta — complete and tested. See ${link('packages/x')}.`, // colon outside the bold
	];
	for (const text of nearMisses) {
		if (parsePackageBanner(text, 'packages/x')) fail(`scripts/check-docs.mjs: the package banner parser tolerates a near-miss: ${text}`);
	}

	// A package banner wraps; the block must rejoin before it can be parsed at all.
	const wrapped = ['# Package', '', '> **Stability: Beta** — complete and tested, but the', '> surface is still being shaped. See', `> ${link('packages/x')}.`, '', 'Intro.'];
	const blocks = packageBannerBlocks(wrapped);
	if (blocks.length !== 1 || blocks[0].line !== 3 || parsePackageBanner(blocks[0].text, 'packages/x')?.tier !== 'Beta') {
		fail(`scripts/check-docs.mjs: a wrapped package banner no longer joins into one block: ${JSON.stringify(blocks)}`);
	}

	expectFailures(
		collectFailures((f) => classifyPackages(
			{ packages: { 'packages/a': 'Stable', 'packages/both': 'Beta' }, packagesSpanning: ['packages/both'] },
			['packages/a', 'packages/new'],
			f,
		)),
		[`'packages/both' is classified twice`, `'packages/new' publishes to npm but is not classified`],
		'classifyPackages',
		fail,
	);

	const window = new Set([3]);
	const at = (line, text) => ({ line, text });
	const checked = (found, win, expected) => collectFailures((f) => checkPackageBanner('packages/x/README.md', 'packages/x', expected, found, win, f));

	expectFailures(checked([], window, 'Beta'), [`no stability banner`], 'a classified package with no banner', fail);
	expectFailures(checked([at(3, banner('Beta')), at(9, banner('Beta'))], window, 'Beta'), [`a second stability banner`], 'a package declaring its tier twice', fail);
	expectFailures(checked([at(3, banner('Beta'))], null, 'Beta'), [`has no '#' heading`], 'a README with no H1', fail);
	expectFailures(checked([at(9, banner('Beta'))], window, 'Beta'), [`sits below the header window`], 'a banner below the header window', fail);
	expectFailures(checked([at(3, '**Stability** is important around here.')], window, 'Beta'), [`malformed stability banner`], 'a banner-ish line that is not a banner', fail);
	expectFailures(checked([at(3, banner('Stable'))], window, 'Beta'), [`banner says 'Stable' but docs/.stability.json records 'Beta'`], 'a banner disagreeing with the map', fail);
	expectFailures(checked([at(3, spans)], window, 'Beta'), [`declares no single tier`], 'a spans banner on a single-tier package', fail);
	expectFailures(checked([at(3, banner('Beta'))], window, SPANS), [`banner names tier 'Beta'`], 'a single-tier banner on a spanning package', fail);
	expectFailures(checked([at(3, banner('Beta'))], window, 'Beta'), [], 'a well-formed package banner', fail);
	expectFailures(checked([at(3, spans)], window, SPANS), [], 'a well-formed spans-tiers banner', fail);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main() {
	const args = process.argv.slice(2);
	if (args.includes('--update-ratchet')) {
		process.exit(updateRatchet(args.includes('--force')));
	}

	// One breakage can reach `fail` twice: a `[x](docs/foo.md)` link in a README matches both the
	// markdown-link and the bare-`docs/*.md` extractor, and a `doc:` line in the invariant register
	// is a markdown link that Check A already resolved. The message carries its own `path:line`, so
	// identical strings are the same defect. Report each once, in discovery order.
	const failures = [];
	const seen = new Set();
	const fail = (message) => {
		if (seen.has(message)) return;
		seen.add(message);
		failures.push(message);
	};

	selfTest(fail);
	checkLinks(fail);
	checkInvariants(fail);
	const { stability, vocabulary } = checkStability(fail);
	checkPackages(stability, vocabulary, fail);
	checkRatchet(fail);

	if (failures.length) {
		for (const failure of failures) console.error(failure);
		console.error(`\n${failures.length} documentation failure(s). See docs/doc-conventions.md.`);
		process.exit(1);
	}
	console.log('Docs OK: links resolve, invariants well-formed, sizes within ratchet, doc and package tiers declared.');
}

main();

/**
 * Minimal static file server for the benchmark page.
 *
 * IndexedDB is unreliable (Chromium: unavailable outright) on `file://` origins, so the page
 * has to be served over `http://localhost`. This exists only so running the benchmark needs no
 * dependency beyond Node — it serves this directory and nothing else.
 *
 *   node bench/serve.mjs [--port 8099]
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));

const TYPES = {
	'.html': 'text/html; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.md': 'text/plain; charset=utf-8',
};

function parsePort(argv) {
	const flag = argv.indexOf('--port');
	if (flag === -1) return 8099;
	const port = Number(argv[flag + 1]);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error(`--port needs an integer 1..65535, got ${argv[flag + 1]}`);
	}
	return port;
}

/**
 * Map a request path to a file inside ROOT, or null when it escapes.
 * `..` segments are resolved BEFORE the containment check — checking the raw path would let
 * `/../../etc/passwd` through.
 */
function resolveWithinRoot(urlPath) {
	const decoded = decodeURIComponent(urlPath.split('?')[0]);
	const relative = normalize(decoded === '/' ? '/index.html' : decoded).replace(/^([/\\])+/, '');
	const full = resolve(ROOT, relative);
	return full === ROOT || full.startsWith(ROOT + sep) ? full : null;
}

const port = parsePort(process.argv.slice(2));

const server = createServer(async (request, response) => {
	const target = resolveWithinRoot(request.url ?? '/');
	if (!target) {
		response.writeHead(403, { 'content-type': 'text/plain' }).end('forbidden\n');
		return;
	}
	try {
		const info = await stat(target);
		const file = info.isDirectory() ? join(target, 'index.html') : target;
		const body = await readFile(file);
		response.writeHead(200, {
			'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
			// The page is re-edited between runs; a cached module would silently benchmark
			// yesterday's code.
			'cache-control': 'no-store',
		});
		response.end(body);
	} catch (error) {
		const status = error.code === 'ENOENT' ? 404 : 500;
		response.writeHead(status, { 'content-type': 'text/plain' });
		response.end(`${status}: ${error.message}\n`);
	}
});

server.on('error', (error) => {
	console.error(`bench server failed: ${error.message}`);
	process.exitCode = 1;
});

server.listen(port, '127.0.0.1', () => {
	console.log(`bench server: http://localhost:${port}/  (serving ${ROOT})`);
	console.log('open it in Chromium or Firefox and press "Run benchmark"; Ctrl-C to stop');
});

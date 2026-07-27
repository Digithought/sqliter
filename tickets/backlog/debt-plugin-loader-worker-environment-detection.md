----
description: The plugin loader decides whether it is running in a browser by checking for a browser-page-only object, so code running in a background browser thread is mistaken for a server, and one of the two plugin-loading paths would give a confusing error there.
files:
  - packages/plugin-loader/src/plugin-loader.ts (`resolveEnvironment`, `isBrowserEnv`, `loadPlugin`, `loadFromNodePackage`)
  - packages/plugin-loader/test/loader.spec.ts
  - packages/quoomb-web/src/worker/quereus.worker.ts
difficulty: easy
----

## Background

`plugin-loader` has two entry points:

- `dynamicLoadModule(url, …)` — loads a plugin from an `https:`/`file:` URL.
- `loadPlugin(spec, …)` — accepts either a URL (delegating to the above) or an
  npm package name, which resolves differently per environment: Node imports the
  installed package, while a browser needs it mapped to a CDN URL and requires
  the caller to opt in with `allowCdn: true`.

`loadPlugin` picks the environment with `resolveEnvironment()`, which asks
`isBrowserEnv()`, which is "does `globalThis.document` exist".

## The problem

A Web Worker has no `document`. quoomb-web loads all plugins from a worker
(`packages/quoomb-web/src/worker/quereus.worker.ts`). So inside that worker,
`resolveEnvironment()` answers `'node'`.

The same mistake was found and fixed for `dynamicLoadModule` while adding Node
support for `https:` plugin loads — that path now decides with
`isNodeRuntime()` (does `globalThis.process.versions.node` exist), which a worker
correctly fails. `resolveEnvironment` was deliberately left alone at the time,
since nothing routed through it from a worker.

The consequence is dormant, not active: nothing in quoomb-web calls
`loadPlugin` — the worker only calls `dynamicLoadModule`. But the first browser
host that does, with an npm-style spec, gets `loadFromNodePackage` and a bare
`import('some-package')` that a browser cannot resolve. The user sees "Failed to
resolve plugin package '…'. Ensure it exports './plugin' or a default module."
instead of the accurate "Loading npm packages in the browser requires
allowCdn=true".

## Expected behavior

Environment detection should agree across both entry points, and a Web Worker
should be treated as a browser. `isNodeRuntime()` already encodes the right test
and has a spec pinning it; `resolveEnvironment` should be expressed in those terms
rather than by the absence of a DOM. Add a spec covering `loadPlugin` with an npm
spec in a DOM-less, non-Node runtime — it should ask for `allowCdn`, not attempt a
package import.

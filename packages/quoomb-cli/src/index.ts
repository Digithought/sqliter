import { installRemotePluginResolver } from './plugins/remote-resolver.js';

// Both entry points must install it: `bin/quoomb.ts` does not go through this
// module, and an embedder that imports REPL/DotCommands does not go through bin.
// The call is idempotent.
installRemotePluginResolver();

export { REPL } from './repl.js';
export { DotCommands } from './commands/dot-commands.js';

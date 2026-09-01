import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

process.env.TS_NODE_PROJECT = './packages/quereus-babel-fish/tsconfig.test.json';
process.env.TS_NODE_ESM = 'true';
process.env.TS_NODE_TRANSPILE_ONLY = 'true';

register('ts-node/esm', pathToFileURL('./'));

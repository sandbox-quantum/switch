#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.argv.length !== 3) {
  throw new Error('Usage: node deploy/hosted/build-runtime.mjs <output-directory>');
}
const repository = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(new URL('../../console/package.json', import.meta.url));
const { build } = require('esbuild');
const output = resolve(process.argv[2]);
await mkdir(output, { recursive: true });
const names = ['hosted-bootstrap', 'shared-host-daemon'];
await build({
  absWorkingDir: repository,
  entryPoints: {
    'hosted-bootstrap': 'console/packages/agent-providers/src/host/hosted-bootstrap-cli.ts',
    'shared-host-daemon': 'console/packages/agent-providers/src/host/shared-daemon.ts',
  },
  outdir: output,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  tsconfig: 'console/packages/agent-providers/tsconfig.json',
  banner: {
    js: "import { createRequire as createHostedRequire } from 'node:module'; const require = createHostedRequire(import.meta.url);",
  },
  plugins: [
    {
      name: 'headless-runtime-only',
      setup(context) {
        context.onResolve(
          { filter: /^(electron|better-sqlite3|drizzle-orm|@main\/db)(\/|$)/ },
          (args) => ({
            errors: [{ text: `Hosted runtime cannot import desktop dependency: ${args.path}` }],
          })
        );
      },
    },
  ],
  logLevel: 'info',
});
const files = {};
for (const name of names) {
  const file = `${name}.mjs`;
  files[file] = createHash('sha256')
    .update(await readFile(resolve(output, file)))
    .digest('hex');
}
await writeFile(
  resolve(output, 'manifest.json'),
  JSON.stringify({ version: 1, nodeMajor: 24, files }, null, 2) + '\n'
);

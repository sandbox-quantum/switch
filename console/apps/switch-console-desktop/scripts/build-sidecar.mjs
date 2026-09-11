import { rm } from 'node:fs/promises';
import { build } from 'esbuild';

/**
 * Bundles the Switch Console remote runtime sidecar (CHOO-1059) into a single
 * Node ESM file deployed to the agent's VM. The VM already has Node (the agent
 * CLI is a Node program), so no native/per-arch binary is needed.
 *
 * A resolve guard fails the build if any Electron/desktop-only dependency leaks
 * into the bundle — the sidecar must stay pure Node so it runs headless on the
 * VM. This is the standing proof that the poller/hook-server refactor keeps the
 * core free of Electron, the database, and the renderer.
 */
const FORBIDDEN = [
  { label: 'electron', test: (p) => p === 'electron' },
  { label: 'better-sqlite3', test: (p) => p === 'better-sqlite3' },
  { label: 'drizzle-orm', test: (p) => p === 'drizzle-orm' || p.startsWith('drizzle-orm/') },
  { label: '@main/db', test: (p) => p === '@main/db' || p.startsWith('@main/db/') },
];

const guardForbiddenImports = {
  name: 'guard-forbidden-imports',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /.*/ }, (args) => {
      const hit = FORBIDDEN.find((f) => f.test(args.path));
      if (!hit) return null;
      return {
        errors: [
          {
            text: `sidecar bundle must not depend on '${hit.label}' (imported '${args.path}' from ${args.importer}) — keep the sidecar Electron/db-free`,
          },
        ],
      };
    });
  },
};

await rm('dist-sidecar/sidecar.mjs', { force: true });

await build({
  entryPoints: ['../../packages/agent-providers/src/host/shared-daemon.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'dist-sidecar/shared-host.mjs',
  tsconfig: 'tsconfig.json',
  banner: {
    js: "import { createRequire as createSharedHostRequire } from 'node:module'; const require = createSharedHostRequire(import.meta.url);",
  },
  logLevel: 'info',
  plugins: [guardForbiddenImports],
});

import { readFile } from 'node:fs/promises';
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

const OUTFILE = 'dist-sidecar/sidecar.mjs';

await build({
  entryPoints: ['src/sidecar/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: OUTFILE,
  tsconfig: 'tsconfig.json',
  logLevel: 'info',
  plugins: [guardForbiddenImports],
});

/**
 * The sidecar runs under raw Node, where `import.meta.env` is undefined — unlike
 * the Vite-built renderer/main (and unlike Vitest, which defines it, so a unit
 * test cannot catch this). An UNGUARDED `import.meta.env.X` read therefore
 * crashes the sidecar on boot; the guarded `import.meta.env?.X` is fine. Shared
 * code the sidecar bundles must use the optional-chained form (see
 * `src/shared/logger.ts`). Fail the build loudly if an unguarded read slips in,
 * rather than shipping a bundle that dies on the VM (CHOO-1425).
 */
const bundle = await readFile(OUTFILE, 'utf8');
const unguarded = bundle.match(/import\.meta\.env\.[A-Za-z_]/g);
if (unguarded) {
  throw new Error(
    `sidecar bundle contains unguarded import.meta.env access (${[...new Set(unguarded)].join(', ')}) — ` +
      'use import.meta.env?.X in shared code; it is undefined under raw Node and crashes the sidecar on boot'
  );
}

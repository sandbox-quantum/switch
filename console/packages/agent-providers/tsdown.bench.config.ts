import { defineConfig } from 'tsdown';

/**
 * Bundles the benchmark's shared-host entrypoint, and nothing else.
 *
 * Kept out of `tsdown.config.ts` so the benchmark daemon is never an entry of
 * the published package: `pnpm build` cannot emit it, and only the benchmark
 * that invokes this config does. It needs bundling because a host is spawned
 * as a child process, and the entrypoint imports the package's own modules by
 * extensionless specifier — which Node's TypeScript support does not resolve.
 *
 *     pnpm --filter @switch-console/agent-providers exec tsdown \
 *       --config tsdown.bench.config.ts
 */
export default defineConfig({
  entry: { 'bench-host-daemon': 'src/host/bench/daemon.ts' },
  outDir: 'dist-bench',
  format: ['esm'],
  dts: false,
  deps: { alwaysBundle: [/^jsonc-parser(?:\/|$)/] },
  sourcemap: true,
  clean: true,
});

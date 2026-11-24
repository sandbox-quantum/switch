import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    testing: 'src/testing/index.ts',
    box: 'src/host/box/index.ts',
    'subscription-usage': 'src/subscription-usage.ts',
    'host-daemon': 'src/host/daemon.ts',
    'shared-host-daemon': 'src/host/shared-daemon.ts',
  },
  format: ['esm'],
  dts: true,
  deps: { alwaysBundle: [/^jsonc-parser(?:\/|$)/] },
  sourcemap: true,
  clean: true,
});

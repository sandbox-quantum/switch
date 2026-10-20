import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'session-v1': 'src/session-v1/index.ts',
    'windows-spawn': 'src/windows-spawn.ts',
  },
  format: ['esm'],
  dts: true,
  deps: {},
  sourcemap: true,
  clean: true,
});

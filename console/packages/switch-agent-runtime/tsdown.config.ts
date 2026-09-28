import { defineConfig } from 'tsdown';

export default defineConfig({
  // `index` is the protocol client; `hosted` is the tool surface a session
  // host serves and the watcher runs. Splitting them keeps the MCP SDK out of
  // anything that only wants to talk to Switch.
  entry: { index: 'src/index.ts', hosted: 'src/hosted.ts' },
  format: ['esm'],
  dts: true,
  deps: {},
  sourcemap: true,
  clean: true,
});

import { defineConfig } from 'tsdown';

export default defineConfig({
  // Separate entry points. `index` is the protocol client Switch Console
  // imports; `hosted` is the tool surface a session host serves and the
  // watcher runs; `bin` is the standalone MCP server. Splitting them keeps the
  // MCP SDK out of anything that only wants to talk to Switch.
  entry: { index: 'src/index.ts', hosted: 'src/hosted.ts', bin: 'src/bin.ts' },
  format: ['esm'],
  dts: true,
  deps: {},
  sourcemap: true,
  clean: true,
});

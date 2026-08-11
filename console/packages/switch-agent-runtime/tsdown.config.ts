import { defineConfig } from 'tsdown';

export default defineConfig({
  // Two entry points, deliberately separate. `index` is the protocol client
  // Switch Console imports; `bin` is the MCP server npx runs. Splitting them keeps
  // the MCP SDK out of anything that only wants to talk to Switch.
  entry: { index: 'src/index.ts', bin: 'src/bin.ts' },
  format: ['esm'],
  dts: true,
  deps: {},
  sourcemap: true,
  clean: true,
});

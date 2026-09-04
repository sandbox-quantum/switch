import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    agents: 'src/agents/registry.ts',
    // The runtime pin, for the parts of the app that register the Switch MCP
    // server themselves rather than through a connector file.
    distribution: 'src/distribution.ts',
    // The room-workflow skill, for a session whose config directory the app
    // writes and which therefore cannot see the installed connector's copy.
    'opencode-skill': 'src/agents/impl/opencode/skill-file.ts',
  },
  format: ['esm'],
  dts: true,
  deps: {
    neverBundle: ['zod', 'smol-toml', '@switch-console/core'],
  },
  sourcemap: true,
  clean: true,
});

import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    agents: 'src/agents/registry.ts',
    'provider-setup': 'src/agents/provider-setup.ts',
    'switch-skill': 'src/switch-skill/index.ts',
  },
  // The skill is edited as Markdown and shipped inside the bundle as a string.
  loader: { '.md': 'text' },
  format: ['esm'],
  dts: true,
  deps: {
    neverBundle: ['zod', 'smol-toml', '@switch-console/core', '@switch-console/agent-providers'],
  },
  sourcemap: true,
  clean: true,
});

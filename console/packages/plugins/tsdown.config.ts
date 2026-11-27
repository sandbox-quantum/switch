import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    agents: 'src/agents/registry.ts',
    'switch-skill': 'src/switch-skill/index.ts',
    'provider-login': 'src/provider-login/output.ts',
    'browser-sign-in': 'src/provider-login/browser-sign-in.ts',
  },
  // The skill is edited as Markdown and shipped inside the bundle as a string.
  loader: { '.md': 'text' },
  format: ['esm'],
  dts: true,
  deps: {
    neverBundle: ['zod', 'smol-toml', '@switch-console/core'],
  },
  sourcemap: true,
  clean: true,
});

import type { AgentIconAsset } from '@switch-console/core/agents/plugins';

export const icon: AgentIconAsset = {
  kind: 'svg',
  alt: 'Kiro CLI',
  variants: [
    {
      minSize: 0,
      light:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1em" height="1em"><path fill="#7c3aed" d="M3 3h5v8l7-8h6l-8 9 8 9h-6l-7-8v8H3z"/></svg>',
    },
  ],
};

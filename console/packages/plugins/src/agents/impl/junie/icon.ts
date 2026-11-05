import type { AgentIconAsset } from '@switch-console/core/agents/plugins';

export const icon: AgentIconAsset = {
  kind: 'svg',
  alt: 'Junie',
  variants: [
    {
      minSize: 0,
      light:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M7 3h11v12a6 6 0 0 1-12 0h3a3 3 0 0 0 6 0V6H7z"/></svg>',
    },
  ],
};

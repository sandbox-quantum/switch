import type { AgentIconAsset } from '@switch-console/core/agents/plugins';

export const icon: AgentIconAsset = {
  kind: 'svg',
  alt: 'Grok Build',
  invertInDark: true,
  variants: [
    {
      minSize: 0,
      light: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><title>Grok Build</title><path d="M20.293 3.293a1 1 0 0 1 1.414 1.414l-7.5 7.5 7.5 7.5a1 1 0 0 1-1.414 1.414l-7.5-7.5-7.5 7.5a1 1 0 0 1-1.414-1.414l7.5-7.5-7.5-7.5a1 1 0 0 1 1.414-1.414l7.5 7.5 7.5-7.5z" fill="#000000"/></svg>`,
    },
  ],
};

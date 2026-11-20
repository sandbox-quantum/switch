import type { AgentIconAsset } from '@switch-console/core/agents/plugins';

export const icon: AgentIconAsset = {
  kind: 'svg',
  alt: 'Grok Build CLI',
  invertInDark: true,
  variants: [
    {
      minSize: 0,
      light:
        '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><title>Grok Build</title><path d="M20.3 3.3a1 1 0 0 1 1.4 1.4l-7.5 7.5 7.5 7.5a1 1 0 0 1-1.4 1.4l-7.5-7.5-7.5 7.5a1 1 0 0 1-1.4-1.4l7.5-7.5-7.5-7.5a1 1 0 0 1 1.4-1.4l7.5 7.5 7.5-7.5Z" fill="#000"/></svg>',
    },
  ],
};

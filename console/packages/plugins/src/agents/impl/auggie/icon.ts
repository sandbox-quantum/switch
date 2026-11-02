import type { AgentIconAsset } from '@switch-console/core/agents/plugins';

export const icon: AgentIconAsset = {
  kind: 'svg',
  alt: 'Auggie',
  variants: [
    {
      minSize: 0,
      light:
        '<svg height="1em" style="flex:none;line-height:1" viewBox="0 0 24 24" width="1em" xmlns="http://www.w3.org/2000/svg"><title>Auggie</title><path fill="#7C3AED" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-1-13h2v6h-2zm0 8h2v2h-2z"/></svg>',
    },
  ],
};

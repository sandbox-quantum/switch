import type { AgentIconAsset } from '@switch-console/core/agents/plugins';

export const icon: AgentIconAsset = {
  kind: 'svg',
  alt: 'Kiro CLI',
  variants: [
    {
      minSize: 0,
      light: `<svg height="1em" style="flex:none;line-height:1" viewBox="0 0 24 24" width="1em" xmlns="http://www.w3.org/2000/svg"><title>Kiro</title><path d="M12 1.8l2.6 7.6 7.6 2.6-7.6 2.6L12 22.2l-2.6-7.6L1.8 12l7.6-2.6L12 1.8z" fill="#8A5CF6"/></svg>`,
    },
  ],
};

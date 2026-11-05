import type { AgentIconAsset } from '@switch-console/core/agents/plugins';

export const icon: AgentIconAsset = {
  kind: 'svg',
  alt: 'Grok Build',
  variants: [
    {
      minSize: 0,
      light: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#111" d="M12 2a10 10 0 1 0 9.4 13.4h-4.1a6.2 6.2 0 1 1-1.6-7l2.8-2.8A9.9 9.9 0 0 0 12 2Zm1.2 8.2v3.4h4.2a5.9 5.9 0 0 1-.2 1.2h4.1c.3-1.1.5-2.2.5-3.4v-1.2h-8.6Z"/></svg>`,
    },
  ],
};

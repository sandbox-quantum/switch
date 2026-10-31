import type { AgentIconAsset } from '@switch-console/core/agents/plugins';

export const icon: AgentIconAsset = {
  kind: 'svg',
  alt: 'Amp CLI',
  variants: [
    {
      minSize: 0,
      light: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 14.5v-3h2.5l-4.5-7v4h-2.5l4.5 6z" fill="#FF5E1E"/>
</svg>`,
    },
  ],
};

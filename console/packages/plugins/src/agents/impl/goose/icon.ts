import type { AgentIconAsset } from '@switch-console/core/agents/plugins';

export const icon: AgentIconAsset = {
  kind: 'svg',
  alt: 'Goose CLI',
  invertInDark: true,
  variants: [
    {
      minSize: 0,
      light: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M12 2C9.5 2 7.5 4 7.5 6.5c0 1.5.8 2.8 2 3.6V13c-2.5 0-5 2-5 5v2h15v-2c0-3-2.5-5-5-5v-2.9c1.2-.8 2-2.1 2-3.6C16.5 4 14.5 2 12 2zm0 2c1.4 0 2.5 1.1 2.5 2.5S13.4 9 12 9s-2.5-1.1-2.5-2.5S10.6 4 12 4z" fill="currentColor"/>
</svg>`,
    },
  ],
};

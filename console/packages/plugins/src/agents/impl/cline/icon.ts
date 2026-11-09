import type { AgentIconAsset } from '@switch-console/core/agents/plugins';

export const icon: AgentIconAsset = {
  kind: 'svg',
  alt: 'Cline CLI',
  invertInDark: true,
  variants: [
    {
      minSize: 0,
      light: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M12 2L3 7v10l9 5 9-5V7l-9-5zm0 2.24L18.76 8 12 11.76 5.24 8 12 4.24zM4.75 9.35L11 12.83v7.42L4.75 16.5V9.35zm14.5 7.15L13 20.25v-7.42l6.25-3.48v7.15z" fill="currentColor"/>
</svg>`,
    },
  ],
};

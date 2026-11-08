import type { AgentIconAsset } from '@switch-console/core/agents/plugins';

export const icon: AgentIconAsset = {
  kind: 'svg',
  alt: 'OpenHands',
  invertInDark: false,
  variants: [
    {
      minSize: 0,
      light: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none"><path d="M32 4 58 19v26L32 60 6 45V19L32 4Z" fill="#6D28D9"/><path d="M20 23v18m24-18v18M20 32h24" stroke="white" stroke-width="6" stroke-linecap="round"/></svg>`,
    },
  ],
};

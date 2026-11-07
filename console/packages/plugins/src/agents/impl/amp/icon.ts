import type { AgentIconAsset } from '@switch-console/core/agents/plugins';

export const icon: AgentIconAsset = {
  kind: 'svg',
  alt: 'Amp CLI',
  invertInDark: true,
  variants: [
    {
      minSize: 0,
      light: `<svg width="100" height="100" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect width="100" height="100" rx="20" fill="#0F172A"/>
  <path d="M50 20L24 76H38L50 50L62 76H76L50 20Z" fill="#38BDF8"/>
  <circle cx="50" cy="62" r="5" fill="#F8FAFC"/>
</svg>`,
    },
  ],
};

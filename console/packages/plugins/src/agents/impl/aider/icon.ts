import type { AgentIconAsset } from '@switch-console/core/agents/plugins';

export const icon: AgentIconAsset = {
  kind: 'svg',
  alt: 'Aider CLI',
  invertInDark: true,
  variants: [
    {
      minSize: 0,
      light: `<svg width="100" height="100" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect width="100" height="100" rx="20" fill="#1E293B"/>
  <path d="M50 25L25 75H38L50 51L62 75H75L50 25Z" fill="#10B981"/>
  <rect x="42" y="58" width="16" height="5" fill="#F8FAFC"/>
</svg>`,
    },
  ],
};

import type { AgentIconAsset } from '@switch-console/core/agents/plugins';

export const icon: AgentIconAsset = {
  kind: 'svg',
  alt: 'Cline CLI',
  variants: [
    {
      minSize: 0,
      light: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect x="2" y="2" width="20" height="20" rx="4" fill="#2563EB"/>
  <path d="M15.5 8.5C14.7 7.5 13.5 7 12 7C9.2 7 7 9.2 7 12C7 14.8 9.2 17 12 17C13.5 17 14.7 16.5 15.5 15.5" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round"/>
</svg>`,
    },
  ],
};

import type { AgentIconAsset } from '@switch-console/core/agents/plugins';

export const icon: AgentIconAsset = {
  kind: 'svg',
  alt: 'Kiro CLI',
  invertInDark: true,
  variants: [
    {
      minSize: 0,
      light: `<svg width="192" height="192" viewBox="0 0 192 192" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect width="192" height="192" rx="40" fill="#24292E"/>
  <path d="M52 48V144M52 96L132 48M86 96L140 144" stroke="#FFFFFF" stroke-width="20" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`,
    },
  ],
};


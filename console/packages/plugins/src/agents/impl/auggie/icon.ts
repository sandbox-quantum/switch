import type { AgentIconAsset } from '@switch-console/core/agents/plugins';

export const icon: AgentIconAsset = {
  kind: 'svg',
  alt: 'Auggie CLI',
  invertInDark: false,
  variants: [
    {
      minSize: 0,
      light: `<svg width="64" height="64" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
<rect width="64" height="64" rx="14" fill="#635BFF"/>
<path d="M32 12L51 51H41L32 31L23 51H13L32 12Z" fill="#FFFFFF"/>
<path d="M25 40H39L43 48H21L25 40Z" fill="#C7D2FE"/>
</svg>`,
    },
  ],
};
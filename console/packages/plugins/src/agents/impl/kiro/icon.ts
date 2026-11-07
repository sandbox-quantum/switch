import type { AgentIconAsset } from '@switch-console/core/agents/plugins';

export const icon: AgentIconAsset = {
  kind: 'svg',
  alt: 'Kiro CLI',
  invertInDark: false,
  variants: [
    {
      minSize: 0,
      light: `<svg width="64" height="64" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
<rect width="64" height="64" rx="14" fill="#7C3AED"/>
<path d="M17 14H25V29L39 14H49L33 31L49 50H39L27 36L25 38V50H17V14Z" fill="#FFFFFF"/>
</svg>`,
    },
  ],
};

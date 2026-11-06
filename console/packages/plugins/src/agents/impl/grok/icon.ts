import type { AgentIconAsset } from '@switch-console/core/agents/plugins';

export const icon: AgentIconAsset = {
  kind: 'svg',
  alt: 'Grok Build CLI',
  invertInDark: true,
  variants: [
    {
      minSize: 0,
      light: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
<path d="M2.5 3H7.5L21.5 21H16.5L2.5 3ZM8.5 3H12.5L21.5 14.5V21H18.5L8.5 3ZM2.5 9.5V3H5.5L15.5 21H11.5L2.5 9.5Z" fill="#111111"/>
</svg>
`,
    },
  ],
};

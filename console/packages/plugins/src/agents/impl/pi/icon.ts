import type { AgentIconAsset } from '@switch-console/core/agents/plugins';

export const icon: AgentIconAsset = {
  kind: 'svg',
  alt: 'Pi',
  invertInDark: true,
  variants: [
    {
      minSize: 0,
      light: `<svg viewBox="0 0 560 560" fill="none" xmlns="http://www.w3.org/2000/svg">
<path d="M420 280H280V140H0V0H420V280Z" fill="#111111"/>
<path d="M560 560H420V280H560V560Z" fill="#111111"/>
<path d="M140 560H0V140H140V280H280V420H140V560Z" fill="#111111"/>
</svg>`,
    },
  ],
};

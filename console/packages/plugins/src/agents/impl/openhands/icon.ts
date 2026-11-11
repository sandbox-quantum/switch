import type { AgentIconAsset } from '@switch-console/core/agents/plugins';

export const icon: AgentIconAsset = {
  kind: 'svg',
  alt: 'OpenHands',
  variants: [
    {
      minSize: 0,
      light: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="none">
<rect width="32" height="32" rx="8" fill="#F9C80E"/>
<path d="M8 14V9m4 5V7m4 8V9m4 8v-5m-12 1v8c0 4 3 6 7 6h2c4 0 7-3 7-7v-5c0-2-3-2-3 0v3" stroke="#171717" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`,
    },
  ],
};

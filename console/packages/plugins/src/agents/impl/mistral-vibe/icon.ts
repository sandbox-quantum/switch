import type { AgentIconAsset } from '@switch-console/core/agents/plugins';

export const icon: AgentIconAsset = {
  kind: 'svg',
  alt: 'Mistral Vibe CLI',
  variants: [
    {
      minSize: 0,
      light: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
<path d="M3 3H7V7H3V3ZM17 3H21V7H17V3ZM10 6.5H14V10.5H10V6.5ZM3 10.5H7V14.5H3V10.5ZM17 10.5H21V14.5H17V10.5ZM10 14H14V18H10V14ZM3 17.5H21V21.5H3V17.5Z" fill="#FA520F"/>
</svg>
`,
    },
  ],
};

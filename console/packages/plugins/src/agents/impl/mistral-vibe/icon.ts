import type { AgentIconAsset } from '@switch-console/core/agents/plugins';

export const icon: AgentIconAsset = {
  kind: 'svg',
  alt: 'Mistral Vibe CLI',
  variants: [
    {
      minSize: 0,
      light: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
<path d="M3 19.5V4.5h3.2l5.3 9.2 5.3-9.2H20v15h-2.8V9.8L13.4 18.2h-2.8L5.8 9.8v9.7H3z" fill="#FA520F"/>
</svg>
`,
    },
  ],
};

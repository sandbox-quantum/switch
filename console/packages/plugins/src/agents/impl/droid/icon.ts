import type { AgentIconAsset } from '@switch-console/core/agents/plugins';

export const icon: AgentIconAsset = {
  kind: 'svg',
  alt: 'Factory Droid',
  invertInDark: true,
  variants: [
    {
      minSize: 0,
      light: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
<path d="M12 2L2 7V17L12 22L22 17V7L12 2Z" stroke="#26241E" stroke-width="2" stroke-linejoin="round"/>
<path d="M12 6V18M7 9L17 15M17 9L7 15" stroke="#26241E" stroke-width="2" stroke-linecap="round"/>
</svg>`,
    },
  ],
};


import type { AgentIconAsset } from '@switch-console/core/agents/plugins';

export const icon: AgentIconAsset = {
  kind: 'svg',
  alt: 'Pi CLI',
  invertInDark: true,
  variants: [
    {
      minSize: 0,
      light: `<svg width="100" height="100" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect width="100" height="100" rx="20" fill="#18181B"/>
  <path d="M28 32H72V42H60V68H48V42H40V68H28V32Z" fill="#E4E4E7"/>
</svg>`,
    },
  ],
};

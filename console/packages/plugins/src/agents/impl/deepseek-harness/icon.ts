import type { AgentIconAsset } from '@switch-console/core/agents/plugins';

/** A plain mark in DeepSeek's brand blue; the whale logo is not redistributed here. */
export const icon: AgentIconAsset = {
  kind: 'svg',
  alt: 'DeepSeek Harness',
  variants: [
    {
      minSize: 0,
      light: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
<rect width="24" height="24" rx="6" fill="#4D6BFE"/>
<path d="M6 8.5h5.5a3.5 3.5 0 0 1 0 7H6v-7Zm2 2v3h3.5a1.5 1.5 0 0 0 0-3H8Z" fill="#fff"/>
<path d="M15 8.5h3v2h-3zM15 13.5h3v2h-3z" fill="#fff"/>
</svg>`,
    },
  ],
};

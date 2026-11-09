import type { AgentIconAsset } from '@switch-console/core/agents/plugins';

export const icon: AgentIconAsset = {
  kind: 'svg',
  alt: 'Junie',
  invertInDark: true,
  variants: [
    {
      minSize: 0,
      light: `<svg height="1em" style="flex:none;line-height:1" viewBox="0 0 24 24" width="1em" xmlns="http://www.w3.org/2000/svg"><title>Junie</title><rect fill="#000" height="20" rx="3" width="20" x="2" y="2"/><path d="M13 6h3v8a4 4 0 0 1-4 4h-1v-3h1a1 1 0 0 0 1-1z" fill="#fff"/></svg>`,
    },
  ],
};

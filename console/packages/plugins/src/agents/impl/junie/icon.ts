import type { AgentIconAsset } from '@switch-console/core/agents/plugins';

export const icon: AgentIconAsset = {
  kind: 'svg',
  alt: 'Junie',
  variants: [
    {
      minSize: 0,
      light: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1em" height="1em" style="flex:none;line-height:1"><title>Junie</title><rect width="22" height="22" x="1" y="1" rx="5" fill="#087CFA"/><path d="M14 6v8.5a3.5 3.5 0 0 1-7 0V13h2.5v1.5a1 1 0 0 0 2 0V6H14z" fill="#FFFFFF"/><rect x="7" y="17" width="5" height="2" fill="#FC801D"/></svg>`,
    },
  ],
};

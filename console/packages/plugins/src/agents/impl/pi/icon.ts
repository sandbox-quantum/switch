import type { AgentIconAsset } from '@switch-console/core/agents/plugins';

export const icon: AgentIconAsset = {
  kind: 'svg',
  alt: 'Pi',
  invertInDark: true,
  variants: [
    {
      minSize: 0,
      light: `<svg height="1em" style="flex:none;line-height:1" viewBox="0 0 24 24" width="1em" xmlns="http://www.w3.org/2000/svg"><title>Pi</title><path d="M4 6.5h16v2.5h-3.2v8.2c0 .8.4 1.2 1.1 1.2.5 0 .9-.1 1.4-.3l.5 2.3c-.8.4-1.7.6-2.7.6-2 0-3.1-1.2-3.1-3.4V9H10.2c-.2 4.3-1 8.3-2.4 11.6H5c1.5-3.3 2.4-7.3 2.6-11.6H4z" fill="#26241E"/></svg>`,
    },
  ],
};

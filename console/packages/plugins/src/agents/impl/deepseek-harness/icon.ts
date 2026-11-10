import type { AgentIconAsset } from '@switch-console/core/agents/plugins';

export const icon: AgentIconAsset = {
  kind: 'svg',
  alt: 'DeepSeek Harness',
  variants: [
    {
      minSize: 0,
      light: `<svg height="1em" style="flex:none;line-height:1" viewBox="0 0 24 24" width="1em" xmlns="http://www.w3.org/2000/svg"><title>DeepSeek Harness</title><path fill="#4D6BFE" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1.2 16.5c-2.8 0-5.1-1.8-5.9-4.3-.2-.6.2-1.2.8-1.2h.5c.4 0 .8.3.9.7.5 1.7 2.1 2.8 3.7 2.8 2.2 0 4-1.8 4-4s-1.8-4-4-4c-1.5 0-2.8.8-3.5 2.1l1.4 1.4c.3.3.1.9-.3.9H7.2c-.4 0-.7-.3-.7-.7V12c0-.4.5-.7.9-.3l1.3 1.3C9.7 11.2 11.2 10 13.2 10c3.3 0 6 2.7 6 6s-2.7 6.5-6 6.5z"/></svg>`,
    },
  ],
};

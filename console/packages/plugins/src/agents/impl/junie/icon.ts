import type { AgentIconAsset } from '@switch-console/core/agents/plugins';

export const icon: AgentIconAsset = {
  kind: 'svg',
  alt: 'Junie CLI',
  variants: [
    {
      minSize: 0,
      light: `<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 40 40" fill="none"><path d="M25 15H35V16.75C35 29 30.5001 35 16.5001 35H15V25H16.5001C22.6251 25 25 22.875 25 16.75V15Z" fill="currentColor"/><rect x="5" y="15" width="10" height="10" fill="currentColor"/><rect x="15" y="5" width="10" height="10" fill="currentColor"/></svg>`,
    },
  ],
};

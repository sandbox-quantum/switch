import type { AgentIconAsset } from '@switch-console/core/agents/plugins';

/** Pi's mark as its own terminal banner draws it, four blocks square. */
export const icon: AgentIconAsset = {
  kind: 'svg',
  alt: 'Pi',
  invertInDark: true,
  variants: [
    {
      minSize: 0,
      light: `<svg height="1em" width="1em" viewBox="0 0 4 4" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg"><title>Pi</title><path fill="#000" d="M0 0h3v1H0zM2 1h1v1H2zM0 2h2v1H0zM3 2h1v2H3zM0 3h1v1H0z"/></svg>`,
    },
  ],
};

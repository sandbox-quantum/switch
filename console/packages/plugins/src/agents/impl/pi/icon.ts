import type { AgentIconAsset } from '@switch-console/core/agents/plugins';

/**
 * Pi's mark, as its project publishes it (`apps/p2/public/icons/favicon.svg` in
 * https://github.com/earendil-works/pi, MIT licensed). Its three colours read
 * on light and dark alike, so it has no dark variant.
 */
export const icon: AgentIconAsset = {
  kind: 'svg',
  alt: 'Pi',
  variants: [
    {
      minSize: 0,
      light: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4" shape-rendering="crispEdges"><rect x="0" y="0" width="3" height="1" fill="rgb(228 138 122)"/><rect x="2" y="1" width="1" height="1" fill="rgb(228 138 122)"/><rect x="0" y="1" width="1" height="3" fill="rgb(79 142 179)"/><rect x="1" y="2" width="1" height="1" fill="rgb(79 142 179)"/><rect x="3" y="2" width="1" height="2" fill="rgb(234 182 93)"/></svg>
`,
    },
  ],
};

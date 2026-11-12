import type { AgentIconAsset } from '@switch-console/core/agents/plugins';

// Pi's mark in its brand colours: the 4 by 4 grid Pi draws as its logo in the
// terminal (`modes/interactive/components/pi-logo.js` in the MIT-licensed CLI).
export const icon: AgentIconAsset = {
  kind: 'svg',
  alt: 'Pi',
  variants: [
    {
      minSize: 0,
      light: `<svg width="64" height="64" viewBox="0 0 4 4" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges">
<path d="M0 0h3v1H0zM2 1h1v1H2z" fill="#E48A7A"/>
<path d="M0 1h1v3H0zM1 2h1v1H1z" fill="#4F8EB3"/>
<path d="M3 2h1v2H3z" fill="#EAB65D"/>
</svg>
`,
    },
  ],
};

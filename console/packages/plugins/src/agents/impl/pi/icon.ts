import type { AgentIconAsset } from '@switch-console/core/agents/plugins';

// Pi's own mark, a 4 by 4 pixel grid in its fixed brand colours (the logo in
// Pi's interactive mode, `pi-logo.ts`).
export const icon: AgentIconAsset = {
  kind: 'svg',
  alt: 'Pi',
  variants: [
    {
      minSize: 0,
      light: `<svg width="64" height="64" viewBox="0 0 4 4" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges">
<rect x="0" y="0" width="3" height="1" fill="#E48A7A"/>
<rect x="2" y="1" width="1" height="1" fill="#E48A7A"/>
<rect x="0" y="1" width="1" height="3" fill="#4F8EB3"/>
<rect x="1" y="2" width="1" height="1" fill="#4F8EB3"/>
<rect x="3" y="2" width="1" height="2" fill="#EAB65D"/>
</svg>
`,
    },
  ],
};

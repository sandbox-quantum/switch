import type { AgentIconAsset } from '@switch-console/core/agents/plugins';

// Placeholder mark, not Cline's logo — swap for the official artwork.
export const icon: AgentIconAsset = {
  kind: 'svg',
  alt: 'Cline',
  variants: [
    {
      minSize: 0,
      light: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
<rect x="2" y="2" width="20" height="20" rx="5" stroke="currentColor" stroke-width="2"/>
<path d="M15 8.5C14.2 7.6 13.1 7 12 7c-2.2 0-4 2.2-4 5s1.8 5 4 5c1.1 0 2.2-.6 3-1.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
</svg>
`,
    },
  ],
};

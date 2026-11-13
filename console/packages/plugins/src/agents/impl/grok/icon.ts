import type { AgentIconAsset } from '@switch-console/core/agents/plugins';

// A plain monogram: no Grok Build mark is published under a licence this
// repository can carry.
export const icon: AgentIconAsset = {
  kind: 'svg',
  alt: 'Grok Build',
  invertInDark: true,
  variants: [
    {
      minSize: 0,
      light: `<svg width="24" height="24" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <rect x="2" y="2" width="20" height="20" rx="5" fill="#1F1F1F" />
  <text x="12" y="16.5" text-anchor="middle" font-family="Arial, sans-serif" font-size="12" font-weight="700" fill="#FFFFFF">G</text>
</svg>`,
    },
  ],
};

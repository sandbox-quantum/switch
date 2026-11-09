import type { AgentIconAsset } from '@switch-console/core/agents/plugins';

// JetBrains publishes no SVG brand asset for Junie on jetbrains.com/company/brand;
// this is LobeHub's Junie mark (MIT, lobehub/lobe-icons,
// packages/static-svg/icons/junie.svg), the same source already used for the
// Antigravity icon in this package.
export const icon: AgentIconAsset = {
  kind: 'svg',
  alt: 'Junie',
  variants: [
    {
      minSize: 0,
      light: `<svg fill="currentColor" fill-rule="evenodd" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><title>Junie</title><path d="M24 9.333C24 18.666 20 24 9.333 24H8v-8h1.333C14 16 16 14 16 9.333V8h8v1.333zM8 16H0V8h8v8zM16 8H8V0h8v8z"/></svg>`,
    },
  ],
};

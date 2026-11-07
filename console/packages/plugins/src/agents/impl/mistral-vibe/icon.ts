import type { AgentIconAsset } from '@switch-console/core/agents/plugins';

// Mistral Vibe logo — Mistral "M" wordmark, monochrome, adapted from
// Simple Icons 16.x (CC0-1.0). Single-colour: draws in currentColor on
// light theme; inverted to white on dark theme via invertInDark.
export const icon: AgentIconAsset = {
  kind: 'svg',
  alt: 'Mistral Vibe',
  invertInDark: true,
  variants: [
    {
      minSize: 0,
      light: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1em" height="1em" style="flex:none;line-height:1" fill="currentColor"><title>Mistral Vibe</title><path d="M2 2h4v4H2V2zm0 8h4v4H2v-4zm0 8h4v4H2v-4zm6-16h4v4H8V2zm0 8h4v4H8v-4zm0 8h4v4H8v-4zm6-16h4v4h-4V2zm0 8h4v4h-4v-4zm0 8h4v4h-4v-4zm6-16h4v4h-4V2zm0 8h4v4h-4v-4zm0 8h4v4h-4v-4z"/></svg>`,
    },
  ],
};


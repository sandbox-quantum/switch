import type { AgentIconAsset } from '@switch-console/core/agents/plugins';

// Mistral's pixel M mark, rendered as the five rows of its coloured blocks.
export const icon: AgentIconAsset = {
  kind: 'svg',
  alt: 'Mistral Vibe',
  variants: [
    {
      minSize: 0,
      light:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 5 5"><path fill="#FFD800" d="M0 0h1v1H0zM4 0h1v1H4z"/><path fill="#FFAF00" d="M0 1h2v1H0zM3 1h2v1H3z"/><path fill="#FF8205" d="M0 2h5v1H0z"/><path fill="#FA500F" d="M0 3h1v1H0zM2 3h1v1H2zM4 3h1v1H4z"/><path fill="#E10500" d="M0 4h1v1H0zM4 4h1v1H4z"/></svg>',
    },
  ],
};

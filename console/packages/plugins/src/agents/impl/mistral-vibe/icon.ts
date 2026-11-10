import type { AgentIconAsset } from '@switch-console/core/agents/plugins';

export const icon: AgentIconAsset = {
  kind: 'svg',
  alt: 'Mistral Vibe',
  variants: [
    {
      minSize: 0,
      light:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 25 25"><path fill="#FFCF00" d="M0 0h5v5H0zm20 0h5v5h-5z"/><path fill="#FF9A00" d="M0 5h10v5H0zm15 0h10v5H15z"/><path fill="#FF6500" d="M0 10h25v5H0z"/><path fill="#FF3500" d="M0 15h10v5H0zm15 0h10v5H15z"/><path fill="#E92300" d="M0 20h5v5H0zm20 0h5v5h-5z"/></svg>',
    },
  ],
};

import type { AgentIconAsset } from '@switch-console/core/agents/plugins';

/** A simple robot mark, drawn for this provider. */
export const icon: AgentIconAsset = {
  kind: 'svg',
  alt: 'GitHub Copilot CLI',
  variants: [
    {
      minSize: 0,
      light:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="6" width="16" height="14" rx="5"/><path d="M12 3v3M1 11v5m22-5v5M8 17h8"/><rect x="7" y="10" width="3" height="3" rx="1"/><rect x="14" y="10" width="3" height="3" rx="1"/></svg>',
    },
  ],
};

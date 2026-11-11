import type { AgentIconAsset } from '@switch-console/core/agents/plugins';

export const icon: AgentIconAsset = {
  kind: 'svg',
  alt: 'DeepSeek Harness',
  variants: [
    {
      minSize: 0,
      light:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" rx="12" fill="#4d6bfe"/><path d="M12 13h10c10 0 15 5 15 11s-5 11-15 11H12V13zm7 6v10h3c5 0 8-2 8-5s-3-5-8-5h-3z" fill="white"/></svg>',
    },
  ],
};

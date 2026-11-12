import type { AgentIconAsset } from '@switch-console/core/agents/plugins';

/** Junie's mark, as junie.jetbrains.com serves it; a JetBrains trademark. */
export const icon: AgentIconAsset = {
  kind: 'svg',
  alt: 'Junie',
  variants: [
    {
      minSize: 0,
      light: `<svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg"><title>Junie</title><path d="M21 11.0001L31 11V12.6638C31 24.3042 25.9621 31 12.6638 31H11V21H12.6638C18.4811 21 21 18.4749 21 12.6576V11.0001Z" fill="#48E054"/><path d="M11 11H1V21H11V11Z" fill="#48E054"/><path d="M21 1H11V11H21V1Z" fill="#48E054"/></svg>`,
    },
  ],
};

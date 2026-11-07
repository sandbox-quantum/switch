import type { AgentIconAsset } from '@switch-console/core/agents/plugins';

/** A plain single-colour mark for Amp: its wordmark's initial, not Sourcegraph's own logo. */
export const icon: AgentIconAsset = {
  kind: 'svg',
  alt: 'Amp',
  invertInDark: true,
  variants: [
    {
      minSize: 0,
      light: `<svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg"><title>Amp</title><rect x="2" y="2" width="28" height="28" rx="6" fill="#111111"/><path d="M10.2 23 15.1 9h1.8l4.9 14h-2.3l-1.2-3.6h-5.6L11.5 23h-1.3Zm3.3-5.5h4.4L15.7 11l-2.2 6.5Z" fill="#FFFFFF"/></svg>`,
    },
  ],
};

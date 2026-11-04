import type { AgentIconAsset } from '@switch-console/core/agents/plugins';

// Qwen's official brand color is #5e35b1 (purple), logo is a stylized "Q".
// Using a clean SVG that renders well at small sizes.
export const icon: AgentIconAsset = {
  kind: 'svg',
  alt: 'Qwen Code',
  invertInDark: false,
  variants: [
    {
      minSize: 0,
      light: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1em" height="1em" style="flex:none;line-height:1"><title>Qwen Code</title><circle cx="12" cy="12" r="11" fill="#5e35b1"/><text x="12" y="16.5" font-family="Arial,sans-serif" font-size="13" font-weight="bold" fill="white" text-anchor="middle">Q</text></svg>`,
      dark: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1em" height="1em" style="flex:none;line-height:1"><title>Qwen Code</title><circle cx="12" cy="12" r="11" fill="#7e57c2"/><text x="12" y="16.5" font-family="Arial,sans-serif" font-size="13" font-weight="bold" fill="white" text-anchor="middle">Q</text></svg>`,
    },
  ],
};

import type { AgentIconAsset } from '@switch-console/core/agents/plugins';

// Kimi Code's MIT mark from MoonshotAI/kimi-code 2.4.1, apps/vscode/resources/kimi-icon.svg,
// with `currentColor` set to a dark fill.
export const icon: AgentIconAsset = {
  kind: 'svg',
  alt: 'Kimi Code',
  invertInDark: true,
  variants: [
    {
      minSize: 0,
      light: `<svg width="24" height="24" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <rect
    x="3"
    y="4.5"
    width="18"
    height="13"
    rx="2.2"
    fill="none"
    stroke="#1F1F1F"
    stroke-width="1.6"
  />
  <rect
    x="9.6"
    y="8.0"
    width="1.4"
    height="2.6"
    rx="0.45"
    fill="#1F1F1F"
  />
  <rect
    x="15.6"
    y="8.0"
    width="1.4"
    height="2.6"
    rx="0.45"
    fill="#1F1F1F"
  />
</svg>
`,
    },
  ],
};

import type { AgentIconAsset } from '@switch-console/core/agents/plugins';

/** A ghost in Kiro's purple, after the Kiro mark (https://kiro.dev). */
export const icon: AgentIconAsset = {
  kind: 'svg',
  alt: 'Kiro',
  variants: [
    {
      minSize: 0,
      light: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
<path d="M12 2C7.58 2 4 5.58 4 10V20.5C4 21.33 4.94 21.8 5.6 21.3L7.5 19.9L9.4 21.3C9.76 21.57 10.24 21.57 10.6 21.3L12 20.25L13.4 21.3C13.76 21.57 14.24 21.57 14.6 21.3L16.5 19.9L18.4 21.3C19.06 21.8 20 21.33 20 20.5V10C20 5.58 16.42 2 12 2Z" fill="#9046FF"/>
<ellipse cx="9.5" cy="10.5" rx="1.5" ry="2" fill="#FFFFFF"/>
<ellipse cx="14.5" cy="10.5" rx="1.5" ry="2" fill="#FFFFFF"/>
</svg>`,
    },
  ],
};

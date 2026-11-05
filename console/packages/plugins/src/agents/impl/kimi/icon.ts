import type { AgentIconAsset } from '@switch-console/core/agents/plugins';

export const icon: AgentIconAsset = {
  kind: 'svg',
  alt: 'Kimi Code CLI',
  invertInDark: true,
  variants: [
    {
      minSize: 0,
      light: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M4 4.5C4 4.22386 4.22386 4 4.5 4H7.5C7.77614 4 8 4.22386 8 4.5V19.5C8 19.7761 7.77614 20 7.5 20H4.5C4.22386 20 4 19.7761 4 19.5V4.5Z" fill="#1C1B1F"/>
  <path d="M8.2 12.8L15.3 4.3C15.5 4.1 15.8 4 16.1 4H19.2C19.8 4 20.1 4.7 19.7 5.2L12.4 13.8L20 19.1C20.4 19.4 20.2 20 19.7 20H16.4C16.1 20 15.8 19.9 15.6 19.7L8.2 14.2V12.8Z" fill="#1C1B1F"/>
</svg>`,
    },
  ],
};

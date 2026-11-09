import type { AgentIconAsset } from '@switch-console/core/agents/plugins';

export const icon: AgentIconAsset = {
  kind: 'svg',
  alt: 'Qwen Code CLI',
  variants: [
    {
      minSize: 0,
      light: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
<path d="M12 2L3 7.2V16.8L12 22L21 16.8V7.2L12 2ZM18.8 8.1L12 12.03L5.2 8.1L12 4.17L18.8 8.1ZM5 9.87L11 13.33V20.25L5 16.8V9.87ZM13 20.25V13.33L19 9.87V16.8L13 20.25Z" fill="#615CED"/>
</svg>
`,
    },
  ],
};

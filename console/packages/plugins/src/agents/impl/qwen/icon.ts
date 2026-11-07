import type { AgentIconAsset } from '@switch-console/core/agents/plugins';

export const icon: AgentIconAsset = {
  kind: 'svg',
  alt: 'Qwen Code',
  variants: [
    {
      minSize: 0,
      light: `<svg width="128" height="128" viewBox="0 0 128 128" fill="none" xmlns="http://www.w3.org/2000/svg">
<rect width="128" height="128" rx="24" fill="#615CED"/>
<path d="M64 22L102 44V84L64 106L26 84V44L64 22Z" stroke="white" stroke-width="8" stroke-linejoin="round"/>
<path d="M26 44L64 66L102 44M64 66V106" stroke="white" stroke-width="8" stroke-linejoin="round"/>
<circle cx="64" cy="64" r="9" fill="white"/>
</svg>`,
    },
  ],
};

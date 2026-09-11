import switchExpertInstructions from './switch-expert.md?raw';

/**
 * Templates that ship inside the Console. They render in the same listing as
 * server templates but never touch the network — local-first, usable before
 * the server has a registry (or a connection) at all.
 */
export type BundledTemplate = {
  id: string;
  name: string;
  description: string;
  kind: string;
  creator: string;
  definition: string;
  repoUrl: string | null;
  sources: Array<{ url: string; label: string }> | null;
};

export const bundledTemplates: BundledTemplate[] = [
  {
    id: 'bundled:switch-expert',
    name: 'Switch expert',
    description:
      'An agent that knows Switch inside out: rooms, agents, bridges, templates. Ask it how to set things up or why something is not working.',
    kind: 'agent',
    creator: 'Switch',
    definition: switchExpertInstructions,
    repoUrl: 'https://github.com/sandbox-quantum/switch',
    sources: [
      { url: 'https://docs.flintai.dev', label: 'Switch documentation' },
      { url: 'https://docs.flintai.dev/getting-started', label: 'Getting started guide' },
      { url: 'https://docs.flintai.dev/working-in-switch', label: 'Working in Switch' },
    ],
  },
];

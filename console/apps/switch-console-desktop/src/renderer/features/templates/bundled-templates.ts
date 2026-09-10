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
  },
];

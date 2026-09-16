import triagePairTemplate from '@root/../../../examples/agent-templates/triage-pair.template.yaml?raw';
import switchExpertInstructions from '@root/../../../switch-expert/AGENT.md?raw';
import switchExpertTemplate from '@root/../../../switch-expert/template.yaml?raw';

/**
 * Templates that ship inside the Console. They render in the same listing as
 * server templates but never touch the network — local-first, usable before
 * the server has a registry (or a connection) at all.
 *
 * The Switch expert is read straight from `switch-expert/` at the repository
 * root: the template document from `template.yaml`, the persona from
 * `AGENT.md`. One source, so the expert the Console offers is the one the
 * repository documents. The triage pair is the repository's worked example
 * of a group: two agents and the room they share.
 */
export type BundledTemplate = {
  id: string;
  name: string;
  description: string;
  kind: string;
  creator: string;
  /** The agent template document (YAML). */
  content: string;
  /** Fills `agent.instructions` when the document leaves it out. */
  instructions: string | null;
};

export const bundledTemplates: BundledTemplate[] = [
  {
    id: 'bundled:switch-expert',
    name: 'Switch expert',
    description:
      'An agent that knows Switch inside out: rooms, agents, bridges, templates. Ask it how to set things up or why something is not working.',
    kind: 'agent',
    creator: 'Switch',
    content: switchExpertTemplate,
    instructions: switchExpertInstructions,
  },
  {
    id: 'bundled:triage-pair',
    name: 'Triage pair',
    description:
      'Two agents and a room: one triages incoming reports, one reproduces them. A worked example of a group template.',
    kind: 'group',
    creator: 'Switch',
    content: triagePairTemplate,
    instructions: null,
  },
];

export function findBundledTemplate(id: string): BundledTemplate | undefined {
  return bundledTemplates.find((t) => t.id === id);
}

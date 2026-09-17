import supportDeskTemplate from '@root/../../../examples/agent-templates/support-desk.template.yaml?raw';
import triagePairTemplate from '@root/../../../examples/agent-templates/triage-pair.template.yaml?raw';
import switchExpertInstructions from '@root/../../../switch-expert/AGENT.md?raw';
import switchExpertTemplate from '@root/../../../switch-expert/template.yaml?raw';

/**
 * Templates that ship inside the Console. They are listed next to the
 * workspace's templates but need no network: they work before the server
 * has a template registry, or a connection at all.
 *
 * The documents are read from the repository at build time. The Switch
 * expert comes from `switch-expert/` at the repository root: the template
 * from `template.yaml`, the instructions from `AGENT.md`. The others come
 * from `examples/agent-templates/`. One source, so the Console offers the
 * same documents the repository documents.
 */
export type BundledTemplate = {
  id: string;
  name: string;
  description: string;
  kind: string;
  creator: string;
  /** The template document, as YAML text. */
  content: string;
  /** Instructions kept in a separate file, used when the document has no `instructions:`. */
  instructions: string | null;
};

export const bundledTemplates: BundledTemplate[] = [
  {
    id: 'bundled:switch-expert',
    name: 'Switch expert',
    description: 'Knows Switch inside out. Ask it how to set things up or why something is off.',
    kind: 'agent',
    creator: 'Switch',
    content: switchExpertTemplate,
    instructions: switchExpertInstructions,
  },
  {
    id: 'bundled:triage-pair',
    name: 'Triage pair',
    description: 'Two agents and their room: one triages reports, one reproduces them.',
    kind: 'group',
    creator: 'Switch',
    content: triagePairTemplate,
    instructions: null,
  },
  {
    id: 'bundled:support-desk',
    name: 'Support desk',
    description: 'Two rooms and two agents: a greeter on intake, an engineer on escalations.',
    kind: 'group',
    creator: 'Switch',
    content: supportDeskTemplate,
    instructions: null,
  },
];

export function findBundledTemplate(id: string): BundledTemplate | undefined {
  return bundledTemplates.find((t) => t.id === id);
}

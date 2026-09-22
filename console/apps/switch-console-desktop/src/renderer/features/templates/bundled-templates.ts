import switchExpertInstructions from '@root/../../../switch-expert/AGENT.md?raw';
import switchExpertTemplate from '@root/../../../switch-expert/template.yaml?raw';

/**
 * Templates that ship inside the Console, read from the repository at build
 * time: the Switch expert from `switch-expert/`, the template from
 * `template.yaml` and the instructions from `AGENT.md`. Listing them needs
 * no request to the server, so they are there before the server has a
 * template registry.
 */
export type BundledTemplate = {
  id: string;
  name: string;
  description: string;
  kind: string;
  creator: string;
  yamlText: string;
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
    yamlText: switchExpertTemplate,
    instructions: switchExpertInstructions,
  },
];

export function findBundledTemplate(id: string): BundledTemplate | undefined {
  return bundledTemplates.find((t) => t.id === id);
}

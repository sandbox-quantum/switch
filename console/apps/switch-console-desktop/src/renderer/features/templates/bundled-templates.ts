import { rpc } from '@renderer/lib/ipc';
import switchExpertInstructions from '@root/../../../switch-expert/AGENT.md?raw';
import switchExpertConsoleTemplate from '@root/../../../switch-expert/template.console.yaml?raw';
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
  /** The document for a server that runs agent management. */
  yamlText: string;
  /**
   * The document for a server that does not, which the Console runs the
   * agents of itself; null when the template has only the one.
   */
  yamlWithoutManagement: string | null;
  /** Instructions kept in a separate file, used when the document has no `instructions:`. */
  instructions: string | null;
};

export const bundledTemplates: BundledTemplate[] = [
  {
    id: 'bundled:switch-expert',
    name: 'Switch expert',
    description:
      'An agent that knows Switch inside out. Ask it how to set things up or why something is off.',
    kind: 'agent',
    creator: 'Switch',
    yamlText: switchExpertTemplate,
    yamlWithoutManagement: switchExpertConsoleTemplate,
    instructions: switchExpertInstructions,
  },
];

export function findBundledTemplate(id: string): BundledTemplate | undefined {
  return bundledTemplates.find((t) => t.id === id);
}

/**
 * The bundled document to use on a server: the one for agent management when
 * the server runs it (its `agent_management` feature flag), else the one the
 * Console runs the agents of itself.
 */
export async function bundledYamlFor(
  template: BundledTemplate,
  serverId: string | null
): Promise<string> {
  if (template.yamlWithoutManagement === null) return template.yamlText;
  if (serverId === null) return template.yamlWithoutManagement;
  const res = await rpc.featureFlags.get(serverId);
  return res?.success && res.data.flags.agent_management
    ? template.yamlText
    : template.yamlWithoutManagement;
}

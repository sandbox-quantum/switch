import type { ParsedAgentTemplate } from '@main/core/agent-templates/controller';
import type { StoredTemplateSummary } from '@main/core/switch-servers/gateway-client';
import { rpc } from '@renderer/lib/ipc';
import { bundledTemplates, findBundledTemplate } from './bundled-templates';

/**
 * What the add-agent modal needs from an agent template: the parsed document
 * plus the room half re-cut as a room template, so the modal can provision the
 * room the moment the agent exists without parsing YAML itself.
 */
export type AgentTemplateData = {
  /** The template's own name, for the dialog title. */
  name: string;
  /** Suggested agent name; the person can still change it. */
  agentName: string | null;
  description: string;
  instructions: string;
  repoUrl: string | null;
  sources: ParsedAgentTemplate['sources'];
  /** Room-template YAML for the companion room, or null when the template has none. */
  roomYaml: string | null;
  roomName: string | null;
  warnings: string[];
};

async function fromContent(
  templateName: string,
  content: string,
  instructions: string | null
): Promise<AgentTemplateData> {
  const parsed = await rpc.agentTemplates.parse({ yamlText: content, instructions });
  const roomYaml = parsed.room
    ? await rpc.agentTemplates.roomDocument({ yamlText: content })
    : null;
  return {
    name: templateName,
    agentName: parsed.name,
    description: parsed.description,
    instructions: parsed.instructions,
    repoUrl: parsed.repoUrl,
    sources: parsed.sources,
    roomYaml,
    roomName: parsed.room?.name ?? null,
    warnings: parsed.warnings,
  };
}

/** Resolve a listing entry (bundled or from the server's registry) into modal data. */
export async function loadAgentTemplateData(
  serverId: string,
  template: StoredTemplateSummary
): Promise<AgentTemplateData> {
  const bundled = findBundledTemplate(template.id);
  if (bundled) return fromContent(bundled.name, bundled.content, bundled.instructions);
  const detail = await rpc.switchServers.getTemplateDetail({ serverId, templateId: template.id });
  return fromContent(detail.name, detail.definition, null);
}

/**
 * The bundled template whose agent is called `agentName`, if there is one. The
 * room-template wizard uses it when a slot names an agent that does not exist
 * yet: creating "switch-expert" should offer the Switch expert, not a blank
 * form. Bundled only: server templates would need a round trip per candidate.
 */
export async function bundledTemplateForAgent(
  agentName: string
): Promise<AgentTemplateData | null> {
  for (const bundled of bundledTemplates) {
    if (bundled.kind !== 'agent') continue;
    try {
      const data = await fromContent(bundled.name, bundled.content, bundled.instructions);
      if (data.agentName === agentName) return data;
    } catch {
      // A bundled template that does not parse is a build problem, not the
      // wizard's; the plain create path is still there.
    }
  }
  return null;
}

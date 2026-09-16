import type { ParsedAgentTemplate } from '@main/core/agent-templates/controller';
import type { AgentTemplateOrigin } from '@main/core/agents/agent-config-file';
import type { StoredTemplateSummary } from '@main/core/switch-servers/gateway-client';
import { rpc } from '@renderer/lib/ipc';
import { findBundledTemplate } from './bundled-templates';

/**
 * What the add-agent modal needs from an agent template: the parsed document
 * plus the room half re-cut as a room template, so the modal can provision the
 * room the moment the agent exists without parsing YAML itself.
 */
export type AgentTemplateData = {
  /** The template's own name, for the dialog title. */
  name: string;
  /** Where the template came from, kept on the agent so its settings page
   * can offer the template's current instructions later. */
  origin: AgentTemplateOrigin;
  /** Suggested agent name; the person can still change it. */
  agentName: string | null;
  description: string;
  instructions: string;
  repoUrl: string | null;
  sources: ParsedAgentTemplate['sources'];
  addressing: ParsedAgentTemplate['addressing'];
  /** Room-template YAML for the companion room, or null when the template has none. */
  roomYaml: string | null;
  roomName: string | null;
  warnings: string[];
};

async function fromContent(
  origin: AgentTemplateOrigin,
  content: string,
  instructions: string | null
): Promise<AgentTemplateData> {
  const templateName = origin.name;
  const parsed = await rpc.agentTemplates.parse({ yamlText: content, instructions });
  const roomYaml = parsed.room
    ? await rpc.agentTemplates.roomDocument({ yamlText: content })
    : null;
  return {
    name: templateName,
    origin,
    agentName: parsed.name,
    description: parsed.description,
    instructions: parsed.instructions,
    repoUrl: parsed.repoUrl,
    sources: parsed.sources,
    addressing: parsed.addressing,
    roomYaml,
    roomName: parsed.room?.name ?? null,
    warnings: parsed.warnings,
  };
}

/** Load a template again from where an agent's config says it came from. */
export async function loadAgentTemplateByOrigin(
  origin: AgentTemplateOrigin
): Promise<AgentTemplateData> {
  if (origin.source === 'bundled') {
    const bundled = findBundledTemplate(origin.id);
    if (!bundled) throw new Error(`This Console no longer bundles "${origin.name}".`);
    return fromContent(origin, bundled.content, bundled.instructions);
  }
  if (!origin.serverId)
    throw new Error(`"${origin.name}" came from a server this Console does not know.`);
  const detail = await rpc.switchServers.getTemplateDetail({
    serverId: origin.serverId,
    templateId: origin.id,
  });
  return fromContent(origin, detail.definition, null);
}

/** Resolve a listing entry (bundled or from the server's registry) into modal data. */
export async function loadAgentTemplateData(
  serverId: string,
  template: StoredTemplateSummary
): Promise<AgentTemplateData> {
  const bundled = findBundledTemplate(template.id);
  if (bundled) {
    return fromContent(
      { id: bundled.id, name: bundled.name, source: 'bundled' },
      bundled.content,
      bundled.instructions
    );
  }
  const detail = await rpc.switchServers.getTemplateDetail({ serverId, templateId: template.id });
  return fromContent(
    { id: detail.id, name: detail.name, source: 'server', serverId },
    detail.definition,
    null
  );
}

import type { ParsedAgentTemplate } from '@main/core/agent-templates/controller';
import type { AgentTemplateOrigin } from '@main/core/agents/agent-config-file';
import type { StoredTemplateSummary } from '@main/core/switch-servers/gateway-client';
import { rpc } from '@renderer/lib/ipc';
import { type BundledTemplate, bundledTemplates, findBundledTemplate } from './bundled-templates';

/**
 * What the add-agent modal needs from an agent template: the parsed document
 * plus the room half re-cut as a room template, so the modal can provision the
 * room the moment the agent exists without parsing YAML itself.
 */
export type AgentTemplateData = {
  /** The template's own name, for the dialog title. */
  name: string;
  /** Where the template came from, kept on the agent so its settings page
   * can offer the template's current instructions later. Null for a pasted
   * document, which has nowhere to be fetched from again. */
  origin: AgentTemplateOrigin | null;
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

/** Parse a document into what the dialog needs. Exported for the import modal. */
export async function agentTemplateDataFromContent(
  templateName: string,
  content: string,
  instructions: string | null,
  origin: AgentTemplateOrigin | null
): Promise<AgentTemplateData> {
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
    return agentTemplateDataFromContent(origin.name, bundled.content, bundled.instructions, origin);
  }
  if (!origin.serverId)
    throw new Error(`"${origin.name}" came from a server this Console does not know.`);
  const detail = await rpc.switchServers.getTemplateDetail({
    serverId: origin.serverId,
    templateId: origin.id,
  });
  return agentTemplateDataFromContent(origin.name, detail.definition, null, origin);
}

/** Resolve a listing entry (bundled or from the server's registry) into modal data. */
export async function loadAgentTemplateData(
  serverId: string,
  template: StoredTemplateSummary
): Promise<AgentTemplateData> {
  const bundled = findBundledTemplate(template.id);
  if (bundled) {
    return agentTemplateDataFromContent(bundled.name, bundled.content, bundled.instructions, {
      id: bundled.id,
      name: bundled.name,
      source: 'bundled',
    });
  }
  const detail = await rpc.switchServers.getTemplateDetail({ serverId, templateId: template.id });
  return agentTemplateDataFromContent(detail.name, detail.definition, null, {
    id: detail.id,
    name: detail.name,
    source: 'server',
    serverId,
  });
}

/** A template as the detail page shows it: where it lives, its data, its document. */
export type LoadedTemplate = {
  name: string;
  /** The Console-bundled copy, when this is (or shadows) one. */
  bundled: BundledTemplate | null;
  /** The registry row, when the template is on the server. */
  server: StoredTemplateSummary | null;
  data: AgentTemplateData;
  /** The full document, persona inlined, as it is or would be stored. */
  document: string;
};

/**
 * Load one template by the id the listing gave it: a bundled id, or a registry
 * row id. A bundled template that has also been saved to the server is loaded
 * from the server copy, which is the one admins can maintain, and the bundled
 * half is kept so the page can say so.
 */
export async function loadTemplateById(
  serverId: string,
  templateId: string
): Promise<LoadedTemplate> {
  const bundled = findBundledTemplate(templateId);
  if (bundled) {
    const document = await rpc.agentTemplates.compose({
      yamlText: bundled.content,
      instructions: bundled.instructions ?? '',
    });
    const data = await agentTemplateDataFromContent(bundled.name, document, null, {
      id: bundled.id,
      name: bundled.name,
      source: 'bundled',
    });
    return { name: bundled.name, bundled, server: null, data, document };
  }
  const detail = await rpc.switchServers.getTemplateDetail({ serverId, templateId });
  const data = await agentTemplateDataFromContent(detail.name, detail.definition, null, {
    id: detail.id,
    name: detail.name,
    source: 'server',
    serverId,
  });
  const shadowOf =
    bundledTemplates.find((b) => b.kind === 'agent' && b.name === detail.name) ?? null;
  const { definition: _definition, ...summary } = detail;
  return {
    name: detail.name,
    bundled: shadowOf,
    server: summary,
    data,
    document: detail.definition,
  };
}

import type { ParsedAgentTemplate } from '@main/core/agent-templates/controller';
import type { AgentTemplateOrigin } from '@main/core/agents/agent-config-file';
import type { ParsedTemplate } from '@main/core/room-templates/controller';
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

/** A template as the detail page shows it: where it lives, what it is, its document. */
export type LoadedTemplate = {
  name: string;
  description: string;
  kind: 'agent' | 'room';
  /** The Console-bundled copy, when this is (or shadows) one. */
  bundled: BundledTemplate | null;
  /** The registry row, when the template is on the server. */
  server: StoredTemplateSummary | null;
  /** Parsed, for an agent template. */
  agent: AgentTemplateData | null;
  /** Parsed, for a room template. */
  room: ParsedTemplate | null;
  /** The full document, persona inlined, as it is or would be stored. */
  document: string;
};

function isAgentDocument(yamlText: string): boolean {
  return /^agent:\s*$/m.test(yamlText) || /^agent:\s+\S/m.test(yamlText);
}

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
    const agent = await agentTemplateDataFromContent(bundled.name, document, null, {
      id: bundled.id,
      name: bundled.name,
      source: 'bundled',
    });
    return {
      name: bundled.name,
      description: bundled.description,
      kind: 'agent',
      bundled,
      server: null,
      agent,
      room: null,
      document,
    };
  }
  const detail = await rpc.switchServers.getTemplateDetail({ serverId, templateId });
  const { definition, ...summary } = detail;
  const shadowOf =
    bundledTemplates.find((b) => b.kind === 'agent' && b.name === detail.name) ?? null;
  if (detail.kind === 'agent' || (detail.kind !== 'room' && isAgentDocument(definition))) {
    const agent = await agentTemplateDataFromContent(detail.name, definition, null, {
      id: detail.id,
      name: detail.name,
      source: 'server',
      serverId,
    });
    return {
      name: detail.name,
      description: detail.description,
      kind: 'agent',
      bundled: shadowOf,
      server: summary,
      agent,
      room: null,
      document: definition,
    };
  }
  const room = await rpc.roomTemplates.parse({ yamlText: definition });
  return {
    name: detail.name,
    description: detail.description,
    kind: 'room',
    bundled: null,
    server: summary,
    agent: null,
    room,
    document: definition,
  };
}

/** A readable listing name from a file name: no extension, no `.template`, words not dashes. */
export function templateNameFromFile(fileName: string): string {
  const stem = fileName
    .replace(/(\.template)?\.ya?ml$/i, '')
    .replace(/[-_]+/g, ' ')
    .trim();
  return stem.length === 0 ? stem : stem[0].toUpperCase() + stem.slice(1);
}

/** What the save dialog should offer for a document: its kind, a name and a description. */
export async function prefillForSave(
  content: string,
  sourceName: string | null
): Promise<{ kind: 'agent' | 'room'; name: string; description: string }> {
  const fromFile = sourceName ? templateNameFromFile(sourceName) : '';
  if (/^agent:\s*$/m.test(content) || /^agent:\s+\S/m.test(content)) {
    const t = await agentTemplateDataFromContent(fromFile || 'Agent template', content, null, null);
    return {
      kind: 'agent',
      name: fromFile || t.agentName || 'Agent template',
      description: t.description,
    };
  }
  const t = await rpc.roomTemplates.parse({ yamlText: content });
  const roomName = t.roomName && !/\{[^}]+\}/.test(t.roomName) ? t.roomName : null;
  return {
    kind: 'room',
    name: fromFile || roomName || 'Room template',
    description: t.roomDescription ?? '',
  };
}

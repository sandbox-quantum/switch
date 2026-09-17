import type {
  ParsedAgentEntry,
  ParsedAgentTemplate,
  TemplateKind,
  TemplateSummary,
} from '@main/core/agent-templates/controller';
import type { AgentTemplateOrigin } from '@main/core/agents/agent-config-file';
import type { ParsedTemplate } from '@main/core/room-templates/controller';
import type { StoredTemplateSummary } from '@main/core/switch-servers/gateway-client';
import { rpc } from '@renderer/lib/ipc';
import { type BundledTemplate, bundledTemplates, findBundledTemplate } from './bundled-templates';

/**
 * One agent as a template describes it, plus its room part already converted
 * to a room template. A caller can create the room as soon as the agent
 * exists, without parsing YAML itself.
 */
export type AgentTemplateData = {
  /** The template's own name, for a heading. */
  name: string;
  /** Where the template came from. Recorded on the agent so its settings
   * page can load the template again and offer its current instructions.
   * Null for a pasted document, which cannot be loaded again. */
  origin: AgentTemplateOrigin | null;
  /** The agent name the template suggests. The person can change it before creating. */
  agentName: string | null;
  description: string;
  instructions: string;
  repoUrl: string | null;
  sources: ParsedAgentTemplate['sources'];
  addressing: ParsedAgentTemplate['addressing'];
  /** The template's room as a room template document, or null when it declares no room. */
  roomYaml: string | null;
  roomName: string | null;
  warnings: string[];
};

/** Parse a document into the agent it describes. */
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

/** Resolve a listing entry (bundled or from the server's registry) into the agent it describes. */
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

/** A template loaded for its page: its source, what it creates, and its document. */
export type LoadedTemplate = {
  name: string;
  description: string;
  kind: TemplateKind;
  /** The bundled template, when this is one. Null for a workspace template. */
  bundled: BundledTemplate | null;
  /** For a bundled template: its copy saved on the workspace, or null when there is none. */
  savedCopy: StoredTemplateSummary | null;
  /** For a workspace template: the bundled template with the same name, or null when there is none. */
  copyOf: BundledTemplate | null;
  /** The workspace record, when the template is stored on the server. Null for a bundled template. */
  server: StoredTemplateSummary | null;
  /** The agents the template creates, in document order. Empty for a room template. */
  agents: ParsedAgentEntry[];
  /** The room part, parsed: the rooms and the params. Null when the document has no rooms. */
  room: ParsedTemplate | null;
  /** The rooms and agents it creates, with counts for the listing card. */
  summary: TemplateSummary;
  /** The full document with agent instructions inlined, as stored or as it would be stored. */
  document: string;
};

/** Classify a document from its top-level keys alone, without parsing the YAML. */
export function documentKind(yamlText: string): TemplateKind {
  if (/^group:/m.test(yamlText) || /^rooms:/m.test(yamlText)) return 'group';
  if (/^agents:/m.test(yamlText)) return 'group';
  if (/^agent:\s*$/m.test(yamlText) || /^agent:\s+\S/m.test(yamlText)) return 'agent';
  return 'room';
}

/**
 * Load one template by the id the listing gave it: a bundled id, or a registry
 * row id. A bundled template also records whether a copy of it is saved on
 * the workspace, and a workspace row records which built-in it copies, so
 * the page can say either.
 */
export async function loadTemplateById(
  serverId: string,
  templateId: string
): Promise<LoadedTemplate> {
  const bundled = findBundledTemplate(templateId);
  let name: string;
  let description: string;
  let document: string;
  let server: StoredTemplateSummary | null = null;
  let copyOf: BundledTemplate | null = null;
  let savedCopy: StoredTemplateSummary | null = null;
  if (bundled) {
    savedCopy =
      (await rpc.switchServers.listTemplates({ serverId }).catch(() => [])).find(
        (t) => t.name === bundled.name
      ) ?? null;
    name = bundled.name;
    description = bundled.description;
    document = bundled.instructions
      ? await rpc.agentTemplates.compose({
          yamlText: bundled.content,
          instructions: bundled.instructions,
        })
      : bundled.content;
  } else {
    const detail = await rpc.switchServers.getTemplateDetail({ serverId, templateId });
    const { definition, ...summary } = detail;
    name = detail.name;
    description = detail.description;
    document = definition;
    server = summary;
    copyOf = bundledTemplates.find((b) => b.name === detail.name) ?? null;
  }
  const kind = await rpc.agentTemplates.kind({ yamlText: document });
  const { agents } = await rpc.agentTemplates.parseAgents({ yamlText: document });
  const coreYaml = await rpc.agentTemplates.coreDocument({ yamlText: document });
  const room = coreYaml ? await rpc.roomTemplates.parse({ yamlText: coreYaml }) : null;
  const summary = await rpc.agentTemplates.summarize({ yamlText: document });
  return {
    name,
    description,
    kind,
    bundled: bundled ?? null,
    savedCopy,
    copyOf,
    server,
    agents,
    room,
    summary,
    document,
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
): Promise<{ kind: TemplateKind; name: string; description: string }> {
  const fromFile = sourceName ? templateNameFromFile(sourceName) : '';
  const kind = await rpc.agentTemplates.kind({ yamlText: content });
  if (kind === 'agent') {
    const t = await agentTemplateDataFromContent(fromFile || 'Agent template', content, null, null);
    return {
      kind,
      name: fromFile || t.agentName || 'Agent template',
      description: t.description,
    };
  }
  const coreYaml = await rpc.agentTemplates.coreDocument({ yamlText: content });
  const t = coreYaml ? await rpc.roomTemplates.parse({ yamlText: coreYaml }) : null;
  const literal = (s: string | null) => (s && !/\{[^}]+\}/.test(s) ? s : null);
  return {
    kind,
    name:
      fromFile ||
      literal(t?.groupName ?? null) ||
      literal(t?.roomName ?? null) ||
      (kind === 'group' ? 'Group template' : 'Room template'),
    // A room's description often contains a placeholder ("Workroom for
    // {task}"), which reads badly on a listing card. Leave the description
    // empty and let the person write one in the dialog.
    description: literal(t?.roomDescription ?? null) ?? '',
  };
}

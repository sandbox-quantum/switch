import type { ToolResult } from '@sandboxaq/switch-agent-runtime/hosted';

export interface SessionToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface CompactGroupSpec {
  name: string;
  label: string;
  operations: readonly string[];
}

/**
 * Antigravity (`agy acp`) caps session MCP tools to the 50 smallest definitions
 * and disables the rest. Consolidating secondary CRUD/admin operations into
 * domain dispatchers keeps total Switch tools comfortably below 50 while
 * keeping every high-frequency and prompt-referenced tool (messaging, rooms,
 * core agent/template/role use) first-class with unchanged names and schemas.
 */
export const COMPACT_TOOL_THRESHOLD = 40;

const COMPACT_GROUPS: readonly CompactGroupSpec[] = [
  {
    name: 'manage_rooms',
    label: 'room membership, archive, link, YAML, and group',
    operations: [
      'archive_room',
      'unarchive_room',
      'invite_agent_to_room',
      'remove_agent_from_room',
      'add_users_to_room',
      'link_rooms',
      'unlink_rooms',
      'list_linked_rooms',
      'create_room_from_yaml',
      'create_room_group',
      'list_room_groups',
      'get_room_group_detail',
    ],
  },
  {
    name: 'manage_agents',
    label: 'agent configuration, service grant, and deletion',
    operations: [
      'update_agent_detail',
      'request_agent_deletion',
      'set_agent_service',
      'remove_agent_service',
      'get_advanced_config',
    ],
  },
  {
    name: 'manage_roles',
    label: 'room role authoring',
    operations: ['define_role', 'edit_role', 'delete_role'],
  },
  {
    name: 'manage_references',
    label: 'reference and room document',
    operations: [
      'list_all_references',
      'list_reference_types',
      'create_reference',
      'attach_reference_to_room',
      'create_room_document',
      'update_room_document',
      'delete_room_document',
    ],
  },
  {
    name: 'manage_schedules',
    label: 'room schedule',
    operations: [
      'list_room_schedules',
      'create_room_schedule',
      'update_room_schedule',
      'pause_room_schedule',
      'delete_room_schedule',
    ],
  },
  {
    name: 'manage_templates',
    label: 'template inspection and authoring',
    operations: [
      'get_template',
      'get_template_guide',
      'get_template_status',
      'save_template',
      'update_template',
      'delete_template',
    ],
  },
];

const GROUP_BY_TOOL = new Map(COMPACT_GROUPS.map((group) => [group.name, group]));
const GROUP_BY_OPERATION = new Map(
  COMPACT_GROUPS.flatMap((group) => group.operations.map((op) => [op, group] as const))
);

function formatActionLine(tool: SessionToolDefinition): string {
  const schema = tool.inputSchema;
  const props =
    schema.properties && typeof schema.properties === 'object'
      ? Object.keys(schema.properties as Record<string, unknown>)
      : [];
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((entry): entry is string => typeof entry === 'string')
      : []
  );
  const paramList = props.map((prop) => (required.has(prop) ? `${prop}*` : prop)).join(', ');
  const summary =
    tool.description
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean) ?? '';
  return `- ${tool.name}(${paramList})${summary ? `: ${summary}` : ''}`;
}

function buildGroupTool(
  group: CompactGroupSpec,
  members: readonly SessionToolDefinition[]
): SessionToolDefinition {
  const actions = members.map((member) => member.name);
  return {
    name: group.name,
    description: [
      `Run a ${group.label} Switch operation. Choose \`action\` and pass its parameters in \`arguments\` (or set \`describe: true\` to inspect an action's full schema).`,
      'Parameters marked `*` are required:',
      ...members.map(formatActionLine),
    ].join('\n'),
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: actions,
          description: 'Switch operation name to run.',
        },
        arguments: {
          type: 'object',
          additionalProperties: true,
          description: 'Arguments object for the selected action (omit or pass {} if none needed).',
        },
        describe: {
          type: 'boolean',
          description: 'When true, returns the full schema for `action` without running it.',
        },
      },
    },
  };
}

/**
 * Collapses grouped secondary Switch operations into domain dispatcher tools
 * when `tools.length` exceeds `threshold`. Core tools and ungrouped tools pass
 * through unchanged.
 */
export function compactSwitchTools(
  tools: readonly SessionToolDefinition[],
  threshold = COMPACT_TOOL_THRESHOLD
): SessionToolDefinition[] {
  if (tools.length <= threshold) return [...tools];
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const result: SessionToolDefinition[] = [];
  for (const tool of tools) {
    if (GROUP_BY_OPERATION.has(tool.name) || GROUP_BY_TOOL.has(tool.name)) continue;
    result.push(tool);
  }
  for (const group of COMPACT_GROUPS) {
    const members = group.operations
      .map((op) => byName.get(op))
      .filter((member): member is SessionToolDefinition => member !== undefined);
    if (members.length > 0) result.push(buildGroupTool(group, members));
  }
  return result;
}

function errorResult(text: string): ToolResult {
  return { isError: true, content: [{ type: 'text', text }] };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Unwraps a call targeting a consolidated domain dispatcher (`manage_*`) back
 * to the underlying Switch operation name and arguments, or returns a local
 * schema/validation response directly.
 */
export async function dispatchCompactedToolCall(
  name: string,
  args: Record<string, unknown>,
  forward: (operationName: string, operationArgs: Record<string, unknown>) => Promise<ToolResult>,
  getRawTools: () => Promise<Map<string, SessionToolDefinition>>
): Promise<ToolResult> {
  const group = GROUP_BY_TOOL.get(name);
  if (!group) return forward(name, args);

  const action = typeof args.action === 'string' ? args.action.trim() : '';
  if (!action || !group.operations.includes(action)) {
    return errorResult(
      `Invalid action for ${name}. Expected one of: ${group.operations.join(', ')}.`
    );
  }

  if (args.describe === true) {
    const raw = (await getRawTools()).get(action);
    if (!raw) return errorResult(`Operation ${action} is not available in this session.`);
    return { content: [{ type: 'text', text: JSON.stringify(raw, null, 2) }] };
  }

  if (args.arguments !== undefined && !isPlainRecord(args.arguments)) {
    return errorResult(`Invalid arguments for ${action}: expected an object.`);
  }
  const nestedArgs = isPlainRecord(args.arguments) ? args.arguments : {};
  const extraTopLevel: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (key !== 'action' && key !== 'arguments' && key !== 'describe') extraTopLevel[key] = value;
  }
  return forward(action, { ...extraTopLevel, ...nestedArgs });
}

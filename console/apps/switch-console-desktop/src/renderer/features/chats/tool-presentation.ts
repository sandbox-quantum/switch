import type { Item } from '@switch-console/shared/session-v1';
import type { ToolDetail } from '@shared/core/sessions/reasoning';

/**
 * How a tool call reads in a chat's work log: what kind of thing it did (for
 * its icon), a short human label ("Ran `ls -la`", "Read src/store.ts") and
 * what opening it shows.
 *
 * The session-v1 item carries only a title. What the call was given and gave
 * back comes from the session host's tool details when it has them (a local
 * or SSH host that knows them); without them the row is labelled from the
 * title alone and has nothing to open.
 */

export type ToolKind =
  | 'shell'
  | 'read'
  | 'edit'
  | 'search'
  | 'web'
  | 'agent'
  | 'todo'
  | 'switch'
  | 'mcp'
  | 'other';

export type DiffLine = { sign: '+' | '-' | ' '; text: string };

export type ToolDetailView =
  | { kind: 'command'; command: string; output: string | null; exitCode: number | null }
  | { kind: 'read'; path: string | null; output: string | null }
  | { kind: 'diff'; path: string | null; lines: DiffLine[] }
  | { kind: 'search'; query: string | null; scope: string | null; output: string | null }
  | { kind: 'web'; target: string | null; output: string | null }
  | { kind: 'generic'; input: string | null; output: string | null };

export type ToolPresentation = {
  kind: ToolKind;
  /** The verb ("Ran", "Read") and what it acted on, which is set in code when it is code. */
  verb: string;
  subject: string | null;
  code: boolean;
  /** Null when there is nothing to show beyond the label: the row does not open. */
  details: ToolDetailView | null;
  truncated: boolean;
};

const SHELL = new Set(['Bash', 'bash', 'BashOutput', 'KillShell', 'KillBash', 'shell']);
const READ = new Set(['Read', 'read', 'NotebookRead', 'view']);
const EDIT = new Set([
  'Edit',
  'MultiEdit',
  'Write',
  'NotebookEdit',
  'edit',
  'write',
  'patch',
  'apply_patch',
  'multiedit',
]);
const SEARCH = new Set(['Grep', 'Glob', 'LS', 'grep', 'glob', 'list', 'codesearch']);
const WEB = new Set(['WebSearch', 'WebFetch', 'websearch', 'webfetch', 'web_search']);
const AGENT = new Set(['Task', 'Agent', 'task']);
const TODO = new Set(['TodoWrite', 'TodoRead', 'todowrite', 'todoread']);

/** Tool names the Switch MCP server's tools carry, as Claude Code reports them. */
export const SWITCH_TOOL_PREFIX = 'mcp__switch__';

const SWITCH_LABELS: Record<string, string> = {
  connect_to_room: 'Connected to the room',
  read_context: 'Read the room',
  post_message: 'Posted to the room',
  send_targeted_message: 'Sent a message in the room',
  send_attachment: 'Sent an attachment',
  download_attachment: 'Downloaded an attachment',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function field(input: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return null;
}

function kindOf(name: string, type: string | null): ToolKind {
  if (name.startsWith(SWITCH_TOOL_PREFIX)) return 'switch';
  if (SHELL.has(name) || type === 'command_execution') return 'shell';
  if (READ.has(name)) return 'read';
  if (EDIT.has(name) || type === 'file_change') return 'edit';
  if (SEARCH.has(name)) return 'search';
  if (WEB.has(name) || type === 'web_search') return 'web';
  if (AGENT.has(name) || type === 'subagent') return 'agent';
  if (TODO.has(name)) return 'todo';
  if (name.startsWith('mcp__') || type === 'mcp_tool_call') return 'mcp';
  return 'other';
}

/** A tool name as Claude reports an MCP one (`mcp__server__tool`), split for reading. */
function mcpParts(name: string): { server: string; tool: string } | null {
  const match = /^mcp__(.+?)__(.+)$/.exec(name);
  return match ? { server: match[1]!, tool: match[2]! } : null;
}

const humanize = (name: string) => name.replace(/[_-]+/g, ' ').trim();

function lines(text: string): string[] {
  return text.replace(/\n$/, '').split('\n');
}

function editDiff(name: string, input: Record<string, unknown>): DiffLine[] {
  const pairs: { before: string; after: string }[] = [];
  const edits = Array.isArray(input.edits) ? input.edits : null;
  if (edits) {
    for (const edit of edits)
      if (isRecord(edit))
        pairs.push({
          before: field(edit, 'old_string', 'oldString') ?? '',
          after: field(edit, 'new_string', 'newString') ?? '',
        });
  } else if (
    field(input, 'old_string', 'oldString') !== null ||
    field(input, 'new_string', 'newString') !== null
  ) {
    pairs.push({
      before: field(input, 'old_string', 'oldString') ?? '',
      after: field(input, 'new_string', 'newString') ?? '',
    });
  } else if (name === 'Write' || name === 'write' || field(input, 'content') !== null) {
    const content = field(input, 'content', 'new_source');
    if (content) pairs.push({ before: '', after: content });
  }
  return pairs.flatMap(({ before, after }, index) => [
    ...(index > 0 ? [{ sign: ' ' as const, text: '…' }] : []),
    ...(before ? lines(before).map((text) => ({ sign: '-' as const, text })) : []),
    ...(after ? lines(after).map((text) => ({ sign: '+' as const, text })) : []),
  ]);
}

/** A unified diff's lines, coloured by their first character; headers read as context. */
function unifiedDiff(text: string): DiffLine[] {
  return lines(text).map((line) => {
    if (line.startsWith('+') && !line.startsWith('+++')) return { sign: '+', text: line.slice(1) };
    if (line.startsWith('-') && !line.startsWith('---')) return { sign: '-', text: line.slice(1) };
    return { sign: ' ', text: line };
  });
}

function pretty(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  if (typeof input === 'string') return input.trim() ? input : null;
  if (isRecord(input) && Object.keys(input).length === 0) return null;
  return JSON.stringify(input, null, 2);
}

function nonEmpty(text: string | null | undefined): string | null {
  return text && text.trim().length > 0 ? text : null;
}

/** The title's tool name and subject, for a row with no details (`Edit /a.ts`, `Read`). */
function fromTitle(title: string): { name: string; subject: string | null } {
  const match = /^([A-Za-z]+) (\S.*)$/.exec(title);
  if (match && (EDIT.has(match[1]!) || READ.has(match[1]!)))
    return { name: match[1]!, subject: match[2]! };
  return { name: title, subject: null };
}

/** The verb while running and once done, and the whole label when there is no subject. */
type Verbs = { running: string; done: string; bareRunning: string; bareDone: string };
const VERBS: Record<Exclude<ToolKind, 'switch' | 'mcp' | 'other'>, Verbs> = {
  shell: {
    running: 'Running',
    done: 'Ran',
    bareRunning: 'Running a command',
    bareDone: 'Ran a command',
  },
  read: {
    running: 'Reading',
    done: 'Read',
    bareRunning: 'Reading a file',
    bareDone: 'Read a file',
  },
  edit: {
    running: 'Editing',
    done: 'Edited',
    bareRunning: 'Editing a file',
    bareDone: 'Edited a file',
  },
  search: {
    running: 'Searching for',
    done: 'Searched for',
    bareRunning: 'Searching',
    bareDone: 'Searched',
  },
  web: {
    running: 'Searching the web for',
    done: 'Searched the web for',
    bareRunning: 'Searching the web',
    bareDone: 'Searched the web',
  },
  agent: {
    running: 'Running agent:',
    done: 'Ran agent:',
    bareRunning: 'Running an agent',
    bareDone: 'Ran an agent',
  },
  todo: {
    running: 'Updating the to-do list',
    done: 'Updated the to-do list',
    bareRunning: 'Updating the to-do list',
    bareDone: 'Updated the to-do list',
  },
};

export function presentTool(item: Item, detail: ToolDetail | null): ToolPresentation {
  const running = item.status === 'in-progress';
  const titled = fromTitle(item.title);
  const name = detail?.toolName ?? titled.name;
  const kind = kindOf(name, detail?.type ?? null);
  const input = isRecord(detail?.input) ? detail.input : {};
  const output = nonEmpty(detail?.output) ?? nonEmpty(item.text);
  const truncated = detail?.truncated ?? false;
  const base = { kind, truncated };
  const labelled = (verbs: Verbs, subject: string | null, code: boolean) =>
    subject
      ? { verb: running ? verbs.running : verbs.done, subject, code }
      : { verb: running ? verbs.bareRunning : verbs.bareDone, subject: null, code: false };

  switch (kind) {
    case 'shell': {
      const command = field(input, 'command') ?? item.title;
      return {
        ...base,
        ...labelled(VERBS.shell, command, true),
        details: detail
          ? { kind: 'command', command, output, exitCode: detail.exitCode }
          : output
            ? { kind: 'command', command, output, exitCode: null }
            : null,
      };
    }
    case 'read': {
      const path = field(input, 'file_path', 'filePath', 'path', 'notebook_path') ?? titled.subject;
      return {
        ...base,
        ...labelled(VERBS.read, path, false),
        details: output ? { kind: 'read', path, output } : null,
      };
    }
    case 'edit': {
      const path =
        field(input, 'file_path', 'filePath', 'path', 'notebook_path') ??
        titled.subject ??
        (detail?.type === 'file_change' ? item.title : null);
      const diff = editDiff(name, input);
      const lines = diff.length > 0 ? diff : output ? unifiedDiff(output) : [];
      const created = name === 'Write' || name === 'write';
      return {
        ...base,
        ...labelled(
          created ? { ...VERBS.edit, running: 'Writing', done: 'Wrote' } : VERBS.edit,
          path,
          false
        ),
        details: lines.length > 0 ? { kind: 'diff', path, lines } : null,
      };
    }
    case 'search': {
      const query = field(input, 'pattern', 'query', 'path');
      const scope = field(input, 'path', 'glob', 'include');
      return {
        ...base,
        ...labelled(VERBS.search, query, true),
        details:
          query || output
            ? { kind: 'search', query, scope: scope === query ? null : scope, output }
            : null,
      };
    }
    case 'web': {
      const url = field(input, 'url');
      const target = field(input, 'query') ?? url ?? (item.title !== name ? item.title : null);
      return {
        ...base,
        ...labelled(
          url ? { ...VERBS.web, running: 'Fetching', done: 'Fetched' } : VERBS.web,
          target,
          false
        ),
        details: detail && (target || output) ? { kind: 'web', target, output } : null,
      };
    }
    case 'agent':
    case 'todo': {
      const subject =
        kind === 'agent' ? (field(input, 'description') ?? (item.title || null)) : null;
      const shown = pretty(detail?.input);
      return {
        ...base,
        ...labelled(VERBS[kind], subject, false),
        details: shown || output ? { kind: 'generic', input: shown, output } : null,
      };
    }
    case 'switch':
    case 'mcp':
    case 'other': {
      const mcp = mcpParts(name);
      const label =
        kind === 'switch'
          ? (SWITCH_LABELS[mcp?.tool ?? ''] ?? `Switch: ${humanize(mcp?.tool ?? name)}`)
          : mcp
            ? `${humanize(mcp.server)}: ${humanize(mcp.tool)}`
            : item.title || name;
      const shown = pretty(detail?.input);
      return {
        ...base,
        verb: label,
        subject: null,
        code: false,
        details: shown || output ? { kind: 'generic', input: shown, output } : null,
      };
    }
  }
}

/** A path's last few segments, which are the part a reader looks for. */
export function shortPath(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : path;
}

const COUNTED: Record<ToolKind, (count: number) => string> = {
  shell: (n) => `Ran ${n} ${n === 1 ? 'command' : 'commands'}`,
  read: (n) => `Read ${n} ${n === 1 ? 'file' : 'files'}`,
  edit: (n) => `Edited ${n} ${n === 1 ? 'file' : 'files'}`,
  search: (n) => `Searched ${n} ${n === 1 ? 'time' : 'times'}`,
  web: (n) => `Searched the web ${n} ${n === 1 ? 'time' : 'times'}`,
  agent: (n) => `Ran ${n} ${n === 1 ? 'agent' : 'agents'}`,
  todo: (n) => `Updated the to-do list${n === 1 ? '' : ` ${n} times`}`,
  switch: (n) => `Took ${n} Switch ${n === 1 ? 'action' : 'actions'}`,
  mcp: (n) => `Called ${n} ${n === 1 ? 'tool' : 'tools'}`,
  other: (n) => `Used ${n} ${n === 1 ? 'tool' : 'tools'}`,
};

/**
 * One line for a run of tool calls, by kind in the order each first appears:
 * "Ran 2 commands, read 3 files and edited 1 file". The kind is the icon's
 * when every call shares it, and null when they are mixed.
 */
export function summarizeTools(kinds: ToolKind[]): { label: string; kind: ToolKind | null } {
  const counts = new Map<ToolKind, number>();
  for (const kind of kinds) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  const parts = [...counts].map(([kind, count], index) => {
    const text = COUNTED[kind](count);
    return index === 0 ? text : text.charAt(0).toLowerCase() + text.slice(1);
  });
  const label =
    parts.length < 2 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
  return { label, kind: counts.size === 1 ? kinds[0]! : null };
}

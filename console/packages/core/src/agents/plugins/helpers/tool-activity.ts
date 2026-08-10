/**
 * Shared pieces for turning a tool hook body into a runtime-activity line.
 *
 * The wire format is Claude Code's hook payload — `tool_name` plus a
 * `tool_input` object — which Codex also emits, so the parts that only read
 * those two fields live here rather than in either provider. What a tool acts
 * *on* does not generalise: the tool names differ per provider and so do the
 * `tool_input` keys, so each provider supplies its own object extractor and
 * composes it with {@link formatToolActivityLine}.
 */

/** The base name of a file path, for compact activity lines. */
export function baseName(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}

/** Read a tool name off a hook body (pre/post tool use, or a failure). */
export function toolNameOf(body: Record<string, unknown>): string {
  return typeof body.tool_name === 'string' ? body.tool_name : '';
}

/** A tool's bare leaf label — MCP tools arrive as mcp__<server>__<tool>. */
export function toolLabel(toolName: string): string {
  return toolName.startsWith('mcp__')
    ? (toolName.split('__').filter(Boolean).pop() ?? toolName)
    : toolName;
}

/** A tool body's `tool_input` as a plain object; empty when absent or scalar. */
export function toolInputOf(body: Record<string, unknown>): Record<string, unknown> {
  return body.tool_input && typeof body.tool_input === 'object' && !Array.isArray(body.tool_input)
    ? (body.tool_input as Record<string, unknown>)
    : {};
}

/** Whitespace-collapsed and truncated, for a value shown inline in a status. */
export function collapseText(value: string, limit = 60): string {
  const oneLine = value.replace(/\s+/g, ' ').trim();
  return oneLine.length > limit ? `${oneLine.slice(0, limit - 3)}…` : oneLine;
}

/**
 * A command off a tool input, whether the provider sends it as a string
 * (Claude's `Bash`) or as an argv array (Codex's `shell`).
 */
export function commandText(value: unknown): string | undefined {
  if (typeof value === 'string') return collapseText(value) || undefined;
  if (Array.isArray(value)) {
    const joined = value.filter((part) => typeof part === 'string').join(' ');
    return collapseText(joined) || undefined;
  }
  return undefined;
}

/**
 * A tool activity line, e.g. "_Running tool_ `Edit` — foo.py". `verb` is the
 * italicised lead; the tool name is code-formatted and `object` trails after an
 * em dash when present.
 */
export function formatToolActivityLine(
  toolName: string,
  verb: string,
  object: string | undefined
): string {
  return `_${verb}_ \`${toolLabel(toolName)}\`` + (object ? ` — ${object}` : '');
}

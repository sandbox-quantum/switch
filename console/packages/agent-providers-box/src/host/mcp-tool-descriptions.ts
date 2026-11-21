import type { ToolDefinition } from '@sandboxaq/switch-agent-runtime-box/hosted';
import type { ProviderKind } from '../events';

/** How a session's MCP tools are described to its CLI. */
export type DescribeTools = (tools: ToolDefinition[]) => ToolDefinition[];

/** The most of a tool's first paragraph a brief description keeps. */
export const BRIEF_DESCRIPTION_MAX = 400;

/**
 * A tool's description cut to its first paragraph, and to
 * `BRIEF_DESCRIPTION_MAX` characters at a word boundary.
 */
export function briefDescription(description: string): string {
  const first = description
    .trim()
    .split(/\n\s*\n/, 1)[0]!
    .replace(/\s+/g, ' ');
  if (first.length <= BRIEF_DESCRIPTION_MAX) return first;
  const cut = first.slice(0, BRIEF_DESCRIPTION_MAX - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > 0 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * How `provider`'s CLI is told about MCP tools: as the servers describe them,
 * except for Antigravity, which gets each tool's first paragraph.
 *
 * agy (1.5) offers the model MCP tools smallest first until their definitions
 * reach about 55,000 characters, and makes the rest "lazy": listed only as
 * schema files, to be called through a `call_mcp_tool` tool that `agy acp`
 * does not offer. Switch's tools are about 97,000 characters as served, so
 * the ten largest, `post_message` and `read_context` among them, could not be
 * called at all. Brief, the Switch tools come to about 26,000, leaving room
 * for a granted service's. The room workflow the full descriptions spell out
 * reaches Antigravity in the Switch skill.
 */
export function describeToolsFor(provider: ProviderKind): DescribeTools {
  if (provider !== 'antigravity') return (tools) => tools;
  return (tools) =>
    tools.map((tool) => ({ ...tool, description: briefDescription(tool.description) }));
}

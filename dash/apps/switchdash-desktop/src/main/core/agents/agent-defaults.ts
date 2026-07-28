import os from 'node:os';
import path from 'node:path';
import { getProvider, type AgentProviderId } from '@shared/core/providers/agent-provider-registry';
import type { AgentDefaults } from '@shared/core/switch-servers/switch-servers';

/**
 * Slugify a string into the Switch agent-name charset: lowercase letters,
 * digits, `.`, `-`, `_`. Any other character becomes `-`; runs of `-` collapse
 * and leading/trailing `-` are stripped. Mirrors the `configure` skill's slug
 * rule so desktop-registered agents are named the same way.
 */
export function slugifyAgentNamePart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Suggest a default name and description for a new agent of `providerId` in
 * `dir`. The name is `<provider-slug>.<repo-slug>.<user-slug>`, where the prefix
 * is the provider's display name slugified — `codex`, `claude-code`, `grok`, etc.
 * — so the default reflects the chosen agent type (CHOO-1436). The per-user
 * suffix keeps two developers registering from the same repo from colliding (see
 * the `configure` skill). Falls back to the bare provider slug if the repo/user
 * parts both slug to empty.
 */
export function suggestAgentDefaults(dir: string, providerId: AgentProviderId): AgentDefaults {
  const providerName = getProvider(providerId)?.name ?? providerId;
  const providerSlug =
    slugifyAgentNamePart(providerName) || slugifyAgentNamePart(providerId) || 'agent';
  const repoSlug = slugifyAgentNamePart(path.basename(dir));
  let userSlug = '';
  try {
    userSlug = slugifyAgentNamePart(os.userInfo().username);
  } catch {
    userSlug = '';
  }

  const parts = [providerSlug, repoSlug, userSlug].filter((p) => p.length > 0);
  const name = parts.length > 1 ? parts.join('.') : providerSlug;
  const repoLabel = path.basename(dir) || 'this directory';
  return { name, description: `${providerName} running in ${repoLabel}` };
}

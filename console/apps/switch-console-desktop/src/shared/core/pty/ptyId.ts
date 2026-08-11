import { AGENT_PROVIDER_IDS, type AgentProviderId } from '../providers/agent-provider-registry';

const SESSION_SEP = '-session-';

// Legacy separators — used only for snapshot migration fallback lookups.
const LEGACY_MAIN_SEP = '-main-';
const LEGACY_CHAT_SEP = '-chat-';

export function makePtyId(provider: AgentProviderId | 'shell', sessionId: string): string {
  return `${provider}${SESSION_SEP}${sessionId}`;
}

/**
 * Narrow a provider id that arrived as an opaque string — from a database row
 * or a launch spec read off disk — to one `makePtyId` can use.
 *
 * Throws rather than passing the value through, because `parsePtyId` only
 * recognises registered providers: a pty id built from an unknown one parses
 * back as null, and every hook callback carrying it is then dropped with no
 * indication of why.
 */
export function asPtyProviderId(value: string): AgentProviderId | 'shell' {
  if (value === 'shell' || (AGENT_PROVIDER_IDS as readonly string[]).includes(value)) {
    return value as AgentProviderId | 'shell';
  }
  throw new Error(
    `unknown agent provider '${value}': pty ids built from it cannot be parsed back, ` +
      'so the session would receive no hook events'
  );
}

export function parsePtyId(id: string): {
  providerId: AgentProviderId | 'shell';
  sessionId: string;
} | null {
  // Try 'shell' sentinel first, then all known provider IDs longest-first to avoid prefix collisions.
  const candidates: Array<AgentProviderId | 'shell'> = [
    'shell',
    ...[...AGENT_PROVIDER_IDS].sort((a, b) => b.length - a.length),
  ];
  for (const pid of candidates) {
    const prefix = pid + SESSION_SEP;
    if (id.startsWith(prefix)) {
      return { providerId: pid, sessionId: id.slice(prefix.length) };
    }
  }
  return null;
}

/**
 * Try to parse a legacy PTY ID (pre-refactor format: {prov}-main-{sessionId} or {prov}-chat-{convId}).
 * Used only by TerminalSnapshotService for one-time fallback lookups on existing snapshots.
 */
export function parseLegacyPtyId(id: string): {
  providerId: AgentProviderId;
  kind: 'main' | 'chat';
  suffix: string;
} | null {
  const sorted = [...AGENT_PROVIDER_IDS].sort((a, b) => b.length - a.length);
  for (const pid of sorted) {
    if (id.startsWith(pid + LEGACY_MAIN_SEP)) {
      return {
        providerId: pid,
        kind: 'main',
        suffix: id.slice(pid.length + LEGACY_MAIN_SEP.length),
      };
    }
    if (id.startsWith(pid + LEGACY_CHAT_SEP)) {
      return {
        providerId: pid,
        kind: 'chat',
        suffix: id.slice(pid.length + LEGACY_CHAT_SEP.length),
      };
    }
  }
  return null;
}

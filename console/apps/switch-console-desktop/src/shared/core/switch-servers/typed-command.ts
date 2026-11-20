import type { RemoteBridge } from './switch-servers';

/** How a server predating `RemoteBridge.commands` spelled them. */
const LEGACY: Record<string, Record<string, string>> = {
  telegram: { 'invite-agent': '/invite_agent @{agent}', 'link-account': '/link_account {code}' },
};
const LEGACY_DEFAULT: Record<string, string> = {
  'invite-agent': '!invite-agent @{agent}',
  'link-account': '!link-account {code}',
};

/**
 * The text a person pastes to run `name` on this bridge's platform, as the
 * server spells it, with `{agent}` and `{code}` filled in.
 */
export function typedCommand(
  bridge: Pick<RemoteBridge, 'type' | 'commands'>,
  name: 'invite-agent' | 'link-account',
  values: { agent?: string; code?: string }
): string {
  // Optional-chained: a bridge cached from an older server may not carry it.
  const template = bridge.commands?.[name] ?? LEGACY[bridge.type]?.[name] ?? LEGACY_DEFAULT[name];
  return template
    .replaceAll('{agent}', values.agent ?? 'agent-name')
    .replaceAll('{code}', values.code ?? 'CODE');
}

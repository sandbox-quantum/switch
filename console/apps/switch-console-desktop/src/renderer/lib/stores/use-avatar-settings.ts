import { useQuery } from '@tanstack/react-query';
import { rpc } from '@renderer/lib/ipc';

/** How often a server's setting is read again while something shows it. */
const AVATAR_SETTINGS_REFRESH_MS = 5 * 60_000;

/** Query key for a server's third-party-avatar setting, shared so every
 * surface that asks (the agent avatar, the icon picker, the new-agent form)
 * agrees on one cached answer per server. */
export function avatarSettingsQueryKey(serverId: string | null) {
  return ['avatar-settings', serverId] as const;
}

/**
 * Whether `serverId` allows a third-party avatar URL (DiceBear, ui-avatars.com)
 * to be generated or sent anywhere — the operator's `THIRD_PARTY_AVATARS_ENABLED`
 * setting.
 *
 * `null` while unknown: no server to ask, or the answer has not arrived yet.
 * Callers must treat `null` the same as "disabled" for anything that would
 * send a name off the machine — see `AgentAvatar`, which is the one place that
 * matters most.
 *
 * Asked again every few minutes: the setting changes when the server
 * restarts, which a running Console outlives, so an operator who turns it off
 * reaches this app without anyone restarting it.
 */
export function useThirdPartyAvatarsEnabled(serverId: string | null): boolean | null {
  const { data } = useQuery({
    queryKey: avatarSettingsQueryKey(serverId),
    queryFn: () => rpc.switchServers.avatarSettings(serverId as string),
    enabled: serverId !== null,
    staleTime: AVATAR_SETTINGS_REFRESH_MS,
    refetchInterval: AVATAR_SETTINGS_REFRESH_MS,
  });
  return data?.thirdPartyAvatarsEnabled ?? null;
}

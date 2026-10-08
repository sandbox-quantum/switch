import { useQuery } from '@tanstack/react-query';
import { rpc } from '@renderer/lib/ipc';

/** Query key for a server's third-party-avatar setting, shared so every
 * surface that asks (the agent avatar, the icon picker, the new-agent form)
 * agrees on one cached answer per server for the session. */
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
 * `staleTime: Infinity` because the setting only changes when the Switch
 * server's own process restarts: re-asking on every render would cost a round
 * trip for an answer that cannot change under a running session.
 */
export function useThirdPartyAvatarsEnabled(serverId: string | null): boolean | null {
  const { data } = useQuery({
    queryKey: avatarSettingsQueryKey(serverId),
    queryFn: () => rpc.switchServers.avatarSettings(serverId as string),
    enabled: serverId !== null,
    staleTime: Infinity,
  });
  return data?.thirdPartyAvatarsEnabled ?? null;
}

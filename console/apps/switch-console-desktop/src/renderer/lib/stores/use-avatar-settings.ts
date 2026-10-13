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

/** A server's avatar setting, as the surfaces that draw agents need it. */
export type AvatarSettingsState = {
  /** The server's answer, or `null` while there is none: no server to ask, an
   * answer not in yet, or one that could not be read. */
  thirdPartyAvatarsEnabled: boolean | null;
  /** Why there is no answer, when reading it failed. */
  error: Error | null;
  /** Ask the server again. */
  retry: () => void;
};

/**
 * Whether `serverId` allows a third-party avatar URL (DiceBear, ui-avatars.com)
 * to be generated or sent anywhere — the operator's `THIRD_PARTY_AVATARS_ENABLED`
 * setting.
 *
 * Callers must treat a `null` answer the same as "disabled" for anything that
 * would send a name off the machine — see `AgentAvatar`, which is the one place
 * that matters most. A read that failed is still `null`, and says so in
 * `error`, so a surface can tell "could not ask" from "still asking".
 *
 * Asked again every few minutes: the setting changes when the server
 * restarts, which a running Console outlives, so an operator who turns it off
 * reaches this app without anyone restarting it.
 */
export function useAvatarSettings(serverId: string | null): AvatarSettingsState {
  const { data, error, refetch } = useQuery({
    queryKey: avatarSettingsQueryKey(serverId),
    queryFn: () => rpc.switchServers.avatarSettings(serverId as string),
    enabled: serverId !== null,
    staleTime: AVATAR_SETTINGS_REFRESH_MS,
    refetchInterval: AVATAR_SETTINGS_REFRESH_MS,
  });
  return {
    thirdPartyAvatarsEnabled: data?.thirdPartyAvatarsEnabled ?? null,
    // A failed refetch keeps the last answer, which still stands.
    error: data === undefined ? error : null,
    retry: () => void refetch(),
  };
}

/** {@link useAvatarSettings}, for a caller that needs only the answer. */
export function useThirdPartyAvatarsEnabled(serverId: string | null): boolean | null {
  return useAvatarSettings(serverId).thirdPartyAvatarsEnabled;
}

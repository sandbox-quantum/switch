import { useEffect, useState } from 'react';
import buddyAvatar from '@/assets/images/switch-buddy/avatar.png';
import { useAvatarSettings } from '@renderer/lib/stores/use-avatar-settings';
import { cn } from '@renderer/utils/utils';
import { agentInitials, resolveAgentAvatarSrc } from '@shared/core/agents/agent-avatar';
import { BUDDY_ICON_URL } from '@shared/core/agents/switch-buddy';

/** The image an agent's avatar shows, or null for its initials. */
export function agentAvatarSrc(
  iconUrl: string | null,
  name: string,
  thirdPartyAvatarsEnabled: boolean | null
): string | null {
  // switch-buddy's picture ships with the app: shown from here, it needs no
  // network and no avatar setting.
  if (iconUrl === BUDDY_ICON_URL) return buddyAvatar;
  return resolveAgentAvatarSrc(iconUrl, name, thirdPartyAvatarsEnabled);
}

/**
 * An agent's own picture, at whatever size the surface asks for (CHOO-2171).
 *
 * This is the agent's identity — distinct from `AgentIcon`, which shows the
 * *provider* it runs on. Every surface listing agents uses this one component
 * so the same agent wears the same face everywhere.
 *
 * Generated avatars are drawn by DiceBear from the agent's name, so whether
 * one may be loaded is up to the agent's server (`THIRD_PARTY_AVATARS_ENABLED`).
 * In order:
 *  - the icon its owner chose;
 *  - failing that, on a server that allows it, an avatar drawn from its name,
 *    which is also what the Switch bridges show, so the app and Slack agree;
 *  - otherwise its initials. That covers a server that turns third-party
 *    avatars off, which also withholds a chosen icon on DiceBear or
 *    ui-avatars.com; a server whose answer is not in yet, or no server at all,
 *    so no name leaves the machine before Console knows it may; and an image
 *    that will not load, most often because the machine is offline.
 *    Deliberately visible rather than a blank square or a broken-image glyph:
 *    a missing avatar should read as a missing avatar.
 *
 * A failed load is tried again a few times, further apart each time, before
 * the initials stay: the avatar service refuses a burst of requests (a sidebar
 * of twenty agents asks for twenty at once), and those refusals pass.
 */
export function AgentAvatar({
  name,
  iconUrl,
  serverId,
  size = 16,
  className,
}: {
  name: string;
  /** The agent's chosen icon, or null to draw one from its name — subject to
   * what `serverId` allows. */
  iconUrl: string | null;
  /** The Switch server this agent belongs to, or null when it has none.
   * Required rather than optional: whether a name-seeded avatar may be built
   * at all depends on this server's setting, so a call site cannot skip it
   * without deciding to always fail closed. */
  serverId: string | null;
  /** Rendered size in pixels. Default: 16. */
  size?: number;
  className?: string;
}) {
  const avatarSettings = useAvatarSettings(serverId);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const src = agentAvatarSrc(iconUrl, name, avatarSettings.thirdPartyAvatarsEnabled);
  const [attempt, setAttempt] = useState({ src, count: 0 });
  const tries = attempt.src === src ? attempt.count : 0;

  // After a failed load, try again later; the initials show in the meantime.
  useEffect(() => {
    if (src === null || failedSrc !== src || tries >= RETRY_DELAYS_MS.length) return;
    const delay = RETRY_DELAYS_MS[tries] * (0.75 + Math.random() * 0.5);
    const timer = setTimeout(() => {
      setAttempt({ src, count: tries + 1 });
      setFailedSrc(null);
    }, delay);
    return () => clearTimeout(timer);
  }, [failedSrc, src, tries]);

  const shape = cn('inline-flex shrink-0 items-center justify-center rounded-full', className);

  if (src === null || failedSrc === src) {
    return (
      <span
        className={cn(shape, 'bg-background-tertiary font-medium text-foreground-muted')}
        style={{ width: size, height: size, fontSize: Math.max(8, Math.round(size * 0.4)) }}
        title={
          src === null && avatarSettings.error !== null
            ? `${name} — couldn't read this server's avatar setting`
            : name
        }
      >
        {agentInitials(name)}
      </span>
    );
  }

  return (
    <span className={shape} style={{ width: size, height: size }}>
      <img
        key={tries}
        src={src}
        alt=""
        width={size}
        height={size}
        className="size-full rounded-full object-cover"
        onError={() => setFailedSrc(src)}
      />
    </span>
  );
}

/** How long to wait before each new try of an avatar that did not load. */
const RETRY_DELAYS_MS = [1_500, 5_000, 15_000];

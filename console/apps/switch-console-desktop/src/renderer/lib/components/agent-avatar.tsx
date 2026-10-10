import { useState } from 'react';
import { useThirdPartyAvatarsEnabled } from '@renderer/lib/stores/use-avatar-settings';
import { cn } from '@renderer/utils/utils';
import { agentInitials, resolveAgentAvatarSrc } from '@shared/core/agents/agent-avatar';

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
  const thirdPartyAvatarsEnabled = useThirdPartyAvatarsEnabled(serverId);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const src = resolveAgentAvatarSrc(iconUrl, name, thirdPartyAvatarsEnabled);

  const shape = cn('inline-flex shrink-0 items-center justify-center rounded-full', className);

  if (src === null || failedSrc === src) {
    return (
      <span
        className={cn(shape, 'bg-background-tertiary font-medium text-foreground-muted')}
        style={{ width: size, height: size, fontSize: Math.max(8, Math.round(size * 0.4)) }}
        title={name}
      >
        {agentInitials(name)}
      </span>
    );
  }

  return (
    <span className={shape} style={{ width: size, height: size }}>
      <img
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

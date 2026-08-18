import { useState } from 'react';
import { cn } from '@renderer/utils/utils';
import { agentAvatarUrlForName, agentInitials } from '@shared/core/agents/agent-avatar';

/**
 * An agent's own picture, at whatever size the surface asks for (CHOO-2171).
 *
 * This is the agent's identity — distinct from `AgentIcon`, which shows the
 * *provider* it runs on. Every surface listing agents uses this one component
 * so the same agent wears the same face everywhere.
 *
 * Three states, in order:
 *  - the icon its owner chose;
 *  - failing that, a bot drawn from its name, which is also what the Switch
 *    bridges show, so the app and Slack agree;
 *  - failing *that* — an image that will not load, most often because the
 *    machine is offline — its initials. Deliberately visible rather than a
 *    blank square or a broken-image glyph: a missing avatar should read as a
 *    missing avatar.
 */
export function AgentAvatar({
  name,
  iconUrl,
  size = 16,
  className,
}: {
  name: string;
  /** The agent's chosen icon, or null to draw one from its name. */
  iconUrl: string | null;
  /** Rendered size in pixels. Default: 16. */
  size?: number;
  className?: string;
}) {
  const src = iconUrl ?? agentAvatarUrlForName(name);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  const shape = cn('inline-flex shrink-0 items-center justify-center rounded-full', className);

  if (failedSrc === src) {
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

import { agentInitials, resolveAgentAvatarSrc } from "@switch-console/chat-ui/model/agent-avatar";
import { useState } from "react";

/**
 * An agent's picture, or its initials. A generated avatar, drawn from the
 * agent's name by an outside service, is loaded only where the server allows
 * it (`thirdParty`), as Console and the messaging apps do; until the server
 * says (null), initials.
 */
export default function AgentPicture({
  name,
  iconUrl,
  size,
  thirdParty,
}: {
  name: string;
  iconUrl: string | null;
  size: number;
  thirdParty: boolean | null;
}) {
  const src = resolveAgentAvatarSrc(iconUrl, name, thirdParty);
  const [failed, setFailed] = useState<string | null>(null);
  const shape = "inline-flex shrink-0 items-center justify-center rounded-full";
  if (src === null || failed === src)
    return (
      <span
        className={`${shape} bg-background-2 font-medium text-foreground-muted`}
        style={{ width: size, height: size, fontSize: Math.max(8, Math.round(size * 0.4)) }}
        title={name}
      >
        {agentInitials(name)}
      </span>
    );
  return (
    <span className={shape} style={{ width: size, height: size }}>
      <img
        src={src}
        alt=""
        width={size}
        height={size}
        className="size-full rounded-full object-cover"
        onError={() => setFailed(src)}
      />
    </span>
  );
}

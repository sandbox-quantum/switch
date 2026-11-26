import { ArrowRightLeft, Power, PowerOff } from 'lucide-react';
import { ProfileButton } from './agent-page';

export type AgentProfileActionsProps = {
  desiredState: 'running' | 'stopped';
  busy: boolean;
  onToggleState: () => void;
  /** Null where the agent cannot be moved from here. */
  onMove: (() => void) | null;
};

/**
 * Turning an agent on or off, and moving it to another device. These sit with
 * the agent profile, as they are about the agent itself rather than a specific
 * chat or room.
 */
export function AgentProfileActions({
  desiredState,
  busy,
  onToggleState,
  onMove,
}: AgentProfileActionsProps) {
  const running = desiredState === 'running';
  return (
    <>
      <ProfileButton
        label={running ? 'Turn off agent' : 'Turn on agent'}
        icon={running ? PowerOff : Power}
        disabled={busy}
        onClick={onToggleState}
      />
      {onMove && (
        <ProfileButton
          label="Move to another device…"
          icon={ArrowRightLeft}
          disabled={busy}
          onClick={onMove}
        />
      )}
    </>
  );
}

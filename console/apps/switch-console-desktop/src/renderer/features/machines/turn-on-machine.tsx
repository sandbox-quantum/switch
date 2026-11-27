import { Button } from '@switch-console/chat-ui/primitives/button';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';

/** The server as the person knows it: its name, and its address when that says more. */
export function serverForConsent(server: Pick<SwitchServer, 'name' | 'url'> | null): string {
  if (server === null) return 'this Switch server';
  let host: string | null = null;
  try {
    host = new URL(server.url).host;
  } catch {
    host = null;
  }
  return host && host !== server.name ? `${server.name} (${host})` : server.name;
}

/**
 * What the person agrees to by making a computer a machine of a server's
 * workspace: the server can then run agents there, as them.
 */
export function machineConsent(input: { server: string; label: string; sshHost: string | null }): {
  title: string;
  text: string;
} {
  if (input.sshHost)
    return {
      title: `Make ${input.label} a machine?`,
      text: `Console registers ${input.label} with ${input.server} and starts Switch’s agent controller there. ${input.server} can then start, change and stop agents on ${input.label}, running as your account there.`,
    };
  return {
    title: 'Run managed agents on this computer?',
    text: `Console registers this computer with ${input.server} and starts Switch’s agent controller here, in the background. ${input.server} can then start, change and stop agents on this computer, running as you.`,
  };
}

/**
 * The one way a computer becomes a machine of a server's workspace from
 * Console's pages: a button, then a confirmation saying which server will be
 * able to run agents there. Nothing is turned on until the person confirms.
 */
export const TurnOnMachine = observer(function TurnOnMachine({
  serverId,
  label,
  sshHost,
  buttonLabel,
  busy,
  onConfirm,
}: {
  serverId: string;
  /** The computer as the page names it: "This computer", or the host's name. */
  label: string;
  sshHost: string | null;
  buttonLabel: string;
  busy: boolean;
  onConfirm: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming)
    return (
      <Button
        size="sm"
        variant="outline"
        className="w-fit"
        disabled={busy}
        onClick={() => setConfirming(true)}
      >
        {busy ? 'Turning on…' : buttonLabel}
      </Button>
    );
  return (
    <MachineConsentPrompt
      serverId={serverId}
      label={label}
      sshHost={sshHost}
      confirmLabel="Turn on"
      onCancel={() => setConfirming(false)}
      onConfirm={() => {
        setConfirming(false);
        onConfirm();
      }}
    />
  );
});

/**
 * The confirmation `TurnOnMachine` asks for, for a page that asks it from a
 * button of its own: which server will be able to run agents on the computer,
 * with Cancel and `confirmLabel`.
 */
export const MachineConsentPrompt = observer(function MachineConsentPrompt({
  serverId,
  label,
  sshHost,
  confirmLabel,
  onCancel,
  onConfirm,
}: {
  serverId: string;
  /** The computer as the page names it: "This computer", or the host's name. */
  label: string;
  sshHost: string | null;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const consent = machineConsent({
    server: serverForConsent(switchServersStore.serverById(serverId)),
    label,
    sshHost,
  });
  return (
    <div
      role="group"
      aria-label={consent.title}
      className="flex flex-col gap-2 rounded-md border border-border bg-background p-2 text-xs"
    >
      <p className="font-medium text-foreground">{consent.title}</p>
      <p className="text-foreground-muted">{consent.text}</p>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </div>
  );
});

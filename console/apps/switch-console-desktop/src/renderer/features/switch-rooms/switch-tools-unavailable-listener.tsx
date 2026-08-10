import { useEffect } from 'react';
import { useToast } from '@renderer/lib/hooks/use-toast';
import { events } from '@renderer/lib/ipc';
import { switchToolsUnavailableEvent } from '@shared/events/switchSetupEvents';

const TITLE = 'Session started without Switch tools';

/**
 * Report a session that came up without its Switch MCP tools.
 *
 * The session still starts — that is deliberate — but without this the only
 * evidence was a log line, so it looked like a healthy session that simply had
 * no Switch tools, and the cause was several layers below anything the user
 * could see.
 */
export function SwitchToolsUnavailableListener() {
  const { toast } = useToast();

  useEffect(
    () =>
      events.on(switchToolsUnavailableEvent, ({ reason, detail }) => {
        const fix =
          reason === 'env-shadowed'
            ? 'Unset it in your shell, or give that token the read:packages scope.'
            : 'Fix this under Settings → Agents → Switch setup.';
        toast({ title: TITLE, description: `${detail} ${fix}`, variant: 'destructive' });
      }),
    [toast]
  );

  return null;
}

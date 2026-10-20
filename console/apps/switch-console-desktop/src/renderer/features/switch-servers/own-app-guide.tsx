import { useQuery } from '@tanstack/react-query';
import { CircleCheck, CircleX, ExternalLink } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { openExternalUrl } from '@renderer/lib/open-external';
import { Button } from '@renderer/lib/ui/button';
import { Spinner } from '@renderer/lib/ui/spinner';
import { cn } from '@renderer/utils/utils';

/** The platforms whose own-app setup Console walks through. */
export const GUIDED_PLATFORMS = ['slack'] as const;
export type GuidedPlatform = (typeof GUIDED_PLATFORMS)[number];

export function isGuidedPlatform(key: string | null | undefined): key is GuidedPlatform {
  return GUIDED_PLATFORMS.includes(key as GuidedPlatform);
}

/** The tokens the guide needs, asked for as required whatever the schema says:
 * on a server's own app they are, even where a shared app makes them optional. */
export const GUIDE_REQUIRED_FIELDS: Record<GuidedPlatform, readonly string[]> = {
  slack: ['bot_token', 'app_token'],
};

/** The fields the guide fills in itself, which the form does not ask for. */
export const GUIDE_FILLED_FIELDS: Record<GuidedPlatform, readonly string[]> = {
  slack: ['workspace_id'],
};

/** How long to wait after typing stops before checking a token. */
const CHECK_DELAY_MS = 600;

type Props = {
  workspaceId: string;
  config: Record<string, string | boolean>;
  /** Fill in, or clear with null, a field the guide works out itself. */
  setField: (key: string, value: string | null) => void;
};

/**
 * Creating a Slack app of your own, one step at a time, with the parts Console
 * can do done for you: the app comes pre-filled from this server, the tokens
 * are checked as they are pasted, and the workspace id is read from them
 * rather than copied by hand. Discord has no way to pre-fill an app, so it
 * keeps the setup guide alone.
 */
export function OwnAppGuide(props: Props & { platform: GuidedPlatform }) {
  return <SlackGuide {...props} />;
}

function Step({ n, done, children }: { n: number; done?: boolean; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span
        className={cn(
          'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-medium',
          done ? 'border-transparent bg-foreground-success text-background' : 'border-border'
        )}
      >
        {done ? '✓' : n}
      </span>
      <div className="min-w-0 flex-1 space-y-1.5 text-sm text-foreground">{children}</div>
    </li>
  );
}

function Status({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <p
      className={cn(
        'flex items-start gap-1.5 text-xs',
        ok ? 'text-foreground' : 'text-destructive'
      )}
    >
      {ok ? (
        <CircleCheck className="mt-px size-3.5 shrink-0 text-foreground-success" />
      ) : (
        <CircleX className="mt-px size-3.5 shrink-0" />
      )}
      <span>{children}</span>
    </p>
  );
}

function text(config: Props['config'], key: string): string {
  const value = config[key];
  return typeof value === 'string' ? value.trim() : '';
}

/** `value`, once it has stopped changing for a moment. */
function useSettled<T>(value: T): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), CHECK_DELAY_MS);
    return () => clearTimeout(timer);
  }, [value]);
  return settled;
}

function SlackGuide({ workspaceId, config, setField }: Props) {
  const setup = useQuery({
    queryKey: ['slack-own-app-setup', workspaceId],
    queryFn: () => rpc.workspaces.slackOwnAppSetup(workspaceId),
  });
  const botToken = useSettled(text(config, 'bot_token'));
  const appToken = useSettled(text(config, 'app_token'));
  const ready = botToken.length > 0 && appToken.length > 0;
  const check = useQuery({
    queryKey: ['slack-own-app-check', workspaceId, botToken, appToken],
    queryFn: () => rpc.workspaces.checkSlackTokens({ workspaceId, botToken, appToken }),
    enabled: ready,
    retry: false,
    gcTime: 0,
  });

  useEffect(() => {
    setField('workspace_id', check.data?.workspaceId ?? null);
  }, [check.data, setField]);

  return (
    <ol className="space-y-3 rounded-lg border border-border bg-background-1 p-3">
      <Step n={1} done={!!check.data}>
        <p>Create the app in Slack. It opens already set up for this server.</p>
        <Button
          size="sm"
          variant="outline"
          disabled={!setup.data}
          onClick={() =>
            setup.data && void openExternalUrl(setup.data.createUrl, 'Could not open Slack')
          }
        >
          {setup.isPending && <Spinner className="size-3.5" />}
          Create the Slack app
          <ExternalLink className="size-3.5" />
        </Button>
        <p className="text-xs text-foreground-muted">
          Pick your workspace, click Next, then Create.
        </p>
        {setup.isError && (
          <Status ok={false}>{failureText(setup.error, 'Could not prepare the Slack app.')}</Status>
        )}
      </Step>
      <Step n={2} done={!!check.data}>
        <p>
          In Slack, open <b>Install App</b>, click <b>Install to your workspace</b> and allow it.
          Copy the <b>Bot User OAuth Token</b> (xoxb-…) into <b>Bot token</b> below.
        </p>
      </Step>
      <Step n={3} done={!!check.data}>
        <p>
          Open <b>Basic Information</b>, and under <b>App-Level Tokens</b> click{' '}
          <b>Generate Token and Scopes</b>. Add the <b>connections:write</b> scope, generate, and
          copy the token (xapp-…) into <b>App-level token</b> below.
        </p>
      </Step>
      {ready && check.isFetching && (
        <p className="flex items-center gap-1.5 text-xs text-foreground-muted">
          <Spinner className="size-3" /> Checking the tokens with Slack…
        </p>
      )}
      {ready && check.data && !check.isFetching && (
        <Status ok>
          Both tokens work, for the <b>{check.data.workspaceName}</b> workspace.
        </Status>
      )}
      {ready && check.isError && !check.isFetching && (
        <Status ok={false}>{failureText(check.error, 'Could not check the tokens.')}</Status>
      )}
    </ol>
  );
}

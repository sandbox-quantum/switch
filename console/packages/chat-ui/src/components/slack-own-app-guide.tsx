import { useQuery } from '@tanstack/react-query';
import { Check, CircleCheck, CircleX, Copy, ExternalLink } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import type {
  BridgeConfigField,
  SlackOwnAppSetup,
  SlackTokensChecked,
} from '../contracts/switch-servers';
import { cn } from '../model/cn';
import { Button } from '../primitives/button';
import { Field, FieldLabel } from '../primitives/field';
import { Input } from '../primitives/input';
import { Spinner } from '../primitives/spinner';

/** How long to wait after typing stops before checking a token. */
const CHECK_DELAY_MS = 600;

/** The pictures of Slack's pages the steps point at. */
export type SlackSetupShot = 'install-app' | 'app-level-tokens';

/** What the app showing the guide provides: how it reaches the server, opens links and draws the pictures. */
export type SlackGuideHost = {
  /** Keeps one workspace's lookups apart from another's. */
  scope: string;
  /** "this server": who the app comes set up for. */
  thisServer: string;
  setup: () => Promise<SlackOwnAppSetup>;
  /** Whether the tokens work. A refusal throws with the server's sentence. */
  checkTokens: (tokens: { botToken: string; appToken: string }) => Promise<SlackTokensChecked>;
  docsUrl: string;
  openExternal: (url: string, failureTitle: string) => Promise<boolean>;
  describeError: (error: unknown, fallback: string) => string;
  renderShot: (shot: SlackSetupShot, alt: string) => ReactNode;
};

export type SlackOwnAppGuideProps = {
  config: Record<string, string | boolean>;
  /** The platform's own description of the fields the guide asks for. */
  fields: readonly BridgeConfigField[];
  /** Fill in, or clear with null, a field the guide works out itself. */
  setField: (key: string, value: string | null) => void;
  /** Set, or clear with null, a field the person types into the guide. */
  setInput: (key: string, value: string | null) => void;
};

function Step({
  n,
  title,
  done,
  children,
}: {
  n: number;
  title: string;
  done?: boolean;
  children: ReactNode;
}) {
  return (
    <li className="flex gap-3 border-b border-border py-4 first:pt-0 last:border-b-0 last:pb-0">
      <span
        className={cn(
          'mt-px flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-medium',
          done ? 'bg-foreground-success text-background' : 'bg-foreground text-background'
        )}
        role="img"
        aria-label={done ? `Step ${n}, done` : `Step ${n}`}
      >
        {done ? '✓' : n}
      </span>
      <div className="min-w-0 flex-1 space-y-2 text-sm text-foreground">
        <p className="font-semibold">{title}</p>
        {children}
      </div>
    </li>
  );
}

/** A step's instructions and the field they lead to, above a picture of the Slack page they describe. */
function WithShot({ shot, children }: { shot: ReactNode; children: ReactNode }) {
  return (
    <div className="space-y-3">
      <div className="min-w-0 space-y-3">{children}</div>
      {shot}
    </div>
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

function text(config: SlackOwnAppGuideProps['config'], key: string): string {
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

/**
 * For when Slack's create page does not take the app from the link: its newer
 * "Create new app" screen sometimes opens on its list of choices, and its
 * Create button can do nothing until the page is reloaded without the link's
 * query. Pasting the manifest by hand makes the same app.
 */
function ManifestFallback({
  manifestJson,
  openExternal,
}: {
  manifestJson: string;
  openExternal: SlackGuideHost['openExternal'];
}) {
  const [copied, setCopied] = useState<'yes' | 'failed' | null>(null);
  useEffect(() => {
    if (copied !== 'yes') return;
    const timer = setTimeout(() => setCopied(null), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <div className="space-y-1.5 rounded-lg bg-background-2 p-2.5 text-xs text-foreground-muted">
      <p>
        If Slack shows <b>Create new app</b> with a list of choices instead, or its button does
        nothing: go to{' '}
        <button
          type="button"
          className="underline underline-offset-2 hover:text-foreground"
          onClick={() => void openExternal('https://api.slack.com/apps', 'Could not open Slack')}
        >
          api.slack.com/apps
        </button>
        , click <b>Create New App</b>, choose <b>Paste a manifest</b> (on Slack&apos;s older screen,{' '}
        <b>From an app manifest</b>), pick your workspace, and paste this app&apos;s manifest.
      </p>
      <p>
        If your workspace has guests, delete the <code>agent_view</code> block before pasting. It
        declares the app an Agent, which blocks guests from it and can&apos;t be undone; Switch
        doesn&apos;t use it.
      </p>
      <Button
        size="sm"
        variant="outline"
        onClick={() =>
          void navigator.clipboard.writeText(manifestJson).then(
            () => setCopied('yes'),
            () => setCopied('failed')
          )
        }
      >
        {copied === 'yes' ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        {copied === 'yes' ? 'Copied' : 'Copy the manifest'}
      </Button>
      {copied === 'failed' && (
        <Status ok={false}>Could not copy. Copy it from the box below instead.</Status>
      )}
      {copied === 'failed' && (
        <textarea
          readOnly
          className="h-32 w-full rounded border border-border bg-background p-2 font-mono text-[11px]"
          value={manifestJson}
          onFocus={(e) => e.target.select()}
        />
      )}
    </div>
  );
}

/** One of the tokens, asked for where the step says to copy it from. */
function TokenField({
  fieldKey,
  fallbackLabel,
  config,
  fields,
  setInput,
}: {
  fieldKey: string;
  fallbackLabel: string;
} & Pick<SlackOwnAppGuideProps, 'config' | 'fields' | 'setInput'>) {
  const field = fields.find((f) => f.key === fieldKey);
  const value = config[fieldKey];
  const inputId = `own-app-${fieldKey}`;
  return (
    <Field>
      <FieldLabel htmlFor={inputId}>{field?.label ?? fallbackLabel}</FieldLabel>
      <Input
        id={inputId}
        // Masked, so a token is not left readable on screen while the rest of
        // the form is checked.
        type="password"
        autoComplete="new-password"
        spellCheck={false}
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => setInput(fieldKey, e.target.value === '' ? null : e.target.value)}
      />
      {field?.description && (
        <p className="mt-1 text-xs text-foreground-muted">{field.description}</p>
      )}
    </Field>
  );
}

/**
 * Creating a Slack app of your own, one step at a time, with the parts that
 * can be done for the person done: the app comes pre-filled from this server,
 * each token is asked for in the step that says where to find it, the tokens
 * are checked as they are pasted, and the workspace id is read from them
 * rather than copied by hand.
 */
export function SlackOwnAppGuide({
  host,
  config,
  fields,
  setField,
  setInput,
}: SlackOwnAppGuideProps & { host: SlackGuideHost }) {
  const { openExternal, describeError } = host;
  const setup = useQuery({
    queryKey: ['slack-own-app-setup', host.scope],
    queryFn: host.setup,
  });
  const botToken = useSettled(text(config, 'bot_token'));
  const appToken = useSettled(text(config, 'app_token'));
  const ready = botToken.length > 0 && appToken.length > 0;
  const check = useQuery({
    queryKey: ['slack-own-app-check', host.scope, botToken, appToken],
    queryFn: () => host.checkTokens({ botToken, appToken }),
    enabled: ready,
    retry: false,
    gcTime: 0,
  });

  useEffect(() => {
    setField('workspace_id', check.data?.workspaceId ?? null);
  }, [check.data, setField]);

  const works = !!check.data;
  const tokenProps = { config, fields, setInput };
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm text-foreground-muted">Slack app setup</h3>
        <button
          type="button"
          className="flex items-center gap-1 text-xs text-foreground-muted underline underline-offset-2 hover:text-foreground"
          onClick={() => void openExternal(host.docsUrl, 'Could not open the setup guide')}
        >
          How to set up Slack
          <ExternalLink className="size-3" />
        </button>
      </div>
      <ol className="rounded-xl border border-border bg-background-1 p-4">
        <Step n={1} title="Create a new Slack app" done={works}>
          <p>Create the app in Slack. It opens already set up for {host.thisServer}.</p>
          <Button
            size="sm"
            variant="outline"
            disabled={!setup.data}
            onClick={() =>
              setup.data && void openExternal(setup.data.createUrl, 'Could not open Slack')
            }
          >
            {setup.isPending && <Spinner className="size-3.5" />}
            Create the Slack app
            <ExternalLink className="size-3.5" />
          </Button>
          <p className="text-xs text-foreground-muted">
            Pick your workspace, click <b>Next</b>, then <b>Create</b>.
          </p>
          {setup.data?.manifestJson && (
            <ManifestFallback manifestJson={setup.data.manifestJson} openExternal={openExternal} />
          )}
          {setup.isError && (
            <Status ok={false}>
              {describeError(setup.error, 'Could not prepare the Slack app.')}
            </Status>
          )}
        </Step>
        <Step n={2} title="Install the app and copy the bot token" done={works}>
          <WithShot
            shot={host.renderShot('install-app', "The Install App page of a Slack app's settings")}
          >
            <ol className="list-decimal space-y-1 pl-5">
              <li>
                In your new app&apos;s settings, open <b>Install App</b>.
              </li>
              <li>
                Click <b>Install to your workspace</b> and allow it.
              </li>
              <li>
                Copy the <b>Bot User OAuth Token</b> (xoxb-…) and paste it below.
              </li>
            </ol>
            <TokenField fieldKey="bot_token" fallbackLabel="Bot token" {...tokenProps} />
          </WithShot>
        </Step>
        <Step n={3} title="Generate the app-level token" done={works}>
          <WithShot
            shot={host.renderShot(
              'app-level-tokens',
              "The App-Level Tokens section of a Slack app's Basic Information page"
            )}
          >
            <ol className="list-decimal space-y-1 pl-5">
              <li>
                Open <b>Basic Information</b>.
              </li>
              <li>
                Under <b>App-Level Tokens</b>, click <b>Generate Token and Scopes</b>.
              </li>
              <li>
                Name the token, click <b>Add Scope</b>, pick <b>connections:write</b>, then{' '}
                <b>Generate</b>.
              </li>
              <li>Copy the token (xapp-…) and paste it below.</li>
            </ol>
            <TokenField fieldKey="app_token" fallbackLabel="App-level token" {...tokenProps} />
          </WithShot>
        </Step>
      </ol>
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
        <Status ok={false}>{describeError(check.error, 'Could not check the tokens.')}</Status>
      )}
    </section>
  );
}

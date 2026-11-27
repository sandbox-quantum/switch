import { useMutation } from '@tanstack/react-query';
import { CircleAlert, CircleCheck, Copy, ExternalLink } from 'lucide-react';
import { useState } from 'react';
import type { BrowserSignInState } from '../contracts/machine-logins';
import { browserCodePrompt } from '../model/provider-catalogue';
import { Button, buttonVariants } from '../primitives/button';
import { Input } from '../primitives/input';
import { Spinner } from '../primitives/spinner';

/**
 * A browser sign-in running on a machine, as its owner follows it: the
 * machine starting it, then a button opening the sign-in page in a new tab,
 * with the code to type there or a field for the code the page shows, and
 * how it ended. The app reads the state and sends the code.
 */
export function BrowserSignInPanel({
  machineName,
  provider,
  providerName,
  state,
  sendCode,
  failureText,
}: {
  machineName: string;
  provider: string;
  providerName: string;
  state: BrowserSignInState;
  sendCode: (code: string) => Promise<void>;
  failureText: (error: unknown, fallback: string) => string;
}) {
  const [code, setCode] = useState('');
  const [copied, setCopied] = useState(false);
  const sending = useMutation({ mutationFn: sendCode, onSuccess: () => setCode('') });

  if (state.state === 'starting')
    return (
      <p className="flex items-center gap-2 text-xs text-foreground-muted" role="status">
        <Spinner className="size-3.5" />
        Starting sign-in on {machineName}…
      </p>
    );
  if (state.state === 'succeeded')
    return (
      <p className="flex items-center gap-2 text-xs" role="status">
        <CircleCheck className="size-3.5 text-emerald-500" />
        Signed in: {providerName} signs in on {machineName}.
      </p>
    );
  if (state.state === 'failed')
    return (
      <p className="flex items-start gap-2 text-xs whitespace-pre-line" role="alert">
        <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
        {state.message}
      </p>
    );

  const waitingForCode = state.needsCode && !sending.isSuccess;
  return (
    <div className="space-y-3">
      <a
        className={buttonVariants({ variant: 'outline', size: 'sm' })}
        href={state.url}
        target="_blank"
        rel="noopener noreferrer"
      >
        <ExternalLink className="size-3.5" />
        Open sign-in page
      </a>
      {state.userCode && (
        <div className="space-y-1">
          <p className="text-xs text-foreground-muted">Enter this code on the page:</p>
          <div className="flex items-center gap-2">
            <code className="rounded bg-background-2 px-2 py-1 font-mono text-sm tracking-wider">
              {state.userCode}
            </code>
            <Button
              variant="ghost"
              size="sm"
              aria-label="Copy the code"
              onClick={() => {
                void navigator.clipboard.writeText(state.userCode!).then(() => setCopied(true));
              }}
            >
              <Copy className="size-3.5" />
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        </div>
      )}
      {waitingForCode ? (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (code.trim()) sending.mutate(code.trim());
          }}
        >
          <p className="w-full text-xs text-foreground-muted">{browserCodePrompt(provider)}</p>
          <Input
            value={code}
            onChange={(event) => setCode(event.target.value)}
            placeholder="Paste the code here"
            aria-label="Sign-in code"
            autoComplete="off"
            spellCheck={false}
            className="h-8 flex-1 font-mono"
            disabled={sending.isPending}
          />
          <Button type="submit" size="sm" disabled={!code.trim() || sending.isPending}>
            {sending.isPending && <Spinner className="size-3.5" />}
            Send code
          </Button>
        </form>
      ) : (
        <p className="flex items-center gap-2 text-xs text-foreground-muted" role="status">
          <Spinner className="size-3.5" />
          {sending.isSuccess
            ? `Checking the code on ${machineName}…`
            : `Waiting for you to finish signing in on the page…`}
        </p>
      )}
      {sending.error && (
        <p className="flex items-start gap-2 text-xs" role="alert">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
          {failureText(sending.error, 'The code could not be sent. Start the sign-in again.')}
        </p>
      )}
    </div>
  );
}

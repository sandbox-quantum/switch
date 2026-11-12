import { Copy } from 'lucide-react';
import { useState } from 'react';
import { bridgePlatformLabel } from '@renderer/lib/components/bridge-platform';
import { Button } from '@renderer/lib/ui/button';
import { Input } from '@renderer/lib/ui/input';

/**
 * Shown straight after connecting a platform that delivers its events to an
 * address of the connection's own. Nothing arrives until someone gives the
 * platform that address, so this is the moment to hand it over — not a menu
 * they would have to know to look in afterwards.
 */
export function WebhookAddressStep({
  platform,
  webhookUrl,
  setupValues,
}: {
  platform: string;
  webhookUrl: string | null;
  setupValues?: Record<string, string>;
}) {
  const label = bridgePlatformLabel(platform);
  const [copied, setCopied] = useState<string | null>(null);

  const copy = async (value: string, key: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
    } catch {
      setCopied('failed');
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {webhookUrl === null ? (
        <p className="text-xs text-destructive">
          {label} is connected, but it delivers events to a public address and this server has none
          configured, so no message from {label} can reach Switch yet. Set MESSAGING_PUBLIC_URL on
          the server; the address then appears in this connection&apos;s menu.
        </p>
      ) : (
        <>
          <p className="text-sm">
            {label} is connected. Give {label} this address so its messages reach Switch — the
            platform&apos;s setup guide says where it goes.
          </p>
          <div className="flex items-center gap-2">
            <Input readOnly value={webhookUrl} spellCheck={false} className="font-mono text-xs" />
            <Button variant="outline" size="sm" onClick={() => void copy(webhookUrl, 'address')}>
              <Copy className="size-3" />
              {copied === 'address' ? 'Copied' : 'Copy'}
            </Button>
          </div>
          <p className="text-xs text-foreground-muted">
            You can copy it again later from this connection&apos;s menu.
          </p>
        </>
      )}
      {setupValues && Object.keys(setupValues).length > 0 && (
        <div className="flex flex-col gap-3">
          <p className="text-sm">
            Save these connection secrets in your app now. They are shown only once; reconnect if
            you lose them.
          </p>
          {Object.entries(setupValues).map(([name, value]) => (
            <div key={name} className="flex flex-col gap-1 text-xs">
              <label htmlFor={`webhook-setup-${name}`}>{name.replaceAll('_', ' ')}</label>
              <Input
                id={`webhook-setup-${name}`}
                type="password"
                readOnly
                value={value}
                spellCheck={false}
                autoComplete="off"
                className="font-mono text-xs"
              />
              <Button variant="outline" size="sm" onClick={() => void copy(value, name)}>
                <Copy className="size-3" />
                {copied === name ? 'Copied' : `Copy ${name.replaceAll('_', ' ')}`}
              </Button>
            </div>
          ))}
        </div>
      )}
      {copied === 'failed' && (
        <p className="text-xs text-destructive">
          Could not copy; select the value and copy it manually.
        </p>
      )}
    </div>
  );
}

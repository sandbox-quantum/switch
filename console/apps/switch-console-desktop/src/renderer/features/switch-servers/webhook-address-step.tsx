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
}: {
  platform: string;
  webhookUrl: string | null;
}) {
  const label = bridgePlatformLabel(platform);
  const [copied, setCopied] = useState<'yes' | 'failed' | null>(null);

  if (webhookUrl === null) {
    return (
      <p className="text-xs text-destructive">
        {label} is connected, but it delivers events to a public address and this server has none
        configured, so no message from {label} can reach Switch yet. Set MESSAGING_PUBLIC_URL on the
        server; the address then appears in this connection&apos;s menu.
      </p>
    );
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(webhookUrl);
      setCopied('yes');
    } catch {
      setCopied('failed');
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm">
        {label} is connected. Give {label} this address so its messages reach Switch — the
        platform&apos;s setup guide says where it goes.
      </p>
      <div className="flex items-center gap-2">
        <Input readOnly value={webhookUrl} spellCheck={false} className="font-mono text-xs" />
        <Button variant="outline" size="sm" onClick={() => void copy()}>
          <Copy className="size-3" />
          {copied === 'yes' ? 'Copied' : 'Copy'}
        </Button>
      </div>
      {copied === 'failed' && (
        <p className="text-xs text-destructive">Could not copy it; select the address instead.</p>
      )}
      <p className="text-xs text-foreground-muted">
        You can copy it again later from this connection&apos;s menu.
      </p>
    </div>
  );
}

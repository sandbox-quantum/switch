import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@renderer/lib/ui/button';

/** Copies `value`, and says so for two seconds. */
export function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label={copied ? 'Copied' : `Copy ${value}`}
      title={copied ? 'Copied' : 'Copy'}
      onClick={() =>
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        })
      }
    >
      {copied ? (
        <Check className="size-3.5 text-foreground-success" />
      ) : (
        <Copy className="size-3.5" />
      )}
    </Button>
  );
}

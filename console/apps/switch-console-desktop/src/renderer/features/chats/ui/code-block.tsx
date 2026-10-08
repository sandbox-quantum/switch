import { CheckIcon, CopyIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { toast } from 'sonner';
import { describeFailure } from '@renderer/lib/errors/describe-failure';
import { useTheme } from '@renderer/lib/hooks/useTheme';
import { Button } from '@renderer/lib/ui/button';
import { cn } from '@renderer/utils/utils';

const COPIED_RESET_MS = 1600;

/**
 * A fenced code block with a copy button. Highlighting reuses the Prism build the
 * markdown renderer already ships rather than a second highlighter.
 */
export function CodeBlock({
  code,
  language,
  className,
}: {
  code: string;
  language?: string;
  className?: string;
}) {
  const { effectiveTheme } = useTheme();
  const isDark = effectiveTheme === 'emdark';

  return (
    <div
      data-slot="code-block"
      className={cn(
        'group/code-block relative w-full overflow-hidden rounded-md border border-border bg-background-1 text-foreground',
        className
      )}
    >
      <div className="flex h-8 items-center justify-between border-b border-border pr-1 pl-3">
        <span className="font-mono text-tiny text-foreground-passive">{language || 'text'}</span>
        <CodeBlockCopyButton code={code} />
      </div>
      <SyntaxHighlighter
        style={isDark ? oneDark : oneLight}
        language={language || 'text'}
        PreTag="div"
        customStyle={{ margin: 0, background: 'transparent', padding: '0.75rem' }}
        codeTagProps={{ className: 'font-mono text-xs' }}
      >
        {code}
      </SyntaxHighlighter>
    </div>
  );
}

function CodeBlockCopyButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const resetRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (resetRef.current !== null) window.clearTimeout(resetRef.current);
    },
    []
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
    } catch (error) {
      const { headline, detail } = describeFailure(error, 'Could not copy the code');
      toast.error(headline, { description: detail ?? undefined });
      return;
    }
    setCopied(true);
    if (resetRef.current !== null) window.clearTimeout(resetRef.current);
    resetRef.current = window.setTimeout(() => {
      setCopied(false);
      resetRef.current = null;
    }, COPIED_RESET_MS);
  };

  const Icon = copied ? CheckIcon : CopyIcon;
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label={copied ? 'Copied' : 'Copy code'}
      title={copied ? 'Copied' : 'Copy code'}
      onClick={() => void copy()}
    >
      <Icon />
    </Button>
  );
}

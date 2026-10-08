import type { Item } from '@switch-console/shared/session-v1';
import { useState } from 'react';
import { cn } from '@renderer/utils/utils';
import type { ToolDetail } from '@shared/core/sessions/reasoning';
import type { ToolState } from '../activity-join';
import {
  presentTool,
  shortPath,
  type ToolDetailView,
  type ToolPresentation,
} from '../tool-presentation';
import { ToolKindIcon, WorkLogDetails, WorkLogNote, WorkLogPre, WorkLogRow } from '../ui/work-log';

function Label({ presentation }: { presentation: ToolPresentation }) {
  const { verb, subject, code, kind } = presentation;
  if (!subject) return <>{verb}</>;
  const shown = kind === 'read' || kind === 'edit' ? shortPath(subject) : subject;
  return (
    <>
      {verb}{' '}
      {code ? (
        <code className="rounded bg-background-2 px-1 py-px font-mono text-xs text-foreground-muted">
          {shown}
        </code>
      ) : (
        <span className="text-foreground-muted">{shown}</span>
      )}
    </>
  );
}

function resultCount(output: string | null): number | null {
  if (!output) return null;
  return output.split('\n').filter((line) => line.trim().length > 0).length;
}

function Details({ view }: { view: ToolDetailView }) {
  switch (view.kind) {
    case 'command':
      return (
        <>
          <WorkLogPre>
            <span className="text-foreground">$ {view.command}</span>
            {view.output ? `\n${view.output}` : ''}
          </WorkLogPre>
          {view.exitCode !== null && view.exitCode !== 0 && (
            <WorkLogNote tone="failed">Exit code {view.exitCode}</WorkLogNote>
          )}
        </>
      );
    case 'read':
      return (
        <>
          {view.path && <WorkLogNote>{view.path}</WorkLogNote>}
          {view.output && <WorkLogPre>{view.output}</WorkLogPre>}
        </>
      );
    case 'diff':
      return (
        <>
          {view.path && <WorkLogNote>{view.path}</WorkLogNote>}
          <WorkLogPre className="px-0">
            {view.lines.map((line, index) => (
              <span
                key={index}
                className={cn(
                  'block px-2.5',
                  line.sign === '+' && 'bg-background-success/60 text-foreground-success',
                  line.sign === '-' && 'bg-background-error/60 text-foreground-error'
                )}
              >
                {line.sign === ' ' ? '  ' : `${line.sign} `}
                {line.text}
              </span>
            ))}
          </WorkLogPre>
        </>
      );
    case 'search': {
      const count = resultCount(view.output);
      return (
        <>
          <WorkLogNote>
            {view.query ? `Pattern: ${view.query}` : 'Search'}
            {view.scope ? ` in ${view.scope}` : ''}
            {count !== null ? ` · ${count} ${count === 1 ? 'result' : 'results'}` : ''}
          </WorkLogNote>
          {view.output && <WorkLogPre>{view.output}</WorkLogPre>}
        </>
      );
    }
    case 'web':
      return (
        <>
          {view.target && <WorkLogNote>{view.target}</WorkLogNote>}
          {view.output && <WorkLogPre>{view.output}</WorkLogPre>}
        </>
      );
    case 'generic':
      return (
        <>
          {view.input && (
            <>
              <WorkLogNote>Input</WorkLogNote>
              <WorkLogPre>{view.input}</WorkLogPre>
            </>
          )}
          {view.output && (
            <>
              <WorkLogNote>Output</WorkLogNote>
              <WorkLogPre>{view.output}</WorkLogPre>
            </>
          )}
        </>
      );
  }
}

/**
 * One tool call as a work-log line. Running shimmers, failed is tinted red
 * and says so, done carries no mark at all. It opens only when the session
 * host gave it something to show.
 */
export function ToolRow({
  item,
  state,
  detail,
}: {
  item: Item;
  state: ToolState;
  detail: ToolDetail | null;
}) {
  const [open, setOpen] = useState(false);
  const presentation = presentTool(item, detail);
  const { details, truncated } = presentation;
  const failed = state === 'failed';
  return (
    <WorkLogRow
      icon={<ToolKindIcon kind={presentation.kind} />}
      label={<Label presentation={presentation} />}
      title={presentation.subject ?? undefined}
      tone={failed ? 'failed' : state === 'declined' ? 'passive' : 'default'}
      active={state === 'running'}
      trailing={
        failed ? (
          <span className="shrink-0 text-xs text-foreground-destructive">Failed</span>
        ) : state === 'declined' ? (
          <span className="shrink-0 text-xs text-foreground-passive">Declined</span>
        ) : null
      }
      {...(details ? { open, onToggle: () => setOpen(!open) } : {})}
    >
      {details && open && (
        <WorkLogDetails>
          <Details view={details} />
          {truncated && <WorkLogNote>Long values were clipped.</WorkLogNote>}
        </WorkLogDetails>
      )}
    </WorkLogRow>
  );
}

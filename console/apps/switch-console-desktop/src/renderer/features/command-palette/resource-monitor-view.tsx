import { Activity, ArrowLeft, Check, Copy } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { appState } from '@renderer/lib/stores/app-state';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { formatBytes } from '@renderer/utils/formatBytes';
import type { ResourceAppProcess, ResourceSnapshot } from '@shared/resource-monitor';
import { appProcessLabel, formatReport, sortAppProcesses } from './resource-monitor-utils';

export const ResourceMonitorView = observer(function ResourceMonitorView({
  onBack,
}: {
  onBack: () => void;
}) {
  const store = appState.resourceMonitor;
  const snapshot = store.snapshot;
  const memLabel = formatBytes(store.totalMemoryBytes);
  const cpuLabel = `${store.totalCpuPercent.toFixed(1)}%`;

  const processes = useMemo(() => sortAppProcesses(snapshot?.appProcesses ?? []), [snapshot]);

  const hasProcesses = processes.length > 0;

  return (
    <>
      <div className="flex items-center gap-2 border-b border-foreground/10 px-2 py-2">
        <button
          onClick={onBack}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-foreground/50 transition-colors hover:bg-background-2 hover:text-foreground"
          aria-label="Back to search"
        >
          <ArrowLeft size={14} />
        </button>
        <Activity size={13} className="shrink-0 text-foreground/50" />
        <span className="text-sm font-medium tracking-tight">Resource Monitor</span>
        <div className="ml-auto flex items-center gap-3 text-xs tabular-nums">
          <Stat label="CPU" value={cpuLabel} />
          <Stat label="Mem" value={memLabel} />
          <CopyReportButton snapshot={snapshot} />
        </div>
      </div>

      <div className="max-h-[24rem] min-h-[14rem] overflow-y-auto px-1.5 py-1.5">
        {hasProcesses && (
          <Section heading="Application">
            <div className="flex flex-col">
              {processes.map((p) => (
                <ProcessRow key={p.pid} process={p} cpuCount={snapshot?.cpuCount} />
              ))}
            </div>
          </Section>
        )}

        <p className="px-2 py-3 text-xs text-foreground/50">
          SDK host resources are managed on the execution machine.
        </p>
      </div>
    </>
  );
});

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span>
      <span className="text-foreground/40">{label} </span>
      <span className="font-medium text-foreground">{value}</span>
    </span>
  );
}

function Section({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <div className="flex flex-col">
      <div className="px-2 pt-2 pb-0.5 text-[10px] font-medium tracking-wider text-foreground/40 uppercase">
        {heading}
      </div>
      {children}
    </div>
  );
}

function ProcessRow({ process, cpuCount }: { process: ResourceAppProcess; cpuCount?: number }) {
  const label = appProcessLabel(process.type, process.name);
  const cpu = cpuCount ? process.cpu / cpuCount : process.cpu;
  return (
    <div
      className="grid grid-cols-[1fr_3rem_4rem] items-center gap-2 rounded-md px-2 py-1 text-xs text-foreground-muted hover:bg-background-2"
      title={`pid ${process.pid}`}
    >
      <span className="truncate">{label}</span>
      <span className="text-right text-foreground/50 tabular-nums">{cpu.toFixed(1)}%</span>
      <span className="text-right text-foreground/50 tabular-nums">
        {formatBytes(process.memory)}
      </span>
    </div>
  );
}

function CopyReportButton({ snapshot }: { snapshot: ResourceSnapshot | null }) {
  const [copied, setCopied] = useState(false);
  const resetRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (resetRef.current !== null) window.clearTimeout(resetRef.current);
    };
  }, []);

  const handleCopy = useCallback(async () => {
    if (!snapshot || typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(formatReport(snapshot));
      setCopied(true);
      if (resetRef.current !== null) window.clearTimeout(resetRef.current);
      resetRef.current = window.setTimeout(() => {
        setCopied(false);
        resetRef.current = null;
      }, 1500);
    } catch {
      setCopied(false);
    }
  }, [snapshot]);

  return (
    <Tooltip>
      <TooltipTrigger>
        <button
          disabled={!snapshot}
          onClick={handleCopy}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-foreground/50 transition-colors hover:bg-background-2 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
          aria-label="Copy report"
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </button>
      </TooltipTrigger>
      <TooltipContent>{copied ? 'Copied' : 'Copy report'}</TooltipContent>
    </Tooltip>
  );
}

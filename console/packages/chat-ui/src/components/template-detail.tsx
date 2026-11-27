import { ArrowLeft, Bot, CircleAlert, DoorOpen, Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';
import type { TemplateKind } from '../model/template-filters';
import { Alert, AlertDescription } from '../primitives/alert';
import { Badge } from '../primitives/badge';
import { Button } from '../primitives/button';
import { DisclosureRow } from '../primitives/disclosure-row';
import { PageHeader } from '../primitives/page-header';
import { KIND_LABEL } from './template-card';

/** One thing a template creates, as its page lists it. */
export type TemplateCreation = { kind: 'room' | 'agent'; name: string; description: string };

function BackToTemplates({ onBack }: { onBack: () => void }) {
  return (
    <Button size="sm" variant="ghost" className="-ml-2" onClick={onBack}>
      <ArrowLeft className="size-4" /> All templates
    </Button>
  );
}

/** The scrolling column a template's page sits in. */
export function TemplateDetailFrame({ children }: { children: ReactNode }) {
  return (
    <div className="relative z-10 flex min-h-0 flex-1 flex-col overflow-auto bg-background">
      <div className="mx-auto w-full max-w-[820px] space-y-7 px-8 pb-10">{children}</div>
    </div>
  );
}

export function TemplateDetailLoading() {
  return (
    <div className="flex flex-1 items-center justify-center">
      <Loader2 className="size-5 animate-spin text-foreground-muted" />
    </div>
  );
}

/** A template's page when the template could not be read: why, and the way back. */
export function TemplateDetailError({ error, onBack }: { error: string; onBack: () => void }) {
  return (
    <div className="relative z-10 flex min-h-0 flex-1 flex-col overflow-auto bg-background">
      <div className="space-y-6 px-8 pb-10">
        <PageHeader sticky title="Template" back={<BackToTemplates onBack={onBack} />} />
        <p className="text-sm text-destructive">{error}</p>
      </div>
    </div>
  );
}

export function TemplateDetailHeader({
  name,
  description,
  ownerLine,
  accessLine,
  version,
  kind,
  official,
  onBack,
  actions,
}: {
  name: string;
  description: string;
  /** Whose it is, such as "Yours" or "Comes with Switch". */
  ownerLine: string;
  /** Who may see and change it. */
  accessLine: string;
  version: number;
  kind: TemplateKind;
  official: boolean;
  onBack: () => void;
  /** The buttons at the end of the badges' row. */
  actions: ReactNode;
}) {
  return (
    <PageHeader
      sticky
      title={name}
      description={
        <span className="flex flex-col gap-1.5">
          <span>{description || 'No description.'}</span>
          <span className="flex items-center gap-2 text-xs text-foreground-passive">
            <span>{ownerLine}</span>
            <span>·</span>
            <span>{accessLine}</span>
            {version > 1 && (
              <>
                <span>·</span>
                <span>Version {version}</span>
              </>
            )}
          </span>
        </span>
      }
      back={<BackToTemplates onBack={onBack} />}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary">{KIND_LABEL[kind]}</Badge>
        {official && (
          <Badge variant="outline" title="Comes with Switch">
            Official
          </Badge>
        )}
        <span className="flex-1" />
        {actions}
      </div>
    </PageHeader>
  );
}

/** Why a template cannot be used, and who can put it right. */
export function TemplateProblem({ problem, canFix }: { problem: string; canFix: boolean }) {
  return (
    <Alert variant="destructive">
      <CircleAlert />
      <AlertDescription>
        This template cannot be used. {problem}{' '}
        {canFix ? 'Edit it to fix the document, or remove it.' : 'Ask whoever saved it to fix it.'}
      </AlertDescription>
    </Alert>
  );
}

export function FactRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3 text-sm">
      <span className="w-28 shrink-0 text-foreground-muted">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/**
 * What the template creates, one row each, then `children`: facts about it
 * beneath the rows. With `creates` null the page knows only `summary`, a line
 * such as how many of each it creates.
 */
export function TemplateCreates({
  creates,
  summary,
  children,
}: {
  creates: readonly TemplateCreation[] | null;
  summary: string | null;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2.5">
      <h2 className="text-sm font-semibold text-foreground">What it creates</h2>
      {creates && creates.length > 0 ? (
        <div className="flex flex-col divide-y divide-border overflow-hidden rounded-[11px] border border-border bg-background-1">
          {creates.map((c, i) => {
            const Icon = c.kind === 'room' ? DoorOpen : Bot;
            return (
              <div key={i} className="flex items-center gap-3 px-3.5 py-3">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-lg bg-background-2 text-foreground-muted">
                  <Icon className="size-3.5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-[13px] font-medium">{c.name}</div>
                  <div className="mt-0.5 text-xs leading-snug text-foreground-muted">
                    {c.description}
                  </div>
                </div>
                <span className="shrink-0 text-[11px] text-foreground-passive">
                  {c.kind === 'room' ? 'Room' : 'Agent'}
                </span>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="text-sm text-foreground-muted">
          {summary ?? 'Nothing yet: the document is empty.'}
        </p>
      )}
      {children}
    </section>
  );
}

/** The document, folded away until asked for, under a bar naming its file. */
export function TemplateDocument({
  open,
  onToggle,
  fileName,
  note,
  actions,
  document,
}: {
  open: boolean;
  onToggle: () => void;
  fileName: string;
  /** Where the text comes from, such as "Stored exactly as uploaded". */
  note: string;
  /** Buttons on the bar, such as Copy. */
  actions: ReactNode;
  document: string;
}) {
  return (
    <section className="flex flex-col gap-2.5">
      <DisclosureRow
        open={open}
        title={open ? 'Hide the document' : 'Show the document'}
        onToggle={onToggle}
      />
      {open && (
        <div className="overflow-hidden rounded-[11px] border border-border bg-background-1">
          <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-[11.5px] text-foreground-passive">
            <span className="min-w-0 flex-1 truncate font-mono">{fileName}</span>
            <span className="shrink-0">{note}</span>
            {actions}
          </div>
          <pre className="overflow-x-auto p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-foreground-muted">
            {document}
          </pre>
        </div>
      )}
    </section>
  );
}

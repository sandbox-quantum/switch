import type { Command, Session } from '@switch-console/shared/session-v1';
import { Brain, ChevronDown, Cpu, Minimize2, RotateCcw, SlidersHorizontal } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@renderer/lib/ui/button';
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from '@renderer/lib/ui/combobox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@renderer/lib/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@renderer/lib/ui/popover';

const controlClass = 'h-7 gap-1.5 rounded-md px-2 text-xs font-normal text-foreground-muted';
const optionLabel = (value: string) =>
  value === 'xhigh' ? 'Extra high' : value.charAt(0).toUpperCase() + value.slice(1);

export function SessionV1Controls({
  session,
  disabled,
  execute,
}: {
  session: Session;
  disabled: boolean;
  execute: (body: Command['body']) => Promise<void>;
}) {
  const [confirmReset, setConfirmReset] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const models = session.models ?? [];
  const model = models.find((entry) => entry.id === session.model?.id);
  const options = session.model?.options ?? {};
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      <Combobox
        items={models}
        value={model ?? null}
        itemToStringLabel={(entry) => entry.label}
        isItemEqualToValue={(a, b) => a.id === b.id}
        onValueChange={(next) => {
          if (!disabled && next && next.id !== session.model?.id) {
            void execute({ type: 'session.model.set', modelId: next.id, options: {} });
          }
        }}
      >
        <ComboboxTrigger
          render={<Button variant="ghost" size="sm" />}
          className={controlClass}
          disabled={disabled || !session.capabilities.modelChange || !models.length}
          aria-label="Session model"
          title={
            session.capabilities.modelChange
              ? 'Choose a model for the next turn'
              : 'Model changes are unavailable for this session'
          }
        >
          <Cpu className="size-3.5 shrink-0" />
          <span className="max-w-44 truncate">
            {model?.label ?? session.model?.id ?? 'Provider default'}
          </span>
          <ChevronDown className="size-3 shrink-0" />
        </ComboboxTrigger>
        <ComboboxContent side="top" align="start" className="w-72">
          <ComboboxInput
            aria-label="Search models"
            placeholder="Search models…"
            showTrigger={false}
          />
          <ComboboxEmpty>No matching models</ComboboxEmpty>
          <ComboboxList>
            {(entry: (typeof models)[number]) => (
              <ComboboxItem key={entry.id} value={entry} disabled={disabled}>
                <div className="min-w-0">
                  <div className="truncate">{entry.label}</div>
                  {entry.imageInput === false && (
                    <div className="text-xs text-foreground-muted">Text and files · No images</div>
                  )}
                </div>
              </ComboboxItem>
            )}
          </ComboboxList>
          <p className="border-t border-border px-3 py-2 text-xs text-foreground-muted">
            {session.provider} · Applies to the next turn
          </p>
        </ComboboxContent>
      </Combobox>
      {Object.entries(model?.options ?? {}).map(([key, values]) => {
        const label = key === 'effort' ? 'Reasoning effort' : optionLabel(key);
        const defaultLabel =
          session.provider === 'codex' && key === 'effort'
            ? 'Keep current effort'
            : 'Provider default';
        return (
          <DropdownMenu key={key}>
            <DropdownMenuTrigger
              render={<Button variant="ghost" size="sm" />}
              className={controlClass}
              disabled={disabled || !session.capabilities.modelChange}
              aria-label={`Model ${key}`}
              title={label}
            >
              <Brain className="size-3.5" />
              {options[key] ? optionLabel(options[key]) : defaultLabel}
              <ChevronDown className="size-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start">
              <p className="px-2 py-1.5 text-xs text-foreground-muted">{label}</p>
              <DropdownMenuRadioGroup
                value={options[key] ?? ''}
                onValueChange={(value) => {
                  if (disabled || value === (options[key] ?? '')) return;
                  const next = { ...options };
                  if (value) next[key] = value;
                  else delete next[key];
                  void execute({ type: 'session.model.set', modelId: model!.id, options: next });
                }}
              >
                <DropdownMenuRadioItem value="">{defaultLabel}</DropdownMenuRadioItem>
                {values.map((value) => (
                  <DropdownMenuRadioItem key={value} value={value}>
                    {optionLabel(value)}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        );
      })}
      <Popover
        open={contextOpen}
        onOpenChange={(open) => {
          setContextOpen(open);
          setConfirmReset(false);
        }}
      >
        <PopoverTrigger
          render={<Button variant="ghost" size="sm" />}
          className={controlClass}
          aria-label="Context actions"
        >
          <SlidersHorizontal className="size-3.5" />
          Context
          <ChevronDown className="size-3" />
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          className="w-80 max-w-[calc(100vw-2rem)] gap-2 p-3"
        >
          <PopoverTitle>
            {confirmReset ? 'Start a fresh conversation?' : 'Conversation context'}
          </PopoverTitle>
          {confirmReset ? (
            <>
              <p className="text-xs text-foreground-muted">
                The agent starts with a fresh context. Earlier messages stay in the transcript as
                history.
              </p>
              <div className="flex justify-end gap-2 pt-2">
                <Button size="sm" variant="ghost" onClick={() => setConfirmReset(false)}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  disabled={disabled || !session.capabilities.reset}
                  onClick={() => {
                    setContextOpen(false);
                    setConfirmReset(false);
                    void execute({ type: 'session.reset' });
                  }}
                >
                  Start fresh
                </Button>
              </div>
            </>
          ) : (
            <>
              <Button
                variant="ghost"
                disabled={disabled || !session.capabilities.compact}
                className="h-auto justify-start gap-3 px-2 py-2 text-left"
                onClick={() => {
                  setContextOpen(false);
                  void execute({ type: 'session.compact' });
                }}
              >
                <Minimize2 className="size-4 shrink-0" />
                <span>
                  <span className="block">Compact context</span>
                  <span className="block text-xs font-normal text-foreground-muted">
                    {session.capabilities.compact
                      ? 'Free up space in this conversation'
                      : 'Native compaction is unavailable'}
                  </span>
                </span>
              </Button>
              <Button
                variant="ghost"
                disabled={disabled || !session.capabilities.reset}
                className="h-auto justify-start gap-3 px-2 py-2 text-left"
                onClick={() => setConfirmReset(true)}
              >
                <RotateCcw className="size-4 shrink-0" />
                <span>
                  <span className="block">Reset context…</span>
                  <span className="block text-xs font-normal text-foreground-muted">
                    {session.capabilities.reset
                      ? 'Start fresh and keep transcript history'
                      : 'Reset is unavailable for this session'}
                  </span>
                </span>
              </Button>
              {disabled && (
                <p className="text-xs text-foreground-muted">
                  Context changes need a connected, idle session with no pending requests or
                  commands.
                </p>
              )}
              <p className="border-t border-border pt-2 text-xs text-foreground-muted">
                Skills and MCP load from the execution host. Restart the host while idle after
                changing their configuration.
              </p>
            </>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}

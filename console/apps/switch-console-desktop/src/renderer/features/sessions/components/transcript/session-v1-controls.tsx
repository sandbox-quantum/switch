import type { Command, Session } from '@switch-console/shared/session-v1';
import { useState } from 'react';
import { Button } from '@renderer/lib/ui/button';

export function SessionV1Controls({
  session,
  disabled,
  execute,
}: {
  session: Session;
  disabled: boolean;
  execute: (body: Command['body']) => Promise<void>;
}) {
  const [modelId, setModelId] = useState(session.model?.id ?? '');
  const [options, setOptions] = useState<Record<string, string>>(session.model?.options ?? {});
  const [confirmReset, setConfirmReset] = useState(false);
  const model = session.models?.find((entry) => entry.id === modelId);
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-2 text-xs">
      {session.capabilities.modelChange ? (
        <>
          <label className="flex items-center gap-2">
            Model
            <select
              aria-label="Session model"
              className="rounded border border-border bg-background px-2 py-1"
              value={modelId}
              disabled={disabled}
              onChange={(event) => {
                setModelId(event.target.value);
                setOptions({});
              }}
            >
              <option value="">Provider default</option>
              {session.models?.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                  {entry.imageInput === false ? ' (no images)' : ''}
                </option>
              ))}
            </select>
          </label>
          {Object.entries(model?.options ?? {}).map(([key, values]) => (
            <label key={key} className="flex items-center gap-2">
              {key}
              <select
                aria-label={`Model ${key}`}
                className="rounded border border-border bg-background px-2 py-1"
                value={options[key] ?? ''}
                disabled={disabled}
                onChange={(event) =>
                  setOptions((prior) => {
                    const next = { ...prior };
                    if (event.target.value) next[key] = event.target.value;
                    else delete next[key];
                    return next;
                  })
                }
              >
                <option value="">
                  {session.provider === 'codex' && key === 'effort'
                    ? 'Keep current effort'
                    : 'Provider default'}
                </option>
                {values.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
          ))}
          <Button
            size="sm"
            variant="outline"
            disabled={disabled || !model}
            onClick={() => void execute({ type: 'session.model.set', modelId, options })}
          >
            Apply model
          </Button>
        </>
      ) : (
        <span className="text-foreground-muted">
          Model changes are unavailable for this session.
        </span>
      )}
      {session.capabilities.reset && (
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => setConfirmReset(true)}
        >
          Reset context
        </Button>
      )}
      {session.capabilities.compact ? (
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => void execute({ type: 'session.compact' })}
        >
          Compact context
        </Button>
      ) : (
        <span className="text-foreground-muted">
          Native compaction is unavailable for this session.
        </span>
      )}
      <p className="w-full text-foreground-muted">
        Model changes apply to the next turn. Skills and MCP load from the execution host. After
        changing their configuration, restart the host while the session is idle.
      </p>
      {confirmReset && (
        <div role="alert" className="flex w-full items-center gap-2">
          <span>
            Start a fresh conversation? Earlier messages stay in the transcript as history.
          </span>
          <Button
            size="sm"
            disabled={disabled}
            onClick={() => {
              setConfirmReset(false);
              void execute({ type: 'session.reset' });
            }}
          >
            Start fresh
          </Button>
          <Button size="sm" variant="outline" onClick={() => setConfirmReset(false)}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}

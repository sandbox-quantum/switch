import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, RefreshCw } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useMemo, useState } from 'react';
import {
  advancedFields,
  attributesFromForm,
  DefinitionFieldInput,
  emptyForm,
  formFromAttributes,
  type FormState,
  type FormValue,
} from '@renderer/features/locations/components/agent-definition-fields';
import {
  fieldCatalogueState,
  fieldWithCatalogue,
  type ModelCatalogueResult,
} from '@renderer/features/locations/components/agent-model-catalogue';
import { getSessionManagerStore } from '@renderer/features/sessions/stores/session-selectors';
import { isProvisioned } from '@renderer/features/sessions/stores/session-store';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { DisclosureRow } from '@renderer/lib/ui/disclosure-row';
import { Field, FieldDescription, FieldLabel } from '@renderer/lib/ui/field';
import { log } from '@renderer/utils/logger';
import { cn } from '@renderer/utils/utils';

/**
 * Per-agent "Advanced configuration" in the Settings tab: the model, reasoning
 * effort, tools and system prompt for an existing agent.
 *
 * Providers keep these in different places — Claude Code in the repo-agent
 * definition it launches by name, Codex in the profile it loads at startup —
 * but they are the same settings collected as the same fields, so this is one
 * section for both. The main process routes the read and the write to whichever
 * surface the provider actually uses (`agent-advanced-config.ts`); the agent
 * name is immutable either way, so only advanced attributes are editable here
 * (CHOO-1440, CHOO-1985).
 */
export const AgentAdvancedSettingsSection = observer(function AgentAdvancedSettingsSection({
  locationId,
  agentId,
}: {
  locationId: string;
  agentId: string | undefined;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);

  const { data: agents } = useQuery({
    queryKey: ['location-agents', locationId],
    queryFn: () => rpc.agents.getAgents(locationId),
  });
  const agent = (agents ?? []).find((a) => a.id === agentId);
  const providerId = agent?.providerId ?? null;
  const editable = !!agent;

  const { data: allFields } = useQuery({
    queryKey: ['agentAdvancedFields', providerId],
    queryFn: () => (providerId ? rpc.agents.advancedFields({ providerId }) : Promise.resolve([])),
    enabled: !!providerId,
  });
  const fields = useMemo(() => advancedFields(allFields ?? []), [allFields]);

  // Where the provider keeps these settings, which decides whether a running
  // session can be brought onto them. Asked of the provider rather than inferred
  // from its id.
  const { data: surface } = useQuery({
    queryKey: ['agentAdvancedSurface', providerId],
    queryFn: () =>
      providerId ? rpc.agents.advancedSurface({ providerId }) : Promise.resolve('none' as const),
    enabled: !!providerId,
  });

  const { data: locations } = useQuery({
    queryKey: ['locations'],
    queryFn: () => rpc.locations.getLocations(),
  });
  const location = (locations ?? []).find((l) => l.id === locationId);

  // What the agent's own host offers, for the fields bound to it. Fetched per
  // host rather than per keystroke: it shells out to the provider CLI, over SSH
  // for a remote agent.
  const { data: catalogue } = useQuery({
    queryKey: ['agent-model-catalogue', providerId, location?.sshHost ?? 'local', location?.dir],
    queryFn: (): Promise<ModelCatalogueResult> =>
      providerId && location
        ? rpc.agents.modelCatalogue({ providerId, sshHost: location.sshHost, dir: location.dir })
        : Promise.resolve({ kind: 'unavailable', reason: 'No host to ask.' }),
    enabled: !!providerId && !!location && editable,
    staleTime: 60_000,
  });

  const { data: current } = useQuery({
    queryKey: ['agent-advanced-config', agentId],
    queryFn: () => (agentId ? rpc.agents.readAdvancedConfig({ agentId }) : Promise.resolve(null)),
    enabled: !!agentId && editable,
  });

  const savedForm = useMemo(
    () => (current ? formFromAttributes(fields, current) : emptyForm(fields)),
    [fields, current]
  );

  const [form, setForm] = useState<FormState>({});
  // Seed (and re-seed after save/agent change) from the persisted values. During
  // editing no refetch fires, so local edits are preserved until Save.
  useEffect(() => {
    setForm(savedForm);
  }, [savedForm]);

  const staleSessionIds = sessionsStartedBeforeChanges(locationId, agentId);

  const save = useMutation({
    mutationFn: () =>
      rpc.agents.updateAdvancedConfig({
        agentId: agentId as string,
        attributes: attributesFromForm(fields, form),
      }),
    onSuccess: () => {
      toast({ title: 'Advanced configuration saved' });
      void queryClient.invalidateQueries({ queryKey: ['agent-advanced-config', agentId] });
      void queryClient.invalidateQueries({ queryKey: ['location-agents', locationId] });
    },
    onError: (error) => {
      log.error('Failed to save agent advanced configuration', { agentId, error });
      toast({
        title: 'Failed to save configuration',
        description: String(error),
        variant: 'destructive',
      });
      // A save can fail after the row was written — pushing the change to a
      // remote host is a separate step that can fail on its own. Re-read rather
      // than leave the form showing values that are no longer what is stored.
      void queryClient.invalidateQueries({ queryKey: ['agent-advanced-config', agentId] });
      void queryClient.invalidateQueries({ queryKey: ['location-agents', locationId] });
    },
  });

  // The Settings page swaps agents in place rather than remounting, so a save on
  // the previous agent must not leave its restart notice over the next one.
  const resetSave = save.reset;
  useEffect(() => {
    resetSave();
  }, [agentId, resetSave]);

  const [restartFailed, setRestartFailed] = useState<string[]>([]);
  const restart = useMutation({
    mutationFn: async () => {
      // Restart the ones that have not already been restarted: a retry after a
      // partial failure must not kill and respawn the sessions that succeeded.
      const targets = restartFailed.length > 0 ? restartFailed : staleSessionIds;
      const results = await Promise.allSettled(
        targets.map((sessionId) => rpc.sessions.restartAgent(sessionId))
      );
      const failed = targets.filter((_, i) => results[i]?.status === 'rejected');
      setRestartFailed(failed);
      if (failed.length > 0) {
        const reasons = results
          .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
          .map((r) => String(r.reason));
        throw new Error(`${failed.length} of ${targets.length} failed — ${reasons.join('; ')}`);
      }
    },
    onSuccess: () => {
      toast({ title: 'Session restarted on the new configuration' });
      // Everything running now carries the saved values.
      save.reset();
    },
    onError: (error) => {
      log.error('Failed to restart a session after an advanced configuration change', {
        agentId,
        error,
      });
      toast({
        title: 'Failed to restart the session',
        description: String(error),
        variant: 'destructive',
      });
    },
  });

  if (!editable || fields.length === 0) return null;

  const dirty =
    JSON.stringify(attributesFromForm(fields, form)) !==
    JSON.stringify(attributesFromForm(fields, savedForm));

  const setField = (key: string, value: FormValue) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  // A launch profile is read once, when the session starts, so a change cannot
  // reach a running session without one — and a resume carries the new profile,
  // which is what makes the restart safe to offer. A repo-agent definition
  // (Claude) reads at launch too and very likely wants the same treatment, but
  // that is a change to Claude's behaviour and is being raised on its own.
  const restartable = surface === 'launch-profile';
  const showStaleNotice = restartable && staleSessionIds.length > 0 && (dirty || save.isSuccess);

  return (
    <div>
      <DisclosureRow
        open={open}
        title="Advanced configuration"
        summary={summariseValues(fields, savedForm)}
        meta={`${fields.length} ${fields.length === 1 ? 'setting' : 'settings'}`}
        onToggle={() => setOpen((v) => !v)}
      />
      <div className={cn('flex flex-col gap-4 pt-3', !open && 'hidden')}>
        <FieldDescription className="text-foreground-muted">
          The agent&apos;s model, reasoning effort, tools, and system prompt. The agent name is
          fixed.
        </FieldDescription>
        {fields.map((field) => {
          const catalogueState = fieldCatalogueState(field, form, catalogue);
          const rendered = fieldWithCatalogue(field, catalogueState);
          return (
            <Field key={field.key}>
              <FieldLabel htmlFor={`agent-advanced-${field.key}`}>
                {field.label}
                {field.required || field.type === 'boolean' ? '' : ' (optional)'}
              </FieldLabel>
              <DefinitionFieldInput
                field={rendered}
                value={form[field.key] ?? (field.type === 'boolean' ? false : '')}
                disabled={catalogueState.disabled}
                suggestions={catalogueState.suggestions}
                onChange={(value) => setField(field.key, value)}
              />
              {field.help && (
                <FieldDescription className="text-foreground-muted">{field.help}</FieldDescription>
              )}
              {catalogueState.note && (
                <FieldDescription
                  className={
                    catalogueState.warning ? 'text-foreground-warning' : 'text-foreground-muted'
                  }
                >
                  {catalogueState.note}
                </FieldDescription>
              )}
            </Field>
          );
        })}
        <div className="flex justify-end">
          <Button
            type="button"
            size="sm"
            disabled={!dirty || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? 'Saving...' : 'Save'}
          </Button>
        </div>

        {showStaleNotice && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
            <p className="text-xs text-foreground-muted">
              {staleSessionIds.length === 1
                ? 'A session is running'
                : `${staleSessionIds.length} sessions are running`}{' '}
              on the previous configuration — it is read only when a session starts.{' '}
              {dirty
                ? 'Save, then Restart to apply it now.'
                : 'It applies to the next session — or use Restart to apply it now (the conversation is resumed).'}
            </p>
            <Button
              size="sm"
              variant="outline"
              disabled={dirty || restart.isPending}
              onClick={() => restart.mutate()}
            >
              {restart.isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
              {restartFailed.length > 0 ? 'Retry restart' : 'Restart'}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
});

/**
 * What the section is holding, read off the saved values rather than the form —
 * a collapsed row has to say what is set without being opened, and the form may
 * be mid-edit.
 *
 * Values, not labels: "claude-opus-4-6 · high" reads as configuration where
 * "Model claude-opus-4-6 · Reasoning effort high" reads as a table of contents.
 */
function summariseValues(fields: { key: string; label: string }[], saved: FormState): string {
  const set = fields
    .map((field) => {
      const value = saved[field.key];
      if (value === true) return field.label.toLowerCase();
      if (typeof value === 'string' && value.trim().length > 0) return value.trim();
      return null;
    })
    .filter((v): v is string => v !== null);

  if (set.length === 0) return 'defaults';
  const shown = set.slice(0, 2).join(' · ');
  return set.length > 2 ? `${shown} · +${set.length - 2}` : shown;
}

/**
 * The agent's sessions that already started a conversation, and so are running
 * on whatever configuration was in place at the time.
 *
 * `providerSessionId` is the test rather than "is provisioned": a remote session
 * is provisioned at creation so it can carry room traffic, but its agent process
 * is only launched when the terminal is first opened. Counting those would claim
 * a running session that does not exist — and restarting one cannot resume a
 * conversation that never started. Read from the session store rather than
 * queried, so it tracks sessions coming and going; call only from an `observer`.
 */
function sessionsStartedBeforeChanges(locationId: string, agentId: string | undefined): string[] {
  const manager = getSessionManagerStore(locationId);
  if (!manager || !agentId) return [];
  return [...manager.sessions.values()]
    .filter(
      (session) =>
        isProvisioned(session) &&
        session.data.agentId === agentId &&
        !!session.data.providerSessionId
    )
    .map((session) => session.data.id);
}

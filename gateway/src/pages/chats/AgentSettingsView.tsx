import "@switch-console/chat-ui/theme.css";
import type { ManagedAgentDefinition, ManagedAgentView } from "@switch-console/chat-ui/client/agents-client";
import {
  AdvancedConfigDisclosure,
  summariseValues,
} from "@switch-console/chat-ui/components/advanced-config-disclosure";
import { SectionLabel } from "@switch-console/chat-ui/components/agent-page-section";
import {
  CanManageAgentsSetting,
  MidTurnDeliverySetting,
} from "@switch-console/chat-ui/components/agent-permissions";
import { AgentSettingsPage, UnsavedChangesBar } from "@switch-console/chat-ui/components/agent-settings-page";
import {
  AdvancedFieldInput,
  MODEL_FIELD,
  type NewAgentAdvancedField,
  advancedConfigOf,
} from "@switch-console/chat-ui/components/new-agent-dialog";
import { AgentAvatar } from "@switch-console/chat-ui/host";
import { failureText } from "@switch-console/chat-ui/model/failures";
import { Badge } from "@switch-console/chat-ui/primitives/badge";
import { Button } from "@switch-console/chat-ui/primitives/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@switch-console/chat-ui/primitives/dialog";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useBlocker, useNavigate } from "react-router";
import { useAuth } from "../../data/AuthContext";
import {
  type AgentDetail,
  deleteAgent,
  fetchAgent,
  updateAgentCanManageAgents,
  updateAgentDescription,
  updateAgentDisplayName,
  updateAgentMidTurnDelivery,
} from "../../data/api";
import { fetchProviders, providerAutoModeUnreviewed, providerHasAutoMode } from "../../data/management";
import { agentsClient } from "../../data/useManagedAgent";
import AddressingPolicySection from "../agents/AddressingPolicySection";
import ServiceAccessSection from "../agents/ServiceAccessSection";
import { providerReport, useOwnDevices } from "../ai-providers/DeviceProviders";

const serverId = "web";

type FormValue = string | boolean;

/** What the page edits, as it is saved. */
type Draft = {
  displayName: string;
  description: string;
  instructions: string;
  autoMode: boolean;
  autoApprove: boolean;
  directory: string;
  isolation: "shared" | "isolated";
  /** The model and the provider's advanced configuration, as their inputs hold them. */
  form: Record<string, FormValue>;
};

type Edits = { values: Partial<Omit<Draft, "form">>; form: Record<string, FormValue> };
const NO_EDITS: Edits = { values: {}, form: {} };

function formOf(definition: ManagedAgentDefinition, fields: NewAgentAdvancedField[]): Record<string, FormValue> {
  const form: Record<string, FormValue> = { [MODEL_FIELD.key]: definition.model ?? "" };
  for (const field of fields) {
    const value = definition.advanced_config[field.key];
    if (field.type === "boolean") form[field.key] = value === true;
    else if (Array.isArray(value)) form[field.key] = value.join(", ");
    else form[field.key] = value === undefined || value === null ? "" : String(value);
  }
  return form;
}

function draftOf(agent: AgentDetail, managed: ManagedAgentView | null, fields: NewAgentAdvancedField[]): Draft {
  const definition = managed?.definition;
  return {
    displayName: agent.display_name ?? "",
    description: agent.description,
    instructions: definition?.instructions ?? "",
    autoMode: definition?.auto_mode ?? false,
    autoApprove: definition?.auto_approve ?? false,
    directory: definition?.directory ?? "",
    isolation: definition?.isolation ?? "shared",
    form: definition ? formOf(definition, fields) : {},
  };
}

/** What changed in the definition, as the management route takes it: only the fields that did. */
function definitionChanges(
  definition: ManagedAgentDefinition,
  fields: NewAgentAdvancedField[],
  saved: Draft,
  draft: Draft,
): Partial<ManagedAgentDefinition> {
  const changes: Partial<ManagedAgentDefinition> = {};
  if (draft.instructions !== saved.instructions) changes.instructions = draft.instructions;
  if (draft.autoMode !== saved.autoMode) changes.auto_mode = draft.autoMode;
  if (draft.autoApprove !== saved.autoApprove) changes.auto_approve = draft.autoApprove;
  if (draft.isolation !== saved.isolation) changes.isolation = draft.isolation;
  const directory = draft.directory.trim() || null;
  if (directory !== (definition.directory ?? null)) changes.directory = directory;
  const model = String(draft.form[MODEL_FIELD.key] ?? "").trim() || null;
  if (model !== (definition.model ?? null)) changes.model = model;
  const advanced = advancedConfigOf(fields, draft.form);
  if (JSON.stringify(advanced) !== JSON.stringify(advancedConfigOf(fields, saved.form))) {
    // Settings the provider no longer describes are kept rather than dropped.
    const known = new Set(fields.map((field) => field.key));
    const kept = Object.fromEntries(
      Object.entries(definition.advanced_config).filter(([key]) => !known.has(key)),
    );
    changes.advanced_config = { ...kept, ...advanced };
  }
  return changes;
}

/** A change the server holds, saved as it is made, with why it was refused. */
function useSaveNow(onSaved: () => Promise<unknown>) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (save: () => Promise<unknown>, fallback: string) => {
    setPending(true);
    setError(null);
    try {
      await save();
      await onSaved();
    } catch (failure) {
      setError(failureText(failure, fallback));
    } finally {
      setPending(false);
    }
  };
  return { pending, error, run };
}

function ConfirmChoice({
  open,
  title,
  description,
  cancelLabel,
  confirmLabel,
  destructive,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description: string;
  cancelLabel: string;
  confirmLabel: string;
  destructive: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button variant={destructive ? "destructive" : "default"} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PageMessage({ children }: { children: React.ReactNode }) {
  return <p className="px-8 py-10 text-sm text-foreground-muted">{children}</p>;
}

/**
 * An agent's settings, as Switch Console's agent page draws them: who it is,
 * and for an agent Switch runs on one of the person's devices its
 * instructions, permissions, where it runs and its advanced configuration,
 * all saved together from the bar that appears with the first change. The
 * rows Switch holds (who can talk to it, steering, managing agents) save as
 * they change. Someone who may not change the agent sees it read-only.
 */
export function AgentSettingsView({
  agentId,
  managedAgent,
  onManagedChanged,
  onMove,
}: {
  agentId: string;
  /** The definition Switch runs it with, when the person owns it and Switch runs it; null otherwise. */
  managedAgent: ManagedAgentView | null;
  onManagedChanged: () => Promise<unknown>;
  /** Opens the move dialog; null where the agent cannot be moved from here. */
  onMove: (() => void) | null;
}) {
  const agentQuery = useQuery({
    queryKey: ["agent-settings", agentId],
    queryFn: async () => {
      const found = await fetchAgent(agentId);
      if (!found) throw new Error("Agent not found");
      return found;
    },
  });
  const agent = agentQuery.data;

  if (agentQuery.isPending) return <PageMessage>Loading…</PageMessage>;
  if (!agent)
    return (
      <p role="alert" className="px-8 py-10 text-sm text-foreground-destructive">
        {failureText(agentQuery.error, "The agent could not be read.")}
      </p>
    );
  return (
    <AgentSettings
      key={agent.id}
      agent={agent}
      managed={managedAgent?.can_edit ? managedAgent : null}
      refetchAgent={agentQuery.refetch}
      onManagedChanged={onManagedChanged}
      onMove={onMove}
    />
  );
}

function AgentSettings({
  agent,
  managed,
  refetchAgent,
  onManagedChanged,
  onMove,
}: {
  agent: AgentDetail;
  managed: ManagedAgentView | null;
  refetchAgent: () => Promise<unknown>;
  onManagedChanged: () => Promise<unknown>;
  onMove: (() => void) | null;
}) {
  const navigate = useNavigate();
  const { capabilities } = useAuth();
  const canEdit = agent.can_manage;
  const providers = useQuery({ queryKey: ["ai-providers", "list"], queryFn: fetchProviders, enabled: managed !== null });
  const devices = useOwnDevices();
  const provider = managed ? (providers.data?.find((each) => each.id === managed.definition.provider) ?? null) : null;
  const providerFields = useMemo(() => provider?.advanced_fields ?? [], [provider]);
  const fields = useMemo(() => [MODEL_FIELD, ...providerFields], [providerFields]);

  const saved = useMemo(() => draftOf(agent, managed, providerFields), [agent, managed, providerFields]);
  const [edits, setEdits] = useState<Edits>(NO_EDITS);
  const draft: Draft = { ...saved, ...edits.values, form: { ...saved.form, ...edits.form } };
  const changes = managed ? definitionChanges(managed.definition, providerFields, saved, draft) : {};
  const displayNameChanged = draft.displayName.trim() !== saved.displayName;
  const descriptionChanged = draft.description.trim() !== saved.description;
  const dirty = Object.keys(changes).length > 0 || displayNameChanged || descriptionChanged;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const setValue = <K extends keyof Edits["values"]>(key: K, value: Draft[K]) =>
    setEdits((current) => ({ ...current, values: { ...current.values, [key]: value } }));

  const reload = () => Promise.all([refetchAgent(), managed ? onManagedChanged() : null]);
  const saveNow = useSaveNow(refetchAgent);

  const save = async () => {
    setError(null);
    if (!draft.description.trim()) {
      setError("Give the agent a description before saving: it is how people and agents know what it is for.");
      return;
    }
    setSaving(true);
    const done: string[] = [];
    try {
      if (Object.keys(changes).length > 0) {
        // Switch takes the whole definition, so the changes go onto the one it holds now.
        const current = await agentsClient.getManagedAgent(agent.id);
        await agentsClient.updateManagedAgent(agent.id, { definition: { ...current.definition, ...changes } });
        done.push("its settings");
      }
      if (displayNameChanged) {
        await updateAgentDisplayName(agent.id, draft.displayName.trim() || null);
        done.push("its display name");
      }
      if (descriptionChanged) {
        await updateAgentDescription(agent.id, draft.description.trim());
        done.push("its description");
      }
      await reload();
      setEdits(NO_EDITS);
    } catch (failure) {
      setError(
        done.length === 0
          ? failureText(failure, "The changes could not be saved. Nothing changed.")
          : `Saved ${done.join(" and ")}, but not the rest: ${failureText(failure, "Switch refused it.")}`,
      );
      if (done.length > 0) await reload();
    } finally {
      setSaving(false);
    }
  };
  const discard = () => {
    setEdits(NO_EDITS);
    setError(null);
  };

  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty &&
      (currentLocation.pathname !== nextLocation.pathname || currentLocation.search !== nextLocation.search),
  );
  useEffect(() => {
    if (!dirty) return;
    const refuseUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", refuseUnload);
    return () => window.removeEventListener("beforeunload", refuseUnload);
  }, [dirty]);

  const remove = async () => {
    setDeleting(true);
    setError(null);
    try {
      await deleteAgent(agent.id);
      setConfirmingDelete(false);
      navigate("/agents");
    } catch (failure) {
      setConfirmingDelete(false);
      setError(failureText(failure, `${agent.display_name ?? agent.name} could not be deleted.`));
    } finally {
      setDeleting(false);
    }
  };

  const onCloud = managed?.controller_kind === "ec2";
  const deviceLabel = onCloud ? "Switch Cloud" : (managed?.controller_name ?? null);
  const device = devices.data?.find((each) => each.id === managed?.controller_id) ?? null;
  const reported = managed
    ? device?.status?.providers.map(providerReport).find((each) => each.provider === managed.definition.provider)
    : undefined;
  const providerName = provider?.label ?? managed?.definition.provider ?? null;
  const modelNote = (): { text: string; warning: boolean } =>
    reported && !reported.ready
      ? {
          text: `${deviceLabel ?? "Its device"} reports ${providerName} ${reported.problem}. You can enter a model ID.`,
          warning: true,
        }
      : {
          text: `Couldn't read ${deviceLabel ?? "its device"}'s models, so this isn't checked. You can enter a model alias or ID.`,
          warning: false,
        };

  const canManageAgents = useSaveNow(refetchAgent);

  return (
    <>
      <AgentSettingsPage
        saveBar={
          dirty && (
            <UnsavedChangesBar
              saving={saving}
              onDiscard={discard}
              onSave={() => void save()}
              saveRef={undefined}
              shortcut={null}
            />
          )
        }
        error={error}
        identity={{
          avatar: <AgentAvatar name={agent.name} iconUrl={agent.icon_url ?? null} serverId={serverId} size={88} />,
          name: agent.name,
          displayName: draft.displayName,
          description: draft.description,
          onDisplayNameChange: canEdit ? (value) => setValue("displayName", value) : null,
          onDescriptionChange: canEdit ? (value) => setValue("description", value) : null,
          badges: providerName && (
            <Badge variant="secondary" className="h-5 shrink-0 px-2 text-[11px]">
              {providerName}
            </Badge>
          ),
          titleActions: null,
          actions: !canEdit && (
            <p className="text-sm text-foreground-muted">
              You can see this agent, but only its owner and this workspace's admins can change it.
            </p>
          ),
        }}
        definition={
          managed && {
            instructions: draft.instructions,
            onInstructionsChange: (value) => setValue("instructions", value),
            autoMode: providerHasAutoMode(managed.definition.provider) ? draft.autoMode : null,
            unreviewedAutoMode: providerAutoModeUnreviewed(managed.definition.provider) ? providerName : null,
            onAutoModeChange: (checked) => setValue("autoMode", checked),
            autoApprove: draft.autoApprove,
            onAutoApproveChange: (checked) => setValue("autoApprove", checked),
          }
        }
        serverRows={
          <>
            {capabilities.features.agent_management && (
              <CanManageAgentsSetting
                agentName={null}
                machineWord="device"
                checked={agent.can_manage_agents}
                disabled={!agent.can_change_manage_agents || canManageAgents.pending}
                onChange={(checked) =>
                  void canManageAgents.run(
                    () => updateAgentCanManageAgents(agent.id, checked),
                    "Could not change whether this agent can manage agents.",
                  )
                }
                error={canManageAgents.error}
              />
            )}
            {agent.mid_turn_delivery !== undefined && (
              <MidTurnDeliverySetting
                steer={agent.mid_turn_delivery === "steer"}
                disabled={!canEdit || saveNow.pending}
                onChange={(mode) =>
                  void saveNow.run(
                    () => updateAgentMidTurnDelivery(agent.id, mode),
                    "Could not save the message delivery setting.",
                  )
                }
                error={saveNow.error}
              />
            )}
            <AddressingPolicySection
              agent={agent}
              canEdit={canEdit}
              canWiden={agent.can_widen_addressing}
              onUpdated={() => void refetchAgent()}
            />
          </>
        }
        machine={
          managed && {
            machineName: deviceLabel,
            thisComputer: false,
            directory: draft.directory,
            isolation: draft.isolation,
            cloud: onCloud,
            onDirectoryChange: (value) => setValue("directory", value),
            onIsolationChange: (value) => setValue("isolation", value),
            onChangeDevice: onMove ?? undefined,
          }
        }
        advanced={
          managed && (
            <>
              <AdvancedConfigDisclosure
                fields={fields}
                summary={summariseValues(fields, saved.form)}
                intro="The agent's model and its provider's settings. Its instructions are above, and its name is fixed."
                renderField={(field) => ({
                  input: (
                    <AdvancedFieldInput
                      field={field}
                      value={draft.form[field.key] ?? (field.type === "boolean" ? false : "")}
                      onChange={(value) =>
                        setEdits((current) => ({ ...current, form: { ...current.form, [field.key]: value } }))
                      }
                    />
                  ),
                  note: field.key === MODEL_FIELD.key || field.catalogue ? modelNote() : null,
                })}
              />
              {providers.error && (
                <p role="alert" className="text-xs text-foreground-destructive">
                  {failureText(
                    providers.error,
                    `Switch's settings for ${providerName} could not be read, so only the model can be changed here.`,
                  )}
                </p>
              )}
            </>
          )
        }
        onDelete={managed?.can_delete ? () => setConfirmingDelete(true) : null}
        deleting={deleting}
        machineWord="device"
      />
      <ConfirmChoice
        open={blocker.state === "blocked"}
        title="You have unsaved changes"
        description="If you leave now, your changes to this agent's settings will be lost."
        cancelLabel="Stay"
        confirmLabel="Discard and leave"
        destructive={false}
        onCancel={() => blocker.reset?.()}
        onConfirm={() => {
          discard();
          blocker.proceed?.();
        }}
      />
      <ConfirmChoice
        open={confirmingDelete}
        title={`Delete ${agent.display_name ?? agent.name}?`}
        description="Its device stops it and it is deleted from Switch, for every room it is in."
        cancelLabel="Cancel"
        confirmLabel={deleting ? "Deleting…" : "Delete"}
        destructive
        onCancel={() => setConfirmingDelete(false)}
        onConfirm={() => void remove()}
      />
    </>
  );
}

/** The agent's Connectors: the services it may use, apart from its settings. */
export function AgentConnectorsView({ agentId }: { agentId: string }) {
  const agentQuery = useQuery({
    queryKey: ["agent-settings", agentId],
    queryFn: async () => {
      const found = await fetchAgent(agentId);
      if (!found) throw new Error("Agent not found");
      return found;
    },
  });
  const agent = agentQuery.data;
  if (agentQuery.isPending) return <PageMessage>Loading…</PageMessage>;
  if (!agent)
    return (
      <p role="alert" className="px-8 py-10 text-sm text-foreground-destructive">
        {failureText(agentQuery.error, "The agent could not be read.")}
      </p>
    );
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <section className="mx-auto flex w-full max-w-[900px] flex-col gap-6 px-8 pt-10 pb-20">
        <SectionLabel>Service Access</SectionLabel>
        <ServiceAccessSection
          agent={agent}
          canGrant={agent.can_grant_services}
          onAgentUpdated={() => void agentQuery.refetch()}
        />
      </section>
    </div>
  );
}

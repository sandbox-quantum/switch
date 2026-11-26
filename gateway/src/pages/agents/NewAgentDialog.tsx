import "@switch-console/chat-ui/theme.css";
import {
  type NewAgentDevice,
  NewAgentDialog as SharedNewAgentDialog,
  type NewAgentHost,
} from "@switch-console/chat-ui/components/new-agent-dialog";
import type { AddressingPolicy } from "@switch-console/chat-ui/contracts/switch-servers";
import { NO_PROVIDER_PERMISSIONS, type NewAgentFormState } from "@switch-console/chat-ui/model/new-agent-form";
import { Button } from "@switch-console/chat-ui/primitives/button";
import { Dialog, DialogContent } from "@switch-console/chat-ui/primitives/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@switch-console/chat-ui/primitives/select";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import AgentPicture from "../../components/AgentPicture";
import { closeUnlessBusy } from "../../components/closeUnlessBusy";
import { AGENT_NAME_PATTERN, slugifyAgentName } from "../../data/agentNames";
import { agentPath } from "../../data/agentPaths";
import { useAuth } from "../../data/AuthContext";
import {
  OWNER_ONLY_POLICY,
  fetchAvatarSettings,
  loadAgents,
  updateAgentAddressingPolicy,
  updateAgentCanManageAgents,
} from "../../data/api";
import {
  type Controller,
  createManagedAgent,
  fetchProviders,
  providerAutoModeUnreviewed,
  providerHasAutoMode,
} from "../../data/management";
import {
  DeviceLoginForm,
  PROVIDERS_KEY,
  REFRESH_MS,
  deviceName,
  loginOffered,
  providerReport,
  providersQueryClient,
  useOwnDevices,
} from "../ai-providers/DeviceProviders";
import {
  ensureCloudMachine,
  fetchHostedMachines,
  needsWaking,
  wakeCloudMachine,
} from "../get-started/onboarding";
import { ProviderIcon } from "../get-started/ProviderIcon";

/** Who can talk to the agent, as the three answers the dialog offers; the rule editor is on the agent's page. */
const ADDRESSING = [
  {
    mode: "ownerAndAgents",
    label: "Me and my agents (default)",
    hint: "You, and any agent you own — so one of your agents can hand this one work. Nobody else.",
    policy: {
      rules: [{ rooms: "*", room_groups: "*", users: [], agents: [], owner: true, owner_agents: true }],
    } as AddressingPolicy,
  },
  {
    mode: "owner",
    label: "Only me",
    hint: "Only you, in person. Agents cannot talk to it, including your own.",
    policy: OWNER_ONLY_POLICY as AddressingPolicy,
  },
  {
    mode: "anyone",
    label: "Anyone",
    hint: "Anyone in this agent’s rooms can talk to it.",
    policy: null,
  },
] as const;

function AddressingChoice({ form }: { form: NewAgentFormState }) {
  const chosen = ADDRESSING.find((each) => each.policy === form.addressingPolicy) ?? ADDRESSING[0];
  return (
    <div className="flex flex-col gap-3">
      <Select
        value={chosen.mode}
        onValueChange={(next) =>
          form.setAddressingPolicy(ADDRESSING.find((each) => each.mode === next)?.policy ?? null)
        }
      >
        <SelectTrigger className="w-full" aria-label="Who can talk to your agent">
          <SelectValue>{chosen.label}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {ADDRESSING.map((each) => (
            <SelectItem key={each.mode} value={each.mode}>
              {each.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <span className="text-xs text-foreground-muted">{chosen.hint}</span>
    </div>
  );
}

function deviceOf(device: Controller): NewAgentDevice {
  const cloud = device.kind === "ec2";
  return {
    id: device.id,
    name: deviceName(device),
    cloud,
    online: device.state === "online",
    tag: cloud ? "cloud" : device.kind === "console" ? "Switch Console" : "computer",
    icon: cloud ? "cloud" : "server",
    os: device.platform?.os ?? null,
    workspacesDir: device.workspaces_dir ?? null,
    acceptsLogins: Boolean(device.public_key),
    providers: (device.status?.providers ?? []).map(providerReport),
  };
}

function WebConfirmButton(props: { type: "button"; onClick: () => void; disabled: boolean; children: ReactNode }) {
  return <Button {...props} />;
}

/**
 * The New agent dialog Switch Console has, on the web: the agent runs on the
 * person's Switch Cloud machine where the server offers one (made and woken
 * here when needed, as Get started does), otherwise on one of their devices; it is created
 * through the dashboard's own routes, and opens once it exists. An admin can
 * still add an agent that runs elsewhere, from a link under the title.
 */
export function NewAgentDialog({
  open,
  onClose,
  onAddOutsideAgent,
}: {
  open: boolean;
  onClose: () => void;
  /** Opens the dialog for an agent that runs elsewhere; null where the person may not. */
  onAddOutsideAgent: (() => void) | null;
}) {
  const [guarded, setGuarded] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={closeUnlessBusy(guarded, onClose)}
    >
      <DialogContent className="sm:max-w-2xl">
        {open && (
          <QueryClientProvider client={providersQueryClient}>
            <NewAgent onClose={onClose} setGuarded={setGuarded} onAddOutsideAgent={onAddOutsideAgent} />
          </QueryClientProvider>
        )}
      </DialogContent>
    </Dialog>
  );
}

function NewAgent({
  onClose,
  setGuarded,
  onAddOutsideAgent,
}: {
  onClose: () => void;
  setGuarded: (guarded: boolean) => void;
  onAddOutsideAgent: (() => void) | null;
}) {
  const navigate = useNavigate();
  const { capabilities } = useAuth();
  const devices = useOwnDevices();
  // The person's Switch Cloud machine, claimed when they have none; null where the server offers none.
  const hosted = useQuery({
    queryKey: [...PROVIDERS_KEY, "hosted-machine"],
    queryFn: async () => {
      const { available, machines } = await fetchHostedMachines();
      if (machines[0]) return machines[0];
      return available ? ensureCloudMachine() : null;
    },
    refetchInterval: REFRESH_MS,
  });
  const cloudOnly = hosted.data !== null;
  const cloudMachine = hosted.data ?? null;
  const [wakeError, setWakeError] = useState<unknown>(null);
  const woken = useRef(false);
  useEffect(() => {
    if (!cloudMachine || woken.current || !needsWaking(cloudMachine)) return;
    woken.current = true;
    wakeCloudMachine(cloudMachine).catch((caught: unknown) => setWakeError(caught));
  }, [cloudMachine]);
  const providers = useQuery({ queryKey: [...PROVIDERS_KEY, "list"], queryFn: fetchProviders });
  const agents = useQuery({ queryKey: [...PROVIDERS_KEY, "agent-names"], queryFn: loadAgents });
  const avatars = useQuery({ queryKey: [...PROVIDERS_KEY, "avatars"], queryFn: fetchAvatarSettings });
  const thirdParty = avatars.data?.third_party_avatars_enabled ?? null;
  const controllers = (devices.data ?? []).filter(
    (device) => !cloudOnly || device.id === cloudMachine?.controller_id,
  );
  const providerName = (id: string) => providers.data?.find((each) => each.id === id)?.label ?? id;

  const host: NewAgentHost = {
    cloudOnly,
    devices: devices.data && (!cloudOnly || cloudMachine) ? controllers.map(deviceOf) : undefined,
    devicesError: wakeError ?? hosted.error ?? devices.error,
    providers: providers.data?.map((each) => ({ id: each.id, name: each.label, fields: each.advanced_fields })),
    providersError: providers.error,
    takenNames: new Set((agents.data ?? []).map((agent) => agent.name)),
    machineWord: "device",
    takenWhere: "here",
    reportedTo: "Switch",
    formRules: { namePattern: AGENT_NAME_PATTERN, slugify: slugifyAgentName },
    permissionsFor: (provider) => {
      if (provider === null) return NO_PROVIDER_PERMISSIONS;
      const supportsAutoMode = providerHasAutoMode(provider);
      const unreviewed = providerAutoModeUnreviewed(provider);
      return {
        autoApprove: !supportsAutoMode,
        autoMode: supportsAutoMode && !unreviewed,
        supportsAutoMode,
        unreviewedAutoMode: unreviewed ? providerName(provider) : null,
      };
    },
    initialPolicy: () => ADDRESSING[0].policy,
    thirdPartyAvatarsEnabled: thirdParty,
    iconPicker: (form) => (
      <AgentPicture name={form.agentName || "?"} iconUrl={form.iconUrl} size={84} thirdParty={thirdParty} />
    ),
    addressing: (form) => <AddressingChoice form={form} />,
    providerIcon: (provider) => <ProviderIcon provider={provider} size={22} />,
    loginOffered,
    giveLogin: (device, provider, close) => {
      const controller = controllers.find((each) => each.id === device.id);
      return (
        controller && (
          <DeviceLoginForm
            device={controller}
            provider={provider}
            providerName={providerName(provider)}
            onClose={close}
          />
        )
      );
    },
    createAgent: async (request) => {
      const created = await createManagedAgent({
        name: request.name,
        description: request.description,
        display_name: request.displayName,
        icon_url: request.iconUrl,
        controller_id: request.deviceId,
        desired_state: "running",
        definition: {
          provider: request.provider,
          model: request.model,
          instructions: request.instructions,
          auto_mode: request.autoMode,
          auto_approve: request.autoApprove,
          directory: request.directory,
          isolation: request.isolation,
          advanced_config: request.advancedConfig,
        },
      });
      return { agentId: created.agent_id };
    },
    finishSetup: async (agentId, { addressingPolicy, canManageAgents }) => {
      // Always set: Switch creates an agent that answers its owner alone.
      await updateAgentAddressingPolicy(agentId, addressingPolicy);
      if (canManageAgents) await updateAgentCanManageAgents(agentId, true);
    },
    openAgent: (agentId) => navigate(agentPath(agentId, capabilities)),
    otherWays: [
      { label: "Or start from a template", onClick: () => navigate("/templates") },
      ...(onAddOutsideAgent ? [{ label: "Or add an agent that runs elsewhere", onClick: onAddOutsideAgent }] : []),
    ],
    addDevice: () => {
      onClose();
      navigate("/settings/devices");
    },
    setCloseGuard: setGuarded,
    onClose,
    ConfirmButton: WebConfirmButton,
  };

  return <SharedNewAgentDialog host={host} />;
}

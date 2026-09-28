import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, Loader2 } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  FormOptions,
  ParsedAgentEntry,
  TemplateKind,
} from '@main/core/agent-templates/template-document';
import type { AgentTemplateOrigin } from '@main/core/agents/agent-config-file';
import type { ParamSpec, ParsedTemplate } from '@main/core/room-templates/controller';
import type { GuardResult, ViewDefinition } from '@renderer/app/view-registry';
import { AgentTypePicker } from '@renderer/features/locations/components/add-agent-modal/agent-type-picker';
import { agentsStore } from '@renderer/features/locations/stores/agents-store';
import { HostReachabilityNotice } from '@renderer/features/remote-hosts/host-reachability-notice';
import { hostReachabilityStore } from '@renderer/features/remote-hosts/host-reachability-store';
import {
  HostReadinessNotice,
  useRemoteHostReadiness,
} from '@renderer/features/remote-hosts/host-readiness-notice';
import { blockedHandoffs } from '@renderer/features/room-templates/agent-handoff';
import {
  AgentListField,
  type EntityLists,
  UserListField,
} from '@renderer/features/room-templates/entity-fields';
import { refreshSidebarRoomState } from '@renderer/features/sidebar/sidebar-tree-data';
import { ServerSectionTitlebar } from '@renderer/features/switch-servers/server-section-titlebar';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { useMyIdentities } from '@renderer/features/switch-servers/use-my-identities';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate, useParams } from '@renderer/lib/layout/navigation-provider';
import { useModalContext } from '@renderer/lib/modal/modal-provider';
import { useAgentTypeAvailability } from '@renderer/lib/stores/use-agent-type-availability';
import { remoteAgentsQueryKey, useRemoteAgents } from '@renderer/lib/stores/use-remote-agents';
import { Alert, AlertDescription } from '@renderer/lib/ui/alert';
import { Button } from '@renderer/lib/ui/button';
import { Switch } from '@renderer/lib/ui/switch';
import { cn } from '@renderer/utils/utils';
import { AGENT_NAME_PATTERN, slugifyAgentNamePart } from '@shared/core/agents/agent-slug';
import {
  AGENT_PROVIDER_IDS,
  type AgentProviderId,
  providerDisplayName,
} from '@shared/core/providers/agent-provider-registry';
import { describeRemoteDirRefusal } from '@shared/core/remote-hosts/remote-dir';
import { ownerAndMyAgentsPolicy, ownerOnlyPolicy } from '@shared/core/switch-servers/owner-policy';
import { NEW } from '@shared/core/switch-servers/room-template-params';
import { RpcError } from '@shared/lib/ipc/rpc-error';
import { findBundledTemplate } from './bundled-templates';
import { CollapsibleInput } from './use/collapsible-input';
import {
  type AgentSlot,
  AgentSlotCard,
  newSlot,
  ResolvedDocument,
  RoomCard,
  SlotDirectoryField,
  type SlotStatus,
} from './use/creates-rail';
import { CreatingScreen } from './use/creating-screen';
import { ParamField } from './use/param-field';
import { RoomChoiceField } from './use/room-pick-field';
import { LOCAL_RUN_LOCATION, runLocationLabel, useAllowedHosts } from './use/run-location-select';
import {
  agentCreateSteps,
  bridgeCandidates,
  type CreateStep,
  createStepStatus,
  defaultsFor,
  hasPlaceholder,
  interpolate,
  isChain,
  isEmpty,
  missingParams,
  paramLabel,
  placeholdersIn,
  resolveChain,
  sectionOf,
  serverInputs,
  type Values,
  valueProblem,
} from './use/use-template-model';

type Params = {
  serverId: string;
  /** A workspace template id or bundled template id to load. */
  templateId?: string;
  /** A document to use instead of a stored template: pasted, dropped, or a recent. */
  yamlText?: string;
  sourceName?: string;
  /** Add the created agent to this room instead of creating the template's room. */
  intoRoomId?: string;
};

function useViewParams(): Params {
  return useParams('templateUse').params as Params;
}

/** A template loaded for the Use page: its document, its origin, and everything parsed from it. */
type UsePageTemplate = {
  name: string;
  yamlText: string;
  instructions: string | null;
  origin: AgentTemplateOrigin | null;
  kind: TemplateKind;
  agents: ParsedAgentEntry[];
  /** True for the singular `agent:` form, whose room refers to the agent as `{agent}`. */
  singular: boolean;
  /** Every declared param, the Console types included. */
  params: ParamSpec[];
  /** The names of the params the server document keeps. */
  serverParamNames: Set<string>;
  form: FormOptions;
  parsed: ParsedTemplate | null;
  coreYaml: string | null;
  warnings: string[];
};

async function loadUsePageTemplate(serverId: string, params: Params): Promise<UsePageTemplate> {
  let name: string;
  let yamlText: string;
  let instructions: string | null = null;
  let origin: AgentTemplateOrigin | null = null;
  if (params.templateId) {
    const bundled = findBundledTemplate(params.templateId);
    if (bundled) {
      name = bundled.name;
      yamlText = bundled.yamlText;
      instructions = bundled.instructions;
      origin = { id: bundled.id, name: bundled.name, source: 'bundled' };
    } else {
      const detail = await rpc.switchServers.getTemplateDetail({
        serverId,
        templateId: params.templateId,
      });
      name = detail.name;
      yamlText = detail.definition;
      origin = { id: detail.id, name: detail.name, source: 'server', serverId };
    }
  } else if (params.yamlText) {
    name = params.sourceName?.replace(/(\.template)?\.ya?ml$/i, '') ?? 'Pasted template';
    yamlText = params.yamlText;
  } else {
    throw new Error('Nothing to use: no template was given.');
  }
  const kind = await rpc.agentTemplates.kind({ yamlText });
  const { agents, singular, warnings } = await rpc.agentTemplates.parseAgents({
    yamlText,
    instructions,
  });
  // Two versions of the room document: one that keeps every param, for
  // building the form, and one with only what the server understands.
  const forForm = await rpc.agentTemplates.serverDocument({ yamlText, keepConsoleParams: true });
  const coreYaml = await rpc.agentTemplates.serverDocument({ yamlText });
  // Without the schema the form is built from the Console's own parse and
  // the server validates on create, so an older server without the schema
  // endpoint still gets a working page.
  const schema = await rpc.switchServers.fetchTemplateSchema(serverId).catch(() => null);
  const parsed = forForm
    ? await rpc.roomTemplates.parse({ yamlText: forForm, schema: schema ?? undefined })
    : null;
  // A document without rooms can still declare params, used in agent names.
  const declaredParams = parsed?.params ?? (await rpc.roomTemplates.params({ yamlText }));
  const serverParams = coreYaml ? await rpc.roomTemplates.params({ yamlText: coreYaml }) : [];
  const form = await rpc.agentTemplates.form({ yamlText });
  return {
    name,
    yamlText,
    instructions,
    origin,
    kind,
    agents,
    singular,
    params: declaredParams,
    serverParamNames: new Set(serverParams.map((p) => p.name)),
    form,
    parsed,
    coreYaml,
    warnings: [...warnings, ...(parsed?.warnings ?? [])],
  };
}

const TemplateUseTitlebar = observer(function TemplateUseTitlebar() {
  const { serverId } = useViewParams();
  const { navigate } = useNavigate();
  return (
    <ServerSectionTitlebar
      serverId={serverId}
      icon={FileText}
      label="Templates"
      item={{ label: 'Use template' }}
      onSectionClick={() => navigate('templates', { serverId })}
    />
  );
});

function SectionTitle({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      {hint && <p className="text-[12.5px] leading-relaxed text-foreground-muted">{hint}</p>}
    </div>
  );
}

/** A value the template fixed: shown so nothing is hidden, not editable. */
function FixedRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-3 rounded-[10px] border border-dashed border-border px-3 py-2.5">
      <span className="w-[104px] shrink-0 truncate text-[12.5px] font-medium">{label}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-foreground-muted">
        {value}
      </span>
      <span className="shrink-0 text-[11px] text-foreground-passive">Set by the template</span>
    </div>
  );
}

/** Everything the page has worked out about one agent entry from the inputs. */
type SlotSetup = {
  /** The identifier the agent is created under. */
  name: string;
  displayName: string | null;
  provider: AgentProviderId | null;
  /** `local`, or an SSH host. */
  location: string;
  directory: string;
  /** Rooms the agent joins once it exists, by name. */
  joins: string[];
  /** Whether the run creates the template's room for it. */
  makesRoom: boolean;
};

const TemplateUsePanel = observer(function TemplateUsePanel() {
  const params = useViewParams();
  const { serverId, intoRoomId = null } = params;
  const { navigate } = useNavigate();
  const { showModal } = useModalContext();
  const queryClient = useQueryClient();
  const [loaded, setLoaded] = useState<UsePageTemplate | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [values, setValues] = useState<Values>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [slots, setSlots] = useState<AgentSlot[]>([]);
  const [editedAgents, setEditedAgents] = useState<string[]>([]);
  const [editedUsers, setEditedUsers] = useState<string[]>([]);
  // The provider for agents whose template names none and declares no
  // `provider` param: asked on the page, never chosen for the deployer.
  const [pickedProvider, setPickedProvider] = useState<AgentProviderId | null>(null);
  const [phase, setPhase] = useState<'form' | 'creating' | 'done' | 'failed'>('form');
  const [doneDetail, setDoneDetail] = useState<string | null>(null);
  // What the server returned for the room, kept so that a step failing after
  // it does not make Retry create the room a second time.
  const createdRoom = useRef<Awaited<
    ReturnType<typeof rpc.switchServers.createRoomFromTemplate>
  > | null>(null);
  const [roomStatus, setRoomStatus] = useState<SlotStatus>('idle');
  const [createError, setCreateError] = useState<string | null>(null);
  // Advanced inputs the deployer opened, by param name or row key.
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  // For a template whose agent joins a `room` param: whether the deployer
  // wants a room at all, and whether they are choosing one right now.
  const [roomOn, setRoomOn] = useState(false);
  const [pickingRoom, setPickingRoom] = useState(false);
  const open = (key: string) => setOpened((prev) => new Set(prev).add(key));
  // Chains decided once their candidates are known, so a value the deployer
  // clears is not filled in again.
  const chainDecided = useRef(new Set<string>());
  // The directory agents are kept under, per location, for `{$agents_dir}`.
  const [agentsDirs, setAgentsDirs] = useState<Record<string, string>>({});

  // Reload only when a different document is requested. Reloading on every
  // render would reset the form.
  const { templateId, yamlText: givenYaml, sourceName } = params;
  useEffect(() => {
    let cancelled = false;
    setLoaded(null);
    setLoadError(null);
    loadUsePageTemplate(serverId, { serverId, templateId, yamlText: givenYaml, sourceName })
      .then((result) => {
        if (cancelled) return;
        setLoaded(result);
        const formParams = result.params.filter((p) => !(result.singular && p.name === 'agent'));
        setValues(defaultsFor(formParams));
        chainDecided.current = new Set();
        createdRoom.current = null;
        setOpened(new Set());
        setRoomOn(false);
        setPickingRoom(false);
        nameStepped.current = false;
        setPickedProvider(null);
        setSlots(result.agents.map(newSlot));
        // The editable member list holds the room's fixed agents that the template
        // does not create. Agents it creates have their own cards.
        const slotNames = new Set(result.agents.map((a) => a.name ?? ''));
        setEditedAgents((result.parsed?.hardcodedAgents ?? []).filter((a) => !slotNames.has(a)));
        setEditedUsers(result.parsed?.hardcodedUsers ?? []);
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(failureText(e, 'Could not load this template.'));
      });
    return () => {
      cancelled = true;
    };
  }, [serverId, templateId, givenYaml, sourceName]);

  const parsed = loaded?.parsed ?? null;
  // In the singular `agent:` form the room refers to the agent as `{agent}`.
  // The page fills that in with the agent's name, so it is not an input.
  const templateParams = useMemo(
    () => (loaded?.params ?? []).filter((p) => !(loaded?.singular && p.name === 'agent')),
    [loaded]
  );
  const createsAgents = (loaded?.agents.length ?? 0) > 0;
  const hasRoomPart = loaded?.coreYaml !== null && parsed !== null && !intoRoomId;
  const isGroupDoc = (parsed?.rooms.length ?? 0) > 1 || (parsed?.groupName ?? null) !== null;
  const templateRoom = parsed?.rooms[0] ?? null;

  // ── Which section each param belongs to ─────────────────────────────────
  const agentTexts = useMemo(
    () =>
      (loaded?.agents ?? []).map((a) => [
        a.name ?? '',
        a.displayName ?? '',
        a.provider ?? '',
        a.location ?? '',
        a.directory ?? '',
        ...a.join,
      ]),
    [loaded]
  );
  const roomText = loaded?.coreYaml ?? '';
  const sections = useMemo(
    () => new Map(templateParams.map((p) => [p.name, sectionOf(p, agentTexts, roomText)])),
    [templateParams, agentTexts, roomText]
  );
  const paramsOfAgent = (i: number) =>
    templateParams.filter((p) => {
      const s = sections.get(p.name);
      return s?.section === 'agent' && s.index === i;
    });
  const roomParams = templateParams.filter((p) => sections.get(p.name)?.section === 'room');
  // The `room` param an agent joins, when the template leaves the room to the deployer.
  const joinParam =
    templateParams.find(
      (p) => p.type === 'room' && (loaded?.agents ?? []).some((a) => a.join.includes(`{${p.name}}`))
    ) ?? null;
  const joinValue = joinParam ? String(values[joinParam.name] ?? '') : '';
  // A chain that resolved to a room switches the room on.
  useEffect(() => {
    if (joinValue !== '' && !roomOn) setRoomOn(true);
  }, [joinValue, roomOn]);
  // A Console-type param no agent entry binds applies to every agent.
  const unboundOfType = (type: ParamSpec['type']) =>
    templateParams.find(
      (p) =>
        p.type === type && !agentTexts.some((texts) => texts.some((t) => t.includes(`{${p.name}}`)))
    ) ?? null;
  const providerParam = unboundOfType('provider');
  const locationParam = unboundOfType('location');
  const directoryParam = unboundOfType('directory');

  // ── Server lists (pickers, identities, bridges) ─────────────────────────
  const agents = useRemoteAgents(serverId);
  const roomsQuery = useQuery({
    queryKey: ['remote-rooms', serverId],
    queryFn: () => rpc.switchServers.listRemoteRooms(serverId),
  });
  const bridgesQuery = useQuery({
    queryKey: ['remote-bridges', serverId],
    queryFn: () => rpc.switchServers.listRemoteBridges(serverId),
  });
  const knownUsersQuery = useQuery({
    queryKey: ['remote-external-users', serverId],
    queryFn: () => rpc.switchServers.listRemoteExternalUsers(serverId),
  });
  const { identities, refresh: refreshIdentities } = useMyIdentities(serverId);
  const bridges = useMemo(() => bridgesQuery.data ?? [], [bridgesQuery.data]);
  const allowedHosts = useAllowedHosts(serverId);
  const hostLabel = useCallback(
    (sshHost: string) => allowedHosts.find((h) => h.sshHost === sshHost)?.name ?? sshHost,
    [allowedHosts]
  );

  // The messaging app the room is created on: the bridge param's value if
  // there is one, else the bridge named in the template, else the server's default.
  const templateBridge = useMemo(() => {
    const bridgeParam = templateParams.find((p) => p.type === 'bridge');
    const picked = bridgeParam ? String(values[bridgeParam.name] ?? '') : '';
    const named = picked !== '' ? picked : (parsed?.bridge ?? null);
    if (named) return bridges.find((b) => b.displayName === named) ?? null;
    return bridges.find((b) => b.isDefault) ?? null;
  }, [bridges, parsed, templateParams, values]);
  const creatorIdentity = useMemo(() => {
    if (identities === null) return null;
    if (templateBridge) {
      return identities.find((i) => i.bridgeId === templateBridge.id)?.externalUsername ?? null;
    }
    return identities[0]?.externalUsername ?? null;
  }, [identities, templateBridge]);
  // A linked account is needed only when the room is on a messaging app. On
  // a server without one, the server uses the deployer's gateway name.
  const creatorBlocked =
    parsed?.usesCreator === true &&
    templateBridge !== null &&
    identities !== null &&
    creatorIdentity === null;
  const linkAccount = templateBridge
    ? () =>
        showModal('claimIdentityModal', {
          serverId,
          bridgeId: templateBridge.id,
          onSuccess: () => refreshIdentities(),
        })
    : null;
  const noMessagingApp = parsed !== null && bridgesQuery.data !== undefined && bridges.length === 0;

  const lists = useMemo(
    (): EntityLists => ({
      serverId,
      agents: agents.data ?? [],
      agentsLoading: agents.isLoading,
      rooms: roomsQuery.data ?? [],
      roomsLoading: roomsQuery.isLoading,
      bridges,
      identities,
      knownUsers: knownUsersQuery.data ?? [],
      bridgeId: templateBridge?.id ?? null,
    }),
    [
      serverId,
      agents.data,
      agents.isLoading,
      roomsQuery.data,
      roomsQuery.isLoading,
      bridges,
      identities,
      knownUsersQuery.data,
      templateBridge,
    ]
  );

  // ── The agents: what each is made of, from the inputs ───────────────────
  const setups: SlotSetup[] = useMemo(() => {
    const roomJoinParam = (entry: ParsedAgentEntry) =>
      templateParams.find((p) => p.type === 'room' && entry.join.includes(`{${p.name}}`)) ?? null;
    return slots.map((slot) => {
      const entry = slot.entry;
      const name = entry.name
        ? interpolate(entry.name, values)
        : slugifyAgentNamePart(interpolate(entry.displayName ?? '', values));
      const displayName = entry.displayName ? interpolate(entry.displayName, values) : null;
      const providerText = entry.provider
        ? interpolate(entry.provider, values)
        : providerParam
          ? String(values[providerParam.name] ?? '')
          : (pickedProvider ?? '');
      const provider = (AGENT_PROVIDER_IDS as readonly string[]).includes(providerText)
        ? (providerText as AgentProviderId)
        : null;
      const locationText = entry.location
        ? interpolate(entry.location, values)
        : locationParam
          ? String(values[locationParam.name] ?? '')
          : LOCAL_RUN_LOCATION;
      const location = locationText === '' ? LOCAL_RUN_LOCATION : locationText;
      const agentsDir = agentsDirs[location] ?? '';
      const dirValues: Values = { ...values, agent: name, $agents_dir: agentsDir };
      // A directory read from a param is interpolated twice: once to reach
      // the param's value, once for the `{$agents_dir}` and `{agent}` inside it.
      const directory = slot.dirPicked
        ? slot.dir
        : entry.directory
          ? interpolate(interpolate(entry.directory, dirValues), dirValues)
          : directoryParam
            ? interpolate(String(values[directoryParam.name] ?? ''), dirValues)
            : agentsDir && name && !hasPlaceholder(name)
              ? `${agentsDir}/${name}`
              : '';
      const joinParam = roomJoinParam(entry);
      const joins = entry.join
        .map((j) => interpolate(j, values))
        .filter((j) => j !== '' && j !== NEW && !hasPlaceholder(j));
      const makesRoom =
        hasRoomPart && (joinParam === null ? true : String(values[joinParam.name] ?? '') === NEW);
      return { name, displayName, provider, location, directory, joins, makesRoom };
    });
  }, [
    slots,
    values,
    templateParams,
    providerParam,
    locationParam,
    directoryParam,
    pickedProvider,
    agentsDirs,
    hasRoomPart,
  ]);
  // A room template with no agents still makes its room.
  const makesRoom = hasRoomPart && (setups.length === 0 || setups.some((s) => s.makesRoom));
  const locations = useMemo(() => [...new Set(setups.map((s) => s.location))], [setups]);
  const firstRemote = locations.find((l) => l !== LOCAL_RUN_LOCATION) ?? null;
  const hostReachable = locations.every(
    (l) => l === LOCAL_RUN_LOCATION || !hostReachabilityStore.isBlocked(l)
  );
  const hostReadiness = useRemoteHostReadiness(
    firstRemote,
    setups.find((s) => s.location === firstRemote)?.provider ?? null
  );
  const hostReady = firstRemote === null || (!hostReadiness.blocked && !hostReadiness.checking);
  // A location the server does not allow falls back to this computer.
  useEffect(() => {
    if (!locationParam) return;
    const v = String(values[locationParam.name] ?? '');
    if (v !== '' && v !== LOCAL_RUN_LOCATION && !allowedHosts.some((h) => h.sshHost === v)) {
      setValues((prev) => ({ ...prev, [locationParam.name]: LOCAL_RUN_LOCATION }));
    }
  }, [allowedHosts, locationParam, values]);

  // `{$agents_dir}` for every location in play, fetched once each.
  useEffect(() => {
    for (const location of locations) {
      if (agentsDirs[location] !== undefined) continue;
      const sshHost = location === LOCAL_RUN_LOCATION ? null : location;
      if (sshHost && hostReachabilityStore.isBlocked(sshHost)) continue;
      void rpc.agentTemplates
        .agentsDirectory({ sshHost })
        .then((dir) => setAgentsDirs((prev) => ({ ...prev, [location]: dir })))
        .catch(() => {});
    }
  }, [locations, agentsDirs]);

  // ── Chains: each decided once its candidates are known ──────────────────
  const availability = useAgentTypeAvailability(firstRemote ?? undefined);
  const localAvailability = useAgentTypeAvailability(undefined);
  useEffect(() => {
    if (!loaded) return;
    for (const param of templateParams) {
      if (!isChain(param) || chainDecided.current.has(param.name)) continue;
      let candidates: string[] | undefined;
      if (param.type === 'bridge') {
        candidates = bridgesQuery.data && bridgeCandidates(bridgesQuery.data);
      } else if (param.type === 'agent') {
        candidates = agents.data?.map((a) => a.name).sort();
      } else if (param.type === 'room') {
        candidates = roomsQuery.data?.map((r) => r.name).sort();
      } else if (param.type === 'location') {
        candidates = [LOCAL_RUN_LOCATION, ...allowedHosts.map((h) => h.sshHost)];
      } else if (param.type === 'provider') {
        // The providers installed where the agent reading this param runs.
        const section = sections.get(param.name);
        const at = section?.section === 'agent' ? setups[section.index] : undefined;
        const list =
          at && at.location !== LOCAL_RUN_LOCATION ? availability.data : localAvailability.data;
        candidates = list
          ?.filter(
            (a) => a.available && (AGENT_PROVIDER_IDS as readonly string[]).includes(a.agentId)
          )
          .map((a) => a.agentId);
      }
      if (candidates === undefined) continue; // the list is still loading
      chainDecided.current.add(param.name);
      const choice = resolveChain(param, candidates, hasRoomPart);
      if (choice === null) continue;
      setValues((prev) => (isEmpty(prev[param.name]) ? { ...prev, [param.name]: choice } : prev));
    }
  }, [
    loaded,
    templateParams,
    sections,
    setups,
    hasRoomPart,
    bridgesQuery.data,
    agents.data,
    roomsQuery.data,
    allowedHosts,
    availability.data,
    localAvailability.data,
  ]);

  // ── Names: taken, invalid, or still unresolved ──────────────────────────
  const takenNames = useMemo(() => new Set((agents.data ?? []).map((a) => a.name)), [agents.data]);
  // The param an agent entry takes its name from, when it takes it from one.
  const nameParamOf = useCallback(
    (entry: ParsedAgentEntry): ParamSpec | null => {
      const source = entry.name ?? entry.displayName ?? '';
      const key = placeholdersIn(source)[0];
      return key ? (templateParams.find((p) => p.name === key) ?? null) : null;
    },
    [templateParams]
  );
  // The template's default name steps to the first free one, "Switch expert
  // 2", before the deployer sees it, so a second agent from the same
  // template does not start out clashing. Decided once per load, and only
  // while the field still holds the template's default.
  const nameStepped = useRef(false);
  useEffect(() => {
    if (!loaded || !agents.data || nameStepped.current) return;
    nameStepped.current = true;
    const used = new Set(takenNames);
    const next: Values = {};
    for (const entry of loaded.agents) {
      const param = nameParamOf(entry);
      if (!param || typeof param.default !== 'string') continue;
      const current = String(values[param.name] ?? '');
      if (current !== param.default) continue;
      const identifierFor = (text: string) =>
        entry.name
          ? interpolate(entry.name, { ...values, [param.name]: text })
          : slugifyAgentNamePart(text);
      let candidate = param.default;
      for (let n = 2; used.has(identifierFor(candidate)); n++) candidate = `${param.default} ${n}`;
      used.add(identifierFor(candidate));
      if (candidate !== current) next[param.name] = candidate;
    }
    if (Object.keys(next).length > 0) setValues((prev) => ({ ...prev, ...next }));
  }, [loaded, agents.data, takenNames, nameParamOf, values]);

  // ── Why Create is disabled ──────────────────────────────────────────────
  // A room's own params matter only when the room is made.
  const liveParams = templateParams.filter(
    (p) =>
      makesRoom || joinParam === null || p === joinParam || sections.get(p.name)?.section !== 'room'
  );
  const missing = missingParams(liveParams, values);
  const invalid = liveParams
    .map((p) => ({ p, problem: valueProblem(p, values[p.name] ?? '') }))
    .filter((x) => x.problem !== null);
  const slotProblems: string[] = [];
  // A clash on a name the deployer can edit is shown in red under its field.
  const clashErrors: Record<string, string> = {};
  const seenNames = new Set<string>();
  slots.forEach((slot, i) => {
    const setup = setups[i];
    if (slot.mode === 'existing') {
      if (slot.existingName === '')
        slotProblems.push(`Pick the existing agent for ${setup.name || `agent ${i + 1}`}.`);
      return;
    }
    const name = slot.createdName ?? setup.name;
    if (name === '') {
      slotProblems.push('Give the agent a name.');
      return;
    }
    if (hasPlaceholder(name)) {
      slotProblems.push(`Fill in ${placeholdersIn(name).join(', ')} to name the agent.`);
      return;
    }
    if (!AGENT_NAME_PATTERN.test(name)) {
      slotProblems.push(
        `${name} is not a valid agent name: lowercase letters, digits, . - _, starting with a letter or digit.`
      );
    } else if (slot.createdName === null && (takenNames.has(name) || seenNames.has(name))) {
      const message = `An agent called ${name} already exists on this server. Change the name.`;
      slotProblems.push(message);
      const param = nameParamOf(slot.entry);
      if (param) clashErrors[param.name] = message;
    }
    seenNames.add(name);
    if (!setup.provider) slotProblems.push(`Choose which coding agent runs ${name}.`);
    if (setup.directory.trim() === '') slotProblems.push(`Choose a directory for ${name}.`);
    for (const room of setup.joins) {
      if (roomsQuery.data && !roomsQuery.data.some((r) => r.name === room))
        slotProblems.push(`There is no room called ${room} on this server.`);
    }
  });
  if (joinParam && roomOn && joinValue === '')
    slotProblems.push('Pick the room, or switch it off.');
  const newSlots = slots.filter((s) => s.mode === 'new');
  const remoteLabel = firstRemote ? runLocationLabel(firstRemote, allowedHosts) : '';
  const blockedReason: string | null =
    phase !== 'form'
      ? null
      : loaded === null
        ? 'Loading…'
        : missing.length > 0
          ? `Fill in ${missing.map(paramLabel).join(', ')}`
          : invalid.length > 0
            ? `${paramLabel(invalid[0].p)}: ${invalid[0].problem}`
            : slotProblems.length > 0
              ? slotProblems[0]
              : newSlots.length > 0 && !hostReachable
                ? `${remoteLabel} cannot be reached right now.`
                : newSlots.length > 0 && !hostReady
                  ? hostReadiness.checking
                    ? `Checking what ${remoteLabel} has installed…`
                    : `${remoteLabel} is missing setup the agents need.`
                  : !makesRoom
                    ? null // no room is made, so nothing below applies
                    : creatorBlocked
                      ? 'Link your messaging account first.'
                      : parsed !== null && noMessagingApp && parsed.usesCreator
                        ? 'This server has no messaging app, so the room would have no chat.'
                        : null;
  const stillNeeded =
    missing.length > 0
      ? `${missing.length} input${missing.length === 1 ? '' : 's'} still needed`
      : slotProblems.length > 0 || invalid.length > 0
        ? `${slotProblems.length + invalid.length} thing${slotProblems.length + invalid.length === 1 ? '' : 's'} to settle`
        : 'Every input filled in';

  // Existing agents in the room whose addressing policy blocks messages from
  // another member. New agents get the template's addressing at creation.
  const handoffBlocked = useMemo(() => {
    if (!parsed) return [];
    const names = new Set<string>(editedAgents);
    for (const param of templateParams) {
      if (param.type === 'agent') {
        const v = values[param.name];
        if (typeof v === 'string' && v !== '') names.add(v);
      }
    }
    for (const slot of slots)
      if (slot.mode === 'existing' && slot.existingName) names.add(slot.existingName);
    return blockedHandoffs((agents.data ?? []).filter((a) => names.has(a.name)));
  }, [parsed, editedAgents, templateParams, values, slots, agents.data]);
  const [allowingHandoffs, setAllowingHandoffs] = useState(false);
  const allowHandoffs = useCallback(async () => {
    const byName = new Map((agents.data ?? []).map((a) => [a.name, a]));
    setAllowingHandoffs(true);
    try {
      for (const targetName of new Set(handoffBlocked.map((b) => b.to))) {
        const target = byName.get(targetName);
        if (!target) continue;
        const sources = handoffBlocked
          .filter((b) => b.to === targetName)
          .map((b) => byName.get(b.from))
          .filter((a): a is NonNullable<typeof a> => a !== undefined);
        const rules = (target.addressingPolicy?.rules ?? []).map((rule) => {
          const next = { ...rule };
          for (const source of sources) {
            if (target.ownerId !== null && source.ownerId === target.ownerId) {
              next.owner_agents = true;
            } else if (next.agents !== '*' && !next.agents.includes(source.id)) {
              next.agents = [...next.agents, source.id];
            }
          }
          return next;
        });
        await rpc.switchServers.updateAddressingPolicy({
          serverId,
          agentId: target.id,
          policy: { rules },
        });
      }
      await queryClient.invalidateQueries({ queryKey: remoteAgentsQueryKey(serverId) });
    } catch (e) {
      toast({ title: failureText(e, 'Could not update the agents.'), variant: 'destructive' });
    } finally {
      setAllowingHandoffs(false);
    }
  }, [agents.data, handoffBlocked, serverId, queryClient]);

  // ── Create ──────────────────────────────────────────────────────────────
  const setSlot = (i: number, patch: Partial<AgentSlot>) =>
    setSlots((prev) => prev.map((s, j) => (j === i ? { ...s, ...patch } : s)));

  const createAll = async () => {
    if (!loaded || blockedReason !== null) return;
    setPhase('creating');
    setCreateError(null);
    setFieldErrors({});
    const created: { slotIndex: number; name: string; switchAgentId: string | null }[] = [];

    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      const setup = setups[i];
      if (slot.mode !== 'new' || slot.status === 'created') continue;
      const name = slot.createdName ?? setup.name;
      const providerId = setup.provider;
      if (!providerId) continue;
      const sshHost = setup.location === LOCAL_RUN_LOCATION ? null : setup.location;
      setSlot(i, { status: 'creating', error: null, step: 'prepare' });
      try {
        // An agent created on an earlier attempt is not created again; only its policy is set.
        let switchAgentId = slot.createdSwitchAgentId;
        if (!switchAgentId) {
          const prepared = await rpc.agentTemplates.prepareWorkspace({
            dir: setup.directory.trim(),
            repoUrl: slot.cloneRepo ? slot.entry.repoUrl : null,
            sshHost,
          });
          if (prepared.repo?.outcome === 'failed') {
            setSlot(i, {
              cloneWarning: `The repository could not be cloned (${prepared.repo.error ?? 'git clone failed'}). The agent clones it on its first run.`,
            });
            toast({
              title: `Could not fetch the repository for ${name}`,
              description: `${prepared.repo.error ?? 'git clone failed'}. The agent will try to clone it itself on its first run.`,
              variant: 'destructive',
            });
          }
          setSlot(i, { step: 'create' });
          const result = await rpc.agents.addAgent({
            sshHost,
            dir: setup.directory.trim(),
            name,
            providerId,
            serverId,
            description: slot.entry.description,
            displayName:
              setup.displayName && setup.displayName.trim() !== name
                ? setup.displayName.trim()
                : null,
            iconUrl: null,
            autoSession: true,
            // Nobody sits at a host's terminal to approve tool calls.
            autoApprove: sshHost !== null,
            instructions: slot.entry.instructions,
            definitionAttributes: {},
            providerConfig: null,
            entryPoint: 'server_page',
            // Only a single-agent template can be loaded again for this
            // agent's instructions; a team template has no one entry to offer.
            templateOrigin: loaded.singular ? loaded.origin : null,
          });
          if (result.kind !== 'created') {
            setSlot(i, { status: 'failed', error: provisionErrorText(result, hostLabel) });
            setPhase('failed');
            return;
          }
          switchAgentId = result.agent.switchAgentId ?? null;
          // Record the created agent before setting its policy, so a retry after a
          // policy failure does not create a second agent.
          setSlot(i, { createdName: result.agent.name, createdSwitchAgentId: switchAgentId });
        }
        // A new agent answers only its owner by default. The template's `anyone`
        // must be written as the open policy; leaving the default would keep it closed.
        if (switchAgentId && slot.entry.addressing) {
          setSlot(i, { step: 'policy' });
          await rpc.switchServers.updateAddressingPolicy({
            serverId,
            agentId: switchAgentId,
            policy:
              slot.entry.addressing === 'owner-agents'
                ? ownerAndMyAgentsPolicy()
                : slot.entry.addressing === 'owner'
                  ? ownerOnlyPolicy()
                  : null,
          });
        }
        created.push({ slotIndex: i, name, switchAgentId });
        setSlot(i, { status: 'created' });
      } catch (e) {
        setSlot(i, { status: 'failed', error: failureText(e, 'Could not create the agent.') });
        setPhase('failed');
        return;
      }
    }
    if (created.length > 0) {
      // The agents exist whether or not the lists refresh, so a refresh that
      // fails must not fail the run.
      await agentsStore.load().catch(() => {});
      await queryClient
        .invalidateQueries({ queryKey: remoteAgentsQueryKey(serverId) })
        .catch(() => {});
    }
    // A recent is used again from its own text, so a bundled template whose
    // instructions live in a separate file is stored with them inlined.
    void (async () => {
      const yamlText = loaded.instructions
        ? await rpc.agentTemplates.compose({
            yamlText: loaded.yamlText,
            instructions: loaded.instructions,
          })
        : loaded.yamlText;
      await rpc.roomTemplates.saveRecent({ serverId, name: loaded.name, yamlText });
    })().catch(() => {});

    // Rooms the agents join: the one this page was opened from, and the ones
    // the template names for each agent.
    const byRoomName = new Map((roomsQuery.data ?? []).map((r) => [r.name, r.id]));
    const byAgentName = new Map((agents.data ?? []).map((a) => [a.name, a.id]));
    const joinsByRoom = new Map<string, string[]>();
    // Agents the server did not register cannot be put in a room; the run
    // stops and says so rather than opening the room without them.
    const missingJoin: string[] = [];
    slots.forEach((slot, i) => {
      const agentId =
        slot.mode === 'existing'
          ? (byAgentName.get(slot.existingName) ?? null)
          : (slot.createdSwitchAgentId ??
            created.find((c) => c.slotIndex === i)?.switchAgentId ??
            null);
      if (!agentId) {
        if (intoRoomId || setups[i].joins.length > 0)
          missingJoin.push(slot.createdName ?? setups[i].name);
        return;
      }
      const roomIds = [
        ...(intoRoomId ? [intoRoomId] : []),
        ...setups[i].joins.map((r) => byRoomName.get(r)).filter((id): id is string => !!id),
      ];
      for (const roomId of roomIds) {
        joinsByRoom.set(roomId, [...(joinsByRoom.get(roomId) ?? []), agentId]);
      }
    });
    if (missingJoin.length > 0) {
      setRoomStatus('failed');
      setCreateError(
        `${missingJoin.join(', ')} ${missingJoin.length === 1 ? 'was' : 'were'} created but the server has not registered ${missingJoin.length === 1 ? 'it' : 'them'} yet, so ${missingJoin.length === 1 ? 'it' : 'they'} could not be added to the room. Open the agent and add it to the room from there.`
      );
      setPhase('failed');
      return;
    }
    let joinedRoomId: string | null = null;
    if (joinsByRoom.size > 0) {
      setRoomStatus('creating');
      try {
        for (const [roomId, ids] of joinsByRoom) {
          await rpc.switchServers.addRoomAgents({
            serverId,
            roomId,
            agentIds: [...new Set(ids)],
            direction: 'agents_to_room',
          });
          joinedRoomId = roomId;
        }
        if (!makesRoom) setRoomStatus('created');
        await refreshSidebarRoomState(true).catch(() => {});
      } catch (e) {
        setRoomStatus('failed');
        setCreateError(
          failureText(e, 'The agents were created, but could not be added to the room.')
        );
        setPhase('failed');
        return;
      }
    }

    if (!makesRoom || !loaded.coreYaml || !parsed) {
      // No room to make. Every path out of here navigates, so a run that
      // created nothing new does not stay on the creating screen.
      if (joinedRoomId) {
        toast({
          title: 'In the room',
          description: 'Mention an agent there to start it. A message from you is what wakes it.',
        });
        const roomId = joinedRoomId;
        finish(`Opening ${switchRoomsStore.roomNameById(roomId) ?? 'the room'}…`, () =>
          navigate('room', { roomId })
        );
        return;
      }
      const firstName = created[0]?.name ?? slots.find((s) => s.createdName)?.createdName;
      const local = firstName
        ? agentsStore.agentsOnServer(serverId).find((a) => a.name === firstName)
        : undefined;
      finish(local ? `Opening ${local.name}…` : 'Opening Your Agents…', () =>
        local
          ? navigate('location', { locationId: local.locationId, agentName: local.name })
          : navigate('serverAgents', { serverId })
      );
      return;
    }

    // Then the rooms. Agent names in the document are replaced with the names
    // the agents got, so the server finds them.
    setRoomStatus('creating');
    try {
      const replacements: Record<string, string> = {};
      slots.forEach((slot, i) => {
        const expression = slot.entry.name ?? '';
        const actual =
          slot.mode === 'existing' ? slot.existingName : (slot.createdName ?? setups[i].name);
        if (expression && actual && expression !== actual) replacements[expression] = actual;
      });
      let coreYaml = await rpc.agentTemplates.substituteSlots({
        coreYaml: loaded.coreYaml,
        replacements,
      });
      if (!isGroupDoc) {
        // The member lists are rebuilt from the parsed template, so the renamed
        // agents must be renamed here too, or the original names would come back.
        const slotNamesSet = new Set(slots.map((s) => s.entry.name ?? ''));
        const keep = (list: string[]) =>
          list
            .filter((a) => hasPlaceholder(a) || slotNamesSet.has(a))
            .map((a) => replacements[a] ?? a);
        coreYaml = await rpc.roomTemplates.rewriteYaml({
          yamlText: coreYaml,
          agents: [...new Set([...keep(parsed.agents), ...editedAgents])],
          users: [...keep(parsed.users), ...editedUsers],
        });
      }
      const inputs = serverInputs(templateParams, values, loaded.serverParamNames);
      if (loaded.singular && slots.length === 1) {
        // The singular `agent:` form: the server fills `{agent}` from this input.
        const slot = slots[0];
        inputs.agent =
          slot.mode === 'existing' ? slot.existingName : (slot.createdName ?? setups[0].name);
      }
      const result =
        createdRoom.current ??
        (await rpc.switchServers.createRoomFromTemplate(serverId, coreYaml, inputs, loaded.name));
      createdRoom.current = result;
      setRoomStatus('created');
      // The room exists whether or not the sidebar refreshes.
      await refreshSidebarRoomState(true).catch(() => {});
      if (result.kind === 'room') {
        if (result.failedAttachments.length > 0) {
          const kickoff = result.failedAttachments.find((f) => f.kind === 'kickoff');
          const others = result.failedAttachments.filter((f) => f.kind !== 'kickoff');
          toast({
            title: kickoff
              ? `"${result.roomName}" exists, but nobody has spoken in it yet`
              : `"${result.roomName}" was created with gaps`,
            description: [
              kickoff ? `The first message could not be posted: ${kickoff.error}` : null,
              others.length > 0
                ? `Could not add: ${others.map((f) => `${f.id} (${f.error})`).join(', ')}`
                : null,
            ]
              .filter(Boolean)
              .join(' '),
            variant: 'destructive',
          });
        }
        // Open the room. The kickoff and the agents' answers appear there, and the
        // agents' sessions appear in the sidebar.
        finish(`Opening ${result.roomName}…`, () => navigate('room', { roomId: result.roomId }));
      } else {
        const gaps = [
          ...result.errors.map((e) => e.error),
          ...result.rooms.flatMap((r) =>
            r.failedAttachments.map((f) => `${r.roomName}: ${f.id} (${f.error})`)
          ),
        ];
        if (gaps.length > 0) {
          toast({
            title: `"${result.groupName}" was created with gaps`,
            description: gaps.join('; '),
            variant: 'destructive',
          });
        } else {
          toast({
            title: `"${result.groupName}" is ready`,
            description: `${result.rooms.length} room${result.rooms.length === 1 ? '' : 's'} created.`,
          });
        }
        const first = result.rooms[0];
        finish(first ? `Opening ${first.roomName}…` : 'Opening Your Rooms…', () =>
          first ? navigate('room', { roomId: first.roomId }) : navigate('serverRooms', { serverId })
        );
      }
    } catch (e) {
      setRoomStatus('failed');
      const serverDetail =
        e instanceof RpcError && e.code === 'GatewayError' ? e.stringField('detail') : undefined;
      const message =
        serverDetail ?? failureText(e, 'Could not create the room from this template.');
      const paramMatch = message.match(/param(?:\(s\))?:?\s*['"]?(\w+)/i);
      if (paramMatch && templateParams.some((p) => p.name === paramMatch[1])) {
        setFieldErrors({ [paramMatch[1]]: message });
        open(paramMatch[1]);
      }
      setCreateError(
        created.length > 0
          ? `The agents were created, but the room could not be: ${message}`
          : message
      );
      setPhase('failed');
    }
  };

  // A short finished state before the page moves on, skipped for a deployer
  // who asked the system for less motion.
  const finish = (detail: string, go: () => void) => {
    setDoneDetail(detail);
    setPhase('done');
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.setTimeout(go, still ? 0 : 900);
  };

  // Values for the preview cards: the inputs, `{agent}` for a single-agent
  // template, and every agent's final name.
  const railValues: Values =
    loaded?.singular && setups[0] ? { ...values, agent: setups[0].name || '{agent}' } : values;
  const railRenames = useMemo(() => {
    const out: Record<string, string> = {};
    slots.forEach((slot, i) => {
      const expression = slot.entry.name ?? '';
      const actual =
        slot.mode === 'existing' ? slot.existingName : (slot.createdName ?? setups[i]?.name);
      if (expression && actual && expression !== actual) out[expression] = actual;
    });
    return out;
  }, [slots, setups]);

  // ── Render ──────────────────────────────────────────────────────────────
  const partlyDone =
    slots.some((s) => s.status === 'created' || s.status === 'failed') || roomStatus === 'failed';
  const roomCount = makesRoom ? (parsed?.rooms.length ?? 0) : 0;
  const primaryLabel = partlyDone
    ? 'Retry remaining steps'
    : intoRoomId
      ? 'Create and add to room'
      : createsAgents && roomCount > 0
        ? slots.length === 1
          ? 'Create agent and room'
          : 'Create all'
        : createsAgents
          ? slots.length === 1
            ? 'Create agent'
            : 'Create agents'
          : roomCount > 1
            ? 'Create rooms'
            : 'Create room';
  const intoRoomName = intoRoomId ? switchRoomsStore.roomNameById(intoRoomId) : null;

  const cancel = () =>
    intoRoomId
      ? navigate('room', { roomId: intoRoomId })
      : params.templateId
        ? navigate('templateDetail', { serverId, templateId: params.templateId })
        : params.yamlText
          ? navigate('templateImport', {
              serverId,
              yamlText: params.yamlText,
              sourceName: params.sourceName,
              edit: true,
            })
          : navigate('templates', { serverId });
  const showAgentLists =
    parsed !== null &&
    !isGroupDoc &&
    (parsed.hardcodedAgents.length > 0 || editedAgents.length > 0);
  const showUserLists =
    parsed !== null && !isGroupDoc && (parsed.hardcodedUsers.length > 0 || editedUsers.length > 0);

  // The rows of the creating screen: one per call the run makes.
  const createSteps: CreateStep[] = slots.flatMap((slot, i) =>
    slot.mode === 'new'
      ? agentCreateSteps(i, {
          name: slot.createdName ?? setups[i]?.name ?? 'the agent',
          status: slot.status,
          step: slot.step,
          clones: slot.cloneRepo && !!slot.entry.repoUrl,
          setsPolicy: !!slot.entry.addressing,
          cloneWarning: slot.cloneWarning,
        })
      : []
  );
  const joinNames = [
    ...(intoRoomName ? [intoRoomName] : []),
    ...new Set(setups.flatMap((s) => s.joins)),
  ];
  if (joinNames.length > 0) {
    createSteps.push({
      key: 'join',
      label: `Add to ${joinNames.join(', ')}`,
      status: makesRoom && roomStatus === 'created' ? 'done' : createStepStatus(roomStatus),
    });
  }
  if (makesRoom && parsed) {
    const count = parsed.rooms.length;
    const hasKickoff = parsed.kickoff !== null || parsed.rooms.some((r) => r.kickoff);
    createSteps.push({
      key: 'room',
      label:
        (count > 1 ? `Create ${count} rooms` : 'Create the room') +
        (hasKickoff ? (count > 1 ? ' and post their kickoffs' : ' and post the kickoff') : ''),
      status: createStepStatus(roomStatus),
    });
  }
  const runError =
    createError ?? slots.find((s) => s.status === 'failed')?.error ?? Object.values(fieldErrors)[0];

  const busy = phase === 'creating';
  const newRoomForPick =
    hasRoomPart && templateRoom
      ? {
          name: interpolate(templateRoom.name ?? 'New room', railValues),
          bridgeType: templateBridge?.type ?? null,
        }
      : null;

  /** One param as the template says to show it: asked, folded, or fixed.
   * Inside the Advanced fold an `advanced` param is a plain field: the fold does the folding. */
  const paramRow = (
    param: ParamSpec,
    sshHost: string | null,
    inFold = false,
    /** The agent whose section the row sits in, for a directory param's resolved path. */
    slotIndex: number | null = null
  ) => {
    const value = values[param.name] ?? '';
    const error = fieldErrors[param.name] ?? clashErrors[param.name] ?? valueProblem(param, value);
    const resolvedDirectory =
      param.type === 'directory' && slotIndex !== null && setups[slotIndex]?.directory
        ? setups[slotIndex].directory
        : null;
    const summary =
      param.type === 'provider'
        ? (providerDisplayName(String(value)) ?? String(value))
        : param.type === 'location'
          ? runLocationLabel(String(value) || LOCAL_RUN_LOCATION, allowedHosts)
          : param.type === 'room' && value === NEW
            ? (newRoomForPick?.name ?? 'New room')
            : param.type === 'directory'
              ? (resolvedDirectory ?? String(value)).replace(/^\/(?:Users|home)\/[^/]+/, '~')
              : String(value);
    if (param.input === 'fixed') {
      return <FixedRow key={param.name} label={paramLabel(param)} value={summary} />;
    }
    // A directory param's value can read `{$agents_dir}` and `{agent}`; the
    // control shows the path they resolve to, and an edit writes a literal.
    const shown = resolvedDirectory ?? value;
    const field = (
      <ParamField
        key={param.name}
        param={param}
        value={shown}
        onChange={(v) => setValues((prev) => ({ ...prev, [param.name]: v }))}
        error={error}
        lists={lists}
        sshHost={sshHost}
        hosts={allowedHosts}
        newRoom={newRoomForPick}
        disabled={busy}
        onNavigateAway={() =>
          param.type === 'location'
            ? navigate('remoteHosts')
            : navigate('settings', { tab: 'clis-models' })
        }
      />
    );
    if (param.input === 'advanced' && !inFold) {
      const settled = !isEmpty(value) && error === null;
      return (
        <CollapsibleInput
          key={param.name}
          label={paramLabel(param)}
          summary={summary}
          collapsed={settled && !opened.has(param.name) && phase === 'form'}
          onOpen={() => open(param.name)}
          disabled={busy}
        >
          {field}
        </CollapsibleInput>
      );
    }
    return field;
  };

  /** A summary line for the fold: each folded value, in order. */
  const foldSummary = (rows: ParamSpec[], directory: string, asksDirectory: boolean) =>
    [
      ...rows.map((p) => {
        const v = values[p.name] ?? '';
        return p.type === 'provider'
          ? (providerDisplayName(String(v)) ?? String(v))
          : p.type === 'location'
            ? runLocationLabel(String(v) || LOCAL_RUN_LOCATION, allowedHosts)
            : p.type === 'directory'
              ? (directory || String(v)).replace(/^\/(?:Users|home)\/[^/]+/, '~')
              : String(v);
      }),
      ...(asksDirectory ? [directory.replace(/^\/(?:Users|home)\/[^/]+/, '~')] : []),
    ]
      .filter((v) => v !== '')
      .join('  ·  ');

  /** The section for one agent entry: what it asks, then one fold with what the template settled. */
  const agentSection = (slot: AgentSlot, i: number) => {
    const setup = setups[i];
    const sshHost = setup.location === LOCAL_RUN_LOCATION ? null : setup.location;
    const own = paramsOfAgent(i);
    const shared = i === 0 ? [providerParam, locationParam, directoryParam] : [];
    const rows = [...own, ...shared.filter((p): p is ParamSpec => p !== null && !own.includes(p))];
    const asked = rows.filter((p) => p.input === 'ask');
    const folded = rows.filter((p) => p.input !== 'ask');
    const asksProvider = !slot.entry.provider && !providerParam && slot.mode === 'new';
    const asksDirectory = !slot.entry.directory && !directoryParam && slot.mode === 'new';
    const isRemote = sshHost !== null;
    const foldKey = `fold:${i}`;
    const foldSettled =
      folded.every(
        (p) =>
          p.input === 'fixed' ||
          (!isEmpty(values[p.name]) &&
            (fieldErrors[p.name] ?? valueProblem(p, values[p.name] ?? '')) === null)
      ) &&
      (!asksDirectory || (setup.directory !== '' && !slot.dirPicked)) &&
      hostReachable &&
      hostReady;
    const hasFold = folded.length > 0 || asksDirectory;
    const foldLabel = loaded?.form.advanced.label ?? 'Advanced';
    return (
      <div key={i} className="flex flex-col gap-4">
        {slots.length > 1 && (
          <SectionTitle
            title={setup.name && !hasPlaceholder(setup.name) ? setup.name : `Agent ${i + 1}`}
            hint={slot.entry.description || undefined}
          />
        )}
        {asked.map((p) => paramRow(p, sshHost, false, i))}
        {asksProvider && (
          <div className="flex flex-col gap-2">
            <div className="flex items-baseline gap-2">
              <span className="text-[12.5px] font-medium">Provider</span>
              <span className="flex-1" />
              <span className="text-[11px] text-amber-600 dark:text-amber-400">Required</span>
            </div>
            <p className="text-xs text-foreground-muted">
              The template names no coding agent. Only what{' '}
              {runLocationLabel(setup.location, allowedHosts)} has installed is offered.
            </p>
            {hostReachable ? (
              <AgentTypePicker
                value={pickedProvider}
                onChange={setPickedProvider}
                sshHost={sshHost ?? undefined}
                onNavigateAway={() => navigate('settings', { tab: 'clis-models' })}
              />
            ) : (
              <p className="text-xs text-foreground-passive">Waiting for the host…</p>
            )}
          </div>
        )}
        {hasFold && (
          <CollapsibleInput
            label={foldLabel}
            summary={foldSummary(folded, setup.directory, asksDirectory)}
            collapsed={
              phase === 'form' &&
              !(loaded?.form.advanced.open ?? false) &&
              !opened.has(foldKey) &&
              foldSettled
            }
            onOpen={() => open(foldKey)}
            disabled={busy}
            wrap
          >
            <div className="flex flex-col gap-5 rounded-[10px] border border-border px-4 py-4">
              <span className="text-[12.5px] font-medium">{foldLabel}</span>
              {folded.map((p) => paramRow(p, sshHost, true, i))}
              {asksDirectory && (
                <div className="flex flex-col gap-2">
                  <span className="text-[12.5px] font-medium">Directory</span>
                  <p className="text-xs text-foreground-muted">
                    The template names no directory, so the agent gets a folder of its own under the
                    one this Console keeps agents in.
                  </p>
                  <SlotDirectoryField
                    slot={{ ...slot, dir: setup.directory }}
                    onChange={(next) =>
                      setSlots((prev) => prev.map((x, j) => (j === i ? next : x)))
                    }
                    sshHost={sshHost}
                    busy={busy}
                  />
                </div>
              )}
              {isRemote && <HostReachabilityNotice sshHost={setup.location} />}
              {isRemote &&
                hostReachable &&
                firstRemote === setup.location &&
                !hostReadiness.checking && (
                  <HostReadinessNotice
                    sshHost={setup.location}
                    readiness={hostReadiness}
                    onNavigateAway={() => navigate('remoteHosts')}
                  />
                )}
            </div>
          </CollapsibleInput>
        )}
      </div>
    );
  };

  const memberLists = (
    <>
      {showAgentLists && (
        <div className="flex flex-col gap-2">
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-[12.5px] font-medium">agents</span>
            <span className="text-[11px] text-foreground-passive">already on the server</span>
          </div>
          <AgentListField items={editedAgents} onChange={setEditedAgents} lists={lists} />
          <p className="text-xs text-foreground-muted">
            Agents the template puts in the room. Drop any the server does not have, or add more.
          </p>
        </div>
      )}
      {showUserLists && (
        <div className="flex flex-col gap-2">
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-[12.5px] font-medium">users</span>
            <span className="text-[11px] text-foreground-passive">people</span>
          </div>
          <UserListField items={editedUsers} onChange={setEditedUsers} lists={lists} />
          <p className="text-xs text-foreground-muted">
            People the template invites. A name the server has not seen is looked up in the
            messaging app's directory when the room is created.
          </p>
        </div>
      )}
    </>
  );

  const otherRoomParams = roomParams.filter((p) => p !== joinParam);
  const roomDetails = (
    <>
      {otherRoomParams.filter((p) => p.input !== 'advanced').map((p) => paramRow(p, null))}
      {makesRoom && memberLists}
      {otherRoomParams.filter((p) => p.input === 'advanced').map((p) => paramRow(p, null))}
    </>
  );
  const roomSummary =
    joinValue === NEW
      ? `New room: ${newRoomForPick?.name ?? 'from the template'}`
      : joinValue || 'Pick a room';
  const roomSection = joinParam ? (
    // The template leaves the room to the deployer: one switch, and the
    // details only once it is on. Off, the agent is created on its own.
    <div className="flex flex-col gap-4">
      <label className="flex cursor-pointer items-start gap-3">
        <Switch
          checked={roomOn}
          disabled={busy}
          onCheckedChange={(on) => {
            setRoomOn(on);
            const next = on && hasRoomPart ? NEW : '';
            setValues((prev) => ({ ...prev, [joinParam.name]: next }));
            setPickingRoom(on && next === '');
          }}
          className="mt-0.5"
        />
        <span className="flex flex-col gap-0.5">
          <span className="text-sm font-semibold text-foreground">{paramLabel(joinParam)}</span>
          {joinParam.description && (
            <span className="text-[12.5px] leading-relaxed text-foreground-muted">
              {joinParam.description}
            </span>
          )}
        </span>
      </label>
      {roomOn && (
        <div className="flex flex-col gap-4 border-l-2 border-border pl-4">
          {pickingRoom ? (
            <div className="flex flex-col gap-2">
              <span className="text-[12.5px] font-medium">Room</span>
              <RoomChoiceField
                rooms={lists.rooms}
                loading={lists.roomsLoading}
                newRoom={newRoomForPick}
                value=""
                onChange={(v) => {
                  setValues((prev) => ({ ...prev, [joinParam.name]: v }));
                  setPickingRoom(false);
                }}
              />
            </div>
          ) : (
            <CollapsibleInput
              label="Room"
              summary={roomSummary}
              collapsed
              onOpen={() => setPickingRoom(true)}
              disabled={busy}
            >
              {null}
            </CollapsibleInput>
          )}
          {roomDetails}
        </div>
      )}
    </div>
  ) : hasRoomPart || roomParams.length > 0 || intoRoomId ? (
    <div className="flex flex-col gap-4">
      <SectionTitle
        title={roomCount > 1 ? 'Rooms' : 'Room'}
        hint={
          intoRoomId
            ? `The agent joins ${intoRoomName ?? 'the room'} you came from.`
            : roomParams.length === 0 && makesRoom
              ? 'Created as the template describes, with the agent in it.'
              : undefined
        }
      />
      {roomDetails}
    </div>
  ) : null;

  return (
    <div className="relative z-10 flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <div className="flex shrink-0 items-start gap-4 border-b border-border px-8 pt-8 pb-5 [-webkit-app-region:drag]">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-xs text-foreground-passive">
            {intoRoomId ? `Add an agent to ${intoRoomName ?? 'the room'}` : 'Use template'}
          </span>
          <h2 className="truncate text-xl font-semibold tracking-tight">
            {loaded?.name ?? params.sourceName ?? 'Template'}
          </h2>
          {partlyDone && phase === 'form' && (
            <span className="text-xs text-foreground-muted">
              What was created stays created; the button carries on from the first step that did not
              finish.
            </span>
          )}
        </div>
        <div
          className={cn(
            'flex shrink-0 flex-col items-end gap-1 [-webkit-app-region:no-drag]',
            phase !== 'form' && 'invisible'
          )}
        >
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={cancel} disabled={phase !== 'form'}>
              {params.yamlText && !intoRoomId ? 'Back to the document' : 'Cancel'}
            </Button>
            <Button
              size="sm"
              onClick={() => void createAll()}
              disabled={blockedReason !== null || phase !== 'form'}
              title={blockedReason ?? undefined}
            >
              {primaryLabel}
            </Button>
          </div>
          {blockedReason && loaded && phase === 'form' && (
            <span className="max-w-md text-right text-[11.5px] text-foreground-muted">
              {blockedReason}
            </span>
          )}
        </div>
      </div>

      {loadError ? (
        <div className="px-8 py-6">
          <Alert variant="destructive">
            <AlertDescription>{loadError}</AlertDescription>
          </Alert>
        </div>
      ) : !loaded || (!parsed && loaded.coreYaml) ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="size-5 animate-spin text-foreground-muted" />
        </div>
      ) : (
        <>
          {phase !== 'form' && (
            <CreatingScreen
              templateName={loaded.name}
              phase={phase}
              steps={createSteps}
              error={runError ?? null}
              doneDetail={doneDetail}
              onRetry={() => void createAll()}
              onBack={() => setPhase('form')}
            />
          )}
          {/* The form stays mounted under the creating screen, so Back to the
            form finds every choice as it was left. */}
          <div className={cn('flex min-h-0 flex-1', phase !== 'form' && 'hidden')}>
            {/* Left: inputs */}
            <div className="flex w-[46%] min-w-[340px] shrink-0 flex-col gap-6 overflow-auto px-8 py-6">
              {createError && (
                <Alert variant="destructive">
                  <AlertDescription>{createError}</AlertDescription>
                </Alert>
              )}
              {loaded.warnings.map((w, i) => (
                <Alert key={i}>
                  <AlertDescription>{w}</AlertDescription>
                </Alert>
              ))}
              {creatorBlocked && makesRoom && (
                <Alert>
                  <AlertDescription>
                    <div className="flex flex-col gap-2">
                      <span>
                        This template puts you in the room, and this server does not know which
                        account is yours{templateBridge ? ` on ${templateBridge.displayName}` : ''}.
                      </span>
                      {linkAccount && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="self-start"
                          onClick={linkAccount}
                        >
                          Link account
                        </Button>
                      )}
                    </div>
                  </AlertDescription>
                </Alert>
              )}
              {handoffBlocked.length > 0 && (
                <Alert>
                  <AlertDescription>
                    <div className="flex flex-col gap-2">
                      <span>
                        These agents will not hear each other:{' '}
                        {handoffBlocked.map((b) => `${b.to} ignores ${b.from}`).join(', ')}.
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        className="self-start"
                        disabled={allowingHandoffs}
                        onClick={() => void allowHandoffs()}
                      >
                        {allowingHandoffs ? 'Updating…' : 'Let them hear each other'}
                      </Button>
                    </div>
                  </AlertDescription>
                </Alert>
              )}

              {createsAgents && (
                <>
                  <SectionTitle
                    title={slots.length === 1 ? 'Agent' : 'Agents'}
                    hint={
                      templateParams.length === 0
                        ? 'This template asks for nothing. Create it as it is, or open Advanced.'
                        : undefined
                    }
                  />
                  {slots.map(agentSection)}
                </>
              )}
              {createsAgents && roomSection && <div className="border-t border-border" />}
              {!createsAgents && templateParams.length === 0 && (
                <p className="text-sm text-foreground-muted">This template asks for nothing.</p>
              )}
              {roomSection}
            </div>

            {/* Right: what this will create */}
            <div className="flex min-w-0 flex-1 flex-col border-l border-border bg-background-1">
              <div className="flex shrink-0 items-center gap-3 border-b border-border px-5 py-3">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-[10.5px] font-medium tracking-wide text-foreground-passive uppercase">
                    Preview
                  </span>
                  <span className="text-[13px] font-semibold">What this will create</span>
                </span>
                <span
                  className={cn(
                    'shrink-0 text-[11.5px]',
                    missing.length > 0 || slotProblems.length > 0 || invalid.length > 0
                      ? 'text-amber-600 dark:text-amber-400'
                      : 'text-emerald-700 dark:text-emerald-400'
                  )}
                >
                  {stillNeeded}
                </span>
              </div>
              <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-5 py-4">
                <div className="flex flex-col gap-2">
                  {slots.map((slot, i) => (
                    <AgentSlotCard
                      key={i}
                      slot={slot}
                      wantedName={setups[i]?.name ?? ''}
                      onChange={(next) =>
                        setSlots((prev) => prev.map((s, j) => (j === i ? next : s)))
                      }
                      lists={lists}
                      locationLabel={runLocationLabel(
                        setups[i]?.location ?? LOCAL_RUN_LOCATION,
                        allowedHosts
                      )}
                      choice={loaded.kind === 'group'}
                    />
                  ))}
                  {intoRoomId ? (
                    <p className="px-1 text-xs text-foreground-muted">
                      Joins{' '}
                      <span className="font-medium text-foreground">
                        {intoRoomName ?? 'the room'}
                      </span>
                      . Mention it there to start it.
                    </p>
                  ) : null}
                  {joinNames
                    .filter((n) => n !== intoRoomName)
                    .map((n) => (
                      <p key={n} className="px-1 text-xs text-foreground-muted">
                        Joins <span className="font-medium text-foreground">{n}</span>. Mention it
                        there to start it.
                      </p>
                    ))}
                  {makesRoom &&
                    parsed?.rooms.map((room, i) => (
                      <RoomCard
                        key={i}
                        room={room}
                        values={railValues}
                        renames={railRenames}
                        bridgeName={templateBridge?.displayName ?? parsed.bridge}
                        creatorIdentity={creatorIdentity}
                        status={roomStatus}
                        toggle={null}
                      />
                    ))}
                </div>
                <ResolvedDocument
                  yamlText={loaded.yamlText}
                  values={railValues}
                  renames={railRenames}
                />
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
});

function provisionErrorText(
  result: Exclude<Awaited<ReturnType<typeof rpc.agents.addAgent>>, { kind: 'created' }>,
  /** What the user calls the host they picked, keyed by SSH alias. */
  hostLabel: (sshHost: string) => string
): string {
  switch (result.kind) {
    case 'unauthenticated':
      return 'Sign in to this server first.';
    case 'name-conflict':
      return 'An agent with this name already exists in this directory or on the server.';
    case 'credentials-conflict':
      return `This directory already holds credentials for an agent of that name on ${result.endpoint}. Pick another directory.`;
    case 'already-configured':
      return 'This directory already holds credentials for an agent of that name. Load it instead.';
    case 'invalid-name':
      return result.message;
    case 'directory-unusable':
      return describeRemoteDirRefusal(result.inspection, hostLabel(result.sshHost));
    default:
      return result.message;
  }
}

export const templateUseView = {
  WrapView: ({ children }: { children: React.ReactNode } & Params) => <>{children}</>,
  TitlebarSlot: TemplateUseTitlebar,
  MainPanel: TemplateUsePanel,
  canActivate: (params: unknown): GuardResult => {
    const p = params as Partial<Params> | null;
    if (typeof p?.serverId !== 'string') return { ok: false, redirect: 'home' };
    if (!p.templateId && !p.yamlText)
      return { ok: false, redirect: 'templates', params: { serverId: p.serverId } };
    return { ok: true };
  },
} satisfies ViewDefinition<Params>;

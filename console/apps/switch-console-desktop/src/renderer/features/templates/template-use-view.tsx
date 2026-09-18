import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, Loader2 } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ParsedAgentEntry, TemplateKind } from '@main/core/agent-templates/controller';
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
import { remoteAgentsQueryKey, useRemoteAgents } from '@renderer/lib/stores/use-remote-agents';
import { useAgentTypeAvailability } from '@renderer/lib/stores/use-switch-setup';
import { Alert, AlertDescription } from '@renderer/lib/ui/alert';
import { Button } from '@renderer/lib/ui/button';
import { Input } from '@renderer/lib/ui/input';
import { cn } from '@renderer/utils/utils';
import { AGENT_NAME_PATTERN } from '@shared/core/agents/agent-slug';
import {
  AGENT_PROVIDER_IDS,
  type AgentProviderId,
  providerDisplayName,
} from '@shared/core/providers/agent-provider-registry';
import { ownerAndMyAgentsPolicy, ownerOnlyPolicy } from '@shared/core/switch-servers/owner-policy';
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
  slotWantedName,
} from './use/creates-rail';
import { CreatingScreen } from './use/creating-screen';
import { ParamField } from './use/param-field';
import {
  LOCAL_RUN_LOCATION,
  RunLocationSelect,
  runLocationLabel,
  useAllowedHosts,
} from './use/run-location-select';
import {
  agentCreateSteps,
  bridgeCandidates,
  type CreateStep,
  createStepStatus,
  defaultsFor,
  isEmpty,
  hasPlaceholder,
  interpolate,
  missingParams,
  prefillChoice,
  serverInputs,
  unsetBridgeParams,
  type Values,
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
  /** The declared params, including the Console-only `provider` type. */
  params: ParamSpec[];
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
  // Two versions of the room document: one that keeps the provider params, for
  // building the form, and one without them, for the server.
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
  // `prefill` is read from the full document: the room document above has it
  // removed, since a server that predates the key refuses it.
  const written = await rpc.roomTemplates.params({ yamlText });
  const prefillOf = new Map(written.map((p) => [p.name, p.prefill]));
  const declaredParams = (parsed?.params ?? written).map((p) => ({
    ...p,
    prefill: prefillOf.get(p.name) ?? null,
  }));
  return {
    name,
    yamlText,
    instructions,
    origin,
    kind,
    agents,
    singular,
    params: declaredParams,
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
  const [nameOverride, setNameOverride] = useState<string | null>(null);
  const [editedAgents, setEditedAgents] = useState<string[]>([]);
  const [editedUsers, setEditedUsers] = useState<string[]>([]);
  const [runHost, setRunHost] = useState<string>(LOCAL_RUN_LOCATION);
  const [pickedProvider, setPickedProvider] = useState<AgentProviderId | null>(null);
  const [phase, setPhase] = useState<'form' | 'creating' | 'done' | 'failed'>('form');
  const [doneDetail, setDoneDetail] = useState<string | null>(null);
  // What the server returned for the room, kept so that a step failing after
  // it does not make Retry create the room a second time.
  const createdRoom = useRef<Awaited<
    ReturnType<typeof rpc.switchServers.createRoomFromTemplate>
  > | null>(null);
  const [roomStatus, setRoomStatus] = useState<SlotStatus>('idle');
  // For an agent template the room is optional. When off, only the agent is created.
  const [createRoom, setCreateRoom] = useState(true);
  const [createError, setCreateError] = useState<string | null>(null);
  // An input the page filled in is shown as one line until the deployer opens it.
  const [prefilled, setPrefilled] = useState<ReadonlySet<string>>(new Set());
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const markPrefilled = useCallback(
    (key: string) => setPrefilled((prev) => (prev.has(key) ? prev : new Set(prev).add(key))),
    []
  );
  const open = (key: string) => setOpened((prev) => new Set(prev).add(key));
  // Params whose `prefill` has been decided, so a value the deployer clears
  // is not filled in again.
  const prefillDecided = useRef(new Set<string>());

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
        prefillDecided.current = new Set();
        createdRoom.current = null;
        setOpened(new Set());
        const firstName = result.agents[0]?.name ?? '';
        setPrefilled(
          new Set([
            ...formParams.filter((p) => p.default !== null).map((p) => `param:${p.name}`),
            ...(firstName !== '' && !hasPlaceholder(firstName) ? ['name'] : []),
            ...(result.agents.length > 0 ? ['location'] : []),
          ])
        );
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
  const isGroupDoc = (parsed?.rooms.length ?? 0) > 1 || parsed?.groupName !== null;
  const isRemoteRun = runHost !== LOCAL_RUN_LOCATION;
  const sshHost = isRemoteRun ? runHost : null;

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

  // The messaging app the room is created on: the bridge param's value if
  // there is one, else the bridge named in the template, else the server's default.
  const templateBridge = useMemo(() => {
    const bridgeParam = templateParams.find((p) => p.type === 'bridge');
    const picked = bridgeParam ? String(values[bridgeParam.name] ?? '') : '';
    const named = picked !== '' ? picked : (parsed?.bridge ?? null);
    if (named) return bridges.find((b) => b.displayName === named) ?? null;
    return bridges.find((b) => b.isDefault) ?? (bridges.length === 1 ? bridges[0] : null);
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

  // The existing-agent picker lists agents that run on the chosen location.
  // The Console records the host of every agent it created.
  const locationsQuery = useQuery({
    queryKey: ['locations'],
    queryFn: () => rpc.locations.getLocations(),
  });
  const agentsAtLocation = useMemo(() => {
    const hostOf = new Map((locationsQuery.data ?? []).map((l) => [l.id, l.sshHost]));
    const here = new Set(
      agentsStore
        .agentsOnServer(serverId)
        .filter((a) => (hostOf.get(a.locationId) ?? null) === sshHost)
        .map((a) => a.name)
    );
    return (agents.data ?? []).filter((a) => here.has(a.name));
  }, [agents.data, locationsQuery.data, serverId, sshHost]);

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

  // Apply `prefill: first`, and select the messaging app when the server has
  // only one. Each param is decided once, when its list has loaded.
  useEffect(() => {
    if (!loaded) return;
    for (const param of templateParams) {
      if (prefillDecided.current.has(param.name)) continue;
      const candidates =
        param.type === 'bridge'
          ? bridgesQuery.data && bridgeCandidates(bridgesQuery.data)
          : param.type === 'agent'
            ? agents.data?.map((a) => a.name).sort()
            : param.type === 'room'
              ? roomsQuery.data?.map((r) => r.name).sort()
              : [];
      if (candidates === undefined) continue; // the list is still loading
      prefillDecided.current.add(param.name);
      const first = prefillChoice(param, candidates);
      if (first === null) continue;
      setValues((prev) => (isEmpty(prev[param.name]) ? { ...prev, [param.name]: first } : prev));
      markPrefilled(`param:${param.name}`);
    }
  }, [loaded, templateParams, bridgesQuery.data, agents.data, roomsQuery.data, markPrefilled]);

  // ── Where the agents run, and what runs them ────────────────────────────
  const allowedHosts = useAllowedHosts(serverId);
  useEffect(() => {
    if (isRemoteRun && !allowedHosts.some((h) => h.sshHost === runHost)) {
      setRunHost(LOCAL_RUN_LOCATION);
    }
  }, [allowedHosts, isRemoteRun, runHost]);
  // Provider availability differs per machine, so changing the run location
  // clears the provider picked on the page. A `provider` param keeps its value.
  useEffect(() => {
    setPickedProvider(null);
    setSlots((prev) => prev.map((s) => (s.dirPicked ? s : { ...s, dir: '' })));
  }, [runHost]);
  const providerParam = templateParams.find((p) => p.type === 'provider') ?? null;
  // The first coding agent the run location has is selected for the deployer.
  const availability = useAgentTypeAvailability(sshHost ?? undefined);
  useEffect(() => {
    if (!createsAgents || phase !== 'form') return;
    const first = availability.data?.find(
      (a) => a.available && (AGENT_PROVIDER_IDS as readonly string[]).includes(a.agentId)
    )?.agentId as AgentProviderId | undefined;
    if (!first) return;
    if (providerParam) {
      if (providerParam.default !== null || !isEmpty(values[providerParam.name])) return;
      setValues((prev) => ({ ...prev, [providerParam.name]: first }));
      markPrefilled(`param:${providerParam.name}`);
    } else if (pickedProvider === null) {
      setPickedProvider(first);
      markPrefilled('provider');
    }
  }, [
    availability.data,
    createsAgents,
    phase,
    providerParam,
    values,
    pickedProvider,
    markPrefilled,
  ]);
  const pageProvider: AgentProviderId | null = providerParam
    ? ((values[providerParam.name] as AgentProviderId) ?? null) || null
    : pickedProvider;
  const providerFor = (entry: ParsedAgentEntry): AgentProviderId | null => {
    const own = entry.provider ? interpolate(entry.provider, values) : null;
    if (own && (AGENT_PROVIDER_IDS as readonly string[]).includes(own)) {
      return own as AgentProviderId;
    }
    return pageProvider;
  };
  const hostReachable = !isRemoteRun || !hostReachabilityStore.isBlocked(runHost);
  const hostReadiness = useRemoteHostReadiness(sshHost, pageProvider);
  const hostReady = !isRemoteRun || (!hostReadiness.blocked && !hostReadiness.checking);

  // ── Names: wanted, taken, and the first free variant ────────────────────
  const takenNames = useMemo(() => new Set((agents.data ?? []).map((a) => a.name)), [agents.data]);
  const slotNames = useMemo(() => {
    const used = new Set<string>();
    return slots.map((slot, i) => {
      const wanted = slotWantedName(slot, values, i === 0 ? nameOverride : null);
      if (slot.mode === 'existing') return { wanted, final: slot.existingName };
      if (wanted === '' || hasPlaceholder(wanted)) return { wanted, final: wanted };
      let candidate = wanted;
      for (let n = 2; takenNames.has(candidate) || used.has(candidate); n++) {
        candidate = `${wanted}-${n}`;
      }
      used.add(candidate);
      return { wanted, final: candidate };
    });
  }, [slots, values, nameOverride, takenNames]);

  // Suggest a working directory for each new agent, named after it, under the
  // Console's locations directory or the host's home. The suggestion follows
  // the agent name until the deployer picks a directory.
  const suggestSeq = useRef(0);
  useEffect(() => {
    if (!hostReachable || phase !== 'form') return;
    const seq = ++suggestSeq.current;
    slots.forEach((slot, i) => {
      if (slot.mode !== 'new' || slot.dirPicked) return;
      const name = slotNames[i]?.final ?? '';
      if (name === '' || hasPlaceholder(name) || !AGENT_NAME_PATTERN.test(name)) return;
      void rpc.agentTemplates
        .suggestDirectory({ agentName: name, sshHost })
        .then((dir) => {
          if (seq !== suggestSeq.current) return;
          setSlots((prev) => {
            const s = prev[i];
            if (!s || s.dirPicked || s.dir === dir) return prev; // same array: no re-run
            return prev.map((x, j) => (j === i ? { ...x, dir } : x));
          });
          if (i === 0) markPrefilled('dir');
        })
        .catch(() => {});
    });
  }, [slots, slotNames, sshHost, hostReachable, phase, markPrefilled]);

  // ── Why Create is disabled ──────────────────────────────────────────────
  const missing = missingParams(templateParams, values);
  const slotProblems: string[] = [];
  slots.forEach((slot, i) => {
    const { wanted, final } = slotNames[i] ?? { wanted: '', final: '' };
    if (slot.mode === 'existing') {
      if (final === '')
        slotProblems.push(`Pick the existing agent for ${wanted || `agent ${i + 1}`}.`);
      return;
    }
    if (final === '' || hasPlaceholder(final)) return; // an input still fills it in
    if (!AGENT_NAME_PATTERN.test(final)) {
      slotProblems.push(
        `${final} is not a valid agent name: lowercase letters, digits, . - _, starting with a letter or digit.`
      );
    }
    if (!providerFor(slot.entry))
      slotProblems.push('Choose which coding agent backs the new agents.');
    if (slot.dir.trim() === '') slotProblems.push(`Choose a directory for ${final}.`);
  });
  const newSlots = slots.filter((s) => s.mode === 'new');
  const blockedReason: string | null =
    phase !== 'form'
      ? null
      : loaded === null
        ? 'Loading…'
        : missing.length > 0
          ? `Fill in ${missing.map((p) => p.name).join(', ')}`
          : slotProblems.length > 0
            ? slotProblems[0]
            : newSlots.length > 0 && !hostReachable
              ? `${runLocationLabel(runHost, allowedHosts)} cannot be reached right now.`
              : newSlots.length > 0 && !hostReady
                ? hostReadiness.checking
                  ? `Checking what ${runLocationLabel(runHost, allowedHosts)} has installed…`
                  : `${runLocationLabel(runHost, allowedHosts)} is missing setup the agents need.`
                : intoRoomId
                  ? null // no room is made, so nothing below applies
                  : creatorBlocked
                    ? 'Link your messaging account first.'
                    : parsed !== null && noMessagingApp && parsed.usesCreator
                      ? 'This server has no messaging app, so the room would have no chat.'
                      : null;
  const stillNeeded =
    missing.length > 0
      ? `${missing.length} input${missing.length === 1 ? '' : 's'} still needed`
      : slotProblems.length > 0
        ? `${slotProblems.length} thing${slotProblems.length === 1 ? '' : 's'} to settle`
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
    const finalNames = slotNames.map((n) => n.final);
    const created: { slotIndex: number; name: string; switchAgentId: string | null }[] = [];

    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      if (slot.mode !== 'new' || slot.status === 'created') continue;
      const name = slot.createdName ?? finalNames[i];
      const providerId = providerFor(slot.entry);
      if (!providerId) continue;
      setSlot(i, { status: 'creating', error: null, step: 'prepare' });
      try {
        // An agent created on an earlier attempt is not created again; only its policy is set.
        let switchAgentId = slot.createdSwitchAgentId;
        if (!switchAgentId) {
          const prepared = await rpc.agentTemplates.prepareWorkspace({
            dir: slot.dir.trim(),
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
            dir: slot.dir.trim(),
            name,
            providerId,
            serverId,
            description: slot.entry.description,
            displayName: null,
            iconUrl: null,
            autoSession: true,
            // Nobody sits at a host's terminal to approve tool calls.
            autoApprove: isRemoteRun,
            instructions: slot.entry.instructions,
            definitionAttributes: {},
            providerConfig: null,
            entryPoint: 'server_page',
            templateOrigin: loaded.origin,
          });
          if (result.kind !== 'created') {
            setSlot(i, { status: 'failed', error: provisionErrorText(result) });
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
    rpc.roomTemplates
      .saveRecent({ serverId, name: loaded.name, yamlText: loaded.yamlText })
      .catch(() => {});

    if (intoRoomId) {
      const byName = new Map((agents.data ?? []).map((a) => [a.name, a.id]));
      const ids = slots
        .map((s) =>
          s.mode === 'existing' ? (byName.get(s.existingName) ?? null) : s.createdSwitchAgentId
        )
        .concat(created.map((c) => c.switchAgentId))
        .filter((id): id is string => !!id);
      setRoomStatus('creating');
      try {
        if (ids.length > 0) {
          await rpc.switchServers.addRoomAgents({
            serverId,
            roomId: intoRoomId,
            agentIds: [...new Set(ids)],
            direction: 'agents_to_room',
          });
        }
        setRoomStatus('created');
        await refreshSidebarRoomState(true).catch(() => {});
        toast({
          title: 'In the room',
          description: 'Mention an agent there to start it. A message from you is what wakes it.',
        });
        finish(`Opening ${intoRoomName ?? 'the room'}…`, () =>
          navigate('room', { roomId: intoRoomId })
        );
      } catch (e) {
        setRoomStatus('failed');
        setCreateError(
          failureText(e, 'The agents were created, but could not be added to the room.')
        );
        setPhase('failed');
      }
      return;
    }

    if (!loaded.coreYaml || !parsed || (loaded.kind === 'agent' && !createRoom)) {
      // No room to make. Every path out of here navigates, so a run that
      // created nothing new does not stay on the creating screen.
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
          slot.mode === 'existing' ? slot.existingName : (slot.createdName ?? finalNames[i]);
        if (expression && actual && expression !== actual) replacements[expression] = actual;
      });
      let coreYaml = await rpc.agentTemplates.substituteSlots({
        coreYaml: loaded.coreYaml,
        replacements,
      });
      coreYaml = await rpc.agentTemplates.dropParams({
        coreYaml,
        names: unsetBridgeParams(templateParams, values),
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
      const inputs = serverInputs(templateParams, values);
      if (loaded.singular && slots.length === 1) {
        // The singular `agent:` form: the server fills `{agent}` from this input.
        const slot = slots[0];
        inputs.agent =
          slot.mode === 'existing' ? slot.existingName : (slot.createdName ?? finalNames[0] ?? '');
      }
      const result =
        createdRoom.current ??
        (await rpc.switchServers.createRoomFromTemplate(serverId, coreYaml, inputs));
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
        open(`param:${paramMatch[1]}`);
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
    loaded?.singular && slotNames[0]
      ? { ...values, agent: slotNames[0].final || '{agent}' }
      : values;
  const railRenames = useMemo(() => {
    const out: Record<string, string> = {};
    slots.forEach((slot, i) => {
      const expression = slot.entry.name ?? '';
      const actual =
        slot.mode === 'existing' ? slot.existingName : (slot.createdName ?? slotNames[i]?.final);
      if (expression && actual && expression !== actual) out[expression] = actual;
    });
    return out;
  }, [slots, slotNames]);

  // ── Render ──────────────────────────────────────────────────────────────
  const partlyDone =
    slots.some((s) => s.status === 'created' || s.status === 'failed') || roomStatus === 'failed';
  const primaryLabel = partlyDone
    ? 'Retry remaining steps'
    : intoRoomId
      ? 'Create and add to room'
      : loaded?.kind === 'group'
        ? 'Create all'
        : loaded?.kind === 'agent'
          ? 'Create agent'
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
  const showNameField = loaded?.kind === 'agent' && slots.length === 1 && slots[0].mode === 'new';
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
          name: slot.createdName ?? slotNames[i]?.final ?? 'the agent',
          status: slot.status,
          step: slot.step,
          clones: slot.cloneRepo && !!slot.entry.repoUrl,
          setsPolicy: !!slot.entry.addressing,
          cloneWarning: slot.cloneWarning,
        })
      : []
  );
  if (intoRoomId) {
    createSteps.push({
      key: 'room',
      label: `Add to ${intoRoomName ?? 'the room'}`,
      status: createStepStatus(roomStatus),
    });
  } else if (loaded?.coreYaml && parsed && !(loaded.kind === 'agent' && !createRoom)) {
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

  const isCollapsed = (key: string) => prefilled.has(key) && !opened.has(key) && phase === 'form';
  // One new agent: its name, provider and directory are inputs of the page.
  // With several agents each card in the rail holds its own directory.
  const singleNewAgent = slots.length === 1 && slots[0].mode === 'new';

  const nameField = showNameField && (
    <CollapsibleInput
      label="Name"
      summary={slotNames[0]?.final || (nameOverride ?? slotNames[0]?.wanted ?? '')}
      collapsed={isCollapsed('name') && (nameOverride ?? slotNames[0]?.wanted ?? '') !== ''}
      onOpen={() => open('name')}
    >
      <div className="flex flex-col gap-2">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-[12.5px] font-medium">name</span>
          <span className="text-[11px] text-foreground-passive">text</span>
          <span className="flex-1" />
          <span className="text-[11px] text-amber-600 dark:text-amber-400">Required</span>
        </div>
        <p className="text-xs text-foreground-muted">
          What the agent is called on this server. In rooms it is addressed by this name.
        </p>
        <Input
          className="font-mono"
          value={nameOverride ?? slotNames[0]?.wanted ?? ''}
          onChange={(e) => setNameOverride(e.target.value)}
          disabled={phase === 'creating'}
        />
      </div>
    </CollapsibleInput>
  );

  const paramFields = templateParams.map((param) => (
    <CollapsibleInput
      key={param.name}
      label={
        param.type === 'bridge'
          ? 'Messaging app'
          : param.type === 'provider'
            ? 'Provider'
            : param.name
      }
      summary={
        param.type === 'provider'
          ? (providerDisplayName(String(values[param.name] ?? '')) ?? String(values[param.name]))
          : String(values[param.name] ?? '')
      }
      collapsed={
        isCollapsed(`param:${param.name}`) &&
        !isEmpty(values[param.name]) &&
        !fieldErrors[param.name]
      }
      onOpen={() => open(`param:${param.name}`)}
    >
      <ParamField
        param={param}
        value={values[param.name] ?? ''}
        onChange={(v) => setValues((prev) => ({ ...prev, [param.name]: v }))}
        error={fieldErrors[param.name] ?? null}
        lists={lists}
        sshHost={sshHost}
        onNavigateAway={() => navigate('settings', { tab: 'clis-models' })}
      />
    </CollapsibleInput>
  ));

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

  // Hidden when the server allows no SSH host, since agents can then only run on this computer.
  const locationField = createsAgents && allowedHosts.length > 0 && (
    <CollapsibleInput
      label="Runs on"
      summary={runLocationLabel(runHost, allowedHosts)}
      collapsed={isCollapsed('location')}
      onOpen={() => open('location')}
    >
      <div className="flex flex-col gap-2">
        <span className="text-[12.5px] font-medium">Runs on</span>
        <RunLocationSelect
          value={runHost}
          onChange={setRunHost}
          hosts={allowedHosts}
          disabled={phase === 'creating'}
        />
        {isRemoteRun && <HostReachabilityNotice sshHost={runHost} />}
        {isRemoteRun && hostReachable && !hostReadiness.checking && (
          <HostReadinessNotice
            sshHost={runHost}
            readiness={hostReadiness}
            onNavigateAway={() => navigate('remoteHosts')}
          />
        )}
      </div>
    </CollapsibleInput>
  );

  const providerField = createsAgents && !providerParam && (
    <CollapsibleInput
      label="Provider"
      summary={pickedProvider ? (providerDisplayName(pickedProvider) ?? pickedProvider) : ''}
      collapsed={isCollapsed('provider') && pickedProvider !== null}
      onOpen={() => open('provider')}
    >
      <div className="flex flex-col gap-2">
        <span className="text-[12.5px] font-medium">Provider</span>
        <p className="text-xs text-foreground-muted">
          Which coding agent backs {slots.length === 1 ? 'it' : 'them'}. Only what{' '}
          {runLocationLabel(runHost, allowedHosts)} has installed is offered.
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
    </CollapsibleInput>
  );

  const directoryField = singleNewAgent && (
    <CollapsibleInput
      label="Directory"
      summary={slots[0].dir.replace(/^\/(?:Users|home)\/[^/]+/, '~')}
      collapsed={isCollapsed('dir') && !slots[0].dirPicked && slots[0].dir !== ''}
      onOpen={() => open('dir')}
    >
      <div className="flex flex-col gap-2">
        <span className="text-[12.5px] font-medium">Directory</span>
        <SlotDirectoryField
          slot={slots[0]}
          onChange={(next) => setSlots((prev) => prev.map((x, j) => (j === 0 ? next : x)))}
          sshHost={sshHost}
          busy={phase === 'creating'}
        />
      </div>
    </CollapsibleInput>
  );

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
              {creatorBlocked && !intoRoomId && (
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

              <SectionTitle
                title="Inputs"
                hint={
                  blockedReason === null && prefilled.size > 0
                    ? 'Filled in for you. Change anything, or create it as it is.'
                    : 'Values are substituted into the template. Nothing is created until you confirm.'
                }
              />
              {templateParams.length === 0 && !showNameField && (
                <p className="text-sm text-foreground-muted">This template asks for nothing.</p>
              )}
              {singleNewAgent ? (
                <>
                  {nameField}
                  {providerField}
                  {paramFields}
                  {memberLists}
                  {locationField}
                  {directoryField}
                </>
              ) : (
                <>
                  {nameField}
                  {paramFields}
                  {memberLists}
                  {createsAgents && (
                    <>
                      <SectionTitle
                        title={slots.length === 1 ? 'Where the agent runs' : 'Where the agents run'}
                        hint="Each new agent gets its own directory there, named after it."
                      />
                      {locationField}
                      {providerField}
                    </>
                  )}
                </>
              )}
            </div>

            {/* Right: what this will create */}
            <div className="flex min-w-0 flex-1 flex-col border-l border-border bg-background-1">
              <div className="flex shrink-0 items-center gap-3 border-b border-border px-5 py-3">
                <span className="min-w-0 flex-1 text-[13px] font-semibold">
                  What this will create
                </span>
                <span
                  className={cn(
                    'shrink-0 text-[11.5px]',
                    missing.length > 0 || slotProblems.length > 0
                      ? 'text-amber-600 dark:text-amber-400'
                      : 'text-emerald-700 dark:text-emerald-400'
                  )}
                >
                  {stillNeeded}
                </span>
              </div>
              <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-5 py-4">
                <div className="flex flex-col gap-2">
                  {intoRoomId ? (
                    <p className="text-xs text-foreground-muted">
                      The new agent joins the room you came from; no room is made.
                    </p>
                  ) : (
                    parsed?.rooms.map((room, i) => (
                      <RoomCard
                        key={i}
                        room={room}
                        values={railValues}
                        renames={railRenames}
                        bridgeName={templateBridge?.displayName ?? parsed.bridge}
                        creatorIdentity={creatorIdentity}
                        status={roomStatus}
                        toggle={
                          loaded?.kind === 'agent' && phase === 'form'
                            ? { checked: createRoom, onChange: setCreateRoom }
                            : null
                        }
                      />
                    ))
                  )}
                  {slots.map((slot, i) => (
                    <AgentSlotCard
                      key={i}
                      slot={slot}
                      wantedName={slotNames[i]?.wanted ?? ''}
                      finalName={slotNames[i]?.final ?? ''}
                      onChange={(next) =>
                        setSlots((prev) => prev.map((s, j) => (j === i ? next : s)))
                      }
                      lists={{ ...lists, agents: agentsAtLocation }}
                      locationLabel={runLocationLabel(runHost, allowedHosts)}
                      sshHost={sshHost}
                      busy={phase === 'creating'}
                      directoryInForm={singleNewAgent}
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
  result: Exclude<Awaited<ReturnType<typeof rpc.agents.addAgent>>, { kind: 'created' }>
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

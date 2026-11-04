import {
  fetchManagedAgents,
  GatewayError,
  gatewayFetch,
} from '@main/core/switch-servers/gateway-client';
import type { CloudMachine } from '@shared/core/cloud-agents/cloud-agents';
import {
  type SharedCloudAgent,
  sharedCloudAgentsResponseSchema,
  type SharedCloudOverview,
  sharedCloudOverviewSchema,
} from '@shared/core/shared-cloud/shared-cloud';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';
import { hostedV2On } from './hosted-v2';
import { type MockMode, sharedCloudMock } from './mock-mode';

export { type MockMode, sharedCloudMock } from './mock-mode';

function isNotFound(error: unknown): boolean {
  return error instanceof GatewayError && error.kind === 'http' && error.status === 404;
}

/**
 * The signed-in user's agents on the shared cloud, each with its state, or
 * null when the server offers no shared cloud (it says `available: false`, or
 * an older server answers 404).
 */
export async function listSharedCloudAgents(
  server: SwitchServer
): Promise<SharedCloudAgent[] | null> {
  if (sharedCloudMock()) return mockAgents(server);
  // Hosted agents v2 only: off, nothing is asked of `/shared-cloud/*` (upstream has none).
  if (!(await hostedV2On(server))) return null;
  let response: Response;
  try {
    response = await gatewayFetch(server, '/shared-cloud/agents', { authenticated: true });
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  const listed = sharedCloudAgentsResponseSchema.parse(await response.json());
  return listed.available ? (listed.agents ?? []) : null;
}

/**
 * The admin's view of the shared cloud, or null when the server offers none
 * or the caller is not an admin there (403). The server decides who is an
 * admin; Console only hides what it would refuse.
 */
export async function fetchSharedCloudOverview(
  server: SwitchServer
): Promise<SharedCloudOverview | null> {
  const mock = sharedCloudMock();
  // Checked like a real answer, so the mock can't drift from the shape.
  if (mock) return sharedCloudOverviewSchema.parse(mockOverview(mock));
  if (!(await hostedV2On(server))) return null;
  let response: Response;
  try {
    response = await gatewayFetch(server, '/shared-cloud/overview', { authenticated: true });
  } catch (error) {
    if (
      error instanceof GatewayError &&
      error.kind === 'http' &&
      (error.status === 404 || error.status === 403)
    )
      return null;
    throw error;
  }
  return sharedCloudOverviewSchema.parse(await response.json());
}

const MINUTE = 60_000;

/** The caller's real managed agents, given one of each state in turn. */
async function mockAgents(server: SwitchServer): Promise<SharedCloudAgent[]> {
  // Switch Buddy runs on the server, not in a user's cloud box.
  const agents = (await fetchManagedAgents(server)).filter(
    (agent) => !agent.name.startsWith('switch-buddy')
  );
  const now = Date.now();
  return agents.map((agent, index): SharedCloudAgent => {
    if (index === 0)
      return {
        agent_id: agent.agentId,
        state: 'working',
        room_name: 'Off-Topic',
        last_reply_at: new Date(now).toISOString(),
        last_resume_ms: 3100,
      };
    if (index === 1)
      return {
        agent_id: agent.agentId,
        state: 'idle',
        last_reply_at: new Date(now - 4 * MINUTE).toISOString(),
        last_resume_ms: null,
      };
    if (index === 4)
      return {
        agent_id: agent.agentId,
        state: 'unavailable',
        last_reply_at: new Date(now - 3 * 60 * MINUTE).toISOString(),
        last_resume_ms: null,
      };
    if (index === 2)
      return {
        agent_id: agent.agentId,
        state: 'waking',
        last_reply_at: new Date(now - 47 * MINUTE).toISOString(),
        last_resume_ms: 2800,
      };
    return {
      agent_id: agent.agentId,
      state: 'resting',
      last_reply_at: new Date(now - (index === 3 ? 120 : 26 * 60) * MINUTE).toISOString(),
      last_resume_ms: 3400,
    };
  });
}

const GB = 1024 ** 3;

const ATTEMPTS = [
  "Read the other person's files",
  "See the other person's processes",
  "Reach the other person's agents or the machine",
  'Reach the cloud metadata address',
  'Reach the Kubernetes API',
  'Reach anything off the allow-list',
  "Read the other person's AI login",
];

function mockOverview(mode: MockMode): SharedCloudOverview {
  const now = Date.now();
  const unknown = mode === 'unreachable';
  const checkedAt = new Date(now - 95 * MINUTE).toISOString();
  return {
    viewer: mode === 'workspace_admin' ? 'workspace_admin' : 'operator',
    people: [
      {
        user_id: 'mock-a',
        name: 'Test user A',
        agents: { working: 1, idle: 1, resting: 3, unavailable: 0 },
        memory_bytes: unknown ? null : 2.6 * GB,
        cost_month_usd: unknown ? null : 27,
        kept_apart: unknown ? 'unknown' : 'pass',
      },
      ...(mode === 'workspace_admin'
        ? []
        : [
            {
              user_id: 'mock-b',
              name: 'Test user B',
              agents: { working: 0, idle: 0, resting: 5, unavailable: 0 },
              memory_bytes: unknown ? null : 0.4 * GB,
              cost_month_usd: unknown ? null : 27,
              kept_apart: unknown ? ('unknown' as const) : ('pass' as const),
            },
          ]),
    ],
    room: unknown ? 'unknown' : 'plenty',
    cost: {
      per_person_month_usd: unknown ? null : 27,
      target_low_usd: 15,
      target_high_usd: 30,
      estimate: true,
    },
    isolation: unknown
      ? { result: 'unknown', blocked: 0, total: 0, checked_at: null, attempts: [] }
      : {
          result: 'pass',
          blocked: 14,
          total: 14,
          checked_at: checkedAt,
          attempts: ATTEMPTS.map((label) => ({
            label,
            // A workspace admin sees only their own people named; the server
            // shows anyone outside their workspace as "another user".
            results:
              mode === 'workspace_admin'
                ? [
                    { direction: 'Test user A → another user', result: 'pass' as const },
                    { direction: 'another user → Test user A', result: 'pass' as const },
                  ]
                : [
                    { direction: 'Test user A → Test user B', result: 'pass' as const },
                    { direction: 'Test user B → Test user A', result: 'pass' as const },
                  ],
          })),
        },
    alerts: [
      {
        id: 'mock-1',
        severity: 'warning',
        title: "Test user A's agents reached their memory limit",
        detail: 'One session restarted. Nothing was lost, and the others kept working.',
        raised_at: new Date(now - 26 * 60 * MINUTE).toISOString(),
        cleared_at: new Date(now - 25 * 60 * MINUTE).toISOString(),
      },
    ],
    nodes:
      mode === 'unreachable'
        ? { machines: [] }
        : mode === 'operator'
          ? {
              machines: [
                {
                  name: 'shared-1',
                  instance_type: 'm7g.xlarge',
                  kind: 'shared',
                  memory_total_bytes: 16 * GB,
                  memory_working_bytes: 2.6 * GB,
                  memory_resting_bytes: 0.5 * GB,
                  memory_system_bytes: 2 * GB,
                  people: 2,
                  room_for_people: 18,
                },
              ],
            }
          : null,
  };
}

/**
 * In the mock, a pretend box that the caller's agents run in, so the screens
 * read as they would for a shared-cloud user. Nothing on the server knows it.
 */
export const MOCK_BOX = {
  id: 'mock-shared-cloud-box',
  name: 'Your box (sample data)',
  kind: 'daemon',
  state: 'online' as const,
};

/**
 * The mock box as the owner's cloud machine list shows it: Core's `backend: "box"`
 * is what makes it a box, as for a real one (dev only, with the mock on).
 */
export function mockCloudMachine(): CloudMachine {
  return {
    machine_id: 'mock-shared-cloud-machine',
    state: 'ready',
    desired_state: 'running',
    stop_reason: null,
    sleeping: false,
    revision: 1,
    instance_type: null,
    error: null,
    error_code: null,
    retain_until: null,
    heartbeat_at: null,
    disk: null,
    memory: null,
    agents: [],
    controller_id: MOCK_BOX.id,
    backend: 'box',
    room: { used_bytes: 2 * 1024 ** 3, total_bytes: 8 * 1024 ** 3 },
    awake: { running: 1, max: 4 },
    ai_calls_today: null,
  };
}

/** Refuses anything that would change the server while the mock is on. */
export function refuseWhileMocked(what: string): void {
  if (sharedCloudMock())
    throw new Error(`This Console is showing sample data, so it doesn't ${what}.`);
}

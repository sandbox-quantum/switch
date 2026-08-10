/**
 * Persistence for remote-host setup plans (CHOO-1809).
 *
 * Plans are validated on the way in from SQLite rather than trusted. A row we
 * cannot parse raises: silently returning "no plan" would be read by every
 * caller as "this host has nothing outstanding", which is the most dangerous
 * possible misreading of a corrupt record.
 */

import { eq } from 'drizzle-orm';
import { db } from '@main/db/client';
import { remoteHostSetupPlans, type RemoteHostSetupPlanRow } from '@main/db/schema';
import type {
  DependencyCheckOutcome,
  HostSetupPlan,
  HostSetupPlanStatus,
  HostSetupStep,
  HostSetupStepKind,
  HostSetupStepState,
} from '@shared/core/remote-hosts/setup';

const PLAN_STATUSES: HostSetupPlanStatus[] = ['idle', 'complete'];
const STEP_STATES: HostSetupStepState[] = [
  'pending',
  'checking',
  'installing',
  'updating',
  'satisfied',
  'failed',
  'skipped',
];

/**
 * Values written before the automated run was removed.
 *
 * A plan persisted by an older build can still say `running`, `halted` or
 * `blocked`; those concepts no longer exist, but the row does. Map them to
 * their nearest live meaning rather than refusing to load — a strict parser
 * would make an upgrade look like a corrupt database.
 */
const LEGACY_PLAN_STATUSES: Record<string, HostSetupPlanStatus> = {
  running: 'idle',
  halted: 'idle',
};
const LEGACY_STEP_STATES: Record<string, HostSetupStepState> = {
  // "never attempted because something upstream failed" is just "not yet".
  blocked: 'pending',
};
const STEP_KINDS: HostSetupStepKind[] = ['core-dependency', 'agent-cli', 'agent-plugin', 'gh-auth'];
const OUTCOMES: DependencyCheckOutcome[] = [
  'satisfied',
  'missing',
  'not-running',
  'wrong-version',
  'unknown',
];

function oneOf<T extends string>(
  allowed: T[],
  raw: unknown,
  field: string,
  sshHost: string,
  legacy: Record<string, T> = {}
): T {
  if (typeof raw === 'string' && legacy[raw]) return legacy[raw];
  const match = allowed.find((value) => value === raw);
  if (!match) {
    throw new Error(
      `Invalid ${field} '${String(raw)}' in the persisted setup plan for host ${sshHost}`
    );
  }
  return match;
}

function nullableString(raw: unknown): string | null {
  return typeof raw === 'string' ? raw : null;
}

function toStep(raw: unknown, sshHost: string): HostSetupStep {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`Malformed setup step in the persisted plan for host ${sshHost}`);
  }
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== 'string') {
    throw new Error(`Setup step without an id in the persisted plan for host ${sshHost}`);
  }
  return {
    id: value.id,
    kind: oneOf(STEP_KINDS, value.kind, 'step kind', sshHost),
    name: typeof value.name === 'string' ? value.name : value.id,
    state: oneOf(STEP_STATES, value.state, 'step state', sshHost, LEGACY_STEP_STATES),
    outcome: value.outcome == null ? null : oneOf(OUTCOMES, value.outcome, 'outcome', sshHost),
    version: nullableString(value.version),
    // Absent in plans written before update-awareness. Unknown latest and no
    // known update is the honest reading of a row that predates the concept.
    latestVersion: nullableString(value.latestVersion),
    updateAvailable: value.updateAvailable === true,
    error: nullableString(value.error),
    output: nullableString(value.output),
    optional: value.optional === true,
    dependsOn: Array.isArray(value.dependsOn)
      ? value.dependsOn.filter((id): id is string => typeof id === 'string')
      : [],
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date(0).toISOString(),
  };
}

function toPlan(row: RemoteHostSetupPlanRow): HostSetupPlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.steps);
  } catch (error) {
    throw new Error(
      `Could not parse the persisted setup plan for host ${row.sshHost}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Persisted setup plan for host ${row.sshHost} is not a list of steps`);
  }

  return {
    sshHost: row.sshHost,
    status: oneOf(PLAN_STATUSES, row.status, 'plan status', row.sshHost, LEGACY_PLAN_STATUSES),
    steps: parsed.map((step) => toStep(step, row.sshHost)),
    currentStepId: row.currentStepId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getSetupPlan(sshHost: string): Promise<HostSetupPlan | null> {
  const [row] = await db
    .select()
    .from(remoteHostSetupPlans)
    .where(eq(remoteHostSetupPlans.sshHost, sshHost))
    .limit(1);
  return row ? toPlan(row) : null;
}

export async function listSetupPlans(): Promise<HostSetupPlan[]> {
  const rows = await db.select().from(remoteHostSetupPlans);
  return rows.map(toPlan);
}

export async function saveSetupPlan(plan: HostSetupPlan): Promise<void> {
  const values = {
    sshHost: plan.sshHost,
    status: plan.status,
    steps: JSON.stringify(plan.steps),
    currentStepId: plan.currentStepId,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
  };
  await db
    .insert(remoteHostSetupPlans)
    .values(values)
    .onConflictDoUpdate({
      target: remoteHostSetupPlans.sshHost,
      set: {
        status: values.status,
        steps: values.steps,
        currentStepId: values.currentStepId,
        updatedAt: values.updatedAt,
      },
    });
}

export async function deleteSetupPlan(sshHost: string): Promise<void> {
  await db.delete(remoteHostSetupPlans).where(eq(remoteHostSetupPlans.sshHost, sshHost));
}
